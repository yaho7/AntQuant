"""Broker selection and the Schwab authorization wizard."""

from __future__ import annotations

import secrets
import time
from dataclasses import asdict
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from backend.adapters.brokers.base import BrokerError
from backend.api.deps import client_ip, get_db, require_session
from backend.core.audit import audit
from backend.core.secrets import delete_secrets, mask
from backend.models import Task, UserSession
from backend.services import broker_service
from backend.services import schwab_service as schwab
from backend.services.task_manager import ACTIVE

router = APIRouter(
    prefix="/api/settings", tags=["brokers"], dependencies=[Depends(require_session)]
)


class SchwabAuthorize(BaseModel):
    app_key: str = Field(default="", max_length=128)
    app_secret: str = Field(default="", max_length=256)
    callback_url: str = Field(min_length=1, max_length=256)

    @field_validator("callback_url")
    @classmethod
    def valid_callback(cls, value: str) -> str:
        return schwab.validate_callback(value.strip())


class SchwabCallback(BaseModel):
    redirect_url: str = Field(min_length=1, max_length=4096)


class SchwabAccountChoice(BaseModel):
    account: int = Field(ge=0)


class BrokerChoice(BaseModel):
    broker: Literal["alpaca", "schwab"]


def _running_trades(db: Session) -> bool:
    return (
        db.scalar(select(Task.id).where(Task.kind == "trading", Task.status.in_(ACTIVE)).limit(1))
        is not None
    )


def _pending(db: Session, session: UserSession) -> dict:
    pending = schwab.read_json_secret(db, schwab.SCHWAB_PENDING)
    if (
        not pending
        or pending["session"] != session.token_hash
        or pending["deadline"] <= time.time()
    ):
        raise HTTPException(409, "Start a new Schwab authorization in Settings.")
    return pending


@router.post("/schwab/authorize")
def authorize_schwab(
    body: SchwabAuthorize,
    session: UserSession = Depends(require_session),
    db: Session = Depends(get_db),
) -> dict[str, str]:
    app_key, app_secret = body.app_key.strip(), body.app_secret.strip()
    db.execute(text("BEGIN IMMEDIATE"))
    if not app_key and not app_secret:
        saved = schwab.connection(db)
        if saved:
            app_key, app_secret = saved.app_key, saved.app_secret
    if not app_key or not app_secret:
        raise HTTPException(400, "Enter both the Schwab app key and secret.")
    url, state = schwab.authorize(app_key, body.callback_url)
    schwab.write_json_secret(
        db,
        schwab.SCHWAB_PENDING,
        {
            "app_key": app_key,
            "app_secret": app_secret,
            "callback": body.callback_url,
            "state": state,
            "session": session.token_hash,
            "deadline": time.time() + 900,
        },
    )
    db.commit()
    return {"authorization_url": url}


@router.post("/schwab/accounts")
def schwab_accounts(
    body: SchwabCallback,
    session: UserSession = Depends(require_session),
    db: Session = Depends(get_db),
) -> dict:
    pending = _pending(db, session)
    if "accounts" not in pending:
        try:
            token, accounts = schwab.exchange(pending, body.redirect_url.strip())
        except BrokerError as exc:
            raise HTTPException(exc.status_code, exc.message) from None
        db.execute(text("BEGIN IMMEDIATE"))
        if _pending(db, session)["state"] != pending["state"]:
            raise HTTPException(409, "Start a new Schwab authorization in Settings.")
        pending.update(token=token, accounts=accounts, authorized_at=time.time())
        schwab.write_json_secret(db, schwab.SCHWAB_PENDING, pending)
        db.commit()
    return {
        "accounts": [
            {"id": i, "label": mask(a["number"])} for i, a in enumerate(pending["accounts"])
        ]
    }


@router.put("/schwab/connection")
def connect_schwab(
    body: SchwabAccountChoice,
    request: Request,
    session: UserSession = Depends(require_session),
    db: Session = Depends(get_db),
) -> dict:
    db.execute(text("BEGIN IMMEDIATE"))
    pending = _pending(db, session)
    if body.account >= len(pending.get("accounts", [])):
        raise HTTPException(400, "Select an authorized Schwab account.")
    account = pending["accounts"][body.account]
    prior = schwab.connection(db)
    same = prior is not None and (prior.app_key, prior.account_number, prior.account_hash) == (
        pending["app_key"],
        account["number"],
        account["hash"],
    )
    if _running_trades(db) and (broker_service.selected_broker(db) != "schwab" or not same):
        raise HTTPException(409, "Stop all trading strategies before changing broker accounts.")
    conn = schwab.SchwabConnection(
        id=prior.id if prior and same else secrets.token_hex(16),
        app_key=pending["app_key"],
        app_secret=pending["app_secret"],
        callback=pending["callback"],
        account_number=account["number"],
        account_hash=account["hash"],
        token=pending["token"],
        authorized_at=pending["authorized_at"],
    )
    schwab.write_json_secret(db, schwab.SCHWAB_CONNECTION, asdict(conn))
    delete_secrets(db, schwab.SCHWAB_PENDING)
    broker_service.select_broker(db, "schwab")
    audit(db, "settings.broker", "schwab", {"action": "connect"}, client_ip(request))
    return broker_service.schwab_status(db)


@router.delete("/schwab/connection")
def disconnect_schwab(request: Request, db: Session = Depends(get_db)) -> dict:
    db.execute(text("BEGIN IMMEDIATE"))
    if broker_service.selected_broker(db) == "schwab":
        if _running_trades(db):
            raise HTTPException(409, "Stop all trading strategies before changing broker accounts.")
        broker_service.select_broker(db, "alpaca")
    delete_secrets(db, schwab.SCHWAB_CONNECTION, schwab.SCHWAB_PENDING)
    audit(db, "settings.broker", "schwab", {"action": "disconnect"}, client_ip(request))
    return broker_service.schwab_status(db)


@router.put("/broker/active")
def select_broker(
    body: BrokerChoice, request: Request, db: Session = Depends(get_db)
) -> dict[str, str]:
    db.execute(text("BEGIN IMMEDIATE"))
    if broker_service.selected_broker(db) != body.broker and _running_trades(db):
        raise HTTPException(409, "Stop all trading strategies before changing broker accounts.")
    if body.broker == "schwab":
        conn = schwab.connection(db)
        if conn is None or conn.expires_at <= time.time():
            raise HTTPException(409, schwab.AUTH_REQUIRED)
    elif broker_service.alpaca_credentials(db) is None:
        raise HTTPException(409, "No Alpaca keys are stored.")
    broker_service.select_broker(db, body.broker)
    audit(db, "settings.broker", body.broker, {"action": "select"}, client_ip(request))
    return {"active_broker": body.broker}

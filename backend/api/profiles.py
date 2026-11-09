"""Account-scoped broker connections and Schwab authorization."""

from __future__ import annotations

import secrets
import time
from dataclasses import asdict
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from backend.adapters.brokers.alpaca import AlpacaAdapter
from backend.adapters.brokers.base import BrokerError
from backend.adapters.brokers.endpoints import ALPACA_LIVE_URL, ALPACA_PAPER_URL
from backend.api.brokers import SchwabAuthorize
from backend.api.deps import client_ip, get_db, require_session, settings_dep
from backend.core.audit import audit
from backend.core.config import Settings
from backend.core.secrets import delete_secrets, mask
from backend.models import BrokerProfile, UserSession
from backend.schemas import AlpacaCredentials
from backend.services import broker_service as brokers
from backend.services import schwab_service as schwab

router = APIRouter(
    prefix="/api/profiles", tags=["profiles"], dependencies=[Depends(require_session)]
)
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]


class ProfileName(BaseModel):
    name: Name


class AlpacaProfile(AlpacaCredentials, ProfileName):
    pass


class SchwabStart(SchwabAuthorize):
    profile_id: str | None = Field(default=None, max_length=80)


class SchwabCallback(BaseModel):
    redirect_url: str = Field(min_length=1, max_length=4096)


class SchwabSelection(BaseModel):
    accounts: list[int] = Field(min_length=1, max_length=100)
    name: Name | None = None


def require_profile(db: Session, profile_id: str) -> BrokerProfile:
    profile = db.get(BrokerProfile, profile_id)
    if profile is None:
        raise HTTPException(404, "Broker account not found.")
    return profile


def profile_out(db: Session, profile: BrokerProfile) -> dict:
    conn = brokers.trading_connection(db, profile.id)
    result = {
        "id": profile.id,
        "name": profile.name,
        "provider": profile.provider,
        "account_hint": profile.account_hint,
        "connected": conn is not None,
        "endpoint": None,
        "mode": "paper" if conn and conn.paper else "live",
        "callback_url": None,
        "authorization_expires_at": None,
        "authorization_expired": False,
        "can_liquidate": isinstance(conn, brokers.AlpacaConnection),
    }
    if isinstance(conn, schwab.SchwabConnection):
        result.update(schwab_status_fields(db, conn))
    elif isinstance(conn, brokers.AlpacaConnection):
        result["endpoint"] = conn.endpoint
    return result


def schwab_status_fields(db: Session, conn: schwab.SchwabConnection) -> dict:
    status = brokers.schwab_status(db, conn)
    return {
        key: status[key]
        for key in ("endpoint", "callback_url", "authorization_expires_at", "authorization_expired")
    }


@router.get("")
def profiles(db: Session = Depends(get_db), settings: Settings = Depends(settings_dep)) -> dict:
    items = db.scalars(select(BrokerProfile).order_by(BrokerProfile.name, BrokerProfile.id))
    return {
        "profiles": [profile_out(db, row) for row in items],
        "live_available": settings.live_trading_enabled,
    }


@router.patch("/{profile_id}")
def rename(
    profile_id: str, body: ProfileName, request: Request, db: Session = Depends(get_db)
) -> dict:
    profile = require_profile(db, profile_id)
    profile.name = body.name
    audit(db, "profile.rename", profile.id, {}, client_ip(request))
    return profile_out(db, profile)


def alpaca_identity(creds: brokers.AlpacaConnection) -> tuple[str, str | None]:
    account = AlpacaAdapter(
        creds.key, creds.secret, paper=creds.paper, endpoint=creds.endpoint
    ).get_account()
    if not account.account_id:
        raise BrokerError("Alpaca did not return an account ID.", 502)
    return brokers.profile_identity("alpaca", creds.endpoint, account.account_id), mask(
        account.account_id
    )


def save_alpaca(body: AlpacaProfile, request: Request, db: Session, profile_id: str | None) -> dict:
    endpoint = body.endpoint or (ALPACA_PAPER_URL if body.paper else ALPACA_LIVE_URL)
    creds = brokers.AlpacaConnection(body.api_key.strip(), body.api_secret.strip(), endpoint)
    legacy = brokers.alpaca_credentials(db)
    legacy_key = brokers.connection_key(legacy)
    legacy_profile = db.get(BrokerProfile, legacy_key) if legacy_key else None
    try:
        identity, hint = alpaca_identity(creds)
    except BrokerError as exc:
        raise HTTPException(exc.status_code, exc.message) from None
    legacy_identity = None
    if (
        legacy
        and legacy_profile
        and not legacy_profile.identity
        and legacy.endpoint == creds.endpoint
    ):
        if legacy.key == creds.key:
            legacy_identity = (identity, hint)
        else:
            try:
                legacy_identity = alpaca_identity(legacy)
            except BrokerError:
                pass

    db.execute(text("BEGIN IMMEDIATE"))
    if legacy_identity and legacy_key == brokers.connection_key(brokers.alpaca_credentials(db)):
        current = db.get(BrokerProfile, legacy_key, populate_existing=True)
        if current and not current.identity:
            current.identity, current.account_hint = legacy_identity
    duplicate = db.scalar(select(BrokerProfile).where(BrokerProfile.identity == identity))
    if profile_id is None:
        if duplicate and brokers.trading_connection(db, duplicate.id) is not None:
            raise HTTPException(409, "This broker account is already connected.")
        profile = duplicate or BrokerProfile(
            id=f"alpaca:{secrets.token_hex(16)}", provider="alpaca", name=body.name
        )
        if duplicate is None:
            db.add(profile)
    else:
        profile = require_profile(db, profile_id)
        if profile.provider != "alpaca" or profile.identity != identity:
            raise HTTPException(409, "These credentials belong to a different broker account.")
        if brokers.profile_running(db, profile_id):
            raise HTTPException(409, "Stop strategies on this account before replacing its keys.")
        if profile.legacy:
            brokers.remove_alpaca_credentials(db)
            profile.legacy = False
    profile.name, profile.identity, profile.account_hint = body.name, identity, hint
    schwab.write_json_secret(db, brokers.alpaca_profile_secret(profile.id), asdict(creds))
    audit(db, "profile.alpaca", profile.id, {}, client_ip(request))
    return profile_out(db, profile)


@router.post("/alpaca")
def add_alpaca(body: AlpacaProfile, request: Request, db: Session = Depends(get_db)) -> dict:
    return save_alpaca(body, request, db, None)


@router.put("/{profile_id}/alpaca")
def update_alpaca(
    profile_id: str, body: AlpacaProfile, request: Request, db: Session = Depends(get_db)
) -> dict:
    return save_alpaca(body, request, db, profile_id)


def flow_secret(flow_id: str) -> str:
    return f"schwab:flow:{flow_id}"


def pending(db: Session, flow_id: str, session: UserSession) -> dict:
    flow = schwab.read_json_secret(db, flow_secret(flow_id))
    if not flow or flow["session"] != session.token_hash or flow["deadline"] <= time.time():
        raise HTTPException(409, "Start a new Schwab authorization in Settings.")
    return flow


@router.post("/schwab/authorize")
def authorize(
    body: SchwabStart,
    session: UserSession = Depends(require_session),
    db: Session = Depends(get_db),
) -> dict:
    app_key, app_secret = body.app_key.strip(), body.app_secret.strip()
    if body.profile_id:
        profile = require_profile(db, body.profile_id)
        conn = brokers.trading_connection(db, profile.id)
        if not isinstance(conn, schwab.SchwabConnection):
            raise HTTPException(409, "Schwab account is no longer connected.")
        if not app_key and not app_secret:
            app_key, app_secret = conn.app_key, conn.app_secret
        if app_key != conn.app_key:
            raise HTTPException(409, "Renew this account with the same Schwab app.")
    if not app_key or not app_secret:
        raise HTTPException(400, "Enter both the Schwab app key and secret.")
    url, state = schwab.authorize(app_key, body.callback_url)
    flow_id = secrets.token_hex(16)
    schwab.write_json_secret(
        db,
        flow_secret(flow_id),
        {
            "app_key": app_key,
            "app_secret": app_secret,
            "callback": body.callback_url,
            "state": state,
            "session": session.token_hash,
            "deadline": time.time() + 900,
            "profile_id": body.profile_id,
        },
    )
    db.commit()
    return {"authorization_url": url, "flow_id": flow_id}


@router.post("/schwab/{flow_id}/accounts")
def accounts(
    flow_id: str,
    body: SchwabCallback,
    session: UserSession = Depends(require_session),
    db: Session = Depends(get_db),
) -> dict:
    flow = pending(db, flow_id, session)
    if "accounts" not in flow:
        try:
            token, authorized = schwab.exchange(flow, body.redirect_url.strip())
        except BrokerError as exc:
            raise HTTPException(exc.status_code, exc.message) from None
        db.execute(text("BEGIN IMMEDIATE"))
        flow = pending(db, flow_id, session)
        if "accounts" not in flow:
            flow.update(token=token, accounts=authorized, authorized_at=time.time())
            schwab.write_json_secret(db, flow_secret(flow_id), flow)
            db.commit()
    return {
        "accounts": [{"id": i, "label": mask(a["number"])} for i, a in enumerate(flow["accounts"])]
    }


@router.put("/schwab/{flow_id}/accounts")
def connect(
    flow_id: str,
    body: SchwabSelection,
    request: Request,
    session: UserSession = Depends(require_session),
    db: Session = Depends(get_db),
) -> list[dict]:
    db.execute(text("BEGIN IMMEDIATE"))
    flow = pending(db, flow_id, session)
    authorized = flow.get("accounts", [])
    if any(i < 0 or i >= len(authorized) for i in body.accounts):
        raise HTTPException(400, "Select an authorized Schwab account.")
    selected = {authorized[i]["number"] for i in body.accounts}
    by_number = {a["number"]: a for a in authorized}
    existing = {}
    grants = set()
    for profile in db.scalars(select(BrokerProfile).where(BrokerProfile.provider == "schwab")):
        conn = brokers.trading_connection(db, profile.id)
        if not isinstance(conn, schwab.SchwabConnection):
            continue
        existing[conn.account_number] = (profile, conn)
        if conn.app_key == flow["app_key"] and conn.account_number in by_number:
            grants.add(conn.grant_id or conn.id)
    if flow["profile_id"]:
        required = require_profile(db, flow["profile_id"])
        current = brokers.trading_connection(db, required.id)
        if (
            not isinstance(current, schwab.SchwabConnection)
            or current.account_number not in selected
        ):
            raise HTTPException(409, "Select the same Schwab account to renew access.")
    for number in selected:
        if number in existing and existing[number][1].app_key != flow["app_key"]:
            raise HTTPException(
                409, "This account is already connected through a different Schwab app."
            )
    # A refresh grant is shared by accounts returned in the same authorization.
    affected = selected | {
        n
        for n, (_, c) in existing.items()
        if (c.grant_id or c.id) in grants and c.app_key == flow["app_key"]
    }
    if not affected <= by_number.keys():
        raise HTTPException(409, "Authorize all accounts linked to this Schwab connection.")
    grant_id = next(iter(grants)) if len(grants) == 1 else secrets.token_hex(16)
    schwab.write_json_secret(
        db,
        schwab.grant_secret(grant_id),
        {key: flow[key] for key in ("app_key", "app_secret", "callback", "authorized_at", "token")},
    )
    rows = []
    for number in sorted(affected):
        if number in existing:
            profile, _ = existing[number]
            if profile.legacy:
                delete_secrets(db, schwab.SCHWAB_CONNECTION)
                profile.legacy = False
        else:
            identity = brokers.profile_identity("schwab", number)
            profile = db.scalar(select(BrokerProfile).where(BrokerProfile.identity == identity))
            if profile is None:
                profile = BrokerProfile(
                    id=f"schwab:{secrets.token_hex(16)}",
                    provider="schwab",
                    name=(body.name or "") if len(selected) == 1 else "",
                    identity=identity,
                    account_hint=mask(number),
                )
                db.add(profile)
        schwab.write_json_secret(
            db,
            schwab.profile_secret(profile.id.removeprefix("schwab:")),
            {
                "grant_id": grant_id,
                "account_number": number,
                "account_hash": by_number[number]["hash"],
            },
        )
        rows.append(profile)
    for old_grant in grants - {grant_id}:
        delete_secrets(db, schwab.grant_secret(old_grant))
    delete_secrets(db, flow_secret(flow_id))
    audit(db, "profile.schwab", rows[0].id, {"profiles": [r.id for r in rows]}, client_ip(request))
    return [profile_out(db, row) for row in rows]


@router.delete("/{profile_id}")
def disconnect(profile_id: str, request: Request, db: Session = Depends(get_db)) -> dict:
    db.execute(text("BEGIN IMMEDIATE"))
    profile = require_profile(db, profile_id)
    if brokers.profile_running(db, profile_id):
        raise HTTPException(409, "Stop strategies on this account before disconnecting.")
    conn = brokers.trading_connection(db, profile.id)
    if profile.provider == "alpaca":
        if profile.legacy:
            brokers.remove_alpaca_credentials(db)
        else:
            delete_secrets(db, brokers.alpaca_profile_secret(profile.id))
    elif profile.legacy:
        delete_secrets(db, schwab.SCHWAB_CONNECTION)
    else:
        delete_secrets(db, schwab.profile_secret(profile.id.removeprefix("schwab:")))
        if isinstance(conn, schwab.SchwabConnection) and conn.grant_id:
            others = db.scalars(
                select(BrokerProfile).where(
                    BrokerProfile.provider == "schwab",
                    BrokerProfile.id != profile.id,
                )
            )
            if not any(
                getattr(brokers.trading_connection(db, row.id), "grant_id", None) == conn.grant_id
                for row in others
            ):
                delete_secrets(db, schwab.grant_secret(conn.grant_id))
    profile.legacy = False
    audit(db, "profile.disconnect", profile_id, {}, client_ip(request))
    return {"status": "ok"}

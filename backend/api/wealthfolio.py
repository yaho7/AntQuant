"""Configure a Wealthfolio destination for a broker account."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from backend.adapters.brokers.endpoints import validate_endpoint
from backend.api.deps import client_ip, get_db, require_session
from backend.core.audit import audit
from backend.models import BrokerProfile, WealthfolioDelivery, WealthfolioRoute
from backend.services import broker_service, wealthfolio

router = APIRouter(
    prefix="/api/settings/wealthfolio",
    tags=["wealthfolio"],
    dependencies=[Depends(require_session)],
)


class Endpoint(BaseModel):
    endpoint: str = Field(max_length=512)
    password: str = Field(default="", max_length=256)

    @field_validator("endpoint")
    @classmethod
    def endpoint_url(cls, value: str) -> str:
        return validate_endpoint(value)


class Destination(Endpoint):
    account_id: str = Field(min_length=1, max_length=256)


def _key(db: Session, profile_id: str | None) -> str | None:
    if profile_id is not None and db.get(BrokerProfile, profile_id) is None:
        raise HTTPException(404, "Broker account not found.")
    return profile_id if profile_id is not None else wealthfolio.current_key(db)


def _credentials(db: Session, body: Endpoint, key: str | None) -> str:
    return body.password or wealthfolio.saved_password(db, key, body.endpoint)


def _accounts(endpoint: str, password: str) -> list[dict]:
    client = wealthfolio.WebClient(endpoint, password)
    try:
        return client.accounts()
    except wealthfolio.WealthfolioError as exc:
        raise HTTPException(502, str(exc)) from None
    finally:
        client.close()


@router.get("/statuses")
def statuses(db: Session = Depends(get_db)) -> dict:
    ids = list(db.scalars(select(BrokerProfile.id)))
    # A queued fill keeps its original destination even after its profile is removed.
    known = select(WealthfolioRoute.id)
    unassigned = db.scalar(
        select(func.count()).where(
            WealthfolioDelivery.sent_at.is_(None), WealthfolioDelivery.destination.not_in(known)
        )
    )
    return {"profiles": {key: wealthfolio.status(db, key) for key in ids}, "unassigned": unassigned}


@router.get("/connection")
def status(profile_id: str | None = None, db: Session = Depends(get_db)) -> dict:
    return wealthfolio.status(db, _key(db, profile_id))


@router.post("/accounts")
def accounts(body: Endpoint, profile_id: str | None = None, db: Session = Depends(get_db)) -> dict:
    return {"accounts": _accounts(body.endpoint, _credentials(db, body, _key(db, profile_id)))}


@router.put("/connection")
def connect(
    body: Destination,
    request: Request,
    profile_id: str | None = None,
    db: Session = Depends(get_db),
) -> dict:
    broker = _key(db, profile_id)
    if broker is None or broker_service.trading_connection(db, broker) is None:
        raise HTTPException(409, "Connect a broker before configuring Wealthfolio.")
    password = _credentials(db, body, broker)
    accounts = _accounts(body.endpoint, password)
    target = next((a for a in accounts if a["id"] == body.account_id), None)
    if target is None:
        raise HTTPException(400, "Select an available Wealthfolio account.")
    db.execute(text("BEGIN IMMEDIATE"))
    if _key(db, profile_id) != broker or broker_service.trading_connection(db, broker) is None:
        raise HTTPException(409, "The broker account changed. Refresh the page and try again.")
    wealthfolio.save(db, body.endpoint, password, target, broker)
    audit(db, "settings.wealthfolio", broker, {"action": "connect"}, client_ip(request))
    return wealthfolio.status(db, broker)


@router.delete("/connection")
def disconnect(
    request: Request, profile_id: str | None = None, db: Session = Depends(get_db)
) -> dict:
    db.execute(text("BEGIN IMMEDIATE"))
    broker = _key(db, profile_id)
    if broker:
        wealthfolio.pause(db, broker)
        audit(db, "settings.wealthfolio", broker, {"action": "pause"}, client_ip(request))
    return wealthfolio.status(db, broker)

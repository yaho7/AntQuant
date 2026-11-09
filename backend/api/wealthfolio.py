"""Configure the Wealthfolio destination for the active broker account."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import text
from sqlalchemy.orm import Session

from backend.adapters.brokers.endpoints import validate_endpoint
from backend.api.deps import client_ip, get_db, require_session
from backend.core.audit import audit
from backend.core.secrets import delete_secrets
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


def _credentials(db: Session, body: Endpoint) -> str:
    prior = wealthfolio.connection(db)
    if not body.password and prior and prior.endpoint == body.endpoint:
        return prior.password
    return body.password


def _accounts(endpoint: str, password: str) -> list[dict]:
    client = wealthfolio.WebClient(endpoint, password)
    try:
        return client.accounts()
    except wealthfolio.WealthfolioError as exc:
        raise HTTPException(502, str(exc)) from None
    finally:
        client.close()


@router.get("/connection")
def status(db: Session = Depends(get_db)) -> dict:
    return wealthfolio.status(db)


@router.post("/accounts")
def accounts(body: Endpoint, db: Session = Depends(get_db)) -> dict:
    return {"accounts": _accounts(body.endpoint, _credentials(db, body))}


@router.put("/connection")
def connect(body: Destination, request: Request, db: Session = Depends(get_db)) -> dict:
    broker = broker_service.connection_key(broker_service.trading_connection(db))
    if broker is None:
        raise HTTPException(409, "Connect a broker before configuring Wealthfolio.")
    password = _credentials(db, body)
    accounts = _accounts(body.endpoint, password)
    target = next((a for a in accounts if a["id"] == body.account_id), None)
    if target is None:
        raise HTTPException(400, "Select an available Wealthfolio account.")
    db.execute(text("BEGIN IMMEDIATE"))
    if broker_service.connection_key(broker_service.trading_connection(db)) != broker:
        raise HTTPException(409, "The active broker changed. Refresh the page and try again.")
    wealthfolio.save(db, body.endpoint, password, target, broker)
    audit(db, "settings.wealthfolio", "wealthfolio", {"action": "connect"}, client_ip(request))
    return wealthfolio.status(db)


@router.delete("/connection")
def disconnect(request: Request, db: Session = Depends(get_db)) -> dict:
    delete_secrets(db, wealthfolio.SECRET)
    audit(db, "settings.wealthfolio", "wealthfolio", {"action": "disconnect"}, client_ip(request))
    return wealthfolio.status(db)

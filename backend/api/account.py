"""Broker account data (account level, not per strategy)."""

from __future__ import annotations

from dataclasses import asdict
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from backend.adapters.brokers.base import BrokerAdapter, BrokerError
from backend.api.deps import get_db, require_session
from backend.services.broker_service import get_broker

router = APIRouter(prefix="/api/account", tags=["account"], dependencies=[Depends(require_session)])

NOT_CONNECTED = "No broker account is connected. Choose a broker in Settings."


def _broker_or_409(db: Session, profile_id: str | None) -> BrokerAdapter:
    broker = get_broker(db, profile_id)
    if broker is None:
        raise HTTPException(409, NOT_CONNECTED)
    return broker


def _call(fn):  # type: ignore[no-untyped-def]
    try:
        return fn()
    except BrokerError as exc:
        raise HTTPException(
            409 if exc.status_code == 401 else exc.status_code, exc.message
        ) from exc


@router.get("/summary")
def summary(profile_id: str | None = None, db: Session = Depends(get_db)) -> dict[str, Any]:
    broker = get_broker(db, profile_id)
    if broker is None:
        return {"connected": False, "account": None, "error": None}
    try:
        account = broker.get_account()
    except BrokerError as exc:
        return {"connected": True, "account": None, "error": exc.message}
    return {"connected": True, "account": account.to_dict(), "error": None}


@router.get("/positions")
def positions(profile_id: str | None = None, db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    broker = _broker_or_409(db, profile_id)
    return [asdict(p) for p in _call(broker.get_positions)]


@router.get("/orders")
def orders(
    status: str = Query("open", pattern="^(open|closed|all)$"),
    limit: int = Query(100, ge=1, le=500),
    profile_id: str | None = None,
    db: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    broker = _broker_or_409(db, profile_id)
    return [asdict(o) for o in _call(lambda: broker.get_orders(status, limit))]


@router.get("/history")
def history(
    period: str = Query("1M", pattern="^(1W|1M|3M|6M|1A|all)$"),
    profile_id: str | None = None,
    db: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    broker = _broker_or_409(db, profile_id)
    return [asdict(p) for p in _call(lambda: broker.get_portfolio_history(period, "1D"))]


@router.get("/clock")
def clock(profile_id: str | None = None, db: Session = Depends(get_db)) -> dict[str, Any]:
    broker = _broker_or_409(db, profile_id)
    return {"is_open": _call(broker.is_market_open)}

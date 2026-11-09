"""Strategy trading control. Pause, Stop and Liquidate are separate actions."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.adapters.brokers.base import BrokerError
from backend.api.deps import client_ip, get_db, require_session, settings_dep, task_manager
from backend.api.serializers import task_out
from backend.core.audit import audit
from backend.core.config import Settings
from backend.models import Strategy, Task
from backend.schemas import LiquidateRequest, TradingStart
from backend.services.broker_service import alpaca_credentials, get_broker
from backend.services.task_manager import ACTIVE, TaskError, TaskManager

router = APIRouter(prefix="/api/trading", tags=["trading"], dependencies=[Depends(require_session)])

LIQUIDATE_PHRASE = "LIQUIDATE"
LIVE_LIQUIDATE_PHRASE = "LIQUIDATE LIVE"


def _trading_task(db: Session, task_id: str) -> Task:
    task = db.get(Task, task_id)
    if task is None or task.kind != "trading":
        raise HTTPException(404, "Trading task not found.")
    return task


def _heartbeat(task: Task) -> dict[str, Any] | None:
    path = Path(task.work_dir) / "heartbeat.json"
    try:
        return json.loads(path.read_text())  # type: ignore[no-any-return]
    except (OSError, json.JSONDecodeError):
        return None


@router.get("/mode")
def mode(
    db: Session = Depends(get_db), settings: Settings = Depends(settings_dep)
) -> dict[str, Any]:
    creds = alpaca_credentials(db)
    live = creds is not None and not creds.paper
    return {
        "mode": "live" if live else "paper",
        "live_available": settings.live_trading_enabled,
        "live_note": None
        if settings.live_trading_enabled
        else "Live trading is disabled on this server.",
        "live_flag": settings.live_trading_enabled,
    }


@router.get("/tasks")
def tasks(
    active_only: bool = False,
    limit: int = Query(50, ge=1, le=500),
    db: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    query = select(Task).where(Task.kind == "trading").order_by(Task.created_at.desc())
    if active_only:
        query = query.where(Task.status.in_(ACTIVE))
    return [{**task_out(t), "heartbeat": _heartbeat(t)} for t in db.scalars(query.limit(limit))]


@router.post("/start")
def start(
    body: TradingStart,
    request: Request,
    db: Session = Depends(get_db),
    tm: TaskManager = Depends(task_manager),
    settings: Settings = Depends(settings_dep),
) -> dict[str, Any]:
    ip = client_ip(request)
    if body.mode == "live" and not settings.live_trading_enabled:
        audit(db, "trading.start_live_refused", str(body.strategy_id), {}, ip, success=False)
        raise HTTPException(403, "Live trading is disabled on this server.")
    strategy = db.get(Strategy, body.strategy_id)
    if strategy is None or strategy.archived:
        raise HTTPException(404, "Strategy not found.")
    try:
        task = tm.start_trading(db, strategy, body.mode)
    except TaskError as exc:
        audit(db, "trading.start", strategy.name, {"error": exc.message}, ip, success=False)
        raise HTTPException(exc.status_code, exc.message) from exc
    audit(db, "trading.start", strategy.name, {"task": task.id, "mode": body.mode}, ip)
    return task_out(task)


@router.post("/{task_id}/pause")
def pause(
    task_id: str,
    request: Request,
    db: Session = Depends(get_db),
    tm: TaskManager = Depends(task_manager),
) -> dict[str, Any]:
    _trading_task(db, task_id)
    try:
        task = tm.set_paused(db, task_id, True)
    except TaskError as exc:
        raise HTTPException(exc.status_code, exc.message) from exc
    audit(db, "trading.pause", task_id, {}, client_ip(request))
    return task_out(task)


@router.post("/{task_id}/resume")
def resume(
    task_id: str,
    request: Request,
    db: Session = Depends(get_db),
    tm: TaskManager = Depends(task_manager),
) -> dict[str, Any]:
    _trading_task(db, task_id)
    try:
        task = tm.set_paused(db, task_id, False)
    except TaskError as exc:
        raise HTTPException(exc.status_code, exc.message) from exc
    audit(db, "trading.resume", task_id, {}, client_ip(request))
    return task_out(task)


@router.post("/{task_id}/stop")
def stop(
    task_id: str,
    request: Request,
    db: Session = Depends(get_db),
    tm: TaskManager = Depends(task_manager),
) -> dict[str, Any]:
    """Stop the strategy process. Positions stay open."""
    _trading_task(db, task_id)
    task = tm.stop(db, task_id)
    audit(db, "trading.stop", task_id, {}, client_ip(request))
    return task_out(task)


@router.post("/emergency-stop")
def emergency_stop(
    request: Request, db: Session = Depends(get_db), tm: TaskManager = Depends(task_manager)
) -> dict[str, Any]:
    """Stop every trading strategy at once. Positions stay open."""
    ids = tm.stop_all_trading(db)
    audit(db, "trading.emergency_stop", "all", {"tasks": ids}, client_ip(request))
    return {"stopped": ids}


@router.post("/liquidate")
def liquidate(
    body: LiquidateRequest,
    request: Request,
    db: Session = Depends(get_db),
    settings: Settings = Depends(settings_dep),
) -> dict[str, Any]:
    """Close ALL positions in the broker account. Requires typing the phrase."""
    ip = client_ip(request)
    broker = get_broker(db)
    if broker is None:
        raise HTTPException(409, "No broker account is connected.")
    if not broker.paper and not settings.live_trading_enabled:
        raise HTTPException(403, "Live trading is disabled on this server.")
    phrase = LIQUIDATE_PHRASE if broker.paper else LIVE_LIQUIDATE_PHRASE
    if body.confirm != phrase:
        audit(db, "account.liquidate", "account", {"reason": "bad phrase"}, ip, success=False)
        raise HTTPException(400, f'Type "{phrase}" to confirm.')
    try:
        results = broker.close_all_positions(cancel_orders=body.cancel_orders)
    except BrokerError as exc:
        audit(db, "account.liquidate", "account", {"error": exc.message}, ip, success=False)
        raise HTTPException(exc.status_code, exc.message) from exc
    audit(db, "account.liquidate", "account", {"results": results}, ip)
    return {"results": results}


@router.get("/{task_id}/events")
def events(task_id: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    task = _trading_task(db, task_id)
    path = Path(task.work_dir) / "events.jsonl"
    fills = []
    if path.exists():
        for line in path.read_text().splitlines()[-1000:]:
            try:
                fills.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return {"task": task_out(task), "heartbeat": _heartbeat(task), "fills": fills[::-1]}

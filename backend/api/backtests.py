from __future__ import annotations

import csv
import io
import json
from dataclasses import asdict
from datetime import date
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.adapters.lumibot_adapter import DATA_SOURCES
from backend.api.deps import client_ip, get_db, require_session, task_manager
from backend.api.serializers import task_out
from backend.core.audit import audit
from backend.models import BacktestResult, Strategy, Task
from backend.schemas import BacktestCreate
from backend.services.broker_service import alpaca_credentials
from backend.services.settings_store import get_setting
from backend.services.task_manager import TaskError, TaskManager

router = APIRouter(
    prefix="/api/backtests", tags=["backtests"], dependencies=[Depends(require_session)]
)

FILE_TYPES = {
    "tearsheet_html": "text/html",
    "plot_html": "text/html",
    "indicators_html": "text/html",
    "stats": "text/csv",
    "trades": "text/csv",
    "tearsheet_csv": "text/csv",
    "tearsheet_metrics": "application/json",
    "settings": "application/json",
    "logfile": "text/plain",
}


def _task(db: Session, task_id: str) -> Task:
    task = db.get(Task, task_id)
    if task is None or task.kind != "backtest":
        raise HTTPException(404, "Backtest not found.")
    return task


@router.get("/options")
def options(db: Session = Depends(get_db)) -> dict[str, Any]:
    has_keys = alpaca_credentials(db) is not None
    return {
        "data_sources": [
            {**asdict(ds), "available": has_keys or not ds.requires_alpaca_keys}
            for ds in DATA_SOURCES.values()
        ],
        "defaults": get_setting(db, "backtest_defaults"),
    }


@router.post("")
def create(
    body: BacktestCreate,
    request: Request,
    db: Session = Depends(get_db),
    tm: TaskManager = Depends(task_manager),
) -> dict[str, Any]:
    strategy = db.get(Strategy, body.strategy_id)
    if strategy is None or strategy.archived:
        raise HTTPException(404, "Strategy not found.")
    if body.end <= body.start:
        raise HTTPException(400, "End date must be after start date.")
    if body.end > date.today():
        raise HTTPException(400, "End date cannot be in the future.")
    if DATA_SOURCES[body.data_source].requires_alpaca_keys and alpaca_credentials(db) is None:
        raise HTTPException(400, "This data source needs Alpaca keys. Add them in Settings.")
    config = {
        "data_source": body.data_source,
        "start": body.start.isoformat(),
        "end": body.end.isoformat(),
        "budget": body.budget,
        "benchmark": (body.benchmark or "").upper() or None,
        "parameters": body.parameters if body.parameters is not None else strategy.parameters,
    }
    try:
        task = tm.create_backtest(db, strategy, config)
    except TaskError as exc:
        raise HTTPException(exc.status_code, exc.message) from exc
    audit(db, "backtest.create", task.id, {"strategy": strategy.name, **config}, client_ip(request))
    db.refresh(task)
    return task_out(task)


@router.get("")
def list_backtests(
    strategy_id: int | None = None,
    limit: int = Query(100, ge=1, le=500),
    db: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    query = select(Task).where(Task.kind == "backtest").order_by(Task.created_at.desc())
    if strategy_id is not None:
        query = query.where(Task.strategy_id == strategy_id)
    out = []
    for task in db.scalars(query.limit(limit)):
        result = db.get(BacktestResult, task.id)
        out.append({**task_out(task), "metrics": result.metrics if result else None})
    return out


@router.get("/{task_id}")
def get_one(task_id: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    task = _task(db, task_id)
    result = db.get(BacktestResult, task.id)
    return {
        **task_out(task),
        "metrics": result.metrics if result else None,
        "files": result.files if result else {},
    }


@router.get("/{task_id}/result")
def result(task_id: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    task = _task(db, task_id)
    path = Path(task.work_dir) / "result.json"
    if task.status != "completed" or not path.exists():
        raise HTTPException(409, "The backtest has no result yet.")
    data = json.loads(path.read_text())
    data.pop("analysis", None)
    return data  # type: ignore[no-any-return]


@router.get("/{task_id}/files/{kind}")
def file(task_id: str, kind: str, db: Session = Depends(get_db)) -> FileResponse:
    task = _task(db, task_id)
    row = db.get(BacktestResult, task.id)
    if row is None or kind not in row.files or kind not in FILE_TYPES:
        raise HTTPException(404, "File not available for this backtest.")
    work_dir = Path(task.work_dir).resolve()
    target = (work_dir / row.files[kind]).resolve()
    if not target.is_relative_to(work_dir) or not target.is_file():
        raise HTTPException(404, "File not found.")
    media = FILE_TYPES[kind]
    headers = {"Content-Security-Policy": "sandbox allow-scripts"} if media == "text/html" else {}
    return FileResponse(
        target,
        media_type=media,
        filename=f"{task.strategy_name}_{task.id}_{target.name}",
        content_disposition_type="inline" if media == "text/html" else "attachment",
        headers=headers,
    )


@router.get("/{task_id}/export/trades.csv")
def export_trades(task_id: str, db: Session = Depends(get_db)) -> Response:
    data = result(task_id, db)
    buf = io.StringIO()
    fields = ["time", "symbol", "asset_type", "side", "quantity", "price", "multiplier", "fee",
              "order_type"]
    writer = csv.DictWriter(buf, fieldnames=fields, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(data.get("trades", []))
    return Response(
        buf.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="trades_{task_id}.csv"'},
    )


@router.get("/{task_id}/export/equity.csv")
def export_equity(task_id: str, db: Session = Depends(get_db)) -> Response:
    data = result(task_id, db)
    dd = {p["time"]: p["value"] for p in data.get("drawdown_curve", [])}
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["date", "portfolio_value", "drawdown"])
    for p in data.get("equity_curve", []):
        writer.writerow([p["time"], p["value"], dd.get(p["time"])])
    return Response(
        buf.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="equity_{task_id}.csv"'},
    )


@router.post("/{task_id}/stop")
def stop(
    task_id: str,
    request: Request,
    db: Session = Depends(get_db),
    tm: TaskManager = Depends(task_manager),
) -> dict[str, Any]:
    _task(db, task_id)
    try:
        task = tm.stop(db, task_id)
    except TaskError as exc:
        raise HTTPException(exc.status_code, exc.message) from exc
    audit(db, "backtest.stop", task_id, {}, client_ip(request))
    return task_out(task)

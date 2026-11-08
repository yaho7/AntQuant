from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.api.deps import client_ip, get_db, require_session, settings_dep
from backend.api.serializers import strategy_out, task_out, version_out
from backend.core.audit import audit
from backend.core.config import Settings
from backend.models import BacktestResult, Strategy, StrategyVersion, Task
from backend.schemas import StrategyCreate, StrategyUpdate
from backend.services import strategy_service as svc
from backend.services.strategy_service import StrategyError

router = APIRouter(
    prefix="/api/strategies", tags=["strategies"], dependencies=[Depends(require_session)]
)


def _get(db: Session, strategy_id: int) -> Strategy:
    strategy = db.get(Strategy, strategy_id)
    if strategy is None:
        raise HTTPException(404, "Strategy not found.")
    return strategy


def _wrap(fn):  # type: ignore[no-untyped-def]
    try:
        return fn()
    except StrategyError as exc:
        raise HTTPException(exc.status_code, exc.message) from exc


@router.get("")
def list_strategies(
    include_archived: bool = False, db: Session = Depends(get_db)
) -> list[dict[str, Any]]:
    query = select(Strategy).order_by(Strategy.name)
    if not include_archived:
        query = query.where(Strategy.archived.is_(False))
    out = []
    for s in db.scalars(query):
        data = strategy_out(s)
        trading = db.scalar(
            select(Task)
            .where(Task.strategy_id == s.id, Task.kind == "trading")
            .order_by(Task.created_at.desc())
            .limit(1)
        )
        data["trading_task"] = task_out(trading) if trading else None
        out.append(data)
    return out


@router.get("/discover")
def discover(settings: Settings = Depends(settings_dep)) -> list[dict[str, Any]]:
    """Strategy classes found in strategy files (parsed, not executed)."""
    return [d.to_dict() for d in svc.discover(settings)]


@router.post("")
def create(
    body: StrategyCreate,
    request: Request,
    db: Session = Depends(get_db),
    settings: Settings = Depends(settings_dep),
) -> dict[str, Any]:
    strategy = _wrap(
        lambda: svc.create_strategy(
            db,
            settings,
            name=body.name.strip(),
            description=body.description,
            source_path=body.source_path,
            class_name=body.class_name,
            parameters=body.parameters,
        )
    )
    audit(db, "strategy.create", strategy.name, {"source": body.source_path}, client_ip(request))
    return strategy_out(strategy)


@router.post("/upload")
async def upload(
    request: Request,
    file: UploadFile = File(...),
    acknowledge_risk: bool = Form(False),
    settings: Settings = Depends(settings_dep),
    db: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    if not acknowledge_risk:
        raise HTTPException(
            400, "Confirm that you trust this code: it runs with the server's permissions."
        )
    content = await file.read(svc.MAX_UPLOAD_BYTES + 1)
    found = _wrap(lambda: svc.save_upload(settings, file.filename or "strategy.py", content))
    audit(
        db,
        "strategy.upload",
        found[0].source_path,
        {"classes": [f.class_name for f in found], "sha256": found[0].sha256},
        client_ip(request),
    )
    return [f.to_dict() for f in found]


@router.get("/{strategy_id}")
def get_one(strategy_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    return strategy_out(_get(db, strategy_id))


@router.patch("/{strategy_id}")
def update(
    strategy_id: int,
    body: StrategyUpdate,
    request: Request,
    db: Session = Depends(get_db),
    settings: Settings = Depends(settings_dep),
) -> dict[str, Any]:
    strategy = _get(db, strategy_id)
    strategy = _wrap(
        lambda: svc.update_strategy(
            db,
            settings,
            strategy,
            name=body.name.strip() if body.name else None,
            description=body.description,
            parameters=body.parameters,
            note=body.note,
        )
    )
    audit(db, "strategy.update", strategy.name, {"version": strategy.version}, client_ip(request))
    return strategy_out(strategy)


@router.post("/{strategy_id}/archive")
def archive(
    strategy_id: int, request: Request, archived: bool = True, db: Session = Depends(get_db)
) -> dict[str, Any]:
    strategy = _get(db, strategy_id)
    active = db.scalar(
        select(Task.id).where(
            Task.strategy_id == strategy_id, Task.status.in_(("pending", "starting", "running"))
        )
    )
    if archived and active:
        raise HTTPException(409, "Stop running tasks of this strategy first.")
    strategy.archived = archived
    db.commit()
    audit(db, "strategy.archive", strategy.name, {"archived": archived}, client_ip(request))
    return strategy_out(strategy)


@router.get("/{strategy_id}/versions")
def versions(strategy_id: int, db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    _get(db, strategy_id)
    rows = db.scalars(
        select(StrategyVersion)
        .where(StrategyVersion.strategy_id == strategy_id)
        .order_by(StrategyVersion.version.desc())
    )
    return [version_out(v) for v in rows]


@router.post("/{strategy_id}/versions/{version}/restore")
def restore_version(
    strategy_id: int,
    version: int,
    request: Request,
    db: Session = Depends(get_db),
    settings: Settings = Depends(settings_dep),
) -> dict[str, Any]:
    strategy = _get(db, strategy_id)
    snap = db.scalar(
        select(StrategyVersion).where(
            StrategyVersion.strategy_id == strategy_id, StrategyVersion.version == version
        )
    )
    if snap is None:
        raise HTTPException(404, "Version not found.")
    strategy = _wrap(
        lambda: svc.update_strategy(
            db,
            settings,
            strategy,
            description=snap.description,
            parameters=snap.parameters,
            note=f"Restored parameters from v{version}",
        )
    )
    audit(db, "strategy.restore", strategy.name, {"from": version}, client_ip(request))
    return strategy_out(strategy)


@router.get("/{strategy_id}/source")
def source(
    strategy_id: int, db: Session = Depends(get_db), settings: Settings = Depends(settings_dep)
) -> dict[str, Any]:
    strategy = _get(db, strategy_id)
    path = _wrap(lambda: svc.resolve_source(settings, strategy.source_path))
    return {
        "source_path": strategy.source_path,
        "sha256": svc.file_sha256(path),
        "code": path.read_text(encoding="utf-8", errors="replace"),
    }


@router.get("/{strategy_id}/performance")
def performance(strategy_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    """Strategy-level view: its backtests and the fills its paper runs recorded."""
    _get(db, strategy_id)
    backtests = []
    for task in db.scalars(
        select(Task)
        .where(Task.strategy_id == strategy_id, Task.kind == "backtest")
        .order_by(Task.created_at.desc())
        .limit(20)
    ):
        result = db.get(BacktestResult, task.id)
        backtests.append({**task_out(task), "metrics": result.metrics if result else None})
    fills: list[dict[str, Any]] = []
    for task in db.scalars(
        select(Task)
        .where(Task.strategy_id == strategy_id, Task.kind == "trading")
        .order_by(Task.created_at.desc())
        .limit(20)
    ):
        events = Path(task.work_dir) / "events.jsonl"
        if events.exists():
            for line in events.read_text().splitlines()[-500:]:
                try:
                    fills.append({**json.loads(line), "task_id": task.id})
                except json.JSONDecodeError:
                    continue
    fills.sort(key=lambda f: f.get("time", ""), reverse=True)
    return {"backtests": backtests, "fills": fills[:500]}

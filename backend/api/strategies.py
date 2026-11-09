from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from backend.api.deps import client_ip, get_db, require_session, settings_dep
from backend.api.serializers import strategy_out, task_out, version_out
from backend.core.audit import audit
from backend.core.config import Settings
from backend.models import BacktestResult, Strategy, StrategyVersion, Task
from backend.schemas import (
    StrategyCode,
    StrategyCreate,
    StrategyImport,
    StrategySourceUpdate,
    StrategyUpdate,
)
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


def _get_for_update(db: Session, strategy_id: int, expected_version: int | None = None) -> Strategy:
    db.execute(text("BEGIN IMMEDIATE"))
    strategy = _get(db, strategy_id)
    if expected_version is not None and strategy.version != expected_version:
        raise HTTPException(409, "This strategy was updated. Reload it before saving.")
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


@router.post("/scan")
def scan(body: StrategyCode) -> dict[str, Any]:
    try:
        found = svc.scan_code(body.filename, body.code.encode("utf-8"))
    except svc.StrategySyntaxError as exc:
        return {"classes": [], "error": exc.message, "line": exc.line, "reason": exc.reason}
    except StrategyError as exc:
        return {"classes": [], "error": exc.message}
    return {"classes": [item.to_dict() for item in found]}


def _require_trusted_code(acknowledge_risk: bool) -> None:
    if not acknowledge_risk:
        raise HTTPException(
            400, "Confirm that you trust this code: it runs with the server's permissions."
        )


@router.post("/import")
def import_strategy(
    body: StrategyImport,
    request: Request,
    db: Session = Depends(get_db),
    settings: Settings = Depends(settings_dep),
) -> dict[str, Any]:
    _require_trusted_code(body.acknowledge_risk)
    found = _wrap(lambda: svc.save_upload(settings, body.filename, body.code.encode("utf-8")))
    path = found[0].source_path
    try:
        strategy = _wrap(
            lambda: svc.create_strategy(
                db,
                settings,
                name=body.name.strip(),
                description=body.description,
                source_path=path,
                class_name=body.class_name,
                parameters=body.parameters,
            )
        )
    except Exception:
        svc.resolve_source(settings, path).unlink(missing_ok=True)
        raise
    audit(db, "strategy.create", strategy.name, {"source": path}, client_ip(request))
    return strategy_out(strategy)


@router.post("/upload")
async def upload(
    request: Request,
    file: UploadFile = File(...),
    acknowledge_risk: bool = Form(False),
    settings: Settings = Depends(settings_dep),
    db: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    _require_trusted_code(acknowledge_risk)
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
    strategy = _get_for_update(db, strategy_id, body.expected_version)
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
def versions(
    strategy_id: int,
    db: Session = Depends(get_db),
    settings: Settings = Depends(settings_dep),
) -> list[dict[str, Any]]:
    _get(db, strategy_id)
    rows = db.scalars(
        select(StrategyVersion)
        .where(StrategyVersion.strategy_id == strategy_id)
        .order_by(StrategyVersion.version.desc())
    )
    return [
        {**version_out(v), "code_available": svc.version_code(settings, v) is not None}
        for v in rows
    ]


@router.post("/{strategy_id}/versions/{version}/restore")
def restore_version(
    strategy_id: int,
    version: int,
    request: Request,
    parameters_only: bool = False,
    db: Session = Depends(get_db),
    settings: Settings = Depends(settings_dep),
) -> dict[str, Any]:
    strategy = _get_for_update(db, strategy_id)
    snap = svc.get_version(db, strategy_id, version)
    if snap is None:
        raise HTTPException(404, "Version not found.")
    code = (
        _wrap(lambda: svc.current_code(db, settings, strategy))
        if parameters_only
        else svc.version_code(settings, snap)
    )
    if code is None:
        raise HTTPException(
            409, "Code for this older version is unavailable. Restore its parameters only."
        )
    restored = "parameters" if parameters_only else "code and parameters"
    strategy = _wrap(
        lambda: svc.update_strategy(
            db,
            settings,
            strategy,
            description=snap.description,
            parameters=snap.parameters,
            content=code,
            class_name=None if parameters_only else snap.class_name,
            source_path=None if parameters_only else snap.source_path,
            note=f"Restored {restored} from v{version}",
        )
    )
    audit(db, "strategy.restore", strategy.name, {"from": version}, client_ip(request))
    return strategy_out(strategy)


@router.get("/{strategy_id}/source")
def source(
    strategy_id: int, db: Session = Depends(get_db), settings: Settings = Depends(settings_dep)
) -> dict[str, Any]:
    strategy = _get(db, strategy_id)
    code = _wrap(lambda: svc.current_code(db, settings, strategy))
    sha = hashlib.sha256(code).hexdigest()
    version = svc.get_version(db, strategy.id, strategy.version)
    editable = svc.editable_source(strategy.source_path)
    modified = version is None or version.code_sha256 != sha
    if not editable:
        path = _wrap(lambda: svc.resolve_source(settings, strategy.source_path, must_exist=False))
        modified = modified or (path.is_file() and path.read_bytes() != code)
    return {
        "source_path": strategy.source_path,
        "sha256": sha,
        "code": code.decode("utf-8", errors="replace"),
        "editable": editable,
        "modified": modified,
        "version": strategy.version,
    }


@router.put("/{strategy_id}/source")
def save_source(
    strategy_id: int,
    body: StrategySourceUpdate,
    request: Request,
    db: Session = Depends(get_db),
    settings: Settings = Depends(settings_dep),
) -> dict[str, Any]:
    _require_trusted_code(body.acknowledge_risk)
    code = body.code.encode("utf-8")
    classes = _wrap(lambda: svc.scan_code(body.filename, code))
    if not any(item.class_name == body.class_name for item in classes):
        raise HTTPException(400, "Select a strategy class found in this file.")
    strategy = _get_for_update(db, strategy_id, body.expected_version)
    if not svc.editable_source(strategy.source_path):
        raise HTTPException(409, "Only uploaded strategies can be edited here.")
    strategy = _wrap(
        lambda: svc.update_strategy(
            db,
            settings,
            strategy,
            content=code,
            class_name=body.class_name,
            parameters=body.parameters,
            note="Updated code",
        )
    )
    audit(db, "strategy.source", strategy.name, {"version": strategy.version}, client_ip(request))
    return strategy_out(strategy)


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
                    fills.append(
                        {
                            **json.loads(line),
                            "task_id": task.id,
                            "profile_id": task.config.get("broker_key"),
                            "profile_name": task.config.get("profile_name"),
                        }
                    )
                except json.JSONDecodeError:
                    continue
    fills.sort(key=lambda f: f.get("time", ""), reverse=True)
    return {"backtests": backtests, "fills": fills[:500]}

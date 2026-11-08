"""Unified log viewer. Sources are named, never raw paths."""

from __future__ import annotations

from dataclasses import asdict
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import PlainTextResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.api.deps import get_db, require_session, settings_dep
from backend.core.config import Settings
from backend.core.logging import redact
from backend.models import Task
from backend.services.log_service import LEVELS, read_entries, system_log_path

router = APIRouter(prefix="/api/logs", tags=["logs"], dependencies=[Depends(require_session)])

# name -> (label, logger prefix filter on system.log)
SYSTEM_SOURCES = {
    "system": ("System", None),
    "api": ("API errors", "api"),
    "audit": ("Audit / trading actions", "audit"),
}


def _resolve(db: Session, settings: Settings, source: str) -> tuple[Path, str | None]:
    if source in SYSTEM_SOURCES:
        return system_log_path(settings), SYSTEM_SOURCES[source][1]
    if source.startswith("task:"):
        task = db.get(Task, source[5:])
        if task is None:
            raise HTTPException(404, "Task not found.")
        return Path(task.log_path), None
    raise HTTPException(400, "Unknown log source.")


@router.get("/sources")
def sources(
    strategy_id: int | None = None,
    kind: str | None = Query(None, pattern="^(backtest|trading)$"),
    db: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if strategy_id is None and kind is None:
        out = [{"id": k, "label": v[0], "group": "system"} for k, v in SYSTEM_SOURCES.items()]
    query = select(Task).order_by(Task.created_at.desc()).limit(200)
    if strategy_id is not None:
        query = query.where(Task.strategy_id == strategy_id)
    if kind is not None:
        query = query.where(Task.kind == kind)
    for task in db.scalars(query):
        out.append(
            {
                "id": f"task:{task.id}",
                "label": f"{task.strategy_name} · {task.kind} · {task.id[:8]}",
                "group": task.kind,
                "status": task.status,
                "strategy_id": task.strategy_id,
            }
        )
    return out


@router.get("")
def read(
    source: str = "system",
    level: str | None = Query(None, pattern="^(DEBUG|INFO|WARNING|ERROR|CRITICAL)$"),
    q: str | None = Query(None, max_length=200),
    limit: int = Query(500, ge=1, le=5000),
    db: Session = Depends(get_db),
    settings: Settings = Depends(settings_dep),
) -> dict[str, Any]:
    path, prefix = _resolve(db, settings, source)
    entries = read_entries(path, min_level=level, search=q, logger_prefix=prefix, limit=limit)
    return {"source": source, "levels": LEVELS, "entries": [asdict(e) for e in entries]}


@router.get("/download")
def download(
    source: str = "system",
    db: Session = Depends(get_db),
    settings: Settings = Depends(settings_dep),
) -> PlainTextResponse:
    path, _ = _resolve(db, settings, source)
    text = redact(path.read_text(encoding="utf-8", errors="replace")) if path.exists() else ""
    name = source.replace(":", "_")
    return PlainTextResponse(
        text, headers={"Content-Disposition": f'attachment; filename="{name}.log"'}
    )

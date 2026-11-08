from __future__ import annotations

from typing import Any

from backend.models import Strategy, StrategyVersion, Task
from backend.services.task_manager import aware


def _iso(dt):  # type: ignore[no-untyped-def]
    dt = aware(dt)
    return dt.isoformat() if dt else None


def task_out(task: Task) -> dict[str, Any]:
    return {
        "id": task.id,
        "kind": task.kind,
        "mode": task.mode,
        "status": task.status,
        "strategy_id": task.strategy_id,
        "strategy_name": task.strategy_name,
        "strategy_version": task.strategy_version,
        "config": task.config,
        "paused": task.paused,
        "pid": task.pid,
        "progress": task.progress,
        "exit_code": task.exit_code,
        "error_message": task.error_message,
        "created_at": _iso(task.created_at),
        "started_at": _iso(task.started_at),
        "ended_at": _iso(task.ended_at),
    }


def strategy_out(s: Strategy) -> dict[str, Any]:
    return {
        "id": s.id,
        "name": s.name,
        "description": s.description,
        "source_path": s.source_path,
        "class_name": s.class_name,
        "parameters": s.parameters,
        "version": s.version,
        "archived": s.archived,
        "created_at": _iso(s.created_at),
        "updated_at": _iso(s.updated_at),
    }


def version_out(v: StrategyVersion) -> dict[str, Any]:
    return {
        "version": v.version,
        "name": v.name,
        "description": v.description,
        "parameters": v.parameters,
        "source_path": v.source_path,
        "class_name": v.class_name,
        "code_sha256": v.code_sha256,
        "note": v.note,
        "created_at": _iso(v.created_at),
    }

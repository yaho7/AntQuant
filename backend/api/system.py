"""Settings, system info, version and update checks."""

from __future__ import annotations

import platform
import shutil
import sys
import time
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from backend import __version__
from backend.adapters.brokers.alpaca import AlpacaAdapter
from backend.adapters.brokers.base import BrokerError
from backend.adapters.lumibot_adapter import (
    VERIFIED_LUMIBOT_VERSIONS,
    compatibility_report,
    lumibot_version,
)
from backend.api.deps import client_ip, get_db, require_session, settings_dep
from backend.api.serializers import _iso, task_out
from backend.core.audit import audit
from backend.core.config import Settings
from backend.core.secrets import mask
from backend.models import AuditLog, SystemEvent, Task
from backend.schemas import AlpacaCredentials, BacktestDefaults, SettingUpdate
from backend.services import broker_service
from backend.services.settings_store import all_settings, set_setting
from backend.services.task_manager import ACTIVE

router = APIRouter(prefix="/api", tags=["system"], dependencies=[Depends(require_session)])
public = APIRouter(prefix="/api", tags=["health"])

STARTED = time.time()
_update_cache: tuple[float, dict[str, Any]] | None = None


@public.get("/health")
def health(db: Session = Depends(get_db)) -> dict[str, str]:
    db.execute(select(1))
    return {"status": "ok", "version": __version__}


def _alpaca_status(db: Session) -> dict[str, Any]:
    creds = broker_service.alpaca_credentials(db)
    return {
        "configured": creds is not None,
        "api_key_hint": mask(creds.key) if creds else None,
        "paper": creds.paper if creds else True,
    }


@router.get("/settings")
def get_settings_view(db: Session = Depends(get_db)) -> dict[str, Any]:
    return {"settings": all_settings(db), "alpaca": _alpaca_status(db)}


@router.put("/settings/backtest_defaults")
def put_backtest_defaults(
    body: BacktestDefaults, request: Request, db: Session = Depends(get_db)
) -> dict[str, Any]:
    set_setting(db, "backtest_defaults", body.model_dump())
    audit(db, "settings.update", "backtest_defaults", body.model_dump(), client_ip(request))
    return {"settings": all_settings(db)}


_INT_SETTINGS = {
    "backtest_timeout_minutes": (5, 24 * 60),
    "max_concurrent_backtests": (1, 8),
    "log_retention_days": (1, 3650),
}


@router.put("/settings/{key}")
def put_setting(
    key: str, body: SettingUpdate, request: Request, db: Session = Depends(get_db)
) -> dict[str, Any]:
    if key not in _INT_SETTINGS:
        raise HTTPException(404, "Unknown setting.")
    low, high = _INT_SETTINGS[key]
    if (
        not isinstance(body.value, int)
        or isinstance(body.value, bool)
        or not (low <= body.value <= high)
    ):
        raise HTTPException(400, f"Value must be a whole number from {low} to {high}.")
    set_setting(db, key, body.value)
    audit(db, "settings.update", key, {"value": body.value}, client_ip(request))
    return {"settings": all_settings(db)}


@router.put("/settings/alpaca/credentials")
def put_alpaca(
    body: AlpacaCredentials, request: Request, db: Session = Depends(get_db)
) -> dict[str, Any]:
    """Write-only: the secret is encrypted at rest and never returned."""
    db.execute(text("BEGIN IMMEDIATE"))
    if db.scalar(select(Task.id).where(Task.kind == "trading", Task.status.in_(ACTIVE)).limit(1)):
        raise HTTPException(409, "Stop all trading strategies before replacing the keys.")
    broker_service.save_alpaca_credentials(db, body.api_key, body.api_secret, body.paper)
    audit(
        db,
        "settings.alpaca_credentials",
        "alpaca",
        {"action": "set", "paper": body.paper},
        client_ip(request),
    )
    broker_service.reset_broker()
    return _alpaca_status(db)


@router.delete("/settings/alpaca/credentials")
def delete_alpaca(request: Request, db: Session = Depends(get_db)) -> dict[str, Any]:
    db.execute(text("BEGIN IMMEDIATE"))
    if db.scalar(select(Task.id).where(Task.kind == "trading", Task.status.in_(ACTIVE)).limit(1)):
        raise HTTPException(409, "Stop all trading strategies before removing the keys.")
    broker_service.remove_alpaca_credentials(db)
    audit(db, "settings.alpaca_credentials", "alpaca", {"action": "delete"}, client_ip(request))
    broker_service.reset_broker()
    return _alpaca_status(db)


@router.post("/settings/alpaca/test")
def test_alpaca(
    request: Request,
    body: AlpacaCredentials | None = None,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Test given keys (before saving) or the stored ones."""
    if body is not None:
        adapter: Any = AlpacaAdapter(body.api_key, body.api_secret, paper=body.paper)
    else:
        adapter = broker_service.get_broker(db)
        if adapter is None:
            raise HTTPException(409, "No Alpaca keys are stored.")
    try:
        account = adapter.get_account()
    except BrokerError as exc:
        return {"ok": False, "error": exc.message}
    return {
        "ok": True,
        "account_id": mask(account.account_id),
        "status": account.status,
        "paper": account.paper,
    }


@router.get("/system/status")
def system_status(db: Session = Depends(get_db)) -> dict[str, Any]:
    active = db.scalars(select(Task).where(Task.status.in_(ACTIVE))).all()
    events = db.scalars(select(SystemEvent).order_by(SystemEvent.id.desc()).limit(10)).all()
    version = lumibot_version()
    return {
        "ui_version": __version__,
        "lumibot_version": version,
        "lumibot_verified": version in VERIFIED_LUMIBOT_VERSIONS,
        "broker": _alpaca_status(db),
        "uptime_seconds": int(time.time() - STARTED),
        "active_tasks": [task_out(t) for t in active],
        "events": [
            {
                "time": _iso(e.created_at),
                "level": e.level,
                "source": e.source,
                "message": e.message,
            }
            for e in events
        ],
    }


@router.get("/system/info")
def system_info(db: Session = Depends(get_db), settings: Settings = Depends(settings_dep)) -> dict:
    usage = shutil.disk_usage(settings.data_dir)
    task_count = db.scalar(select(func.count()).select_from(Task)) or 0
    return {
        "ui_version": __version__,
        "lumibot_version": lumibot_version(),
        "verified_lumibot_versions": list(VERIFIED_LUMIBOT_VERSIONS),
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "data_dir": str(settings.data_dir),
        "disk_free_bytes": usage.free,
        "disk_total_bytes": usage.total,
        "task_count": task_count,
        "uptime_seconds": int(time.time() - STARTED),
        "live_trading_available": settings.live_trading_enabled,
    }


@router.get("/system/compat")
def compat(refresh: bool = False) -> dict[str, Any]:
    return compatibility_report(refresh=refresh)


@router.get("/system/updates")
def updates(settings: Settings = Depends(settings_dep)) -> dict[str, Any]:
    """Look up the newest LumiBot on PyPI and the newest LumiBot UI release on GitHub.

    Informational only: nothing is installed. Update by pulling a newer image.
    """
    global _update_cache
    if _update_cache and time.time() - _update_cache[0] < 3600:
        return _update_cache[1]
    out: dict[str, Any] = {
        "lumibot": {"installed": lumibot_version(), "latest": None, "error": None},
        "ui": {"installed": __version__, "latest": None, "error": None},
    }
    with httpx.Client(timeout=8, follow_redirects=True) as client:
        try:
            r = client.get("https://pypi.org/pypi/lumibot/json")
            r.raise_for_status()
            out["lumibot"]["latest"] = r.json()["info"]["version"]
        except (httpx.HTTPError, KeyError, ValueError) as exc:
            out["lumibot"]["error"] = f"PyPI check failed: {type(exc).__name__}"
        try:
            r = client.get(f"https://api.github.com/repos/{settings.github_repo}/releases/latest")
            if r.status_code == 404:
                out["ui"]["error"] = "No published release yet."
            else:
                r.raise_for_status()
                out["ui"]["latest"] = str(r.json().get("tag_name", "")).lstrip("v") or None
        except (httpx.HTTPError, ValueError) as exc:
            out["ui"]["error"] = f"GitHub check failed: {type(exc).__name__}"
    _update_cache = (time.time(), out)
    return out


@router.get("/audit")
def audit_log(limit: int = 100, db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    rows = db.scalars(select(AuditLog).order_by(AuditLog.id.desc()).limit(min(limit, 500)))
    return [
        {
            "time": _iso(r.created_at),
            "action": r.action,
            "target": r.target,
            "detail": r.detail,
            "ip": r.ip,
            "success": r.success,
        }
        for r in rows
    ]

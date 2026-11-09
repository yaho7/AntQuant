"""Typed access to user settings stored in the `setting` table."""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from sqlalchemy.orm import Session

from backend.models import SettingValue

DEFAULTS: dict[str, Any] = {
    "backtest_defaults": {"data_source": "yahoo", "budget": 100000.0, "benchmark": "SPY"},
    "backtest_timeout_minutes": 120,
    "max_concurrent_backtests": 1,
    "log_retention_days": 30,
}

ALPACA_KEY = "alpaca_api_key"
ALPACA_SECRET = "alpaca_api_secret"  # noqa: S105 - secret name, not a value
ALPACA_MODE = "alpaca_mode"
ALPACA_ENDPOINT = "alpaca_endpoint"


def get_setting(db: Session, key: str) -> Any:
    row = db.get(SettingValue, key)
    if row is None:
        return deepcopy(DEFAULTS.get(key))
    default = DEFAULTS.get(key)
    if isinstance(default, dict) and isinstance(row.value, dict):
        return {**default, **row.value}
    return row.value


def set_setting(db: Session, key: str, value: Any) -> None:
    if key not in DEFAULTS:
        raise KeyError(key)
    row = db.get(SettingValue, key)
    if row is None:
        db.add(SettingValue(key=key, value=value))
    else:
        row.value = value
    db.commit()


def all_settings(db: Session) -> dict[str, Any]:
    return {key: get_setting(db, key) for key in DEFAULTS}

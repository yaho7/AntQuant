"""Request and response bodies."""

from __future__ import annotations

from datetime import date
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class SetupRequest(BaseModel):
    username: str = Field(min_length=3, max_length=64, pattern=r"^[A-Za-z0-9_.\-]+$")
    password: str = Field(min_length=1, max_length=256)
    alpaca_api_key: str | None = Field(default=None, max_length=128)
    alpaca_api_secret: str | None = Field(default=None, max_length=256)
    alpaca_paper: bool = True


class LoginRequest(BaseModel):
    username: str = Field(max_length=64)
    password: str = Field(max_length=256)


class PasswordChange(BaseModel):
    current_password: str = Field(max_length=256)
    new_password: str = Field(max_length=256)


class AlpacaCredentials(BaseModel):
    api_key: str = Field(min_length=8, max_length=128, pattern=r"^[A-Za-z0-9]+$")
    api_secret: str = Field(min_length=16, max_length=256, pattern=r"^[A-Za-z0-9/+=]+$")
    paper: bool = True


# Strategy parameters are JSON values passed to LumiBot as a dict. They never
# reach a command line: workers read them from spec.json.
ParamValue = str | int | float | bool | None | list[Any] | dict[str, Any]


def _check_params(value: dict[str, Any]) -> dict[str, Any]:
    if len(value) > 100:
        raise ValueError("Too many parameters.")
    for key in value:
        if not isinstance(key, str) or not key.isidentifier():
            raise ValueError(f"Invalid parameter name: {key!r}")
    return value


class StrategyCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    description: str = Field(default="", max_length=4000)
    source_path: str = Field(max_length=512)
    class_name: str = Field(max_length=128, pattern=r"^[A-Za-z_][A-Za-z0-9_]*$")
    parameters: dict[str, ParamValue] | None = None

    _v = field_validator("parameters")(lambda v: v if v is None else _check_params(v))


class StrategyUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=128)
    description: str | None = Field(default=None, max_length=4000)
    parameters: dict[str, ParamValue] | None = None
    note: str = Field(default="", max_length=255)

    _v = field_validator("parameters")(lambda v: v if v is None else _check_params(v))


class BacktestCreate(BaseModel):
    strategy_id: int
    data_source: Literal["yahoo", "alpaca"] = "yahoo"
    start: date
    end: date
    budget: float = Field(gt=0, le=1e12)
    benchmark: str | None = Field(default="SPY", max_length=16, pattern=r"^[A-Za-z0-9.\-]*$")
    parameters: dict[str, ParamValue] | None = None

    _v = field_validator("parameters")(lambda v: v if v is None else _check_params(v))


class TradingStart(BaseModel):
    strategy_id: int
    mode: Literal["paper", "live"] = "paper"


class LiquidateRequest(BaseModel):
    confirm: str
    cancel_orders: bool = True


class SettingUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    value: Any


class BacktestDefaults(BaseModel):
    data_source: Literal["yahoo", "alpaca"] = "yahoo"
    budget: float = Field(gt=0, le=1e12)
    benchmark: str = Field(default="SPY", max_length=16, pattern=r"^[A-Za-z0-9.\-]*$")

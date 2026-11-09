"""Broker-neutral read model for account data shown in the UI."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Protocol


class BrokerError(Exception):
    """A broker call failed. `message` is safe to show to the user."""

    def __init__(self, message: str, status_code: int = 502) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code


@dataclass
class Account:
    broker: str
    account_id: str
    paper: bool
    status: str
    currency: str
    equity: float
    cash: float
    buying_power: float
    last_equity: float | None
    long_market_value: float | None
    short_market_value: float | None
    trading_blocked: bool

    @property
    def daily_pnl(self) -> float | None:
        if self.last_equity is None:
            return None
        return self.equity - self.last_equity

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["daily_pnl"] = self.daily_pnl
        data["daily_pnl_pct"] = (
            None
            if self.last_equity in (None, 0) or self.daily_pnl is None
            else self.daily_pnl / self.last_equity  # type: ignore[operator]
        )
        return data


@dataclass
class Position:
    symbol: str
    asset_class: str
    side: str
    quantity: float
    avg_entry_price: float | None
    current_price: float | None
    market_value: float | None
    cost_basis: float | None
    unrealized_pl: float | None
    unrealized_plpc: float | None


@dataclass
class Order:
    id: str
    client_order_id: str
    symbol: str
    side: str
    type: str
    status: str
    quantity: float | None
    filled_quantity: float | None
    limit_price: float | None
    stop_price: float | None
    filled_avg_price: float | None
    submitted_at: str | None
    filled_at: str | None


@dataclass
class EquityPoint:
    time: str  # ISO date or datetime
    equity: float
    profit_loss: float | None


class BrokerAdapter(Protocol):
    name: str
    paper: bool
    can_liquidate: bool

    def get_account(self) -> Account: ...

    def get_positions(self) -> list[Position]: ...

    def get_orders(self, status: str = "open", limit: int = 100) -> list[Order]: ...

    def get_portfolio_history(
        self, period: str = "1M", timeframe: str = "1D"
    ) -> list[EquityPoint]: ...

    def close_all_positions(self, cancel_orders: bool = True) -> list[dict[str, Any]]: ...

    def is_market_open(self) -> bool | None: ...

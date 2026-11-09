"""In-memory broker used by automated tests. Never wired into the running app."""

from __future__ import annotations

from typing import Any

from backend.adapters.brokers.base import Account, EquityPoint, Order, Position


class MockBroker:
    paper = True
    name = "mock"

    def __init__(self) -> None:
        self.account = Account(
            broker="mock",
            account_id="TEST-ACCOUNT",
            paper=True,
            status="ACTIVE",
            currency="USD",
            equity=1000.0,
            cash=400.0,
            buying_power=800.0,
            last_equity=990.0,
            long_market_value=600.0,
            short_market_value=0.0,
            trading_blocked=False,
        )
        self.positions = [
            Position("AAA", "us_equity", "long", 2, 100.0, 300.0, 600.0, 200.0, 400.0, 2.0)
        ]
        self.orders: list[Order] = []
        self.closed = False

    def get_account(self) -> Account:
        return self.account

    def get_positions(self) -> list[Position]:
        return [] if self.closed else self.positions

    def get_orders(self, status: str = "open", limit: int = 100) -> list[Order]:
        return self.orders[:limit]

    def get_portfolio_history(self, period: str = "1M", timeframe: str = "1D") -> list[EquityPoint]:
        return [EquityPoint("2026-01-01", 990.0, 0.0), EquityPoint("2026-01-02", 1000.0, 10.0)]

    def close_all_positions(self, cancel_orders: bool = True) -> list[dict[str, Any]]:
        self.closed = True
        return [{"symbol": p.symbol, "status": 200} for p in self.positions]

    def is_market_open(self) -> bool | None:
        return False

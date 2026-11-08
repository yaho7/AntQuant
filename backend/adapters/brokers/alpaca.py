"""Alpaca account data via the official alpaca-py SDK (installed with LumiBot).

Read calls are cached for a few seconds and rate limited, so a dashboard left
open does not burn through Alpaca's 200 requests/minute budget.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any, TypeVar

from backend.adapters.brokers.base import Account, BrokerError, EquityPoint, Order, Position

T = TypeVar("T")


def _f(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _enum(value: Any) -> str:
    return str(getattr(value, "value", value) or "")


def _iso(value: Any) -> str | None:
    return value.isoformat() if value is not None and hasattr(value, "isoformat") else None


class RateLimiter:
    """Token bucket. Default: 150 calls/minute, under Alpaca's 200."""

    def __init__(self, per_minute: int = 150) -> None:
        self.capacity = float(per_minute)
        self.tokens = float(per_minute)
        self.rate = per_minute / 60.0
        self.updated = time.monotonic()
        self.lock = threading.Lock()

    def acquire(self) -> None:
        with self.lock:
            now = time.monotonic()
            self.tokens = min(self.capacity, self.tokens + (now - self.updated) * self.rate)
            self.updated = now
            if self.tokens < 1:
                raise BrokerError("Alpaca request budget exhausted, retry in a few seconds.", 429)
            self.tokens -= 1


class AlpacaAdapter:
    name = "alpaca"

    def __init__(
        self,
        api_key: str,
        api_secret: str,
        paper: bool = True,
        client_factory: Callable[[], Any] | None = None,
        cache_seconds: float = 5.0,
    ) -> None:
        self._key = api_key
        self._secret = api_secret
        self.paper = paper
        self._factory = client_factory
        self._client: Any = None
        self._lock = threading.Lock()
        self._cache: dict[str, tuple[float, Any]] = {}
        self._cache_seconds = cache_seconds
        self._limiter = RateLimiter()

    def _new_client(self) -> Any:
        if self._factory is not None:
            return self._factory()
        from alpaca.trading.client import TradingClient

        return TradingClient(self._key, self._secret, paper=self.paper)

    def _call(self, cache_key: str | None, fn: Callable[[Any], T]) -> T:
        if cache_key:
            hit = self._cache.get(cache_key)
            if hit and time.monotonic() - hit[0] < self._cache_seconds:
                return hit[1]  # type: ignore[no-any-return]
        self._limiter.acquire()
        with self._lock:
            if self._client is None:
                self._client = self._new_client()
            client = self._client
        try:
            value = fn(client)
        except BrokerError:
            raise
        except Exception as exc:
            # Drop the client so the next call reconnects from scratch.
            with self._lock:
                self._client = None
            raise BrokerError(_describe(exc)) from exc
        if cache_key:
            self._cache[cache_key] = (time.monotonic(), value)
        return value

    def invalidate(self) -> None:
        self._cache.clear()

    def get_account(self) -> Account:
        def fetch(c: Any) -> Account:
            a = c.get_account()
            return Account(
                broker="alpaca",
                account_id=str(a.account_number or a.id),
                paper=self.paper,
                status=_enum(a.status),
                currency=str(a.currency or "USD"),
                equity=_f(a.equity) or 0.0,
                cash=_f(a.cash) or 0.0,
                buying_power=_f(a.buying_power) or 0.0,
                last_equity=_f(a.last_equity),
                long_market_value=_f(a.long_market_value),
                short_market_value=_f(a.short_market_value),
                trading_blocked=bool(a.trading_blocked or a.account_blocked),
            )

        return self._call("account", fetch)

    def get_positions(self) -> list[Position]:
        def fetch(c: Any) -> list[Position]:
            return [
                Position(
                    symbol=p.symbol,
                    asset_class=_enum(p.asset_class),
                    side=_enum(p.side),
                    quantity=_f(p.qty) or 0.0,
                    avg_entry_price=_f(p.avg_entry_price),
                    current_price=_f(p.current_price),
                    market_value=_f(p.market_value),
                    cost_basis=_f(p.cost_basis),
                    unrealized_pl=_f(p.unrealized_pl),
                    unrealized_plpc=_f(p.unrealized_plpc),
                )
                for p in c.get_all_positions()
            ]

        return self._call("positions", fetch)

    def get_orders(self, status: str = "open", limit: int = 100) -> list[Order]:
        from alpaca.trading.enums import QueryOrderStatus
        from alpaca.trading.requests import GetOrdersRequest

        query = {"open": QueryOrderStatus.OPEN, "closed": QueryOrderStatus.CLOSED}.get(
            status, QueryOrderStatus.ALL
        )

        def fetch(c: Any) -> list[Order]:
            req = GetOrdersRequest(status=query, limit=min(max(limit, 1), 500), nested=False)
            return [
                Order(
                    id=str(o.id),
                    client_order_id=str(o.client_order_id or ""),
                    symbol=str(o.symbol or ""),
                    side=_enum(o.side),
                    type=_enum(o.order_type or o.type),
                    status=_enum(o.status),
                    quantity=_f(o.qty),
                    filled_quantity=_f(o.filled_qty),
                    limit_price=_f(o.limit_price),
                    stop_price=_f(o.stop_price),
                    filled_avg_price=_f(o.filled_avg_price),
                    submitted_at=_iso(o.submitted_at),
                    filled_at=_iso(o.filled_at),
                )
                for o in c.get_orders(filter=req)
            ]

        return self._call(f"orders:{status}:{limit}", fetch)

    def get_portfolio_history(self, period: str = "1M", timeframe: str = "1D") -> list[EquityPoint]:
        from alpaca.trading.requests import GetPortfolioHistoryRequest

        def fetch(c: Any) -> list[EquityPoint]:
            h = c.get_portfolio_history(
                GetPortfolioHistoryRequest(period=period, timeframe=timeframe)
            )
            points: list[EquityPoint] = []
            pls = h.profit_loss or []
            for i, ts in enumerate(h.timestamp or []):
                equity = (h.equity or [None])[i] if i < len(h.equity or []) else None
                if equity is None:
                    continue
                stamp = datetime.fromtimestamp(int(ts), UTC)
                points.append(
                    EquityPoint(
                        time=stamp.date().isoformat() if timeframe == "1D" else stamp.isoformat(),
                        equity=float(equity),
                        profit_loss=_f(pls[i]) if i < len(pls) else None,
                    )
                )
            return points

        return self._call(f"history:{period}:{timeframe}", fetch)

    def close_all_positions(self, cancel_orders: bool = True) -> list[dict[str, Any]]:
        def run(c: Any) -> list[dict[str, Any]]:
            responses = c.close_all_positions(cancel_orders=cancel_orders)
            return [{"symbol": str(r.symbol), "status": int(r.status)} for r in (responses or [])]

        result = self._call(None, run)
        self.invalidate()
        return result

    def is_market_open(self) -> bool | None:
        return self._call("clock", lambda c: bool(c.get_clock().is_open))


def _describe(exc: Exception) -> str:
    """Readable error without leaking request headers."""
    status = getattr(exc, "status_code", None)
    message = str(getattr(exc, "message", None) or exc) or type(exc).__name__
    if status == 401 or "unauthorized" in message.lower() or "forbidden" in message.lower():
        return "Alpaca rejected the API keys (unauthorized). Check the keys in Settings."
    if status:
        return f"Alpaca API error {status}: {message[:300]}"
    return f"Alpaca request failed: {type(exc).__name__}: {message[:300]}"

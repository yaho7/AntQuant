"""Account and order reads from Schwab Trader API."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from urllib.parse import quote

from backend.adapters.brokers.base import Account, BrokerError, EquityPoint, Order, Position
from backend.services import schwab_service

CLOSED = {"FILLED", "CANCELED", "REJECTED", "EXPIRED", "REPLACED"}


def number(value) -> float | None:  # type: ignore[no-untyped-def]
    return float(value) if isinstance(value, (int, float)) else None


class SchwabAdapter:
    name = "schwab"
    paper = False
    can_liquidate = False

    def __init__(self, connection_id: str) -> None:
        self.connection_id = connection_id

    def _read(self, suffix: str = "", **params):  # type: ignore[no-untyped-def]
        conn = schwab_service.access_connection(self.connection_id)
        path = f"/trader/v1/accounts/{quote(conn.account_hash, safe='')}{suffix}"
        return schwab_service.request_json(path, conn.token["access_token"], **params)

    def get_account(self) -> Account:
        a = self._read()["securitiesAccount"]
        balances = a.get("currentBalances", {})
        cash = number(balances.get("cashBalance", balances.get("cashAvailableForTrading"))) or 0
        return Account(
            broker=self.name,
            account_id="••••" + str(a["accountNumber"])[-4:],
            paper=False,
            status="ACTIVE",
            currency="USD",
            equity=number(balances.get("liquidationValue")) or 0,
            cash=cash,
            buying_power=number(
                balances.get("buyingPower", balances.get("cashAvailableForTrading"))
            )
            or 0,
            last_equity=None,
            long_market_value=number(balances.get("longMarketValue")),
            short_market_value=number(balances.get("shortMarketValue")),
            trading_blocked=False,
        )

    def get_positions(self) -> list[Position]:
        rows = self._read(fields="positions")["securitiesAccount"].get("positions", [])
        out = []
        for row in rows:
            instrument = row.get("instrument", {})
            qty = (number(row.get("longQuantity")) or 0) - (number(row.get("shortQuantity")) or 0)
            pl = number(row.get("longOpenProfitLoss" if qty >= 0 else "shortOpenProfitLoss"))
            out.append(
                Position(
                    symbol=instrument.get("symbol", ""),
                    asset_class=instrument.get("assetType", ""),
                    side="long" if qty >= 0 else "short",
                    quantity=abs(qty),
                    avg_entry_price=number(row.get("averagePrice")),
                    current_price=None,
                    market_value=number(row.get("marketValue")),
                    cost_basis=None,
                    unrealized_pl=pl,
                    unrealized_plpc=None,
                )
            )
        return out

    def get_orders(self, status: str = "open", limit: int = 100) -> list[Order]:
        now = datetime.now(UTC)
        rows = self._read(
            "/orders",
            fromEnteredTime=(now - timedelta(days=60)).isoformat(),
            toEnteredTime=now.isoformat(),
            maxResults=min(max(limit * 3, 100), 500),
        )
        out = []
        for row in rows:
            closed = row["status"] in CLOSED
            if (status == "open" and closed) or (status == "closed" and not closed):
                continue
            legs = row.get("orderLegCollection", [])
            fills = [
                leg
                for activity in row.get("orderActivityCollection", [])
                for leg in activity.get("executionLegs", [])
            ]
            fill_qty = sum(float(leg.get("quantity") or 0) for leg in fills)
            fill_avg = (
                sum(float(leg.get("quantity") or 0) * float(leg.get("price") or 0) for leg in fills)
                / fill_qty
                if len(legs) == 1 and fill_qty
                else None
            )
            out.append(
                Order(
                    id=str(row["orderId"]),
                    client_order_id="",
                    symbol=" / ".join(leg.get("instrument", {}).get("symbol", "") for leg in legs),
                    side=legs[0].get("instruction", "").lower() if len(legs) == 1 else "multi-leg",
                    type=row.get("orderType", "").lower(),
                    status=row["status"].lower(),
                    quantity=number(row.get("quantity")),
                    filled_quantity=number(row.get("filledQuantity")),
                    limit_price=number(row.get("price")),
                    stop_price=number(row.get("stopPrice")),
                    filled_avg_price=fill_avg,
                    submitted_at=row.get("enteredTime"),
                    filled_at=row.get("closeTime") if row["status"] == "FILLED" else None,
                )
            )
        return out[:limit]

    def get_portfolio_history(self, period: str = "1M", timeframe: str = "1D") -> list[EquityPoint]:
        return []  # Schwab Trader API does not supply account equity history.

    def close_all_positions(self, cancel_orders: bool = True) -> list[dict]:
        raise BrokerError("Account-wide liquidation is unavailable for Schwab.", 409)

    def is_market_open(self) -> bool | None:
        conn = schwab_service.access_connection(self.connection_id)
        hours = schwab_service.request_json(
            "/marketdata/v1/markets", conn.token["access_token"], markets="equity"
        )
        entries = list(hours.get("equity", {}).values())
        return entries[0].get("isOpen") if entries else None

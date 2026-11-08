"""Turn LumiBot backtest output files into one normalised result document.

Pure standard library so it is cheap to test. Inputs:

* `stats.csv`  - LumiBot portfolio snapshots (`datetime`, `portfolio_value`, ...)
* `trades.csv` - LumiBot order events (`time`, `side`, `status`, `filled_quantity`, ...)
* `analysis`   - the dict returned by `Strategy.run_backtest`

A metric that cannot be computed reliably is `None` (shown as N/A) with a reason.
"""

from __future__ import annotations

import csv
import math
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any

FILL_STATUSES = {"fill", "filled", "partial_fill", "partially_filled"}
LOT_ASSET_TYPES = {"stock", "etf", ""}


def _num(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(out) or math.isinf(out):
        return None
    return out


def read_equity_curve(stats_csv: Path) -> list[dict[str, Any]]:
    """Daily equity: the last portfolio value seen on each calendar date."""
    if not stats_csv.exists():
        return []
    by_day: dict[str, float] = {}
    with stats_csv.open(newline="") as fh:
        for row in csv.DictReader(fh):
            stamp = (row.get("datetime") or "").strip()
            value = _num(row.get("portfolio_value"))
            if not stamp or value is None:
                continue
            by_day[stamp[:10]] = value
    return [{"time": day, "value": by_day[day]} for day in sorted(by_day)]


def drawdown_curve(equity: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    peak = -math.inf
    for point in equity:
        peak = max(peak, point["value"])
        dd = 0.0 if peak <= 0 else (point["value"] - peak) / peak
        out.append({"time": point["time"], "value": dd})
    return out


def read_fills(trades_csv: Path) -> list[dict[str, Any]]:
    if not trades_csv.exists():
        return []
    fills: list[dict[str, Any]] = []
    with trades_csv.open(newline="") as fh:
        for row in csv.DictReader(fh):
            if (row.get("event_kind") or "trade") != "trade":
                continue
            if (row.get("status") or "").lower() not in FILL_STATUSES:
                continue
            qty = _num(row.get("filled_quantity"))
            price = _num(row.get("price"))
            if qty is None or price is None:
                continue
            fills.append(
                {
                    "time": row.get("time", ""),
                    "symbol": row.get("symbol", ""),
                    "asset_type": (row.get("asset.asset_type") or "").lower(),
                    "side": (row.get("side") or "").lower(),
                    "quantity": qty,
                    "price": price,
                    "multiplier": _num(row.get("asset.multiplier")) or 1.0,
                    "fee": _num(row.get("trade_cost")) or 0.0,
                    "order_type": row.get("type", ""),
                }
            )
    return fills


@dataclass
class RoundTripStats:
    win_rate: float | None
    profit_factor: float | None
    closed_trades: int | None
    reason: str | None


def round_trip_stats(fills: list[dict[str, Any]]) -> RoundTripStats:
    """FIFO-match long stock lots. Anything else is reported as not computable."""
    lots: dict[str, deque[list[float]]] = {}
    pnls: list[float] = []
    for fill in fills:
        if fill["asset_type"] not in LOT_ASSET_TYPES:
            return RoundTripStats(None, None, None, "Only long stock trades are supported.")
        side = fill["side"]
        queue = lots.setdefault(fill["symbol"], deque())
        qty = fill["quantity"]
        mult = fill["multiplier"]
        if "buy" in side:
            # Entry fee is folded into the lot cost.
            queue.append([qty, fill["price"] + fill["fee"] / (qty * mult)])
            continue
        if "sell" not in side:
            return RoundTripStats(None, None, None, f"Unknown order side '{side}'.")
        remaining = qty
        pnl = -fill["fee"]
        while remaining > 1e-9:
            if not queue:
                return RoundTripStats(
                    None, None, None, "Short selling detected; win rate needs long-only trades."
                )
            lot = queue[0]
            take = min(lot[0], remaining)
            pnl += (fill["price"] - lot[1]) * take * mult
            lot[0] -= take
            remaining -= take
            if lot[0] <= 1e-9:
                queue.popleft()
        pnls.append(pnl)
    if not pnls:
        return RoundTripStats(None, None, 0, "No closed trades.")
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p < 0]
    win_rate = len(wins) / len(pnls)
    gross_loss = -sum(losses)
    profit_factor = None if gross_loss == 0 else sum(wins) / gross_loss
    reason = "No losing trades; profit factor is undefined." if gross_loss == 0 else None
    return RoundTripStats(win_rate, profit_factor, len(pnls), reason)


def _max_drawdown_from(analysis: dict[str, Any], drawdowns: list[dict[str, Any]]) -> float | None:
    mdd = analysis.get("max_drawdown")
    if isinstance(mdd, dict):
        value = _num(mdd.get("drawdown"))
        if value is not None:
            return -abs(value)
    if drawdowns:
        return min(p["value"] for p in drawdowns)
    return None


def build_result(
    stats_csv: Path, trades_csv: Path, analysis: dict[str, Any] | None, budget: float | None
) -> dict[str, Any]:
    analysis = analysis or {}
    equity = read_equity_curve(stats_csv)
    drawdowns = drawdown_curve(equity)
    fills = read_fills(trades_csv)
    rt = round_trip_stats(fills)

    total_return = _num(analysis.get("total_return"))
    if total_return is None and len(equity) >= 2 and equity[0]["value"] > 0:
        total_return = equity[-1]["value"] / equity[0]["value"] - 1

    notes: dict[str, str] = {}
    if rt.reason:
        notes["win_rate"] = rt.reason
        notes["profit_factor"] = rt.reason

    metrics = {
        "total_return": total_return,
        "annualized_return": _num(analysis.get("cagr")),
        "sharpe_ratio": _num(analysis.get("sharpe")),
        "max_drawdown": _max_drawdown_from(analysis, drawdowns),
        "volatility": _num(analysis.get("volatility")),
        "win_rate": rt.win_rate,
        "profit_factor": rt.profit_factor,
        "number_of_trades": len(fills),
        "closed_trades": rt.closed_trades,
        "starting_value": budget if budget else (equity[0]["value"] if equity else None),
        "ending_value": equity[-1]["value"] if equity else None,
    }
    return {
        "metrics": metrics,
        "notes": notes,
        "equity_curve": equity,
        "drawdown_curve": drawdowns,
        "trades": fills,
    }

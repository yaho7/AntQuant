from __future__ import annotations

from pathlib import Path

import pytest

from backend.services.backtest_metrics import (
    build_result,
    drawdown_curve,
    round_trip_stats,
)

TRADES_HEADER = "time,side,status,filled_quantity,symbol,asset.asset_type,price,asset.multiplier," \
    "trade_cost,event_kind\n"


def fill(side: str, qty: float, price: float, symbol: str = "SPY", fee: float = 0.0) -> dict:
    return {"time": "t", "symbol": symbol, "asset_type": "stock", "side": side,
            "quantity": qty, "price": price, "multiplier": 1.0, "fee": fee, "order_type": "market"}


def test_round_trips_fifo() -> None:
    fills = [
        fill("buy", 10, 100),
        fill("buy", 10, 110),
        fill("sell", 15, 120),  # 10*20 + 5*10 = 250 win
        fill("sell", 5, 100),  # 5*-10 = -50 loss
    ]
    rt = round_trip_stats(fills)
    assert rt.closed_trades == 2
    assert rt.win_rate == 0.5
    assert rt.profit_factor == pytest.approx(5.0)


def test_short_selling_is_not_computable() -> None:
    rt = round_trip_stats([fill("sell", 1, 100)])
    assert rt.win_rate is None and rt.profit_factor is None and rt.reason


def test_options_not_computable() -> None:
    f = fill("buy", 1, 1)
    f["asset_type"] = "option"
    assert round_trip_stats([f]).win_rate is None


def test_no_losses_profit_factor_undefined() -> None:
    rt = round_trip_stats([fill("buy", 1, 10), fill("sell", 1, 12)])
    assert rt.win_rate == 1.0 and rt.profit_factor is None


def test_drawdown_curve() -> None:
    dd = drawdown_curve([{"time": "a", "value": 100}, {"time": "b", "value": 80},
                         {"time": "c", "value": 120}])
    assert [p["value"] for p in dd] == [0.0, -0.2, 0.0]


def test_build_result_from_files(tmp_path: Path) -> None:
    stats = tmp_path / "stats.csv"
    stats.write_text(
        "datetime,portfolio_value,return\n"
        "2024-01-02 09:30:00-05:00,1000,\n"
        "2024-01-02 16:00:00-05:00,1010,0.01\n"
        "2024-01-03 16:00:00-05:00,990,-0.02\n"
    )
    trades = tmp_path / "trades.csv"
    trades.write_text(
        TRADES_HEADER
        + "2024-01-02,buy,new,,SPY,stock,,1,,trade\n"
        + "2024-01-02,buy,fill,2,SPY,stock,100,1,0,trade\n"
        + "2024-01-03,sell,fill,2,SPY,stock,95,1,0,trade\n"
    )
    out = build_result(stats, trades, {"cagr": float("nan"), "sharpe": 1.5}, 1000)
    m = out["metrics"]
    assert out["equity_curve"] == [{"time": "2024-01-02", "value": 1010.0},
                                   {"time": "2024-01-03", "value": 990.0}]
    assert m["annualized_return"] is None  # NaN becomes N/A
    assert m["sharpe_ratio"] == 1.5
    assert m["number_of_trades"] == 2
    assert m["win_rate"] == 0.0
    assert m["total_return"] == pytest.approx(990 / 1010 - 1)
    assert m["max_drawdown"] == pytest.approx(-20 / 1010)

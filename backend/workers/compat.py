"""Check that the installed LumiBot exposes every API this project uses.

Prints one JSON line. Exit code 0 when all checks pass.
Run: `python -m backend.workers.compat`
"""

from __future__ import annotations

import inspect
import json
import os
import sys
from collections.abc import Callable
from typing import Any

os.environ.setdefault("LUMIBOT_DISABLE_UPDATE_CHECK", "true")

REQUIRED_RUN_BACKTEST_ARGS = (
    "datasource_class",
    "backtesting_start",
    "backtesting_end",
    "budget",
    "benchmark_asset",
    "parameters",
    "stats_file",
    "trades_file",
    "tearsheet_file",
    "tearsheet_metrics_file",
    "plot_file_html",
    "settings_file",
    "indicators_file",
    "logfile",
    "show_plot",
    "show_tearsheet",
    "save_tearsheet",
    "show_indicators",
    "show_progress_bar",
    "config",
    "name",
)

REQUIRED_STRATEGY_METHODS = (
    "submit_order",
    "get_position",
    "get_portfolio_value",
    "get_cash",
    "on_filled_order",
    "on_trading_iteration",
)


def _check(name: str, fn: Callable[[], Any]) -> dict[str, Any]:
    try:
        detail = fn()
        return {"name": name, "ok": True, "detail": detail or ""}
    except Exception as exc:  # noqa: BLE001 - report everything
        return {"name": name, "ok": False, "detail": f"{type(exc).__name__}: {exc}"}


def run_checks() -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = []

    def strategy_api() -> str:
        from lumibot.strategies import Strategy

        params = inspect.signature(Strategy.run_backtest).parameters
        missing = [a for a in REQUIRED_RUN_BACKTEST_ARGS if a not in params]
        if missing:
            raise AttributeError(f"run_backtest missing args: {missing}")
        missing_m = [m for m in REQUIRED_STRATEGY_METHODS if not hasattr(Strategy, m)]
        if missing_m:
            raise AttributeError(f"Strategy missing methods: {missing_m}")
        return "Strategy.run_backtest and order methods present"

    def trader_api() -> str:
        from lumibot.traders import Trader

        for name in ("add_strategy", "run_all", "stop_all"):
            if not hasattr(Trader, name):
                raise AttributeError(f"Trader.{name} missing")
        return "Trader.add_strategy/run_all/stop_all present"

    def broker_api() -> str:
        from lumibot.brokers import Alpaca, Schwab

        params = inspect.signature(Alpaca.__init__).parameters
        if "config" not in params:
            raise AttributeError("Alpaca(config=...) not supported")
        if "trading_client" not in params:
            raise AttributeError("Alpaca does not support a caller-supplied trading client")
        if "config" not in inspect.signature(Schwab.__init__).parameters:
            raise AttributeError("Schwab(config=...) not supported")
        return "Alpaca and Schwab broker constructors present"

    def datasources() -> str:
        import lumibot.backtesting as bt

        from backend.adapters.lumibot_adapter import DATA_SOURCES

        names = [ds.lumibot_class for ds in DATA_SOURCES.values()]
        missing = [n for n in names if getattr(bt, n, None) is None]
        if missing:
            raise AttributeError(f"missing data sources: {missing}")
        return ", ".join(names)

    def progress_csv() -> str:
        from lumibot.data_sources.data_source_backtesting import DataSourceBacktesting

        header = getattr(DataSourceBacktesting, "_PROGRESS_CSV_HEADER", ())
        if "percent" not in header:
            raise AttributeError("progress.csv has no 'percent' column")
        return "progress.csv 'percent' column present"

    checks.append(_check("strategy_api", strategy_api))
    checks.append(_check("trader_api", trader_api))
    checks.append(_check("broker_api", broker_api))
    checks.append(_check("backtest_data_sources", datasources))
    checks.append(_check("backtest_progress_file", progress_csv))
    return checks


def main() -> int:
    checks = run_checks()
    ok = all(c["ok"] for c in checks)
    print(json.dumps({"ok": ok, "checks": checks}))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

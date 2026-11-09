"""Run one LumiBot strategy against the selected broker account.

Usage: python -m backend.workers.trading_worker <task_work_dir>

Control and telemetry go through small files in the task dir:

* `control.json`    (written by the web app) - `{"paused": bool}`
* `heartbeat.json`  (written here)           - last iteration time and values
* `events.jsonl`    (written here)           - one line per filled order

Pause: orders that open or increase a position are rejected and logged. Orders
that reduce or close a position still go through, so the strategy's own exits
and stop logic keep working. Orders already resting at the broker are untouched.

Stop: SIGINT/SIGTERM makes LumiBot's Trader stop the strategy. Positions are kept.
"""

from __future__ import annotations

import json
import logging
import os
import signal
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

os.environ.setdefault("LUMIBOT_DISABLE_UPDATE_CHECK", "true")

from backend.workers.common import (  # noqa: E402
    alpaca_config,
    load_strategy_class,
    setup_worker,
    write_error,
    write_json,
)

log = logging.getLogger("trading_worker")

OPENING_SIDES = {"buy_to_open", "sell_to_open", "sell_short"}
CLOSING_SIDES = {"buy_to_close", "sell_to_close", "buy_to_cover"}


def order_increases_exposure(side: str, position_qty: float) -> bool:
    """True when an order would open or grow a position."""
    side = side.lower()
    if side in OPENING_SIDES:
        return True
    if side in CLOSING_SIDES:
        return False
    if side == "buy":
        return position_qty >= 0
    if side == "sell":
        return position_qty <= 0
    return True  # unknown side: treat as risky


class ControlFile:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._mtime = -1.0
        self._data: dict[str, Any] = {}

    def read(self) -> dict[str, Any]:
        try:
            mtime = self.path.stat().st_mtime
        except FileNotFoundError:
            return {}
        if mtime != self._mtime:
            try:
                self._data = json.loads(self.path.read_text())
                self._mtime = mtime
            except (json.JSONDecodeError, OSError):
                pass
        return self._data

    @property
    def paused(self) -> bool:
        return bool(self.read().get("paused"))


def make_managed_strategy(cls: type, work_dir: Path) -> type:
    control = ControlFile(work_dir / "control.json")
    events_path = work_dir / "events.jsonl"
    heartbeat_path = work_dir / "heartbeat.json"

    class Managed(cls):  # type: ignore[misc, valid-type]
        def _ui_filter(self, orders: list[Any]) -> list[Any]:
            if not control.paused:
                return orders
            allowed = []
            for order in orders:
                position = self.get_position(order.asset)
                qty = float(position.quantity) if position is not None else 0.0
                if order_increases_exposure(str(order.side), qty):
                    log.warning(
                        "PAUSED: rejected %s %s %s (opens or increases a position)",
                        order.side,
                        order.quantity,
                        getattr(order.asset, "symbol", order.asset),
                    )
                else:
                    allowed.append(order)
            return allowed

        def submit_order(self, order, **kwargs):  # type: ignore[no-untyped-def]
            orders = order if isinstance(order, list) else [order]
            allowed = self._ui_filter(orders)
            if not allowed:
                return None
            if isinstance(order, list):
                return super().submit_order(allowed, **kwargs)
            return super().submit_order(allowed[0], **kwargs)

        def submit_orders(self, orders, **kwargs):  # type: ignore[no-untyped-def]
            allowed = self._ui_filter(list(orders))
            return super().submit_orders(allowed, **kwargs) if allowed else []

        def on_trading_iteration(self):  # type: ignore[no-untyped-def]
            try:
                write_json(
                    heartbeat_path,
                    {
                        "time": datetime.now(UTC).isoformat(),
                        "paused": control.paused,
                        "portfolio_value": self.get_portfolio_value(),
                        "cash": self.get_cash(),
                    },
                )
            except Exception:  # noqa: BLE001 - telemetry must never stop trading
                log.debug("heartbeat failed", exc_info=True)
            return super().on_trading_iteration()

        def on_filled_order(self, position, order, price, quantity, multiplier):  # type: ignore[no-untyped-def]
            try:
                with events_path.open("a") as fh:
                    fh.write(
                        json.dumps(
                            {
                                "time": datetime.now(UTC).isoformat(),
                                "symbol": getattr(order.asset, "symbol", str(order.asset)),
                                "side": str(order.side),
                                "quantity": float(quantity),
                                "price": float(price),
                                "multiplier": float(multiplier or 1),
                                "order_id": str(getattr(order, "identifier", "")),
                            }
                        )
                        + "\n"
                    )
            except Exception:  # noqa: BLE001
                log.debug("event write failed", exc_info=True)
            return super().on_filled_order(position, order, price, quantity, multiplier)

    Managed.__name__ = cls.__name__
    Managed.__qualname__ = cls.__qualname__
    return Managed


def alpaca_broker(spec: dict[str, Any]):  # type: ignore[no-untyped-def]
    config = alpaca_config()
    if config is None:
        raise RuntimeError("Alpaca keys are not configured; set them in Settings.")
    mode = "paper" if config["PAPER"] else "live"
    if spec.get("mode") != mode:
        raise RuntimeError("Trading mode must match the connected Alpaca account.")

    from lumibot.brokers import Alpaca

    from backend.adapters.brokers.endpoints import ALPACA_LIVE_URL, ALPACA_PAPER_URL

    endpoint = config["ENDPOINT"]
    if endpoint and endpoint not in {ALPACA_LIVE_URL, ALPACA_PAPER_URL}:
        from alpaca.trading.client import TradingClient

        client = TradingClient(
            config["API_KEY"], config["API_SECRET"], paper=config["PAPER"], url_override=endpoint
        )
        return Alpaca(config, trading_client=client)
    return Alpaca(config)


def run_strategy(work_dir: Path, spec: dict[str, Any], broker: Any) -> None:
    from lumibot.traders import Trader

    strategy_cls = make_managed_strategy(
        load_strategy_class(spec["strategy_file"], spec["class_name"]), work_dir
    )
    strategy = strategy_cls(
        broker=broker,
        name=spec.get("name") or spec["class_name"],
        parameters=spec.get("parameters") or {},
    )
    trader = Trader(logfile=str(work_dir / "lumibot.log"))
    trader.add_strategy(strategy)

    def _graceful(signum, _frame):  # type: ignore[no-untyped-def]
        log.info("Received signal %s, stopping strategy", signum)
        trader.stop_all()

    signal.signal(signal.SIGTERM, _graceful)
    log.info("Starting %s trading %s (%s)", spec["mode"], spec["task_id"], spec["class_name"])
    started = time.monotonic()
    trader.run_all()
    log.info("Trader exited after %.0fs", time.monotonic() - started)


def run(work_dir: Path) -> None:
    spec = setup_worker(work_dir)
    if spec.get("broker") == "schwab":
        from backend.workers.schwab_broker import broker_session

        if spec.get("mode") != "live":
            raise RuntimeError("Schwab strategies require the live trading endpoint.")
        with broker_session(spec["broker_connection"]) as broker:
            run_strategy(work_dir, spec, broker)
    else:
        run_strategy(work_dir, spec, alpaca_broker(spec))


def main() -> int:
    work_dir = Path(sys.argv[1]).resolve()
    try:
        run(work_dir)
        return 0
    except KeyboardInterrupt:
        return 0
    except BaseException as exc:  # noqa: BLE001
        log.exception("Trading worker failed")
        write_error(work_dir, exc)
        return 1


if __name__ == "__main__":
    sys.exit(main())

"""Stand-in worker for TaskManager tests. Does not import LumiBot.

Behaviour comes from spec.json:
* backtest: sleep `sleep` seconds, then write result.json, or error.json if `fail`
  (with `error` and `traceback`; `{file}` in it becomes the strategy file path).
* trading: write heartbeat.json, loop until SIGINT/SIGTERM.
"""

from __future__ import annotations

import json
import os
import signal
import sys
import time
from pathlib import Path


def main() -> int:
    work_dir = Path(sys.argv[1])
    spec = json.loads((work_dir / "spec.json").read_text())
    print(f"fake worker {spec['task_id']} started", flush=True)
    if spec["kind"] == "backtest":
        params = spec.get("parameters") or {}
        time.sleep(float(params.get("sleep", 0.2)))
        if params.get("fail"):
            trace = str(params.get("traceback", "")).replace("{file}", spec["strategy_file"])
            error = {"error": params.get("error", "boom"), "traceback": trace}
            (work_dir / "error.json").write_text(json.dumps(error))
            return 1
        (work_dir / "logs").mkdir(exist_ok=True)
        (work_dir / "result.json").write_text(
            json.dumps(
                {
                    "metrics": {"total_return": 0.1},
                    "files": {},
                    "equity_curve": [],
                    "drawdown_curve": [],
                    "trades": [],
                }
            )
        )
        return 0
    stop = {"flag": False}

    def handler(signum, frame):  # type: ignore[no-untyped-def]
        stop["flag"] = True

    signal.signal(signal.SIGINT, handler)
    signal.signal(signal.SIGTERM, handler)
    (work_dir / "heartbeat.json").write_text(
        json.dumps({"time": "now", "alpaca_mode": os.environ.get("LUMIBOT_UI_ALPACA_MODE")})
    )
    while not stop["flag"]:
        time.sleep(0.05)
    print("fake worker stopped", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

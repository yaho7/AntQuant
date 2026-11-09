"""Run one LumiBot backtest in its own process.

Usage: python -m backend.workers.backtest_worker <task_work_dir>

Reads `spec.json`, writes LumiBot artifacts into `out/`, then `result.json`
(or `error.json` on failure). LumiBot's progress file lands in `logs/progress.csv`.
"""

from __future__ import annotations

import logging
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

# Must be set before LumiBot reads its credentials module.
os.environ["LOG_BACKTEST_PROGRESS_TO_FILE"] = "true"
os.environ.setdefault("LUMIBOT_DISABLE_UPDATE_CHECK", "true")

from backend.workers.common import (  # noqa: E402
    alpaca_config,
    load_strategy_class,
    setup_worker,
    write_error,
    write_json,
)

log = logging.getLogger("backtest_worker")

OUTPUT_FILES = {
    "stats": "stats.csv",
    "trades": "trades.csv",
    "tearsheet_html": "tearsheet.html",
    "tearsheet_metrics": "metrics.json",
    "plot_html": "plot.html",
    "settings": "settings.json",
    "indicators_html": "indicators.html",
    "logfile": "backtest.log",
}


def _to_plain(value: Any) -> Any:
    """Convert numpy / pandas scalars in LumiBot's analysis dict to JSON values."""
    if isinstance(value, dict):
        return {str(k): _to_plain(v) for k, v in value.items()}
    if hasattr(value, "item"):
        try:
            return value.item()
        except (ValueError, AttributeError):
            pass
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return value


def run(work_dir: Path) -> None:
    spec = setup_worker(work_dir)
    from lumibot import backtesting

    from backend.adapters.lumibot_adapter import DATA_SOURCES
    from backend.services.backtest_metrics import build_result

    source = DATA_SOURCES[spec["data_source"]]
    datasource_class = getattr(backtesting, source.lumibot_class)
    config = None
    if source.requires_alpaca_keys:
        config = alpaca_config()
        if config is None:
            raise RuntimeError("Alpaca keys are not configured; set them in Settings.")

    strategy_cls = load_strategy_class(spec["strategy_file"], spec["class_name"])
    out = work_dir / "out"
    out.mkdir(exist_ok=True)
    paths = {k: str(out / v) for k, v in OUTPUT_FILES.items()}

    log.info(
        "Starting backtest %s: %s %s..%s budget=%s source=%s",
        spec["task_id"],
        spec["class_name"],
        spec["start"],
        spec["end"],
        spec["budget"],
        source.id,
    )
    analysis, _strategy = strategy_cls.run_backtest(
        datasource_class,
        datetime.fromisoformat(spec["start"]),
        datetime.fromisoformat(spec["end"]),
        budget=float(spec["budget"]),
        benchmark_asset=spec.get("benchmark") or None,
        parameters=spec.get("parameters") or {},
        name=spec.get("name") or spec["class_name"],
        config=config,
        stats_file=paths["stats"],
        trades_file=paths["trades"],
        tearsheet_file=paths["tearsheet_html"],
        tearsheet_metrics_file=paths["tearsheet_metrics"],
        plot_file_html=paths["plot_html"],
        settings_file=paths["settings"],
        indicators_file=paths["indicators_html"],
        logfile=paths["logfile"],
        show_plot=False,
        show_tearsheet=False,
        save_tearsheet=True,
        show_indicators=False,
        show_progress_bar=False,
        quiet_logs=False,
    )
    analysis = _to_plain(analysis or {})
    result = build_result(Path(paths["stats"]), Path(paths["trades"]), analysis, spec["budget"])
    result["analysis"] = analysis
    result["files"] = {
        k: Path(v).relative_to(work_dir).as_posix()
        for k, v in paths.items()
        if Path(v).exists() and Path(v).stat().st_size > 0
    }
    for extra in sorted(out.glob("*_tearsheet.csv")):
        result["files"]["tearsheet_csv"] = extra.relative_to(work_dir).as_posix()
    write_json(work_dir / "result.json", result)
    log.info("Backtest %s finished", spec["task_id"])


def main() -> int:
    work_dir = Path(sys.argv[1]).resolve()
    try:
        run(work_dir)
        return 0
    except BaseException as exc:  # noqa: BLE001 - report every failure to the UI
        log.exception("Backtest failed")
        write_error(work_dir, exc)
        return 1


if __name__ == "__main__":
    sys.exit(main())

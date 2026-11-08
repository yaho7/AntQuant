"""LumiBot adapter compatibility tests. These import the real LumiBot package."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import date
from pathlib import Path

import pytest

from backend.adapters.lumibot_adapter import (
    VERIFIED_LUMIBOT_VERSIONS,
    discover_strategies,
    lumibot_version,
)
from backend.core.config import PROJECT_ROOT


@pytest.mark.compat
def test_compat_probe_passes() -> None:
    proc = subprocess.run(
        [sys.executable, "-m", "backend.workers.compat"],
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )
    report = json.loads([ln for ln in proc.stdout.splitlines() if ln.startswith("{")][-1])
    failed = [c for c in report["checks"] if not c["ok"]]
    assert report["ok"], failed


@pytest.mark.compat
def test_installed_version_is_verified() -> None:
    assert lumibot_version() in VERIFIED_LUMIBOT_VERSIONS


@pytest.mark.compat
def test_example_strategies_import() -> None:
    from backend.workers.common import load_strategy_class

    found = discover_strategies({"examples": PROJECT_ROOT / "strategies" / "examples"})
    assert found
    for item in found:
        path = PROJECT_ROOT / "strategies" / item.source_path
        load_strategy_class(str(path), item.class_name)


@pytest.mark.integration
def test_real_yahoo_backtest(tmp_path: Path) -> None:
    """Runs the real backtest worker with Yahoo data (needs internet)."""
    work = tmp_path / "task"
    work.mkdir()
    spec = {
        "task_id": "it",
        "kind": "backtest",
        "data_source": "yahoo",
        "strategy_file": str(PROJECT_ROOT / "strategies/examples/sma_crossover.py"),
        "class_name": "SmaCrossover",
        "name": "SmaCrossover",
        "start": date(2023, 1, 1).isoformat(),
        "end": date(2023, 12, 31).isoformat(),
        "budget": 10000,
        "benchmark": "SPY",
        "parameters": {"symbol": "SPY", "fast": 10, "slow": 30, "cash_fraction": 0.9},
    }
    (work / "spec.json").write_text(json.dumps(spec))
    env = {**os.environ, "PYTHONPATH": str(PROJECT_ROOT)}
    proc = subprocess.run(
        [sys.executable, "-m", "backend.workers.backtest_worker", str(work)],
        cwd=work,
        env=env,
        capture_output=True,
        text=True,
        timeout=900,
        check=False,
    )
    assert proc.returncode == 0, proc.stdout[-3000:] + proc.stderr[-3000:]
    result = json.loads((work / "result.json").read_text())
    assert len(result["equity_curve"]) > 200
    assert result["metrics"]["number_of_trades"] > 0
    assert "tearsheet_html" in result["files"]
    assert (work / "logs" / "progress.csv").exists()

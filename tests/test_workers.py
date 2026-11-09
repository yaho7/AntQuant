"""Worker helpers that run before user strategy code. Each test uses a fresh interpreter."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

from backend.core.config import PROJECT_ROOT

RSI_BOT = """
import pandas as pd
import pandas_ta as ta
from pandas_ta.momentum import rsi
from lumibot.strategies import Strategy


class RsiBot(Strategy):
    parameters = {"length": 14}

    def on_trading_iteration(self):
        pass


closes = pd.Series([float(i % 7 + i) for i in range(40)])
VALUE = float(ta.rsi(closes, length=14).iloc[-1])
SAME = VALUE == float(rsi(closes, length=14).iloc[-1])
"""


def _python(code: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-c", code],
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )


def test_pandas_ta_alias_only_for_code_that_uses_it() -> None:
    proc = _python(
        "import sys\n"
        "from backend.workers.common import install_module_aliases\n"
        "install_module_aliases(b'import pandas_ta_classic')\n"
        "assert 'pandas_ta' not in sys.modules\n"
        "install_module_aliases(b'import pandas_ta as ta')\n"
        "import pandas_ta, pandas_ta_classic\n"
        "from pandas_ta.momentum import rsi\n"
        "print(pandas_ta is pandas_ta_classic, rsi is pandas_ta_classic.momentum.rsi)\n"
    )
    assert proc.returncode == 0, proc.stderr[-2000:]
    assert proc.stdout.split() == ["True", "True"]


@pytest.mark.compat
def test_strategy_importing_pandas_ta_loads(tmp_path: Path) -> None:
    path = tmp_path / "rsi_bot.py"
    path.write_text(RSI_BOT)
    proc = _python(
        "import sys\n"
        "from backend.workers.common import load_strategy_class\n"
        f"cls = load_strategy_class({str(path)!r}, 'RsiBot')\n"
        "module = sys.modules[cls.__module__]\n"
        "print(cls.__name__, module.SAME, 0 < module.VALUE < 100)\n"
    )
    assert proc.returncode == 0, proc.stderr[-2000:]
    assert proc.stdout.split()[-3:] == ["RsiBot", "True", "True"]

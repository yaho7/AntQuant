"""Checks and the one-click fix for strategy files written for plain LumiBot or by AI."""

from __future__ import annotations

import ast
import textwrap

from fastapi.testclient import TestClient

from backend.services import strategy_checks
from backend.services.strategy_service import scan_code

HEAD = "from lumibot.strategies import Strategy\n"
BOT = """
class Bot(Strategy):
    parameters = {"symbol": "SPY"}

    def on_trading_iteration(self):
        self.log_message(self.parameters["symbol"])
"""


def _check(code: str) -> strategy_checks.Report:
    raw = textwrap.dedent(code).encode()
    return strategy_checks.check(raw, scan_code("bot.py", raw))


def _codes(report: strategy_checks.Report) -> list[tuple[str, int | None, bool]]:
    return [(issue.code, issue.line, issue.fixable) for issue in report.issues]


def _runs_cleanly(fixed: str) -> None:
    """The fixed file parses and no longer starts a run or imports a missing module."""
    ast.parse(fixed)
    again = strategy_checks.check(fixed.encode(), scan_code("bot.py", fixed.encode()))
    assert [i.code for i in again.issues if i.severity == "error"] == []
    assert again.fixed_code is None


def test_clean_file_has_no_issues() -> None:
    report = _check(HEAD + BOT + 'if __name__ == "__main__":\n    Bot.backtest(None)\n')
    assert report.issues == [] and report.fixed_code is None


def test_run_code_moves_under_main_guard() -> None:
    code = (
        HEAD
        + "from datetime import datetime\n"
        + "from lumibot.brokers import Alpaca\n"
        + "from lumibot.traders import Trader\n"
        + BOT
        + "\nstart = datetime(2023, 1, 1)\n"
        + "Bot.backtest(None, start)\n"
        + "print('done')\n"
    )
    report = _check(code)
    assert _codes(report) == [("run_code", 13, True)]
    assert report.fixed_code is not None
    assert report.fixed_code.endswith(
        'if __name__ == "__main__":\n'
        "    start = datetime(2023, 1, 1)\n"
        "    Bot.backtest(None, start)\n"
        "    print('done')\n"
    )
    assert report.changes == [{"kind": "run_code", "line": 12}]
    _runs_cleanly(report.fixed_code)


def test_main_function_called_at_top_level_is_run_code() -> None:
    code = HEAD + BOT + "\ndef main():\n    Bot.backtest(None)\n\nmain()\n"
    report = _check(code)
    assert _codes(report) == [("run_code", 12, True)]
    assert report.fixed_code is not None
    _runs_cleanly(report.fixed_code)


def test_local_key_file_import_moves_into_main_block() -> None:
    code = (
        HEAD
        + "from config import ALPACA_CONFIG\n"
        + "from lumibot.brokers import Alpaca\n"
        + BOT
        + '\nif __name__ == "__main__":\n'
        + "    broker = Alpaca(ALPACA_CONFIG)\n"
    )
    report = _check(code)
    assert _codes(report) == [("missing_module", 2, True)]
    assert report.issues[0].params == {"module": "config"}
    assert report.fixed_code is not None
    assert "    from config import ALPACA_CONFIG\n    broker = Alpaca" in report.fixed_code
    assert report.fixed_code.count("from config import") == 1
    _runs_cleanly(report.fixed_code)


def test_unused_missing_import_is_removed_and_used_one_is_not_fixable() -> None:
    unused = _check(HEAD + "import secrets_file\n" + BOT)
    assert _codes(unused) == [("missing_module", 2, True)]
    assert unused.fixed_code is not None and "secrets_file" not in unused.fixed_code
    assert unused.changes == [{"kind": "import", "line": 2, "moved": False}]

    used = _check(HEAD + "import talib\n" + BOT.replace("self.log_message", "talib.RSI"))
    assert _codes(used) == [("missing_module", 2, False)] and used.fixed_code is None


def test_imports_that_never_run_or_are_optional_are_ignored() -> None:
    code = (
        HEAD
        + "try:\n    import talib\nexcept ImportError:\n    talib = None\n"
        + BOT
        + '\nif __name__ == "__main__":\n    from credentials import KEYS\n'
    )
    assert _check(code).issues == []


def test_pandas_ta_and_relative_imports() -> None:
    report = _check("import pandas_ta as ta\nfrom .helpers import signal\n" + HEAD + BOT)
    assert [(i.code, i.severity, i.params) for i in report.issues] == [
        ("missing_module", "error", {"module": ".helpers"}),
        ("module_alias", "info", {"module": "pandas_ta", "alias": "pandas_ta_classic"}),
    ]


def test_multiline_strings_keep_their_text_when_moved() -> None:
    code = HEAD + BOT + '\nnote = """first\nsecond"""\nBot.backtest(None, name=note)\n'
    report = _check(code)
    assert report.fixed_code is not None
    assert '    note = """first\nsecond"""\n    Bot.backtest' in report.fixed_code
    _runs_cleanly(report.fixed_code)


def test_run_code_sharing_a_line_is_not_rewritten() -> None:
    report = _check(HEAD + BOT + "\nx = 1; Bot.backtest(None)\n")
    assert _codes(report) == [("run_code", 9, False)] and report.fixed_code is None


def test_data_source_intraday_and_credentials_hints() -> None:
    code = (
        HEAD
        + "import os\n"
        + "from lumibot.backtesting import PolygonDataBacktesting\n"
        + "class Bot(Strategy):\n"
        + "    def initialize(self):\n"
        + '        self.sleeptime = "5M"\n'
        + '        self.key = os.environ["ALPACA_API_KEY"]\n'
        + '\nif __name__ == "__main__":\n'
        + "    Bot.backtest(PolygonDataBacktesting)\n"
    )
    assert [(i.code, i.line, i.params) for i in _check(code).issues] == [
        ("intraday", 6, {}),
        ("env_credentials", 7, {"name": "ALPACA_API_KEY"}),
        ("data_source", None, {"names": "PolygonDataBacktesting"}),
    ]


def test_scan_endpoint_returns_issues_and_fix(authed: TestClient) -> None:
    code = HEAD + "from config import KEYS\n" + BOT + "\nBot.backtest(None, KEYS)\n"
    body = authed.post("/api/strategies/scan", json={"code": code}).json()
    assert body["classes"][0]["class_name"] == "Bot"
    assert [(i["code"], i["fixable"]) for i in body["issues"]] == [
        ("missing_module", True),
        ("run_code", True),
    ]
    fixed = body["fix"]["code"]
    assert fixed.endswith(
        'if __name__ == "__main__":\n    from config import KEYS\n    Bot.backtest(None, KEYS)\n'
    )
    assert body["fix"]["diff"].startswith("--- before.py")
    clean = authed.post("/api/strategies/scan", json={"code": fixed}).json()
    assert clean["issues"] == [] and clean["fix"] is None

    broken = authed.post("/api/strategies/scan", json={"code": "class Bot(Strategy)\n"}).json()
    assert broken["issues"] == [] and broken["fix"] is None and broken["line"] == 1


def test_discovered_file_source(authed: TestClient) -> None:
    path = "/api/strategies/discover/source"
    body = authed.get(path, params={"source_path": "examples/sma_crossover.py"}).json()
    assert "class SmaCrossover" in body["code"]
    assert authed.get(path, params={"source_path": "examples/../../README.md"}).status_code == 400

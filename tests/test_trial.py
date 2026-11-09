"""Trial runs of unsaved strategy code."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.services import trial_service

BOT = """from lumibot.strategies import Strategy


class Bot(Strategy):
    parameters = {"symbol": "SPY"}

    def on_trading_iteration(self):
        symbol = self.parameters["symbol"]
"""


def _trial(client: TestClient, **extra: object):  # type: ignore[no-untyped-def]
    body = {"code": BOT, "class_name": "Bot", "acknowledge_risk": True, **extra}
    return client.post("/api/strategies/trial", json=body)


def test_trial_needs_trust_and_a_class_from_the_file(authed: TestClient) -> None:
    assert _trial(authed, acknowledge_risk=False).status_code == 400
    assert _trial(authed, class_name="Other").status_code == 400
    assert _trial(authed, code="print('no strategy')").status_code == 400


def test_trial_summary_and_cleanup(authed: TestClient, data_dir: Path) -> None:
    response = _trial(authed)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is True and body["trades"] == 0 and body["total_return"] == 0.1
    assert body["start"] < body["end"]
    assert list((data_dir / "trials").iterdir()) == []


def test_trial_explains_the_failing_line(authed: TestClient) -> None:
    trace = (
        "Traceback (most recent call last):\n"
        '  File "{file}", line 9, in on_trading_iteration\n'
        '    symbol = self.parameters["symbol"]\n'
        "KeyError: 'symbol'\n"
    )
    params = {"fail": True, "error": "KeyError: 'symbol'", "traceback": trace}
    body = _trial(authed, parameters=params).json()
    assert body["ok"] is False and body["error"] == "KeyError: 'symbol'"
    assert body["hint"] == {"code": "missing_parameter", "params": {"name": "symbol"}, "line": 9}
    assert "KeyError" in body["traceback"]


def test_trial_timeout_and_one_at_a_time(authed: TestClient, monkeypatch) -> None:
    monkeypatch.setattr(trial_service, "TRIAL_TIMEOUT_SECONDS", 0.5)
    body = _trial(authed, parameters={"sleep": 5}).json()
    assert body["ok"] is False and body["hint"]["code"] == "timeout"
    with trial_service._lock:
        assert _trial(authed).status_code == 409


FILE = "/data/trials/x/strategy.py"


def _frame(line: int, source: str) -> str:
    outer = '  File "/srv/lumibot/x.py", line 1, in run\n    run()\n'
    return f'{outer}  File "{FILE}", line {line}, in f\n    {source}\n'


@pytest.mark.parametrize(
    ("error", "trace", "code", "params", "line"),
    [
        ("ModuleNotFoundError: No module named 'talib'", _frame(2, "import talib"),
         "missing_module", {"module": "talib"}, 2),
        ("TypeError: Bot.initialize() missing 1 required positional argument: 'symbol'", "",
         "missing_parameter", {"name": "symbol"}, None),
        ("KeyError: 'x'", _frame(8, 'p = params["x"]'), "missing_parameter", {"name": "x"}, 8),
        ("KeyError: 'close'", _frame(8, 'bars.df["close"]'), "key_error", {"key": "close"}, 8),
        ("NameError: name 'ta' is not defined", _frame(5, "ta.rsi()"),
         "name_error", {"name": "ta"}, 5),
        ("AttributeError: 'NoneType' object has no attribute 'df'", _frame(6, "bars.df"),
         "no_data", {}, 6),
        ("ConnectionError: Max retries exceeded with url", "", "data_download", {}, None),
        ('APIError: {"message": "unauthorized."}', _frame(15, "broker = Alpaca(CONFIG)"),
         "broker_auth", {}, 15),
        ("ZeroDivisionError: division by zero", _frame(3, "1 / 0"),
         "generic", {"error": "ZeroDivisionError: division by zero"}, 3),
    ],
)  # fmt: skip
def test_explain(error: str, trace: str, code: str, params: dict, line: int | None) -> None:
    assert trial_service.explain(error, trace, FILE) == {
        "code": code,
        "params": params,
        "line": line,
    }


SCRIPT_WITH_PARAMETERS_IN_MAIN = """from datetime import datetime
from lumibot.backtesting import YahooDataBacktesting
from lumibot.strategies import Strategy


class Momentum(Strategy):
    def initialize(self):
        self.sleeptime = "1D"

    def on_trading_iteration(self):
        symbol = self.parameters["symbol"]
        self.log_message(f"{symbol} {self.get_last_price(symbol)}")


if __name__ == "__main__":
    Momentum.backtest(YahooDataBacktesting, datetime(2023, 1, 1), datetime(2023, 12, 31),
                      parameters={"symbol": "QQQ"})
"""


@pytest.mark.integration
def test_real_trial_with_and_without_parameters(data_dir: Path) -> None:
    """Runs the real worker on Yahoo data (needs internet)."""
    from backend.core.config import get_settings

    settings = get_settings()
    code, name = SCRIPT_WITH_PARAMETERS_IN_MAIN, "Momentum"
    failed = trial_service.run_trial(settings, code, name, {})
    assert failed["ok"] is False, failed
    assert failed["hint"] == {"code": "missing_parameter", "params": {"name": "symbol"}, "line": 11}
    passed = trial_service.run_trial(settings, code, name, {"symbol": "QQQ"})
    assert passed["ok"] is True, passed.get("traceback") or passed.get("log")
    assert passed["days"] > 10

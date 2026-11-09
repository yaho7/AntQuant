from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from backend.adapters.lumibot_adapter import parse_strategy_file
from tests.test_task_manager import backtest_body, wait_for

GOOD = b'''
from lumibot.strategies import Strategy

class MyBot(Strategy):
    """Doc here."""
    parameters = {"symbol": "QQQ", "n": 3}
    def on_trading_iteration(self):
        pass

class NotAStrategy:
    pass
'''


def _create(client: TestClient, name: str = "Hold SPY") -> dict:
    r = client.post(
        "/api/strategies",
        json={"name": name, "source_path": "examples/buy_and_hold.py", "class_name": "BuyAndHold"},
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_parse_without_executing(tmp_path: Path) -> None:
    f = tmp_path / "x.py"
    f.write_bytes(GOOD + b"\nraise SystemExit('must not run')\n")
    found = parse_strategy_file(f, "user", "x.py")
    assert [s.class_name for s in found] == ["MyBot"]
    assert found[0].parameters == {"symbol": "QQQ", "n": 3}
    assert found[0].docstring == "Doc here."


LUMIBOT_SCRIPT = b"""
from datetime import datetime
from lumibot.backtesting import YahooDataBacktesting
from lumibot.entities import Asset
from lumibot.strategies import Strategy

DEFAULTS = {"symbol": "SPY", "asset": Asset("SPY")}


class Swing(Strategy):
    parameters = DEFAULTS

    def initialize(self, window=10, *, hidden=2):
        self.sleeptime = "1D"

    def on_trading_iteration(self):
        params = self.parameters
        threshold = params["threshold"]
        risk = self.parameters.get("risk", 0.02)
        self.parameters["state"] = 1
        state = self.parameters["state"]
        lookback = self.parameters["lookback"]


run_params = {"symbol": "AAPL", "threshold": 1.5}

if __name__ == "__main__":
    Swing.backtest(YahooDataBacktesting, datetime(2023, 1, 1), datetime(2023, 6, 1),
                   parameters=run_params, budget=5000)
"""


def test_parameters_from_every_lumibot_place(tmp_path: Path) -> None:
    f = tmp_path / "swing.py"
    f.write_bytes(LUMIBOT_SCRIPT)
    (item,) = parse_strategy_file(f, "user", "swing.py")
    # Run call beats the class dict; initialize() and .get() defaults fill the rest.
    assert item.parameters == {"symbol": "AAPL", "window": 10, "risk": 0.02, "threshold": 1.5}
    assert [s["kind"] for s in item.parameter_sources] == ["class", "initialize", "get", "call"]
    assert item.unread_parameters == ["asset"] and not item.parameters_parsed
    assert item.missing_parameters == [{"name": "lookback", "line": 22}]


def test_initialize_keywords_become_parameters(tmp_path: Path) -> None:
    f = tmp_path / "x.py"
    f.write_text(
        "from lumibot.strategies import Strategy\n"
        "class Swing(Strategy):\n"
        "    def initialize(self, symbol='SPY', period=20):\n"
        "        self.symbol = symbol\n"
    )
    (item,) = parse_strategy_file(f, "user", "x.py")
    assert item.parameters == {"symbol": "SPY", "period": 20} and item.parameters_parsed
    assert item.parameter_sources == [{"kind": "initialize", "line": 3}]


def test_discover_examples(authed: TestClient) -> None:
    names = {d["class_name"] for d in authed.get("/api/strategies/discover").json()}
    assert {"BuyAndHold", "SmaCrossover"} <= names


def test_create_update_versions(authed: TestClient) -> None:
    s = _create(authed)
    assert s["parameters"]["symbol"] == "SPY" and s["version"] == 1
    r = authed.patch(f"/api/strategies/{s['id']}", json={"parameters": {"symbol": "QQQ"}})
    assert r.json()["version"] == 2
    versions = authed.get(f"/api/strategies/{s['id']}/versions").json()
    assert [v["version"] for v in versions] == [2, 1]
    r = authed.post(f"/api/strategies/{s['id']}/versions/1/restore", json={})
    assert r.json()["parameters"]["symbol"] == "SPY" and r.json()["version"] == 3
    assert _create_dup(authed).status_code == 409


def _create_dup(client: TestClient):  # type: ignore[no-untyped-def]
    return client.post(
        "/api/strategies",
        json={
            "name": "Hold SPY",
            "source_path": "examples/buy_and_hold.py",
            "class_name": "BuyAndHold",
        },
    )


def test_bad_parameter_names_rejected(authed: TestClient) -> None:
    s = _create(authed)
    r = authed.patch(f"/api/strategies/{s['id']}", json={"parameters": {"bad key; rm": 1}})
    assert r.status_code == 422


def test_path_traversal_blocked(authed: TestClient) -> None:
    for path in (
        "examples/../../backend/main.py",
        "user/../../../etc/passwd",
        "/etc/passwd",
        "other/x.py",
    ):
        r = authed.post(
            "/api/strategies",
            json={"name": "x", "source_path": path, "class_name": "BuyAndHold"},
        )
        assert r.status_code in (400, 404), path


def test_upload_requires_ack_and_strategy_class(authed: TestClient) -> None:
    files = {"file": ("bot.py", GOOD, "text/x-python")}
    assert authed.post("/api/strategies/upload", files=files).status_code == 400
    r = authed.post("/api/strategies/upload", files=files, data={"acknowledge_risk": "true"})
    assert r.status_code == 200, r.text
    found = r.json()
    assert found[0]["class_name"] == "MyBot"
    assert found[0]["source_path"].startswith("user/uploads/bot_")
    bad = {"file": ("x.py", b"print('hi')", "text/x-python")}
    r = authed.post("/api/strategies/upload", files=bad, data={"acknowledge_risk": "true"})
    assert r.status_code == 400
    r = authed.post(
        "/api/strategies/upload",
        files={"file": ("x.sh", b"echo", "text/plain")},
        data={"acknowledge_risk": "true"},
    )
    assert r.status_code == 400


def test_source_view(authed: TestClient) -> None:
    s = _create(authed)
    body = authed.get(f"/api/strategies/{s['id']}/source").json()
    assert "class BuyAndHold" in body["code"]


def test_scan_and_import_strategy(authed: TestClient) -> None:
    code = GOOD.decode().replace("parameters =", "parameters: dict =")
    code += "\nraise RuntimeError('scanning must never run this')\n"
    source = {"filename": "bot.py", "code": code}
    scan = authed.post("/api/strategies/scan", json=source).json()
    assert scan["classes"][0]["parameters"] == {"symbol": "QQQ", "n": 3}
    assert not any(
        item["class_name"] == "MyBot" for item in authed.get("/api/strategies/discover").json()
    )

    broken = authed.post("/api/strategies/scan", json={"code": "class Bot(Strategy)\n"}).json()
    assert broken["classes"] == [] and broken["line"] == 1

    body = {**source, "name": "My strategy", "class_name": "MyBot", "parameters": {"n": 5}}
    assert authed.post("/api/strategies/import", json=body).status_code == 400
    saved = authed.post("/api/strategies/import", json={**body, "acknowledge_risk": True})
    assert saved.status_code == 200, saved.text
    assert saved.json()["parameters"] == {"n": 5}
    path = f"/api/strategies/{saved.json()['id']}/source"
    assert authed.get(path).json()["code"] == code


def test_edit_restore_and_pin_queued_backtest(
    authed: TestClient, data_dir: Path, monkeypatch
) -> None:
    manager = authed.app.state.task_manager
    start_pending = manager._start_pending
    monkeypatch.setattr(manager, "_start_pending", lambda db: None)
    code = GOOD.decode()
    trusted = {"code": code, "class_name": "MyBot", "acknowledge_risk": True}
    created = authed.post("/api/strategies/import", json={**trusted, "name": "Bot"})
    assert created.status_code == 200, created.text
    sid = created.json()["id"]
    base = f"/api/strategies/{sid}"
    task = authed.post("/api/backtests", json=backtest_body(sid, n=3)).json()
    assert task["status"] == "pending"

    new_code = code.replace("MyBot", "NewBot").replace('"n": 3', '"n": 8')
    edit = {
        **trusted,
        "code": new_code,
        "class_name": "NewBot",
        "expected_version": 1,
        "parameters": {"n": 8},
    }
    assert authed.put(f"{base}/source", json={**edit, "class_name": "MyBot"}).status_code == 400
    saved = authed.put(f"{base}/source", json=edit)
    assert saved.status_code == 200, saved.text
    assert saved.json()["version"] == 2 and saved.json()["class_name"] == "NewBot"
    assert authed.put(f"{base}/source", json=edit).status_code == 409
    assert authed.get(f"{base}/source").json()["code"] == new_code

    monkeypatch.setattr(manager, "_start_pending", start_pending)
    task_path = f"/api/backtests/{task['id']}"
    wait_for(authed, task_path, lambda result: result["status"] == "completed")
    spec = json.loads((data_dir / "tasks" / task["id"] / "spec.json").read_text())
    assert spec["class_name"] == "MyBot"
    assert Path(spec["strategy_code"]).read_text() == code
    assert spec["parameters"] == {"n": 3}

    assert all(v["code_available"] for v in authed.get(f"{base}/versions").json())
    restored = authed.post(f"{base}/versions/1/restore", json={})
    assert restored.status_code == 200, restored.text
    assert restored.json()["class_name"] == "MyBot"
    assert restored.json()["parameters"] == {"symbol": "QQQ", "n": 3}
    assert authed.get(f"{base}/source").json()["code"] == code

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from backend.adapters.lumibot_adapter import parse_strategy_file

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
        json={"name": "Hold SPY", "source_path": "examples/buy_and_hold.py",
              "class_name": "BuyAndHold"},
    )


def test_bad_parameter_names_rejected(authed: TestClient) -> None:
    s = _create(authed)
    r = authed.patch(f"/api/strategies/{s['id']}", json={"parameters": {"bad key; rm": 1}})
    assert r.status_code == 422


def test_path_traversal_blocked(authed: TestClient) -> None:
    for path in ("examples/../../backend/main.py", "user/../../../etc/passwd", "/etc/passwd",
                 "other/x.py"):
        r = authed.post(
            "/api/strategies",
            json={"name": "x", "source_path": path, "class_name": "BuyAndHold"},
        )
        assert r.status_code in (400, 404), path


def test_upload_requires_ack_and_strategy_class(authed: TestClient) -> None:
    files = {"file": ("bot.py", GOOD, "text/x-python")}
    assert authed.post("/api/strategies/upload", files=files).status_code == 400
    r = authed.post(
        "/api/strategies/upload", files=files, data={"acknowledge_risk": "true"}
    )
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

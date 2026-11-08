from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from backend.adapters.brokers.mock import MockBroker
from backend.services.broker_service import set_broker_override

KEY = "PKTESTKEY1234ABCD"
SECRET = "SuperSecretValue0123456789abcdef"


def test_alpaca_secret_is_write_only(authed: TestClient, data_dir: Path) -> None:
    r = authed.put("/api/settings/alpaca/credentials", json={"api_key": KEY, "api_secret": SECRET})
    assert r.status_code == 200
    body = authed.get("/api/settings").text
    assert SECRET not in body and KEY not in body
    assert authed.get("/api/settings").json()["alpaca"] == {
        "configured": True,
        "api_key_hint": "••••ABCD",
        "paper": True,
    }
    # Stored encrypted, not in plain text in the database file.
    assert SECRET.encode() not in (data_dir / "lumibot-ui.db").read_bytes()
    assert (data_dir / "secret.key").stat().st_mode & 0o077 == 0


def test_secret_never_logged(authed: TestClient, data_dir: Path) -> None:
    import logging

    authed.put("/api/settings/alpaca/credentials", json={"api_key": KEY, "api_secret": SECRET})
    authed.get("/api/account/summary")  # registers secrets for redaction
    logging.getLogger("system").error("leak attempt %s", SECRET)
    for handler in logging.getLogger().handlers:
        handler.flush()
    assert SECRET not in (data_dir / "logs" / "system.log").read_text()


def test_account_not_connected(authed: TestClient) -> None:
    assert authed.get("/api/account/summary").json() == {
        "connected": False,
        "account": None,
        "error": None,
    }
    assert authed.get("/api/account/positions").status_code == 409


def test_account_with_mock_broker(authed: TestClient) -> None:
    broker = MockBroker()
    set_broker_override(broker)
    summary = authed.get("/api/account/summary").json()
    assert summary["account"]["equity"] == 1000.0
    assert summary["account"]["daily_pnl"] == 10.0
    assert authed.get("/api/account/positions").json()[0]["symbol"] == "AAA"
    assert len(authed.get("/api/account/history").json()) == 2


def test_liquidate_needs_phrase(authed: TestClient) -> None:
    broker = MockBroker()
    set_broker_override(broker)
    r = authed.post("/api/trading/liquidate", json={"confirm": "yes"})
    assert r.status_code == 400 and not broker.closed
    r = authed.post("/api/trading/liquidate", json={"confirm": "LIQUIDATE"})
    assert r.status_code == 200 and broker.closed
    actions = [a["action"] for a in authed.get("/api/audit").json()]
    assert actions.count("account.liquidate") == 2


def test_live_mode_refused(authed: TestClient) -> None:
    r = authed.post("/api/trading/start", json={"strategy_id": 1, "mode": "live"})
    assert r.status_code == 403


def test_int_setting_validation(authed: TestClient) -> None:
    assert (
        authed.put("/api/settings/max_concurrent_backtests", json={"value": 99}).status_code == 400
    )
    r = authed.put("/api/settings/max_concurrent_backtests", json={"value": 2})
    assert r.json()["settings"]["max_concurrent_backtests"] == 2
    assert authed.put("/api/settings/unknown", json={"value": 1}).status_code == 404

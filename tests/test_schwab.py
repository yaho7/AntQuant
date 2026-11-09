from __future__ import annotations

import time
from collections.abc import Callable
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from fastapi.testclient import TestClient

from backend.adapters.brokers.alpaca import AlpacaAdapter
from backend.adapters.brokers.mock import MockBroker
from backend.core.config import get_settings
from backend.core.db import session_factory
from backend.services import schwab_service
from tests.test_task_manager import make_strategy, wait_for

CALLBACK = "https://127.0.0.1:8182"


@pytest.fixture
def schwab_api(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    grants: list[dict] = []

    def fake_post(url: str, *, auth, data, **_kwargs) -> httpx.Response:
        assert url == schwab_service.TOKEN_URL and auth == ("test-app", "test-secret")
        grants.append(data)
        return httpx.Response(
            200,
            request=httpx.Request("POST", url),
            json={"access_token": "access-new", "refresh_token": "refresh-new", "expires_in": 1800},
        )

    def fake_get(url: str, *, headers, params, **_kwargs) -> httpx.Response:
        assert headers == {"Authorization": "Bearer access-new"}
        if url.endswith("/accountNumbers"):
            data = [{"accountNumber": "12345678", "hashValue": "account-hash"}]
        else:
            assert url.endswith("/accounts/account-hash")
            data = {
                "securitiesAccount": {
                    "accountNumber": "12345678",
                    "currentBalances": {"liquidationValue": 1200, "cashBalance": 200},
                    "positions": [{"instrument": {"symbol": "AAPL"}, "longQuantity": 5}],
                }
            }
        return httpx.Response(200, json=data, request=httpx.Request("GET", url))

    monkeypatch.setattr(schwab_service.httpx, "post", fake_post)
    monkeypatch.setattr(schwab_service.httpx, "get", fake_get)
    return grants


def authorize(client: TestClient, *, renew: bool = False) -> str:
    body = {"callback_url": CALLBACK}
    if not renew:
        body.update(app_key="test-app", app_secret="test-secret")
    response = client.post("/api/settings/schwab/authorize", json=body)
    assert response.status_code == 200, response.text
    url = response.json()["authorization_url"]
    assert url.startswith(schwab_service.SCHWAB_URL)
    return parse_qs(urlsplit(url).query)["state"][0]


def connect(client: TestClient, state: str) -> None:
    result = client.post(
        "/api/settings/schwab/accounts",
        json={"redirect_url": f"{CALLBACK}/?code=code&state={state}"},
    )
    assert result.status_code == 200, result.text
    assert result.json() == {"accounts": [{"id": 0, "label": "••••5678"}]}
    saved = client.put("/api/settings/schwab/connection", json={"account": 0})
    assert saved.status_code == 200, saved.text


def mutate_connection(fn: Callable[[dict], None]) -> str:
    with session_factory()() as db:
        raw = schwab_service.read_json_secret(db, schwab_service.SCHWAB_CONNECTION)
        assert raw is not None
        fn(raw)
        schwab_service.write_json_secret(db, schwab_service.SCHWAB_CONNECTION, raw)
        db.commit()
        return raw["id"]


def test_schwab_callback_account_and_expiry(
    authed: TestClient, schwab_api: list[dict], monkeypatch: pytest.MonkeyPatch
) -> None:
    alpaca = authed.put(
        "/api/settings/alpaca/credentials",
        json={"api_key": "PKTESTKEY1234", "api_secret": "secretsecretsecret12"},
    )
    assert alpaca.status_code == 200
    state = authorize(authed)
    bad = authed.post(
        "/api/settings/schwab/accounts", json={"redirect_url": f"{CALLBACK}?code=x&state=wrong"}
    )
    assert bad.status_code == 400
    assert not schwab_api
    connect(authed, state)
    settings = authed.get("/api/settings")
    assert settings.json()["active_broker"] == "schwab"
    for secret in ("test-secret", "access-new", "refresh-new", "account-hash", "12345678"):
        assert secret not in settings.text
    assert authed.get("/api/account/summary").json()["account"]["equity"] == 1200
    monkeypatch.setattr(AlpacaAdapter, "get_account", lambda _: MockBroker().get_account())
    tested = authed.post("/api/settings/alpaca/test")
    assert tested.json()["account_id"] == "••••OUNT"
    assert authed.get("/api/settings").json()["active_broker"] == "schwab"
    assert authed.get("/api/account/positions").json()[0]["symbol"] == "AAPL"
    assert (
        authed.post("/api/trading/liquidate", json={"confirm": "LIQUIDATE LIVE"}).status_code == 409
    )

    connection_id = mutate_connection(lambda item: item["token"].update(expires_at=0))
    assert schwab_service.access_connection(connection_id).token["access_token"] == "access-new"
    assert schwab_service.access_connection(connection_id).token["access_token"] == "access-new"
    assert [grant["grant_type"] for grant in schwab_api] == ["authorization_code", "refresh_token"]

    mutate_connection(lambda item: item.update(authorized_at=time.time() - 604801))
    assert authed.get("/api/settings").json()["schwab"]["authorization_expired"]
    assert authed.get("/api/trading/mode").json()["authorization_expired"]
    assert authed.get("/api/account/summary").json()["error"] == schwab_service.AUTH_REQUIRED
    connect(authed, authorize(authed, renew=True))
    assert mutate_connection(lambda _: None) == connection_id
    assert not authed.get("/api/settings").json()["schwab"]["authorization_expired"]


def test_trading_uses_selected_schwab_account(authed: TestClient, schwab_api: list[dict]) -> None:
    get_settings().live_trading_enabled = True
    connect(authed, authorize(authed))
    strategy = make_strategy(authed)
    body = {"strategy_id": strategy, "broker": "alpaca", "mode": "live"}
    assert authed.post("/api/trading/start", json=body).status_code == 409
    started = authed.post("/api/trading/start", json={**body, "broker": "schwab"})
    assert started.status_code == 200, started.text
    task = started.json()
    assert task["config"]["broker"] == "schwab"
    assert "test-secret" not in started.text
    assert authed.delete("/api/settings/schwab/connection").status_code == 409
    connect(authed, authorize(authed, renew=True))
    authed.post(f"/api/trading/{task['id']}/stop", json={})
    wait_for(authed, "/api/trading/tasks", lambda data: data[0]["status"] == "stopped")

from __future__ import annotations

import time
from dataclasses import replace
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient

from backend.adapters.brokers.alpaca import AlpacaAdapter
from backend.adapters.brokers.mock import MockBroker
from backend.core.db import session_factory
from backend.services import schwab_service as schwab
from tests.test_task_manager import make_strategy


@pytest.fixture
def alpaca_accounts(monkeypatch: pytest.MonkeyPatch) -> None:
    def account(self):
        return replace(MockBroker().account, account_id=self._key, equity=float(self._key[-4:]))

    monkeypatch.setattr(AlpacaAdapter, "get_account", account)


def add_alpaca(client: TestClient, suffix: str) -> dict:
    response = client.post(
        "/api/profiles/alpaca",
        json={
            "name": f"Alpaca {suffix}",
            "api_key": f"testkey{suffix}",
            "api_secret": "testsecret123456",
            "endpoint": "https://paper-api.alpaca.markets",
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_profiles_scope_reads_and_allow_parallel_strategy(
    authed: TestClient, alpaca_accounts: None
) -> None:
    a, b = add_alpaca(authed, "1001"), add_alpaca(authed, "1002")
    assert a["account_hint"] == "••••1001"
    assert a["id"] != b["id"]
    strategy = make_strategy(authed)
    for profile, equity in [(a, 1001), (b, 1002)]:
        params = {"profile_id": profile["id"]}
        account = authed.get("/api/account/summary", params=params).json()["account"]
        assert account["equity"] == equity
        body = {"strategy_id": strategy, "mode": "paper", **params}
        started = authed.post("/api/trading/start", json=body)
        assert started.status_code == 200, started.text
        assert authed.post("/api/trading/start", json=body).status_code == 409
        assert [task["id"] for task in authed.get("/api/trading/tasks", params=params).json()] == [
            started.json()["id"]
        ]
        assert authed.delete(f"/api/profiles/{profile['id']}").status_code == 409
    assert authed.post("/api/trading/liquidate", json={"confirm": "LIQUIDATE"}).status_code == 400


def test_schwab_profiles_share_grant_and_renew_in_place(
    authed: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    callback = "https://127.0.0.1:8182"
    issued = []

    def exchange(flow, url):
        assert parse_qs(urlsplit(url).query)["state"] == [flow["state"]]
        issued.append(len(issued))
        return (
            {
                "access_token": f"token-{issued[-1]}",
                "refresh_token": "refresh",
                "expires_at": time.time() + 3600,
            },
            [{"number": "1234", "hash": "acct-a"}, {"number": "5678", "hash": "acct-b"}],
        )

    monkeypatch.setattr(schwab, "exchange", exchange)

    def authorize(body, selection):
        response = authed.post(
            "/api/profiles/schwab/authorize", json={"callback_url": callback, **body}
        )
        assert response.status_code == 200, response.text
        flow = response.json()
        state = parse_qs(urlsplit(flow["authorization_url"]).query)["state"][0]
        path = f"/api/profiles/schwab/{flow['flow_id']}/accounts"
        response = authed.post(path, json={"redirect_url": f"{callback}/?code=test&state={state}"})
        assert response.status_code == 200, response.text
        response = authed.put(path, json={"accounts": selection})
        assert response.status_code == 200, response.text
        return response.json()

    profiles = authorize({"app_key": "key", "app_secret": "secret"}, [0, 1])
    assert len(profiles) == 2
    ids = {p["id"] for p in profiles}
    assert {p["id"] for p in authorize({"profile_id": profiles[0]["id"]}, [0])} == ids
    with session_factory()() as db:
        conns = [schwab.connection(db, pid.removeprefix("schwab:")) for pid in ids]
        assert all(conn is not None for conn in conns)
        assert len({c.grant_id for c in conns if c}) == 1
        assert {c.account_hash for c in conns if c} == {"acct-a", "acct-b"}
        assert {c.token["access_token"] for c in conns if c} == {"token-1"}

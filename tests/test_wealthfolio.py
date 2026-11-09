from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import update

from backend.core.db import session_factory
from backend.models import WealthfolioDelivery
from backend.services import broker_service, wealthfolio
from backend.workers.trading_worker import make_managed_strategy

ENDPOINT = "https://wealthfolio.example.test"
ACCOUNTS = [{"id": "target", "name": "Stock portfolio", "currency": "USD"}]


def test_strategy_fills_are_queued_and_delivered_once(
    authed: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    delivered = {}
    failed = False

    def remote(request: httpx.Request) -> httpx.Response:
        nonlocal failed
        path = request.url.path
        if path.endswith("/auth/login"):
            assert b"wf-password" in request.content
            return httpx.Response(200, headers={"Set-Cookie": "wf_session=mock; Path=/api"})
        if request.headers.get("cookie") != "wf_session=mock":
            return httpx.Response(401)
        if path.endswith("/accounts"):
            return httpx.Response(200, json=ACCOUNTS)
        if path.endswith("/check-duplicates"):
            return httpx.Response(200, json={"duplicates": dict.fromkeys(delivered, "existing")})
        assert path.endswith("/activities")
        import json

        body = json.loads(request.content)
        key = body["idempotencyKey"]
        if key in delivered:
            return httpx.Response(409)
        assert body["accountId"] == "target" and body["activityType"] == "BUY"
        delivered[key] = body
        if not failed:
            failed = True
            raise httpx.ReadTimeout("Response lost after the server committed the fill")
        return httpx.Response(200, json={"id": "created"})

    monkeypatch.setattr(
        wealthfolio,
        "Client",
        lambda **kw: httpx.Client(transport=httpx.MockTransport(remote), **kw),
    )
    authed.put(
        "/api/settings/alpaca/credentials",
        json={
            "api_key": "PKTESTKEY1234",
            "api_secret": "secretsecretsecret12",
        },
    )
    body = {"endpoint": ENDPOINT, "password": "wf-password", "account_id": "target"}
    saved = authed.put("/api/settings/wealthfolio/connection", json=body)
    assert saved.status_code == 200 and saved.json()["active"]
    assert "wf-password" not in saved.text
    with session_factory()() as db:
        broker_key = broker_service.connection_key(broker_service.trading_connection(db))

    class Strategy:
        def on_partially_filled_order(self, *_):
            pass

        def on_filled_order(self, *_):
            pass

    strategy = make_managed_strategy(Strategy, tmp_path, broker_key)()
    first = SimpleNamespace(quantity=2, price=101)
    second = SimpleNamespace(quantity=3, price=102)
    order = SimpleNamespace(
        identifier="order-1",
        side="buy",
        asset=SimpleNamespace(symbol="AAPL", asset_type="stock"),
        transactions=[first],
    )
    strategy.on_partially_filled_order(None, order, 101, 2, 1)
    strategy.on_partially_filled_order(None, order, 101, 2, 1)
    order.transactions.append(second)
    strategy.on_filled_order(None, order, 102, 3, 1)
    status_url = "/api/settings/wealthfolio/connection"
    assert authed.get(status_url).json()["pending"] == 2
    wealthfolio.process_pending()
    assert authed.get(status_url).json()["pending"] == 1
    with session_factory()() as db:
        db.execute(update(WealthfolioDelivery).values(next_attempt=0))
        db.commit()
    wealthfolio.process_pending()
    status = authed.get(status_url).json()
    assert status["pending"] == 0 and status["last_synced_at"]
    assert sorted((body["quantity"], body["unitPrice"]) for body in delivered.values()) == [
        ("2", "101"),
        ("3", "102"),
    ]

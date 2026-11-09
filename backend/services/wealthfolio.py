"""Deliver completed strategy fills to the Wealthfolio web API."""

from __future__ import annotations

import hashlib
import logging
import threading
import time
from collections import Counter
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from urllib.parse import quote

import httpx
from httpx import Client
from sqlalchemy import func, select
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.orm import Session

from backend.adapters.brokers.base import BrokerError
from backend.core.db import session_factory
from backend.core.logging import register_secret
from backend.models import WealthfolioDelivery
from backend.services import broker_service, schwab_service
from backend.services.schwab_service import read_json_secret, write_json_secret

SECRET = "wealthfolio_connection"  # noqa: S105
log = logging.getLogger("wealthfolio")
BUY_SIDES = {"buy", "buy_to_open", "buy_to_close", "buy_to_cover"}
SELL_SIDES = {"sell", "sell_to_open", "sell_to_close", "sell_short"}
TRADE_SUBTYPES = {"sell_short": "SELL_SHORT", "buy_to_cover": "BUY_TO_COVER"}


class WealthfolioError(Exception):
    """A safe, displayable error from the remote connection."""


def stable_id(*parts: str) -> str:
    return hashlib.sha256("\0".join(parts).encode()).hexdigest()


@dataclass(frozen=True)
class Connection:
    endpoint: str
    password: str
    account_id: str
    account_name: str
    broker_key: str

    @property
    def destination(self) -> str:
        return stable_id(self.endpoint, self.account_id, self.broker_key)


def connection(db: Session) -> Connection | None:
    stored = read_json_secret(db, SECRET)
    return Connection(**stored) if stored else None


def save(db: Session, endpoint: str, password: str, account: dict, broker_key: str) -> None:
    write_json_secret(
        db,
        SECRET,
        {
            "endpoint": endpoint,
            "password": password,
            "account_id": account["id"],
            "account_name": account["name"],
            "broker_key": broker_key,
        },
    )


def status(db: Session) -> dict:
    cfg = connection(db)
    if cfg is None:
        return {"configured": False}
    rows = WealthfolioDelivery
    pending = db.scalar(
        select(func.count()).where(rows.destination == cfg.destination, rows.sent_at.is_(None))
    )
    last_sent = db.scalar(select(func.max(rows.sent_at)).where(rows.destination == cfg.destination))
    last_error = db.scalar(
        select(rows.error)
        .where(rows.destination == cfg.destination, rows.sent_at.is_(None), rows.error.is_not(None))
        .order_by(rows.next_attempt.desc())
        .limit(1)
    )
    return {
        "configured": True,
        "endpoint": cfg.endpoint,
        "account_name": cfg.account_name,
        "active": cfg.broker_key
        == broker_service.connection_key(broker_service.trading_connection(db)),
        "pending": pending,
        "last_error": last_error,
        "last_synced_at": datetime.fromtimestamp(last_sent, UTC).isoformat() if last_sent else None,
    }


def enqueue(broker_key: str, event_id: str, fill: dict) -> None:
    with session_factory()() as db:
        cfg = connection(db)
        if cfg is None or cfg.broker_key != broker_key:
            return
        db.execute(
            insert(WealthfolioDelivery)
            .values(
                id=stable_id(cfg.destination, event_id),
                destination=cfg.destination,
                payload=fill,
                attempts=0,
                next_attempt=time.time(),
            )
            .on_conflict_do_nothing(index_elements=["id"])
        )
        db.commit()


class WebClient:
    def __init__(self, endpoint: str, password: str) -> None:
        register_secret(password)
        self.password = password
        self.client = Client(base_url=f"{endpoint}/api/v1/", timeout=8, follow_redirects=False)

    def close(self) -> None:
        self.client.close()

    def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        try:
            response = self.client.request(method, path, **kwargs)
            if response.status_code == 401 and self.password:
                login = self.client.post("auth/login", json={"password": self.password})
                if login.status_code in (401, 403):
                    raise WealthfolioError("Wealthfolio rejected the password.")
                login.raise_for_status()
                response = self.client.request(method, path, **kwargs)
            return response
        except httpx.HTTPError:
            raise WealthfolioError("Could not reach the Wealthfolio API.") from None

    def accounts(self) -> list[dict]:
        response = self._request("GET", "accounts")
        if response.status_code in (401, 403):
            raise WealthfolioError("Wealthfolio requires a valid password.")
        if not response.is_success:
            raise WealthfolioError("Could not load Wealthfolio accounts.")
        try:
            return [
                {"id": a["id"], "name": a["name"], "currency": a["currency"]}
                for a in response.json()
            ]
        except (ValueError, KeyError, TypeError):
            raise WealthfolioError("The endpoint did not return Wealthfolio accounts.") from None

    def deliver(self, account: str, key: str, fill: dict) -> None:
        response = self._request(
            "POST",
            "activities",
            json={
                "accountId": account,
                "activityType": fill["type"],
                "subtype": fill.get("subtype"),
                "activityDate": fill["time"],
                "asset": {"symbol": fill["symbol"]},
                "quantity": fill["quantity"],
                "unitPrice": fill["price"],
                "currency": fill.get("currency", "USD"),
                "status": "POSTED",
                "idempotencyKey": key,
                "notes": "LumiBot strategy fill",
            },
        )
        if response.is_success:
            return
        # Verify the same idempotency key after a timeout/retry or a duplicate response.
        if response.status_code in (400, 409, 422):
            duplicate = self._request(
                "POST",
                "activities/import/check-duplicates",
                json={
                    "idempotencyKeys": [key],
                },
            )
            if duplicate.is_success and key in duplicate.json().get("duplicates", {}):
                return
        if response.status_code in (401, 403):
            raise WealthfolioError("Wealthfolio rejected the sync credentials.")
        raise WealthfolioError("Wealthfolio rejected the activity. Check the destination account.")


def activity_type(side: str) -> str | None:
    return "BUY" if side in BUY_SIDES else "SELL" if side in SELL_SIDES else None


def schwab_executions(cfg: Connection, order_id: str) -> list[tuple[str, dict]]:
    conn = schwab_service.access_connection(cfg.broker_key.removeprefix("schwab:"))
    path = (
        f"/trader/v1/accounts/{quote(conn.account_hash, safe='')}/orders/{quote(order_id, safe='')}"
    )
    order = schwab_service.request_json(path, conn.token["access_token"])
    legs = {leg["legId"]: leg for leg in order.get("orderLegCollection", [])}
    results = []
    occurrences: Counter[str] = Counter()
    for event in order.get("orderActivityCollection") or []:
        for execution in event.get("executionLegs") or []:
            leg = legs.get(execution.get("legId"), {})
            instrument = leg.get("instrument", {})
            instruction = leg.get("instruction", "").lower()
            side = activity_type(instruction)
            if side and instrument.get("assetType") == "EQUITY" and execution.get("quantity"):
                identity = stable_id(
                    cfg.destination,
                    order_id,
                    str(execution["legId"]),
                    execution["time"],
                    str(execution["quantity"]),
                    str(execution["price"]),
                )
                occurrences[identity] += 1
                key = stable_id(identity, str(occurrences[identity]))
                results.append(
                    (
                        key,
                        {
                            "type": side,
                            "subtype": TRADE_SUBTYPES.get(instruction),
                            "symbol": instrument["symbol"],
                            "time": execution["time"],
                            "quantity": str(execution["quantity"]),
                            "price": str(execution["price"]),
                        },
                    )
                )
    if not results:
        raise WealthfolioError("Schwab execution details are not available yet.")
    return results


def process_pending(stop: threading.Event | None = None) -> None:
    with session_factory()() as db:
        cfg = connection(db)
        if cfg is None:
            return
        queue = db.scalars(
            select(WealthfolioDelivery)
            .where(
                WealthfolioDelivery.destination == cfg.destination,
                WealthfolioDelivery.sent_at.is_(None),
                WealthfolioDelivery.next_attempt <= time.time(),
            )
            .order_by(WealthfolioDelivery.next_attempt)
            .limit(20)
        ).all()
        if not queue:
            return
        client = WebClient(cfg.endpoint, cfg.password)
        try:
            for row in queue:
                if stop is not None and stop.is_set():
                    return
                try:
                    if "schwab_order" in row.payload:
                        for key, fill in schwab_executions(cfg, row.payload["schwab_order"]):
                            client.deliver(cfg.account_id, key, fill)
                    else:
                        client.deliver(cfg.account_id, row.id, row.payload)
                except (WealthfolioError, BrokerError) as exc:
                    row.attempts += 1
                    row.error = str(exc)
                    row.next_attempt = time.time() + min(15 * 2 ** min(row.attempts, 6), 900)
                else:
                    row.sent_at = time.time()
                    row.error = None
                db.commit()
        finally:
            client.close()


class SyncWorker:
    def __init__(self) -> None:
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self.run, name="wealthfolio-sync", daemon=True)

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        self.thread.join(timeout=10)

    def run(self) -> None:
        while not self.stop_event.wait(5):
            try:
                process_pending(self.stop_event)
            except Exception:  # noqa: BLE001
                log.exception("Wealthfolio sync tick failed")

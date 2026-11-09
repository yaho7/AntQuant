"""Deliver completed strategy fills to the Wealthfolio web API."""

from __future__ import annotations

import hashlib
import logging
import threading
import time
from collections import Counter
from dataclasses import asdict, dataclass, replace
from datetime import UTC, datetime
from typing import Any
from urllib.parse import quote

import httpx
from httpx import Client
from sqlalchemy import func, select, text
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.orm import Session

from backend.adapters.brokers.base import BrokerError
from backend.core.db import session_factory
from backend.core.logging import register_secret
from backend.core.secrets import delete_secrets
from backend.models import (
    BrokerProfile,
    WealthfolioDelivery,
    WealthfolioOrderRoute,
    WealthfolioRoute,
)
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


def route_secret(destination: str) -> str:
    return f"wealthfolio:route:{destination}"


def current_key(db: Session) -> str | None:
    return broker_service.connection_key(broker_service.trading_connection(db))


def routes(db: Session, broker_key: str) -> list[WealthfolioRoute]:
    return list(
        db.scalars(select(WealthfolioRoute).where(WealthfolioRoute.broker_key == broker_key))
    )


def route_connection(db: Session, destination: str) -> Connection | None:
    stored = read_json_secret(db, route_secret(destination))
    return Connection(**stored) if stored else None


def connection(db: Session, broker_key: str | None = None) -> Connection | None:
    key = broker_key if broker_key is not None else current_key(db)
    selected = next((route for route in routes(db, key) if route.selected), None) if key else None
    return route_connection(db, selected.id) if selected else None


def saved_password(db: Session, broker_key: str | None, endpoint: str) -> str:
    if broker_key is None:
        return ""
    for route in sorted(routes(db, broker_key), key=lambda route: not route.selected):
        cfg = route_connection(db, route.id)
        if cfg and cfg.endpoint == endpoint:
            return cfg.password
    return ""


def save(db: Session, endpoint: str, password: str, account: dict, broker_key: str) -> None:
    cfg = Connection(endpoint, password, account["id"], account["name"], broker_key)
    route = db.get(WealthfolioRoute, cfg.destination)
    for prior in routes(db, broker_key):
        prior.selected = False
        old_cfg = route_connection(db, prior.id)
        if old_cfg and old_cfg.endpoint == cfg.endpoint and old_cfg.password != password:
            write_json_secret(
                db, route_secret(prior.id), asdict(replace(old_cfg, password=password))
            )
    if route is None:
        route = WealthfolioRoute(id=cfg.destination, broker_key=broker_key)
        db.add(route)
    route.selected = True
    route.paused = False
    write_json_secret(db, route_secret(cfg.destination), asdict(cfg))


def migrate_routes(db: Session) -> None:
    db.execute(text("BEGIN IMMEDIATE"))
    stored = read_json_secret(db, SECRET)
    if stored:
        cfg = Connection(**stored)
        save(
            db,
            cfg.endpoint,
            cfg.password,
            {"id": cfg.account_id, "name": cfg.account_name},
            cfg.broker_key,
        )
        db.flush()
        for order in db.scalars(
            select(WealthfolioDelivery.payload).where(
                WealthfolioDelivery.destination == cfg.destination
            )
        ):
            if "schwab_order" in order:
                db.execute(
                    insert(WealthfolioOrderRoute)
                    .values(
                        id=stable_id(cfg.broker_key, order["schwab_order"]),
                        destination=cfg.destination,
                    )
                    .on_conflict_do_nothing()
                )
        delete_secrets(db, SECRET)
    db.commit()


def pause(db: Session, broker_key: str) -> None:
    for route in routes(db, broker_key):
        route.selected = False
        route.paused = True


def status(db: Session, broker_key: str | None = None) -> dict:
    key = broker_key if broker_key is not None else current_key(db)
    available = routes(db, key) if key else []
    cfg = connection(db, key) if key else None
    rows = WealthfolioDelivery
    destinations = [route.id for route in available]
    queued = rows.destination.in_(destinations) & rows.sent_at.is_(None)
    pending = db.scalar(select(func.count()).where(queued))
    parked = db.scalar(
        select(func.count()).where(
            queued, rows.destination.in_([route.id for route in available if route.paused])
        )
    )
    last_sent = db.scalar(select(func.max(rows.sent_at)).where(rows.destination.in_(destinations)))
    last_error = db.scalar(
        select(rows.error)
        .where(queued, rows.error.is_not(None))
        .order_by(rows.next_attempt.desc())
        .limit(1)
    )
    return {
        "configured": cfg is not None,
        "endpoint": cfg.endpoint if cfg else None,
        "account_name": cfg.account_name if cfg else None,
        "active": cfg is not None,
        "pending": pending,
        "parked": parked,
        "last_error": last_error,
        "last_synced_at": datetime.fromtimestamp(last_sent, UTC).isoformat() if last_sent else None,
    }


def enqueue(
    broker_key: str,
    event_id: str,
    fill: dict,
    order_id: str | None = None,
    first_event_id: str | None = None,
) -> None:
    with session_factory()() as db:
        db.execute(text("BEGIN IMMEDIATE"))
        key = stable_id(broker_key, order_id) if order_id else None
        pinned = db.get(WealthfolioOrderRoute, key) if key else None
        if pinned:
            destination = pinned.destination
        else:
            available = routes(db, broker_key)
            # Pre-profile Alpaca deliveries used the first fill ID but did not store the order ID.
            route = next(
                (
                    item
                    for item in available
                    if first_event_id
                    and db.get(WealthfolioDelivery, stable_id(item.id, first_event_id)) is not None
                ),
                None,
            )
            route = route or next((item for item in available if item.selected), None)
            if route is None:
                return
            destination = route.id
            if key:
                db.add(WealthfolioOrderRoute(id=key, destination=destination))
        db.execute(
            insert(WealthfolioDelivery)
            .values(
                id=stable_id(destination, event_id),
                destination=destination,
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
                "notes": "AntQuant strategy fill",
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
        queue = db.scalars(
            select(WealthfolioDelivery)
            .join(WealthfolioRoute, WealthfolioRoute.id == WealthfolioDelivery.destination)
            .join(BrokerProfile, BrokerProfile.id == WealthfolioRoute.broker_key)
            .where(
                WealthfolioRoute.paused.is_(False),
                WealthfolioDelivery.sent_at.is_(None),
                WealthfolioDelivery.next_attempt <= time.time(),
            )
            .order_by(WealthfolioDelivery.next_attempt)
            .limit(20)
        ).all()
        clients: dict[str, tuple[Connection, WebClient]] = {}
        try:
            for row in queue:
                if stop is not None and stop.is_set():
                    return
                route = db.get(WealthfolioRoute, row.destination, populate_existing=True)
                if route is None or route.paused:
                    continue
                if row.destination not in clients:
                    cfg = route_connection(db, row.destination)
                    if cfg is None:
                        continue
                    clients[row.destination] = (cfg, WebClient(cfg.endpoint, cfg.password))
                cfg, client = clients[row.destination]
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
            for _, client in clients.values():
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

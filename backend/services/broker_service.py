"""Builds the broker adapter from stored credentials."""

from __future__ import annotations

import hashlib
import threading
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal

from sqlalchemy.orm import Session

from backend.adapters.brokers.alpaca import AlpacaAdapter
from backend.adapters.brokers.base import BrokerAdapter
from backend.adapters.brokers.endpoints import ALPACA_LIVE_URL, ALPACA_PAPER_URL, is_paper_endpoint
from backend.adapters.brokers.schwab import SchwabAdapter
from backend.core.logging import register_secret
from backend.core.secrets import delete_secrets, get_secrets, mask, set_secret
from backend.services import schwab_service
from backend.services.settings_store import (
    ALPACA_ENDPOINT,
    ALPACA_KEY,
    ALPACA_MODE,
    ALPACA_SECRET,
    get_setting,
    set_setting,
)

_lock = threading.Lock()
_cached: tuple[str, BrokerAdapter] | None = None
_override: BrokerAdapter | None = None


@dataclass(frozen=True)
class AlpacaConnection:
    key: str
    secret: str
    endpoint: str

    @property
    def paper(self) -> bool:
        return is_paper_endpoint(self.endpoint)


def set_broker_override(broker: BrokerAdapter | None) -> None:
    """Tests inject a MockBroker here."""
    global _override, _cached
    _override = broker
    _cached = None


def alpaca_credentials(db: Session) -> AlpacaConnection | None:
    # Read the full connection in one query so a concurrent update cannot mix credentials.
    values = get_secrets(db, ALPACA_KEY, ALPACA_SECRET, ALPACA_MODE, ALPACA_ENDPOINT)
    key, secret = values.get(ALPACA_KEY), values.get(ALPACA_SECRET)
    if not key or not secret:
        return None
    register_secret(key)
    register_secret(secret)
    fallback = ALPACA_LIVE_URL if values.get(ALPACA_MODE) == "live" else ALPACA_PAPER_URL
    return AlpacaConnection(key, secret, values.get(ALPACA_ENDPOINT) or fallback)


def save_alpaca_credentials(
    db: Session, key: str, secret: str, paper: bool, endpoint: str | None = None
) -> None:
    endpoint = endpoint or (ALPACA_PAPER_URL if paper else ALPACA_LIVE_URL)
    set_secret(db, ALPACA_KEY, key.strip())
    set_secret(db, ALPACA_SECRET, secret.strip())
    set_secret(db, ALPACA_MODE, "paper" if is_paper_endpoint(endpoint) else "live")
    set_secret(db, ALPACA_ENDPOINT, endpoint)


def remove_alpaca_credentials(db: Session) -> None:
    delete_secrets(db, ALPACA_KEY, ALPACA_SECRET, ALPACA_MODE, ALPACA_ENDPOINT)


def selected_broker(db: Session) -> Literal["alpaca", "schwab"]:
    return "schwab" if get_setting(db, "active_broker") == "schwab" else "alpaca"


def select_broker(db: Session, broker: Literal["alpaca", "schwab"]) -> None:
    set_setting(db, "active_broker", broker, commit=False)


def trading_connection(db: Session) -> AlpacaConnection | schwab_service.SchwabConnection | None:
    if selected_broker(db) == "schwab":
        return schwab_service.connection(db)
    return alpaca_credentials(db)


def schwab_status(db: Session) -> dict:
    conn = schwab_service.connection(db)
    return {
        "configured": conn is not None,
        "endpoint": schwab_service.SCHWAB_URL,
        "account_hint": mask(conn.account_number) if conn else None,
        "callback_url": conn.callback if conn else None,
        "authorization_expires_at": datetime.fromtimestamp(conn.expires_at, UTC).isoformat()
        if conn
        else None,
        "authorization_expired": bool(conn and conn.expires_at <= time.time()),
    }


def get_broker(db: Session) -> BrokerAdapter | None:
    """Return the configured broker, or None when no credentials are stored."""
    global _cached
    if _override is not None:
        return _override
    creds = trading_connection(db)
    if isinstance(creds, schwab_service.SchwabConnection):
        return SchwabAdapter(creds.id)
    if creds is None:
        return None
    fingerprint = hashlib.sha256(
        f"{creds.endpoint}\0{creds.key}\0{creds.secret}".encode()
    ).hexdigest()
    with _lock:
        if _cached is None or _cached[0] != fingerprint:
            _cached = (
                fingerprint,
                AlpacaAdapter(creds.key, creds.secret, paper=creds.paper, endpoint=creds.endpoint),
            )
        return _cached[1]


def reset_broker() -> None:
    global _cached
    with _lock:
        _cached = None

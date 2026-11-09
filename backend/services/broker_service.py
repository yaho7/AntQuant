"""Builds the broker adapter from stored credentials."""

from __future__ import annotations

import hashlib
import threading
from dataclasses import dataclass

from sqlalchemy.orm import Session

from backend.adapters.brokers.alpaca import AlpacaAdapter
from backend.adapters.brokers.base import BrokerAdapter
from backend.core.logging import register_secret
from backend.core.secrets import delete_secrets, get_secrets, set_secret
from backend.services.settings_store import ALPACA_KEY, ALPACA_MODE, ALPACA_SECRET

_lock = threading.Lock()
_cached: tuple[str, BrokerAdapter] | None = None
_override: BrokerAdapter | None = None


@dataclass(frozen=True)
class AlpacaConnection:
    key: str
    secret: str
    paper: bool


def set_broker_override(broker: BrokerAdapter | None) -> None:
    """Tests inject a MockBroker here."""
    global _override, _cached
    _override = broker
    _cached = None


def alpaca_credentials(db: Session) -> AlpacaConnection | None:
    # Read the full connection in one query so a concurrent update cannot mix credentials.
    values = get_secrets(db, ALPACA_KEY, ALPACA_SECRET, ALPACA_MODE)
    key, secret = values.get(ALPACA_KEY), values.get(ALPACA_SECRET)
    if not key or not secret:
        return None
    register_secret(key)
    register_secret(secret)
    return AlpacaConnection(key, secret, values.get(ALPACA_MODE) != "live")


def save_alpaca_credentials(db: Session, key: str, secret: str, paper: bool) -> None:
    set_secret(db, ALPACA_KEY, key.strip())
    set_secret(db, ALPACA_SECRET, secret.strip())
    set_secret(db, ALPACA_MODE, "paper" if paper else "live")


def remove_alpaca_credentials(db: Session) -> None:
    delete_secrets(db, ALPACA_KEY, ALPACA_SECRET, ALPACA_MODE)


def get_broker(db: Session) -> BrokerAdapter | None:
    """Return the configured broker, or None when no credentials are stored."""
    global _cached
    if _override is not None:
        return _override
    creds = alpaca_credentials(db)
    if creds is None:
        return None
    fingerprint = hashlib.sha256(f"{creds.paper}\0{creds.key}\0{creds.secret}".encode()).hexdigest()
    with _lock:
        if _cached is None or _cached[0] != fingerprint:
            _cached = (fingerprint, AlpacaAdapter(creds.key, creds.secret, paper=creds.paper))
        return _cached[1]


def reset_broker() -> None:
    global _cached
    with _lock:
        _cached = None

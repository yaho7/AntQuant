"""Builds the broker adapter from stored credentials."""

from __future__ import annotations

import hashlib
import threading

from sqlalchemy.orm import Session

from backend.adapters.brokers.alpaca import AlpacaAdapter
from backend.adapters.brokers.base import BrokerAdapter
from backend.core.logging import register_secret
from backend.core.secrets import get_secret
from backend.services.settings_store import ALPACA_KEY, ALPACA_SECRET

_lock = threading.Lock()
_cached: tuple[str, BrokerAdapter] | None = None
_override: BrokerAdapter | None = None


def set_broker_override(broker: BrokerAdapter | None) -> None:
    """Tests inject a MockBroker here."""
    global _override, _cached
    _override = broker
    _cached = None


def alpaca_credentials(db: Session) -> tuple[str, str] | None:
    key = get_secret(db, ALPACA_KEY)
    secret = get_secret(db, ALPACA_SECRET)
    if not key or not secret:
        return None
    register_secret(key)
    register_secret(secret)
    return key, secret


def get_broker(db: Session) -> BrokerAdapter | None:
    """Return the configured broker, or None when no credentials are stored."""
    global _cached
    if _override is not None:
        return _override
    creds = alpaca_credentials(db)
    if creds is None:
        return None
    fingerprint = hashlib.sha256("\0".join(creds).encode()).hexdigest()
    with _lock:
        if _cached is None or _cached[0] != fingerprint:
            # Paper is hard-wired: live trading is not available in this release.
            _cached = (fingerprint, AlpacaAdapter(creds[0], creds[1], paper=True))
        return _cached[1]


def reset_broker() -> None:
    global _cached
    with _lock:
        _cached = None

"""Schwab OAuth credentials and refresh, shared by the API and trading workers."""

from __future__ import annotations

import fcntl
import hmac
import json
import os
import secrets
import time
from dataclasses import asdict, dataclass, replace
from typing import Any
from urllib.parse import parse_qs, urlencode, urlsplit

import httpx
from sqlalchemy import text
from sqlalchemy.orm import Session

from backend.adapters.brokers.base import BrokerError
from backend.core.config import get_settings
from backend.core.db import session_factory
from backend.core.logging import register_secret
from backend.core.secrets import get_secrets, set_secret

SCHWAB_URL = "https://api.schwabapi.com"
SCHWAB_CONNECTION = "schwab_connection"
SCHWAB_PENDING = "schwab_pending"
AUTH_LIFETIME = 7 * 24 * 3600
AUTH_REQUIRED = "Schwab authorization expired. Reconnect in Settings."
TOKEN_URL = f"{SCHWAB_URL}/v1/oauth/token"


@dataclass(frozen=True)
class SchwabConnection:
    id: str
    app_key: str
    app_secret: str
    callback: str
    account_number: str
    account_hash: str
    token: dict[str, Any]
    authorized_at: float

    @property
    def paper(self) -> bool:
        return False

    @property
    def expires_at(self) -> float:
        return self.authorized_at + AUTH_LIFETIME


def read_json_secret(db: Session, name: str) -> dict[str, Any] | None:
    value = get_secrets(db, name).get(name)
    return json.loads(value) if value else None


def write_json_secret(db: Session, name: str, value: dict[str, Any]) -> None:
    set_secret(db, name, json.dumps(value))


def connection(db: Session) -> SchwabConnection | None:
    stored = read_json_secret(db, SCHWAB_CONNECTION)
    return SchwabConnection(**stored) if stored else None


def authorize(app_key: str, callback: str) -> tuple[str, str]:
    state = secrets.token_urlsafe(32)
    query = urlencode(
        {"client_id": app_key, "redirect_uri": callback, "state": state, "response_type": "code"}
    )
    return f"{SCHWAB_URL}/v1/oauth/authorize?{query}", state


def validate_callback(value: str) -> str:
    try:
        url = urlsplit(value)
        port = url.port
    except ValueError:
        raise ValueError("Enter a valid HTTPS callback URL.") from None
    if (
        url.scheme != "https"
        or not url.hostname
        or url.username is not None
        or url.query
        or url.fragment
        or port == 0
        or any(ch.isspace() for ch in value)
    ):
        raise ValueError("Enter a valid HTTPS callback URL.")
    return value


def exchange(pending: dict[str, Any], received: str) -> tuple[dict, list[dict]]:
    try:
        callback = urlsplit(pending["callback"])
        redirect = urlsplit(received)
        values = parse_qs(redirect.query)
        states, codes = values.get("state", []), values.get("code", [])
        matches = (redirect.scheme, redirect.netloc, redirect.path or "/") == (
            callback.scheme,
            callback.netloc,
            callback.path or "/",
        )
    except ValueError:
        raise BrokerError("The Schwab callback URL is invalid.", 400) from None
    if (
        not matches
        or redirect.fragment
        or len(states) != 1
        or len(codes) != 1
        or not hmac.compare_digest(states[0].encode(), pending["state"].encode())
    ):
        raise BrokerError("The Schwab callback URL does not match this authorization.", 400)
    token = request_token(
        pending["app_key"],
        pending["app_secret"],
        {"grant_type": "authorization_code", "code": codes[0], "redirect_uri": pending["callback"]},
    )
    if not token.get("refresh_token"):
        raise BrokerError("Schwab did not return a refresh token. Reauthorize in Settings.", 401)
    accounts = request_json("/trader/v1/accounts/accountNumbers", token["access_token"])
    valid = [
        {"number": str(a["accountNumber"]), "hash": a["hashValue"]}
        for a in accounts
        if a.get("accountNumber") and a.get("hashValue")
    ]
    if not valid:
        raise BrokerError("Schwab returned no authorized accounts.", 400)
    return token, valid


def request_token(app_key: str, app_secret: str, fields: dict[str, str]) -> dict[str, Any]:
    register_secret(app_key)
    register_secret(app_secret)
    try:
        response = httpx.post(TOKEN_URL, auth=(app_key, app_secret), data=fields, timeout=10)
        if response.status_code in (400, 401, 403):
            error = (
                AUTH_REQUIRED
                if fields["grant_type"] == "refresh_token"
                else "Schwab rejected the authorization. Check the app credentials and start again."
            )
            raise BrokerError(error, 401)
        response.raise_for_status()
        token = response.json()
        token["expires_at"] = time.time() + int(token["expires_in"])
        register_secret(token["access_token"])
        register_secret(token.get("refresh_token"))
        return token
    except (httpx.HTTPError, TypeError, ValueError, KeyError):
        raise BrokerError("Schwab token service is unavailable.") from None


def request_json(path: str, access_token: str, **params: Any) -> Any:
    register_secret(access_token)
    try:
        response = httpx.get(
            f"{SCHWAB_URL}{path}",
            params=params,
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=10,
        )
        if response.status_code in (401, 403):
            raise BrokerError(AUTH_REQUIRED, 401)
        if response.status_code == 429:
            raise BrokerError("Schwab rate limit reached. Try again in a few seconds.", 429)
        response.raise_for_status()
        return response.json()
    except (httpx.HTTPError, ValueError):
        raise BrokerError("Schwab API request failed.") from None


def require_connection(db: Session, connection_id: str) -> SchwabConnection:
    current = connection(db)
    if current is None or current.id != connection_id:
        raise BrokerError("Schwab account is no longer connected.", 409)
    if current.expires_at <= time.time():
        raise BrokerError(AUTH_REQUIRED, 401)
    return current


def access_connection(connection_id: str) -> SchwabConnection:
    factory = session_factory()
    with factory() as db:
        current = require_connection(db, connection_id)
        if current.token["expires_at"] > time.time() + 120:
            return current

    # Only one API request or worker may rotate this account's refresh token at a time.
    path = get_settings().data_dir / ".schwab-refresh.lock"
    with os.fdopen(os.open(path, os.O_CREAT | os.O_RDWR, 0o600), "r+") as lock, factory() as db:
        fcntl.flock(lock, fcntl.LOCK_EX)
        current = require_connection(db, connection_id)
        if current.token["expires_at"] > time.time() + 120:
            return current
        refresh_token = current.token.get("refresh_token")
        if not refresh_token:
            raise BrokerError(AUTH_REQUIRED, 401)
        token = request_token(
            current.app_key,
            current.app_secret,
            {"grant_type": "refresh_token", "refresh_token": refresh_token},
        )
        token.setdefault("refresh_token", refresh_token)
        db.execute(text("BEGIN IMMEDIATE"))
        latest = require_connection(db, connection_id)
        if latest.authorized_at != current.authorized_at:
            return latest
        updated = replace(current, token=token)
        write_json_secret(db, SCHWAB_CONNECTION, asdict(updated))
        db.commit()
        return updated

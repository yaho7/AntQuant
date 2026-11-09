"""Connect LumiBot to a centrally refreshed Schwab authorization."""

from __future__ import annotations

import logging
import tempfile
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from backend.adapters.brokers.base import BrokerError
from backend.core.db import init_engine
from backend.services.schwab_service import access_connection
from backend.workers.common import write_json

log = logging.getLogger(__name__)


@contextmanager
def broker_session(connection_id: str) -> Iterator[Any]:
    from lumibot.brokers import Schwab

    init_engine()
    with tempfile.TemporaryDirectory(prefix="lumibot-schwab-") as directory:
        path = Path(directory) / "access.json"
        last_token = None

        def publish():
            nonlocal last_token
            conn = access_connection(connection_id)
            token = {
                "access_token": conn.token["access_token"],
                "token_type": "Bearer",
                "expires_at": min(conn.token["expires_at"], conn.expires_at),
            }
            if token != last_token:
                write_json(path, {"creation_timestamp": int(conn.authorized_at), "token": token})
                last_token = token
            return conn

        conn = publish()
        stop = threading.Event()

        def refresh() -> None:
            last_error = None
            while not stop.wait(15):
                try:
                    publish()
                except (BrokerError, OSError) as exc:
                    if str(exc) != last_error:
                        log.warning("Schwab credentials could not be updated: %s", exc)
                        last_error = str(exc)
                else:
                    last_error = None

        thread = threading.Thread(target=refresh, name="schwab-access-token", daemon=True)
        thread.start()
        try:
            broker = Schwab(
                config={
                    "SCHWAB_APP_KEY": conn.app_key,
                    "SCHWAB_ACCOUNT_NUMBER": conn.account_number,
                    "SCHWAB_BACKEND_CALLBACK_URL": conn.callback,
                    "SCHWAB_TOKEN_PATH": str(path),
                    "LUMIBOT_OAUTH_REFRESH_MODE": "external",
                }
            )
            if not broker._broker_fully_ready:
                raise RuntimeError(
                    "Schwab broker could not connect. Check the authorization in Settings."
                )
            yield broker
        finally:
            stop.set()
            thread.join()

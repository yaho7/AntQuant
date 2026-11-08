"""First-run setup.

Until an admin account exists, creating one requires a one-time setup token.
The token is printed to the server log and saved to `<data>/setup-token.txt`,
so only someone with access to the server can claim the instance.
"""

from __future__ import annotations

import hmac
import logging
import os
import secrets

from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.core.config import Settings
from backend.models import AdminUser

log = logging.getLogger("setup")


def admin_exists(db: Session) -> bool:
    return db.scalar(select(AdminUser.id).limit(1)) is not None


def token_path(settings: Settings):  # type: ignore[no-untyped-def]
    return settings.data_dir / "setup-token.txt"


def ensure_setup_token(db: Session, settings: Settings) -> str | None:
    path = token_path(settings)
    if admin_exists(db):
        path.unlink(missing_ok=True)
        return None
    if path.exists():
        token = path.read_text().strip()
    else:
        token = secrets.token_hex(4) + "-" + secrets.token_hex(4)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as fh:
            fh.write(token + "\n")
    log.warning("=" * 60)
    log.warning("First-run setup token: %s", token)
    log.warning("Open the web UI and enter this token to create the admin account.")
    log.warning("=" * 60)
    return token


def check_setup_token(settings: Settings, supplied: str) -> bool:
    path = token_path(settings)
    if not path.exists():
        return False
    return hmac.compare_digest(path.read_text().strip(), supplied.strip())


def consume_setup_token(settings: Settings) -> None:
    token_path(settings).unlink(missing_ok=True)

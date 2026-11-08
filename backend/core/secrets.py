"""Encrypted secret storage.

Secrets (broker API keys) are encrypted with Fernet using a key file that is
generated on first start inside the data directory with 0600 permissions.
This protects against a leaked database file or backup on its own; anyone who
can read the whole data directory can still decrypt. Protect the volume.
"""

from __future__ import annotations

import os
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy.orm import Session

from backend.core.config import get_settings
from backend.models import Secret

_fernet: Fernet | None = None


def _load_or_create_key(path: Path) -> bytes:
    if path.exists():
        return path.read_bytes().strip()
    path.parent.mkdir(parents=True, exist_ok=True)
    key = Fernet.generate_key()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as fh:
        fh.write(key)
    return key


def fernet() -> Fernet:
    global _fernet
    if _fernet is None:
        _fernet = Fernet(_load_or_create_key(get_settings().secret_key_path))
    return _fernet


def reset_cache() -> None:
    global _fernet
    _fernet = None


def set_secret(db: Session, name: str, value: str) -> None:
    token = fernet().encrypt(value.encode()).decode()
    row = db.get(Secret, name)
    if row is None:
        db.add(Secret(name=name, ciphertext=token))
    else:
        row.ciphertext = token
    db.commit()


def get_secret(db: Session, name: str) -> str | None:
    row = db.get(Secret, name)
    if row is None:
        return None
    try:
        return fernet().decrypt(row.ciphertext.encode()).decode()
    except InvalidToken:
        return None


def has_secret(db: Session, name: str) -> bool:
    return db.get(Secret, name) is not None


def delete_secret(db: Session, name: str) -> None:
    row = db.get(Secret, name)
    if row is not None:
        db.delete(row)
        db.commit()


def mask(value: str | None) -> str | None:
    """Show only the last 4 characters (used for the non-secret key id)."""
    if not value:
        return None
    return "••••" + value[-4:]

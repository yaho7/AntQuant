from __future__ import annotations

from collections.abc import Iterator

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from backend.core.config import Settings, get_settings
from backend.core.db import session_factory
from backend.core.security import CSRF_HEADER, SESSION_COOKIE, csrf_matches, lookup_session
from backend.models import UserSession
from backend.services.task_manager import TaskManager

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def get_db() -> Iterator[Session]:
    db = session_factory()()
    try:
        yield db
    finally:
        db.close()


def settings_dep() -> Settings:
    return get_settings()


def client_ip(request: Request) -> str:
    return request.client.host if request.client else ""


def require_session(request: Request, db: Session = Depends(get_db)) -> UserSession:
    """Authenticate via the session cookie; enforce CSRF on state-changing calls."""
    session = lookup_session(db, request.cookies.get(SESSION_COOKIE))
    if session is None:
        raise HTTPException(status_code=401, detail="Not signed in.")
    if request.method not in SAFE_METHODS and not csrf_matches(
        session.csrf_token, request.headers.get(CSRF_HEADER)
    ):
        raise HTTPException(status_code=403, detail="Missing or invalid CSRF token.")
    return session


def task_manager(request: Request) -> TaskManager:
    return request.app.state.task_manager  # type: ignore[no-any-return]

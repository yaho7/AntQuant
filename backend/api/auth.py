from __future__ import annotations

import threading
import time
from collections import defaultdict, deque

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from backend.api.deps import client_ip, get_db, require_session, settings_dep
from backend.core.audit import audit
from backend.core.config import Settings
from backend.core.security import (
    SESSION_COOKIE,
    create_session,
    delete_all_sessions,
    delete_session,
    hash_password,
    validate_new_password,
    verify_password,
)
from backend.models import AdminUser, UserSession
from backend.schemas import LoginRequest, PasswordChange, SetupRequest
from backend.services import broker_service

router = APIRouter(prefix="/api/auth", tags=["auth"])

_FAIL_WINDOW = 300
_FAIL_LIMIT = 5
_failures: dict[str, deque[float]] = defaultdict(deque)
_fail_lock = threading.Lock()


def _throttle(ip: str) -> None:
    with _fail_lock:
        q = _failures[ip]
        cutoff = time.monotonic() - _FAIL_WINDOW
        while q and q[0] < cutoff:
            q.popleft()
        if len(q) >= _FAIL_LIMIT:
            raise HTTPException(429, "Too many failed attempts. Try again in a few minutes.")


def _record_failure(ip: str) -> None:
    with _fail_lock:
        _failures[ip].append(time.monotonic())


def reset_throttle() -> None:
    with _fail_lock:
        _failures.clear()


def _set_cookie(response: Response, token: str, settings: Settings) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=settings.session_hours * 3600,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="strict",
        path="/",
    )


def _admin_exists(db: Session) -> bool:
    return db.scalar(select(AdminUser.id).limit(1)) is not None


@router.get("/status")
def status(request: Request, db: Session = Depends(get_db)) -> dict[str, bool]:
    from backend.core.security import lookup_session

    return {
        "setup_required": not _admin_exists(db),
        "authenticated": lookup_session(db, request.cookies.get(SESSION_COOKIE)) is not None,
    }


@router.post("/setup")
def setup(
    body: SetupRequest,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    settings: Settings = Depends(settings_dep),
) -> dict[str, str]:
    ip = client_ip(request)
    _throttle(ip)
    # Serialize the check and creation across processes, even for different usernames.
    db.execute(text("BEGIN IMMEDIATE"))
    if _admin_exists(db):
        raise HTTPException(409, "Setup is already complete.")
    if err := validate_new_password(body.password):
        raise HTTPException(400, err)
    if bool(body.alpaca_api_key) != bool(body.alpaca_api_secret):
        raise HTTPException(400, "Enter both the Alpaca API key and secret, or neither.")
    user = AdminUser(username=body.username, password_hash=hash_password(body.password))
    db.add(user)
    db.flush()
    if body.alpaca_api_key and body.alpaca_api_secret:
        broker_service.save_alpaca_credentials(
            db, body.alpaca_api_key, body.alpaca_api_secret, body.alpaca_paper
        )
    token = create_session(
        db, user, settings.session_hours, request.headers.get("user-agent", ""), commit=False
    )
    # Commit the administrator, credentials and session with the setup audit entry.
    audit(db, "setup.complete", body.username, {"alpaca": bool(body.alpaca_api_key)}, ip)
    if body.alpaca_api_key:
        broker_service.reset_broker()
    _set_cookie(response, token, settings)
    return {"status": "ok"}


@router.post("/login")
def login(
    body: LoginRequest,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    settings: Settings = Depends(settings_dep),
) -> dict[str, str]:
    ip = client_ip(request)
    _throttle(ip)
    user = db.scalar(select(AdminUser).where(AdminUser.username == body.username))
    if user is None or not verify_password(user.password_hash, body.password):
        _record_failure(ip)
        audit(db, "auth.login", body.username[:64], {}, ip, success=False)
        raise HTTPException(401, "Wrong username or password.")
    token = create_session(db, user, settings.session_hours, request.headers.get("user-agent", ""))
    _set_cookie(response, token, settings)
    audit(db, "auth.login", user.username, {}, ip)
    return {"status": "ok"}


@router.post("/logout")
def logout(
    request: Request,
    response: Response,
    session: UserSession = Depends(require_session),
    db: Session = Depends(get_db),
) -> dict[str, str]:
    delete_session(db, request.cookies.get(SESSION_COOKIE))
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"status": "ok"}


@router.get("/me")
def me(session: UserSession = Depends(require_session), db: Session = Depends(get_db)) -> dict:
    user = db.get(AdminUser, session.user_id)
    return {"username": user.username if user else "", "csrf_token": session.csrf_token}


@router.post("/password")
def change_password(
    body: PasswordChange,
    request: Request,
    response: Response,
    session: UserSession = Depends(require_session),
    db: Session = Depends(get_db),
    settings: Settings = Depends(settings_dep),
) -> dict[str, str]:
    ip = client_ip(request)
    _throttle(ip)
    user = db.get(AdminUser, session.user_id)
    if user is None or not verify_password(user.password_hash, body.current_password):
        _record_failure(ip)
        raise HTTPException(400, "Current password is wrong.")
    if err := validate_new_password(body.new_password):
        raise HTTPException(400, err)
    from datetime import UTC, datetime

    user.password_hash = hash_password(body.new_password)
    user.password_changed_at = datetime.now(UTC)
    db.commit()
    delete_all_sessions(db, user.id)  # sign out every other browser
    token = create_session(db, user, settings.session_hours, request.headers.get("user-agent", ""))
    _set_cookie(response, token, settings)
    audit(db, "auth.password_change", user.username, {}, ip)
    return {"status": "ok"}

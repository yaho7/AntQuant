from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

from fastapi.testclient import TestClient

from tests.conftest import PASSWORD, setup_admin


def test_first_setup_creates_admin(client: TestClient) -> None:
    assert client.get("/api/auth/status").json() == {
        "setup_required": True,
        "authenticated": False,
    }
    r = client.post(
        "/api/auth/setup",
        json={"username": "admin", "password": "short"},
    )
    assert r.status_code == 400
    setup_admin(client)
    status = client.get("/api/auth/status").json()
    assert status == {"setup_required": False, "authenticated": True}
    # Setup cannot run twice.
    r = client.post("/api/auth/setup", json={"username": "other-admin", "password": PASSWORD})
    assert r.status_code == 409


def test_simultaneous_setup_creates_one_admin(client: TestClient) -> None:
    start = Barrier(2)

    def claim(username: str) -> tuple[str, int]:
        start.wait(timeout=5)
        response = client.post("/api/auth/setup", json={"username": username, "password": PASSWORD})
        return username, response.status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = dict(pool.map(claim, ("admin-one", "admin-two")))

    assert sorted(results.values()) == [200, 409]
    assert results[client.get("/api/auth/me").json()["username"]] == 200


def test_session_cookie_flags(client: TestClient) -> None:
    r = client.post(
        "/api/auth/setup",
        json={"username": "admin", "password": PASSWORD},
    )
    cookie = r.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=strict" in cookie


def test_api_requires_login(client: TestClient) -> None:
    for path in ("/api/strategies", "/api/account/summary", "/api/logs", "/api/settings"):
        assert client.get(path).status_code == 401


def test_csrf_enforced(authed: TestClient) -> None:
    token = authed.headers.pop("X-CSRF-Token")
    r = authed.post("/api/trading/emergency-stop", json={})
    assert r.status_code == 403
    authed.headers["X-CSRF-Token"] = token
    assert authed.post("/api/trading/emergency-stop", json={}).status_code == 200


def test_form_posts_rejected(authed: TestClient) -> None:
    r = authed.post(
        "/api/auth/logout",
        content=b"a=b",
        headers={"content-type": "application/x-www-form-urlencoded"},
    )
    assert r.status_code == 415


def test_login_logout_and_throttle(authed: TestClient) -> None:
    authed.post("/api/auth/logout", json={})
    assert authed.get("/api/strategies").status_code == 401
    assert (
        authed.post("/api/auth/login", json={"username": "admin", "password": PASSWORD}).status_code
        == 200
    )
    authed.post(
        "/api/auth/logout",
        json={},
        headers={"X-CSRF-Token": authed.get("/api/auth/me").json()["csrf_token"]},
    )
    for _ in range(5):
        r = authed.post("/api/auth/login", json={"username": "admin", "password": "nope"})
        assert r.status_code == 401
    r = authed.post("/api/auth/login", json={"username": "admin", "password": PASSWORD})
    assert r.status_code == 429


def test_change_password(authed: TestClient) -> None:
    r = authed.post(
        "/api/auth/password",
        json={"current_password": "bad", "new_password": "another long password"},
    )
    assert r.status_code == 400
    r = authed.post(
        "/api/auth/password", json={"current_password": PASSWORD, "new_password": "short"}
    )
    assert r.status_code == 400
    r = authed.post(
        "/api/auth/password",
        json={"current_password": PASSWORD, "new_password": "another long password"},
    )
    assert r.status_code == 200
    authed.headers["X-CSRF-Token"] = authed.get("/api/auth/me").json()["csrf_token"]
    authed.post("/api/auth/logout", json={})
    r = authed.post(
        "/api/auth/login", json={"username": "admin", "password": "another long password"}
    )
    assert r.status_code == 200


def test_health_is_public(client: TestClient) -> None:
    assert client.get("/api/health").json()["status"] == "ok"

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

PASSWORD = "correct horse battery"


@pytest.fixture
def data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("LUMIBOT_UI_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("LUMIBOT_UI_FRONTEND_DIST", str(tmp_path / "no-frontend"))
    from backend.core import secrets
    from backend.core.config import get_settings

    get_settings.cache_clear()
    secrets.reset_cache()
    yield tmp_path / "data"
    get_settings.cache_clear()
    secrets.reset_cache()


@pytest.fixture
def fake_workers(monkeypatch: pytest.MonkeyPatch) -> None:
    from backend.services import task_manager

    monkeypatch.setattr(
        task_manager,
        "WORKER_MODULES",
        {"backtest": "tests.fake_worker", "trading": "tests.fake_worker"},
    )


@pytest.fixture
def client(data_dir: Path, fake_workers: None) -> Iterator[TestClient]:
    from backend.api.auth import reset_throttle
    from backend.main import create_app
    from backend.services.broker_service import set_broker_override

    reset_throttle()
    app = create_app()
    with TestClient(app) as c:
        app.state.task_manager.poll_seconds = 0.1
        yield c
    set_broker_override(None)


def setup_admin(client: TestClient, data_dir: Path, **extra: str) -> str:
    """Complete first-run setup and return the CSRF token."""
    token = (data_dir / "setup-token.txt").read_text().strip()
    r = client.post(
        "/api/auth/setup",
        json={"setup_token": token, "username": "admin", "password": PASSWORD, **extra},
    )
    assert r.status_code == 200, r.text
    csrf = client.get("/api/auth/me").json()["csrf_token"]
    client.headers["X-CSRF-Token"] = csrf
    return csrf


@pytest.fixture
def authed(client: TestClient, data_dir: Path) -> TestClient:
    setup_admin(client, data_dir)
    return client


def pytest_collection_modifyitems(config, items):  # type: ignore[no-untyped-def]
    if os.environ.get("RUN_INTEGRATION") == "1":
        return
    skip = pytest.mark.skip(reason="set RUN_INTEGRATION=1 (needs network)")
    for item in items:
        if "integration" in item.keywords:
            item.add_marker(skip)

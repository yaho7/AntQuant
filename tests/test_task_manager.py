from __future__ import annotations

import time
from datetime import date, timedelta
from pathlib import Path

from fastapi.testclient import TestClient

from backend.adapters.brokers.mock import MockBroker
from backend.services.broker_service import set_broker_override


def wait_for(client: TestClient, url: str, predicate, timeout: float = 15):  # type: ignore[no-untyped-def]
    deadline = time.monotonic() + timeout
    body = None
    while time.monotonic() < deadline:
        body = client.get(url).json()
        if predicate(body):
            return body
        time.sleep(0.1)
    raise AssertionError(f"timeout waiting on {url}: {body}")


def make_strategy(client: TestClient, params: dict | None = None) -> int:
    r = client.post(
        "/api/strategies",
        json={"name": "S1", "source_path": "examples/buy_and_hold.py",
              "class_name": "BuyAndHold", "parameters": params or {}},
    )
    return int(r.json()["id"])


def backtest_body(sid: int, **params) -> dict:  # type: ignore[no-untyped-def]
    end = date.today() - timedelta(days=1)
    return {"strategy_id": sid, "start": (end - timedelta(days=30)).isoformat(),
            "end": end.isoformat(), "budget": 10000, "parameters": params}


def test_backtest_runs_in_subprocess(authed: TestClient) -> None:
    sid = make_strategy(authed)
    task = authed.post("/api/backtests", json=backtest_body(sid, sleep=0.5)).json()
    assert task["status"] in ("pending", "starting")
    # The API answers while the worker runs.
    assert authed.get("/api/health").status_code == 200
    done = wait_for(authed, f"/api/backtests/{task['id']}", lambda b: b["status"] == "completed")
    assert done["metrics"] == {"total_return": 0.1}
    assert authed.get(f"/api/backtests/{task['id']}/result").status_code == 200
    log = authed.get("/api/logs", params={"source": f"task:{task['id']}"}).json()
    assert any("fake worker" in e["message"] for e in log["entries"])


def test_duplicate_backtest_rejected(authed: TestClient) -> None:
    sid = make_strategy(authed)
    body = backtest_body(sid, sleep=2)
    assert authed.post("/api/backtests", json=body).status_code == 200
    assert authed.post("/api/backtests", json=body).status_code == 409


def test_backtest_failure_reported(authed: TestClient) -> None:
    sid = make_strategy(authed)
    task = authed.post("/api/backtests", json=backtest_body(sid, fail=True)).json()
    done = wait_for(authed, f"/api/backtests/{task['id']}", lambda b: b["status"] == "failed")
    assert done["error_message"] == "boom"


def test_backtest_date_validation(authed: TestClient) -> None:
    sid = make_strategy(authed)
    body = backtest_body(sid)
    body["end"] = (date.today() + timedelta(days=5)).isoformat()
    assert authed.post("/api/backtests", json=body).status_code == 400


def test_trading_start_pause_stop(authed: TestClient, data_dir: Path) -> None:
    sid = make_strategy(authed)
    # Without keys trading is refused.
    assert authed.post("/api/trading/start", json={"strategy_id": sid}).status_code == 400
    authed.put("/api/settings/alpaca/credentials",
               json={"api_key": "PKTESTKEY1234", "api_secret": "secretsecretsecret12"})
    set_broker_override(MockBroker())
    task = authed.post("/api/trading/start", json={"strategy_id": sid}).json()
    assert authed.post("/api/trading/start", json={"strategy_id": sid}).status_code == 409
    wait_for(authed, "/api/trading/tasks", lambda b: b[0]["status"] == "running")
    r = authed.post(f"/api/trading/{task['id']}/pause", json={})
    assert r.json()["paused"] is True
    control = data_dir / "tasks" / task["id"] / "control.json"
    assert '"paused": true' in control.read_text()
    authed.post(f"/api/trading/{task['id']}/resume", json={})
    assert '"paused": false' in control.read_text()
    authed.post(f"/api/trading/{task['id']}/stop", json={})
    stopped = wait_for(authed, "/api/trading/tasks", lambda b: b[0]["status"] == "stopped")
    assert stopped[0]["error_message"] == "Stopped by user."


def test_restart_marks_lost_tasks(data_dir: Path, fake_workers: None) -> None:
    from backend.core.db import init_engine, run_migrations, session_factory
    from backend.core.config import get_settings
    from backend.models import Task
    from backend.services.task_manager import TaskManager

    settings = get_settings()
    settings.ensure_dirs()
    run_migrations(settings.db_path)
    init_engine(settings.db_path)
    factory = session_factory()
    with factory() as db:
        db.add(Task(id="lost1", kind="trading", mode="paper", status="running", pid=999999,
                    work_dir=str(data_dir), log_path=str(data_dir / "x.log")))
        db.commit()
    TaskManager(settings, factory, lambda db: None).recover()
    with factory() as db:
        task = db.get(Task, "lost1")
        assert task is not None and task.status == "failed"
        assert "not resumed automatically" in (task.error_message or "")

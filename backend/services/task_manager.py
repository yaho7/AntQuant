"""Runs backtests and trading strategies as child processes.

* Every task gets a work dir `data/tasks/<id>/` holding `spec.json`, `task.log`
  and the worker's output files.
* A monitor thread polls children, reads progress, enforces timeouts and starts
  queued backtests when a slot is free.
* On startup, tasks left in starting/running by a previous server process are
  re-attached if their process is still alive, otherwise marked failed.
  Trading tasks are never restarted automatically.
"""

from __future__ import annotations

import csv
import json
import logging
import os
import signal
import subprocess
import sys
import threading
import time
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import psutil
from sqlalchemy import select, text
from sqlalchemy.orm import Session, sessionmaker

from backend.core.config import PROJECT_ROOT, Settings
from backend.core.logging import redact
from backend.models import BacktestResult, Strategy, SystemEvent, Task
from backend.services.broker_service import (
    AlpacaConnection,
    connection_key,
    selected_broker,
    trading_connection,
)
from backend.services.schwab_service import AUTH_REQUIRED, SchwabConnection
from backend.services.settings_store import get_setting
from backend.workers.common import (
    ALPACA_ENDPOINT_ENV,
    ALPACA_KEY_ENV,
    ALPACA_MODE_ENV,
    ALPACA_SECRET_ENV,
)

log = logging.getLogger("task_manager")

PENDING, STARTING, RUNNING = "pending", "starting", "running"
COMPLETED, FAILED, STOPPED = "completed", "failed", "stopped"
ACTIVE = (PENDING, STARTING, RUNNING)
FINISHED = (COMPLETED, FAILED, STOPPED)

STOP_GRACE_SECONDS = 30
WORKER_MODULES = {
    "backtest": "backend.workers.backtest_worker",
    "trading": "backend.workers.trading_worker",
}


class TaskError(Exception):
    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code


def aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def now() -> datetime:
    return datetime.now(UTC)


def read_progress(work_dir: Path) -> float | None:
    path = work_dir / "logs" / "progress.csv"
    try:
        with path.open(newline="") as fh:
            rows = list(csv.DictReader(fh))
    except (OSError, csv.Error):
        return None
    if not rows:
        return None
    try:
        return max(0.0, min(100.0, float(rows[-1].get("percent") or 0)))
    except ValueError:
        return None


def _pid_matches(pid: int | None, create_time: float | None) -> bool:
    if not pid:
        return False
    try:
        proc = psutil.Process(pid)
        if create_time is not None and abs(proc.create_time() - create_time) > 1:
            return False  # PID was reused by another program
        return proc.status() != psutil.STATUS_ZOMBIE
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return False


class TaskManager:
    def __init__(
        self,
        settings: Settings,
        session_factory: sessionmaker[Session],
        credentials: Callable[[Session], AlpacaConnection | None],
        python: str = sys.executable,
        poll_seconds: float = 2.0,
    ) -> None:
        self.settings = settings
        self.sessions = session_factory
        self.credentials = credentials
        self.python = python
        self.poll_seconds = poll_seconds
        self._procs: dict[str, subprocess.Popen[bytes]] = {}
        self._stop_deadlines: dict[str, float] = {}
        self._timed_out: set[str] = set()
        self._lock = threading.RLock()
        self._thread: threading.Thread | None = None
        self._shutdown = threading.Event()

    # ------------------------------------------------------------ lifecycle

    def start(self) -> None:
        self.recover()
        self._thread = threading.Thread(target=self._loop, name="task-monitor", daemon=True)
        self._thread.start()

    def shutdown(self, timeout: float = 10.0) -> None:
        """Server is exiting: stop children gracefully so nothing is orphaned."""
        self._shutdown.set()
        with self._lock:
            ids = list(self._procs)
        for task_id in ids:
            self._signal(task_id, signal.SIGINT)
        deadline = time.monotonic() + timeout
        for task_id in ids:
            proc = self._procs.get(task_id)
            if proc is None:
                continue
            try:
                proc.wait(timeout=max(0.1, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                self._signal(task_id, signal.SIGKILL)
            self._finalize(task_id, proc.returncode, reason="Stopped: server shutdown")
        if self._thread:
            self._thread.join(timeout=5)

    def recover(self) -> None:
        with self.sessions() as db:
            tasks = db.scalars(select(Task).where(Task.status.in_((STARTING, RUNNING)))).all()
            for task in tasks:
                if _pid_matches(task.pid, task.pid_create_time):
                    log.info("Re-attached to running task %s (pid %s)", task.id, task.pid)
                    continue
                task.status = FAILED
                task.ended_at = now()
                task.error_message = (
                    "Interrupted: the server restarted while this task was running."
                    + (
                        " Paper trading is not resumed automatically."
                        if task.kind == "trading"
                        else ""
                    )
                )
                db.add(
                    SystemEvent(
                        level="WARNING",
                        source="task_manager",
                        message=f"Task {task.id} marked failed after restart",
                    )
                )
            db.commit()

    # ------------------------------------------------------------ creation

    def _new_task(
        self, db: Session, strategy: Strategy, kind: str, mode: str, config: dict[str, Any]
    ) -> Task:
        task_id = uuid.uuid4().hex[:16]
        work_dir = self.settings.tasks_dir / task_id
        work_dir.mkdir(parents=True, exist_ok=False)
        task = Task(
            id=task_id,
            kind=kind,
            mode=mode,
            status=PENDING,
            strategy_id=strategy.id,
            strategy_version=strategy.version,
            strategy_name=strategy.name,
            config=config,
            work_dir=str(work_dir),
            log_path=str(work_dir / "task.log"),
        )
        db.add(task)
        db.commit()
        return task

    def create_backtest(self, db: Session, strategy: Strategy, config: dict[str, Any]) -> Task:
        with self._lock:
            dup = db.scalar(
                select(Task).where(
                    Task.kind == "backtest",
                    Task.strategy_id == strategy.id,
                    Task.status.in_(ACTIVE),
                )
            )
            if dup is not None and dup.config == config:
                raise TaskError("An identical backtest is already queued or running.", 409)
            task = self._new_task(db, strategy, "backtest", "backtest", config)
        self.tick()
        return task

    def start_trading(
        self, db: Session, strategy: Strategy, mode: str, broker: str | None = None
    ) -> Task:
        if mode == "live" and not self.settings.live_trading_enabled:
            raise TaskError("Live trading is disabled on this server.", 403)
        with self._lock:
            # Serialize credential changes with the creation of an active trading task.
            db.execute(text("BEGIN IMMEDIATE"))
            if broker is not None and selected_broker(db) != broker:
                raise TaskError("The active broker changed. Refresh the page and try again.", 409)
            creds = trading_connection(db)
            if creds is None:
                raise TaskError("Connect a broker account in Settings first.", 400)
            if mode != ("paper" if creds.paper else "live"):
                raise TaskError("Trading mode must match the connected broker account.", 409)
            if isinstance(creds, SchwabConnection) and creds.expires_at <= time.time():
                raise TaskError(AUTH_REQUIRED, 401)
            active = db.scalar(
                select(Task).where(
                    Task.kind == "trading",
                    Task.strategy_id == strategy.id,
                    Task.status.in_(ACTIVE),
                )
            )
            if active is not None:
                raise TaskError("This strategy is already running.", 409)
            config = {"parameters": strategy.parameters, "broker_key": connection_key(creds)}
            if isinstance(creds, SchwabConnection):
                config.update(broker="schwab", broker_connection=creds.id)
            task = self._new_task(db, strategy, "trading", mode, config)
            self._launch(db, task, strategy, creds if isinstance(creds, AlpacaConnection) else None)
        return task

    # ------------------------------------------------------------ control

    def stop(self, db: Session, task_id: str) -> Task:
        task = db.get(Task, task_id)
        if task is None:
            raise TaskError("Task not found.", 404)
        if task.status in FINISHED:
            return task
        if task.status == PENDING:
            task.status = STOPPED
            task.ended_at = now()
            task.error_message = "Cancelled before start."
            db.commit()
            return task
        with self._lock:
            self._stop_deadlines[task_id] = time.monotonic() + STOP_GRACE_SECONDS
        if task_id not in self._procs and not _pid_matches(task.pid, task.pid_create_time):
            self._finalize(task_id, None, reason="Stopped")
        else:
            self._signal(task_id, signal.SIGINT, pid=task.pid)
        db.refresh(task)
        return task

    def set_paused(self, db: Session, task_id: str, paused: bool) -> Task:
        task = db.get(Task, task_id)
        if task is None:
            raise TaskError("Task not found.", 404)
        if task.kind != "trading" or task.status not in (STARTING, RUNNING):
            raise TaskError("Only a running trading strategy can be paused.", 409)
        control = Path(task.work_dir) / "control.json"
        tmp = control.with_suffix(".tmp")
        tmp.write_text(json.dumps({"paused": paused, "updated": now().isoformat()}))
        tmp.replace(control)
        task.paused = paused
        db.commit()
        return task

    def stop_all_trading(self, db: Session) -> list[str]:
        ids = list(
            db.scalars(select(Task.id).where(Task.kind == "trading", Task.status.in_(ACTIVE)))
        )
        for task_id in ids:
            self.stop(db, task_id)
        return ids

    # ------------------------------------------------------------ internals

    def _signal(self, task_id: str, sig: int, pid: int | None = None) -> None:
        proc = self._procs.get(task_id)
        target = proc.pid if proc else pid
        if not target:
            return
        try:
            os.killpg(target, sig)  # worker runs in its own session/process group
        except (ProcessLookupError, PermissionError):
            try:
                os.kill(target, sig)
            except (ProcessLookupError, PermissionError):
                pass

    def _launch(
        self, db: Session, task: Task, strategy: Strategy, creds: AlpacaConnection | None = None
    ) -> None:
        from backend.services.strategy_service import StrategyError, resolve_source

        work_dir = Path(task.work_dir)
        try:
            source = resolve_source(self.settings, strategy.source_path)
        except StrategyError as exc:
            self._fail_now(db, task, exc.message)
            return
        spec = {
            "task_id": task.id,
            "kind": task.kind,
            "mode": task.mode,
            "strategy_file": str(source),
            "class_name": strategy.class_name,
            "name": strategy.name,
            **task.config,
        }
        (work_dir / "spec.json").write_text(json.dumps(spec))
        env = {
            k: v
            for k, v in os.environ.items()
            if not k.startswith(("ALPACA_", "LUMIBOT_UI_ALPACA_", "SCHWAB_"))
        }
        env["PYTHONPATH"] = str(PROJECT_ROOT)
        env["PYTHONUNBUFFERED"] = "1"
        env["LUMIBOT_UI_DATA_DIR"] = str(self.settings.data_dir.resolve())
        if task.kind == "backtest":
            creds = self.credentials(db)
        if creds:
            env[ALPACA_KEY_ENV] = creds.key
            env[ALPACA_SECRET_ENV] = creds.secret
            env[ALPACA_MODE_ENV] = "paper" if creds.paper else "live"
            env[ALPACA_ENDPOINT_ENV] = creds.endpoint
        log_file = open(task.log_path, "ab")  # noqa: SIM115 - handed to the child
        try:
            proc = subprocess.Popen(
                [self.python, "-m", WORKER_MODULES[task.kind], str(work_dir)],
                cwd=work_dir,
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=log_file,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        except OSError as exc:
            self._fail_now(db, task, f"Could not start worker: {exc}")
            return
        finally:
            log_file.close()
        with self._lock:
            self._procs[task.id] = proc
        try:
            create_time = psutil.Process(proc.pid).create_time()
        except psutil.Error:
            create_time = None
        task.pid = proc.pid
        task.pid_create_time = create_time
        task.status = STARTING
        task.started_at = now()
        db.commit()
        log.info("Started %s task %s (pid %s)", task.kind, task.id, proc.pid)

    def _fail_now(self, db: Session, task: Task, message: str) -> None:
        task.status = FAILED
        task.error_message = message
        task.ended_at = now()
        db.commit()

    def _finalize(self, task_id: str, returncode: int | None, reason: str | None = None) -> None:
        with self._lock:
            self._procs.pop(task_id, None)
            stop_requested = self._stop_deadlines.pop(task_id, None) is not None
            timed_out = task_id in self._timed_out
            self._timed_out.discard(task_id)
        with self.sessions() as db:
            task = db.get(Task, task_id)
            if task is None or task.status in FINISHED:
                return
            work_dir = Path(task.work_dir)
            task.exit_code = returncode
            task.ended_at = now()
            error = _read_error(work_dir)
            if task.kind == "backtest" and (work_dir / "result.json").exists() and not error:
                self._store_backtest(db, task, work_dir)
                task.status = COMPLETED
                task.progress = 100.0
            elif timed_out:
                task.status = FAILED
                task.error_message = error or "Timed out."
            elif stop_requested or reason:
                task.status = STOPPED
                task.error_message = reason or "Stopped by user."
            elif error:
                task.status = FAILED
                task.error_message = error
            elif task.kind == "trading" and returncode == 0:
                task.status = STOPPED
                task.error_message = "Strategy exited."
            else:
                task.status = FAILED
                task.error_message = (
                    f"Worker exited with code {returncode}. See the task log."
                    if returncode is not None
                    else "Worker exited while the server was not watching it."
                )
            db.commit()
            log.info("Task %s finished: %s", task_id, task.status)

    def _store_backtest(self, db: Session, task: Task, work_dir: Path) -> None:
        data = json.loads((work_dir / "result.json").read_text())
        row = db.get(BacktestResult, task.id)
        if row is None:
            row = BacktestResult(task_id=task.id)
            db.add(row)
        row.metrics = data.get("metrics", {})
        row.files = data.get("files", {})

    def tick(self) -> None:
        """One monitor pass. Safe to call from any thread."""
        with self._lock:
            procs = dict(self._procs)
        for task_id, proc in procs.items():
            code = proc.poll()
            if code is not None:
                self._finalize(task_id, code)
            elif (
                task_id in self._stop_deadlines and time.monotonic() > self._stop_deadlines[task_id]
            ):
                log.warning("Task %s ignored stop signal, killing", task_id)
                self._signal(task_id, signal.SIGKILL)

        with self.sessions() as db:
            timeout_min = int(get_setting(db, "backtest_timeout_minutes") or 0)
            live = db.scalars(select(Task).where(Task.status.in_((STARTING, RUNNING)))).all()
            for task in live:
                if task.id not in self._procs:
                    # Re-attached task from a previous server run: we only have its pid.
                    if not _pid_matches(task.pid, task.pid_create_time):
                        self._finalize(task.id, None)
                        continue
                    if (
                        task.id in self._stop_deadlines
                        and time.monotonic() > self._stop_deadlines[task.id]
                    ):
                        self._signal(task.id, signal.SIGKILL, pid=task.pid)
                work_dir = Path(task.work_dir)
                if task.kind == "backtest":
                    progress = read_progress(work_dir)
                    if progress is not None:
                        task.progress = progress
                    started = aware(task.started_at)
                    if (
                        timeout_min
                        and started
                        and (now() - started).total_seconds() > timeout_min * 60
                        and task.id not in self._stop_deadlines
                    ):
                        log.warning("Backtest %s timed out after %s min", task.id, timeout_min)
                        self._timed_out.add(task.id)
                        _write_error_file(work_dir, f"Timed out after {timeout_min} minutes.")
                        self.stop(db, task.id)
                        refreshed = db.get(Task, task.id)
                        if refreshed is None or refreshed.status in FINISHED:
                            continue
                        task = refreshed
                if task.status == STARTING:
                    started = aware(task.started_at)
                    ready = (work_dir / "heartbeat.json").exists() or task.progress is not None
                    if ready or (started and (now() - started).total_seconds() > 5):
                        task.status = RUNNING
            db.commit()
            self._start_pending(db)

    def _start_pending(self, db: Session) -> None:
        if self._shutdown.is_set():
            return
        limit = max(1, int(get_setting(db, "max_concurrent_backtests") or 1))
        with self._lock:
            running_count = len(
                db.scalars(
                    select(Task.id).where(
                        Task.kind == "backtest", Task.status.in_((STARTING, RUNNING))
                    )
                ).all()
            )
            free = limit - running_count
            if free <= 0:
                return
            pending = db.scalars(
                select(Task)
                .where(Task.kind == "backtest", Task.status == PENDING)
                .order_by(Task.created_at)
                .limit(free)
            ).all()
            for task in pending:
                strategy = db.get(Strategy, task.strategy_id) if task.strategy_id else None
                if strategy is None:
                    self._fail_now(db, task, "Strategy was deleted.")
                    continue
                self._launch(db, task, strategy)

    def _loop(self) -> None:
        while not self._shutdown.wait(self.poll_seconds):
            try:
                self.tick()
            except Exception:  # noqa: BLE001 - the monitor must keep running
                log.exception("Task monitor pass failed")


def _read_error(work_dir: Path) -> str | None:
    path = work_dir / "error.json"
    if not path.exists():
        return None
    try:
        return redact(str(json.loads(path.read_text()).get("error") or "Unknown error"))[:2000]
    except (json.JSONDecodeError, OSError):
        return "Worker failed (unreadable error file)."


def _write_error_file(work_dir: Path, message: str) -> None:
    path = work_dir / "error.json"
    if not path.exists():
        path.write_text(json.dumps({"error": message}))

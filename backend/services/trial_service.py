"""Trial runs: a short real backtest of strategy code before it is saved.

A trial runs the normal backtest worker on the last month of daily Yahoo data in
a scratch folder under `data/trials/`. Its environment holds no broker
credentials. The result is a short summary, or the error with the line of the
user's file it came from and a plain explanation code the UI turns into advice.
One trial runs at a time; the folder is deleted afterwards.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from backend.core.config import Settings
from backend.core.logging import redact
from backend.services import task_manager
from backend.services.strategy_service import StrategyError

TRIAL_DAYS = 30
TRIAL_TIMEOUT_SECONDS = 120
STALE_SECONDS = 3600
LOG_TAIL_LINES = 40
TRACEBACK_TAIL_LINES = 30

_lock = threading.Lock()

NETWORK_ERRORS = re.compile(
    r"ConnectionError|Max retries exceeded|Failed to resolve|Temporary failure in name "
    r"resolution|Name or service not known|nodename nor servname|Network is unreachable|"
    r"YFRateLimitError|Too Many Requests|Rate limited|SSLError|ReadTimeout|ConnectTimeout",
    re.IGNORECASE,
)
BROKER_AUTH = re.compile(r"unauthori[sz]ed|forbidden|\b40[13]\b|invalid api key", re.IGNORECASE)
INITIALIZE_ARGUMENT = re.compile(
    r"initialize\(\) missing \d+ required positional arguments?: '(\w+)'"
)


def trial_window(today: datetime | None = None) -> tuple[str, str]:
    end = (today or datetime.now(UTC)).date() - timedelta(days=1)
    return (end - timedelta(days=TRIAL_DAYS)).isoformat(), end.isoformat()


def _frames(traceback: str, strategy_file: str) -> list[tuple[int, str]]:
    """(line, source text) of each traceback frame inside the user's file."""
    frames: list[tuple[int, str]] = []
    lines = traceback.splitlines()
    for index, text in enumerate(lines):
        match = re.match(r'\s*File "(.+)", line (\d+)', text)
        if match and match.group(1) == strategy_file:
            source = lines[index + 1].strip() if index + 1 < len(lines) else ""
            frames.append((int(match.group(2)), source))
    return frames


def explain(error: str, traceback: str, strategy_file: str) -> dict[str, Any]:
    """Classify a worker error so the UI can say what to change, in the user's language."""
    frames = _frames(traceback, strategy_file)
    line, source = frames[-1] if frames else (None, "")
    kind, _, message = error.partition(": ")

    def hint(code: str, **params: Any) -> dict[str, Any]:
        return {"code": code, "params": params, "line": line}

    if match := re.search(r"No module named '([^']+)'", error):
        return hint("missing_module", module=match.group(1))
    if match := INITIALIZE_ARGUMENT.search(error):
        return hint("missing_parameter", name=match.group(1))
    if kind == "KeyError" and (match := re.fullmatch(r"'(\w+)'", message.strip())):
        if "param" in source.lower():  # self.parameters["x"], params["x"], ...
            return hint("missing_parameter", name=match.group(1))
        return hint("key_error", key=match.group(1))
    if kind == "NameError" and (match := re.search(r"name '(\w+)' is not defined", message)):
        return hint("name_error", name=match.group(1))
    if kind == "AttributeError" and "'NoneType' object has no attribute" in message:
        return hint("no_data")
    if NETWORK_ERRORS.search(error) or NETWORK_ERRORS.search(traceback[-3000:]):
        return hint("data_download")
    if BROKER_AUTH.search(error) and line is not None:
        return hint("broker_auth")
    return hint("generic", error=error)


def _tail(path: Path, lines: int) -> str:
    try:
        text = path.read_text("utf-8", errors="replace")
    except OSError:
        return ""
    return redact("\n".join(text.splitlines()[-lines:]))


def _clean_stale(root: Path) -> None:
    if not root.is_dir():
        return
    cutoff = time.time() - STALE_SECONDS
    for child in root.iterdir():
        try:
            if child.is_dir() and child.stat().st_mtime < cutoff:
                shutil.rmtree(child, ignore_errors=True)
        except OSError:
            continue


def _kill(proc: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(proc.pid, signal.SIGKILL)  # the worker runs in its own process group
    except (ProcessLookupError, PermissionError):
        proc.kill()
    proc.wait()


def run_trial(
    settings: Settings,
    code: str,
    class_name: str,
    parameters: dict[str, Any],
    *,
    budget: float = 100_000.0,
    python: str = sys.executable,
) -> dict[str, Any]:
    if not _lock.acquire(blocking=False):
        raise StrategyError("A trial run is already in progress. Wait for it to finish.", 409)
    root = settings.data_dir.resolve() / "trials"
    work = root / uuid.uuid4().hex[:12]
    try:
        _clean_stale(root)
        work.mkdir(parents=True)
        strategy_file = work / "strategy.py"
        strategy_file.write_text(code, "utf-8")
        start, end = trial_window()
        spec = {
            "task_id": f"trial-{work.name}",
            "kind": "backtest",
            "data_source": "yahoo",
            "strategy_file": str(strategy_file),
            "class_name": class_name,
            "name": class_name,
            "start": start,
            "end": end,
            "budget": budget,
            "benchmark": None,
            "parameters": parameters,
        }
        (work / "spec.json").write_text(json.dumps(spec))
        log_path = work / "task.log"
        started = time.monotonic()
        with log_path.open("ab") as log_file:
            proc = subprocess.Popen(
                [python, "-m", task_manager.WORKER_MODULES["backtest"], str(work)],
                cwd=work,
                env=task_manager.worker_env(settings),
                stdin=subprocess.DEVNULL,
                stdout=log_file,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        try:
            proc.wait(timeout=TRIAL_TIMEOUT_SECONDS)
            timed_out = False
        except subprocess.TimeoutExpired:
            _kill(proc)
            timed_out = True
        report: dict[str, Any] = {
            "start": start,
            "end": end,
            "seconds": round(time.monotonic() - started, 1),
            "log": _tail(log_path, LOG_TAIL_LINES),
        }
        result_path, error_path = work / "result.json", work / "error.json"
        if timed_out:
            hint = {"code": "timeout", "params": {"seconds": TRIAL_TIMEOUT_SECONDS}, "line": None}
            return {**report, "ok": False, "error": "Timed out.", "hint": hint}
        if error_path.exists() or not result_path.exists():
            try:
                failure = json.loads(error_path.read_text())
            except (OSError, json.JSONDecodeError):
                failure = {"error": f"Worker exited with code {proc.returncode}."}
            error = redact(str(failure.get("error") or "Unknown error"))[:2000]
            traceback = redact(str(failure.get("traceback") or ""))
            return {
                **report,
                "ok": False,
                "error": error,
                "traceback": "\n".join(traceback.splitlines()[-TRACEBACK_TAIL_LINES:]),
                "hint": explain(error, traceback, str(strategy_file)),
            }
        result = json.loads(result_path.read_text())
        metrics = result.get("metrics") or {}
        return {
            **report,
            "ok": True,
            "days": len(result.get("equity_curve") or []),
            "trades": len(result.get("trades") or []),
            "total_return": metrics.get("total_return"),
        }
    finally:
        shutil.rmtree(work, ignore_errors=True)
        _lock.release()

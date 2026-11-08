"""Read and filter log files. Paths are always derived server-side."""

from __future__ import annotations

import re
from collections import deque
from dataclasses import dataclass
from pathlib import Path

from backend.core.config import Settings
from backend.core.logging import redact

LEVELS = ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL")
_LEVEL_RANK = {name: i for i, name in enumerate(LEVELS)}
_LINE = re.compile(
    r"^(?P<time>\d{4}-\d{2}-\d{2}[ T][\d:,.]+(?:[+-]\d{2}:?\d{2})?)\s*\|\s*"
    r"(?P<level>DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL)\s*\|\s*(?P<rest>.*)$"
)
MAX_SCAN_LINES = 200_000


@dataclass
class LogEntry:
    time: str | None
    level: str
    logger: str
    message: str


def _parse(lines: list[str]) -> list[LogEntry]:
    entries: list[LogEntry] = []
    for raw in lines:
        line = raw.rstrip("\n")
        if not line:
            continue
        m = _LINE.match(line)
        if m:
            level = "WARNING" if m["level"] == "WARN" else m["level"]
            rest = m["rest"]
            logger, sep, message = rest.partition(" | ")
            if not sep:
                logger, message = "", rest
            entries.append(LogEntry(m["time"], level, logger.strip(), message))
        elif entries:
            # Continuation line (traceback, multi-line message).
            entries[-1].message += "\n" + line
        else:
            entries.append(LogEntry(None, "INFO", "", line))
    return entries


def read_entries(
    path: Path,
    *,
    min_level: str | None = None,
    search: str | None = None,
    logger_prefix: str | None = None,
    limit: int = 500,
) -> list[LogEntry]:
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8", errors="replace") as fh:
        tail = list(deque(fh, maxlen=MAX_SCAN_LINES))
    entries = _parse(tail)
    rank = _LEVEL_RANK.get((min_level or "").upper(), 0)
    needle = (search or "").lower()
    out = [
        e
        for e in entries
        if _LEVEL_RANK.get(e.level, 1) >= rank
        and (not needle or needle in e.message.lower() or needle in e.logger.lower())
        and (not logger_prefix or e.logger.startswith(logger_prefix))
    ]
    for e in out:
        e.message = redact(e.message)
    return out[-limit:]


def system_log_path(settings: Settings) -> Path:
    return settings.logs_dir / "system.log"

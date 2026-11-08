"""Logging setup with secret redaction.

Log line format is shared with LumiBot (`time | LEVEL | message`) so one parser
can read system logs and worker logs.
"""

from __future__ import annotations

import logging
import logging.handlers
import threading
from pathlib import Path

LOG_FORMAT = "%(asctime)s | %(levelname)s | %(name)s | %(message)s"

_redact_lock = threading.Lock()
_redact_values: set[str] = set()


def register_secret(value: str | None) -> None:
    """Make sure `value` never appears in any log line written by this process."""
    if value and len(value) >= 6:
        with _redact_lock:
            _redact_values.add(value)


def redact(text: str) -> str:
    with _redact_lock:
        values = list(_redact_values)
    for value in values:
        if value in text:
            text = text.replace(value, "***REDACTED***")
    return text


class RedactingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        cleaned = redact(message)
        if cleaned != message:
            record.msg = cleaned
            record.args = None
        return True


def setup_logging(logs_dir: Path, level: str = "INFO") -> None:
    logs_dir.mkdir(parents=True, exist_ok=True)
    root = logging.getLogger()
    root.setLevel(level.upper())
    for handler in list(root.handlers):
        if getattr(handler, "_lumibot_ui", False):
            root.removeHandler(handler)

    formatter = logging.Formatter(LOG_FORMAT)
    redactor = RedactingFilter()

    file_handler = logging.handlers.RotatingFileHandler(
        logs_dir / "system.log", maxBytes=5 * 1024 * 1024, backupCount=5, encoding="utf-8"
    )
    stream_handler = logging.StreamHandler()
    for handler in (file_handler, stream_handler):
        handler.setFormatter(formatter)
        handler.addFilter(redactor)
        handler._lumibot_ui = True  # type: ignore[attr-defined]
        root.addHandler(handler)

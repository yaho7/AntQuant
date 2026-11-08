from __future__ import annotations

from pathlib import Path

import pytest

from backend.core.logging import redact, register_secret
from backend.services.log_service import read_entries
from backend.workers.trading_worker import order_increases_exposure


@pytest.mark.parametrize(
    ("side", "qty", "expected"),
    [
        ("buy", 0, True),
        ("buy", 10, True),
        ("buy", -5, False),  # covering a short
        ("sell", 10, False),  # reducing a long
        ("sell", 0, True),  # opening a short
        ("sell_short", 10, True),
        ("buy_to_open", -1, True),
        ("sell_to_close", 1, False),
        ("buy_to_cover", -1, False),
        ("weird", 1, True),
    ],
)
def test_pause_order_filter(side: str, qty: float, expected: bool) -> None:
    assert order_increases_exposure(side, qty) is expected


def test_redact() -> None:
    register_secret("abcdef123456")
    assert redact("key=abcdef123456!") == "key=***REDACTED***!"


def test_log_parsing(tmp_path: Path) -> None:
    log = tmp_path / "t.log"
    log.write_text(
        "2026-01-01 10:00:00,000 | INFO | system | started\n"
        "2026-01-01 10:00:01,000 | ERROR | api | failed call\n"
        "Traceback (most recent call last):\n"
        "  boom\n"
        "2026-01-01 10:00:02,000 | WARNING | trading_worker | PAUSED: rejected buy\n"
        "plain print line\n"
    )
    entries = read_entries(log)
    assert len(entries) == 3
    assert "Traceback" in entries[1].message
    assert [e.level for e in read_entries(log, min_level="WARNING")] == ["ERROR", "WARNING"]
    assert len(read_entries(log, search="paused")) == 1
    assert len(read_entries(log, logger_prefix="api")) == 1

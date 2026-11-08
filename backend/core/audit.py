from __future__ import annotations

import logging
from typing import Any

from sqlalchemy.orm import Session

from backend.models import AuditLog, SystemEvent

log = logging.getLogger("audit")


def audit(
    db: Session,
    action: str,
    target: str = "",
    detail: dict[str, Any] | None = None,
    ip: str = "",
    success: bool = True,
) -> None:
    db.add(AuditLog(action=action, target=target, detail=detail or {}, ip=ip, success=success))
    db.commit()
    log.info("%s target=%s success=%s", action, target, success)


def system_event(db: Session, message: str, level: str = "INFO", source: str = "system") -> None:
    db.add(SystemEvent(message=message, level=level, source=source))
    db.commit()
    logging.getLogger(source).log(logging.getLevelName(level), message)

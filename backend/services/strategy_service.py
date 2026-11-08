"""Strategy files, registration and versioning."""

from __future__ import annotations

import hashlib
import re
import uuid
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.adapters.lumibot_adapter import (
    DiscoveredStrategy,
    discover_strategies,
    parse_strategy_file,
)
from backend.core.config import Settings
from backend.models import Strategy, StrategyVersion

MAX_UPLOAD_BYTES = 512 * 1024
_SAFE_NAME = re.compile(r"[^A-Za-z0-9_\-]")


class StrategyError(Exception):
    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code


def strategy_roots(settings: Settings) -> dict[str, Path]:
    return {"examples": settings.examples_dir, "user": settings.strategies_dir}


def resolve_source(settings: Settings, source_path: str) -> Path:
    """Map "root/relative.py" to an absolute file inside that root. Blocks traversal."""
    root_label, _, rel = source_path.partition("/")
    roots = strategy_roots(settings)
    if root_label not in roots or not rel:
        raise StrategyError("Unknown strategy location.")
    root = roots[root_label].resolve()
    target = (root / rel).resolve()
    if not target.is_relative_to(root) or target.suffix != ".py":
        raise StrategyError("Strategy path is outside the strategy folder.")
    if not target.is_file():
        raise StrategyError("Strategy file not found.", 404)
    return target


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def discover(settings: Settings) -> list[DiscoveredStrategy]:
    return discover_strategies(strategy_roots(settings))


def _find_class(settings: Settings, source_path: str, class_name: str) -> DiscoveredStrategy:
    path = resolve_source(settings, source_path)
    root_label, _, rel = source_path.partition("/")
    for item in parse_strategy_file(path, root_label, rel):
        if item.class_name == class_name:
            return item
    raise StrategyError(f"Class {class_name} (a LumiBot Strategy subclass) not found in file.")


def _snapshot(db: Session, strategy: Strategy, sha: str, note: str) -> None:
    db.add(
        StrategyVersion(
            strategy_id=strategy.id,
            version=strategy.version,
            name=strategy.name,
            description=strategy.description,
            parameters=strategy.parameters,
            source_path=strategy.source_path,
            class_name=strategy.class_name,
            code_sha256=sha,
            note=note,
        )
    )


def create_strategy(
    db: Session,
    settings: Settings,
    *,
    name: str,
    description: str,
    source_path: str,
    class_name: str,
    parameters: dict[str, Any] | None,
) -> Strategy:
    found = _find_class(settings, source_path, class_name)
    if db.scalar(select(Strategy).where(Strategy.name == name)) is not None:
        raise StrategyError("A strategy with this name already exists.", 409)
    strategy = Strategy(
        name=name,
        description=description,
        source_path=source_path,
        class_name=class_name,
        parameters=parameters if parameters is not None else found.parameters,
        version=1,
    )
    db.add(strategy)
    db.flush()
    _snapshot(db, strategy, found.sha256, "Created")
    db.commit()
    db.refresh(strategy)
    return strategy


def update_strategy(
    db: Session,
    settings: Settings,
    strategy: Strategy,
    *,
    name: str | None = None,
    description: str | None = None,
    parameters: dict[str, Any] | None = None,
    note: str = "",
) -> Strategy:
    if name and name != strategy.name:
        if db.scalar(select(Strategy).where(Strategy.name == name)) is not None:
            raise StrategyError("A strategy with this name already exists.", 409)
        strategy.name = name
    if description is not None:
        strategy.description = description
    if parameters is not None:
        strategy.parameters = parameters
    path = resolve_source(settings, strategy.source_path)
    strategy.version += 1
    _snapshot(db, strategy, file_sha256(path), note or "Updated")
    db.commit()
    db.refresh(strategy)
    return strategy


def save_upload(settings: Settings, filename: str, content: bytes) -> list[DiscoveredStrategy]:
    """Store an uploaded .py file under user/uploads/ and return its strategy classes."""
    if not filename.endswith(".py"):
        raise StrategyError("Only .py files are accepted.")
    if len(content) > MAX_UPLOAD_BYTES:
        raise StrategyError("File is larger than 512 KB.")
    try:
        content.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise StrategyError("File must be UTF-8 text.") from exc
    stem = _SAFE_NAME.sub("_", Path(filename).stem)[:60] or "strategy"
    upload_dir = settings.strategies_dir / "uploads"
    upload_dir.mkdir(parents=True, exist_ok=True)
    target = upload_dir / f"{stem}_{uuid.uuid4().hex[:8]}.py"
    target.write_bytes(content)
    rel = target.relative_to(settings.strategies_dir).as_posix()
    found = parse_strategy_file(target, "user", rel)
    if not found:
        target.unlink()
        raise StrategyError(
            "No LumiBot Strategy subclass found. The file needs `class X(Strategy):`."
        )
    return found

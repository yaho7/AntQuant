"""Strategy files, registration and versioning."""

from __future__ import annotations

import hashlib
import re
import tempfile
import uuid
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.adapters.lumibot_adapter import (
    DiscoveredStrategy,
    discover_strategies,
    parse_strategy_source,
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


class StrategySyntaxError(StrategyError):
    def __init__(self, exc: SyntaxError) -> None:
        super().__init__("Python syntax error.")
        self.line = exc.lineno
        self.reason = exc.msg


def strategy_roots(settings: Settings) -> dict[str, Path]:
    return {"examples": settings.examples_dir, "user": settings.strategies_dir}


def resolve_source(settings: Settings, source_path: str, *, must_exist: bool = True) -> Path:
    """Map "root/relative.py" to an absolute file inside that root. Blocks traversal."""
    root_label, _, rel = source_path.partition("/")
    roots = strategy_roots(settings)
    if root_label not in roots or not rel:
        raise StrategyError("Unknown strategy location.")
    root = roots[root_label].resolve()
    target = (root / rel).resolve()
    if not target.is_relative_to(root) or target.suffix != ".py":
        raise StrategyError("Strategy path is outside the strategy folder.")
    if must_exist and not target.is_file():
        raise StrategyError("Strategy file not found.", 404)
    return target


def discover(settings: Settings) -> list[DiscoveredStrategy]:
    return discover_strategies(strategy_roots(settings))


def _find_class(found: list[DiscoveredStrategy], class_name: str) -> DiscoveredStrategy:
    for item in reversed(found):
        if item.class_name == class_name:
            return item
    raise StrategyError(f"Class {class_name} (a LumiBot Strategy subclass) not found in file.")


def get_version(db: Session, strategy_id: int, version: int) -> StrategyVersion | None:
    return db.scalar(
        select(StrategyVersion).where(
            StrategyVersion.strategy_id == strategy_id, StrategyVersion.version == version
        )
    )


def _code_path(settings: Settings, sha: str) -> Path:
    return settings.data_dir.resolve() / "strategy-versions" / f"{sha}.py"


def _store_code(settings: Settings, content: bytes) -> tuple[str, Path]:
    sha = hashlib.sha256(content).hexdigest()
    path = _code_path(settings, sha)
    if path.is_file() and path.read_bytes() == content:
        return sha, path
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as tmp:
        pending = Path(tmp.name)
        try:
            tmp.write(content)
            tmp.close()
            pending.replace(path)
        finally:
            pending.unlink(missing_ok=True)
    return sha, path


def version_code(settings: Settings, version: StrategyVersion) -> bytes | None:
    sha = version.code_sha256
    if not re.fullmatch(r"[0-9a-f]{64}", sha):
        return None
    snapshot = _code_path(settings, sha)
    if snapshot.is_file():
        code = snapshot.read_bytes()
        if hashlib.sha256(code).hexdigest() == sha:
            return code
    try:
        original = resolve_source(settings, version.source_path).read_bytes()
    except (StrategyError, FileNotFoundError):
        return None
    return original if hashlib.sha256(original).hexdigest() == sha else None


def editable_source(source_path: str) -> bool:
    parts = Path(source_path).parts
    return len(parts) == 3 and parts[:2] == ("user", "uploads") and parts[2].endswith(".py")


def current_code(db: Session, settings: Settings, strategy: Strategy) -> bytes:
    version = get_version(db, strategy.id, strategy.version)
    if version is not None:
        code = version_code(settings, version)
        if code is not None:
            return code
    return resolve_source(settings, strategy.source_path).read_bytes()


def run_source(
    db: Session, settings: Settings, strategy_id: int, version: int
) -> tuple[Path, Path, str]:
    snap = get_version(db, strategy_id, version)
    code = version_code(settings, snap) if snap is not None else None
    if snap is None or code is None:
        raise StrategyError("Strategy code for this version is unavailable. Save a new version.")
    source = resolve_source(settings, snap.source_path, must_exist=False)
    _, snapshot = _store_code(settings, code)
    return source, snapshot, snap.class_name


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
    path = resolve_source(settings, source_path)
    content = path.read_bytes()
    root_label, _, rel = source_path.partition("/")
    try:
        classes = parse_strategy_source(content, root_label, rel)
    except SyntaxError as exc:
        raise StrategySyntaxError(exc) from exc
    found = _find_class(classes, class_name)
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
    sha, _ = _store_code(settings, content)
    _snapshot(db, strategy, sha, "Created")
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
    content: bytes | None = None,
    class_name: str | None = None,
    source_path: str | None = None,
) -> Strategy:
    if content is None:
        if editable_source(strategy.source_path):
            content = current_code(db, settings, strategy)
        else:
            content = resolve_source(settings, strategy.source_path).read_bytes()
    sha, _ = _store_code(settings, content)
    if name and name != strategy.name:
        if db.scalar(select(Strategy).where(Strategy.name == name)) is not None:
            raise StrategyError("A strategy with this name already exists.", 409)
        strategy.name = name
    if description is not None:
        strategy.description = description
    if parameters is not None:
        strategy.parameters = parameters
    if class_name is not None:
        strategy.class_name = class_name
    if source_path is not None:
        strategy.source_path = source_path
    strategy.version += 1
    _snapshot(db, strategy, sha, note or "Updated")
    db.commit()
    db.refresh(strategy)
    return strategy


def scan_code(filename: str, content: bytes) -> list[DiscoveredStrategy]:
    if not filename.endswith(".py"):
        raise StrategyError("Only .py files are accepted.")
    if len(content) > MAX_UPLOAD_BYTES:
        raise StrategyError("File is larger than 512 KB.")
    try:
        content.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise StrategyError("File must be UTF-8 text.") from exc
    try:
        found = parse_strategy_source(content, "user", Path(filename).name)
    except SyntaxError as exc:
        raise StrategySyntaxError(exc) from exc
    if not found:
        raise StrategyError(
            "No LumiBot Strategy subclass found. The file needs `class X(Strategy):`."
        )
    return found


def save_upload(settings: Settings, filename: str, content: bytes) -> list[DiscoveredStrategy]:
    """Store an uploaded .py file under user/uploads/ and return its strategy classes."""
    found = scan_code(filename, content)
    stem = _SAFE_NAME.sub("_", Path(filename).stem)[:60] or "strategy"
    upload_dir = settings.strategies_dir / "uploads"
    upload_dir.mkdir(parents=True, exist_ok=True)
    target = upload_dir / f"{stem}_{uuid.uuid4().hex[:8]}.py"
    target.write_bytes(content)
    rel = target.relative_to(settings.strategies_dir).as_posix()
    for item in found:
        item.file = rel
    return found

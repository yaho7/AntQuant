"""The single place that knows about LumiBot.

The web process never imports LumiBot (it is large and slow to import). This
module only:

* reads the installed version from package metadata,
* discovers strategy classes by *parsing* Python files (no code execution),
* describes how a worker subprocess should call LumiBot,
* runs a compatibility probe in a subprocess.

The worker modules in `backend.workers` are the only code that imports LumiBot.
Anything tied to a LumiBot release lives here or there.
"""

from __future__ import annotations

import ast
import hashlib
import json
import subprocess
import sys
import threading
from dataclasses import asdict, dataclass, field
from importlib import metadata
from pathlib import Path
from typing import Any

from backend.core.config import PROJECT_ROOT

# Versions this release has been tested against (CI runs the compat probe).
VERIFIED_LUMIBOT_VERSIONS = ("4.6.48",)


@dataclass(frozen=True)
class DataSourceInfo:
    id: str
    label: str
    lumibot_class: str
    requires_alpaca_keys: bool
    note: str


# Backtesting data sources exposed in the UI. The class names are imported from
# `lumibot.backtesting` inside the worker.
DATA_SOURCES: dict[str, DataSourceInfo] = {
    "yahoo": DataSourceInfo(
        id="yahoo",
        label="Yahoo Finance",
        lumibot_class="YahooDataBacktesting",
        requires_alpaca_keys=False,
        note="Free daily bars for stocks and ETFs. No API key needed.",
    ),
    "alpaca": DataSourceInfo(
        id="alpaca",
        label="Alpaca Market Data",
        lumibot_class="AlpacaBacktesting",
        requires_alpaca_keys=True,
        note="Uses your Alpaca paper keys. Free plans have limited history.",
    ),
}


def lumibot_version() -> str | None:
    try:
        return metadata.version("lumibot")
    except metadata.PackageNotFoundError:
        return None


def is_verified_version(version: str | None) -> bool:
    return version in VERIFIED_LUMIBOT_VERSIONS


# ---------------------------------------------------------------- discovery


@dataclass
class DiscoveredStrategy:
    file: str  # path relative to its strategy root, posix style
    root: str  # "examples" | "user"
    class_name: str
    docstring: str
    parameters: dict[str, Any] = field(default_factory=dict)
    parameters_parsed: bool = True
    sha256: str = ""

    @property
    def source_path(self) -> str:
        return f"{self.root}/{self.file}"

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["source_path"] = self.source_path
        return data


def _base_name(node: ast.expr) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return ""


def parse_strategy_file(path: Path, root_label: str, rel: str) -> list[DiscoveredStrategy]:
    """Find `class X(Strategy)` definitions in a file without importing it."""
    raw = path.read_bytes()
    try:
        tree = ast.parse(raw, filename=str(path))
    except SyntaxError:
        return []
    digest = hashlib.sha256(raw).hexdigest()
    found: list[DiscoveredStrategy] = []
    for node in tree.body:
        if not isinstance(node, ast.ClassDef):
            continue
        if "Strategy" not in {_base_name(b) for b in node.bases}:
            continue
        params: dict[str, Any] = {}
        parsed = True
        for stmt in node.body:
            if isinstance(stmt, ast.Assign) and any(
                isinstance(t, ast.Name) and t.id == "parameters" for t in stmt.targets
            ):
                try:
                    value = ast.literal_eval(stmt.value)
                    params = value if isinstance(value, dict) else {}
                except ValueError:
                    parsed = False
        found.append(
            DiscoveredStrategy(
                file=rel,
                root=root_label,
                class_name=node.name,
                docstring=(ast.get_docstring(node) or "").strip(),
                parameters=params,
                parameters_parsed=parsed,
                sha256=digest,
            )
        )
    return found


def discover_strategies(roots: dict[str, Path]) -> list[DiscoveredStrategy]:
    results: list[DiscoveredStrategy] = []
    for label, root in roots.items():
        if not root.is_dir():
            continue
        for path in sorted(root.rglob("*.py")):
            if path.name.startswith("_") or any(p.startswith(".") for p in path.parts):
                continue
            rel = path.relative_to(root).as_posix()
            results.extend(parse_strategy_file(path, label, rel))
    return results


# ---------------------------------------------------------------- compat probe

_compat_cache: dict[str, Any] | None = None
_compat_lock = threading.Lock()


def compatibility_report(refresh: bool = False, timeout: float = 120) -> dict[str, Any]:
    """Run `backend.workers.compat` in a subprocess and cache its JSON report."""
    global _compat_cache
    with _compat_lock:
        if _compat_cache is not None and not refresh:
            return _compat_cache
        try:
            proc = subprocess.run(
                [sys.executable, "-m", "backend.workers.compat"],
                cwd=PROJECT_ROOT,
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
            )
            lines = [ln for ln in proc.stdout.splitlines() if ln.startswith("{")]
            report = (
                json.loads(lines[-1])
                if lines
                else {
                    "ok": False,
                    "checks": [],
                    "error": (proc.stderr or "compat probe produced no output")[-2000:],
                }
            )
        except (subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
            report = {"ok": False, "checks": [], "error": str(exc)}
        version = lumibot_version()
        report["version"] = version
        report["verified"] = is_verified_version(version)
        report["verified_versions"] = list(VERIFIED_LUMIBOT_VERSIONS)
        _compat_cache = report
        return report

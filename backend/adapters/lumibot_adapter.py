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
        note="Uses your Alpaca keys. Free plans have limited history.",
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
    # Where defaults came from: {"kind": "class" | "initialize" | "get" | "call", "line": n}
    parameter_sources: list[dict[str, Any]] = field(default_factory=list)
    # Names whose default is not a plain value (for example `Asset("SPY")`).
    unread_parameters: list[str] = field(default_factory=list)
    # Names the code reads without any default: {"name": str, "line": n}
    missing_parameters: list[dict[str, Any]] = field(default_factory=list)

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


# --------------------------------------------------------------- parameters
#
# LumiBot builds `self.parameters` from the class-level `parameters` dict plus
# whatever the run passes in (`parameters=...` or extra keyword arguments), and
# passes matching entries to `initialize(...)` by name. Scripts written for
# LumiBot often keep their defaults in the run call under
# `if __name__ == "__main__":`, which AntQuant never executes, so read all of
# these places.

RUN_METHODS = frozenset({"backtest", "run_backtest"})


def _literal(node: ast.expr) -> tuple[bool, Any]:
    try:
        value = ast.literal_eval(node)
        return True, json.loads(json.dumps(value, allow_nan=False))
    except (ValueError, TypeError, SyntaxError, MemoryError, RecursionError):
        return False, None


def _dict_items(node: ast.expr | None) -> tuple[dict[str, Any], list[str], bool]:
    """Read a dict display key by key: (plain values, unread names, fully read)."""
    if not isinstance(node, ast.Dict):
        return {}, [], False
    values: dict[str, Any] = {}
    unread: list[str] = []
    complete = True
    for key, value in zip(node.keys, node.values, strict=True):
        if not (isinstance(key, ast.Constant) and isinstance(key.value, str)):
            complete = False  # `**other` or a non-string key
            continue
        ok, parsed = _literal(value)
        if ok and key.value.isidentifier():
            values[key.value] = parsed
        else:
            unread.append(key.value)
    return values, unread, complete and not unread


def _assignments(tree: ast.AST) -> dict[str, list[tuple[int, ast.expr]]]:
    """Simple `name = value` assignments anywhere in the module, by name."""
    found: dict[str, list[tuple[int, ast.expr]]] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and len(node.targets) == 1:
            target, value = node.targets[0], node.value
        elif isinstance(node, ast.AnnAssign) and node.value is not None:
            target, value = node.target, node.value
        else:
            continue
        if isinstance(target, ast.Name):
            found.setdefault(target.id, []).append((node.lineno, value))
    return found


def _resolve(
    node: ast.expr | None, names: dict[str, list[tuple[int, ast.expr]]], before: int
) -> ast.expr | None:
    """Follow `parameters=params` to the latest `params = {...}` above it."""
    if isinstance(node, ast.Name):
        earlier = [value for line, value in names.get(node.id, []) if line < before]
        return earlier[-1] if earlier else node
    return node


def _is_parameters(node: ast.expr, aliases: set[str]) -> bool:
    if isinstance(node, ast.Name):
        return node.id in aliases
    return (
        isinstance(node, ast.Attribute)
        and node.attr == "parameters"
        and isinstance(node.value, ast.Name)
        and node.value.id == "self"
    )


def _parameter_reads(
    cls: ast.ClassDef,
) -> tuple[dict[str, int], dict[str, tuple[int, Any]], set[str]]:
    """Keys read as self.parameters["x"], defaults from .get("x", d), keys assigned."""
    required: dict[str, int] = {}
    defaults: dict[str, tuple[int, Any]] = {}
    assigned: set[str] = set()
    for func in cls.body:
        if not isinstance(func, ast.FunctionDef | ast.AsyncFunctionDef):
            continue
        aliases = {
            target.id
            for node in ast.walk(func)
            if isinstance(node, ast.Assign) and _is_parameters(node.value, set())
            for target in node.targets
            if isinstance(target, ast.Name)
        }
        for node in ast.walk(func):
            if isinstance(node, ast.Subscript) and _is_parameters(node.value, aliases):
                key = node.slice
                if isinstance(key, ast.Constant) and isinstance(key.value, str):
                    if isinstance(node.ctx, ast.Load):
                        required.setdefault(key.value, node.lineno)
                    else:
                        assigned.add(key.value)
            elif (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr in {"get", "setdefault"}
                and _is_parameters(node.func.value, aliases)
                and node.args
                and isinstance(node.args[0], ast.Constant)
                and isinstance(node.args[0].value, str)
            ):
                name = node.args[0].value
                if len(node.args) > 1 and name not in defaults:
                    ok, value = _literal(node.args[1])
                    if ok:
                        defaults[name] = (node.lineno, value)
    return required, defaults, assigned


def _initialize_args(
    cls: ast.ClassDef,
) -> tuple[int, dict[str, Any], list[str], list[str]]:
    """initialize(self, a, b=1): (line, plain defaults, unread defaults, required names)."""
    for stmt in cls.body:
        if not (
            isinstance(stmt, ast.FunctionDef | ast.AsyncFunctionDef) and stmt.name == "initialize"
        ):
            continue
        positional = [*stmt.args.posonlyargs, *stmt.args.args]
        first_default = len(positional) - len(stmt.args.defaults)
        values: dict[str, Any] = {}
        unread: list[str] = []
        required: list[str] = []
        for index, arg in enumerate(positional):
            if index == 0 or arg in stmt.args.posonlyargs:
                continue  # `self`, and names LumiBot cannot pass by keyword
            if index < first_default:
                required.append(arg.arg)
                continue
            ok, value = _literal(stmt.args.defaults[index - first_default])
            if ok:
                values[arg.arg] = value
            else:
                unread.append(arg.arg)
        return stmt.lineno, values, unread, required
    return 0, {}, [], []


def _run_call_parameters(
    tree: ast.AST, class_name: str, wanted: set[str], names: dict[str, list[tuple[int, ast.expr]]]
) -> tuple[int, dict[str, Any], list[str]]:
    """Parameters given to the first `Cls.backtest(...)` (else `Cls(...)`) call."""
    best: tuple[tuple[int, int], dict[str, Any], list[str]] | None = None
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if (
            isinstance(func, ast.Attribute)
            and func.attr in RUN_METHODS
            and isinstance(func.value, ast.Name)
            and func.value.id == class_name
        ):
            rank = (0, node.lineno)
        elif isinstance(func, ast.Name) and func.id == class_name:
            rank = (1, node.lineno)
        else:
            continue
        values: dict[str, Any] = {}
        unread: list[str] = []
        for keyword in node.keywords:
            if keyword.arg == "parameters":
                given, skipped, _ = _dict_items(_resolve(keyword.value, names, node.lineno))
                values.update(given)
                unread.extend(skipped)
            elif keyword.arg in wanted:
                ok, value = _literal(keyword.value)
                if ok:
                    values[keyword.arg] = value
                else:
                    unread.append(keyword.arg)
        if (values or unread) and (best is None or rank < best[0]):
            best = (rank, values, unread)
    if best is None:
        return 0, {}, []
    return best[0][1], best[1], best[2]


def _class_parameters(
    cls: ast.ClassDef, names: dict[str, list[tuple[int, ast.expr]]]
) -> tuple[int, dict[str, Any], list[str], bool]:
    """The class-level `parameters` dict: (line, plain values, unread names, fully read)."""
    found: tuple[int, dict[str, Any], list[str], bool] = (0, {}, [], True)
    for stmt in cls.body:
        if isinstance(stmt, ast.Assign):
            targets, value = stmt.targets, stmt.value
        elif isinstance(stmt, ast.AnnAssign) and stmt.value is not None:
            targets, value = [stmt.target], stmt.value
        else:
            continue
        if any(isinstance(target, ast.Name) and target.id == "parameters" for target in targets):
            values, unread, complete = _dict_items(_resolve(value, names, stmt.lineno))
            found = (stmt.lineno, values, unread, complete)
    return found


def _strategy_parameters(
    tree: ast.Module, cls: ast.ClassDef, names: dict[str, list[tuple[int, ast.expr]]]
) -> dict[str, Any]:
    class_line, class_values, class_unread, parsed = _class_parameters(cls, names)
    init_line, init_values, init_unread, init_required = _initialize_args(cls)
    required, get_defaults, assigned = _parameter_reads(cls)
    wanted = {*required, *get_defaults, *init_values, *init_unread, *init_required, *class_values}
    call_line, call_values, _ = _run_call_parameters(tree, cls.name, wanted, names)

    # Precedence matches LumiBot: run arguments, then the class dict, then the
    # initialize() default, then a `.get()` fallback in the code.
    merged: dict[str, Any] = {}
    for key in [*class_values, *init_values, *get_defaults, *call_values]:
        if key in call_values:
            merged[key] = call_values[key]
        elif key in class_values:
            merged[key] = class_values[key]
        elif key in init_values:
            merged[key] = init_values[key]
        else:
            merged[key] = get_defaults[key][1]

    sources = []
    if class_line:
        sources.append({"kind": "class", "line": class_line})
    if init_values:
        sources.append({"kind": "initialize", "line": init_line})
    if any(key not in class_values and key not in init_values for key in get_defaults):
        sources.append({"kind": "get", "line": min(line for line, _ in get_defaults.values())})
    if call_values:
        sources.append({"kind": "call", "line": call_line})

    # A class or initialize() default that is not a plain value still applies
    # at run time; it just cannot be edited. A value only given in a run call
    # never reaches AntQuant's runs, so a read of it is missing.
    unread = sorted({*class_unread, *init_unread} - set(merged))
    needed = {name: init_line for name in init_required}
    for name, line in required.items():
        needed.setdefault(name, line)
    missing = [
        {"name": name, "line": line}
        for name, line in sorted(needed.items(), key=lambda item: (item[1], item[0]))
        if name not in merged and name not in assigned and name not in unread
    ]
    return {
        "parameters": merged,
        "parameters_parsed": parsed and not unread,
        "parameter_sources": sources,
        "unread_parameters": unread,
        "missing_parameters": missing,
    }


def parse_strategy_file(path: Path, root_label: str, rel: str) -> list[DiscoveredStrategy]:
    """Find `class X(Strategy)` definitions in a file without importing it."""
    try:
        return parse_strategy_source(path.read_bytes(), root_label, rel)
    except SyntaxError:
        return []


def parse_strategy_source(raw: bytes, root_label: str, rel: str) -> list[DiscoveredStrategy]:
    tree = ast.parse(raw, filename=rel)
    compile(tree, rel, "exec")
    digest = hashlib.sha256(raw).hexdigest()
    bases = {"Strategy"}
    for stmt in tree.body:
        if isinstance(stmt, ast.ImportFrom) and stmt.module in {
            "lumibot.strategies",
            "lumibot.strategies.strategy",
        }:
            bases.update(
                alias.asname for alias in stmt.names if alias.name == "Strategy" and alias.asname
            )
    names = _assignments(tree)
    found: list[DiscoveredStrategy] = []
    for node in tree.body:
        if not isinstance(node, ast.ClassDef):
            continue
        if bases.isdisjoint(_base_name(base) for base in node.bases):
            continue
        found.append(
            DiscoveredStrategy(
                file=rel,
                root=root_label,
                class_name=node.name,
                docstring=(ast.get_docstring(node) or "").strip(),
                sha256=digest,
                **_strategy_parameters(tree, node, names),
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

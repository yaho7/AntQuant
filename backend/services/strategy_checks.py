"""Checks for strategy files written for plain LumiBot or by an AI tool.

Nothing here runs the code. The file is parsed with `ast`, and module names are
looked up with `importlib.util.find_spec`, which does not import top-level
packages. The checks name what would stop the file from running in AntQuant,
and the fix rewrites only the parts that need no guessing:

* top-level code that starts a run when the file is loaded (`trader.run_all()`,
  `Alpaca(...)`, `Strategy.backtest(...)`) moves under
  `if __name__ == "__main__":`, which AntQuant never executes;
* imports of modules the server does not have (a local `config.py` holding API
  keys, say) move into that block when only the run code uses them, or are
  removed when nothing uses them.
"""

from __future__ import annotations

import ast
import difflib
import functools
import importlib.util
import io
import re
import tokenize
from dataclasses import asdict, dataclass, field
from typing import Any, Literal

from backend.adapters.lumibot_adapter import (
    RUN_METHODS,
    DiscoveredStrategy,
    parse_strategy_source,
)
from backend.workers.common import MODULE_ALIASES

Severity = Literal["error", "warning", "info"]

RUN_ATTRIBUTES = RUN_METHODS | {"run_all", "add_strategy", "run_live"}
BUILT_IN_DATA = {"YahooDataBacktesting", "AlpacaBacktesting", "BacktestingBroker"}
CREDENTIAL_ENV = re.compile(r"^(ALPACA|APCA|SCHWAB)_[A-Z0-9_]+$")
GUARDING_ERRORS = {"ImportError", "ModuleNotFoundError", "Exception", "BaseException"}
SEVERITY_ORDER = {"error": 0, "warning": 1, "info": 2}
INDENT = "    "


@dataclass
class Issue:
    code: str
    severity: Severity
    line: int | None = None
    params: dict[str, Any] = field(default_factory=dict)
    fixable: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class Report:
    issues: list[Issue]
    fixed_code: str | None = None
    diff: str = ""
    changes: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        fix = None
        if self.fixed_code is not None:
            fix = {"code": self.fixed_code, "diff": self.diff, "changes": self.changes}
        return {"issues": [issue.to_dict() for issue in self.issues], "fix": fix}


# ------------------------------------------------------------------ helpers


@functools.lru_cache(maxsize=1024)
def _importable(top: str) -> bool:
    try:
        return importlib.util.find_spec(top) is not None
    except (ImportError, ValueError):
        return False


def _status(module: str) -> tuple[bool, str | None]:
    """(available, alias used): can a worker import `module`?"""
    if not module or module.startswith("."):
        return False, None  # a sibling file, which a single upload does not have
    top = module.split(".")[0]
    if _importable(top):
        return True, None
    alias = MODULE_ALIASES.get(top)
    if alias and _importable(alias):
        return True, alias
    return False, None


def _import_modules(stmt: ast.Import | ast.ImportFrom) -> list[str]:
    if isinstance(stmt, ast.ImportFrom):
        return ["." * stmt.level + (stmt.module or "")]
    return [alias.name for alias in stmt.names]


def _bound_names(stmt: ast.Import | ast.ImportFrom) -> set[str]:
    return {alias.asname or alias.name.split(".")[0] for alias in stmt.names if alias.name != "*"}


def _is_main_guard(node: ast.stmt) -> bool:
    if not isinstance(node, ast.If) or not isinstance(node.test, ast.Compare):
        return False
    test = node.test
    if len(test.ops) != 1 or not isinstance(test.ops[0], ast.Eq):
        return False
    sides = [test.left, test.comparators[0]]
    names = [side.id for side in sides if isinstance(side, ast.Name)]
    values = [side.value for side in sides if isinstance(side, ast.Constant)]
    return names == ["__name__"] and values == ["__main__"]


def _loaded_names(nodes: list[ast.stmt]) -> set[str]:
    return {
        node.id
        for stmt in nodes
        for node in ast.walk(stmt)
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load)
    }


def _assigned_names(stmt: ast.stmt) -> set[str]:
    if isinstance(stmt, ast.Assign):
        targets = list(stmt.targets)
    elif isinstance(stmt, ast.AnnAssign | ast.AugAssign):
        targets = [stmt.target]
    else:
        return set()
    return {
        node.id
        for target in targets
        for node in ast.walk(target)
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store)
    }


def _guarded_imports(tree: ast.Module) -> set[int]:
    """ids of imports inside `try:` blocks that catch ImportError."""
    guarded: set[int] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Try):
            continue
        for handler in node.handlers:
            kinds = handler.type.elts if isinstance(handler.type, ast.Tuple) else [handler.type]
            if handler.type is None or any(
                isinstance(kind, ast.Name) and kind.id in GUARDING_ERRORS for kind in kinds
            ):
                guarded.update(
                    id(inner)
                    for stmt in node.body
                    for inner in ast.walk(stmt)
                    if isinstance(inner, ast.Import | ast.ImportFrom)
                )
                break
    return guarded


def _protected_rows(source: str) -> set[int]:
    """Rows inside a multi-line string after its first row; indenting them changes the text."""
    rows: set[int] = set()
    starts: list[int] = []
    for token in tokenize.generate_tokens(io.StringIO(source).readline):
        kind = tokenize.tok_name.get(token.type, "")
        if kind == "FSTRING_START":
            starts.append(token.start[0])
        elif kind == "FSTRING_END" and starts:
            rows.update(range(starts.pop() + 1, token.end[0] + 1))
        elif token.type == tokenize.STRING and token.end[0] > token.start[0]:
            rows.update(range(token.start[0] + 1, token.end[0] + 1))
    return rows


# ------------------------------------------------------------------- module


class _Module:
    """A parsed file and the facts that both the checks and the fix use."""

    def __init__(self, source: str, classes: list[DiscoveredStrategy]) -> None:
        self.source = source
        self.tree = ast.parse(source)
        self.lines = source.splitlines(keepends=True)
        self.body = self.tree.body
        self.run_names = {"Trader"} | {item.class_name for item in classes}
        for node in ast.walk(self.tree):
            if isinstance(node, ast.ImportFrom) and (node.module or "").startswith(
                ("lumibot.brokers", "lumibot.traders")
            ):
                self.run_names.update(alias.asname or alias.name for alias in node.names)
        # A module-level `def main():` that starts a run makes `main()` run code too.
        for stmt in self.body:
            if isinstance(stmt, ast.FunctionDef) and self._starts_run(stmt.body):
                self.run_names.add(stmt.name)
        defs = [
            stmt
            for stmt in self.body
            if isinstance(stmt, ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef)
        ]
        self.def_names = _loaded_names(defs)
        self.guards = [stmt for stmt in self.body if _is_main_guard(stmt)]
        self.regions = self._run_regions()

    def _starts_run(self, nodes: list[ast.stmt]) -> bool:
        for stmt in nodes:
            for node in ast.walk(stmt):
                if not isinstance(node, ast.Call):
                    continue
                func = node.func
                if isinstance(func, ast.Attribute) and func.attr in RUN_ATTRIBUTES:
                    return True
                if isinstance(func, ast.Name) and func.id in self.run_names:
                    return True
        return False

    def is_script(self, stmt: ast.stmt) -> bool:
        """A top-level statement other than a definition, an import or a main block."""
        return not (
            isinstance(
                stmt,
                ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef | ast.Import | ast.ImportFrom,
            )
            or _is_main_guard(stmt)
        )

    def _run_regions(self) -> list[tuple[int, int, int]]:
        """Runs of top-level statements that start a run: (first, last, first flagged)."""
        regions: list[tuple[int, int, int]] = []
        index = 0
        while index < len(self.body):
            stmt = self.body[index]
            if not (self.is_script(stmt) and self._starts_run([stmt])):
                index += 1
                continue
            first = last = index
            # Follow-up statements (print the result, ...) go with the run, but
            # never an assignment that a class or function reads.
            while (
                last + 1 < len(self.body)
                and self.is_script(self.body[last + 1])
                and not (_assigned_names(self.body[last + 1]) & self.def_names)
            ):
                last += 1
            # So do assignments just above it that only the run reads (dates, configs).
            used = _loaded_names(self.body[first : last + 1])
            while first > (regions[-1][1] + 1 if regions else 0):
                previous = self.body[first - 1]
                names = _assigned_names(previous)
                if not (
                    isinstance(previous, ast.Assign | ast.AnnAssign)
                    and names
                    and names <= used
                    and not names & self.def_names
                ):
                    break
                first -= 1
                used |= _loaded_names([previous])
            regions.append((first, last, index))
            index = last + 1
        return regions

    def rows(self, first: int, last: int) -> tuple[int, int]:
        end = self.body[last]
        return self.body[first].lineno, end.end_lineno or end.lineno

    def owns_rows(self, first: int, last: int) -> bool:
        """True when no other top-level statement shares a row with body[first..last]."""
        start, end = self.rows(first, last)
        for index, stmt in enumerate(self.body):
            if first <= index <= last:
                continue
            if stmt.lineno <= end and (stmt.end_lineno or stmt.lineno) >= start:
                return False
        return True


# ------------------------------------------------------------------- checks


def check(content: bytes, classes: list[DiscoveredStrategy]) -> Report:
    """Find what would stop this file from running in AntQuant, plus a fix if one is safe."""
    source = content.decode("utf-8")
    module = _Module(source, classes)
    plan = _plan_fix(module)
    issues = [
        *_import_issues(module, plan),
        *_run_issues(module, plan),
        *_data_issues(module, classes),
    ]
    issues.sort(key=lambda issue: (SEVERITY_ORDER[issue.severity], issue.line or 0))
    report = Report(issues)
    fixed = _apply(module, plan) if plan.edits else None
    if fixed is not None and _same_strategies(fixed, classes):
        report.fixed_code = fixed
        report.diff = "".join(
            difflib.unified_diff(
                source.splitlines(keepends=True),
                fixed.splitlines(keepends=True),
                fromfile="before.py",
                tofile="after.py",
                n=2,
            )
        )
        report.changes = plan.changes
    else:
        for issue in issues:
            issue.fixable = False
    return report


def _import_issues(module: _Module, plan: _Plan) -> list[Issue]:
    guarded = _guarded_imports(module.tree)
    in_main = {id(node) for guard in module.guards for node in ast.walk(guard)}
    issues: list[Issue] = []
    seen: set[str] = set()
    for node in ast.walk(module.tree):
        if not isinstance(node, ast.Import | ast.ImportFrom):
            continue
        if id(node) in guarded or id(node) in in_main:
            continue  # optional, or never runs in AntQuant
        for name in _import_modules(node):
            top = name.split(".")[0] or name
            available, alias = _status(name)
            if top in seen or (available and not alias):
                continue
            seen.add(top)
            if alias:
                issues.append(
                    Issue("module_alias", "info", node.lineno, {"module": top, "alias": alias})
                )
            else:
                issues.append(
                    Issue(
                        "missing_module",
                        "error",
                        node.lineno,
                        {"module": name},
                        fixable=id(node) in plan.moved_imports,
                    )
                )
    return issues


def _run_issues(module: _Module, plan: _Plan) -> list[Issue]:
    return [
        Issue(
            "run_code",
            "error",
            module.body[flagged].lineno,
            fixable=module.rows(first, last)[0] in plan.wrapped,
        )
        for first, last, flagged in module.regions
    ]


def _data_issues(module: _Module, classes: list[DiscoveredStrategy]) -> list[Issue]:
    issues: list[Issue] = []
    foreign: set[str] = set()
    for node in ast.walk(module.tree):
        if isinstance(node, ast.Name):
            names = [node.id]
        elif isinstance(node, ast.ImportFrom) and (node.module or "").startswith(
            "lumibot.backtesting"
        ):
            names = [alias.name for alias in node.names]
        else:
            continue
        foreign.update(n for n in names if "Backtesting" in n and n not in BUILT_IN_DATA)
    if foreign:
        issues.append(Issue("data_source", "info", None, {"names": ", ".join(sorted(foreign))}))

    wanted = {item.class_name for item in classes}
    strategies = [s for s in module.body if isinstance(s, ast.ClassDef) and s.name in wanted]
    intraday = _intraday_line(strategies)
    if intraday:
        issues.append(Issue("intraday", "warning", intraday))
    for cls in strategies:
        for node in ast.walk(cls):
            if (
                isinstance(node, ast.Constant)
                and isinstance(node.value, str)
                and CREDENTIAL_ENV.match(node.value)
            ):
                issues.append(
                    Issue("env_credentials", "warning", node.lineno, {"name": node.value})
                )
                break
    return issues


def _intraday_line(classes: list[ast.ClassDef]) -> int | None:
    """First line that asks for minute or hour bars. Yahoo only has daily bars."""
    for cls in classes:
        for node in ast.walk(cls):
            if (
                isinstance(node, ast.Assign)
                and any(
                    isinstance(t, ast.Attribute) and t.attr == "sleeptime" for t in node.targets
                )
                and isinstance(node.value, ast.Constant)
            ):
                # LumiBot reads "30S", "5M" and "1H" as intraday, and a bare number as minutes.
                value = node.value.value
                minutes = isinstance(value, int) and not isinstance(value, bool)
                unit = value.strip()[-1:].lower() if isinstance(value, str) else ""
                if minutes or (unit and unit in "smh"):
                    return node.lineno
            if isinstance(node, ast.Call):
                for arg in [*node.args, *(keyword.value for keyword in node.keywords)]:
                    if isinstance(arg, ast.Constant) and arg.value in {"minute", "hour"}:
                        return node.lineno
    return None


def _same_strategies(fixed: str, classes: list[DiscoveredStrategy]) -> bool:
    """The fix must keep every strategy class and its default parameters."""
    try:
        found = parse_strategy_source(fixed.encode("utf-8"), "user", "fixed.py")
    except SyntaxError:
        return False
    before = [(item.class_name, item.parameters) for item in classes]
    return [(item.class_name, item.parameters) for item in found] == before


# ---------------------------------------------------------------------- fix


@dataclass
class _Plan:
    edits: list[tuple[int, int, list[str]]] = field(default_factory=list)  # rows -> lines
    wrapped: set[int] = field(default_factory=set)  # first rows of wrapped run code
    moved_imports: set[int] = field(default_factory=set)  # ids of moved or removed imports
    changes: list[dict[str, Any]] = field(default_factory=list)


def _plan_fix(module: _Module) -> _Plan:
    plan = _Plan()
    try:
        protected = _protected_rows(module.source)
    except (tokenize.TokenError, SyntaxError):
        return plan

    regions = [(first, last) for first, last, _ in module.regions if module.owns_rows(first, last)]
    run_stmts = [
        stmt for first, last, _ in module.regions for stmt in module.body[first : last + 1]
    ]
    run_names = _loaded_names(run_stmts) | _loaded_names(module.guards)
    other_names = _loaded_names(
        [stmt for stmt in module.body if module.is_script(stmt) and stmt not in run_stmts]
    )

    # Where moved imports go: the earliest main block, new or existing.
    targets = [(module.rows(first, last)[0], "new") for first, last in regions]
    targets += [
        (guard.body[0].lineno, "guard")
        for guard in module.guards
        if guard.body and guard.body[0].lineno > guard.lineno
    ]
    target = min(targets) if targets else None

    moved: list[str] = []
    for index, stmt in enumerate(module.body):
        if not isinstance(stmt, ast.Import | ast.ImportFrom):
            continue
        if all(_status(name)[0] for name in _import_modules(stmt)):
            continue
        names = _bound_names(stmt)
        used = bool(names & run_names)
        if names & (module.def_names | other_names) or not module.owns_rows(index, index):
            continue  # a class or function needs it: no safe fix
        if used and target is None:
            continue
        start, end = module.rows(index, index)
        plan.edits.append((start, end, []))
        plan.moved_imports.add(id(stmt))
        plan.changes.append({"kind": "import", "line": start, "moved": used})
        if used:
            moved.extend(module.lines[start - 1 : end])
    if moved and not moved[-1].endswith("\n"):
        moved[-1] += "\n"

    for first, last in regions:
        start, end = module.rows(first, last)
        block = ['if __name__ == "__main__":\n']
        if moved and target == (start, "new"):
            block.extend(INDENT + line for line in moved)
        for row in range(start, end + 1):
            line = module.lines[row - 1]
            block.append(line if row in protected or not line.strip() else INDENT + line)
        if not block[-1].endswith("\n"):
            block[-1] += "\n"
        plan.edits.append((start, end, block))
        plan.wrapped.add(start)
        plan.changes.append({"kind": "run_code", "line": start})

    if moved and target and target[1] == "guard":
        row = target[0]
        guard = next(guard for guard in module.guards if guard.body[0].lineno == row)
        indent = " " * guard.body[0].col_offset
        plan.edits.append((row, row - 1, [indent + line for line in moved]))  # insert above
    plan.changes.sort(key=lambda change: change["line"])
    return plan


def _apply(module: _Module, plan: _Plan) -> str:
    lines = list(module.lines)
    if lines and not lines[-1].endswith("\n"):
        lines[-1] += "\n"
    # Bottom-up, so the row numbers of earlier edits stay valid.
    for start, end, new in sorted(plan.edits, key=lambda edit: edit[0], reverse=True):
        lines[start - 1 : end] = new
    return "".join(lines)

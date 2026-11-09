"""Helpers shared by worker subprocesses."""

from __future__ import annotations

import importlib
import importlib.util
import io
import json
import logging
import os
import re
import sys
import traceback
from pathlib import Path
from typing import Any

from backend.core.logging import LOG_FORMAT, RedactingFilter, redact, register_secret

ALPACA_KEY_ENV = "LUMIBOT_UI_ALPACA_API_KEY"
ALPACA_SECRET_ENV = "LUMIBOT_UI_ALPACA_API_SECRET"  # noqa: S105 - env var name, not a secret
ALPACA_MODE_ENV = "LUMIBOT_UI_ALPACA_MODE"
ALPACA_ENDPOINT_ENV = "LUMIBOT_UI_ALPACA_ENDPOINT"


class _RedactingStream(io.TextIOBase):
    """Wrap stdout/stderr so a secret printed by any library is masked."""

    def __init__(self, inner: Any) -> None:
        self._inner = inner

    def write(self, s: str) -> int:
        self._inner.write(redact(s))
        return len(s)

    def flush(self) -> None:
        self._inner.flush()

    def isatty(self) -> bool:
        return False

    def fileno(self) -> int:
        return self._inner.fileno()


def setup_worker(work_dir: Path) -> dict[str, Any]:
    """chdir into the task dir, protect secrets in output, load the spec."""
    os.chdir(work_dir)
    register_secret(os.environ.get(ALPACA_KEY_ENV))
    register_secret(os.environ.get(ALPACA_SECRET_ENV))
    sys.stdout = _RedactingStream(sys.stdout)  # type: ignore[assignment]
    sys.stderr = _RedactingStream(sys.stderr)  # type: ignore[assignment]
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter(LOG_FORMAT))
    handler.addFilter(RedactingFilter())
    # LumiBot prints its own records through its own handler; skip them here
    # so each line appears once. stdout is already wrapped for redaction.
    handler.addFilter(lambda r: not r.name.startswith("lumibot"))
    root = logging.getLogger()
    root.addHandler(handler)
    root.setLevel(logging.INFO)
    return json.loads((work_dir / "spec.json").read_text())


def alpaca_config() -> dict[str, Any] | None:
    key = os.environ.get(ALPACA_KEY_ENV)
    secret = os.environ.get(ALPACA_SECRET_ENV)
    if not key or not secret:
        return None
    return {
        "API_KEY": key,
        "API_SECRET": secret,
        "PAPER": os.environ.get(ALPACA_MODE_ENV) != "live",
        "ENDPOINT": os.environ.get(ALPACA_ENDPOINT_ENV),
    }


# Packages that AI tools and tutorials import under a name this image does not
# ship, mapped to the installed package with the same API. An alias applies
# only while the original package is missing.
MODULE_ALIASES = {"pandas_ta": "pandas_ta_classic"}


def install_module_aliases(source: bytes) -> None:
    """Let `import pandas_ta` resolve to pandas_ta_classic for code that uses it."""
    for alias, real in MODULE_ALIASES.items():
        if alias in sys.modules or not re.search(rb"\b" + alias.encode() + rb"\b", source):
            continue
        if importlib.util.find_spec(alias) is not None or importlib.util.find_spec(real) is None:
            continue
        sys.modules[alias] = importlib.import_module(real)
        for name, submodule in list(sys.modules.items()):
            if name.startswith(real + "."):
                sys.modules.setdefault(alias + name[len(real) :], submodule)


def load_strategy_class(path: str, class_name: str, snapshot: str | None = None) -> type:
    from lumibot.strategies import Strategy

    file_path = Path(path)
    spec = importlib.util.spec_from_file_location(f"user_strategy_{file_path.stem}", file_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load strategy file {file_path.name}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    code = Path(snapshot or file_path).read_bytes()
    install_module_aliases(code)
    if snapshot is None:
        spec.loader.exec_module(module)
    else:
        # Use the pinned code in the worker while preserving the strategy's original __file__.
        compiled = compile(code, snapshot, "exec")
        exec(compiled, module.__dict__)  # noqa: S102 - run trusted administrator strategy code
    cls = getattr(module, class_name, None)
    if not isinstance(cls, type) or not issubclass(cls, Strategy):
        raise TypeError(f"{class_name} in {file_path.name} is not a LumiBot Strategy subclass")
    return cls


def write_json(path: Path, data: Any) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, default=str))
    tmp.replace(path)


def write_error(work_dir: Path, exc: BaseException) -> None:
    write_json(
        work_dir / "error.json",
        {
            "error": redact(f"{type(exc).__name__}: {exc}"),
            "traceback": redact("".join(traceback.format_exception(exc))),
        },
    )

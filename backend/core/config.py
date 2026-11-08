"""Process-level configuration.

Everything here has a safe default so the container starts with no `.env` file.
Broker credentials and the admin password are NOT configured here: they are set
in the first-run setup wizard and stored (encrypted) in the data directory.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

PROJECT_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="LUMIBOT_UI_", extra="ignore")

    data_dir: Path = PROJECT_ROOT / "data"
    examples_dir: Path = PROJECT_ROOT / "strategies" / "examples"
    frontend_dist: Path = PROJECT_ROOT / "frontend" / "dist"

    # Send the session cookie only over HTTPS. Turn on when served behind TLS.
    cookie_secure: bool = False
    session_hours: int = 24 * 7

    # Live trading is not available in this release; the backend refuses it.
    # The flag exists so the check is centralised and auditable.
    live_trading_enabled: bool = False

    github_repo: str = "yaho7/lumibot-ui"
    log_level: str = "INFO"

    @property
    def db_path(self) -> Path:
        return self.data_dir / "lumibot-ui.db"

    @property
    def strategies_dir(self) -> Path:
        return self.data_dir / "strategies"

    @property
    def tasks_dir(self) -> Path:
        return self.data_dir / "tasks"

    @property
    def logs_dir(self) -> Path:
        return self.data_dir / "logs"

    @property
    def secret_key_path(self) -> Path:
        return self.data_dir / "secret.key"

    def ensure_dirs(self) -> None:
        for path in (self.data_dir, self.strategies_dir, self.tasks_dir, self.logs_dir):
            path.mkdir(parents=True, exist_ok=True)


@lru_cache
def get_settings() -> Settings:
    return Settings()

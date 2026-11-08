"""FastAPI application: REST API plus the built React app."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from backend import __version__
from backend.api import account, auth, backtests, logs, strategies, system, trading
from backend.core.config import Settings, get_settings
from backend.core.db import init_engine, run_migrations, session_factory
from backend.core.logging import setup_logging
from backend.services import setup_service
from backend.services.broker_service import alpaca_credentials
from backend.services.task_manager import TaskManager

api_log = logging.getLogger("api")

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
}


def create_app(settings: Settings | None = None, start_tasks: bool = True) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        settings.ensure_dirs()
        setup_logging(settings.logs_dir, settings.log_level)
        run_migrations(settings.db_path)
        init_engine(settings.db_path)
        factory = session_factory()
        with factory() as db:
            setup_service.ensure_setup_token(db, settings)
        tm = TaskManager(settings, factory, alpaca_credentials)
        app.state.task_manager = tm
        if start_tasks:
            tm.start()
        logging.getLogger("system").info("LumiBot UI %s started", __version__)
        yield
        if start_tasks:
            tm.shutdown()
        logging.getLogger("system").info("LumiBot UI stopped")

    app = FastAPI(
        title="LumiBot UI",
        version=__version__,
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url="/api/openapi.json",
    )

    @app.middleware("http")
    async def guard(request: Request, call_next):  # type: ignore[no-untyped-def]
        # State-changing API calls must be JSON or multipart. A cross-site HTML
        # form cannot send these without a CORS preflight, which we never allow.
        if request.url.path.startswith("/api/") and request.method in {
            "POST",
            "PUT",
            "PATCH",
            "DELETE",
        }:
            ctype = request.headers.get("content-type", "")
            has_body = request.headers.get("content-length", "0") not in ("", "0")
            if has_body and not (
                ctype.startswith("application/json") or ctype.startswith("multipart/form-data")
            ):
                return JSONResponse({"detail": "Unsupported content type."}, status_code=415)
        response = await call_next(request)
        for key, value in SECURITY_HEADERS.items():
            response.headers.setdefault(key, value)
        if request.url.path.startswith("/api/"):
            response.headers.setdefault("Cache-Control", "no-store")
        return response

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        if exc.status_code >= 500:
            api_log.error(
                "%s %s -> %s: %s", request.method, request.url.path, exc.status_code, exc.detail
            )
        return JSONResponse(
            {"detail": exc.detail},
            status_code=exc.status_code,
            headers=getattr(exc, "headers", None),
        )

    @app.exception_handler(Exception)
    async def unhandled(request: Request, exc: Exception) -> JSONResponse:
        api_log.exception("Unhandled error on %s %s", request.method, request.url.path)
        return JSONResponse(
            {"detail": f"Internal error ({type(exc).__name__}). See the API error log."},
            status_code=500,
        )

    for router in (
        system.public,
        auth.router,
        account.router,
        strategies.router,
        backtests.router,
        trading.router,
        logs.router,
        system.router,
    ):
        app.include_router(router)

    _mount_frontend(app, settings.frontend_dist)
    return app


def _mount_frontend(app: FastAPI, dist: Path) -> None:
    index = dist / "index.html"
    if (dist / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")
    root = dist.resolve()

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str) -> FileResponse:
        if path.startswith("api/"):
            raise HTTPException(404, "Not found.")
        candidate = (root / path).resolve()
        if path and candidate.is_relative_to(root) and candidate.is_file():
            return FileResponse(candidate)
        if index.exists():
            return FileResponse(index, headers={"Cache-Control": "no-cache"})
        raise HTTPException(404, "Frontend is not built. Run `npm run build` in frontend/.")


app = create_app()

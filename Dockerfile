# syntax=docker/dockerfile:1.7

# ---------- 1. Frontend build ----------
FROM node:22-alpine AS frontend-input
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
# A release bump changes these fields even when the install inputs are identical.
RUN <<'JS' node
const { readFileSync, writeFileSync } = require("node:fs");
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
delete manifest.version;
delete lock.version;
delete lock.packages[""].version;
writeFileSync("package.json", JSON.stringify(manifest));
writeFileSync("package-lock.json", JSON.stringify(lock));
JS

FROM node:22-alpine AS frontend
WORKDIR /src/frontend
COPY --from=frontend-input /src/frontend/package.json /src/frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---------- 2. Python dependencies (locked, no dev tools) ----------
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS python-input
WORKDIR /app
COPY pyproject.toml uv.lock ./
# polars[rtcompat] brings both native runtimes. Ship only the baseline one on x86.
RUN uv export --frozen --no-dev --no-emit-project --no-emit-package polars-runtime-32 \
    --no-header --output-file /requirements.txt --quiet

FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS python-deps
ENV UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never
WORKDIR /app
COPY --from=python-input /requirements.txt ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv venv /app/.venv \
    && uv pip sync --python /app/.venv/bin/python --require-hashes requirements.txt

# ---------- 3. Runtime ----------
FROM python:3.12-slim-bookworm AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 lumibot \
    && useradd --system --uid 10001 --gid lumibot --home-dir /data --no-create-home lumibot \
    && mkdir -p /data \
    && chown lumibot:lumibot /data

ENV PATH="/app/.venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOME=/data \
    MPLCONFIGDIR=/data/.cache/matplotlib \
    LUMIBOT_UI_DATA_DIR=/data \
    LUMIBOT_UI_FRONTEND_DIST=/app/frontend/dist \
    LUMIBOT_UI_EXAMPLES_DIR=/app/strategies/examples

WORKDIR /app
COPY --link --from=python-deps /app/.venv /app/.venv
COPY --link backend/ /app/backend/
COPY --link strategies/ /app/strategies/
COPY --link --from=frontend /src/frontend/dist /app/frontend/dist

ARG VERSION=dev
LABEL org.opencontainers.image.title="AntQuant" \
      org.opencontainers.image.description="Self-hosted web UI for the LumiBot trading framework" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}"

USER lumibot
VOLUME ["/data"]
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4).status == 200 else 1)"]

# tini forwards SIGTERM; uvicorn then runs the shutdown hook that stops
# strategy workers gracefully before the container exits.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000", "--timeout-graceful-shutdown", "20", "--no-server-header"]

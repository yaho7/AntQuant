# Test results (v0.1.0)

Run on macOS arm64, Python 3.12.16, Node 22, LumiBot 4.6.48, on 2026-11-08.

| Check | Command | Result |
| --- | --- | --- |
| Backend unit + API tests | `uv run pytest -m "not compat"` | 46 passed |
| LumiBot compat + real Yahoo backtest | `RUN_INTEGRATION=1 uv run pytest tests/test_lumibot_compat.py` | 4 passed |
| Lint | `uv run ruff check` / `ruff format --check` | clean |
| Frontend types / unit / build | `npm run typecheck && npm test && npm run build` | clean, 3 passed, built |
| Browser end-to-end | Playwright + Chrome against a real server | passed (see below) |

The browser run covered: first-run setup with the token, skipping broker setup, adding the
`SmaCrossover` example, running a real 2022–2024 Yahoo backtest from the form (finished in
about 11 s: total return −3.83 %, max drawdown −27.12 %, 17 fills, 8 closed trades), viewing
the report, logs and settings in light and dark mode and on a 390 px phone, then restarting the
server and confirming the backtest record and result were still there.

## What is tested only with fakes

* **Alpaca account data and paper trading** were tested with a mock broker and a fake worker
  process (start, pause/resume control file, duplicate start refused, stop, restart recovery).
  No real Alpaca keys were available, so a real paper connection has **not** been verified.
  Before relying on it, connect a paper account, press *Test connection* in Settings and run
  the `BuyAndHold` example during market hours.
* **Docker image**: Docker was not available on the development machine. The CI workflow
  builds the image and smoke-tests it (health check, SPA served, API requires login, setup
  token logged, non-root UID, graceful stop) before anything is pushed.

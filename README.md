# LumiBot UI

A self-hosted web interface for the [LumiBot](https://github.com/Lumiwealth/lumibot) trading
framework: manage strategies, run backtests, paper-trade on Alpaca and watch logs from one
browser tab. Free, open source (MIT), one Docker container, no `.env` file needed.

LumiBot UI does not fork or patch LumiBot. It installs a pinned LumiBot release and calls its
public Python API from separate worker processes.

| Area | What works in this release |
| --- | --- |
| Dashboard | Real Alpaca account: equity, cash, buying power, daily and period P&L, equity curve, allocation, holdings, recent trades, running tasks, system status |
| Strategies | Register bundled or uploaded strategy classes, edit name/description/parameters, version history with restore, read-only code view, per-strategy backtests and fills |
| Backtesting | Real LumiBot backtests (Yahoo or Alpaca data) in a subprocess, progress, timeout, queue, metrics, equity and drawdown charts, trade list, CSV export, LumiBot tearsheet files |
| Trading | Alpaca **paper** trading: start, pause, resume, stop, emergency stop, account liquidation with typed confirmation |
| Logs | System, API error, audit and per-task logs with level filter, search, auto-refresh and download |
| Settings | Alpaca keys (write-only, encrypted), backtest defaults, timeouts, password, versions, LumiBot compatibility check, update check, audit log |

Live trading is **not** available in this release. The server refuses it whatever the browser
sends.

## Quick start (Docker)

You need Docker with Compose. Create a folder with this `compose.yaml` (it is also in the repo):

```yaml
services:
  lumibot-ui:
    image: ghcr.io/yaho7/lumibot-ui:latest
    ports:
      - "127.0.0.1:8000:8000"
    volumes:
      - lumibot-data:/data
    restart: unless-stopped
    stop_grace_period: 30s

volumes:
  lumibot-data:
```

Then:

```bash
docker compose up -d
docker compose logs lumibot-ui | grep "setup token"
```

Open <http://127.0.0.1:8000>, enter the setup token from the log, create the admin account,
and (optionally) paste your Alpaca **paper** API key and secret. That is all the setup.

The port is bound to `127.0.0.1` on purpose. To reach it from other devices, put a reverse
proxy in front of it (see below) instead of opening the port.

### Behind 1Panel, Nginx or Cloudflare Tunnel

Point the proxy at `http://127.0.0.1:8000`. Serve it over HTTPS and set
`LUMIBOT_UI_COOKIE_SECURE=true` so the session cookie is only sent over TLS:

```yaml
    environment:
      LUMIBOT_UI_COOKIE_SECURE: "true"
```

Nginx example:

```nginx
location / {
    proxy_pass http://127.0.0.1:8000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 2m;
}
```

With **1Panel**: create a website of type *Reverse proxy* to `http://127.0.0.1:8000`, enable
HTTPS, and add the environment variable above to the container.
With **Cloudflare Tunnel**: `cloudflared tunnel --url http://127.0.0.1:8000`, or add the
service to an existing tunnel. Consider Cloudflare Access in front of it as a second login.

### Data, backup and restore

Everything lives in the `/data` volume: the SQLite database, encrypted keys
(`secret.key` + database), uploaded strategies, task outputs and logs.

```bash
# backup (the volume is named <folder>_lumibot-data; check with `docker volume ls`)
docker run --rm -v lumibot-ui_lumibot-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/lumibot-ui-data.tgz -C /data .
```

Keep backups private: with the whole folder anyone can decrypt the stored Alpaca keys.

To use a host folder instead of a named volume (some NAS setups), make it writable by the
container user first: `mkdir data && sudo chown -R 10001:10001 data`, then use
`- ./data:/data`.

### Your own strategies

Upload a `.py` file on the Strategies page, or copy files into the volume's `strategies/`
folder (they show up under "From strategy folder"). A strategy is a normal LumiBot class:

```python
from lumibot.strategies import Strategy

class MyStrategy(Strategy):
    parameters = {"symbol": "SPY"}   # defaults shown and editable in the UI

    def initialize(self):
        self.sleeptime = "1D"

    def on_trading_iteration(self):
        ...
```

> **Security:** strategy code is trusted administrator code. It runs in its own process with
> the same permissions as the server: it can read the data folder and use the broker keys.
> There is no sandbox. Only the signed-in admin can upload or run code, and uploads require an
> explicit confirmation.

### Update and roll back

The image never upgrades itself or LumiBot at runtime.

```bash
docker compose pull && docker compose up -d     # update to the newest stable release
```

To roll back, pin an older tag in `compose.yaml` (for example `ghcr.io/yaho7/lumibot-ui:1.0`
or an exact `sha-<commit>` tag) and run `docker compose up -d`. The database is migrated
forward automatically on start; take a backup before upgrading across minor versions.

Tags: `latest` (newest stable release), `1.2.3` and `1.2` (releases), `main` (development
build of the main branch), `sha-<commit>` (every main build).

## How it works

```text
Browser ──HTTPS──> FastAPI (auth, CSRF, REST) ──> services ──> SQLite (/data)
                        │
                        ├─> Alpaca adapter (alpaca-py, read-only account data)
                        └─> Task manager ──spawn──> worker process ──> LumiBot
                                                    (backtest_worker / trading_worker)
```

* The web process never imports LumiBot. Strategy files are listed by parsing them, not by
  running them.
* `backend/adapters/lumibot_adapter.py` and `backend/workers/` are the only code tied to
  LumiBot's API. `python -m backend.workers.compat` checks every LumiBot call the project uses.
* Each run gets `data/tasks/<id>/` with its spec, log, LumiBot output and result. Closing the
  browser does not stop it. On restart, runs left behind are re-attached if their process is
  still alive, otherwise marked failed. Paper trading is never resumed automatically.
* Parameters reach workers through a JSON file, never through the command line.

### Pause, Stop and Liquidate

| Action | What happens | Positions |
| --- | --- | --- |
| Pause | Orders that would open or grow a position are rejected and logged. Exits, reductions and broker-side stops still work. | Kept |
| Stop | The strategy process is signalled and exits (killed after 30 s if it hangs). | Kept |
| Emergency stop | Stop for every running strategy at once. | Kept |
| Liquidate | Cancels open orders and closes **all** positions in the Alpaca account. Requires typing `LIQUIDATE`. | Closed |

### Account vs. strategy results

Alpaca reports one account. When several strategies share it, LumiBot UI shows equity,
positions and P&L **for the account only** and does not split them per strategy. Per strategy
it shows backtest results and the fills that strategy's own runs recorded.

### Metrics

Total return, annualized return (CAGR), Sharpe and max drawdown come from LumiBot's own
analysis. Win rate and profit factor are computed from fills by FIFO matching of long stock
trades. When that is not reliable (short sales, options, futures, no closed trade, no losing
trade) the value is shown as N/A with the reason.

## Security model

* Single admin account. Passwords hashed with Argon2. Login throttled per IP.
* First-run setup requires a one-time token from the server log, so nobody else can claim a
  fresh instance.
* Server-side sessions in an HttpOnly, SameSite=Strict cookie; CSRF token on every change;
  state-changing API calls must be JSON or multipart.
* Alpaca keys are entered in the UI, encrypted at rest (Fernet, key file `0600` in `/data`),
  never returned by the API and masked in all logs and downloads.
* No shell execution from the browser. File downloads and log sources resolve server-side
  names, never client paths.
* Paper mode is hard-wired in the backend. Sensitive actions are written to the audit log.
* The container runs as UID 10001 and contains no secrets.

## Development

Requires [uv](https://docs.astral.sh/uv/) and Node 22.

```bash
uv sync                                  # Python 3.12 + locked deps (incl. LumiBot)
uv run uvicorn backend.main:app --reload --port 8000

cd frontend && npm ci && npm run dev     # http://127.0.0.1:5173, proxies /api to :8000
```

The setup token is printed in the server output and saved to `data/setup-token.txt`.

```bash
uv run ruff check backend tests strategies
uv run pytest -m "not compat"            # fast tests, mock broker, fake workers
uv run pytest -m compat                  # real LumiBot API compatibility
RUN_INTEGRATION=1 uv run pytest -m integration   # real Yahoo backtest (internet)
cd frontend && npm run typecheck && npm test && npm run build
```

### Upgrading LumiBot

LumiBot is pinned in `pyproject.toml` and `uv.lock`. Dependabot opens a PR for new
releases; CI's compat job fails until the new version is checked and added to
`VERIFIED_LUMIBOT_VERSIONS` in `backend/adapters/lumibot_adapter.py`, so an untested LumiBot
never reaches a published image.

## Known limitations

* Live trading, multiple accounts and brokers other than Alpaca are not implemented.
* Per-strategy P&L on a shared account is not attributed.
* Pause only filters orders placed through `submit_order` / `submit_orders`; code that calls
  the broker object directly bypasses it.
* The Alpaca data source for backtests is wired through LumiBot but has not been run in CI
  (it needs keys). Yahoo backtests are tested end to end.
* Images are built for `linux/amd64` only for now.
* The UI is English only; strings are centralised for future translations.

## License

MIT. LumiBot is a separate project under its own license. The colour palette is
[Flexoki](https://stephango.com/flexoki) (MIT); the layout is inspired by
[Wealthfolio](https://github.com/afadil/wealthfolio) (no code copied).

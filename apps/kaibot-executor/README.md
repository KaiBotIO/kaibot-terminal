# KaiBot Terminal (executor)

The local executor. Holds the user's exchange keys and runs orders against the
exchange — both stay **on the user's machine**. It never authors a trade:
entries, exits and cancels arrive as signals from the user's own bots over the
websocket (server-pushed stop moves are refused outright), and any local exit
management (trailing, guardrails) runs only from config the user set themselves.

- Tauri desktop shell + a Bun/Hono `node-backend` daemon (same daemon runs
  headless on a server).
- Web UI on `:1420` (vite dev) → proxies `/api` + `/ws` to the backend on
  `:8080`.
- Build: `bun run build` (backend sidecar + web bundle).
- Type-check: `bunx tsc --noEmit` (web) and `cd node-backend && bunx tsc --noEmit`.

## License & disclaimer

The executor (this directory, including `node-backend/` and `src-tauri/`) is
open-source under the **GNU AGPL-3.0** — see [`LICENSE`](LICENSE). The rest of
the KaiBot monorepo is proprietary and NOT covered by that license.

It is provided **as is, without warranty of any kind** (AGPL §15–16), without
support and without any uptime commitment. It places real orders on your
exchange account with your own API keys: running it, configuring it and
monitoring it — including intervening directly on your exchange when the
executor or an exchange session goes down — is entirely your own
responsibility. Trading with it is at your own risk.

Headless / Docker run details: see [`docs/cli-and-docker.md`](docs/cli-and-docker.md).

TradeStation has no reduce-only flag — single-close there rests entirely on the
executor's OCO cancel-on-fill tracker: see
[`docs/tradestation-oco-dependency.md`](docs/tradestation-oco-dependency.md).

## Data dir & isolated instances

All per-installation state — the SQLite DB (`kaibot.db`), the crypto salt
(`.crypto-salt`) and the dev secret (`.crypto-dev-secret`) — lives in one data
dir. Resolution order:

1. `--data-dir <path>` flag / `KAIBOT_DATA_DIR` env → explicit dir.
2. `--profile <name>` flag / `KAIBOT_PROFILE` env → `~/.kaibot/executor/<name>/`.
3. neither → `node-backend/data/` (the default desktop/dev instance).

The DB and the crypto material must always share a dir, or the instance can't
decrypt its own keys. Setting `--profile`/`--data-dir` keeps them together.

### Isolated test instance for e2e pairing

Run a clean executor (fresh setup → login → pair → connect) **without touching
your real local instance**. The script uses a throwaway data dir and never
writes to `node-backend/data/`, so your existing admin credential, exchange
keys and positions stay untouched.

```bash
cd apps/kaibot-executor

# fresh temp dir, auto-removed on Ctrl-C; backend :8190, web :1490
KAIBOT_API_URL=http://localhost:3400 bun run test:instance

# keep the data dir after exit (inspect / reuse)
bun run test:instance --keep

# reuse a specific dir (implies --keep)
bun run test:instance --data-dir /tmp/exec-e2e

# custom ports
TEST_BACKEND_PORT=8200 TEST_WEB_PORT=1500 bun run test:instance
```

Open `http://<host>:<TEST_WEB_PORT>`. Because the temp dir has no admin user,
the first load shows the **setup** screen — create the admin, log in, paste the
executor API key from the main app's onboarding/Security tab to pair, then
connect an exchange. `KAIBOT_API_URL` points the instance at the signal service
it pairs against.

The headless backend supports the same isolation directly:

```bash
cd node-backend
KAIBOT_DATA_DIR=/tmp/exec-e2e PORT=8190 bun run dev
# or: bun run src/main.ts --data-dir /tmp/exec-e2e --port 8190
```

## COMP-1 — autonomous-decision hand-off (for the api team)

The executor must never decide a trade. One architectural violation and a few
flagged spots remain. Moving these server-side spans `apps/api` and is the api
team's task — see [`docs/comp-1-autonomous-decisions.md`](docs/comp-1-autonomous-decisions.md)
for the precise file:line inventory and the server-side replacement per site.

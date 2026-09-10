# E2E hardening — first real signal chain (2026-08-24)

The first live deliverable signal ever sent through the full chain (prod signal
→ WS → executor → routing → TradeStation order → fill) surfaced five defects.
Every one shipped with a regression test. Until this run, "running" bots with
zero orders were indistinguishable from healthy quiet bots — that is exactly
what four of these fixes prevent.

| # | Defect | Fix | Commit |
|---|---|---|---|
| 1 | A catch-up replay ending "in position" left the real book flat and the bot silent until its next flip (replayed entries are never delivered) | One-time deliverable position-sync entry on the first live tick (`shouldSyncPosition`, strategy-runner) | `61abb698` |
| 2 | Breathing-room guard assumed leverage 1 on a flat account → order margin = full notional → every first futures entry rejected (1 MNQ, $58.9k "margin" on a $12k account) | Venue-aware fallback: futures venues default to 10x (`BREATHING_ROOM_FUTURES_LEVERAGE`), stricter than the real ~12-15x | `cda58ca3` |
| 3 | TS balances mapped `InitialMargin`/`MaintenanceMargin` from top-level fields that don't exist in the v3 payload — read $0 even with an open position; margin lives nested under `BalanceDetail` | Map the nested fields first (real figures: MNQ $4,638, MES $2,858 per micro — §9 assumptions confirmed) | `44350104` |
| 4 | TS positions hardcoded `leverage: 1`, so any follow-up open on a rooted account hit the same full-notional false reject via the same-root leverage pick | Derive leverage from `MarketValue / InitialRequirement` (≈12.7x MNQ, 13.5x MES) | `332e84e0` |
| 5 | Pre-open guard rejects (halt, kill-switch, breathing room, daily-loss, concurrency, notional) only logged — a structurally refused bot looked quiet | All six guard paths publish on the `order_rejected` notification channel | `bc610c48` |

Related, server-side (same night): internal sdk plugins were refused by the
forward/backtest/optimize route guards (raw `STRATEGY_RUNNERS` lookup instead
of `resolveRunner`) — `b3d47558`; forward-test `seedDays` ceiling raised
90→550 because ladder/mtf rung indicators need a year-plus of history to warm
(`61abb698`).

## reset-admin also wipes the API pairing

`reset-admin` removes the admin user row — and the `apiConfig` (API URL + key,
auto-connect) lives in that user's settings, so it silently goes with it. The
help text's "Exchange connections, bots and history are untouched" is true for
those tables, but after a reset the executor comes back UP yet DISCONNECTED
from the signal service: no signals, no visible error beyond `ws/status:
disconnected`.

Recovery after every `reset-admin`:

1. First-run setup (`/api/auth/setup` or the UI) → new local admin.
2. Settings → API Configuration → re-enter the `kb_…` API key, test, save
   (or `PUT /api/user/settings` with the apiConfig + `POST /api/ws/connect`).
3. Verify `GET /api/ws/status` reports `connected: true` and check the
   subscriptions page — subscriptions, exchange sessions and history survive.

# Synthetic USD

A Synthetic USD position locks the USD value of your crypto holdings by holding a
short on an inverse (coin-margined) perpetual. On Deribit, `BTC-PERPETUAL` is
quoted in USD and margined in BTC: a short sized to your BTC value cancels the
spot exposure, so the combined position holds a fixed USD value while staying
mostly delta-neutral (~1x short).

It lives entirely in the executor (local), because it places real broker orders.
It is tracked as its own entity, separate from discretionary, signal and bot
positions. It never appears in the normal position list.

## What the user controls

- **Target USD** — how much synthetic USD to mint. The short is sized so the USD
  value held against the holdings equals this number.
- **Holdings basis (USD)** — the collateral the leverage cap is measured against.
  This is the *total* holdings, not only the BTC sitting on Deribit: the sum of
  on-exchange balances plus a manual field for off-exchange holdings.
- **Leverage** — capped at a user-editable ceiling, seeded at 2x (ESMA 2:1 retail
  standard). `target_usd <= leverage_cap * holdings_basis_usd`.

The position is editable over its life: scale up (mint more), scale down (unwind
part), and full close. Every mutation is recorded.

## Data model

Migration `010_synthetic_usd.sql`, picked up by the name-keyed runner in
`storage/database.ts` (key `synthetic_usd`).

### `synthetic_usd_positions`

| column | type | note |
|---|---|---|
| `id` | TEXT PK | uuid |
| `exchange` | TEXT | venue holding the short (e.g. `deribit`) |
| `account_id` | TEXT | account on that venue (e.g. `btc`) |
| `symbol` | TEXT | inverse perpetual (e.g. `BTC-PERPETUAL`) |
| `target_usd` | REAL | requested synthetic USD value |
| `holdings_basis_usd` | REAL | collateral basis the leverage cap measures against |
| `leverage` | REAL | `target_usd / holdings_basis_usd`, derived, ≤ `leverage_cap` |
| `short_size` | REAL | current short notional (USD) actually held |
| `status` | TEXT | `open` \| `closed` |
| `is_factor_basis` | INTEGER | 1 when synthetic mode is on for this (exchange, account) |
| `created_at` | INTEGER | ms |
| `updated_at` | INTEGER | ms |

A partial unique index enforces at most one open position per
`(exchange, account_id, symbol)` and at most one `is_factor_basis = 1` row.

### `synthetic_usd_mutations`

Append-only history.

| column | type | note |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `position_id` | TEXT FK | |
| `kind` | TEXT | `mint` \| `scale_up` \| `scale_down` \| `close` |
| `target_usd_before` | REAL | |
| `target_usd_after` | REAL | |
| `short_size_before` | REAL | |
| `short_size_after` | REAL | |
| `order_id` | TEXT | the order that effected the change, null on no-op |
| `order_side` | TEXT | `sell` (scale up) \| `buy` (scale down/close) |
| `order_qty` | REAL | USD notional of that order |
| `created_at` | INTEGER | ms |

### `holdings_basis`

The configurable collateral basis. One singleton row per `(exchange, account_id)`
plus a manual off-exchange line so the user can include cold storage etc.

| column | type | note |
|---|---|---|
| `source` | TEXT PK | `exchange:account` or `manual:<label>` |
| `usd_value` | REAL | |
| `is_manual` | INTEGER | 1 for user-entered off-exchange lines |
| `updated_at` | INTEGER | ms |

Exchange lines are refreshed from live balances × the venue's BTC index price;
manual lines are user-entered and persist as-is. The holdings basis used for the
leverage cap is the sum of all rows.

## Sizing formula

The inverse perpetual quotes contracts in USD, so the short notional *is* the USD
value to hedge. No price conversion is needed to size the short itself.

```
holdings_basis_usd = Σ holdings_basis.usd_value          // exchange + manual lines
max_target_usd     = leverage_cap * holdings_basis_usd    // leverage_cap default = 2
target_usd         = clamp(requested, 0, max_target_usd)  // reject if requested > cap
short_notional_usd = target_usd                           // 1x short, inverse contract
short_contracts    = roundToStep(short_notional_usd, stepSize)   // deribit btc step = 10 USD
```

To **scale**, diff against the live short:

```
delta_usd = target_after - target_before
delta > 0 → sell `roundToStep(delta, step)` more (scale up / mint)
delta < 0 → buy  `roundToStep(|delta|, step)`  (scale down / unwind), reduceOnly
close     → buy back the full current short_size, reduceOnly
```

`roundToStep` and the min/step constraints come from `contract-constraints.ts`
(`deribit:btc-perpetual` → `minSize 10, stepSize 10` USD), the same path the
signal pipeline uses.

## Synthetic mode (factor basis)

When a synthetic USD position is marked `is_factor_basis`, its `target_usd`
becomes the **account size** for signal sizing on that `(exchange, account)` —
every symbol traded on the account, not just the synthetic's own market. The
signal's factor units then read as a percent of that value
(`services/synthetic-sizing.ts`, wired into the factor pipeline in
`websocket/signal-client.ts`):

```
percent      = signal.quantity × sub.factor        // qty 1 → 1 factor = 1%
notional_usd = min(percent / 100 × target_usd, target_usd)   // one order never exceeds 100%
inverse      → order_qty = roundToStep(notional_usd, step)   // notional IS the USD quantity
linear       → order_qty = roundToStep(notional_usd / price, step)
```

Linear venues need a price: `signal.price`, else the mark/entry of a live
position on the same root. With no usable price the signal is **rejected**
(`synthetic_sizing_no_price`) — fail-closed, a wrongly sized order is worse than
a missed one. Deribit (inverse) never needs one.

The conversion runs before every contract-unit cap (`max_position_size`,
`account_sizes`, min/step), so those keep comparing like units and still apply
on top, as do the breathing-room guard and the guardrails. The applied
conversion is logged in the safety-clip trail as `synthetic_sizing_applied`
(plus `synthetic_notional_cap` when the percent implied more than 100%).

Scaling the synthetic position moves the account size with it — the basis is
looked up fresh per signal. Closing it (or turning the toggle off) restores the
plain contract-count behaviour; with no flagged position the pipeline is
byte-identical to before. The per-symbol operator caps in
`services/account-sizing.ts` are unrelated to synthetic USD and resolve as
configured row → built-in default → uncapped.

## Service API

`services/synthetic-usd.ts`:

- `computeSizing(targetUsd, holdingsBasisUsd, step, cap=2)` — pure, returns
  `{ targetUsd, leverage, shortContracts, capped }`. Unit-tested.
- `planMutation(current, nextTargetUsd, step)` — pure, returns the order side +
  qty (or a no-op) for a scale/close. Unit-tested.
- `mint / scale / close` — effectful, run under `withOrderLock` (scale-down covers
  unwinding), place the Deribit short via the adapter, settle via
  `settleAdapterOrder`, then persist the position + mutation row in one step.
  Idempotent on the position id. `scale` accepts `{ kindOverride }` so the
  rebalancer's orders log as `auto_rebalance` in the mutation history.
- `aggregateHoldingsBasis(db, exchangeManager)` — refresh the `is_manual=0`
  holdings lines from live balances × the venue mark price
  (`adapter.getLastPrice`), keyed `'<exchange>:<account>'`. Fail-closed per
  venue: a venue that cannot be priced or read lands in `failures` and never
  overwrites an existing line. Called at the top of every rebalancer tick.
- `setAutoRebalance(id, { enabled, targetPct?, bandPct?, basis? })` — per-position
  auto-rebalance config. Rejects `targetPct > leverage_cap × 100`, `bandPct`
  outside `[1, 100)`, and any basis other than `'holdings'` ('equity' is
  reserved). Disable keeps the numbers for re-enable.

## Routes

`routes/synthetic-usd.ts`, mounted at `/api/synthetic-usd`:

- `GET  /` — list positions + holdings-basis total + `rebalanceEnabled` (the
  global loop gate; the UI shows "disabled on this executor" when off)
- `GET  /holdings-basis` — basis lines + total
- `PUT  /holdings-basis` — set a manual off-exchange line
- `POST /` — mint (target USD, leverage cap check)
- `POST /:id/scale` — set a new target (up or down)
- `POST /:id/close` — buy back the full short
- `POST /:id/factor-basis` — toggle synthetic mode
- `POST /:id/auto-rebalance` — configure auto-rebalance (enabled, targetPct,
  bandPct)

## UI

A dedicated **Synthetic USD** page (sidebar entry, route `/synthetic-usd`),
built on the Terminal Luxury canon (`PageHeader`, `DashboardCard`, `EmptyState`,
`Badge`, shared `Input`/`Button`). It shows, as a clearly separate position:

- the holdings basis (live exchange lines + an editable off-exchange field, total)
- a mint form: target USD + a "100% · 1x" quick-fill + a leverage readout that
  turns red past the cap
- the open position: target, short size, leverage, status, with scale / unwind /
  close actions and a mutation history list
- a "Synthetic mode" toggle, with a badge in the page header (and next to the
  account in Settings → Sizing) while it's on

Currency/number display uses the existing `formatCurrency` / `toLocaleString`
helpers in `src/lib/utils.ts`.

## Auto-rebalance

`services/synthetic-rebalancer.ts` — an opt-in background loop that keeps the
short tracking `rebalance_target_pct` % of the holdings basis.

Gating is double and default-OFF (SPINE: the executor never decides):
`SYNTHETIC_REBALANCE_ENABLED` env flag starts the loop, and each position must
also opt in via its `auto_rebalance` flag (armed in the UI behind a
danger-money confirm).

Tick order (safety first): env gate → halt check → opted-in rows (none = zero
venue load) → one `aggregateHoldingsBasis` per tick → per position: basis-mode
check → session connected → basis staleness (`SYNTHETIC_BASIS_STALE_MS`,
manual-only basis exempt) → **drift guard** (live net via `getPositions()` vs
recorded `short_size`; a mismatch — panic flatten, signals or manual orders on
the same instrument — pauses with an alert instead of "fixing" it) → cooldown
(`SYNTHETIC_REBALANCE_COOLDOWN_MS`, persisted in `last_rebalance_at`, also
armed on order failure) → `planRebalance` (delegates clamp+round to
`computeSizing`, so decision and execution cannot diverge; a target below the
venue minimum is a skip + alert, never a close) → halt re-check → one
`service.scale(..., { kindOverride: 'auto_rebalance' })`.

The tick itself takes no order lock — `scale()` locks internally and the lock
is not reentrant. Every executed rebalance publishes `synthetic_rebalanced`
(webhook-forwarded via `ALERTABLE`); skips alert with a 15-minute throttle per
(position, reason).

If the position is also the factor basis, a rebalance moves `target_usd` and
therefore the account size used for ALL signal sizing on that account — the UI
copy calls this out on the toggle.

Env vars: `SYNTHETIC_REBALANCE_ENABLED` (gate, default off),
`SYNTHETIC_REBALANCE_INTERVAL_MS` (default 5 min),
`SYNTHETIC_REBALANCE_COOLDOWN_MS` (default 30 min),
`SYNTHETIC_BASIS_STALE_MS` (default 15 min).

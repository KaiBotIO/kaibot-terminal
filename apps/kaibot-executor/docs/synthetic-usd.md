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
| `status` | TEXT | `open` \| `closed` \| `armed` (trigger authored, nothing minted; migration 034) |
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
| `kind` | TEXT | `mint` \| `scale_up` \| `scale_down` \| `close` \| `auto_rebalance` \| `arm` \| `arm_update` \| `disarm` \| `recovery_close` |
| `meta` | TEXT | JSON, arm-cycle mutations only: planned vs realized (trigger, mark, plannedUsd, realizedUsd, avgFillPrice, capped, gapPct) |
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
- `POST /arm`, `POST /:id/arm-update`, `POST /:id/disarm` — armed (dynamic)
  synthetic, see below. Every listed row carries a computed `armed` view.

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

## Armed (dynamic) synthetic

Kai's brief: a synthetic position the desk can plan with, but that only
becomes real on the exchange once a price level is hit. Below that level the
holdings are locked in USD; above it they keep their full upside. The
protected value is defined at the **trigger**, not at the fire-time mark:
`planned floor = holdings_coin × trigger_price`.

Same carve-out as the edge hedge guard: the operator arms, the edge executes
(`services/synthetic-guard.ts`, driven by `LocalPositionManager` on the same
per-exchange tick as trails/managers/hedge guards). No server signal, no
autonomous decision.

### Lifecycle

```
arm  ──► armed ──(mark < trigger)──► open ──(mark > recovery)──► armed ──► …
             │                          │
          disarm                   disarm (detach)
             ▼                          ▼
          closed                open, plain synthetic (short kept)
```

- One row per market runs the whole cycle under the same `id`, so the
  mutation history stays continuous (`arm` → `mint` → `recovery_close` →
  `mint` → …). `arm_cycle` counts the mints.
- **Mint** goes through the same order leg as a manual mint
  (`computeSizing` against the holdings basis + leverage cap →
  `usdToNativeSize` → market sell → `settleAdapterOrder`). The row flips to
  `open` in place. What actually filled is booked (partial fills are not
  rounded up to the plan).
- **Recovery** (optional): `recoveryPrice`, or `recoveryPct` above the trigger
  the cycle fired on. Past it the short is bought back (same leg as `close`)
  and the row returns to `armed` at the **fired** trigger, never at the
  recovery level (hysteresis). The ratchet resumes from the current mark.
- **Ratchet** (optional, armed rows only): `trailPct` or `trailAbs`. The
  trigger follows the high-water mark at that distance and never moves down;
  the planned floor moves with it. An explicit new trigger via `arm-update`
  restarts the ratchet from the next mark.
- **Tolerance** (`tolerancePct`, default 0): wick margin below the trigger
  before the mint fires.
- **Disarm** on an armed row retires it without an order; on an open
  arm-cycle row it detaches the cycle and keeps the short (plain synthetic).

### Gap risk, stated plainly

Fills are market orders on the breach (stop-market semantics). A gap through
the trigger fills lower than the trigger. The short is still sized to
`holdings × trigger`, so the book ends up slightly net short below the fill by
`holdings × (trigger / fill − 1)`, and the realized floor is `holdings × fill`,
not `holdings × trigger`. Both numbers are in the mint mutation's `meta`
(`plannedUsd`, `realizedUsd`, `avgFillPrice`, `gapPct`) and the UI labels the
floor "planned" while armed and "realized" once minted. The over-hedge
(`overHedgeUsd = short notional − holdings × fill`) is in the meta, the view
and the cycle block. There are no resting limit orders in v1; `tolerancePct`
is a wick margin, not slippage protection.

The ratchet compounds on purpose: while armed the planned notional follows
the trigger (`holdings × current trigger`), so a later mint is sized to the
higher floor. Once minted nothing moves the short (no ratchet, no rebalancer).

### What it will not do

- Mint on an instrument that is not flat, or unwind when the venue net no
  longer equals the recorded short: both pause with `arm_last_error` and a
  notification. Strategy longs on the mint instrument net against the short
  (review 2026-09-04 §4.4); the guard never trades through that.
- Auto-rebalance an arm-cycle row, or use `service.close()` for the re-arm.
- Accept a dated Deribit future as the instrument (perpetuals only).
- Cap gross exposure against a strategy's own shorts on the same instrument
  (it cannot tell them apart); keep the venue stop alive.
- Evaluate on bar closes: it reads the mark every tick. Tick-level triggers
  with a tight percent ratchet mint far too often (review cost table: 93-338
  round trips a year on 1m ticks, 3-15 with a 5-10 % ratchet). Use a wide
  fixed trigger, or drive the trigger from a bar-close line as below.

### Example: bc-macro C on its own 2D EMA90 line

The only C configuration the review found sensible for bc-macro: the trigger
IS the strategy's short gate. Nothing in the guard computes the line; an
external updater (the strategy runner or an operator script) moves it on
every 2D close.

```
POST /api/synthetic-usd/arm
{ "exchange": "deribit", "accountId": "btc", "symbol": "BTC-PERPETUAL",
  "triggerPrice": <min(EMA90_2D, 0.75 × trailing 2D-close high)>,
  "holdingsCoin": <BTC on the btc account>,
  "recoveryPct": 0, "tolerancePct": 0.5, "leverageCap": 1 }

every 2D close:
POST /api/synthetic-usd/:id/arm-update
{ "triggerPrice": <min(EMA90_2D, 0.75 × trailing 2D-close high)> }
```

- `recoveryPct 0`: the short is bought back as soon as the mark is back above
  the line the cycle fired on; the row re-arms on that same line and the next
  2D update moves it.
- No `trailPct`/`trailAbs`: the cap (0.70-0.75 × trailing high, ETH 0.70) is
  the updater's job, applied before the update call. An explicit trigger
  update while the short is open is refused; update the line on the next
  re-arm instead (the review's "confirm 1" is that one-bar delay).
- `tolerancePct` is only an intrabar wick margin; the review's numbers assume
  2D-close evaluation, which the guard approximates, not reproduces.
- Expect roughly 5 (BTC) / 3.6 (ETH) round trips a year, gap 1.4-4 % on 1D
  bars, and no funding accounting until `funding_rates` exists.

### Holdings convention (per account, never summed)

An arm-cycle row carries its own collateral: `arm_holdings_coin`, given by the
operator or derived from this account's venue basis line
(`<exchange>:<account>`) at the mark. Manual lines and other accounts' lines
never enter it, so a BTC row is never capped by ETH holdings. The leverage cap
(arm, update, mint) measures `holdings × trigger` against `holdings × mark`;
at mint the fire-time mark is used and stored as `holdings_basis_usd`. This
is collateral-only (sim parity): unrealized strategy P&L is not part of it.
The manual mint keeps the summed basis it always had.

### Sizing basis before the mint (Kai, 04/09)

An armed row can carry `is_factor_basis`. `getSyntheticSizingBasis` then
lends signals on that (exchange, account) a `basisUsd` by phase
(`services/synthetic-sizing.ts` `syntheticBasisUsd`):

| phase | basisUsd | kind |
|---|---|---|
| armed | holdings × trigger (planned floor, follows the ratchet) | `armed` |
| open, arm cycle | holdings × fill (realized floor) | `realized` |
| open, plain | `target_usd` | `open` |

Factor units stay percent of that value (1 = 1 %), every symbol on the
account, inverse (notional = quantity) and linear (usd / price) alike. The
flag survives armed → open → armed; the recovery buy-back never touches it.
Disarming an armed row that is the basis clears the flag, logs a warning and
publishes an `error` notification: signals on that account fall back to plain
contract sizing.

One basis per **(exchange, account)**, not per executor (migration 034 swaps
the old executor-wide partial index): two Deribit connections × BTC/ETH each
size on their own armed row (`btc`, `eth`, `acct1/btc`, `acct1/eth`).
Flagging a row only unflags rows on the same account.

The rebalancer never sees an armed basis (open-only candidate list, and the
per-row refusal); the leverage cap on an armed row measures the planned
floor against holdings × mark, unchanged.

### Accounting

- `GET /api/synthetic-usd` lists armed rows next to open ones. Every row has
  an `armed` view: `protectedUsd` + `protection: 'planned' | 'realized'`,
  `distanceToTriggerPct`, `upsideUsd` (value above the floor still riding the
  market; 0 once locked), `recoveryLevel`, fired trigger/fill, cycle.
- `assemblePortfolio` (`/api/ops/portfolio` and the companion snapshot)
  carries a separate `syntheticUsd` block (`protectedPlannedUsd`,
  `protectedRealizedUsd`, rows). Synthetic rows never enter `positions`.
- An armed row IS a factor basis when flagged (planned floor, see above) but
  is never auto-rebalanced. `setAutoRebalance` rejects any row in an arm
  cycle, also in its open phase: the guard sizes to the trigger and unwinds
  on recovery, a rebalancer would fight it.

### Safety

- State lives only in the row; a restart resumes from the DB. Before minting,
  the guard reads the live positions on the instrument: a short that matches
  the plan (within a step or 2 %) is adopted as our mint whose persist never
  happened (`meta.adopted`); any other live position blocks the mint with
  `arm_last_error` (it would net against it, the runbook's synthetic-mint
  conflict) and the operator resolves.
- A rejected or unfilled order leaves the row armed, records
  `arm_last_error`, notifies once per distinct error and retries next tick.
- Overlapping ticks cannot double-fire: an in-flight set per row plus the
  status re-read inside the mint.
- Mint, unwind and failure publish `synthetic_armed_minted` /
  `synthetic_armed_closed` / `synthetic_armed_failed`; all three are in the
  external-alert set (real-money autonomous orders).

### Contract types

- Deribit inverse (`BTC-PERPETUAL`): the order amount IS the USD notional;
  `short_size` is USD, as before.
- Linear (`*_USDC-PERPETUAL`): `usdToNativeSize` converts USD → coin at the
  venue mark (fail-closed without a price); `short_size` is the coin quantity,
  `target_usd` the notional. The buy-back uses the stored native quantity.

### Kay's desk: migration path

An already-minted synthetic short can join a cycle without a break:
`POST /arm` on a market that has an open plain position attaches the cycle
(trigger, holdings, recovery) to that row. It counts as fired at the trigger;
once the mark recovers past the recovery level the short is bought back and
the row re-arms at the trigger. Detach (`disarm`) at any time keeps the short.

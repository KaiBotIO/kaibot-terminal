# Edge hedge guard

Closes the "hedge machinery on the edge" gap from the semi-auto review
(`docs/reviews/2026-08-24-kay-semi-auto-automations.md` §3 row 10). The user
arms a protective hedge on an open position the way they arm a stop: trigger,
sizing and wind-down policy are authored up front; the executor only executes.
Same carve-out as exits/rollover — no server signal, no autonomous decision.

Scope note: this is EDGE execution only. The sim/backtester keeps its own
dual-slot hedge engine (`docs/todos/dual-slot-hedge-engine.md`,
`docs/todos/reverse-automation-hedge.md`) — no strategy logic lives here and
the sim chain is untouched. The edge manager runtime's protect/reduce-only
sanitizer is also untouched: the hedge is a dedicated service
(`node-backend/src/services/hedge-guard.ts`), not a widened manager action
channel.

## Why a different instrument

One venue instrument holds one net position. A hedge on the SAME instrument
would net the main position away on the venue — the exact conflict the
synthetic-USD runbook documents for mint-shorts against open longs. The hedge
is therefore an opposite position on the PAIRED instrument:

- `BTC-PERPETUAL` ↔ `BTC_USDC-PERPETUAL` (and ETH etc.; derived automatically
  on Deribit, overridable; other venues need an explicit `hedgeSymbol`).
- The hedge gets its own position key (`pos:{exchange}:{account}:{symbol}`) so
  every existing edge subsystem (group links, trail/stop owner, managers,
  manual-position markers) works unmodified.
- The hedge changes net delta, not the synthetic-USD value: the synthetic
  short on the inverse instrument is never traded against, so the rebalancer's
  drift guard stays quiet.
- At open, the hedge leg is auto-linked into the main position's group
  (created `manual` "SYMBOL + hedge" when the main had none) — the pair shows
  as one unit with net PnL in the Groups overview.

This is the one structural deviation from the legacy addon, which kept a
virtual LEG book netting on the venue. The new system has no leg book; the
paired instrument gives the same delta protection with real, separately
manageable positions.

## Semantics (legacy `kaibotautomationaddon` parity)

| Aspect | Legacy (`handleHedging`, decisionFlow.ts) | Edge hedge guard |
|---|---|---|
| Trigger | adverse breach of `referencePrice` / `startHedgingAfter` (long: price below, short: price above) | `triggerPrice`, same compare, evaluated on the tick loop's mark of the MAIN instrument |
| Already-breached arm | fires on the next tick | same (the UI shows the adverse side as placeholder) |
| Sizing | flat hedge = configured `quantity`; dynamic hedge = \|underwater position\| | `fixed-usd` (USD notional — Deribit inverse contracts ARE USD) / `match` (main's USD notional at trigger time, converted via the shared coin/USD sizing) |
| Execution | market, immediate | reduce-only=false market on the hedge instrument, order lock + durable settlement row (roll idiom) |
| One-shot | `hedgePositionId` guard blocks a second hedge forever | status machine armed → hedged; re-arm is a new explicit arm |
| Parent lock while hedged | `positionLock` + `enabled:false` | n.a. — the edge never originates entries; the main's resting rungs are NOT cancelled (legacy leaves the ladder standing) |
| Wind-down, main closes | hedge automation frozen (`positionLock`), leg stays | `onMainClose: 'keep'` (default): status `orphaned`, leg stays, notification; `'close'` (opt-in): hedge flattened at market |
| fullRecovery unwind | size-equality on the DCA pair closes both legs | `recoveryPrice` (optional): mark recovering past it (main's favourable direction) closes the hedge. Deviation: a flat edge hedge has no growing leg, so a price level replaces size-equality. Closing BOTH legs = the existing group close. |
| Hedge closed externally | not tracked | detected on the next tick, guard retires (`hedge-closed-externally`) |
| Rejected hedge order | swallowed, retried every tick | stays armed, retried each tick; `lastError` recorded, one notification per distinct failure |
| Hedge on the hedge | forbidden (`shouldHedge=false` on the clone) | the guard manages one leg; nothing stops the operator arming a guard on the hedge position itself (it is a normal position) |

## Surfaces

- Service: `node-backend/src/services/hedge-guard.ts` (pure trigger/sizing
  rules exported for tests), table `hedge_guards` (migration 033).
- Tick: `LocalPositionManager` drives `tickExchange` on the same frozen
  per-exchange position snapshot as trails/managers; an armed guard alone is
  enough to poll its exchange.
- API: `POST /api/trade/hedge` `{action: arm|update|disarm|close, exchange,
  symbol, accountId?, triggerPrice, hedgeSymbol?, hedgeAccountId?, sizeMode?,
  fixedUsd?, recoveryPrice?, onMainClose?}`; `GET /api/trade/hedge` lists all
  guards. While hedged, only `recoveryPrice`/`onMainClose` are updatable.
- UI: Hedge section in ManagePositionDialog (arm/update/disarm/close, status,
  open-leg strip, last error).
- Companion: hedge lifecycle publishes `hedge_opened` / `hedge_closed` /
  `hedge_orphaned` / `hedge_failed` on the notification bus — visible through
  the existing notification channel.

## Operational notes

- The hedge leg is tracked as a manual-position marker so the reconciler never
  "corrects" it away; closing the hedge reduces the marker.
- On Deribit the hedge account follows the instrument's settle currency
  (`usdc` for `_USDC`, else `btc`/`eth`) — margin for the hedge leg comes from
  that account's collateral.
- Fail-closed sizing: a linear hedge leg with no price, or a size below the
  instrument minimum, blocks the open (guard stays armed, error surfaced).
- An `unknown` open outcome proceeds to `hedged` with the settlement row left
  for the reconciler (same rule as the roll's open leg): a tracked maybe-hedge
  beats a silent retry loop.

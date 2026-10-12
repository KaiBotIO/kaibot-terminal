# COMP-1 — Executor autonomous-decision inventory

Hand-off plan for the api team. The executor must never decide a trade: every
action (entry, exit, stop move, take-profit, close, cancel) must arrive as a
server-emitted signal over the websocket. This is the full inventory of where it
currently decides on its own.

Audit scope: `apps/kaibot-executor/node-backend/src`. Line numbers verified
against the working tree on 2026-06-20 (paths relative to that dir).

> Moving these server-side touches `apps/api` and the server-side
> position-manager/signal pipeline — out of scope for the executor app, so this
> doc only lists the sites + the intended server replacement. No executor code
> is changed for COMP-1 (the audit is report-only). A clean removal of V1 from
> the executor should land **together** with the server-side replacement so a
> position is never left unmanaged in between.

---

## V1 — Local trailing-stop / break-even move  (TRUE VIOLATION, the known one)

**What it decides:** moves the protective stop toward profit (and floors it at
break-even + fee buffer) whenever the locally-observed mark price advances past
the water mark by the configured trail distance. The executor decides *when* and
*to what price* to move the stop, then cancels the old SL and places a new one.

**Trigger:** local `setInterval` poll (3s) → `adapter.getPositions()` →
`live.markPrice`. No inbound signal drives the move. Only the trail *parameters*
(`order_plan.trail.percentage/points/max*`) come from the server signal; the
moment-to-moment stop and the order amend are purely local.

**Sites:**
- `services/local-position-manager.ts:18` `DEFAULT_TICK_MS = 3_000`
- `services/local-position-manager.ts:32-34` `start()` / `setInterval` poll loop
- `services/local-position-manager.ts:66` polls `getPositions()`, `:85` reads `markPrice`
- `services/local-position-manager.ts:108` `nextStop(config, extreme, row.current_stop)` — local stop decision
- `services/local-position-manager.ts:140` cancels old SL, `:149` places new SL, `:162` persists `currentStop`
- `services/local-trailing.ts:54-100` the pure maths (`computeTrailingStop` / `computeBreakevenStop` / `nextStop`)
- `websocket/signal-client.ts:898` `upsertLocalTrailState(...)` on entry fill registers the position into the local trail loop (when `order_plan.trail` present)
- `main.ts:201` constructs, `main.ts:816` `localPositionManager.start()` (unconditional), `main.ts:851` `stop()`

**Server-side replacement (already exists and is wired):** the server's
`position-manager-runner` computes the stop and emits a `stop_update` signal; the
executor already handles it purely as execution in
`websocket/signal-client.ts:1005` `handleStopUpdate` (dispatched at `:441-442`).
That handler's own contract comment states "the server decides the stop; the
executor only re-places the order — it never computes a stop itself." The fix:
the server takes over trailing + break-even via `stop_update` signals; the
executor deletes the local trail loop (`LocalPositionManager` +
`local-trailing.ts`) and the `upsertLocalTrailState` registration.

**Gating:** NONE. Started unconditionally in every mode. Recommended interim
step (executor-side, when the team is ready): put `localPositionManager.start()`
behind a default-OFF `EXECUTOR_LOCAL_TRAILING` env flag so the violation is dark
by default while the server-side path is validated, then remove entirely
(ROADMAP item COMP-1). Not done here — COMP-1 is report-only in this pass.

---

## B1 — Settlement-timeout auto-cancel of a working order  (BORDERLINE)

**What it decides:** if a placed entry/close order hasn't reached a terminal
status within the local poll window (~10s; `20 × 500ms`), the executor cancels
that working order on a local timer — no server `cancel` signal involved.

**Sites:**
- `services/order-settlement.ts:107` (window expired → `:112` `cancelOrder(orderId)`)
- reached from entry/close/DCA paths in `websocket/signal-client.ts` (`settleEntry`/`settleClose`/DCA rungs via `settleAdapterOrder`)

**Trigger:** local settlement timer, not a server `cancel`.

**Server-side replacement:** the server already owns order expiry via the
pending-sweeper — it emits a `cancel` signal, handled benignly in
`websocket/signal-client.ts:1106` `handleCancel` (dispatched at `:449`). Ideally
the executor only *observes/settles* the outcome and leaves cancellation of an
unfilled order to a server `cancel` signal.

**Severity:** borderline — it's defensive plumbing around an unconfirmed order
(the post-cancel poll re-reads the real terminal state), not a strategy
decision. Flagged per the brief. Low priority vs V1.

---

## Guards — executor refusing / clipping a server signal  (safe, but it overrides the server)

These don't invent a trade; they refuse or reduce a server-decided one based on
local config. Keep, but be aware the executor is overriding the server. None are
COMP-1 violations.

| ID | Site | Behaviour |
|----|------|-----------|
| G1 | `websocket/signal-client.ts:521` (count `:2328`) | refuse to open when live open count ≥ `max_concurrent_trades` |
| G2 | `services/account-sizing.ts:86` (`clipToAccountSize`), call site `signal-client.ts:539` | cap/zero the size of a server-specified open (kill-switch at cap 0); only ever reduces |
| G3 | `services/market-guard.ts:30`, call sites `signal-client.ts:651`, `reconciler.ts:219` | refuse a market order when the venue's last trade is stale (fail-closed) |
| G4 | `signal-client.ts:392` (paused), `:461` (market filter), `:454` (invalid qty) | refuse on local subscription config |

---

## Benign — local mechanics executing a server-decided plan, or read/report only

Not violations. Listed so the api team knows what NOT to move.

- **Bracket/SL/TP placement** `signal-client.ts:807-889` — places SL/TP at the prices the server put in the signal payload.
- **`order-ladder.ts` (whole file)** — pure helpers turning the server's `order_plan` into legs; no I/O, no decisions.
- **DCA rung placement** `signal-client.ts:1789` — places the resting rungs the server specified.
- **OCO sibling-cancel-on-fill** `signal-client.ts:2247` — cancels the sibling leg of a server-placed bracket on a real exchange fill (wired `main.ts:237`); executes the consequence of a fill, not a local price decision.
- **`handleStopUpdate`** `signal-client.ts:1005`, **`handleCancel`** `:1106`, **`executeCloseSignal`** `:1196` — all server-signal driven.
- **`reconciler.ts`** — places reduce-only corrections to drive broker net toward the net implied by *executed server signals*, under heavy safeguards; state reconciliation, not an invented action. Env-gated (`RECONCILE_*`).
- **`balance-poller.ts`, `quote-cache.ts`, `portfolio-shipper.ts`** — report/cache only; no order ops.

---

## Summary

| Item | Type | Priority | Server replacement |
|------|------|----------|--------------------|
| V1 local trailing | TRUE violation | HIGH | server `stop_update` (exists; `handleStopUpdate`) |
| B1 settlement cancel | borderline | LOW | server `cancel` (exists; `handleCancel`) |
| G1-G4 guards | override, safe | keep | n/a |
| brackets/ladders/OCO/reconciler/pollers | benign | keep | n/a |

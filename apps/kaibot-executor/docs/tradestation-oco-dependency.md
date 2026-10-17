# TradeStation: no reduce-only — single-close depends on the executor's OCO tracker

TradeStation WebAPI v3 (`/v3/orderexecution/orders`) has **no reduce-only /
close-only flag** for futures orders. The order JSON is AccountID / Symbol /
Quantity / OrderType / TradeAction / TimeInForce / AdvancedOptions — nothing in
it can tell the broker "this order may only shrink the position". `TradeAction`
for futures is plain BUY/SELL. OSO/OCO order groups
(`/v3/orderexecution/ordergroups`) sequence and cancel child orders; they do
not add reduce-only semantics either. Verified against the API docs 2026-08-07;
matches what the kaibot-exec port found against the live API.

## Consequence

The executor sets `reduceOnly: true` on every protective leg (SL, TP ladder,
close, reconciler correction). The TradeStation adapter **cannot forward it**
(`tradestation-couchdb.ts` `placeOrder`, see the inline note). So at the
broker, a stop that triggers after the position is already flat is a normal
market order: it **opens a reverse position**.

What actually guarantees single-close on TradeStation is the executor's own
exchange-agnostic **OCO cancel-on-fill tracker** (signal-client
`trackBracket` / bracket-pairs persistence): when one bracket leg fills, the
sibling leg is cancelled at the venue. Bracket pairs are persisted
(`bracket_pairs`, rehydrated on boot), so the cancel survives a restart.

## Operational implications

- **The executor process must be up** for the sibling cancel to fire. Legs rest
  at the venue with GTC (`resolveTradeStationTif`), so protection survives an
  executor outage — but if a leg fills while the executor is down, the sibling
  stays working until the executor comes back and the settlement/reconcile pass
  cancels it. Until then a late trigger can open a reverse position.
- Anything that bypasses the executor (closing by hand in the TS platform)
  leaves the resting legs behind. Cancel them there too, or let the reconciler
  flag the working orders it didn't expect.
- Per-account fallout is bounded by the account-routing guards: every order
  carries an explicit AccountID, so a stray reverse position lands on the
  account that held the bracket, never on another one.

## If broker-native protection is ever wanted

TradeStation's own bracket route is submitting entry + exits as one OSO group
(`/v3/orderexecution/ordergroups`, Type BRK/OCO) so the venue manages the
sibling cancel. That needs a redesign of the entry+bracket submit flow (today:
entry first, legs placed after the fill) — tracked as a deliberate decision,
not a quick patch.

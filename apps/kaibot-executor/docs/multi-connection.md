# Multiple connections per exchange

Two Deribit accounts (each with its own API key, BTC and ETH on both) in one
executor. Before this the executor knew one connection per (user, exchange):
`exchange_connections.id = "<user>:<exchange>"`, sessions via
`exchangeManager.getSession(userId, exchange)`. TradeStation already ran three
broker accounts under ONE session, routed by `accountId`; this extends the
same idea to venues where a second account means a second API key.

## Model

| Piece | Rule |
|---|---|
| Connection row | `exchange_connections.label` (migration 035). The pre-existing row keeps id `<user>:<exchange>` and label `default`; a second connection gets id `<user>:<exchange>:<label>`. Unique on (user, exchange, label). |
| Label | `^[a-z0-9][a-z0-9-]{0,31}$`, never `default`. No `:` (session ids), no `/` (account namespacing). |
| Session | `getSession(userId, exchange)` = default connection, bit-for-bit as before. `getSession(userId, exchange, accountKey)` = the labeled one. `getSessions(userId, exchange)` = all, default first. `sessionForAccount(userId, exchange, accountId)` routes by the account id. |
| Account identity | Stays `(exchange, account, symbol)` in every table. A labeled connection's adapter is wrapped (`account-scope.ts`, `scopeAdapter`): every account id it returns is `<label>/<venueAccount>` (`acct2/btc`), every account id it receives on an order/cancel/status is stripped back to the venue's id. So `btc` and `acct2/btc` on `BTC-PERPETUAL` are two lineages with no new columns. `Position.id` gets `@<label>` for the same reason. |
| Routing | The account id says where an order goes: `accountKeyOf('acct2/btc') = 'acct2'`, `accountKeyOf('btc') = undefined` (default). Services resolve `getSession(userId, exchange, accountKeyOf(accountId))`. |
| Subscription | `executor_subscriptions.account_key` (label; NULL = default). Entry sizing account = `account_id ?? <label>/<per-symbol venue account>`; the close, brackets, DCA rungs, settlements and retries route via the account recorded on their rows. |
| Brackets | `bracket_pairs.account_id` so an OCO sibling cancel after a restart lands on the right connection. |
| Caches | Signal-client position/balance caches are per connection (`exchange|label`). |
| Reconciler | Untouched. TradeStation only, default connection. Deribit stays outside the reconcile allowlist. |
| OAuth | Default connection only (the callback `state` carries the user id, not a label). A second TradeStation login is not supported by this change. |

## API

- `POST /api/exchanges/v2/connect` `{ exchangeName, credentials, label? }`
- `POST /api/exchanges/v2/disconnect` `{ exchangeName, label? }`
- `GET /api/exchanges/v2/sessions` rows carry `label`, `accountKey` (null on default), `connectionId`.
- `GET /api/exchanges/v2/{accounts,balances,positions}/:exchange` aggregate every connection on the exchange; `?account=<label>` narrows to one. Rows carry `accountKey`.
- `GET /api/exchanges/v2/:exchange/details?account=`, `POST /:exchange/refresh?account=`.
- `POST /api/exchanges/v2/order` routes by `order.accountId` (or an explicit `label`).
- Subscriptions: `accountKey` on create/patch/list. Rejected when it names no connected label or clashes with a namespaced `accountId`.
- `/api/positions` and the portfolio snapshot carry `accountKey` per position.

## UI (Terminal)

- Exchanges: one row per connection (`deribit` + badge `acct2`), disconnect per row, detail page at `/exchanges/deribit?account=acct2`.
- Add exchange: API-key forms have an optional "Connection label" field.
- New subscription: the venue step lists connections (`deribit`, `deribit acct2`); the broker-account picker follows the chosen connection.
- Manual trade: connection picker; the account list is scoped to it and the picked `accountId` carries the connection.

## Service contract (for the synthetic-USD / hedge / manager services)

Every edge service that resolved an adapter with `adapterFor(exchange)` now
takes the account: `adapterFor(exchange, accountId)` →
`exchangeManager.getSession(userId, exchange, accountKeyOf(accountId))`.
Pass the account id already on the row (`account_id`, `hedge_account_id`,
`input.accountId`). A bare id resolves to the default connection, so a service
that never sees a labeled account keeps its old behaviour.

Per-connection loops (LocalPositionManager, hedge `tickExchange`) iterate
`getSessions(userId, exchange)` and hand each row only to the session whose
`adapterAccountKey(adapter)` equals `accountKeyOf(row.account_id)`.

Test fakes with a bare `getSession(userId, exchange)` keep working: the extra
argument is ignored and `sessionsForExchange` falls back to that one session.

## Operator notes

- Connecting the second Deribit account: Exchanges → Add exchange → Deribit,
  fill in the key, set label (e.g. `acct2`). The first account stays the
  default connection and needs nothing.
- Existing subscriptions, trails, guards and groups keep their bare account ids
  and keep routing to the default connection.
- Balance snapshots, guardrails and margin guards key on the namespaced account
  (`acct2/btc`), so each connection gets its own rails.

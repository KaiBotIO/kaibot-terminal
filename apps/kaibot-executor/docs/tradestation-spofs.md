# TradeStation setup: known single points of failure (documented, not fixed)

Both are deliberate: changing them is an owner decision, not a patch. Listed so
nobody discovers them during an incident.

Owner decision 2026-08-16: both accepted for now — the shared CouchDB session
stays until a per-account OAuth setup is worth the effort.

## One shared CouchDB session token for all broker accounts

The adapter reads one OAuth access token from legacy KaiBotWeb's CouchDB
(`COUCHDB_TS_SESSION_ID`); that token grants all TradeStation accounts at once.
Legacy kaibotweb owns the refresh — the executor only re-reads on 401, it never
refreshes itself and there is no retry in the legacy refresher. Token death
stops **every** account simultaneously, and only the owner can re-link on
classic.kaibot.io. There is no per-account session concept.

## Global halt / panic

`executor_halt` is a single row: a daily-loss trip (or panic) on one account
halts opens on **all** accounts and venues. Acceptable as a safety default —
halting too much is the safe direction — but there is no per-account halt.
Closes and cancels are never halted.

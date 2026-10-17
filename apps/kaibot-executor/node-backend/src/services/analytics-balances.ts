// Period-start account equity: the denominator of the Analytics max DD %.
//
// Fallback chain per (exchange, account):
//   1. the first poller tick at or after the period start;
//   2. else the last tick before it;
//   3. else null (UI "—"). /account-sizes holds contract caps, not money, so
//      it can't stand in for a balance.
// A tick holds one row per coin wallet (Bybit UTA: USDT next to BTC/ETH/SOL
// collateral), so the account figure is the SUM of usd_equity over that tick.
// Unpriced wallets are left out; a sum that isn't > 0 counts as unknown.

import type { KaiBotDatabase } from '../storage/database.js'
import { accountBalanceKey, accountsOf, type AccountBalances, type ClosedRow } from './analytics.js'

/** Period start for the analytics window: the filter's from, else the first trade in view. */
export function periodStartOf(from: number | null | undefined, rows: ClosedRow[]): number | null {
  if (from != null) return from
  if (rows.length === 0) return null
  return rows.reduce((min, r) => (r.openDate < min ? r.openDate : min), Infinity)
}

export function buildAccountBalances(
  db: Pick<KaiBotDatabase, 'getAccountEquityUsdAt'>,
  rows: ClosedRow[],
  periodStart: number | null,
): AccountBalances {
  const out: AccountBalances = new Map()
  if (periodStart == null) return out
  for (const a of accountsOf(rows)) {
    const equity = a.exchange ? db.getAccountEquityUsdAt(a.exchange, a.accountId, periodStart) : null
    out.set(accountBalanceKey(a.exchange, a.accountId), equity != null && equity > 0 ? equity : null)
  }
  return out
}

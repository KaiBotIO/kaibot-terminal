import type { KaiBotDatabase } from '../storage/database.js'

/**
 * Why opens on this exchange+account are refused, or null when it isn't
 * halted. One message for every open path (signal, manual, synthetic mint,
 * synthetic rebalance). Test doubles may omit getAccountHalt: not halted.
 */
export function accountHaltReason(db: KaiBotDatabase, exchange: string, accountId: string | null | undefined): string | null {
  if (!accountId || typeof db.getAccountHalt !== 'function') return null
  const halt = db.getAccountHalt(exchange, accountId)
  return halt ? `account ${exchange} ${accountId} halted (${halt.reason ?? 'manual'}); not opening new positions` : null
}

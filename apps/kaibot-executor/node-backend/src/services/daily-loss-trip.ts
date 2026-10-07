// Daily-loss trip for one exchange+account, shared by the signal path and the
// manual path. The limit is configured per account, so only that account's
// positions close and only that account halts; other venues and accounts keep
// trading (06/10: a Deribit loss on the TS limit flattened every venue).

import type { KaiBotDatabase } from '../storage/database.js'
import type { ExchangeManager } from './exchanges/exchangeManager.js'
import { notificationBus } from './notifications/notification-bus.js'
import { panicCloseAccount, type PanicReport, type PanicScope } from './panic.js'

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export interface DailyLossTrip {
  realized: number
  limit: number
  userId?: string
}

const usd = (n: number) => `$${Math.abs(n).toFixed(0)}`

export function dailyLossTripMessage(scope: PanicScope, trip: DailyLossTrip, report: PanicReport | null): string {
  const head = `${scope.exchange} ${scope.accountId}: realized -${usd(trip.realized)} today, limit ${usd(trip.limit)}.`
  if (!report) return `${head} Nothing closed (flatten failed or no venue connection), account halted anyway.`
  const closed = report.results.filter((r) => r.ok).map((r) => `${r.symbol} ${r.size}`)
  const failed = report.results.filter((r) => !r.ok).map((r) => `${r.symbol} ${r.size}`)
  const parts = [head, closed.length ? `Closed: ${closed.join(', ')}.` : 'No open positions to close.']
  if (failed.length) parts.push(`Close FAILED: ${failed.join(', ')}.`)
  parts.push('Account halted, other accounts keep trading.')
  return parts.join(' ')
}

/** Flatten + halt one account. The halt holds even when the flatten errors. */
export async function tripDailyLoss(
  db: KaiBotDatabase,
  exchangeManager: ExchangeManager | null | undefined,
  scope: PanicScope,
  trip: DailyLossTrip,
): Promise<PanicReport | null> {
  let report: PanicReport | null = null
  try {
    if (exchangeManager) {
      report = await panicCloseAccount(db, exchangeManager, scope, { halt: true, reason: 'daily_loss', userId: trip.userId })
    } else {
      db.setAccountHalt(scope.exchange, scope.accountId, true, 'daily_loss')
    }
  } catch (err) {
    db.setAccountHalt(scope.exchange, scope.accountId, true, 'daily_loss')
    db.log('error', 'guardrail', 'Daily-loss flatten failed, account halted anyway', { ...scope, error: errMsg(err) })
  }
  notificationBus.publish({
    type: 'error',
    title: `Daily-loss limit hit: ${scope.exchange} ${scope.accountId}`,
    body: dailyLossTripMessage(scope, trip, report),
    data: {
      exchange: scope.exchange,
      accountId: scope.accountId,
      realized: trip.realized,
      limit: trip.limit,
      guard: 'daily-loss limit',
      closed: report?.results.filter((r) => r.ok).map((r) => ({ symbol: r.symbol, size: r.size, orderId: r.orderId })) ?? [],
      failed: report?.results.filter((r) => !r.ok).map((r) => ({ symbol: r.symbol, size: r.size, error: r.error })) ?? [],
    },
  })
  return report
}

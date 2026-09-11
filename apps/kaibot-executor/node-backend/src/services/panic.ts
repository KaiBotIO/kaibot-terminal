// PANIC — offline-proof close-all.
//
// Reads every connected adapter's OPEN positions directly and closes each at
// market with a reduce-only order, straight through the exchange adapter — NOT
// via a cloud signal. The executor holds the keys and talks to the venue itself,
// so this still flattens when the cloud / WS is down (the whole reason it lives
// here and not server-side). Every action is audit-logged.
//
// Side / quantity come from the LIVE position (the exchange is the source of
// truth), mirroring executeCloseSignal: close side is opposite the position side,
// reduce-only so it can only ever shrink the position, market so it fills now.

import type { KaiBotDatabase } from '../storage/database.js'
import type { ExchangeManager } from './exchanges/exchangeManager.js'
import type { Order, Position } from './exchanges/types.js'

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export interface PanicCloseResult {
  exchange: string
  symbol: string
  accountId: string
  side: 'buy' | 'sell' // the flattening side (opposite the position)
  size: number
  ok: boolean
  orderId?: string
  error?: string
}

export interface PanicReport {
  closed: number // positions where the close order was accepted
  failed: number // positions where the close order errored
  results: PanicCloseResult[]
  halted: boolean // whether the local halt flag was set ('panic & halt')
}

/**
 * Close every open position across all connected exchanges at market via the
 * adapters directly. `halt` also sets the local halt flag so the signal-client
 * stops acting on further inbound signals until it's cleared.
 *
 * Per-position failures are isolated (one venue erroring doesn't abort the rest)
 * and every attempt is audit-logged. The realized exit isn't attributed back to
 * any signal here — panic is a blunt safety action, not signal bookkeeping; the
 * reconciler picks up the resulting flat state on its next pass.
 */
export async function panicCloseAll(
  db: KaiBotDatabase,
  exchangeManager: ExchangeManager,
  opts: { halt: boolean; userId?: string; reason?: string } = { halt: false },
): Promise<PanicReport> {
  const userId = opts.userId ?? 'default'
  db.log('warn', 'trading', 'PANIC invoked: closing all positions', {
    halt: opts.halt,
    reason: opts.reason ?? 'manual',
  })

  const results: PanicCloseResult[] = []

  // Halt FIRST when requested, so any signal racing in while we flatten is
  // already gated. Clearing is a deliberate separate user action.
  if (opts.halt) {
    db.setHaltState(true, opts.reason ?? 'panic')
    db.log('warn', 'trading', 'PANIC: executor halted (will ignore inbound signals until re-enabled)', {})
  }

  const sessions = await exchangeManager.getAllSessions(userId)
  for (const session of sessions) {
    if (session.status !== 'connected') continue
    const exchange = session.exchangeName
    let positions: Position[] = []
    try {
      positions = await session.adapter.getPositions()
    } catch (err) {
      db.log('error', 'trading', 'PANIC: getPositions failed', { exchange, error: errMsg(err) })
      continue
    }

    for (const p of positions) {
      const size = Math.abs(p.size)
      if (size <= 0) continue
      const side: 'buy' | 'sell' = p.side === 'long' ? 'sell' : 'buy'
      const order: Order = {
        accountId: p.accountId,
        symbol: p.symbol,
        side,
        orderType: 'market',
        quantity: size,
        reduceOnly: true,
        label: `kaibot:panic:close`,
      }
      try {
        const result = await session.adapter.placeOrder(order)
        results.push({ exchange, symbol: p.symbol, accountId: p.accountId, side, size, ok: true, orderId: result.orderId })
        db.log('warn', 'trading', 'PANIC: close order placed', {
          exchange,
          symbol: p.symbol,
          accountId: p.accountId,
          side,
          size,
          orderId: result.orderId,
          status: result.status,
        })
      } catch (err) {
        results.push({ exchange, symbol: p.symbol, accountId: p.accountId, side, size, ok: false, error: errMsg(err) })
        db.log('error', 'trading', 'PANIC: close order failed', {
          exchange,
          symbol: p.symbol,
          accountId: p.accountId,
          side,
          size,
          error: errMsg(err),
        })
      }
    }
  }

  const closed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok).length
  db.log('warn', 'trading', 'PANIC complete', { closed, failed, halted: opts.halt })
  return { closed, failed, results, halted: opts.halt }
}

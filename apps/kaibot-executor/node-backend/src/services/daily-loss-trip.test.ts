import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { KaiBotDatabase } from '../storage/database.js'
import { notificationBus, type NotificationEvent } from './notifications/notification-bus.js'
import { tripDailyLoss } from './daily-loss-trip.js'
import type { ExchangeManager } from './exchanges/exchangeManager.js'
import type { Order, Position } from './exchanges/types.js'

const pos = (symbol: string, accountId: string, size = 1): Position => ({ id: `p:${symbol}`, accountId, symbol, side: 'long', size, entryPrice: 100 })

function venue(positions: Position[], failSymbols: string[] = []) {
  const placed: Order[] = []
  return {
    placed,
    async getPositions() {
      return positions
    },
    async placeOrder(o: Order) {
      if (failSymbols.includes(o.symbol)) throw new Error('rejected')
      placed.push(o)
      return { orderId: `o:${o.symbol}`, status: 'filled' as const, filledQuantity: o.quantity, averagePrice: 100 }
    },
  }
}

describe('tripDailyLoss', () => {
  let dir: string
  let db: KaiBotDatabase
  let events: NotificationEvent[]
  const listener = (e: NotificationEvent) => events.push(e)
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kaibot-dl-trip-'))
    db = new KaiBotDatabase(join(dir, 'test.db'))
    events = []
    notificationBus.on('notification', listener)
  })
  afterEach(() => {
    notificationBus.off('notification', listener)
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('closes and halts the account and names it plus what closed in the notification', async () => {
    const ts = venue([pos('MESZ26', '21084931'), pos('MNQZ26', '21084931', 2), pos('MGCZ26', '21084933')], ['MNQZ26'])
    const deribit = venue([pos('ETH-PERPETUAL', 'eth', 6424)])
    const manager = {
      async getAllSessions() {
        return [
          { adapter: ts, status: 'connected', exchangeName: 'tradestation' },
          { adapter: deribit, status: 'connected', exchangeName: 'deribit' },
        ]
      },
    } as unknown as ExchangeManager
    await tripDailyLoss(db, manager, { exchange: 'tradestation', accountId: '21084931' }, { realized: -612.4, limit: 500 })

    expect(ts.placed.map((o) => o.symbol)).toEqual(['MESZ26'])
    expect(deribit.placed).toHaveLength(0)
    expect(db.getAccountHalt('tradestation', '21084931')?.reason).toBe('daily_loss')
    expect(db.getHaltState().halted).toBe(false)

    const ev = events.find((e) => e.title.startsWith('Daily-loss limit hit'))!
    expect(ev.title).toBe('Daily-loss limit hit: tradestation 21084931')
    expect(ev.body).toBe(
      'tradestation 21084931: realized -$612 today, limit $500. Closed: MESZ26 1. Close FAILED: MNQZ26 2. Account halted, other accounts keep trading.',
    )
    expect(ev.data).toMatchObject({ exchange: 'tradestation', accountId: '21084931', closed: [{ symbol: 'MESZ26', size: 1 }], failed: [{ symbol: 'MNQZ26', size: 2 }] })
  })

  it('halts the account even when the flatten throws', async () => {
    const manager = {
      async getAllSessions() {
        throw new Error('venue down')
      },
    } as unknown as ExchangeManager
    await tripDailyLoss(db, manager, { exchange: 'deribit', accountId: 'eth' }, { realized: -800, limit: 500 })
    expect(db.getAccountHalt('deribit', 'eth')?.reason).toBe('daily_loss')
    expect(events.at(-1)?.body).toContain('Nothing closed')
  })
})

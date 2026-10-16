import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { KaiBotDatabase } from '../storage/database.js'
import type { SignalFillRow } from '../storage/types.js'
import { createManualTradeService } from './manual-trade.js'
import { closedRowsFromExecutions, isBotTrade } from './analytics.js'
import { buildStrategyLabels } from './analytics-attribution.js'

// Live 14/10: ETH-PERPETUAL 381 closed by hand with no execution and no marker
// behind it. Through the real ledger: booked, priced in analytics as a manual
// trade, and never handed to the portfolio shipper.

let dir: string
let db: KaiBotDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-manual-close-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const adapter = {
  name: 'deribit',
  async getAccounts() {
    return [{ id: 'eth', exchangeName: 'deribit', accountId: 'eth', name: 'ETH', currency: 'ETH' }]
  },
  async getPositions() {
    return [{ id: 'p', accountId: 'eth', symbol: 'ETH-PERPETUAL', side: 'long', size: 381, entryPrice: 2_465.3 }]
  },
  async placeOrder(o: any) {
    return { orderId: 'ETH-138596370755', status: 'filled', filledQuantity: o.quantity, averagePrice: 2_500.75, commission: 0.19 }
  },
  async cancelOrder() {},
}
const manager = {
  async getSession() {
    return { userId: 'default', exchangeName: 'deribit', adapter, status: 'connected' }
  },
} as any

describe('manual close of an untracked position', () => {
  it('live 14/10: ETH 381 lands in analytics as a manual trade and stays local', async () => {
    const svc = createManualTradeService(db, manager)
    await svc.close({ exchange: 'deribit', symbol: 'ETH-PERPETUAL', fraction: 1 })

    const id = 'manual-close:ETH-138596370755'
    const fills = db.getSignalFills(id) as SignalFillRow[]
    expect(fills.map((f) => [f.kind, f.qty, f.price])).toEqual([['entry', 381, 2_465.3], ['exit', 381, 2_500.75]])
    expect(db.listUnsyncedFills().filter((f) => f.signal_id === id)).toEqual([])
    expect(db.getManualPosition('deribit', 'eth', 'ETH-PERPETUAL') ?? null).toBeNull()

    const exec = db.getSignalExecution(id)!
    const rows = closedRowsFromExecutions([exec as any], new Map([[id, fills]]), buildStrategyLabels(db, [exec as any]))
    expect(rows).toHaveLength(1)
    expect(isBotTrade(rows[0]!)).toBe(false)
    expect(rows[0]).toMatchObject({ symbol: 'ETH-PERPETUAL', direction: 'long', entryAvg: 2_465.3, exitAvg: 2_500.75, commission: 0.19 })
    expect(rows[0]!.realizedPnl).toBeGreaterThan(0)
  })
})

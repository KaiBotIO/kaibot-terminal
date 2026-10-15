import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { KaiBotDatabase } from '../storage/database.js'
import { nettedClosePlan } from './netted-close.js'
import { panicCloseAccount, panicCloseAll } from './panic.js'
import { dailyLossTripMessage } from './daily-loss-trip.js'
import { notificationBus } from './notifications/notification-bus.js'
import type { ExchangeManager } from './exchanges/exchangeManager.js'
import type { Order, Position } from './exchanges/types.js'

// Bulk closes next to a floor hedge (15/10): the eth account nets the ETH
// floor hedge -12.356 with Fault Line +1.972 into one Deribit short of -10.384.
// No bulk close may buy the hedge back.

let dir: string
let db: KaiBotDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-netted-close-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function hedge(exchange = 'deribit', account = 'eth', symbol = 'ETH-PERPETUAL', short = 12_356) {
  db.insertSyntheticUsdPosition({
    id: `syn-${account}-${symbol}`, exchange, account_id: account, symbol,
    target_usd: short, holdings_basis_usd: short, leverage: 1, short_size: short, leverage_cap: 2,
  })
  db.updateSyntheticUsdPosition(`syn-${account}-${symbol}`, { arm_trigger_price: 2_471.24 })
}

function bot(id: string, direction: 'long' | 'short', qty: number, exchange = 'deribit', account = 'eth', symbol = 'ETH-PERPETUAL') {
  db.insertSignalExecution({ signalId: id, symbol, exchange, direction, status: 'open', qtyOpened: qty, accountId: account })
}

const venue = (side: 'long' | 'short', size: number, symbol = 'ETH-PERPETUAL', accountId = 'eth', exchange = 'deribit') => ({
  exchange, accountId, symbol, side, size,
})

describe('nettedClosePlan', () => {
  it('no hedge on the instrument: plain close', () => {
    bot('fl', 'long', 1_972)
    expect(nettedClosePlan(db, venue('long', 1_972), 'bots')).toEqual({ kind: 'plain' })
  })

  it('bot long inside the hedge short (the live case): blocked for bots and for PANIC', () => {
    hedge()
    bot('fl', 'long', 1_972)
    const forGroup = nettedClosePlan(db, venue('short', 10_384), 'bots')
    expect(forGroup.kind).toBe('blocked')
    expect(forGroup.kind === 'blocked' && forGroup.reason).toBe(
      'ETH-PERPETUAL: bots +1.972 netted with floor hedge -12.356 (venue -10.384). A reduce-only close can only buy back the hedge.',
    )
    expect(nettedClosePlan(db, venue('short', 10_384), 'non-hedge').kind).toBe('blocked')
  })

  it('bot short on the hedge side: reduce-only close of the bot lineage only', () => {
    hedge()
    bot('s1', 'short', 1_000)
    expect(nettedClosePlan(db, venue('short', 13_356), 'bots')).toEqual({ kind: 'partial', qty: 1_000, side: 'buy' })
  })

  it('PANIC closes everything but the hedge; the group close only its own lineage', () => {
    hedge()
    bot('s1', 'short', 1_000)
    db.addManualPosition('deribit', 'eth', 'ETH-PERPETUAL', 'sell', 500)
    expect(nettedClosePlan(db, venue('short', 13_856), 'non-hedge')).toEqual({ kind: 'partial', qty: 1_500, side: 'buy' })
    expect(nettedClosePlan(db, venue('short', 13_856), 'bots')).toEqual({ kind: 'partial', qty: 1_000, side: 'buy' })
  })

  it('only the hedge left: blocked with a pointer to the Synthetic USD page', () => {
    hedge()
    const plan = nettedClosePlan(db, venue('short', 12_356), 'non-hedge')
    expect(plan).toEqual({ kind: 'blocked', reason: 'ETH-PERPETUAL: only the floor hedge -12.356 is left. Manage it on the Synthetic USD page.' })
  })

  it('a hedge on another account leaves this one plain', () => {
    hedge('deribit', 'acct1/eth')
    bot('fl', 'long', 1_972)
    expect(nettedClosePlan(db, venue('long', 1_972), 'bots')).toEqual({ kind: 'plain' })
  })

  it('Bybit coin sizes: bot short 0,4 next to the ETH hedge -1,35', () => {
    hedge('bybit', 'unified', 'ETHUSDT', 1.35)
    bot('alt', 'short', 0.4, 'bybit', 'unified', 'ETHUSDT')
    expect(nettedClosePlan(db, venue('short', 1.75, 'ETHUSDT', 'unified', 'bybit'), 'bots')).toEqual({ kind: 'partial', qty: 0.4, side: 'buy' })
  })
})

class FakeAdapter {
  placed: Order[] = []
  constructor(public positions: Position[]) {}
  async getPositions() {
    return this.positions
  }
  async placeOrder(order: Order) {
    this.placed.push(order)
    return { orderId: `o:${order.symbol}`, status: 'pending' as const }
  }
}

const livePos = (symbol: string, side: 'long' | 'short', size: number, accountId = 'eth'): Position => ({
  id: `deribit:${symbol}`, accountId, symbol, side, size, entryPrice: 2_400,
})

function manager(adapter: FakeAdapter) {
  return { getAllSessions: async () => [{ adapter, status: 'connected', exchangeName: 'deribit', userId: 'default' }] } as unknown as ExchangeManager
}

describe('PANIC next to a floor hedge', () => {
  it('leaves the netted ETH position and a hedge-only position open, closes the rest', async () => {
    hedge()
    bot('fl', 'long', 1_972)
    hedge('deribit', 'btc', 'BTC-PERPETUAL', 7_510)
    const adapter = new FakeAdapter([
      livePos('ETH-PERPETUAL', 'short', 10_384),
      livePos('BTC-PERPETUAL', 'short', 7_510, 'btc'),
      livePos('SOL_USDC-PERPETUAL', 'long', 4, 'usdc'),
    ])
    const report = await panicCloseAll(db, manager(adapter), { halt: false })
    expect(report).toMatchObject({ closed: 1, failed: 0, skipped: 2 })
    expect(adapter.placed.map((o) => o.symbol)).toEqual(['SOL_USDC-PERPETUAL'])
    expect(report.results.filter((r) => r.skipped).map((r) => r.symbol)).toEqual(['ETH-PERPETUAL', 'BTC-PERPETUAL'])
  })

  it('closes a same-side bot leg with its own size, reduce-only, and keeps the hedge', async () => {
    hedge()
    bot('s1', 'short', 1_000)
    const adapter = new FakeAdapter([livePos('ETH-PERPETUAL', 'short', 13_356)])
    const report = await panicCloseAll(db, manager(adapter), { halt: false })
    expect(report).toMatchObject({ closed: 1, skipped: 0 })
    expect(adapter.placed).toHaveLength(1)
    expect(adapter.placed[0]).toMatchObject({ symbol: 'ETH-PERPETUAL', side: 'buy', quantity: 1_000, reduceOnly: true })
  })

  it('the daily-loss flatten keeps the hedge and says so', async () => {
    hedge()
    bot('fl', 'long', 1_972)
    const adapter = new FakeAdapter([livePos('ETH-PERPETUAL', 'short', 10_384)])
    const scope = { exchange: 'deribit', accountId: 'eth' }
    const report = await panicCloseAccount(db, manager(adapter), scope, { halt: true, reason: 'daily_loss' })
    expect(adapter.placed).toHaveLength(0)
    expect(report.skipped).toBe(1)
    expect(dailyLossTripMessage(scope, { realized: -300, limit: 250 }, report)).toContain(
      'NOT flat, left open next to a floor hedge: ETH-PERPETUAL.',
    )
  })
})

describe('R3: fail closed, small hedge, labeled connection', () => {
  it('a throwing hedge source fails the close closed: no order, failed, not flat, one alert', async () => {
    bot('fl', 'long', 1_972)
    ;(db as any).listSyntheticUsdPositions = () => {
      throw new Error('database is locked')
    }
    expect(() => nettedClosePlan(db, venue('short', 10_384), 'non-hedge')).toThrow('database is locked')

    const seen: any[] = []
    const onNote = (n: any) => seen.push(n)
    notificationBus.on('notification', onNote)
    try {
      const adapter = new FakeAdapter([livePos('ETH-PERPETUAL', 'short', 10_384)])
      const report = await panicCloseAll(db, manager(adapter), { halt: false })
      expect(adapter.placed).toHaveLength(0)
      expect(report).toMatchObject({ closed: 0, failed: 1, skipped: 0, flat: false })
      expect(report.results[0].error).toBe('hedge lookup failed, left open: database is locked')
      const notFlat = seen.filter((n) => n.title === 'PANIC: not flat')
      expect(notFlat).toHaveLength(1)
      expect(notFlat[0].body).toBe('Close FAILED: ETH-PERPETUAL.')
    } finally {
      notificationBus.off('notification', onNote)
    }
  })

  it('a missing hedge source fails closed too', () => {
    const noLister = { listOpenExecutionsForExchange: () => [] } as unknown as KaiBotDatabase
    expect(() => nettedClosePlan(noLister, venue('long', 1_972), 'bots')).toThrow('synthetic USD positions not readable')
  })

  it('hedge smaller than the bot long: blocked, PANIC reports it skipped and not flat', async () => {
    hedge('deribit', 'eth', 'ETH-PERPETUAL', 1_000)
    bot('fl', 'long', 1_972)
    const plan = nettedClosePlan(db, venue('long', 972), 'bots')
    expect(plan.kind === 'blocked' && plan.reason).toBe(
      'ETH-PERPETUAL: bots +1.972 netted with floor hedge -1.000 (venue 972). A reduce-only close can only buy back the hedge.',
    )
    expect(nettedClosePlan(db, venue('long', 972), 'non-hedge').kind).toBe('blocked')

    const adapter = new FakeAdapter([livePos('ETH-PERPETUAL', 'long', 972)])
    const report = await panicCloseAll(db, manager(adapter), { halt: false })
    expect(adapter.placed).toHaveLength(0)
    expect(report).toMatchObject({ closed: 0, failed: 0, skipped: 1, flat: false })
  })

  it('acct1/eth: the hedge binds to the labeled account only, the default eth position closes plain', async () => {
    hedge('deribit', 'acct1/eth')
    bot('a1', 'long', 1_972, 'deribit', 'acct1/eth')
    bot('d1', 'long', 500)
    expect(nettedClosePlan(db, venue('short', 10_384, 'ETH-PERPETUAL', 'acct1/eth'), 'bots').kind).toBe('blocked')
    expect(nettedClosePlan(db, venue('long', 500), 'bots')).toEqual({ kind: 'plain' })

    const adapter = new FakeAdapter([livePos('ETH-PERPETUAL', 'short', 10_384, 'acct1/eth'), livePos('ETH-PERPETUAL', 'long', 500)])
    const report = await panicCloseAll(db, manager(adapter), { halt: false })
    expect(report).toMatchObject({ closed: 1, skipped: 1, flat: false })
    expect(adapter.placed).toEqual([expect.objectContaining({ accountId: 'eth', side: 'sell', quantity: 500, reduceOnly: true })])
  })
})

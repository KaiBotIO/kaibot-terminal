import { describe, expect, it } from 'bun:test'
import { panicCloseAll } from './panic.js'
import type { ExchangeManager } from './exchanges/exchangeManager.js'
import type { KaiBotDatabase } from '../storage/database.js'
import type { Order, OrderResult, Position } from './exchanges/types.js'

// Panic flattens every open position via the adapters directly (no cloud) and
// optionally sets the local halt flag. Fakes stand in for the DB / manager /
// adapter — nothing hits a venue.

class FakeDb {
  logs: any[] = []
  halt = { halted: false, reason: null as string | null, tripped_at: null as number | null }
  log(level: string, category: string, message: string, metadata?: any) {
    this.logs.push({ level, category, message, metadata })
  }
  setHaltState(halted: boolean, reason?: string | null) {
    this.halt = { halted, reason: halted ? reason ?? null : null, tripped_at: halted ? Date.now() : null }
  }
  getHaltState() {
    return this.halt
  }
}

class FakeAdapter {
  placed: Order[] = []
  failSymbols = new Set<string>()
  constructor(public positions: Position[]) {}
  async getPositions() {
    return this.positions
  }
  async placeOrder(order: Order): Promise<OrderResult> {
    if (this.failSymbols.has(order.symbol)) throw new Error(`venue rejected ${order.symbol}`)
    this.placed.push(order)
    return { orderId: `o:${order.symbol}`, status: 'filled' }
  }
}

class FakeManager {
  sessions: Array<{ adapter: FakeAdapter; status: string; exchangeName: string }>
  constructor(sessions: Array<{ adapter: FakeAdapter; status?: string; exchangeName: string }>) {
    this.sessions = sessions.map((s) => ({ status: 'connected', ...s }))
  }
  async getAllSessions() {
    return this.sessions.map((s) => ({ ...s, userId: 'default' }))
  }
}

const pos = (symbol: string, side: 'long' | 'short', size: number, account = 'default'): Position => ({
  id: `p:${symbol}`,
  accountId: account,
  symbol,
  side,
  size,
  entryPrice: 100,
})

const build = (positions: Position[]) => {
  const db = new FakeDb()
  const adapter = new FakeAdapter(positions)
  const manager = new FakeManager([{ adapter, exchangeName: 'bybit' }])
  return { db, adapter, manager }
}

describe('panicCloseAll', () => {
  it('closes every open position with a reduce-only market order on the opposite side', async () => {
    const { db, adapter, manager } = build([
      pos('BTCUSDT', 'long', 0.5),
      pos('ETHUSDT', 'short', 3),
    ])
    const report = await panicCloseAll(db as unknown as KaiBotDatabase, manager as unknown as ExchangeManager, {
      halt: false,
    })

    expect(report.closed).toBe(2)
    expect(report.failed).toBe(0)
    expect(adapter.placed).toHaveLength(2)

    const btc = adapter.placed.find((o) => o.symbol === 'BTCUSDT')!
    expect(btc.side).toBe('sell') // long → sell to flatten
    expect(btc.reduceOnly).toBe(true)
    expect(btc.orderType).toBe('market')
    expect(btc.quantity).toBe(0.5)

    const eth = adapter.placed.find((o) => o.symbol === 'ETHUSDT')!
    expect(eth.side).toBe('buy') // short → buy to flatten
  })

  it('skips zero-size positions', async () => {
    const { db, adapter, manager } = build([pos('BTCUSDT', 'long', 0), pos('ETHUSDT', 'long', 1)])
    const report = await panicCloseAll(db as unknown as KaiBotDatabase, manager as unknown as ExchangeManager, {
      halt: false,
    })
    expect(report.closed).toBe(1)
    expect(adapter.placed.map((o) => o.symbol)).toEqual(['ETHUSDT'])
  })

  it('isolates a per-position failure and still closes the rest', async () => {
    const { db, adapter, manager } = build([pos('BTCUSDT', 'long', 1), pos('ETHUSDT', 'long', 2)])
    adapter.failSymbols.add('BTCUSDT')
    const report = await panicCloseAll(db as unknown as KaiBotDatabase, manager as unknown as ExchangeManager, {
      halt: false,
    })
    expect(report.closed).toBe(1)
    expect(report.failed).toBe(1)
    const failed = report.results.find((r) => !r.ok)!
    expect(failed.symbol).toBe('BTCUSDT')
    expect(failed.error).toContain('venue rejected')
  })

  it('sets the halt flag when halt:true and reports it', async () => {
    const { db, manager } = build([pos('BTCUSDT', 'long', 1)])
    const report = await panicCloseAll(db as unknown as KaiBotDatabase, manager as unknown as ExchangeManager, {
      halt: true,
      reason: 'panic',
    })
    expect(report.halted).toBe(true)
    expect(db.halt.halted).toBe(true)
    expect(db.halt.reason).toBe('panic')
  })

  it('does not halt when halt:false', async () => {
    const { db, manager } = build([pos('BTCUSDT', 'long', 1)])
    await panicCloseAll(db as unknown as KaiBotDatabase, manager as unknown as ExchangeManager, { halt: false })
    expect(db.halt.halted).toBe(false)
  })

  it('skips disconnected sessions', async () => {
    const db = new FakeDb()
    const connected = new FakeAdapter([pos('BTCUSDT', 'long', 1)])
    const offline = new FakeAdapter([pos('ETHUSDT', 'long', 5)])
    const manager = new FakeManager([
      { adapter: connected, exchangeName: 'bybit' },
      { adapter: offline, status: 'disconnected', exchangeName: 'deribit' },
    ])
    const report = await panicCloseAll(db as unknown as KaiBotDatabase, manager as unknown as ExchangeManager, {
      halt: false,
    })
    expect(report.closed).toBe(1)
    expect(connected.placed).toHaveLength(1)
    expect(offline.placed).toHaveLength(0)
  })
})

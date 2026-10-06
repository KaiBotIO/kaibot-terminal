import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { KaiBotDatabase } from '../storage/database.js'
import { panicCloseAll } from './panic.js'
import { sweepVenueExitOrders } from './venue-exit-sweep.js'
import type { ExchangeManager } from './exchanges/exchangeManager.js'
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
  states: Array<{ position_id: string; entry_signal_id: string; exchange: string; symbol: string; active: boolean }> = []
  execs = new Map<string, { signal_id: string; symbol: string; exchange: string; status: string; account_id: string | null }>()
  listActiveServerExitStates(exchange?: string) {
    return this.states.filter((s) => s.active && (!exchange || s.exchange === exchange))
  }
  getSignalExecution(signalId: string) {
    return this.execs.get(signalId)
  }
  deactivateServerExitState(positionId: string) {
    for (const s of this.states) if (s.position_id === positionId) s.active = false
  }
}

class FakeAdapter {
  placed: Order[] = []
  failSymbols = new Set<string>()
  constructor(public positions: Position[]) {}
  async getPositions() {
    return this.positions
  }
  fillPrices = new Map<string, number>()
  async placeOrder(order: Order): Promise<OrderResult> {
    if (this.failSymbols.has(order.symbol)) throw new Error(`venue rejected ${order.symbol}`)
    this.placed.push(order)
    const averagePrice = this.fillPrices.get(order.symbol)
    return averagePrice
      ? { orderId: `o:${order.symbol}`, status: 'filled', averagePrice }
      : { orderId: `o:${order.symbol}`, status: 'pending' }
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

// ─── Booking (06/10 incident: the flatten left rides open locally, MES without
//     a price, and three server rows open) ───

class VenueAdapter {
  placed: Order[] = []
  statusCalls = 0
  constructor(
    public positions: Position[],
    private ack: (o: Order) => OrderResult,
    public getOrderStatus?: (orderId: string) => Promise<any>,
  ) {}
  async getPositions() {
    return this.positions
  }
  async placeOrder(order: Order): Promise<OrderResult> {
    this.placed.push(order)
    return this.ack(order)
  }
}

describe('panicCloseAll books what it closed', () => {
  let dir: string
  let db: KaiBotDatabase
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kaibot-panic-'))
    db = new KaiBotDatabase(join(dir, 'test.db'))
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const seed = (o: { signalId: string; exchange: string; symbol: string; account: string; qty: number; entry: number; positionId?: string }) => {
    db.insertSignalExecution({ signalId: o.signalId, symbol: o.symbol, exchange: o.exchange, direction: 'long', status: 'open', qtyOpened: o.qty, accountId: o.account, createdAtMs: 1 })
    db.insertSignalFill({ signalId: o.signalId, kind: 'entry', symbol: o.symbol, side: 'buy', qty: o.qty, price: o.entry, createdAtMs: 1 })
    if (o.positionId) {
      db.run(
        `INSERT INTO server_exit_state (position_id, entry_signal_id, exchange, symbol, direction, sl_order_id, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'long', ?, 1, 1, 1)`,
        [o.positionId, o.signalId, o.exchange, o.symbol, `stop-${o.positionId}`],
      )
    }
  }

  const incident = () => {
    seed({ signalId: 'handover:pos-btc', exchange: 'deribit', symbol: 'BTC-PERPETUAL', account: 'btc', qty: 2950, entry: 86000, positionId: 'pos-btc' })
    seed({ signalId: 'handover:pos-eth', exchange: 'deribit', symbol: 'ETH-PERPETUAL', account: 'eth', qty: 6424, entry: 2718.45, positionId: 'pos-eth' })
    seed({ signalId: 'sig-mes', exchange: 'tradestation', symbol: 'MESZ26', account: '21084931', qty: 1, entry: 7900, positionId: 'pos-mes' })
    const deribit = new VenueAdapter(
      [pos('BTC-PERPETUAL', 'long', 2950, 'btc'), pos('ETH-PERPETUAL', 'long', 6424, 'eth')],
      (o) => ({
        orderId: `d:${o.symbol}`,
        status: 'filled',
        filledQuantity: o.quantity,
        averagePrice: o.symbol === 'BTC-PERPETUAL' ? 85555 : 2695.85,
        commission: 1.2,
        feeNative: 0.00001,
        feeCurrency: 'BTC',
      }),
    )
    const ts = new VenueAdapter([pos('MESZ26', 'long', 1, '21084931')], () => ({ orderId: '1319225338', status: 'pending' }))
    ts.getOrderStatus = async (orderId) => {
      ts.statusCalls += 1
      return ts.statusCalls < 2
        ? { orderId, state: 'working' }
        : { orderId, state: 'filled', filledQuantity: 1, averagePrice: 7877, commission: 0.62, filledAtMs: 1_000 }
    }
    const manager = new FakeManager([
      { adapter: deribit as unknown as FakeAdapter, exchangeName: 'deribit' },
      { adapter: ts as unknown as FakeAdapter, exchangeName: 'tradestation' },
    ])
    return { manager }
  }

  const exit = (signalId: string) => db.getSignalFills(signalId).find((f) => f.kind === 'exit')
  const noSleep = { sleep: async () => {}, intervalMs: 0 }

  it('books the exit fill, closes the execution, retires protections and reports, per venue', async () => {
    const { manager } = incident()
    const reported: Array<[string, number | null]> = []
    const retired: string[] = []
    await panicCloseAll(db, manager as unknown as ExchangeManager, {
      halt: true,
      reason: 'daily_loss',
      settle: noSleep,
      reportVenueExit: async (positionId, fill) => {
        reported.push([positionId, fill.price])
        return { sent: true }
      },
      retireProtections: async (_ex, signalId) => {
        retired.push(signalId)
      },
    })

    expect(exit('handover:pos-btc')).toMatchObject({ qty: 2950, price: 85555, side: 'sell', commission: 1.2, order_id: 'd:BTC-PERPETUAL' })
    expect(exit('handover:pos-eth')).toMatchObject({ qty: 6424, price: 2695.85 })
    expect(exit('sig-mes')).toMatchObject({ qty: 1, price: 7877, commission: 0.62, order_id: '1319225338', created_at: 1_000 })
    for (const id of ['handover:pos-btc', 'handover:pos-eth', 'sig-mes']) {
      expect(db.getSignalExecution(id)?.status).toBe('closed')
    }
    expect(retired.sort()).toEqual(['handover:pos-btc', 'handover:pos-eth', 'sig-mes'])
    expect(reported.sort()).toEqual([
      ['pos-btc', 85555],
      ['pos-eth', 2695.85],
      ['pos-mes', 7877],
    ])
    expect(db.listActiveServerExitStates()).toHaveLength(0)
  })

  it('a hanging reporter neither blocks the other closes nor the PANIC itself', async () => {
    const { manager } = incident()
    const started = Date.now()
    const report = await panicCloseAll(db, manager as unknown as ExchangeManager, {
      halt: true,
      settle: noSleep,
      reportTimeoutMs: 50,
      reportVenueExit: () => new Promise(() => {}),
    })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(report.closed).toBe(3)
    // booked locally all the same; the server rows stay active for a retry
    expect(db.getSignalExecution('sig-mes')?.status).toBe('closed')
    expect(db.listActiveServerExitStates().map((s) => s.position_id).sort()).toEqual(['pos-btc', 'pos-eth', 'pos-mes'])
  })

  it('an unconfirmed or failed report keeps the exit state active', async () => {
    const { manager } = incident()
    const replies: Array<() => Promise<{ sent: boolean; reason?: string }>> = [
      async () => ({ sent: false, reason: 'no credentials' }),
      async () => {
        throw new Error('server down')
      },
      async () => ({ sent: true }),
    ]
    await panicCloseAll(db, manager as unknown as ExchangeManager, {
      halt: false,
      settle: noSleep,
      reportVenueExit: () => replies.shift()!(),
    })
    expect(db.listActiveServerExitStates()).toHaveLength(2)
    const notReported = db.all(`SELECT metadata FROM logs WHERE message = 'PANIC: venue exit not reported to server'`, []) as any[]
    expect(notReported).toHaveLength(2)
  })

  for (const [label, finalState] of [
    ['still working after the poll', 'working'],
    ['rejected', 'rejected'],
    ['cancelled', 'cancelled'],
  ] as const) {
    it(`a close that is ${label} touches nothing: stops, exit state and server stay`, async () => {
      seed({ signalId: 'sig-mes', exchange: 'tradestation', symbol: 'MESZ26', account: '21084931', qty: 1, entry: 7900, positionId: 'pos-mes' })
      db.run(`INSERT INTO bracket_pairs (signal_id, exchange, sl_order_id, created_at) VALUES ('sig-mes', 'tradestation', 'stop', 1)`, [])
      const ts = new VenueAdapter([pos('MESZ26', 'long', 1, '21084931')], () => ({ orderId: 'o1', status: 'pending' }))
      ts.getOrderStatus = async (orderId) => ({ orderId, state: finalState })
      const manager = new FakeManager([{ adapter: ts as unknown as FakeAdapter, exchangeName: 'tradestation' }])
      const reported: string[] = []
      const retired: string[] = []
      await panicCloseAll(db, manager as unknown as ExchangeManager, {
        halt: false,
        settle: { ...noSleep, attempts: 3 },
        reportVenueExit: async (positionId) => {
          reported.push(positionId)
          return { sent: true }
        },
        retireProtections: async (_ex, signalId) => {
          retired.push(signalId)
        },
      })
      expect(exit('sig-mes')).toBeUndefined()
      expect(db.getSignalExecution('sig-mes')?.status).toBe('open')
      expect(db.listBracketPairs().map((b) => b.signal_id)).toEqual(['sig-mes'])
      expect(db.getServerExitState('pos-mes')?.active).toBeTruthy()
      expect(retired).toEqual([])
      expect(reported).toEqual([])
    })
  }

  it('a failed PANIC report goes out on the next sweep, from the booked fill, without a new order', async () => {
    const { manager } = incident()
    await panicCloseAll(db, manager as unknown as ExchangeManager, {
      halt: true,
      settle: noSleep,
      reportVenueExit: async () => {
        throw new Error('server down')
      },
    })
    expect(db.listActiveServerExitStates()).toHaveLength(3)

    const placedBefore = manager.sessions.map((s) => (s.adapter as unknown as VenueAdapter).placed.length)
    let statusCalls = 0
    const reported: Array<[string, number | null, string | null | undefined]> = []
    for (const exchange of ['deribit', 'tradestation']) {
      await sweepVenueExitOrders(
        {
          db,
          getAdapter: async () => ({
            getOrderStatus: async (orderId: string) => {
              statusCalls += 1
              return { orderId, state: 'unknown' as const }
            },
          }),
          retireProtections: async () => {},
          reportVenueExit: async (positionId, fill) => {
            reported.push([positionId, fill.price, fill.orderId])
            return { sent: true }
          },
        },
        exchange,
      )
    }
    expect(reported.sort()).toEqual([
      ['pos-btc', 85555, 'd:BTC-PERPETUAL'],
      ['pos-eth', 2695.85, 'd:ETH-PERPETUAL'],
      ['pos-mes', 7877, '1319225338'],
    ])
    expect(db.listActiveServerExitStates()).toHaveLength(0)
    expect(statusCalls).toBe(0)
    expect(manager.sessions.map((s) => (s.adapter as unknown as VenueAdapter).placed.length)).toEqual(placedBefore)
  })

  it('the sweep keeps an unconfirmed lingering state for the next pass', async () => {
    const { manager } = incident()
    await panicCloseAll(db, manager as unknown as ExchangeManager, {
      halt: false,
      settle: noSleep,
      reportVenueExit: async () => ({ sent: false, reason: 'no api url' }),
    })
    await sweepVenueExitOrders(
      { db, getAdapter: async () => null, reportVenueExit: async () => ({ sent: false, reason: 'no api url' }) },
      'deribit',
    )
    expect(db.listActiveServerExitStates('deribit')).toHaveLength(2)
  })
})

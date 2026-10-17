import { describe, expect, it } from 'bun:test'
import { Reconciler, describeExplained } from './reconciler.js'
import type { ExchangeManager } from './exchanges/exchangeManager.js'
import type { Position } from './exchanges/types.js'

// 2026-10-14 13:13 UTC onward, every 15 minutes: "Position mismatch on deribit
// ETH-PERPETUAL: expected 1972, broker holds -10384". The eth account carries
// the ETH floor hedge (synthetic short 12.356) next to Fault Line's long
// 1.972; Deribit nets them. The hedge is our own position, not drift.

interface ExecRow {
  signal_id: string
  symbol: string
  exchange: string
  direction: 'long' | 'short'
  status: string
  qty_opened: number
  qty_closed: number
  account_id: string | null
}

interface SyntheticRow {
  id: string
  exchange: string
  account_id: string
  symbol: string
  status: 'open' | 'armed' | 'closed'
  short_size: number
  arm_trigger_price: number | null
  arm_fired_price: number | null
}

class FakeDb {
  reconciliations: any[] = []
  synthetic: SyntheticRow[] = []
  manual: Array<{ exchange: string; account_id: string; symbol: string; net: number }> = []
  constructor(public execs: ExecRow[]) {}
  log() {}
  listExecutionExchanges() {
    return [...new Set(this.execs.map((e) => e.exchange))].map((exchange) => ({ exchange }))
  }
  listExecutionSymbols(exchange: string) {
    return [...new Set(this.execs.filter((e) => e.exchange === exchange).map((e) => e.symbol))].map((symbol) => ({ symbol }))
  }
  listExecutionAccountSymbols(exchange: string) {
    const seen = new Map<string, { account_id: string | null; symbol: string }>()
    for (const e of this.execs.filter((e) => e.exchange === exchange)) {
      seen.set(`${e.account_id}|${e.symbol}`, { account_id: e.account_id, symbol: e.symbol })
    }
    return [...seen.values()]
  }
  listOpenExecutionsForExchange(exchange: string) {
    return this.execs.filter((e) => e.exchange === exchange && e.status === 'open')
  }
  listKnownOrderIds() {
    return new Set<string>()
  }
  hasManualPosition(exchange: string, symbol: string) {
    return this.manual.some((m) => m.exchange === exchange && m.symbol === symbol)
  }
  getManualPosition() {
    return undefined
  }
  listManualPositions() {
    return this.manual
  }
  listSyntheticUsdPositions(includeClosed = false) {
    return includeClosed ? this.synthetic : this.synthetic.filter((r) => r.status === 'open' || r.status === 'armed')
  }
  all() {
    return []
  }
  insertReconciliation(row: any) {
    this.reconciliations.push(row)
  }
}

class FakeAdapter {
  alwaysOpen = true
  placed: any[] = []
  constructor(public positions: Position[]) {}
  async getPositions() {
    return this.positions
  }
  async placeOrder(o: any) {
    this.placed.push(o)
    return { orderId: 'x', status: 'filled' as const }
  }
  async cancelOrder() {}
}

function build(exchange: string, execs: ExecRow[], positions: Position[]) {
  const db = new FakeDb(execs)
  const adapter = new FakeAdapter(positions)
  const manager = {
    async getSession() {
      return undefined
    },
    async getSessions(_u: string, name: string) {
      return name === exchange ? [{ adapter, status: 'connected', userId: 'default', exchangeName: exchange }] : []
    },
  } as unknown as ExchangeManager
  const alerts: string[] = []
  const reconciler = new Reconciler({
    db: db as any,
    exchangeManager: manager,
    notifications: { publish: (e: any) => alerts.push(e.body) } as any,
  })
  return { db, adapter, reconciler, alerts }
}

const pos = (accountId: string, symbol: string, side: 'long' | 'short', size: number): Position => ({
  id: `${accountId}:${symbol}`,
  accountId,
  symbol,
  side,
  size,
  entryPrice: 2400,
})

const faultLine: ExecRow = {
  signal_id: 'fl-eth',
  symbol: 'ETH-PERPETUAL',
  exchange: 'deribit',
  direction: 'long',
  status: 'open',
  qty_opened: 1_972,
  qty_closed: 0,
  account_id: 'eth',
}

const ethFloorHedge: SyntheticRow = {
  id: '1716d0ef-5ec3-4bb1-ba41-652c46da8dbd',
  exchange: 'deribit',
  account_id: 'eth',
  symbol: 'ETH-PERPETUAL',
  status: 'open',
  short_size: 12_356,
  arm_trigger_price: 2471.2424,
  arm_fired_price: 2468.5,
}

describe('Reconciler observe pass counts active hedges as explained', () => {
  it('floor hedge -12.356 + bot +1.972 = venue -10.384: no alert', async () => {
    const { db, reconciler, alerts, adapter } = build('deribit', [faultLine], [pos('eth', 'ETH-PERPETUAL', 'short', 10_384)])
    db.synthetic.push(ethFloorHedge)
    const s = await reconciler.tick()
    expect(s.pairs).toBe(1)
    expect(s.observedMismatches).toBe(0)
    expect(alerts).toHaveLength(0)
    expect(db.reconciliations).toHaveLength(0)
    expect(adapter.placed).toHaveLength(0)
  })

  it('a residual of 100 beyond the hedge still alerts, with the breakdown', async () => {
    const { db, reconciler, alerts, adapter } = build('deribit', [faultLine], [pos('eth', 'ETH-PERPETUAL', 'short', 10_484)])
    db.synthetic.push(ethFloorHedge)
    const s = await reconciler.tick()
    expect(s.observedMismatches).toBe(1)
    expect(db.reconciliations[0]).toMatchObject({
      symbol: 'ETH-PERPETUAL',
      expectedNet: -10_384,
      brokerNet: -10_484,
      delta: 100,
      action: 'alert_observed_mismatch',
    })
    expect(alerts[0]).toContain('expected -10.384 (bots +1.972, floor hedge -12.356), broker holds -10.484, off by 100')
    expect(adapter.placed).toHaveLength(0)
  })

  it('once the hedge is closed, the same venue net is a mismatch again', async () => {
    const { db, reconciler, alerts } = build('deribit', [faultLine], [pos('eth', 'ETH-PERPETUAL', 'short', 10_384)])
    db.synthetic.push({ ...ethFloorHedge, status: 'closed' })
    const s = await reconciler.tick()
    expect(s.observedMismatches).toBe(1)
    expect(db.reconciliations[0]).toMatchObject({ expectedNet: 1_972, brokerNet: -10_384 })
    expect(alerts[0]).toContain('expected 1.972, broker holds -10.384')
    expect(alerts[0]).not.toContain('hedge')
  })

  it('a closed hedge with the bot alone at the venue stays quiet', async () => {
    const { db, reconciler } = build('deribit', [faultLine], [pos('eth', 'ETH-PERPETUAL', 'long', 1_972)])
    db.synthetic.push({ ...ethFloorHedge, status: 'closed' })
    const s = await reconciler.tick()
    expect(s.observedMismatches).toBe(0)
  })

  it('an armed (unfired) floor holds no short and explains nothing', async () => {
    const { db, reconciler } = build('deribit', [faultLine], [pos('eth', 'ETH-PERPETUAL', 'short', 10_384)])
    db.synthetic.push({ ...ethFloorHedge, status: 'armed', short_size: 0 })
    const s = await reconciler.tick()
    expect(s.observedMismatches).toBe(1)
  })

  it('a hedge on another connection does not explain this one', async () => {
    const { db, reconciler } = build('deribit', [faultLine], [pos('eth', 'ETH-PERPETUAL', 'short', 10_384)])
    db.synthetic.push({ ...ethFloorHedge, account_id: 'acct1/eth' })
    const s = await reconciler.tick()
    expect(s.observedMismatches).toBe(1)
  })

  it('Bybit UTA: fired ETH floor hedge in coin nets with a bot long', async () => {
    const bot: ExecRow = { ...faultLine, signal_id: 'alt-eth', exchange: 'bybit', symbol: 'ETHUSDT', qty_opened: 0.4, account_id: 'unified' }
    const hedge: SyntheticRow = {
      ...ethFloorHedge,
      id: 'fa8d10d4',
      exchange: 'bybit',
      account_id: 'unified',
      symbol: 'ETHUSDT',
      short_size: 1.35,
      arm_trigger_price: 2352.23,
    }
    const quiet = build('bybit', [bot], [pos('unified', 'ETHUSDT', 'short', 0.95)])
    quiet.db.synthetic.push(hedge)
    expect((await quiet.reconciler.tick()).observedMismatches).toBe(0)

    const off = build('bybit', [bot], [pos('unified', 'ETHUSDT', 'short', 1.05)])
    off.db.synthetic.push(hedge)
    expect((await off.reconciler.tick()).observedMismatches).toBe(1)
    expect(off.alerts[0]).toContain('expected -0,95 (bots +0,4, floor hedge -1,35), broker holds -1,05, off by 0,1')
  })

  it('a manual marker on the same connection is part of the sum', async () => {
    const { db, reconciler } = build('deribit', [faultLine], [pos('eth', 'ETH-PERPETUAL', 'short', 9_384)])
    db.synthetic.push(ethFloorHedge)
    db.manual.push({ exchange: 'deribit', account_id: 'eth', symbol: 'ETH-PERPETUAL', net: 1_000 })
    const s = await reconciler.tick()
    expect(s.observedMismatches).toBe(0)
  })
})

describe('describeExplained', () => {
  it('lists bots, each hedge and the manual marker', () => {
    expect(
      describeExplained({
        bots: 1_972,
        hedges: [{ kind: 'synthetic-usd', id: 'x', accountId: 'eth', symbol: 'ETH-PERPETUAL', net: -500, entryPrice: null }],
        manual: -20,
      }),
    ).toBe('bots +1.972, synthetic USD -500, manual -20')
  })
})

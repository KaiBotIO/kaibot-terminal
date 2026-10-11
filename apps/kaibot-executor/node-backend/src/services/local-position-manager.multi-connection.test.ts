import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { KaiBotDatabase } from '../storage/database.js'
import { LocalPositionManager } from './local-position-manager.js'
import { orderLockIdle } from './order-lock.js'
import { scopeAdapter } from './exchanges/account-scope.js'

// Two Deribit connections: a trail row belongs to the connection its account
// names. It must read THAT connection's position (mark, flat-or-not) and amend
// the stop through THAT connection's adapter, never the sibling's.

let dir: string
let db: KaiBotDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-lpm-multi-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function fakeAdapter(positions: any[]) {
  const placed: any[] = []
  const cancelled: string[] = []
  const adapter = {
    getPositions: async () => positions,
    placeOrder: async (o: any) => { placed.push(o); return { orderId: `new-${placed.length}`, status: 'filled' } },
    cancelOrder: async (id: string) => { cancelled.push(id) },
  }
  return { adapter, placed, cancelled }
}

function twoConnections(defaultPositions: any[], acct2Positions: any[]) {
  const dflt = fakeAdapter(defaultPositions)
  const acct2 = fakeAdapter(acct2Positions)
  const sessions = [
    { status: 'connected', adapter: dflt.adapter, label: 'default', accountKey: undefined },
    { status: 'connected', adapter: scopeAdapter(acct2.adapter as any, 'acct2'), label: 'acct2', accountKey: 'acct2' },
  ]
  const exchangeManager = {
    getSession: async (_u: string, _e: string, key?: string) => sessions.find((s) => s.accountKey === (key || undefined)),
    getSessions: async () => sessions,
  }
  return { dflt, acct2, exchangeManager }
}

describe('LocalPositionManager with two connections on one exchange', () => {
  it('trails the acct2 row on acct2’s mark and amends through acct2’s adapter', async () => {
    db.upsertLocalTrailState({
      signalId: 'sig-acct2', exchange: 'deribit', symbol: 'BTC-PERPETUAL', direction: 'long', accountId: 'acct2/btc',
      entryPrice: 100, slOrderId: 'sl-2', trailPercentage: 2, extremePrice: 100, currentStop: 95,
    })
    // Default holds the same contract but at a LOWER mark; acct2 ran to 120.
    const { dflt, acct2, exchangeManager } = twoConnections(
      [{ symbol: 'BTC-PERPETUAL', size: 1, markPrice: 105, accountId: 'btc' }],
      [{ symbol: 'BTC-PERPETUAL', size: 1, markPrice: 120, accountId: 'btc' }],
    )
    const mgr = new LocalPositionManager(db, exchangeManager as any, null, { tickMs: 999999 })

    await mgr.tick()
    await orderLockIdle()

    const [row] = db.listActiveLocalTrails()
    expect(row.extreme_price).toBe(120)
    expect(row.current_stop).toBeCloseTo(117.6, 6)
    expect(acct2.cancelled).toContain('sl-2')
    expect(acct2.placed).toHaveLength(1)
    expect(acct2.placed[0].accountId).toBe('btc') // stripped for the venue
    expect(dflt.placed).toHaveLength(0)
    expect(dflt.cancelled).toHaveLength(0)
  })

  it('retires the acct2 row when acct2 is flat, even though default still holds the contract', async () => {
    db.upsertLocalTrailState({
      signalId: 'sig-acct2', exchange: 'deribit', symbol: 'BTC-PERPETUAL', direction: 'long', accountId: 'acct2/btc',
      entryPrice: 100, slOrderId: 'sl-2', trailPercentage: 2, extremePrice: 110, currentStop: 107.8,
    })
    const { dflt, acct2, exchangeManager } = twoConnections(
      [{ symbol: 'BTC-PERPETUAL', size: 1, markPrice: 105, accountId: 'btc' }],
      [],
    )
    const mgr = new LocalPositionManager(db, exchangeManager as any, null, { tickMs: 999999 })

    await mgr.tick()
    await orderLockIdle()

    expect(db.listActiveLocalTrails()).toHaveLength(0)
    expect(dflt.cancelled).toHaveLength(0)
    expect(acct2.cancelled).toHaveLength(0) // signal-source rows leave the stop to the bracket
  })

  it('keeps a default-connection row alive on default’s position while acct2 is flat', async () => {
    db.upsertLocalTrailState({
      signalId: 'sig-default', exchange: 'deribit', symbol: 'BTC-PERPETUAL', direction: 'long', accountId: 'btc',
      entryPrice: 100, slOrderId: 'sl-1', trailPercentage: 2, extremePrice: 100, currentStop: 95,
    })
    const { dflt, acct2, exchangeManager } = twoConnections(
      [{ symbol: 'BTC-PERPETUAL', size: 1, markPrice: 110, accountId: 'btc' }],
      [],
    )
    const mgr = new LocalPositionManager(db, exchangeManager as any, null, { tickMs: 999999 })

    await mgr.tick()
    await orderLockIdle()

    const [row] = db.listActiveLocalTrails()
    expect(row.current_stop).toBeCloseTo(107.8, 6)
    expect(dflt.placed).toHaveLength(1)
    expect(acct2.placed).toHaveLength(0)
  })
})

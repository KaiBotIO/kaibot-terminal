import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { KaiBotDatabase } from '../../storage/database.js'
import { ExchangeManager } from './exchangeManager.js'
import type { ExchangeAdapter, ExchangeCredentials, Order } from './types.js'
import { canSeeAccount, canSeeConnection, filterByAccount, scopedSessions } from '../../auth/account-scope.js'
import { createManualTradeService, manualConnectionKey } from '../manual-trade.js'
import { subscriptionScopeAccount } from '../../routes/subscriptions.js'

// Kai's bybit:default next to the client's bybit:kay (own API key, own UTA).
// Orders, positions and viewer scope must never cross between the two.

class FakeBybit implements ExchangeAdapter {
  name = 'bybit'
  connectedWith: ExchangeCredentials | null = null
  placed: Order[] = []
  disconnected = false
  constructor(private readonly size: number) {}
  async connect(credentials: ExchangeCredentials) {
    this.connectedWith = credentials
  }
  async disconnect() {
    this.disconnected = true
  }
  async refreshSession() {}
  async getAccounts() {
    return [{ id: 'bybit:unified', exchangeName: 'bybit', accountId: 'unified', name: 'Unified Trading', currency: 'USDT' }]
  }
  async getBalances() {
    return [{ accountId: 'unified', currency: 'USDT', total: 1000, available: 1000 } as any]
  }
  async getPositions() {
    return [
      { id: 'bybit:BTCUSDT', accountId: 'unified', symbol: 'BTCUSDT', side: 'long' as const, size: this.size, entryPrice: 60000, markPrice: 60000 },
    ]
  }
  async placeOrder(order: Order): Promise<any> {
    this.placed.push(order)
    return { orderId: `o${this.placed.length}`, status: 'filled', filledQuantity: order.quantity, averagePrice: 60000 }
  }
  async cancelOrder() {}
  subscribeToUpdates(_cb?: (data: any) => void) {}
  unsubscribeFromUpdates() {}
}

let dir: string
let db: KaiBotDatabase
let mgr: ExchangeManager
let built: FakeBybit[]

function newManager(target: FakeBybit[]) {
  const m = new ExchangeManager(db)
  m.registerExchange('bybit', () => {
    const a = new FakeBybit(target.length === 0 ? 0.5 : 0.1)
    target.push(a)
    return a
  })
  ;(m as any).startDataPolling = () => {}
  ;(m as any).scheduleSessionRefresh = () => {}
  return m
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-bybit-two-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
  built = []
  mgr = newManager(built)
})

afterEach(async () => {
  await mgr.shutdown()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const creds = (apiKey: string): ExchangeCredentials => ({ type: 'apiKey', apiKey, apiSecret: `${apiKey}-secret` })

async function connectBoth() {
  await mgr.connectExchange('default', 'bybit', creds('KAI'))
  await mgr.connectExchange('default', 'bybit', creds('KAY'), 'kay')
  const dflt = (await mgr.getSession('default', 'bybit'))!
  const kay = (await mgr.getSession('default', 'bybit', 'kay'))!
  return { dflt, kay }
}

describe('two Bybit connections', () => {
  it('stores each with its own key and label', async () => {
    const { dflt, kay } = await connectBoth()
    const rows = db.all('SELECT id, label FROM exchange_connections ORDER BY id') as any[]
    expect(rows).toEqual([
      { id: 'default:bybit', label: 'default' },
      { id: 'default:bybit:kay', label: 'kay' },
    ])
    expect(dflt.accountKey).toBeUndefined()
    expect(kay.accountKey).toBe('kay')
    expect((built[0].connectedWith as any).apiKey).toBe('KAI')
    expect((built[1].connectedWith as any).apiKey).toBe('KAY')
    const stored = db.all('SELECT encrypted_credentials FROM exchange_connections') as any[]
    for (const r of stored) expect(String(r.encrypted_credentials)).not.toContain('secret')
  })

  it('namespaces the second UTA as kay/unified on every read', async () => {
    const { dflt, kay } = await connectBoth()
    expect((await dflt.adapter.getAccounts())[0].accountId).toBe('unified')
    expect((await kay.adapter.getAccounts())[0].accountId).toBe('kay/unified')
    expect((await kay.adapter.getBalances())[0].accountId).toBe('kay/unified')
    const [p] = await kay.adapter.getPositions()
    expect(p.accountId).toBe('kay/unified')
    expect(p.size).toBe(0.1)
  })

  it('routes an order to its own connection only, both ways', async () => {
    const { dflt, kay } = await connectBoth()
    await kay.adapter.placeOrder({ accountId: 'kay/unified', symbol: 'BTCUSDT', side: 'buy', orderType: 'market', quantity: 0.01 })
    expect(built[1].placed.map((o) => o.accountId)).toEqual(['unified'])
    expect(built[0].placed).toHaveLength(0)

    await dflt.adapter.placeOrder({ accountId: 'unified', symbol: 'BTCUSDT', side: 'sell', orderType: 'market', quantity: 0.02 })
    expect(built[0].placed.map((o) => o.quantity)).toEqual([0.02])
    expect(built[1].placed).toHaveLength(1)

    expect((await mgr.sessionForAccount('default', 'bybit', 'kay/unified'))!.adapter).toBe(kay.adapter)
    expect((await mgr.sessionForAccount('default', 'bybit', 'unified'))!.adapter).toBe(dflt.adapter)
  })

  it('a failing connection does not take the other down', async () => {
    const { kay } = await connectBoth()
    built[1].getPositions = async () => {
      throw new Error('Bybit 10003: invalid api key')
    }
    await expect(kay.adapter.getPositions()).rejects.toThrow(/invalid api key/)
    const dflt = (await mgr.getSession('default', 'bybit'))!
    expect(dflt.status).toBe('connected')
    expect((await dflt.adapter.getPositions())[0].size).toBe(0.5)

    await mgr.disconnectExchange('default', 'bybit', 'kay')
    expect((await mgr.getSession('default', 'bybit'))!.status).toBe('connected')
    expect(built[0].disconnected).toBe(false)
  })

  it('restores both after a restart with their own keys', async () => {
    await connectBoth()
    await mgr.shutdown()
    const built2: FakeBybit[] = []
    const mgr2 = newManager(built2)
    try {
      await mgr2.restoreSessions()
      const kay = (await mgr2.getSession('default', 'bybit', 'kay'))!
      expect(kay.status).toBe('connected')
      expect((await kay.adapter.getAccounts())[0].accountId).toBe('kay/unified')
      expect(built2.map((a) => (a.connectedWith as any).apiKey).sort()).toEqual(['KAI', 'KAY'])
    } finally {
      await mgr2.shutdown()
    }
  })
})

describe('viewer granted bybit:kay', () => {
  const scope = { all: false as const, grants: [{ exchange: 'bybit', kind: 'connection' as const, ref: 'kay' }] }

  it('sees kay rows only', () => {
    expect(canSeeAccount(scope, 'bybit', 'kay/unified')).toBe(true)
    expect(canSeeAccount(scope, 'bybit', 'unified')).toBe(false)
    expect(canSeeAccount(scope, 'deribit', 'kay/unified')).toBe(false)
    expect(canSeeConnection(scope, 'bybit', 'kay')).toBe(true)
    expect(canSeeConnection(scope, 'bybit', 'default')).toBe(false)
    const fills = [
      { exchange: 'bybit', account_id: 'unified', id: 1 },
      { exchange: 'bybit', account_id: 'kay/unified', id: 2 },
    ]
    expect(filterByAccount(scope, fills, (f) => ({ exchange: f.exchange, accountId: f.account_id })).map((f) => f.id)).toEqual([2])
  })

  it('sees a kay subscription that has no venue account yet, not Kai’s', () => {
    const subs = [
      { id: 'k', exchange: 'bybit', account_key: 'kay', account_id: null },
      { id: 'k2', exchange: 'bybit', account_key: 'kay', account_id: 'kay/unified' },
      { id: 'd', exchange: 'bybit', account_key: null, account_id: null },
    ]
    const visible = filterByAccount(scope, subs, (r) => ({ exchange: r.exchange, accountId: subscriptionScopeAccount(r) }))
    expect(visible.map((r) => r.id)).toEqual(['k', 'k2'])
  })

  it('scoped sessions hide Kai’s connection', async () => {
    await connectBoth()
    const sessions = await scopedSessions(scope, mgr).getAllSessions('default')
    expect(sessions.map((s) => s.accountKey ?? 'default')).toEqual(['kay'])
    const positions = await sessions[0].adapter.getPositions()
    expect(positions.map((p) => p.accountId)).toEqual(['kay/unified'])
  })
})

describe('manual trade routing', () => {
  it('manualConnectionKey refuses a label that disagrees with the account', () => {
    expect(manualConnectionKey(undefined, 'kay')).toBe('kay')
    expect(manualConnectionKey('kay/unified', 'kay')).toBe('kay')
    expect(manualConnectionKey('kay/unified', undefined)).toBe('kay')
    expect(manualConnectionKey('unified', 'default')).toBeUndefined()
    expect(manualConnectionKey(undefined, undefined)).toBeUndefined()
    expect(() => manualConnectionKey('unified', 'kay')).toThrow(/not on connection kay/)
    expect(() => manualConnectionKey('kay/unified', 'default')).toThrow(/not on connection default/)
  })

  it('places on bybit:kay when only the label is known, never on default', async () => {
    await connectBoth()
    const svc = createManualTradeService(db, mgr)
    await svc.place({ exchange: 'bybit', symbol: 'BTCUSDT', side: 'buy', orderType: 'market', quantity: 0.01, accountKey: 'kay' })
    expect(built[1].placed).toHaveLength(1)
    expect(built[1].placed[0].accountId).toBe('unified')
    expect(built[0].placed).toHaveLength(0)
  })

  it('refuses a mismatched label + account before anything is sent', async () => {
    await connectBoth()
    const svc = createManualTradeService(db, mgr)
    await expect(
      svc.place({ exchange: 'bybit', symbol: 'BTCUSDT', side: 'buy', orderType: 'market', quantity: 0.01, accountId: 'unified', accountKey: 'kay' }),
    ).rejects.toThrow(/not on connection kay/)
    expect(built[0].placed).toHaveLength(0)
    expect(built[1].placed).toHaveLength(0)
  })

  function seedProtection() {
    for (const [sid, accountId] of [['manual:kai-1', 'unified'], ['manual:kay-1', 'kay/unified']] as const) {
      db.insertOrderSettlement({ signalId: sid, exchange: 'bybit', accountId, symbol: 'BTCUSDT', kind: 'entry', side: 'buy', qty: 0.1, orderId: `${sid}-o`, status: 'filled' })
      db.upsertLocalTrailState({
        signalId: sid, exchange: 'bybit', symbol: 'BTCUSDT', direction: 'long', entryPrice: 60000, extremePrice: 60000,
        slOrderId: `${sid}-sl`, trailPercentage: 2, source: 'manual', accountId,
      })
    }
  }

  async function closeWith(input: { accountId?: string; accountKey?: string }) {
    const retired: string[] = []
    const rungs: string[][] = []
    const svc = createManualTradeService(db, mgr, {
      retireBracket: (_ex, sid) => {
        retired.push(sid)
      },
      cancelEntryRungs: (_ex, ids) => {
        rungs.push(ids)
      },
    })
    await svc.close({ exchange: 'bybit', symbol: 'BTCUSDT', ...input })
    const activeTrails = db.findActiveTrailsForSymbol('bybit', 'BTCUSDT').map((t) => t.signal_id).sort()
    return { retired, rungs, activeTrails }
  }

  it("a label-only close on kay leaves Kai's brackets, rungs and trails alone", async () => {
    await connectBoth()
    seedProtection()
    const r = await closeWith({ accountKey: 'kay' })
    expect(r.retired).toEqual(['manual:kay-1'])
    expect(r.rungs).toEqual([['manual:kay-1']])
    expect(r.activeTrails).toEqual(['manual:kai-1'])
    expect(built[0].placed).toHaveLength(0)
  })

  it("a default close leaves kay's protection alone", async () => {
    await connectBoth()
    seedProtection()
    const r = await closeWith({})
    expect(r.retired).toEqual(['manual:kai-1'])
    expect(r.activeTrails).toEqual(['manual:kay-1'])
    expect(built[1].placed).toHaveLength(0)
  })

  it('closes kay’s position on kay only', async () => {
    await connectBoth()
    const svc = createManualTradeService(db, mgr)
    await svc.close({ exchange: 'bybit', symbol: 'BTCUSDT', accountId: 'kay/unified' })
    expect(built[1].placed).toHaveLength(1)
    expect(built[1].placed[0].quantity).toBe(0.1)
    expect(built[0].placed).toHaveLength(0)
  })
})

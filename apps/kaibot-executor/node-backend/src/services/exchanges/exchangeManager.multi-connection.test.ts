import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { KaiBotDatabase } from '../../storage/database.js'
import { ExchangeManager } from './exchangeManager.js'
import type { ExchangeAdapter, ExchangeCredentials, Order } from './types.js'

// Two Deribit accounts in one executor: a second connection on the same
// (user, exchange) carries a label. The default connection keeps its legacy
// id and behaviour bit-for-bit (the live TradeStation session depends on it).

class FakeAdapter implements ExchangeAdapter {
  name = 'deribit'
  connectedWith: ExchangeCredentials | null = null
  disconnected = false
  placed: Order[] = []
  async connect(credentials: ExchangeCredentials) {
    this.connectedWith = credentials
  }
  async disconnect() {
    this.disconnected = true
  }
  async refreshSession() {}
  async getAccounts() {
    return [{ id: 'deribit:btc', exchangeName: 'deribit', accountId: 'btc', name: 'BTC Account', currency: 'BTC' }]
  }
  async getBalances() {
    return []
  }
  async getPositions() {
    return [{ id: 'deribit:BTC-PERPETUAL', accountId: 'btc', symbol: 'BTC-PERPETUAL', side: 'long' as const, size: 100, entryPrice: 60000 }]
  }
  async placeOrder(order: Order): Promise<any> {
    this.placed.push(order)
    return { orderId: `o${this.placed.length}`, status: 'filled' }
  }
  async cancelOrder() {}
  subscribeToUpdates(_cb?: (data: any) => void) {}
  unsubscribeFromUpdates() {}
}

let dir: string
let db: KaiBotDatabase
let mgr: ExchangeManager
let built: FakeAdapter[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-exmgr-multi-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
  mgr = new ExchangeManager(db)
  built = []
  mgr.registerExchange('deribit', () => {
    const a = new FakeAdapter()
    built.push(a)
    return a
  })
  ;(mgr as any).startDataPolling = () => {}
  ;(mgr as any).scheduleSessionRefresh = () => {}
})

afterEach(async () => {
  await mgr.shutdown()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const creds = (apiKey: string): ExchangeCredentials => ({ type: 'apiKey', apiKey, apiSecret: 's' })

describe('labeled connections', () => {
  it('keeps the legacy id for the default connection and adds `<user>:<exchange>:<label>` for the second', async () => {
    await mgr.connectExchange('default', 'deribit', creds('A'))
    await mgr.connectExchange('default', 'deribit', creds('B'), 'acct2')

    const rows = db.all('SELECT id, label FROM exchange_connections ORDER BY id') as any[]
    expect(rows).toEqual([
      { id: 'default:deribit', label: 'default' },
      { id: 'default:deribit:acct2', label: 'acct2' },
    ])

    const dflt = (await mgr.getSession('default', 'deribit'))!
    const acct2 = (await mgr.getSession('default', 'deribit', 'acct2'))!
    expect(dflt.connectionId).toBe('default:deribit')
    expect(dflt.accountKey).toBeUndefined()
    expect(acct2.connectionId).toBe('default:deribit:acct2')
    expect(acct2.accountKey).toBe('acct2')
    expect(dflt.adapter).not.toBe(acct2.adapter)
    expect(built).toHaveLength(2)
    expect((built[0].connectedWith as any).apiKey).toBe('A')
    expect((built[1].connectedWith as any).apiKey).toBe('B')
  })

  it('rejects an invalid label', async () => {
    await expect(mgr.connectExchange('default', 'deribit', creds('B'), 'Bad Label')).rejects.toThrow(/label/)
    expect(built).toHaveLength(0)
  })

  it('namespaces the labeled connection’s account ids and strips them on orders', async () => {
    await mgr.connectExchange('default', 'deribit', creds('A'))
    await mgr.connectExchange('default', 'deribit', creds('B'), 'acct2')

    const dflt = (await mgr.getSession('default', 'deribit'))!
    const acct2 = (await mgr.getSession('default', 'deribit', 'acct2'))!
    expect((await dflt.adapter.getPositions())[0].accountId).toBe('btc')
    expect((await acct2.adapter.getPositions())[0].accountId).toBe('acct2/btc')

    await acct2.adapter.placeOrder({ accountId: 'acct2/btc', symbol: 'BTC-PERPETUAL', side: 'sell', orderType: 'market', quantity: 10 })
    expect(built[1].placed[0].accountId).toBe('btc')
    expect(built[0].placed).toHaveLength(0)
  })

  it('routes an account id to its owning connection (sessionForAccount) and lists both (getSessions)', async () => {
    await mgr.connectExchange('default', 'deribit', creds('A'))
    await mgr.connectExchange('default', 'deribit', creds('B'), 'acct2')

    expect((await mgr.sessionForAccount('default', 'deribit', 'btc'))!.connectionId).toBe('default:deribit')
    expect((await mgr.sessionForAccount('default', 'deribit', undefined))!.connectionId).toBe('default:deribit')
    expect((await mgr.sessionForAccount('default', 'deribit', 'acct2/btc'))!.connectionId).toBe('default:deribit:acct2')
    expect(await mgr.sessionForAccount('default', 'deribit', 'nope/btc')).toBeUndefined()

    const sessions = await mgr.getSessions('default', 'deribit')
    expect(sessions.map((s) => s.label)).toEqual(['default', 'acct2'])
    expect((await mgr.getAllSessions('default')).length).toBe(2)
  })

  it('disconnecting the labeled connection leaves the default one alone (and vice versa)', async () => {
    await mgr.connectExchange('default', 'deribit', creds('A'))
    await mgr.connectExchange('default', 'deribit', creds('B'), 'acct2')

    await mgr.disconnectExchange('default', 'deribit', 'acct2')
    expect(await mgr.getSession('default', 'deribit', 'acct2')).toBeUndefined()
    expect((await mgr.getSession('default', 'deribit'))!.status).toBe('connected')
    expect(built[1].disconnected).toBe(true)
    expect(built[0].disconnected).toBe(false)
    const rows = db.all('SELECT id, is_active FROM exchange_connections ORDER BY id') as any[]
    expect(rows).toEqual([
      { id: 'default:deribit', is_active: 1 },
      { id: 'default:deribit:acct2', is_active: 0 },
    ])
  })

  it('restores both connections on restart with their own credentials and labels', async () => {
    await mgr.connectExchange('default', 'deribit', creds('A'))
    await mgr.connectExchange('default', 'deribit', creds('B'), 'acct2')
    await mgr.shutdown()

    const mgr2 = new ExchangeManager(db)
    const built2: FakeAdapter[] = []
    mgr2.registerExchange('deribit', () => {
      const a = new FakeAdapter()
      built2.push(a)
      return a
    })
    ;(mgr2 as any).startDataPolling = () => {}
    ;(mgr2 as any).scheduleSessionRefresh = () => {}
    try {
      await mgr2.restoreSessions()
      const dflt = (await mgr2.getSession('default', 'deribit'))!
      const acct2 = (await mgr2.getSession('default', 'deribit', 'acct2'))!
      expect(dflt.status).toBe('connected')
      expect(acct2.status).toBe('connected')
      expect(acct2.accountKey).toBe('acct2')
      expect((await acct2.adapter.getPositions())[0].accountId).toBe('acct2/btc')
      const keys = built2.map((a) => (a.connectedWith as any).apiKey).sort()
      expect(keys).toEqual(['A', 'B'])
    } finally {
      await mgr2.shutdown()
    }
  })

  it('restores a pre-migration row (no label column value) as the default connection', async () => {
    const ciphertext = (mgr as any).crypto.encryptCredentials(creds('A'))
    // Legacy insert shape: no label → column default 'default'.
    db.run(
      `INSERT INTO exchange_connections
       (id, user_id, exchange_name, connection_type, encrypted_credentials, is_active, last_refresh)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
      ['default:deribit', 'default', 'deribit', 'apiKey', ciphertext, Date.now()],
    )
    await mgr.restoreSessions()
    const session = (await mgr.getSession('default', 'deribit'))!
    expect(session.status).toBe('connected')
    expect(session.label).toBe('default')
    expect(session.accountKey).toBeUndefined()
    expect((await session.adapter.getPositions())[0].accountId).toBe('btc')
  })

  it('tags exchangeUpdate events with the connection’s account key', async () => {
    const events: any[] = []
    mgr.on('exchangeUpdate', (e) => events.push(e))
    mgr.registerExchange('deribit', () => {
      const a = new FakeAdapter()
      a.subscribeToUpdates = (cb: any) => cb({ type: 'order', data: { order_id: 'x' } })
      return a
    })
    await mgr.connectExchange('default', 'deribit', creds('A'))
    await mgr.connectExchange('default', 'deribit', creds('B'), 'acct2')
    expect(events.map((e) => e.accountKey)).toEqual([undefined, 'acct2'])
  })
})

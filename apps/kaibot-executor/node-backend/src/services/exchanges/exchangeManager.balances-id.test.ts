import { describe, expect, it, beforeEach, afterEach, spyOn } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { KaiBotDatabase } from '../../storage/database.js'
import { ExchangeManager } from './exchangeManager.js'
import type { Account, Balance, ExchangeAdapter, ExchangeCredentials } from './types.js'

// 05/10/2026: Bybit UTA returns one balance row per coin under a single
// accountId. The row id was `${session}:${accountId}:${Date.now()}`, so BTC/ETH/SOL
// in the same ms hit UNIQUE(exchange_balances.id) and every poll reconnected.

class UtaAdapter implements ExchangeAdapter {
  name = 'utafake'
  balanceAccountId = 'uta'
  async connect(_c: ExchangeCredentials) {}
  async disconnect() {}
  async refreshSession() {}
  async getAccounts(): Promise<Account[]> {
    return [{ id: 'uta', exchangeName: 'utafake', accountId: 'uta', accountType: 'unified', name: 'UTA', currency: 'USDT' }]
  }
  async getBalances(): Promise<Balance[]> {
    return ['BTC', 'ETH', 'SOL'].map((currency) => ({
      accountId: this.balanceAccountId,
      balance: 1,
      equity: 1,
      realizedPnL: 0,
      unrealizedPnL: 0,
      currency,
      timestamp: 0,
    }))
  }
  async getPositions() {
    return []
  }
  async placeOrder(): Promise<any> {
    throw new Error('not needed')
  }
  async cancelOrder() {}
  subscribeToUpdates() {}
  unsubscribeFromUpdates() {}
}

let dir: string
let db: KaiBotDatabase
let mgr: ExchangeManager
let reconnects: number
let nowSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-exmgr-balid-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
  mgr = new ExchangeManager(db)
  reconnects = 0
  ;(mgr as any).startDataPolling = () => {}
  ;(mgr as any).scheduleSessionRefresh = () => {}
  ;(mgr as any).scheduleReconnect = () => {
    reconnects++
  }
  nowSpy = spyOn(Date, 'now').mockReturnValue(1_759_600_000_000)
})

afterEach(async () => {
  nowSpy.mockRestore()
  await mgr.shutdown()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('refreshExchangeData balance rows', () => {
  it('stores several coins of one account in the same ms without reconnecting', async () => {
    mgr.registerExchange('utafake', () => new UtaAdapter())
    await mgr.connectExchange('u', 'utafake', { type: 'apiKey', apiKey: 'x' })
    const key = 'u:utafake'
    const errSpy = spyOn(console, 'error').mockImplementation(() => {})

    await mgr.refreshExchangeData(key)
    errSpy.mockRestore()

    const rows = db.all('SELECT id FROM exchange_balances WHERE account_id = ?', [`${key}:uta`]) as Array<{ id: string }>
    expect(rows).toHaveLength(3)
    expect(new Set(rows.map((r) => r.id)).size).toBe(3)
    expect(reconnects).toBe(0)
    expect((await mgr.getSession('u', 'utafake'))!.status).toBe('connected')
  })

  it('a failing DB write still emits the venue data and keeps the session connected', async () => {
    const adapter = new UtaAdapter()
    adapter.balanceAccountId = 'unknown' // FK violation on exchange_balances.account_id
    mgr.registerExchange('utafake', () => adapter)
    await mgr.connectExchange('u', 'utafake', { type: 'apiKey', apiKey: 'x' })
    const key = 'u:utafake'
    let emitted = 0
    mgr.on('dataRefreshed', () => {
      emitted++
    })
    const errSpy = spyOn(console, 'error').mockImplementation(() => {})

    await mgr.refreshExchangeData(key)
    errSpy.mockRestore()

    expect(emitted).toBe(1)
    expect(reconnects).toBe(0)
    expect((await mgr.getSession('u', 'utafake'))!.status).toBe('connected')
  })
})

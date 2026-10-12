import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { KaiBotDatabase } from '../../storage/database.js'
import { ExchangeManager, reconnectDelayMs } from './exchangeManager.js'
import type { ExchangeAdapter, ExchangeCredentials } from './types.js'

// 20/09/2026: the shared TradeStation token expired. connect() in CouchDB
// mode only reads the session doc (always succeeds), the first poll 401'd,
// and connectExchange had reset the attempt counter → 1s reconnects forever.
// The counter must survive a connect and only reset on a successful poll.

class ExpiredTokenAdapter implements ExchangeAdapter {
  name = 'tsfake'
  connects = 0
  accountsOk = false
  async connect(_c: ExchangeCredentials) {
    this.connects++
  }
  async disconnect() {}
  async refreshSession() {}
  async getAccounts() {
    if (!this.accountsOk) throw new Error('Failed to get accounts: unauthorized')
    return []
  }
  async getBalances() {
    return []
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
let scheduled: number[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-exmgr-backoff-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
  mgr = new ExchangeManager(db)
  scheduled = []
  // No real pollers/timers: drive the cycle by hand.
  ;(mgr as any).startDataPolling = () => {}
  ;(mgr as any).scheduleSessionRefresh = () => {}
  ;(mgr as any).scheduleReconnect = (key: string) => {
    scheduled.push(reconnectDelayMs((mgr as any).reconnectAttempts.get(key) ?? 0))
  }
})

afterEach(async () => {
  await mgr.shutdown()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('reconnectDelayMs', () => {
  it('doubles from 1s and caps at 60s', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 20].map(reconnectDelayMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000,
    ])
  })
})

describe('reconnect backoff survives a connect that only reads the session doc', () => {
  it('grows across connect→poll-fail cycles and resets after a successful poll', async () => {
    const adapter = new ExpiredTokenAdapter()
    mgr.registerExchange('tsfake', () => adapter)
    await mgr.connectExchange('u', 'tsfake', { type: 'apiKey', apiKey: 'x' })
    const key = 'u:tsfake'

    // Five cycles: poll fails → reconnect scheduled → reconnect connects → poll fails …
    for (let i = 0; i < 5; i++) {
      await mgr.refreshExchangeData(key)
      await (mgr as any).reconnectSession(key)
    }
    await mgr.refreshExchangeData(key)
    expect(scheduled).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000])
    expect(adapter.connects).toBe(6)

    // Token fixed upstream: the next poll succeeds and the counter resets.
    adapter.accountsOk = true
    await (mgr as any).reconnectSession(key)
    await mgr.refreshExchangeData(key)
    expect((mgr as any).reconnectAttempts.has(key)).toBe(false)
    expect((await mgr.getSession('u', 'tsfake'))!.status).toBe('connected')

    adapter.accountsOk = false
    await mgr.refreshExchangeData(key)
    expect(scheduled.at(-1)).toBe(1_000)
  })
})

import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { KaiBotDatabase } from '../../storage/database.js'
import { ExchangeManager } from './exchangeManager.js'
import type { ExchangeAdapter, ExchangeCredentials } from './types.js'

// EX3 regression: adapters must be per-session instances. With the old
// registry-global adapter, a second user connecting the same exchange rebound
// the first user's credentials, and disconnecting one session killed the other.

class FakeAdapter implements ExchangeAdapter {
  name = 'fakex'
  connectedWith: ExchangeCredentials | null = null
  disconnected = false
  async connect(credentials: ExchangeCredentials) {
    this.connectedWith = credentials
  }
  async disconnect() {
    this.disconnected = true
  }
  async refreshSession() {}
  async getAccounts() {
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-exmgr-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
  mgr = new ExchangeManager(db)
  // Silence the pollers so no fake network work runs after connect.
  ;(mgr as any).startDataPolling = () => {}
  ;(mgr as any).scheduleSessionRefresh = () => {}
})

afterEach(async () => {
  await mgr.shutdown()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('ExchangeManager per-session adapters', () => {
  it('gives each session its own adapter instance (no credential rebinding)', async () => {
    mgr.registerExchange('fakex', () => new FakeAdapter())

    await mgr.connectExchange('userA', 'fakex', { type: 'apiKey', apiKey: 'A' })
    await mgr.connectExchange('userB', 'fakex', { type: 'apiKey', apiKey: 'B' })

    const a = (await mgr.getSession('userA', 'fakex'))!.adapter as FakeAdapter
    const b = (await mgr.getSession('userB', 'fakex'))!.adapter as FakeAdapter

    expect(a).not.toBe(b)
    // User A's adapter still holds A's credentials after B connected.
    expect((a.connectedWith as any).apiKey).toBe('A')
    expect((b.connectedWith as any).apiKey).toBe('B')
  })

  it("disconnecting one session leaves the other session's adapter connected", async () => {
    mgr.registerExchange('fakex', () => new FakeAdapter())

    await mgr.connectExchange('userA', 'fakex', { type: 'apiKey', apiKey: 'A' })
    await mgr.connectExchange('userB', 'fakex', { type: 'apiKey', apiKey: 'B' })

    const a = (await mgr.getSession('userA', 'fakex'))!.adapter as FakeAdapter
    const b = (await mgr.getSession('userB', 'fakex'))!.adapter as FakeAdapter

    await mgr.disconnectExchange('userA', 'fakex')

    expect(a.disconnected).toBe(true)
    expect(b.disconnected).toBe(false)
    expect(await mgr.getSession('userA', 'fakex')).toBeUndefined()
    expect((await mgr.getSession('userB', 'fakex'))?.status).toBe('connected')
  })

  it('reconnecting an existing session reuses its own adapter instance', async () => {
    let built = 0
    mgr.registerExchange('fakex', () => {
      built++
      return new FakeAdapter()
    })

    await mgr.connectExchange('userA', 'fakex', { type: 'apiKey', apiKey: 'A' })
    const first = (await mgr.getSession('userA', 'fakex'))!.adapter
    await mgr.connectExchange('userA', 'fakex', { type: 'apiKey', apiKey: 'A2' })
    const second = (await mgr.getSession('userA', 'fakex'))!.adapter

    expect(second).toBe(first) // same session keeps its adapter (OAuth state)
    expect(built).toBe(1)
  })
})

// Regression: credentials encrypted under a rotated APP_SECRET/salt fail to
// decrypt on boot. This used to be a bare console.error — the venue was then
// absent from /sessions with nothing in the logs, so an operator saw "no Deribit"
// and no reason why. Seen live: a Deribit key stored two minutes before the salt
// was regenerated silently never reconnected.
describe('ExchangeManager restore failures are surfaced', () => {
  const seedConnection = (id: string, exchangeName: string, ciphertext: string) =>
    db.run(
      `INSERT OR REPLACE INTO exchange_connections
       (id, user_id, exchange_name, connection_type, encrypted_credentials, is_active, last_refresh)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
      [id, 'default', exchangeName, 'apiKey', ciphertext, Date.now()],
    )

  it('records an error session and logs when stored credentials cannot be decrypted', async () => {
    mgr.registerExchange('fakex', () => new FakeAdapter())
    seedConnection('default:fakex', 'fakex', 'not:valid:ciphertext')

    await mgr.restoreSessions()

    const session = await mgr.getSession('default', 'fakex')
    expect(session?.status).toBe('error')
    expect(session?.error).toContain('re-enter')

    const logs = db.getRecentLogs(20, 'error') as any[]
    expect(logs.some((l) => l.category === 'exchange' && /Failed to restore fakex/.test(l.message))).toBe(true)
  })

  it('does not schedule a reconnect for an undecryptable credential', async () => {
    mgr.registerExchange('fakex', () => new FakeAdapter())
    seedConnection('default:fakex', 'fakex', 'not:valid:ciphertext')

    await mgr.restoreSessions()

    // Retrying the same dead ciphertext can never succeed; only the user
    // re-entering the key does.
    expect((mgr as any).reconnectTimeouts.size).toBe(0)
  })

  it('logs when a decryptable session fails to connect', async () => {
    mgr.registerExchange('fakex', () => {
      const a = new FakeAdapter()
      a.connect = async () => {
        throw new Error('venue unreachable')
      }
      return a
    })
    // Encrypt through the manager's own Crypto so the blob decrypts cleanly.
    const ciphertext = (mgr as any).crypto.encryptCredentials({ type: 'apiKey', apiKey: 'A' })
    seedConnection('default:fakex', 'fakex', ciphertext)

    await mgr.restoreSessions()

    const logs = db.getRecentLogs(20, 'error') as any[]
    expect(logs.some((l) => l.category === 'exchange' && /Failed to restore fakex/.test(l.message))).toBe(true)
    expect((await mgr.getSession('default', 'fakex'))?.status).toBe('error')
  })
})

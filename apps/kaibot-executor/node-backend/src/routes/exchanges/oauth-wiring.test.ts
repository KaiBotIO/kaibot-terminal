import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Hono } from 'hono'
import { KaiBotDatabase } from '../../storage/database.js'
import { ExchangeManager } from '../../services/exchanges/exchangeManager.js'
import { TradeStationOAuthAdapter } from '../../services/exchanges/adapters/tradestation-oauth.js'
import { createExchangeRoutes } from './index.js'

// Item 5: the executor registers the self-managing OAuth adapter as the
// 'tradestation' exchange, and the callback route routes ?code= to the
// adapter's handleAuthorizationCallback (via ExchangeManager.completeOAuthFlow).

let dir: string
let db: KaiBotDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-oauth-wiring-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('TradeStation OAuth adapter registration', () => {
  it('registers the OAuth adapter (not CouchDB) for the "tradestation" exchange', () => {
    const mgr = new ExchangeManager(db)
    mgr.registerExchange('tradestation', () => new TradeStationOAuthAdapter())

    const adapter = mgr.createAdapter('tradestation')
    expect(adapter).toBeInstanceOf(TradeStationOAuthAdapter)
    expect(adapter?.name).toBe('tradestation')
    // The OAuth adapter exposes the authorize-flow surface; the CouchDB one does not.
    expect(typeof (adapter as any).handleAuthorizationCallback).toBe('function')
    expect(typeof (adapter as any).getStorableCredentials).toBe('function')
  })
})

describe('TradeStation OAuth callback route', () => {
  it('routes the ?code= from the callback to handleAuthorizationCallback', async () => {
    const mgr = new ExchangeManager(db)
    const adapter = new TradeStationOAuthAdapter()

    // Capture the code and avoid hitting the real token endpoint / pollers.
    let receivedCode: string | undefined
    ;(adapter as any).handleAuthorizationCallback = async (code: string) => {
      receivedCode = code
    }
    ;(adapter as any).getStorableCredentials = () => undefined
    ;(adapter as any).subscribeToUpdates = () => {}
    mgr.registerExchange('tradestation', () => adapter)

    // Seed a pending_oauth session so completeOAuthFlow proceeds.
    ;(mgr as any).sessions.set('default:tradestation', {
      userId: 'default',
      exchangeName: 'tradestation',
      adapter,
      status: 'pending_oauth',
    })
    // Stop the post-callback data polling from firing real network calls.
    ;(mgr as any).startDataPolling = () => {}
    ;(mgr as any).scheduleSessionRefresh = () => {}

    const app = new Hono()
    app.route('/api/exchanges/v2', createExchangeRoutes(db, mgr))

    const res = await app.request(
      '/api/exchanges/v2/callback/tradestation?code=abc123&state=default',
    )

    // The handler redirects the browser back to the app after a successful exchange.
    expect(res.status).toBe(302)
    expect(receivedCode).toBe('abc123')
    // The session is now connected.
    const session = await mgr.getSession('default', 'tradestation')
    expect(session?.status).toBe('connected')
  })

  it('returns 400 when the callback is missing the code', async () => {
    const mgr = new ExchangeManager(db)
    mgr.registerExchange('tradestation', () => new TradeStationOAuthAdapter())

    const app = new Hono()
    app.route('/api/exchanges/v2', createExchangeRoutes(db, mgr))

    const res = await app.request('/api/exchanges/v2/callback/tradestation')
    expect(res.status).toBe(400)
  })
})

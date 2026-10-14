import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Hono } from 'hono'
import { KaiBotDatabase } from '../storage/database.js'
import { createOperationsRoutes } from './operations.js'
import type { ExchangeManager } from '../services/exchanges/exchangeManager.js'
import type { CryptoMarket } from '../services/crypto-markets.js'

let dir: string
let db: KaiBotDatabase
let app: Hono

// One Deribit connection, flat, with a public ticker.
const session = (accountKey: string | null) => ({
  exchangeName: 'deribit',
  label: accountKey ?? 'default',
  accountKey,
  status: 'connected',
  adapter: {
    getPositions: async () => [],
    getMarketTicker: async (symbol: string) => ({
      mark: symbol.startsWith('BTC') ? 79_500 : 2450,
      change24hPct: -1.42,
      fundingRate: 0.000042,
    }),
  },
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-markets-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
  app = new Hono()
  const manager = {
    getAllSessions: async () => [session(null), session('acct1')],
    getSession: async () => null,
  } as unknown as ExchangeManager
  app.route('/api/ops', createOperationsRoutes(db, manager))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const markets = async () => {
  const res = await app.request('/api/ops/markets')
  expect(res.status).toBe(200)
  return (await res.json()) as { crypto: CryptoMarket[] }
}

// Kai, 2026-09-05: "Crypto markets 0" while three connections were live. The
// section only listed markets holding an open position.
describe('GET /markets crypto', () => {
  it('lists a subscribed market on a flat connection, priced from the ticker', async () => {
    db.upsertSubscription({
      id: 'local-btc',
      signalBotId: 'bot-btc',
      factor: 1,
      exchange: 'deribit',
      selectedMarkets: ['BTC'],
    })

    const { crypto } = await markets()
    expect(crypto).toHaveLength(1)
    expect(crypto[0].symbol).toBe('BTC-PERPETUAL')
    expect(crypto[0].connection).toBe('deribit')
    expect(crypto[0].sources).toEqual(['subscription'])
    expect(crypto[0].last).toBe(79_500)
    expect(crypto[0].change24hPct).toBe(-1.42)
    expect(crypto[0].fundingRate).toBe(0.000042)
    expect(crypto[0].open).toBe(true)
    expect(crypto[0].position).toBeNull()
  })

  it('is empty when nothing is subscribed, armed or held', async () => {
    expect((await markets()).crypto).toEqual([])
  })
})

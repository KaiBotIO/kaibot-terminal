import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Hono } from 'hono'
import { KaiBotDatabase } from '../storage/database.js'
import { createSubscriptionRoutes, parseRegimeSettings } from './subscriptions.js'
import { isViewerAllowed } from '../auth/roles.js'
import { createRegimeService } from '../services/regime.js'
import type { RegimeApiResponse } from '@kaibot/types/core'

let dir: string
let db: KaiBotDatabase
let app: Hono

const state = (label: string, since: string) => ({ label, since, phaseSince: since, weekClosed: '2026-10-05', close: 1, sma40: 1, sma40_4ago: 1 })
const SNAP = {
  computedAt: '2026-10-12T01:00:00.000Z',
  markets: { MNQ: state('late_bull', '2026-04-06'), BTC: state('not_bull', '2025-11-10'), ALTS: { ...state('not_bull', '2025-11-10'), source: 'BTC' } },
} as RegimeApiResponse

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-subs-regime-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
  app = new Hono()
  app.route('/api/subscriptions', createSubscriptionRoutes(db))
  db.upsertSubscription({ id: 's1', signalBotId: 'bot1', factor: 1, exchange: 'tradestation', accountId: 'ACC1', selectedMarkets: ['MNQ'] })
  db.upsertSubscription({ id: 's2', signalBotId: 'bot2', factor: 1, exchange: 'bybit', selectedMarkets: ['SUIUSDT'] })
  db.saveRegimeSnapshot(SNAP)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const patch = (id: string, body: unknown) =>
  app.request(`/api/subscriptions/${id}`, { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const one = async (id: string) => ((await (await app.request(`/api/subscriptions/${id}`)).json()) as any).subscription

describe('regime factors on the subscription API', () => {
  it('GET derives the group and reads the label; no factors = x1', async () => {
    const rows = (await (await app.request('/api/subscriptions')).json()) as any[]
    expect(rows.find((r) => r.id === 's1')).toMatchObject({
      regimeFactors: null,
      regimeMarket: null,
      regime: { market: 'MNQ', label: 'late_bull', since: '2026-04-06', multiplier: 1 },
    })
    expect(rows.find((r) => r.id === 's2').regime).toMatchObject({ market: 'ALTS', label: 'not_bull' })
  })

  it('PATCH round trip: set, absent key untouched, null clears', async () => {
    expect((await patch('s1', { regimeFactors: { lateBull: 1.5, notBull: 0.5 } })).status).toBe(200)
    expect(await one('s1')).toMatchObject({ regimeFactors: { lateBull: 1.5, notBull: 0.5 }, regime: { multiplier: 1.5 } })

    expect((await patch('s1', { factor: 2 })).status).toBe(200)
    expect(await one('s1')).toMatchObject({ factor: 2, regimeFactors: { lateBull: 1.5, notBull: 0.5 } })

    expect((await patch('s1', { regimeMarket: 'MGC' })).status).toBe(200)
    expect(await one('s1')).toMatchObject({ regimeMarket: 'MGC', regime: { market: 'MGC', label: 'unknown', multiplier: 1 } })

    expect((await patch('s1', { regimeFactors: null, regimeMarket: null })).status).toBe(200)
    expect(await one('s1')).toMatchObject({ regimeFactors: null, regimeMarket: null, regime: { market: 'MNQ', multiplier: 1 } })
  })

  it('pot rules stay untouched by a regime patch', async () => {
    db.setSubscriptionPotRules('s1', { maxTradePct: 25, noSameDayReuse: true })
    await patch('s1', { regimeFactors: { earlyBull: 2 } })
    expect(await one('s1')).toMatchObject({ maxTradePct: 25, noSameDayReuse: true, regimeFactors: { earlyBull: 2 } })
  })

  it('rejects bad input', async () => {
    expect((await patch('s1', { regimeFactors: { lateBull: -1 } })).status).toBe(400)
    expect((await patch('s1', { regimeFactors: { bull: 1 } })).status).toBe(400)
    expect((await patch('s1', { regimeFactors: [1] })).status).toBe(400)
    expect((await patch('s1', { regimeMarket: 'DOGE' })).status).toBe(400)
  })

  it('parseRegimeSettings: empty object clears, null keys drop', () => {
    expect(parseRegimeSettings({})).toEqual({ patch: {} })
    expect(parseRegimeSettings({ regimeFactors: {} })).toEqual({ patch: { regimeFactors: null } })
    expect(parseRegimeSettings({ regimeFactors: { lateBull: 1.5, earlyBull: null } })).toEqual({ patch: { regimeFactors: { lateBull: 1.5 } } })
  })

  it('viewer may read /api/regime, not change it', () => {
    expect(isViewerAllowed('GET', '/api/regime')).toBe(true)
    expect(isViewerAllowed('PATCH', '/api/subscriptions/s1')).toBe(false)
  })
})

describe('regime service', () => {
  const deps = (fetchImpl: (url: string) => Promise<Response>) => ({
    getApiUrl: () => 'https://api.example/',
    getApiKey: () => 'kb_test',
    fetchImpl,
  })

  it('stores a good answer and calls the API with the key', async () => {
    let seen = ''
    const svc = createRegimeService(db, deps(async (url) => {
      seen = url
      return new Response(JSON.stringify({ ...SNAP, markets: { MGC: state('not_bull', '2026-08-24') } }))
    }))
    expect(await svc.refresh()).toBe(true)
    expect(seen).toBe('https://api.example/api/regime')
    expect(db.getRegimeSnapshot()!.body.markets.MGC!.label).toBe('not_bull')
  })

  it('an outage or a malformed answer keeps the last label', async () => {
    expect(await createRegimeService(db, deps(async () => new Response('down', { status: 502 }))).refresh()).toBe(false)
    expect(await createRegimeService(db, deps(async () => { throw new Error('ECONNREFUSED') })).refresh()).toBe(false)
    expect(await createRegimeService(db, deps(async () => new Response(JSON.stringify({ markets: { MNQ: { label: 'bullish' } } })))).refresh()).toBe(false)
    expect(db.getRegimeSnapshot()!.body.markets.MNQ!.label).toBe('late_bull')
  })

  it('one warn line per change when a group is older than 14 days', async () => {
    const body = { ...SNAP, markets: { MNQ: { ...state('late_bull', '2026-04-06'), weekClosed: '2026-09-14' }, BTC: state('not_bull', '2025-11-10') } }
    const now = Date.parse('2026-10-12T12:00:00Z') // MNQ week closed 21/09 = 21 days ago, BTC 05/10 closed 12/10
    const svc = createRegimeService(db, { ...deps(async () => new Response(JSON.stringify(body))), now: () => now })
    await svc.refresh()
    await svc.refresh()
    const warns = (db.all("SELECT message FROM logs WHERE category = 'regime' AND level = 'warn'") as any[]).map((r) => r.message)
    expect(warns).toEqual(['Regime data stale for MNQ: last closed week older than 14 days'])
  })

  it('no API config = no fetch', async () => {
    const svc = createRegimeService(db, { getApiUrl: () => null, getApiKey: () => null, fetchImpl: async () => { throw new Error('called') } })
    expect(await svc.refresh()).toBe(false)
  })
})

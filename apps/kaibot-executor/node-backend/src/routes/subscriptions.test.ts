import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Hono } from 'hono'
import { KaiBotDatabase } from '../storage/database.js'
import { createSubscriptionRoutes } from './subscriptions.js'

let dir: string
let db: KaiBotDatabase
let app: Hono

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-subs-route-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
  app = new Hono()
  app.route('/api/subscriptions', createSubscriptionRoutes(db))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

// Regression (delta review 2026-07-08): sizeUnit is persisted and drives the live
// sizing path, but the GET endpoints dropped it, so the edit view could never
// show or round-trip the current unit. Both list and detail must return it.
describe('subscriptions sizeUnit round-trip', () => {
  it('GET / returns the persisted size_unit', async () => {
    db.upsertSubscription({ id: 's-usd', signalBotId: 'bot1', factor: 1, exchange: 'deribit', sizeUnit: 'usd' })
    db.upsertSubscription({ id: 's-native', signalBotId: 'bot2', factor: 1, exchange: 'deribit' })

    const res = await app.request('/api/subscriptions')
    expect(res.status).toBe(200)
    const rows = (await res.json()) as Array<{ id: string; sizeUnit: string }>
    expect(rows.find((r) => r.id === 's-usd')?.sizeUnit).toBe('usd')
    // Unset defaults to the effective 'native'.
    expect(rows.find((r) => r.id === 's-native')?.sizeUnit).toBe('native')
  })

  it('GET /:id returns the persisted size_unit', async () => {
    db.upsertSubscription({ id: 's1', signalBotId: 'bot1', factor: 1, exchange: 'deribit', sizeUnit: 'usd' })

    const res = await app.request('/api/subscriptions/s1')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { subscription: { sizeUnit: string } }
    expect(body.subscription.sizeUnit).toBe('usd')
  })
})

// Regression (TS live blockers 2026-08): nothing ever set account_id, so every
// TradeStation order went out with AccountID 'default' — an invalid broker
// account. Creating/re-routing a tradestation subscription without a real bare
// AccountID must fail loudly at config time.
describe('subscription account routing (multi-account venues)', () => {
  const post = (body: Record<string, unknown>) =>
    app.request('/api/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signalBotId: 'bot1', factor: 1, exchange: 'tradestation', ...body }),
    })

  it('rejects a tradestation create without accountId', async () => {
    const res = await post({})
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toContain('accountId')
  })

  it("rejects the 'default' fallback as accountId", async () => {
    const res = await post({ accountId: 'default' })
    expect(res.status).toBe(400)
  })

  it('rejects a prefixed adapter id (tradestation:123)', async () => {
    const res = await post({ accountId: 'tradestation:21084931' })
    expect(res.status).toBe(400)
  })

  it('accepts and persists a bare AccountID', async () => {
    // The route best-effort syncs to the server first — keep that off the network.
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch
    try {
      const res = await post({ accountId: '21084931' })
      expect(res.status).toBe(200)
      const { id } = (await res.json()) as { id: string }
      expect(db.getSubscription(id).account_id).toBe('21084931')
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('crypto venues stay accountless (no picker required)', async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch
    try {
      const res = await post({ exchange: 'deribit' })
      expect(res.status).toBe(200)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it("PATCH refuses re-routing a tradestation sub to 'default', keeps factor-only edits working", async () => {
    db.upsertSubscription({
      id: 'ts-sub',
      signalBotId: 'bot1',
      factor: 1,
      exchange: 'tradestation',
      accountId: '21084931',
    })

    const bad = await app.request('/api/subscriptions/ts-sub', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'default' }),
    })
    expect(bad.status).toBe(400)
    expect(db.getSubscription('ts-sub').account_id).toBe('21084931')

    const ok = await app.request('/api/subscriptions/ts-sub', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ factor: 2 }),
    })
    expect(ok.status).toBe(200)
    expect(db.getSubscription('ts-sub').factor).toBe(2)
    expect(db.getSubscription('ts-sub').account_id).toBe('21084931')
  })
})

// Regression (live-data-review 28/08): the detail route matched signals with
// `metadata LIKE '%<subscriptionId>%'`, but a signal's metadata carries the
// SIGNAL BOT id, never the local subscription id. Every subscription therefore
// reported "SIGNALS (24H) 0" and "No signals yet" while signals were arriving.
describe('subscription signal counts match on the signal bot id', () => {
  const recordSignal = async (id: string, botId: string) =>
    db.recordSignal({
      id,
      strategyId: 'strat',
      strategyName: 'Ascender MGC 15m',
      symbol: 'MGCZ26',
      action: 'buy',
      metadata: { signalBotId: botId },
    })

  it('counts the bot signals of a local subscription', async () => {
    db.upsertSubscription({
      id: 'local-abc',
      signalBotId: 'bot-mgc',
      factor: 1,
      exchange: 'tradestation',
      accountId: '21084933',
    })
    await recordSignal('sig-1', 'bot-mgc')
    await recordSignal('sig-2', 'bot-mgc')
    await recordSignal('sig-other', 'bot-mnq')

    const res = await app.request('/api/subscriptions/local-abc')
    const body = (await res.json()) as { signalCount24h: number; signals: unknown[] }
    expect(body.signalCount24h).toBe(2)
    expect(body.signals).toHaveLength(2)
  })

  it('does not leak another bot signals into the count', async () => {
    db.upsertSubscription({
      id: 'local-def',
      signalBotId: 'bot-mnq',
      factor: 1,
      exchange: 'tradestation',
      accountId: '21084931',
    })
    await recordSignal('sig-3', 'bot-mgc')

    const res = await app.request('/api/subscriptions/local-def')
    const body = (await res.json()) as { signalCount24h: number; signals: unknown[] }
    expect(body.signalCount24h).toBe(0)
    expect(body.signals).toHaveLength(0)
  })

  it('still matches metadata that carries the subscription id itself', async () => {
    db.upsertSubscription({ id: 'bot-self', signalBotId: 'bot-self', factor: 1, exchange: 'deribit' })
    await recordSignal('sig-4', 'bot-self')

    const res = await app.request('/api/subscriptions/bot-self')
    const body = (await res.json()) as { signalCount24h: number }
    expect(body.signalCount24h).toBe(1)
  })
})

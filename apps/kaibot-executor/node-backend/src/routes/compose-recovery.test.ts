import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Hono } from 'hono'
import { KaiBotDatabase } from '../storage/database.js'
import { createComposeRecoveryRoutes } from './compose-recovery.js'
import {
  createRecoveryComposeService,
  RecoveryComposeError,
  type FetchLike,
  type RecoveryComposeDeps,
} from '../services/recovery-compose.js'

let dir: string
let db: KaiBotDatabase

// Route + real compose service, with fetch mocked — exercises the tRPC
// envelope handling and the status/code translation end to end.
function buildApp(fetchImpl: FetchLike, over: Partial<RecoveryComposeDeps> = {}) {
  const service = createRecoveryComposeService({
    getApiUrl: () => 'https://api.example',
    getApiKey: () => 'kb_test_key',
    fetchImpl,
    ...over,
  })
  const app = new Hono()
  app.route('/api/trade', createComposeRecoveryRoutes(db, service))
  return app
}

const validBody = {
  extreme: 100,
  entry: 90,
  totalQty: 10,
  assetClass: 'crypto',
  levels: 4,
  includeRecoveryTail: true,
}

function post(app: Hono, body: unknown) {
  return app.request('/api/trade/compose-recovery', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const trpcOk = (data: unknown) =>
  new Response(JSON.stringify({ result: { data: { json: data } } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const trpcErr = (status: number, message: string) =>
  new Response(
    JSON.stringify({ error: { json: { message, data: { httpStatus: status } } } }),
    { status, headers: { 'content-type': 'application/json' } },
  )

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-compose-route-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('POST /api/trade/compose-recovery', () => {
  it('returns rungs from the cloud calculator (happy path)', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const result = {
      rungs: [
        { price: 95, size: 4 },
        { price: 88, size: 6 },
      ],
      avgIfAllFilled: 90.6,
      meta: { levelsUsed: 2 },
    }
    const app = buildApp(((url: any, init: any) => {
      calls.push({ url: String(url), init })
      return Promise.resolve(trpcOk(result))
    }))

    const res = await post(app, validBody)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(result)

    // The cloud call carries the user's key and the superjson input envelope.
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.example/api/trpc/manualTools.computeRecoveryLadder')
    expect((calls[0].init.headers as Record<string, string>)['X-API-Key']).toBe('kb_test_key')
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ json: validBody })
  })

  it('unwraps a non-superjson result envelope too', async () => {
    const result = { rungs: [{ price: 95, size: 10 }], avgIfAllFilled: 95, meta: { levelsUsed: 1 } }
    const app = buildApp((() =>
      Promise.resolve(
        new Response(JSON.stringify({ result: { data: result } }), { status: 200 }),
      )))
    const res = await post(app, validBody)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(result)
  })

  it('translates 401 to unauthorized', async () => {
    const app = buildApp((() => Promise.resolve(trpcErr(401, 'Invalid API key'))))
    const res = await post(app, validBody)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Invalid API key', code: 'unauthorized' })
  })

  it('translates the entitlement 403 to a plan message', async () => {
    const app = buildApp((() =>
      Promise.resolve(trpcErr(403, 'UPGRADE_REQUIRED:platform'))))
    const res = await post(app, validBody)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Not available on your plan.', code: 'forbidden' })
  })

  it('translates 429 to rate-limited and keeps the server message', async () => {
    const app = buildApp((() =>
      Promise.resolve(
        trpcErr(429, 'Too many calculator requests — wait a minute and retry.'),
      )))
    const res = await post(app, validBody)
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({
      error: 'Too many calculator requests — wait a minute and retry.',
      code: 'rate-limited',
    })
  })

  it('translates a server-side 400 (calculator validation) to bad-request', async () => {
    const app = buildApp((() =>
      Promise.resolve(trpcErr(400, 'entry must differ from extreme'))))
    const res = await post(app, validBody)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: 'entry must differ from extreme',
      code: 'bad-request',
    })
  })

  it('reports no-config when no API key is set, without calling the cloud', async () => {
    let called = false
    const app = buildApp(
      () => {
        called = true
        return Promise.resolve(trpcOk({}))
      },
      { getApiKey: () => null },
    )
    const res = await post(app, validBody)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code: string; error: string }
    expect(body.code).toBe('no-config')
    expect(body.error).toContain('Settings')
    expect(called).toBe(false)
  })

  it('maps a network failure to 502 unavailable', async () => {
    const app = buildApp((() => Promise.reject(new Error('ECONNREFUSED'))))
    const res = await post(app, validBody)
    expect(res.status).toBe(502)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('unavailable')
  })

  it('rejects a malformed calculator response instead of passing it through', async () => {
    const app = buildApp((() =>
      Promise.resolve(
        trpcOk({ rungs: [{ price: 'x', size: 1 }], avgIfAllFilled: 1, meta: { levelsUsed: 1 } }),
      )))
    const res = await post(app, validBody)
    expect(res.status).toBe(502)
  })

  it('validates input shape locally before any cloud call', async () => {
    let called = false
    const app = buildApp(() => {
      called = true
      return Promise.resolve(trpcOk({}))
    })

    for (const bad of [
      { ...validBody, extreme: -1 },
      { ...validBody, entry: 0 },
      { ...validBody, totalQty: Number.NaN },
      { ...validBody, assetClass: 'forex' },
      { ...validBody, levels: -3 },
    ]) {
      const res = await post(app, bad)
      expect(res.status).toBe(400)
      expect(((await res.json()) as { code: string }).code).toBe('bad-request')
    }
    expect(called).toBe(false)
  })
})

describe('RecoveryComposeError', () => {
  it('carries code and status', () => {
    const e = new RecoveryComposeError('m', 'forbidden', 403)
    expect(e.code).toBe('forbidden')
    expect(e.status).toBe(403)
  })
})

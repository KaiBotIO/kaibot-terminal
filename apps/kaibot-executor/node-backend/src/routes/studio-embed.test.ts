import { describe, expect, it } from 'bun:test'
import { createStudioEmbedRoutes, resolvePairing } from './studio-embed.js'

// The browser only ever sees the verify URL; the API key stays on this side.

function fakeDb(settings?: object) {
  return {
    logs: [] as any[],
    getAdminUser: () => (settings ? { settings: JSON.stringify(settings) } : undefined),
    log(level: string, category: string, message: string, data?: unknown) {
      this.logs.push({ level, message, data })
    },
  }
}

describe('resolvePairing', () => {
  it('prefers the live signal-client pairing, falls back to settings + env', () => {
    const db = fakeDb({ apiConfig: { apiUrl: 'https://api.kaibot.io/', apiKey: 'kb_settings' } })
    expect(
      resolvePairing(db as any, { getApiUrl: () => 'https://api.kaibot.io', getApiKey: () => 'kb_live' }),
    ).toEqual({ apiUrl: 'https://api.kaibot.io', apiKey: 'kb_live' })
    expect(resolvePairing(db as any, { getApiUrl: () => null, getApiKey: () => null })).toEqual({
      apiUrl: 'https://api.kaibot.io',
      apiKey: 'kb_settings',
    })
    expect(resolvePairing(fakeDb() as any, { getApiUrl: () => null, getApiKey: () => null })).toBeNull()
  })
})

describe('GET /embed-token', () => {
  const build = (fetchImpl: typeof fetch, pairing = { url: 'https://api.kaibot.io', key: 'kb_live' } as { url: string | null; key: string | null }) => {
    const db = fakeDb()
    const app = createStudioEmbedRoutes(db as any, {
      getApiUrl: () => pairing.url,
      getApiKey: () => pairing.key,
      fetchImpl,
    })
    return { app, db }
  }

  it('sends the key upstream and returns only the verify URL', async () => {
    const seen: Array<{ url: string; key: string | null }> = []
    const { app } = build(async (url, init) => {
      seen.push({ url: String(url), key: new Headers(init?.headers).get('x-api-key') })
      return Response.json({ token: 'tok123', expiresAt: '2026-09-05T12:00:00Z', verifyPath: '/api/auth/embed/verify' })
    })
    const res = await app.request('/embed-token')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { verifyUrl: string }
    expect(seen).toEqual([{ url: 'https://api.kaibot.io/api/auth/embed/token', key: 'kb_live' }])
    expect(body.verifyUrl).toBe('https://api.kaibot.io/api/auth/embed/verify?token=tok123')
    expect(JSON.stringify(body)).not.toContain('kb_live')
  })

  // Live smoke 2026-09-05: better-auth answered 415 "Content-Type is required.
  // Allowed types: application/json" to the bare POST. The mock enforces the
  // same content check.
  it('REGRESSION: the mint is a JSON POST (better-auth 415s anything else)', async () => {
    const { app } = build(async (_url, init) => {
      const headers = new Headers(init?.headers)
      if (init?.method !== 'POST' || !headers.get('content-type')?.includes('application/json')) {
        return Response.json(
          { message: 'Content-Type is required. Allowed types: application/json' },
          { status: 415 },
        )
      }
      // A JSON body that must parse — better-auth reads it even when empty.
      JSON.parse(typeof init.body === 'string' ? init.body : '')
      return Response.json({ token: 'tok', expiresAt: '2026-09-05T12:00:00Z', verifyPath: '/api/auth/embed/verify' })
    })
    const res = await app.request('/embed-token')
    expect(res.status).toBe(200)
    expect(((await res.json()) as { verifyUrl: string }).verifyUrl).toContain('token=tok')
  })

  it('503 without a pairing, 502 when the API refuses the key', async () => {
    const { app: unpaired } = build(async () => Response.json({}), { url: null, key: null })
    expect((await unpaired.request('/embed-token')).status).toBe(503)

    const { app: refused } = build(async () => new Response('nope', { status: 401 }))
    const res = await refused.request('/embed-token')
    expect(res.status).toBe(502)
    expect(((await res.json()) as { error: string }).error).toBe('unauthorized')
  })
})

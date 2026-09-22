import { Hono } from 'hono'
import type { KaiBotDatabase } from '../storage/database.js'

// Studio-in-Terminal embed hand-off, executor side. The Chart page frames
// KaiBot Studio; Studio's Lax session cookie never travels into a cross-site
// iframe, so the frame showed the sign-in page. This route trades the
// executor's pairing (the per-user API key) for a short-lived, single-use
// embed token from the API and hands the browser ONLY the verify URL — the
// key itself never leaves this backend. Server side: apps/api embed-handoff.

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export interface StudioEmbedDeps {
  // Pairing the signal client connected with; falls back to the stored
  // settings / env so the route also works before the WS is up.
  getApiUrl(): string | null
  getApiKey(): string | null
  fetchImpl?: typeof fetch
}

export function resolvePairing(db: KaiBotDatabase, deps: StudioEmbedDeps): { apiUrl: string; apiKey: string } | null {
  let apiUrl = deps.getApiUrl()
  let apiKey = deps.getApiKey()
  if (!apiUrl || !apiKey) {
    const user = db.getAdminUser() as { settings?: string | null } | undefined
    let settings: { apiConfig?: { apiUrl?: string; apiKey?: string } } = {}
    try {
      settings = user?.settings ? JSON.parse(user.settings) : {}
    } catch {
      settings = {}
    }
    apiUrl = apiUrl || settings.apiConfig?.apiUrl || process.env.KAIBOT_API_URL || null
    apiKey = apiKey || settings.apiConfig?.apiKey || null
  }
  if (!apiUrl || !apiKey) return null
  return { apiUrl: apiUrl.replace(/\/$/, ''), apiKey }
}

export function createStudioEmbedRoutes(db: KaiBotDatabase, deps: StudioEmbedDeps) {
  const app = new Hono()
  const doFetch = deps.fetchImpl ?? fetch

  app.get('/embed-token', async (c) => {
    const pairing = resolvePairing(db, deps)
    if (!pairing) {
      return c.json({ error: 'not_configured', message: 'No API key paired with KaiBot Studio.' }, 503)
    }
    try {
      // better-auth rejects a POST without a JSON content-type (415, live
      // smoke 2026-09-05) even when the endpoint reads no body — send an
      // empty JSON object.
      const res = await doFetch(`${pairing.apiUrl}/api/auth/embed/token`, {
        method: 'POST',
        headers: { 'x-api-key': pairing.apiKey, 'content-type': 'application/json' },
        body: '{}',
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        db.log('warn', 'system', 'Studio embed token refused', { status: res.status, body: text.slice(0, 200) })
        return c.json({ error: res.status === 401 ? 'unauthorized' : 'upstream', status: res.status }, 502)
      }
      const body = (await res.json()) as { token: string; expiresAt: string; verifyPath?: string }
      const verifyPath = body.verifyPath || '/api/auth/embed/verify'
      const verifyUrl = `${pairing.apiUrl}${verifyPath}?token=${encodeURIComponent(body.token)}`
      return c.json({ verifyUrl, expiresAt: body.expiresAt })
    } catch (error) {
      db.log('warn', 'system', 'Studio embed token request failed', { error: errMsg(error) })
      return c.json({ error: 'upstream', message: errMsg(error) }, 502)
    }
  })

  return app
}

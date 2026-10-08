import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { isPublicApiPath, PUBLIC_API_PATHS } from './public-paths.js'
import { createAuthMiddleware, hashToken } from './session.js'

// Regression (screens review 06/10/2026): GET /api/auth/me was public and
// returned the admin username to any LAN caller without a session.

const TOKEN = 'a'.repeat(64)

function app() {
  const db = {
    getValidAuthSession: (h: string) =>
      h === hashToken(TOKEN) ? { id: 1, user_id: 1, expires_at: '', role: 'admin' } : undefined,
    listAccountGrants: () => [],
  }
  const requireAuth = createAuthMiddleware(db as never)
  const a = new Hono()
  a.use('/api/*', async (c, next) => (isPublicApiPath(c.req.path) ? next() : requireAuth(c, next)))
  a.get('/api/auth/me', (c) => c.json({ username: 'kai' }))
  a.get('/api/auth/setup-status', (c) => c.json({ setupRequired: false }))
  return a
}

describe('public API paths', () => {
  it('does not expose /api/auth/me', () => {
    expect(isPublicApiPath('/api/auth/me')).toBe(false)
  })

  it('/api/auth/me without a session is 401 and names nobody', async () => {
    const res = await app().request('/api/auth/me')
    expect(res.status).toBe(401)
    expect(await res.text()).not.toContain('kai')
  })

  it('/api/auth/me with a session still answers', async () => {
    const res = await app().request('/api/auth/me', { headers: { Authorization: `Bearer ${TOKEN}` } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ username: 'kai' })
  })

  it('the setup probe the login/setup screens use stays public', async () => {
    expect(PUBLIC_API_PATHS.has('/api/auth/setup-status')).toBe(true)
    const res = await app().request('/api/auth/setup-status')
    expect(res.status).toBe(200)
  })
})

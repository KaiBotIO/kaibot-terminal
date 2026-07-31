import { describe, expect, it, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import {
  generateSessionToken,
  hashToken,
  issueSession,
  revokeSession,
  extractToken,
  createAuthMiddleware,
} from './session.js'

// In-memory fake of the bits of KaiBotDatabase the auth module touches.
class FakeAuthDb {
  private sessions = new Map<string, { userId: number; expiresAt: number }>()
  purged = 0

  createAuthSession(tokenHash: string, userId: number, expiresAt: Date) {
    this.sessions.set(tokenHash, { userId, expiresAt: expiresAt.getTime() })
  }

  getValidAuthSession(tokenHash: string) {
    const s = this.sessions.get(tokenHash)
    if (!s) return undefined
    if (s.expiresAt <= Date.now()) return undefined
    return { id: 1, user_id: s.userId, expires_at: new Date(s.expiresAt).toISOString() }
  }

  deleteAuthSession(tokenHash: string) {
    this.sessions.delete(tokenHash)
  }

  purgeExpiredAuthSessions() {
    this.purged++
    for (const [hash, s] of this.sessions) {
      if (s.expiresAt <= Date.now()) this.sessions.delete(hash)
    }
  }

  // Expose an expired insert for testing.
  insertExpired(tokenHash: string, userId: number) {
    this.sessions.set(tokenHash, { userId, expiresAt: Date.now() - 1000 })
  }
}

describe('token helpers', () => {
  it('generates distinct 64-char hex tokens', () => {
    const a = generateSessionToken()
    const b = generateSessionToken()
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toBe(b)
  })

  it('hashes deterministically and not equal to the raw token', () => {
    const token = 'abc123'
    expect(hashToken(token)).toBe(hashToken(token))
    expect(hashToken(token)).not.toBe(token)
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('issueSession / revokeSession', () => {
  it('issues a token whose hash is stored and validates', () => {
    const db = new FakeAuthDb()
    const token = issueSession(db as any, 7)
    expect(db.purged).toBe(1) // opportunistic purge
    const row = db.getValidAuthSession(hashToken(token))
    expect(row?.user_id).toBe(7)
  })

  it('revokes a session so it no longer validates', () => {
    const db = new FakeAuthDb()
    const token = issueSession(db as any, 7)
    revokeSession(db as any, token)
    expect(db.getValidAuthSession(hashToken(token))).toBeUndefined()
  })

  it('does not validate an expired session', () => {
    const db = new FakeAuthDb()
    const token = 'expired-token'
    db.insertExpired(hashToken(token), 7)
    expect(db.getValidAuthSession(hashToken(token))).toBeUndefined()
  })
})

describe('extractToken', () => {
  const ctx = (headers: Record<string, string>) =>
    ({ req: { header: (name: string) => headers[name.toLowerCase()] } } as any)

  it('reads a Bearer token from Authorization', () => {
    expect(extractToken(ctx({ authorization: 'Bearer xyz' }))).toBe('xyz')
    expect(extractToken(ctx({ authorization: 'bearer  spaced ' }))).toBe('spaced')
  })

  it('reads x-auth-token', () => {
    expect(extractToken(ctx({ 'x-auth-token': 'tok' }))).toBe('tok')
  })

  it('returns null when no token is present', () => {
    expect(extractToken(ctx({}))).toBeNull()
    expect(extractToken(ctx({ authorization: 'Basic foo' }))).toBeNull()
  })
})

describe('createAuthMiddleware', () => {
  let db: FakeAuthDb
  let app: Hono

  const mountProtected = (opts: { trustLocal?: boolean } = {}) => {
    app = new Hono()
    app.use('/protected', createAuthMiddleware(db as any, opts))
    app.get('/protected', (c) => c.json({ ok: true, userId: c.get('userId') }))
  }

  beforeEach(() => {
    db = new FakeAuthDb()
  })

  it('rejects with 401 when no token is provided', async () => {
    mountProtected()
    const res = await app.request('/protected')
    expect(res.status).toBe(401)
  })

  it('rejects with 401 for an unknown token', async () => {
    mountProtected()
    const res = await app.request('/protected', { headers: { Authorization: 'Bearer nope' } })
    expect(res.status).toBe(401)
  })

  it('allows a valid token and exposes the userId', async () => {
    mountProtected()
    const token = issueSession(db as any, 42)
    const res = await app.request('/protected', { headers: { Authorization: `Bearer ${token}` } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, userId: 42 })
  })

  it('rejects an expired token', async () => {
    mountProtected()
    const token = 'stale'
    db.insertExpired(hashToken(token), 1)
    const res = await app.request('/protected', { headers: { Authorization: `Bearer ${token}` } })
    expect(res.status).toBe(401)
  })

  it('bypasses validation when trustLocal is set (desktop)', async () => {
    mountProtected({ trustLocal: true })
    const res = await app.request('/protected') // no token at all
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, userId: undefined })
  })
})

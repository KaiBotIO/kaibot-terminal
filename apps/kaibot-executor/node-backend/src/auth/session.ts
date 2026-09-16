import { randomBytes, createHash } from 'node:crypto'
import type { Context, Next } from 'hono'
import type { KaiBotDatabase } from '../storage/database.js'

// Make the validated user id available on the Hono context in a typed way.
declare module 'hono' {
  interface ContextVariableMap {
    userId: number
  }
}

// Local session tokens. The raw token is returned to the client once at
// login/setup; only its SHA-256 hash is persisted. Tokens are opaque random
// strings (not signed) — the hash-in-DB-with-expiry approach keeps a stolen
// DB from yielding usable tokens and lets logout revoke server-side.

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

export function generateSessionToken(): string {
  return randomBytes(32).toString('hex')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function sessionExpiry(now: number = Date.now()): Date {
  return new Date(now + SESSION_TTL_MS)
}

/**
 * Issue a fresh session for a user: generate a token, store its hash with an
 * expiry, opportunistically purge expired rows, return the raw token.
 */
export function issueSession(db: KaiBotDatabase, userId: number): string {
  db.purgeExpiredAuthSessions()
  const token = generateSessionToken()
  db.createAuthSession(hashToken(token), userId, sessionExpiry())
  return token
}

export function revokeSession(db: KaiBotDatabase, token: string): void {
  db.deleteAuthSession(hashToken(token))
}

/**
 * Extract a bearer token from the request. Accepts `Authorization: Bearer x`
 * or the `x-auth-token` header.
 */
export function extractToken(c: Context): string | null {
  const auth = c.req.header('authorization')
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim())
    if (match) return match[1].trim()
  }
  const headerToken = c.req.header('x-auth-token')
  if (headerToken) return headerToken.trim()
  return null
}

export interface AuthMiddlewareOptions {
  // When true (desktop loopback sidecar), the middleware trusts the local
  // caller and skips token validation. The desktop shell is the single local
  // owner and the backend only binds to loopback.
  trustLocal?: boolean
}

/**
 * Hono middleware factory: requires a valid (known, unexpired) session token
 * unless `trustLocal` is set. On success the validated userId is stashed on the
 * context for downstream handlers.
 */
export function createAuthMiddleware(db: KaiBotDatabase, options: AuthMiddlewareOptions = {}) {
  return async (c: Context, next: Next) => {
    if (options.trustLocal) {
      return next()
    }

    const token = extractToken(c)
    if (!token) {
      return c.json({ error: 'Authentication required' }, 401)
    }

    const session = db.getValidAuthSession(hashToken(token))
    if (!session) {
      return c.json({ error: 'Invalid or expired session' }, 401)
    }

    c.set('userId', session.user_id)
    return next()
  }
}

import type { Context, Next } from 'hono'
import type { UserRole } from '../storage/types.js'

export type { UserRole }

declare module 'hono' {
  interface ContextVariableMap {
    role: UserRole
  }
}

// Viewer accounts read the book and nothing else. Every GET a viewer may
// call is listed here, by exact path or path prefix; anything else (every
// mutating method, every read that carries pairing/secrets or prepares an
// action) is refused with 403. Keep this list in step with
// docs/reviews/2026-09-25-executor-viewer-role.md.
const VIEWER_EXACT_PATHS = new Set([
  '/api/health',
  '/api/config',
  '/api/auth/session',
  '/api/ws/status',
  '/api/positions',
  '/api/signals',
  '/api/logs',
  '/api/exchanges',
  '/api/exchanges/v2/sessions',
  '/api/subscriptions',
  '/api/bots',
  '/api/ops/position-lineage',
  '/api/ops/open-orders',
  '/api/ops/portfolio',
  '/api/ops/markets',
  '/api/ops/reconciliations',
  '/api/ops/fills',
  '/api/ops/halt',
  '/api/ops/account-sizes',
  '/api/trade/manage',
  '/api/trade/managers',
  '/api/trade/hedge',
  '/api/position-groups',
  '/api/position-groups/overview',
  '/api/synthetic-usd',
  '/api/synthetic-usd/holdings-basis',
])

// Prefixes take one more path segment (an id, an exchange name).
const VIEWER_PREFIXES = [
  '/api/performance/',
  '/api/exchanges/v2/accounts/',
  '/api/exchanges/v2/balances/',
  '/api/exchanges/v2/positions/',
  '/api/subscriptions/',
  '/api/bots/',
  '/api/ops/executions/',
  '/api/synthetic-usd/',
]

// `/api/exchanges/v2/<name>/details` is the only nested read a viewer needs.
const EXCHANGE_DETAILS = /^\/api\/exchanges\/v2\/[^/]+\/details$/

// Reads under an allowed prefix that still prepare or trigger an action.
const VIEWER_DENIED = new Set(['/api/subscriptions/marketplace/browse'])

function stripQuery(path: string): string {
  const i = path.indexOf('?')
  return i === -1 ? path : path.slice(0, i)
}

export function isViewerAllowed(method: string, rawPath: string): boolean {
  const m = method.toUpperCase()
  if (m !== 'GET' && m !== 'HEAD') return false
  const path = stripQuery(rawPath).replace(/\/+$/, '') || '/'
  if (VIEWER_DENIED.has(path)) return false
  if (VIEWER_EXACT_PATHS.has(path)) return true
  if (EXCHANGE_DETAILS.test(path)) return true
  for (const prefix of VIEWER_PREFIXES) {
    if (!path.startsWith(prefix)) continue
    const rest = path.slice(prefix.length)
    // Exactly one segment after the prefix: an id or a venue name.
    if (rest.length > 0 && !rest.includes('/')) return true
  }
  return false
}

export const VIEWER_FORBIDDEN_BODY = {
  error: 'View-only account. Ask the executor admin to make this change.',
  code: 'viewer_forbidden',
} as const

// Runs after the session middleware. Admin passes; viewer passes only on the
// read allowlist above.
export function createRoleMiddleware() {
  return async (c: Context, next: Next) => {
    const role = c.get('role')
    if (role === 'admin') return next()
    if (role === 'viewer' && isViewerAllowed(c.req.method, c.req.path)) return next()
    return c.json(VIEWER_FORBIDDEN_BODY, 403)
  }
}

export function requireAdmin(c: Context): Response | null {
  return c.get('role') === 'admin' ? null : c.json(VIEWER_FORBIDDEN_BODY, 403)
}

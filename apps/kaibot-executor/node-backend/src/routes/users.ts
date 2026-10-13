import { Hono } from 'hono'
import type { KaiBotDatabase } from '../storage/database.js'
import { requireAdmin } from '../auth/roles.js'
import type { AccountGrant } from '../storage/types.js'

// Admin-only account management: viewer accounts that may read the executor
// and nothing else (auth/roles.ts). The admin row itself is not managed here;
// `kaibot-executor reset-admin` stays the only way to replace it.

const USERNAME = /^[a-z0-9][a-z0-9._-]{2,31}$/i
const MIN_PASSWORD = 8

export function validateUsername(username: unknown): string | null {
  if (typeof username !== 'string') return 'Username is required'
  if (!USERNAME.test(username)) return 'Username: 3 to 32 letters, digits, dots, dashes or underscores'
  return null
}

export function validatePassword(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    return `Password: at least ${MIN_PASSWORD} characters`
  }
  return null
}

// What the admin can grant: every connection and the accounts it reports.
export interface AccountOption {
  exchange: string
  label: string
  status: string
  accounts: Array<{ accountId: string; name: string | null }>
}

const EXCHANGE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
const MAX_GRANTS = 200

export function parseGrants(raw: unknown): AccountGrant[] | string {
  if (!Array.isArray(raw)) return 'grants must be an array'
  if (raw.length > MAX_GRANTS) return `at most ${MAX_GRANTS} grants`
  const out: AccountGrant[] = []
  for (const g of raw) {
    const exchange = typeof g?.exchange === 'string' ? g.exchange.trim().toLowerCase() : ''
    const ref = typeof g?.ref === 'string' ? g.ref.trim() : ''
    if (!EXCHANGE_RE.test(exchange)) return 'grant.exchange: lower-case venue name'
    if (g?.kind !== 'connection' && g?.kind !== 'account') return "grant.kind: 'connection' or 'account'"
    if (!ref || ref.length > 64) return 'grant.ref: 1 to 64 characters'
    out.push({ exchange, kind: g.kind, ref })
  }
  return out
}

export function createUserRoutes(
  db: KaiBotDatabase,
  deps: { accountOptions?: () => Promise<AccountOption[]> } = {},
) {
  const app = new Hono()

  // Belt and braces: the role middleware already refuses viewers on every
  // path here, this keeps the routes safe if the allowlist ever widens.
  app.use('*', async (c, next) => {
    const refused = requireAdmin(c)
    if (refused) return refused
    return next()
  })

  app.get('/', (c) => {
    const users = db.listUsers().map((u) => (u.role === 'viewer' ? { ...u, grants: db.listAccountGrants(u.id) } : u))
    return c.json({ users })
  })

  app.get('/account-options', async (c) => {
    try {
      return c.json({ options: deps.accountOptions ? await deps.accountOptions() : [] })
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  app.get('/:id/scope', (c) => {
    const id = Number(c.req.param('id'))
    const user = Number.isInteger(id) ? db.getUserById(id) : undefined
    if (!user) return c.json({ error: 'User not found' }, 404)
    return c.json({ grants: user.role === 'viewer' ? db.listAccountGrants(user.id) : [], all: user.role === 'admin' })
  })

  // Replaces the viewer's whole scope. An empty list = sees no account data.
  app.put('/:id/scope', async (c) => {
    const id = Number(c.req.param('id'))
    const user = Number.isInteger(id) ? db.getUserById(id) : undefined
    if (!user) return c.json({ error: 'User not found' }, 404)
    if (user.role !== 'viewer') return c.json({ error: 'The admin sees every account' }, 400)
    let body: { grants?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }
    const grants = parseGrants(body.grants)
    if (typeof grants === 'string') return c.json({ error: grants }, 400)
    db.setAccountGrants(user.id, grants)
    db.log('info', 'system', 'Viewer scope updated', {
      username: user.username,
      grants: grants.map((g) => `${g.exchange}:${g.kind}:${g.ref}`),
    })
    return c.json({ grants: db.listAccountGrants(user.id) })
  })

  app.post('/', async (c) => {
    let body: { username?: unknown; password?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }
    const usernameError = validateUsername(body.username)
    if (usernameError) return c.json({ error: usernameError }, 400)
    const passwordError = validatePassword(body.password)
    if (passwordError) return c.json({ error: passwordError }, 400)
    const username = body.username as string
    if (db.getUserByUsername(username)) {
      return c.json({ error: 'Username already taken' }, 409)
    }
    try {
      const user = await db.createViewerUser(username, body.password as string)
      db.log('info', 'system', 'Viewer account created', { username })
      return c.json({ user }, 201)
    } catch (error) {
      db.log('error', 'system', 'Failed to create viewer account', {
        error: error instanceof Error ? error.message : String(error),
      })
      return c.json({ error: 'Failed to create account' }, 500)
    }
  })

  app.post('/:id/password', async (c) => {
    const id = Number(c.req.param('id'))
    const user = Number.isInteger(id) ? db.getUserById(id) : undefined
    if (!user) return c.json({ error: 'User not found' }, 404)
    if (user.role !== 'viewer') return c.json({ error: 'Only viewer passwords can be reset here' }, 400)
    let body: { password?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }
    const passwordError = validatePassword(body.password)
    if (passwordError) return c.json({ error: passwordError }, 400)
    await db.setUserPassword(user.id, body.password as string)
    db.log('info', 'system', 'Viewer password reset', { username: user.username })
    return c.json({ success: true })
  })

  app.delete('/:id', (c) => {
    const id = Number(c.req.param('id'))
    const user = Number.isInteger(id) ? db.getUserById(id) : undefined
    if (!user) return c.json({ error: 'User not found' }, 404)
    if (user.role !== 'viewer') return c.json({ error: 'The admin account cannot be deleted' }, 400)
    db.deleteUser(user.id)
    db.log('info', 'system', 'Viewer account deleted', { username: user.username })
    return c.json({ success: true })
  })

  return app
}

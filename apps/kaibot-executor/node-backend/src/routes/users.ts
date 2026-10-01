import { Hono } from 'hono'
import type { KaiBotDatabase } from '../storage/database.js'
import { requireAdmin } from '../auth/roles.js'

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

export function createUserRoutes(db: KaiBotDatabase) {
  const app = new Hono()

  // Belt and braces: the role middleware already refuses viewers on every
  // path here, this keeps the routes safe if the allowlist ever widens.
  app.use('*', async (c, next) => {
    const refused = requireAdmin(c)
    if (refused) return refused
    return next()
  })

  app.get('/', (c) => {
    return c.json({ users: db.listUsers() })
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

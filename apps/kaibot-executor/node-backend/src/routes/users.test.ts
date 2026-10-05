import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Hono } from 'hono'
import { KaiBotDatabase } from '../storage/database.js'
import { createUserRoutes, validatePassword, validateUsername } from './users.js'
import { createRoleMiddleware } from '../auth/roles.js'
import type { UserRole } from '../auth/roles.js'

let dir: string
let db: KaiBotDatabase

function appAs(role: UserRole) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('role', role)
    return next()
  })
  app.use('/api/*', createRoleMiddleware())
  app.route('/api/auth/users', createUserRoutes(db))
  return app
}

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-users-route-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
  await db.createAdminUser('kai', 'admin-password')
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('validation', () => {
  it('bounds the username and password', () => {
    expect(validateUsername('kay')).toBeNull()
    expect(validateUsername('kay.viewer-01_x')).toBeNull()
    expect(validateUsername('ab')).not.toBeNull()
    expect(validateUsername('has space')).not.toBeNull()
    expect(validateUsername(undefined)).not.toBeNull()
    expect(validatePassword('12345678')).toBeNull()
    expect(validatePassword('1234567')).not.toBeNull()
    expect(validatePassword(42)).not.toBeNull()
  })
})

describe('admin manages viewers', () => {
  it('creates, lists, resets and deletes a viewer', async () => {
    const app = appAs('admin')

    const created = await app.request('/api/auth/users', json({ username: 'kay', password: 'viewer-pass-1' }))
    expect(created.status).toBe(201)
    const { user } = (await created.json()) as { user: { id: number; username: string; role: string } }
    expect(user.username).toBe('kay')
    expect(user.role).toBe('viewer')
    expect('password_hash' in user).toBe(false)

    const list = await app.request('/api/auth/users')
    expect(list.status).toBe(200)
    const { users } = (await list.json()) as { users: Array<{ username: string; role: string }> }
    expect(users.map((u) => [u.username, u.role])).toEqual([
      ['kai', 'admin'],
      ['kay', 'viewer'],
    ])
    for (const u of users) expect('password_hash' in u).toBe(false)

    expect(await db.validateUser('kay', 'viewer-pass-1')).toBe(true)
    const reset = await app.request(`/api/auth/users/${user.id}/password`, json({ password: 'viewer-pass-2' }))
    expect(reset.status).toBe(200)
    expect(await db.validateUser('kay', 'viewer-pass-1')).toBe(false)
    expect(await db.validateUser('kay', 'viewer-pass-2')).toBe(true)

    const del = await app.request(`/api/auth/users/${user.id}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect(db.getUserByUsername('kay')).toBeUndefined()
    expect(db.getAdminUser().username).toBe('kai')
  })

  it('refuses duplicates, weak input and unknown ids', async () => {
    const app = appAs('admin')
    expect((await app.request('/api/auth/users', json({ username: 'kai', password: 'viewer-pass-1' }))).status).toBe(409)
    expect((await app.request('/api/auth/users', json({ username: 'k', password: 'viewer-pass-1' }))).status).toBe(400)
    expect((await app.request('/api/auth/users', json({ username: 'kay', password: 'short' }))).status).toBe(400)
    expect((await app.request('/api/auth/users/999', { method: 'DELETE' })).status).toBe(404)
    expect((await app.request('/api/auth/users/999/password', json({ password: 'viewer-pass-1' }))).status).toBe(404)
    expect((await app.request('/api/auth/users/abc', { method: 'DELETE' })).status).toBe(404)
  })

  it('never touches the admin row', async () => {
    const app = appAs('admin')
    const admin = db.getAdminUser()
    expect((await app.request(`/api/auth/users/${admin.id}`, { method: 'DELETE' })).status).toBe(400)
    expect((await app.request(`/api/auth/users/${admin.id}/password`, json({ password: 'new-admin-pass' }))).status).toBe(400)
    expect(await db.validateUser('kai', 'admin-password')).toBe(true)
  })
})

describe('viewer is locked out of user management', () => {
  it('gets 403 on every users route', async () => {
    await db.createViewerUser('kay', 'viewer-pass-1')
    const kay = db.getUserByUsername('kay')!
    const app = appAs('viewer')
    expect((await app.request('/api/auth/users')).status).toBe(403)
    expect((await app.request('/api/auth/users', json({ username: 'x', password: 'viewer-pass-1' }))).status).toBe(403)
    expect((await app.request(`/api/auth/users/${kay.id}/password`, json({ password: 'viewer-pass-2' }))).status).toBe(403)
    expect((await app.request(`/api/auth/users/${kay.id}`, { method: 'DELETE' })).status).toBe(403)
    expect(db.getUserByUsername('kay')).toBeDefined()
  })
})

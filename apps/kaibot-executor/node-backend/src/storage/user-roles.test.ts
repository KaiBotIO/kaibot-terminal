import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Database } from 'bun:sqlite'
import { KaiBotDatabase } from './database.js'
import { hashToken, issueSession } from '../auth/session.js'

let dir: string
let file: string
let db: KaiBotDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-user-roles-'))
  file = join(dir, 'test.db')
  db = new KaiBotDatabase(file)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('migration 041 (user roles)', () => {
  it('gives a pre-existing account the admin role', async () => {
    await db.createAdminUser('kai', 'admin-password')
    db.close()

    // Rebuild the pre-041 shape: a users table without `role`, migration
    // marked as not applied, then reopen so migrate() runs 041 on it.
    const raw = new Database(file)
    raw.exec('PRAGMA foreign_keys = OFF')
    raw.exec(`
      CREATE TABLE users_legacy AS SELECT id, username, password_hash, created_at, last_login, settings FROM users;
      DROP TABLE users;
      ALTER TABLE users_legacy RENAME TO users;
      DELETE FROM migrations WHERE name = 'user_roles';
    `)
    expect(raw.query('PRAGMA table_info(users)').all().some((c: any) => c.name === 'role')).toBe(false)
    raw.close()

    db = new KaiBotDatabase(file)
    const admin = db.getAdminUser()
    expect(admin.username).toBe('kai')
    expect(admin.role).toBe('admin')
    expect(await db.hasAdminUser()).toBe(true)
  })

  it('is idempotent on reopen', async () => {
    await db.createAdminUser('kai', 'admin-password')
    db.close()
    db = new KaiBotDatabase(file)
    expect(db.getAdminUser().role).toBe('admin')
  })

  it('rejects any role outside admin/viewer', async () => {
    await db.createAdminUser('kai', 'admin-password')
    const raw = new Database(file)
    expect(() => raw.run("INSERT INTO users (username, password_hash, role) VALUES ('x', 'h', 'root')")).toThrow()
    raw.close()
  })
})

describe('accounts', () => {
  it('admin lookups skip viewer rows', async () => {
    await db.createAdminUser('kai', 'admin-password')
    await db.createViewerUser('kay', 'viewer-pass-1')
    expect(db.getAdminUser().username).toBe('kai')
    expect(db.listUsers().map((u) => `${u.username}:${u.role}`)).toEqual(['kai:admin', 'kay:viewer'])
    expect(db.getUserByUsername('kay')?.role).toBe('viewer')
  })

  it('a DB with only viewers has no admin (setup stays open)', async () => {
    await db.createViewerUser('kay', 'viewer-pass-1')
    expect(await db.hasAdminUser()).toBe(false)
    expect(db.getAdminUser()).toBeFalsy()
  })

  it('a session carries the role of its owner', async () => {
    await db.createAdminUser('kai', 'admin-password')
    const kay = await db.createViewerUser('kay', 'viewer-pass-1')
    const adminToken = issueSession(db, db.getAdminUser().id)
    const viewerToken = issueSession(db, kay.id)
    expect(db.getValidAuthSession(hashToken(adminToken))?.role).toBe('admin')
    expect(db.getValidAuthSession(hashToken(viewerToken))).toMatchObject({ role: 'viewer', username: 'kay' })
  })

  it('password reset and delete revoke the sessions of that account only', async () => {
    await db.createAdminUser('kai', 'admin-password')
    const kay = await db.createViewerUser('kay', 'viewer-pass-1')
    const adminToken = issueSession(db, db.getAdminUser().id)
    const viewerToken = issueSession(db, kay.id)

    await db.setUserPassword(kay.id, 'viewer-pass-2')
    expect(db.getValidAuthSession(hashToken(viewerToken))).toBeUndefined()
    expect(db.getValidAuthSession(hashToken(adminToken))?.role).toBe('admin')
    expect(await db.validateUser('kay', 'viewer-pass-2')).toBe(true)

    const viewerToken2 = issueSession(db, kay.id)
    db.deleteUser(kay.id)
    expect(db.getValidAuthSession(hashToken(viewerToken2))).toBeUndefined()
    expect(db.getUserById(kay.id)).toBeUndefined()
    expect(db.getValidAuthSession(hashToken(adminToken))?.role).toBe('admin')
  })
})

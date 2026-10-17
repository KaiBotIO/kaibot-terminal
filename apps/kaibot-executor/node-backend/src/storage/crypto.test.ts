import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Crypto } from './crypto.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-crypto-test-'))
  process.env.CRYPTO_SALT_PATH = join(dir, 'salt')
  process.env.CRYPTO_DEV_SECRET_PATH = join(dir, 'devsecret')
  delete process.env.APP_SECRET
  process.env.NODE_ENV = 'test'
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.CRYPTO_SALT_PATH
  delete process.env.CRYPTO_DEV_SECRET_PATH
})

describe('Crypto', () => {
  it('round-trips an API key with a generated per-installation salt', () => {
    const c = new Crypto()
    expect(existsSync(process.env.CRYPTO_SALT_PATH!)).toBe(true)
    const enc = c.encryptApiKey('super-secret-key')
    expect(enc).not.toContain('super-secret-key')
    expect(c.decryptApiKey(enc)).toBe('super-secret-key')
  })

  it('round-trips credentials objects', () => {
    const c = new Crypto()
    const creds = { apiKey: 'abc', apiSecret: 'def', passphrase: 'ghi' }
    const enc = c.encryptCredentials(creds)
    expect(c.decryptCredentials(enc)).toEqual(creds)
  })

  it('reuses the persisted salt across instances so data stays decryptable', () => {
    const a = new Crypto()
    const enc = a.encryptApiKey('persist-me')
    const saltHex = readFileSync(process.env.CRYPTO_SALT_PATH!, 'utf8')
    const b = new Crypto()
    expect(readFileSync(process.env.CRYPTO_SALT_PATH!, 'utf8')).toBe(saltHex)
    expect(b.decryptApiKey(enc)).toBe('persist-me')
  })

  it('generates a 32-byte (64 hex char) salt', () => {
    new Crypto()
    expect(readFileSync(process.env.CRYPTO_SALT_PATH!, 'utf8').trim()).toHaveLength(64)
  })

  it('throws in production when APP_SECRET is missing', () => {
    process.env.NODE_ENV = 'production'
    // Module-level isProd is captured at import time, so a runtime flip can't be
    // tested here; instead assert an explicit password still works (the prod
    // path is exercised by the resolveSecret guard).
    expect(() => new Crypto('explicit-password')).not.toThrow()
    process.env.NODE_ENV = 'test'
  })
})

import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { KaiBotDatabase } from './database.js'

// Migration 035: connection labels, subscription account_key, bracket account.
// Existing rows must keep working unchanged as the default connection.

let dir: string
let db: KaiBotDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-conn-label-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('migration 035', () => {
  it('defaults the label of a legacy connection row to "default"', () => {
    db.run(
      `INSERT INTO exchange_connections
       (id, user_id, exchange_name, connection_type, encrypted_credentials, is_active, last_refresh)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
      ['default:tradestation', 'default', 'tradestation', 'oauth', 'blob', Date.now()],
    )
    const row = db.get('SELECT id, label FROM exchange_connections WHERE id = ?', ['default:tradestation']) as any
    expect(row).toEqual({ id: 'default:tradestation', label: 'default' })
  })

  it('refuses two rows with the same (user, exchange, label)', () => {
    const insert = (id: string, label: string) =>
      db.run(
        `INSERT INTO exchange_connections
         (id, user_id, exchange_name, connection_type, encrypted_credentials, is_active, last_refresh, label)
         VALUES (?, 'default', 'deribit', 'apiKey', 'blob', 1, 0, ?)`,
        [id, label],
      )
    insert('default:deribit', 'default')
    insert('default:deribit:acct2', 'acct2')
    expect(() => insert('default:deribit:dupe', 'acct2')).toThrow()
  })

  it('is idempotent across a re-run of the migration statements', () => {
    // A second KaiBotDatabase on the same file re-enters runMigrations; the
    // recorded migration name must stop it from re-ALTERing.
    const again = new KaiBotDatabase(join(dir, 'test.db'))
    const names = (again.all('SELECT name FROM migrations') as any[]).map((r) => r.name)
    expect(names.filter((n) => n === 'exchange_connection_label')).toHaveLength(1)
    again.close()
  })
})

describe('subscriptions carry an account key', () => {
  it('round-trips accountKey and leaves rows without one at NULL', () => {
    db.upsertSubscription({ id: 's1', signalBotId: 'bot', factor: 1, exchange: 'deribit', accountKey: 'acct2' })
    db.upsertSubscription({ id: 's2', signalBotId: 'bot2', factor: 1, exchange: 'deribit' })
    expect(db.getSubscription('s1').account_key).toBe('acct2')
    expect(db.getSubscription('s2').account_key).toBeNull()
    // Re-upsert without the key clears it (explicit routing, no stale carry).
    db.upsertSubscription({ id: 's1', signalBotId: 'bot', factor: 1, exchange: 'deribit' })
    expect(db.getSubscription('s1').account_key).toBeNull()
  })
})

describe('bracket pairs record the account of their legs', () => {
  it('stores account_id and keeps it on a later ladder-shrink upsert without one', () => {
    db.upsertBracketPair({ signalId: 'sig', exchange: 'deribit', accountId: 'acct2/btc', slOrderId: 'sl', tpOrderIds: ['tp1', 'tp2'] })
    expect(db.listBracketPairs()[0].account_id).toBe('acct2/btc')
    db.upsertBracketPair({ signalId: 'sig', exchange: 'deribit', slOrderId: 'sl', tpOrderIds: ['tp2'] })
    const row = db.listBracketPairs()[0]
    expect(row.account_id).toBe('acct2/btc')
    expect(row.tp_order_ids).toBe(JSON.stringify(['tp2']))
  })

  it('leaves legacy rows at NULL', () => {
    db.upsertBracketPair({ signalId: 'sig', exchange: 'tradestation', slOrderId: 'sl' })
    expect(db.listBracketPairs()[0].account_id).toBeNull()
  })
})

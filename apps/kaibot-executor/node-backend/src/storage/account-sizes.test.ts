import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { KaiBotDatabase } from './database.js'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Exercises the migration-009 account_sizes helpers and the
// latestReconciliationPerSymbol query against a real on-disk DB.

let dir: string
let db: KaiBotDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-sizes-test-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('account_sizes', () => {
  it('returns null when no row is configured', () => {
    expect(db.getAccountSize('tradestation', 'ACC1', 'MES')).toBeNull()
  })

  it('upserts and reads back a configured cap', () => {
    db.setAccountSize('tradestation', 'ACC1', 'MES', 6)
    expect(db.getAccountSize('tradestation', 'ACC1', 'MES')).toBe(6)
    // updating overwrites in place (PK is exchange+account+root)
    db.setAccountSize('tradestation', 'ACC1', 'MES', 2)
    expect(db.getAccountSize('tradestation', 'ACC1', 'MES')).toBe(2)
    expect(db.listAccountSizes()).toHaveLength(1)
  })

  it('stores a zero cap (kill-switch) distinctly from "unset"', () => {
    db.setAccountSize('deribit', 'btc', 'BTC-PERPETUAL', 0)
    expect(db.getAccountSize('deribit', 'btc', 'BTC-PERPETUAL')).toBe(0)
  })

  it('keeps rows separate per account and root', () => {
    db.setAccountSize('tradestation', 'ACC1', 'MES', 4)
    db.setAccountSize('tradestation', 'ACC2', 'MES', 1)
    db.setAccountSize('tradestation', 'ACC1', 'MNQ', 2)
    expect(db.getAccountSize('tradestation', 'ACC1', 'MES')).toBe(4)
    expect(db.getAccountSize('tradestation', 'ACC2', 'MES')).toBe(1)
    expect(db.getAccountSize('tradestation', 'ACC1', 'MNQ')).toBe(2)
    expect(db.listAccountSizes()).toHaveLength(3)
  })
})

describe('latestReconciliationPerSymbol', () => {
  it('returns the most recent run per (exchange, symbol)', () => {
    db.insertReconciliation({
      exchange: 'tradestation', accountId: 'ACC1', symbol: 'MESM26',
      expectedNet: 4, brokerNet: 4, delta: 0, action: 'corrected',
    })
    // a later mismatch on the same symbol should win
    db.run(
      `INSERT INTO reconciliations (exchange, account_id, symbol, expected_net, broker_net, delta, action, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['tradestation', 'ACC1', 'MESM26', 4, 2, 2, 'skipped_working', Date.now() + 1000],
    )
    db.insertReconciliation({
      exchange: 'tradestation', accountId: 'ACC1', symbol: 'MNQM26',
      expectedNet: 1, brokerNet: 1, delta: 0, action: 'corrected',
    })

    const latest = db.latestReconciliationPerSymbol('tradestation')
    expect(latest).toHaveLength(2)
    const mes = latest.find((r) => r.symbol === 'MESM26')!
    expect(mes.action).toBe('skipped_working')
    expect(mes.delta).toBe(2)
  })
})

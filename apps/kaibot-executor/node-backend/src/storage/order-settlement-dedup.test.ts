import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { KaiBotDatabase } from './database.js'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Migration-011 per-target dedup on order_settlements, against a real on-disk
// SQLite DB (fresh temp dir per test so the UNIQUE index is created clean).

let dir: string
let db: KaiBotDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-dedup-test-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const base = {
  signalId: 'sig-1',
  exchange: 'deribit',
  symbol: 'BTC-PERPETUAL',
  kind: 'exit' as const,
  side: 'sell' as const,
  qty: 1,
}

describe('order_settlements per-target dedup', () => {
  it('a re-fired exit for the same target updates the existing row, not a second one', () => {
    const first = db.insertOrderSettlement({ ...base, orderId: 'o1', targetLabel: 'TP1', status: 'unknown' })
    const second = db.insertOrderSettlement({ ...base, orderId: 'o2', qty: 1, targetLabel: 'TP1', status: 'filled' })

    expect(second).toBe(first) // same row id → dedup hit
    const all = db.all('SELECT * FROM order_settlements WHERE signal_id = ?', ['sig-1']) as any[]
    expect(all).toHaveLength(1)
    expect(all[0].order_id).toBe('o2') // refreshed in place
    expect(all[0].status).toBe('filled')
  })

  it('distinct targets (TP1 vs TP2) keep distinct rows', () => {
    db.insertOrderSettlement({ ...base, orderId: 'o1', targetLabel: 'TP1' })
    db.insertOrderSettlement({ ...base, orderId: 'o2', targetLabel: 'TP2' })
    const all = db.all('SELECT * FROM order_settlements WHERE signal_id = ?', ['sig-1']) as any[]
    expect(all).toHaveLength(2)
  })

  it('rows without a target_label are never deduped (legacy/entry rows)', () => {
    db.insertOrderSettlement({ ...base, kind: 'entry', side: 'buy', orderId: 'e1' })
    db.insertOrderSettlement({ ...base, kind: 'entry', side: 'buy', orderId: 'e2' })
    const all = db.all('SELECT * FROM order_settlements WHERE signal_id = ?', ['sig-1']) as any[]
    expect(all).toHaveLength(2)
  })

  it('targetAlreadyProcessed: filled/unknown count as processed, rejected/cancelled retryable', () => {
    db.insertOrderSettlement({ ...base, orderId: 'o1', targetLabel: 'filled', status: 'filled' })
    db.insertOrderSettlement({ ...base, orderId: 'o2', targetLabel: 'pending', status: 'unknown' })
    db.insertOrderSettlement({ ...base, orderId: 'o3', targetLabel: 'gone', status: 'cancelled' })
    db.insertOrderSettlement({ ...base, orderId: 'o4', targetLabel: 'nope', status: 'rejected' })

    expect(db.targetAlreadyProcessed('sig-1', 'exit', 'filled')).toBe(true)
    expect(db.targetAlreadyProcessed('sig-1', 'exit', 'pending')).toBe(true)
    expect(db.targetAlreadyProcessed('sig-1', 'exit', 'gone')).toBe(false)
    expect(db.targetAlreadyProcessed('sig-1', 'exit', 'nope')).toBe(false)
    expect(db.targetAlreadyProcessed('sig-1', 'exit', 'unseen')).toBe(false)
  })
})

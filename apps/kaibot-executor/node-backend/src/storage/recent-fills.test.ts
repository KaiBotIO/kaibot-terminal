import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { KaiBotDatabase } from './database.js'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// listRecentFills feeds the chart's own-trades layer: every fill carries the
// venue/direction of its execution, newest first, orphans skipped.

let dir: string
let db: KaiBotDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-recent-fills-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('listRecentFills', () => {
  it('joins each fill to its execution and orders newest first', () => {
    db.insertSignalExecution({
      signalId: 'sig-a',
      symbol: 'BTC-PERPETUAL',
      exchange: 'deribit',
      direction: 'long',
      status: 'open',
      qtyOpened: 1,
      accountId: 'main',
    })
    db.insertSignalFill({ signalId: 'sig-a', kind: 'entry', symbol: 'BTC-PERPETUAL', side: 'buy', qty: 1, price: 60000, createdAtMs: 1_000 })
    db.insertSignalFill({ signalId: 'sig-a', kind: 'exit', symbol: 'BTC-PERPETUAL', side: 'sell', qty: 1, price: 61000, createdAtMs: 2_000 })
    // Orphan: no execution row → no venue → not listed.
    db.insertSignalFill({ signalId: 'sig-zombie', kind: 'entry', symbol: 'ETH-PERPETUAL', side: 'buy', qty: 1, price: 3000, createdAtMs: 3_000 })

    const rows = db.listRecentFills()
    expect(rows.map((r) => [r.kind, r.price, r.exchange, r.direction, r.account_id])).toEqual([
      ['exit', 61000, 'deribit', 'long', 'main'],
      ['entry', 60000, 'deribit', 'long', 'main'],
    ])
  })

  it('honours the limit', () => {
    db.insertSignalExecution({ signalId: 'sig-b', symbol: 'MNQZ26', exchange: 'tradestation', direction: 'short', status: 'open' })
    for (let i = 0; i < 5; i++) {
      db.insertSignalFill({ signalId: 'sig-b', kind: 'entry', symbol: 'MNQZ26', side: 'sell', qty: 1, price: 20000 + i, createdAtMs: i })
    }
    expect(db.listRecentFills(2).map((r) => r.price)).toEqual([20004, 20003])
  })
})

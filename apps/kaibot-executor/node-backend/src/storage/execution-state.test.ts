import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { KaiBotDatabase } from './database.js'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Exercises the migration-007 storage helpers against a real on-disk SQLite DB
// (a fresh temp dir per test so installs/migrations run clean).

let dir: string
let db: KaiBotDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-exec-test-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('signal_executions', () => {
  it('inserts once and rejects a duplicate signal id', () => {
    const ok = db.insertSignalExecution({
      signalId: 'sig-1',
      symbol: 'MESM26',
      exchange: 'tradestation',
      direction: 'long',
      status: 'open',
      qtyOpened: 4,
    })
    expect(ok).toBe(true)

    const dup = db.insertSignalExecution({
      signalId: 'sig-1',
      symbol: 'MESM26',
      exchange: 'tradestation',
      direction: 'long',
      status: 'open',
      qtyOpened: 4,
    })
    expect(dup).toBe(false)

    const row = db.getSignalExecution('sig-1')
    expect(row?.status).toBe('open')
    expect(row?.qty_opened).toBe(4)
  })

  it('updates status, quantities and error reason', () => {
    db.insertSignalExecution({ signalId: 's', symbol: 'X', exchange: 'e', direction: 'long', status: 'open', qtyOpened: 2 })
    db.updateSignalExecution('s', { qtyClosed: 1, status: 'open' })
    expect(db.getSignalExecution('s')?.qty_closed).toBe(1)
    db.updateSignalExecution('s', { status: 'error', errorReason: 'boom' })
    expect(db.getSignalExecution('s')?.status).toBe('error')
    expect(db.getSignalExecution('s')?.error_reason).toBe('boom')
  })
})

describe('signal_fills', () => {
  it('stores entry and exit fills and reads them back in order', () => {
    db.insertSignalFill({ signalId: 's', kind: 'entry', symbol: 'MESM26', side: 'buy', qty: 1, price: 5000, commission: 0.5 })
    db.insertSignalFill({ signalId: 's', kind: 'exit', symbol: 'MESM26', side: 'sell', qty: 1, price: 5010 })
    const fills = db.getSignalFills('s')
    expect(fills).toHaveLength(2)
    expect(fills[0].kind).toBe('entry')
    expect(fills[0].price).toBe(5000)
    expect(fills[0].commission).toBe(0.5)
    expect(fills[1].kind).toBe('exit')
  })

  it('reads fills for multiple signals at once', () => {
    db.insertSignalFill({ signalId: 'a', kind: 'entry', symbol: 'X', side: 'buy', qty: 1, price: 1 })
    db.insertSignalFill({ signalId: 'b', kind: 'entry', symbol: 'Y', side: 'buy', qty: 1, price: 2 })
    db.insertSignalFill({ signalId: 'c', kind: 'entry', symbol: 'Z', side: 'buy', qty: 1, price: 3 })
    const fills = db.getFillsForSignals(['a', 'c'])
    expect(fills.map((f) => f.signal_id).sort()).toEqual(['a', 'c'])
  })
})

describe('balance_snapshots', () => {
  it('sums equity per timestamp across accounts', () => {
    const t1 = 1000
    const t2 = 2000
    db.insertBalanceSnapshot({ exchange: 'ts', accountId: 'A', equity: 100, balance: 90, ts: t1 })
    db.insertBalanceSnapshot({ exchange: 'ts', accountId: 'B', equity: 200, balance: 180, ts: t1 })
    db.insertBalanceSnapshot({ exchange: 'ts', accountId: 'A', equity: 110, balance: 95, unrealizedPnL: 5, ts: t2 })
    db.insertBalanceSnapshot({ exchange: 'ts', accountId: 'B', equity: 210, balance: 185, unrealizedPnL: 7, ts: t2 })

    const series = db.getEquitySnapshots(0)
    expect(series).toHaveLength(2)
    expect(series[0]).toMatchObject({ ts: t1, equity: 300 })
    expect(series[1]).toMatchObject({ ts: t2, equity: 320, unrealizedPnL: 12 })
  })

  it('filters by since timestamp', () => {
    db.insertBalanceSnapshot({ exchange: 'ts', accountId: 'A', equity: 100, balance: 90, ts: 1000 })
    db.insertBalanceSnapshot({ exchange: 'ts', accountId: 'A', equity: 110, balance: 95, ts: 5000 })
    const series = db.getEquitySnapshots(2000)
    expect(series).toHaveLength(1)
    expect(series[0].ts).toBe(5000)
  })
})

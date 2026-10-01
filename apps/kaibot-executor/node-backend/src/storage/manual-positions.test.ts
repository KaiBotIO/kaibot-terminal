import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { KaiBotDatabase } from './database.js'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Migration-022 manual_positions marker: the presence signal the reconciler uses
// to avoid undoing a hand-placed position on a signal-traded symbol.

let dir: string
let db: KaiBotDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-manual-pos-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('manual_positions marker', () => {
  it('adds a signed net on open and reports presence', () => {
    db.addManualPosition('deribit', 'btc', 'BTC-PERPETUAL', 'buy', 10)
    expect(db.getManualPosition('deribit', 'btc', 'BTC-PERPETUAL')?.net).toBe(10)
    expect(db.hasManualPosition('deribit', 'BTC-PERPETUAL')).toBe(true)
    expect(db.hasManualPosition('deribit', 'ETH-PERPETUAL')).toBe(false)
  })

  it('accumulates same-side fills and nets opposite ones', () => {
    db.addManualPosition('deribit', 'btc', 'BTC-PERPETUAL', 'buy', 10)
    db.addManualPosition('deribit', 'btc', 'BTC-PERPETUAL', 'buy', 5)
    expect(db.getManualPosition('deribit', 'btc', 'BTC-PERPETUAL')?.net).toBe(15)
    db.addManualPosition('deribit', 'btc', 'BTC-PERPETUAL', 'sell', 4)
    expect(db.getManualPosition('deribit', 'btc', 'BTC-PERPETUAL')?.net).toBe(11)
  })

  it('deletes the row when a fill brings it back to flat', () => {
    db.addManualPosition('deribit', 'btc', 'BTC-PERPETUAL', 'buy', 10)
    db.addManualPosition('deribit', 'btc', 'BTC-PERPETUAL', 'sell', 10)
    expect(db.hasManualPosition('deribit', 'BTC-PERPETUAL')).toBe(false)
  })

  it('reduces toward flat without flipping sign, and clears at zero', () => {
    db.addManualPosition('deribit', 'btc', 'BTC-PERPETUAL', 'buy', 10)
    db.reduceManualPosition('deribit', 'btc', 'BTC-PERPETUAL', 4)
    expect(db.getManualPosition('deribit', 'btc', 'BTC-PERPETUAL')?.net).toBe(6)
    // Over-reduce clamps to flat, never flips to a phantom short.
    db.reduceManualPosition('deribit', 'btc', 'BTC-PERPETUAL', 999)
    expect(db.hasManualPosition('deribit', 'BTC-PERPETUAL')).toBe(false)
  })

  it('reduce is a no-op when there is no marker (never conjures a phantom)', () => {
    db.reduceManualPosition('deribit', 'btc', 'BTC-PERPETUAL', 5)
    expect(db.hasManualPosition('deribit', 'BTC-PERPETUAL')).toBe(false)
  })

  it('clearManualPositionSymbol removes every account for a symbol', () => {
    db.addManualPosition('deribit', 'btc', 'BTC-PERPETUAL', 'buy', 10)
    db.addManualPosition('deribit', 'sub', 'BTC-PERPETUAL', 'sell', 3)
    db.clearManualPositionSymbol('deribit', 'BTC-PERPETUAL')
    expect(db.hasManualPosition('deribit', 'BTC-PERPETUAL')).toBe(false)
  })

  it('listManualEntrySignalIds returns only manual entry ids for a symbol', () => {
    db.insertOrderSettlement({
      signalId: 'manual:k1', exchange: 'deribit', symbol: 'BTC-PERPETUAL',
      kind: 'entry', side: 'buy', qty: 1, orderId: 'o1', targetLabel: 'entry', status: 'filled',
    })
    db.insertOrderSettlement({
      signalId: 's:signal', exchange: 'deribit', symbol: 'BTC-PERPETUAL',
      kind: 'entry', side: 'buy', qty: 1, orderId: 'o2', targetLabel: 'entry', status: 'filled',
    })
    db.insertOrderSettlement({
      signalId: 'manual:k2', exchange: 'deribit', symbol: 'ETH-PERPETUAL',
      kind: 'entry', side: 'buy', qty: 1, orderId: 'o3', targetLabel: 'entry', status: 'filled',
    })
    expect(db.listManualEntrySignalIds('deribit', 'BTC-PERPETUAL')).toEqual(['manual:k1'])
  })

  // Manual-readiness review 2026-08-28, gap #1: a manual close used to cancel
  // EVERY manual bracket on the symbol, regardless of account. Passing
  // accountId scopes it to that account only.
  it('listManualEntrySignalIds scopes to accountId when given, and still matches untagged rows', () => {
    db.insertOrderSettlement({
      signalId: 'manual:acc-a', exchange: 'tradestation', accountId: '21084931', symbol: 'MESU26',
      kind: 'entry', side: 'buy', qty: 1, orderId: 'o1', targetLabel: 'entry', status: 'filled',
    })
    db.insertOrderSettlement({
      signalId: 'manual:acc-b', exchange: 'tradestation', accountId: '21084933', symbol: 'MESU26',
      kind: 'entry', side: 'buy', qty: 1, orderId: 'o2', targetLabel: 'entry', status: 'filled',
    })
    db.insertOrderSettlement({
      signalId: 'manual:no-account', exchange: 'tradestation', symbol: 'MESU26',
      kind: 'entry', side: 'buy', qty: 1, orderId: 'o3', targetLabel: 'entry', status: 'filled',
    })
    expect(db.listManualEntrySignalIds('tradestation', 'MESU26', '21084931')).toEqual([
      'manual:acc-a',
      'manual:no-account',
    ])
    expect(db.listManualEntrySignalIds('tradestation', 'MESU26', '21084933')).toEqual([
      'manual:acc-b',
      'manual:no-account',
    ])
    // No accountId → unscoped, matches every account (back-compat).
    expect(db.listManualEntrySignalIds('tradestation', 'MESU26')).toEqual([
      'manual:acc-a',
      'manual:acc-b',
      'manual:no-account',
    ])
  })

  // Manual-readiness review 2026-08-28, gap #1: a manual close's full-close
  // trail-retire used to cancel/deactivate EVERY trail on the symbol,
  // regardless of account — the stop of a DIFFERENT account's position on the
  // same symbol. Passing accountId scopes it to that account only.
  it('findActiveTrailsForSymbol scopes to accountId when given, and still matches untagged rows', () => {
    db.upsertLocalTrailState({
      signalId: 'pos:tradestation:21084931:MESU26', exchange: 'tradestation', symbol: 'MESU26',
      direction: 'long', entryPrice: 100, extremePrice: 100, accountId: '21084931',
    })
    db.upsertLocalTrailState({
      signalId: 'pos:tradestation:21084933:MESU26', exchange: 'tradestation', symbol: 'MESU26',
      direction: 'short', entryPrice: 100, extremePrice: 100, accountId: '21084933',
    })
    expect(db.findActiveTrailsForSymbol('tradestation', 'MESU26', '21084931').map((t) => t.signal_id)).toEqual([
      'pos:tradestation:21084931:MESU26',
    ])
    expect(db.findActiveTrailsForSymbol('tradestation', 'MESU26', '21084933').map((t) => t.signal_id)).toEqual([
      'pos:tradestation:21084933:MESU26',
    ])
    // No accountId → unscoped, matches every account (back-compat: the sibling-
    // stop-owner enforcement in position-manage.ts relies on this).
    expect(db.findActiveTrailsForSymbol('tradestation', 'MESU26').map((t) => t.signal_id).sort()).toEqual([
      'pos:tradestation:21084931:MESU26',
      'pos:tradestation:21084933:MESU26',
    ])
  })

  it('a manual entry order id is included in listKnownOrderIds (reconciler foreign-order guard)', () => {
    db.insertOrderSettlement({
      signalId: 'manual:k9', exchange: 'tradestation', symbol: 'MESM26',
      kind: 'entry', side: 'buy', qty: 1, orderId: 'broker-777', targetLabel: 'entry', status: 'filled',
    })
    expect(db.listKnownOrderIds('tradestation').has('broker-777')).toBe(true)
  })
})

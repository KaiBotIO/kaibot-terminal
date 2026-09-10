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

  it('a manual entry order id is included in listKnownOrderIds (reconciler foreign-order guard)', () => {
    db.insertOrderSettlement({
      signalId: 'manual:k9', exchange: 'tradestation', symbol: 'MESM26',
      kind: 'entry', side: 'buy', qty: 1, orderId: 'broker-777', targetLabel: 'entry', status: 'filled',
    })
    expect(db.listKnownOrderIds('tradestation').has('broker-777')).toBe(true)
  })
})

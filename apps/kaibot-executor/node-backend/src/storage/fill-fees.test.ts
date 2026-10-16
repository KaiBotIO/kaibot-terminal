import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { KaiBotDatabase } from './database.js'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Migration 040: the venue's native fee next to the USD commission, the
// backfill's fee-only update, and the order-keyed listing it reads.

let dir: string
let db: KaiBotDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-fill-fees-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('signal_fills fee columns', () => {
  it('stores commission with the native fee and currency', () => {
    db.insertSignalExecution({ signalId: 's1', symbol: 'ETH-PERPETUAL', exchange: 'deribit', direction: 'long', status: 'open', qtyOpened: 981, accountId: 'acct1/eth' })
    db.insertSignalFill({ signalId: 's1', kind: 'entry', symbol: 'ETH-PERPETUAL', side: 'buy', qty: 981, price: 3000, commission: 0.6, feeNative: 0.0002, feeCurrency: 'ETH', orderId: 'ETH-1' })
    const [f] = db.getSignalFills('s1')
    expect(f).toMatchObject({ commission: 0.6, fee_native: 0.0002, fee_currency: 'ETH', order_id: 'ETH-1' })
  })

  it('defaults to zero commission and no native fee', () => {
    db.insertSignalFill({ signalId: 's1', kind: 'entry', symbol: 'MESU26', side: 'buy', qty: 1, price: 7700 })
    const [f] = db.getSignalFills('s1')
    expect(f).toMatchObject({ commission: 0, fee_native: null, fee_currency: null })
  })

  it('updateSignalFillFee touches the fee columns only', () => {
    db.insertSignalFill({ signalId: 's1', kind: 'entry', symbol: 'MESU26', side: 'buy', qty: 1, price: 7700, orderId: 'o-1', createdAtMs: 1234 })
    const [before] = db.getSignalFills('s1')
    db.updateSignalFillFee(before!.id, { commission: 0.62, feeNative: 0.62, feeCurrency: 'USD' })
    const [after] = db.getSignalFills('s1')
    expect(after).toMatchObject({ commission: 0.62, fee_native: 0.62, fee_currency: 'USD' })
    expect([after!.qty, after!.price, after!.order_id, after!.created_at, after!.side]).toEqual([1, 7700, 'o-1', 1234, 'buy'])
  })

  it('listFillsWithOrderId joins the venue and account, skips fills without an order', () => {
    db.insertSignalExecution({ signalId: 's1', symbol: 'MESU26', exchange: 'tradestation', direction: 'long', status: 'closed', qtyOpened: 1, qtyClosed: 1, accountId: '21084931' })
    db.insertSignalFill({ signalId: 's1', kind: 'entry', symbol: 'MESU26', side: 'buy', qty: 1, price: 7700, orderId: 'o-1', createdAtMs: 1 })
    db.insertSignalFill({ signalId: 's1', kind: 'exit', symbol: 'MESU26', side: 'sell', qty: 1, price: 7702, orderId: null, createdAtMs: 2 })
    const rows = db.listFillsWithOrderId()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ signal_id: 's1', exchange: 'tradestation', account_id: '21084931', order_id: 'o-1', kind: 'entry' })
  })
})

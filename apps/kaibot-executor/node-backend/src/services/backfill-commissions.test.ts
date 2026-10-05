import { describe, expect, it } from 'bun:test'
import { backfillCommissions, type BackfillAdapter, type BackfillDeps } from './backfill-commissions.js'
import type { FillWithVenueRow } from '../storage/types.js'

// Fee lookups against mocked venues: TradeStation answers from the order
// status, Deribit from trade history, paper is zero. Writes touch the fee
// columns only, a rerun reports 'unchanged', a dry run writes nothing.

function fill(over: Partial<FillWithVenueRow> & { id: number }): FillWithVenueRow {
  return {
    signal_id: `sig-${over.id}`,
    exchange: 'tradestation',
    account_id: '21084931',
    symbol: 'MESU26',
    kind: 'entry',
    side: 'buy',
    qty: 1,
    price: 7700,
    commission: 0,
    fee_native: null,
    fee_currency: null,
    order_id: `o-${over.id}`,
    created_at: over.id,
    ...over,
  }
}

class FakeDb {
  writes: Array<{ id: number; fee: any }> = []
  logs: any[] = []
  constructor(public rows: FillWithVenueRow[]) {}
  listFillsWithOrderId(limit?: number) {
    return limit ? this.rows.slice(0, limit) : this.rows
  }
  updateSignalFillFee(id: number, fee: { commission: number; feeNative?: number | null; feeCurrency?: string | null }) {
    this.writes.push({ id, fee })
    const r = this.rows.find((x) => x.id === id)!
    r.commission = fee.commission
    r.fee_native = fee.feeNative ?? null
    r.fee_currency = fee.feeCurrency ?? null
  }
  log(level: string, category: string, message: string, data?: unknown) {
    this.logs.push({ level, category, message, data })
  }
}

const tsAdapter = (byOrder: Record<string, number>): BackfillAdapter => ({
  name: 'tradestation',
  getOrderStatus: async (orderId) =>
    orderId in byOrder
      ? { orderId, state: 'filled', filledQuantity: 1, averagePrice: 7700, commission: byOrder[orderId] }
      : { orderId, state: 'unknown', absenceConfirmed: true },
})

const deribitAdapter = (): BackfillAdapter => ({
  name: 'deribit',
  getOrderFee: async (orderId) =>
    orderId === 'd-1' ? { commission: 0.6, feeNative: 0.0002, feeCurrency: 'ETH' } : null,
  getOrderStatus: async (orderId) => ({ orderId, state: 'filled' }),
})

function deps(db: FakeDb, adapters: Record<string, BackfillAdapter | null>): BackfillDeps {
  return { db, getAdapter: async (exchange) => adapters[exchange] ?? null }
}

describe('backfillCommissions', () => {
  it('writes the venue fee onto each fill and reports it', async () => {
    const db = new FakeDb([fill({ id: 1 }), fill({ id: 2, kind: 'exit', side: 'sell', order_id: 'o-2' })])
    const report = await backfillCommissions(deps(db, { tradestation: tsAdapter({ 'o-1': 0.62, 'o-2': 0.62 }) }))
    expect(report).toMatchObject({ dryRun: false, scanned: 2, updated: 2, unchanged: 0, skipped: 0, failed: 0 })
    expect(db.writes.map((w) => [w.id, w.fee.commission])).toEqual([[1, 0.62], [2, 0.62]])
    expect(report.fills.map((f) => [f.id, f.before, f.after, f.status])).toEqual([
      [1, 0, 0.62, 'updated'],
      [2, 0, 0.62, 'updated'],
    ])
  })

  it('is idempotent: the second run changes nothing', async () => {
    const db = new FakeDb([fill({ id: 1 })])
    const d = deps(db, { tradestation: tsAdapter({ 'o-1': 0.62 }) })
    await backfillCommissions(d)
    const again = await backfillCommissions(d)
    expect(again).toMatchObject({ updated: 0, unchanged: 1 })
    expect(db.writes).toHaveLength(1)
    expect(db.rows[0]!.commission).toBe(0.62)
  })

  it('dry run reports what it would write and writes nothing', async () => {
    const db = new FakeDb([fill({ id: 1 })])
    const report = await backfillCommissions(deps(db, { tradestation: tsAdapter({ 'o-1': 0.62 }) }), { dryRun: true })
    expect(report.dryRun).toBe(true)
    expect(report.fills[0]).toMatchObject({ before: 0, after: 0.62, status: 'dry-run' })
    expect(report.updated).toBe(0)
    expect(db.writes).toHaveLength(0)
    expect(db.rows[0]!.commission).toBe(0)
  })

  it('splits one order fee pro rata over the fills it produced', async () => {
    // A close over two entries: 3 + 1 lots, one venue order, one fee.
    const db = new FakeDb([
      fill({ id: 1, kind: 'exit', side: 'sell', qty: 3, order_id: 'close-1', signal_id: 'new' }),
      fill({ id: 2, kind: 'exit', side: 'sell', qty: 1, order_id: 'close-1', signal_id: 'old' }),
    ])
    const calls: string[] = []
    const adapter: BackfillAdapter = {
      getOrderStatus: async (orderId) => {
        calls.push(orderId)
        return { orderId, state: 'filled', commission: 2.48 }
      },
    }
    const report = await backfillCommissions(deps(db, { tradestation: adapter }))
    expect(calls).toEqual(['close-1']) // one venue call for the group
    expect(report.fills.map((f) => [f.id, Number(f.after!.toFixed(4))])).toEqual([[1, 1.86], [2, 0.62]])
  })

  it('takes the Deribit fee from trade history with its native figure', async () => {
    const db = new FakeDb([fill({ id: 1, exchange: 'deribit', account_id: 'acct1/eth', symbol: 'ETH-PERPETUAL', order_id: 'd-1' })])
    const report = await backfillCommissions(deps(db, { deribit: deribitAdapter() }))
    expect(report.fills[0]).toMatchObject({ after: 0.6, feeNative: 0.0002, feeCurrency: 'ETH', status: 'updated' })
    expect(db.rows[0]).toMatchObject({ commission: 0.6, fee_native: 0.0002, fee_currency: 'ETH' })
  })

  it('books paper fills at zero without asking any adapter', async () => {
    const db = new FakeDb([fill({ id: 1, exchange: 'paper', commission: 1.5 })])
    let asked = false
    const report = await backfillCommissions({ db, getAdapter: async () => ((asked = true), null) })
    expect(asked).toBe(false)
    expect(report.fills[0]).toMatchObject({ before: 1.5, after: 0, status: 'updated' })
  })

  it('skips fills whose connection is not connected, and orders the venue no longer knows', async () => {
    const db = new FakeDb([
      fill({ id: 1, exchange: 'bybit', order_id: 'b-1' }),
      fill({ id: 2, exchange: 'deribit', order_id: 'gone' }),
    ])
    const report = await backfillCommissions(deps(db, { bybit: null, deribit: deribitAdapter() }))
    expect(report.fills.map((f) => f.status)).toEqual(['no-adapter', 'not-found'])
    expect(report.skipped).toBe(2)
    expect(db.writes).toHaveLength(0)
  })

  it('marks a venue that reports no fee at all as unsupported', async () => {
    const db = new FakeDb([fill({ id: 1, exchange: 'binance', order_id: 'x' })])
    const adapter: BackfillAdapter = { getOrderStatus: async (orderId) => ({ orderId, state: 'filled' }) }
    const report = await backfillCommissions(deps(db, { binance: adapter }))
    expect(report.fills[0]!.status).toBe('unsupported')
  })

  it('onlyZero leaves fills that already carry a fee alone', async () => {
    const db = new FakeDb([fill({ id: 1, commission: 0.5 }), fill({ id: 2 })])
    const report = await backfillCommissions(deps(db, { tradestation: tsAdapter({ 'o-1': 0.62, 'o-2': 0.62 }) }), { onlyZero: true })
    expect(report.scanned).toBe(1)
    expect(db.writes.map((w) => w.id)).toEqual([2])
  })

  it('a throwing venue lookup fails that group only', async () => {
    const db = new FakeDb([fill({ id: 1, order_id: 'boom' }), fill({ id: 2, order_id: 'ok' })])
    const adapter: BackfillAdapter = {
      getOrderStatus: async (orderId) => {
        if (orderId === 'boom') throw new Error('venue down')
        return { orderId, state: 'filled', commission: 0.62 }
      },
    }
    const report = await backfillCommissions(deps(db, { tradestation: adapter }))
    expect(report.fills.map((f) => f.status)).toEqual(['error', 'updated'])
    expect(report.failed).toBe(1)
    expect(report.fills[0]!.detail).toBe('venue down')
  })
})

describe('backfillCommissions history hint', () => {
  it('hands the adapter a since hint ahead of the earliest fill of the order', async () => {
    const t0 = Date.parse('2026-08-30T14:00:00Z')
    const db = new FakeDb([
      fill({ id: 1, kind: 'exit', side: 'sell', qty: 1, order_id: 'close-1', created_at: t0 + 3_600_000 }),
      fill({ id: 2, kind: 'exit', side: 'sell', qty: 1, order_id: 'close-1', created_at: t0 }),
    ])
    const hints: Array<number | undefined> = []
    const adapter: BackfillAdapter = {
      getOrderFee: async (_orderId, ctx) => {
        hints.push(ctx?.sinceMs)
        return ctx?.sinceMs != null ? { commission: 0.4, feeNative: 0.4, feeCurrency: 'USD' } : null
      },
    }
    const report = await backfillCommissions(deps(db, { tradestation: adapter }))
    expect(hints).toHaveLength(1)
    expect(hints[0]).toBe(t0 - 3 * 86_400_000)
    expect(report.updated).toBe(2)
  })

  it('explains a TradeStation miss that lies beyond the 90-day history window', async () => {
    const db = new FakeDb([fill({ id: 1, order_id: 'ancient', created_at: Date.now() - 120 * 86_400_000 })])
    const adapter: BackfillAdapter = {
      getOrderFee: async () => null,
      getOrderStatus: async (orderId) => ({ orderId, state: 'unknown', absenceConfirmed: true }),
    }
    const report = await backfillCommissions(deps(db, { tradestation: adapter }))
    expect(report.fills[0]).toMatchObject({ status: 'not-found', detail: 'older than the venue history window (90 days)' })
  })
})

// Commission backfill for the fill ledger.
//
// Every fill that names a venue order gets its fee looked up at the venue and
// written onto the row: TradeStation from the order status (CommissionFee +
// route fee), Deribit from the order's trades (fee, fee_currency → USD), paper
// zero. One venue call per order; an order that produced several fills (a
// close spread over three entries, a rung filled in two sweeps) has its fee
// split pro rata by quantity, so the pieces add back up to what the venue
// charged. Only the fee columns are written, and only when the value changes,
// so a rerun is a no-op report. Dry run reports what it would write.

import type { FillWithVenueRow } from '../storage/types.js'
import type { FillFee, OrderQueryContext, OrderStatus } from './exchanges/types.js'
import { splitFee } from './exit-attribution.js'

export type BackfillFillStatus =
  | 'updated'
  | 'unchanged'
  | 'dry-run'
  | 'no-adapter'
  | 'unsupported'
  | 'not-found'
  | 'error'

export interface BackfillFillReport {
  id: number
  signalId: string
  exchange: string
  accountId: string | null
  symbol: string
  kind: 'entry' | 'exit'
  orderId: string
  qty: number
  before: number
  after: number | null
  feeNative: number | null
  feeCurrency: string | null
  status: BackfillFillStatus
  detail?: string
}

export interface BackfillReport {
  dryRun: boolean
  scanned: number
  updated: number
  unchanged: number
  skipped: number
  failed: number
  fills: BackfillFillReport[]
}

export interface BackfillAdapter {
  name?: string
  getOrderFee?: (orderId: string, ctx?: OrderQueryContext) => Promise<FillFee | null>
  getOrderStatus?: (orderId: string, ctx?: OrderQueryContext) => Promise<OrderStatus>
}

export interface BackfillDeps {
  db: {
    listFillsWithOrderId(limit?: number): FillWithVenueRow[]
    updateSignalFillFee(id: number, fee: { commission: number; feeNative?: number | null; feeCurrency?: string | null }): unknown
    log(level: string, category: string, message: string, data?: unknown): unknown
  }
  // Adapter of the connection that holds this account; null when not connected.
  getAdapter(exchange: string, accountId: string | null): Promise<BackfillAdapter | null>
}

export interface BackfillOptions {
  dryRun?: boolean
  /** Only fills whose commission is still zero. Default: every fill with an order id. */
  onlyZero?: boolean
  limit?: number
}

const EPS = 1e-9
const isPaper = (exchange: string) => exchange.toLowerCase() === 'paper'
// Head start of a history lookup ahead of the earliest fill of an order.
const HISTORY_MARGIN_MS = 3 * 86_400_000
// How far back a venue's order history reaches; a miss beyond it is explained.
const HISTORY_WINDOW_DAYS: Record<string, number> = { tradestation: 90 }

// The order's fee from the venue. getOrderFee (trade history) wins; a status
// that carries the fee is the fallback; anything else is unsupported.
async function venueFee(
  adapter: BackfillAdapter,
  orderId: string,
  ctx: OrderQueryContext,
): Promise<{ fee: FillFee | null; status: 'ok' | 'unsupported' | 'not-found' }> {
  if (adapter.getOrderFee) {
    const fee = await adapter.getOrderFee(orderId, ctx)
    if (fee) return { fee, status: 'ok' }
    // A venue with trade history but none for this id: try the status before
    // giving up, an order that never traded reports no fee either way.
  }
  if (adapter.getOrderStatus) {
    const s = await adapter.getOrderStatus(orderId, ctx)
    if (s.state === 'unknown') return { fee: null, status: 'not-found' }
    if (s.commission == null) return { fee: null, status: adapter.getOrderFee ? 'not-found' : 'unsupported' }
    return {
      fee: { commission: s.commission, feeNative: s.feeNative, feeCurrency: s.feeCurrency },
      status: 'ok',
    }
  }
  return { fee: null, status: adapter.getOrderFee ? 'not-found' : 'unsupported' }
}

export async function backfillCommissions(deps: BackfillDeps, opts: BackfillOptions = {}): Promise<BackfillReport> {
  const dryRun = opts.dryRun === true
  const all = deps.db.listFillsWithOrderId(opts.limit)
  const fills = opts.onlyZero ? all.filter((f) => Math.abs(f.commission) <= EPS) : all
  const report: BackfillReport = { dryRun, scanned: fills.length, updated: 0, unchanged: 0, skipped: 0, failed: 0, fills: [] }

  // One venue call per (exchange, account, order, kind).
  const groups = new Map<string, FillWithVenueRow[]>()
  for (const f of fills) {
    const key = `${f.exchange}|${f.account_id ?? ''}|${f.order_id}|${f.kind}`
    const g = groups.get(key) ?? []
    g.push(f)
    groups.set(key, g)
  }

  const base = (f: FillWithVenueRow): Omit<BackfillFillReport, 'after' | 'feeNative' | 'feeCurrency' | 'status'> => ({
    id: f.id,
    signalId: f.signal_id,
    exchange: f.exchange,
    accountId: f.account_id,
    symbol: f.symbol,
    kind: f.kind,
    orderId: f.order_id,
    qty: f.qty,
    before: f.commission,
  })
  const push = (r: BackfillFillReport) => {
    report.fills.push(r)
    if (r.status === 'updated') report.updated++
    else if (r.status === 'unchanged') report.unchanged++
    else if (r.status === 'error') report.failed++
    else if (r.status !== 'dry-run') report.skipped++
  }
  // A group's fee lands on its fills pro rata; equal values are left alone.
  const apply = (group: FillWithVenueRow[], fee: FillFee) => {
    const shares = splitFee(fee, group.map((f) => f.qty))
    for (const [i, f] of group.entries()) {
      const share = shares[i]!
      const before = base(f) // captured before the write
      const same =
        Math.abs(f.commission - share.commission) <= EPS &&
        (f.fee_native ?? null) === (share.feeNative ?? null) &&
        (f.fee_currency ?? null) === (share.feeCurrency ?? null)
      if (same) {
        push({ ...before, after: share.commission, feeNative: share.feeNative, feeCurrency: share.feeCurrency, status: 'unchanged' })
        continue
      }
      if (dryRun) {
        push({ ...before, after: share.commission, feeNative: share.feeNative, feeCurrency: share.feeCurrency, status: 'dry-run' })
        continue
      }
      deps.db.updateSignalFillFee(f.id, share)
      push({ ...before, after: share.commission, feeNative: share.feeNative, feeCurrency: share.feeCurrency, status: 'updated' })
    }
  }

  for (const group of groups.values()) {
    const head = group[0]!
    if (isPaper(head.exchange)) {
      apply(group, { commission: 0 })
      continue
    }
    let adapter: BackfillAdapter | null = null
    try {
      adapter = await deps.getAdapter(head.exchange, head.account_id)
    } catch (err: any) {
      for (const f of group) push({ ...base(f), after: null, feeNative: null, feeCurrency: null, status: 'error', detail: err?.message })
      continue
    }
    if (!adapter) {
      for (const f of group) push({ ...base(f), after: null, feeNative: null, feeCurrency: null, status: 'no-adapter', detail: 'connection not connected' })
      continue
    }
    // The order dates from before its earliest fill; a history lookup starts
    // a little ahead of that (a resting stop can fill days after placement).
    const sinceMs = Math.min(...group.map((f) => f.created_at)) - HISTORY_MARGIN_MS
    const ctx: OrderQueryContext = {
      symbol: head.symbol,
      sinceMs,
      ...(head.account_id ? { accountId: head.account_id } : {}),
    }
    try {
      const { fee, status } = await venueFee(adapter, head.order_id, ctx)
      if (!fee) {
        const miss: BackfillFillStatus = status === 'unsupported' ? 'unsupported' : 'not-found'
        const window = HISTORY_WINDOW_DAYS[head.exchange.toLowerCase()]
        const detail =
          miss === 'not-found' && window != null && Date.now() - sinceMs > window * 86_400_000
            ? `older than the venue history window (${window} days)`
            : undefined
        for (const f of group) push({ ...base(f), after: null, feeNative: null, feeCurrency: null, status: miss, ...(detail ? { detail } : {}) })
        continue
      }
      apply(group, fee)
    } catch (err: any) {
      for (const f of group) push({ ...base(f), after: null, feeNative: null, feeCurrency: null, status: 'error', detail: err?.message })
    }
  }

  deps.db.log(dryRun ? 'info' : 'warn', 'trading', 'Commission backfill', {
    dryRun,
    scanned: report.scanned,
    updated: report.updated,
    unchanged: report.unchanged,
    skipped: report.skipped,
    failed: report.failed,
  })
  return report
}

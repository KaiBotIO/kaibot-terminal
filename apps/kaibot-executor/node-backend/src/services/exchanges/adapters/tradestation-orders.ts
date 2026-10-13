// Shared TradeStation order-status logic used by both TradeStation adapters
// (oauth + couchdb). They differ only in how they authenticate; the brokerage
// trading API surface is identical, so the order lookup + status mapping live
// here once.
//
// The lookup queries the working /orders endpoint first, then falls back to
// /historicalorders for an order that already left the working set. Without the
// historical fallback a terminal order (e.g. a late-filled entry) is reported as
// 'unknown' forever, and a timed-out entry never resolves → an orphaned position
// the executor doesn't know it holds. Mirrors kaibot-exec/src/ts-trade.ts
// getOrderStatuses().

import type { FillFee, Order, OrderStatus } from '../types.js'

/**
 * Resolve the TimeInForce string sent on a TradeStation order POST.
 *
 * Protective bracket legs (reduce-only stop / take-profit) MUST outlive the
 * session close. A TIF=DAY stop is killed at Globex settlement (status DON),
 * so an overnight futures position would sit UNPROTECTED until the next open.
 * A reduce-only leg with no explicit TIF therefore defaults to GTC. Everything
 * else keeps TradeStation's DAY default — an entry that dies at session end is
 * re-issued on reopen, and a market entry ignores TIF entirely. An explicit
 * timeInForce is always honored (a caller can still force DAY).
 *
 * This also restores parity with the other venues: Binance/Bybit already
 * default a bracket leg to GTC, and the sim/backtester treats protective legs
 * as persistent (no session-close expiry) — only TradeStation diverged by
 * silently downgrading them to DAY.
 */
export function resolveTradeStationTif(order: Pick<Order, 'timeInForce' | 'reduceOnly'>): string {
  if (order.timeInForce) return order.timeInForce
  if (order.reduceOnly) return 'GTC'
  return 'DAY'
}

/**
 * Serialize a price for a TradeStation order POST. Server-computed levels
 * (initialStopPct/liveStopPct percentages of a fill price) carry float tails
 * — 29233.5 × 0.95 = 27771.824999999997 — and TradeStation hard-rejects them
 * ("Max 8 decimal places supported for 'StopPrice'"), which cost the ascender
 * sync entry its venue backstop (vangnet 2026-08-24). Tick alignment is the
 * server's job (it owns the instrument registry); this guarantees the wire
 * format is always acceptable.
 */
export function tsPriceString(v: number | undefined | null): string | undefined {
  if (v === undefined || v === null || !Number.isFinite(v)) return undefined
  return String(Number(v.toFixed(8)))
}

// TradeStation order status codes. Anything not in this set counts as still
// working. RJC (cancel rejected) is deliberately NOT terminal — the underlying
// order may still fill. Mirrors kaibot-exec/src/ts-trade.ts TERMINAL_STATUSES.
export const TS_TERMINAL: ReadonlySet<string> = new Set([
  'FLL',
  'REJ',
  'EXP',
  'CAN',
  'OUT',
  'BRC',
  'DON',
  'FLP',
])

// How far back the historical-orders lookup reaches. TradeStation caps this at
// 90 days; 14 is plenty for an order that timed out moments ago.
const HISTORICAL_SINCE_DAYS = 14
// The venue's hard limit on the history window.
export const TS_HISTORY_MAX_DAYS = 90
const DAY_MS = 86_400_000

function num(v: any): number {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : 0
}

// Fill timestamp of a terminal order: the leg's ExecutionTime when present,
// else the order's ClosedDateTime. Undefined when neither parses — callers
// fall back to "now".
function fillTimeMs(order: any, leg: any): number | undefined {
  for (const v of [leg?.ExecutionTime, order?.ClosedDateTime]) {
    if (typeof v !== 'string' || v.length === 0) continue
    const t = Date.parse(v)
    if (Number.isFinite(t)) return t
  }
  return undefined
}

/** Map a raw TradeStation order object to the generic OrderStatus shape. */
export function mapTradeStationOrderStatus(orderId: string, order: any): OrderStatus {
  const status = order.Status as string
  if (!TS_TERMINAL.has(status)) {
    return { orderId, state: 'working', raw: order }
  }
  if (status === 'FLL') {
    const leg = order.Legs?.[0] || {}
    const commission = num(order.CommissionFee) + num(order.UnbundledRouteFee)
    return {
      orderId,
      state: 'filled',
      filledQuantity: num(leg.ExecQuantity ?? leg.QuantityOrdered ?? order.FilledQuantity),
      averagePrice: num(order.FilledPrice ?? leg.ExecutionPrice),
      commission,
      filledAtMs: fillTimeMs(order, leg),
      raw: order,
    }
  }
  // DON = done-for-day: the working remainder was killed at session end. A market
  // order placed into a shut session (Globex closed on a Sunday) never fills and
  // must be RE-PLACED on reopen, not booked as a fill — map it to a non-fill
  // terminal so settleClose reports 'unknown' and retryPendingCloses re-issues.
  // A partial fill that landed before the kill is preserved so it isn't re-traded.
  // Ref: kaibot-exec cebd203 (DON added to RETRYABLE_ORDER_STATUSES).
  if (status === 'DON') {
    const leg = order.Legs?.[0] || {}
    const filled = num(leg.ExecQuantity ?? order.FilledQuantity)
    if (filled > 0) {
      return {
        orderId,
        state: 'partially_filled',
        filledQuantity: filled,
        averagePrice: num(order.FilledPrice ?? leg.ExecutionPrice),
        commission: num(order.CommissionFee) + num(order.UnbundledRouteFee),
        filledAtMs: fillTimeMs(order, leg),
        raw: order,
      }
    }
    return { orderId, state: 'cancelled', raw: order }
  }
  if (status === 'FLP') {
    const leg = order.Legs?.[0] || {}
    return {
      orderId,
      state: 'partially_filled',
      filledQuantity: num(leg.ExecQuantity ?? order.FilledQuantity),
      averagePrice: num(order.FilledPrice),
      filledAtMs: fillTimeMs(order, leg),
      raw: order,
    }
  }
  if (status === 'REJ') return { orderId, state: 'rejected', raw: order }
  // CAN / EXP / OUT / BRC → cancelled (terminal, no fill).
  return { orderId, state: 'cancelled', raw: order }
}

/**
 * Resolve a single order's status by id for the settlement poller / reconciler.
 * Working /orders endpoint first, /historicalorders as a fallback (an order
 * placed earlier or already terminal may have rolled off the live list). When
 * the broker reports nothing at all, returns state 'unknown' so the caller keeps
 * the order tracked rather than assuming it vanished.
 *
 * `call` is the adapter's authenticated GET helper; both adapters pass theirs.
 */
export async function lookupTradeStationOrderStatus(
  call: (endpoint: string) => Promise<any>,
  account: string,
  orderId: string,
): Promise<OrderStatus> {
  let order: any | undefined
  // Absence is only venue-confirmed when at least one endpoint actually
  // ANSWERED without the order — two failed calls prove nothing about the
  // order, so 'unknown' then stays unconfirmed (never auto-rejected).
  let lookupSucceeded = false
  try {
    const data = await call(`/v3/brokerage/accounts/${account}/orders/${orderId}`)
    lookupSucceeded = true
    order = (data.Orders || []).find((o: any) => String(o.OrderID) === String(orderId))
  } catch {
    /* fall through to historical */
  }

  if (!order) {
    try {
      const since = new Date(Date.now() - HISTORICAL_SINCE_DAYS * 86_400_000)
        .toISOString()
        .slice(0, 10)
      const hist = await call(
        `/v3/brokerage/accounts/${account}/historicalorders/${orderId}?since=${since}`,
      )
      lookupSucceeded = true
      order = (hist.Orders || []).find((o: any) => String(o.OrderID) === String(orderId))
    } catch {
      /* nothing more to try */
    }
  }

  if (!order) return { orderId, state: 'unknown', absenceConfirmed: lookupSucceeded }
  return mapTradeStationOrderStatus(orderId, order)
}

/** Fee TradeStation charged on one order: commission plus the unbundled route fee, USD. */
export function tradeStationOrderFee(order: any): FillFee {
  // Two string fields summed: cut the float tail (0.35 + 0.05 = 0.39999…).
  const fee = Number((num(order?.CommissionFee) + num(order?.UnbundledRouteFee)).toFixed(8))
  return { commission: fee, feeNative: fee, feeCurrency: String(order?.Currency || 'USD') }
}

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/**
 * Every historical (non-working) order of one account since a date, keyed by
 * OrderID. Pages through GET /historicalorders?since=&pageSize=&nextToken=
 * until the venue stops handing out a NextToken. `since` is clamped to the
 * venue's 90-day window; an order older than that is simply not in the map.
 */
export async function fetchTradeStationHistoricalOrders(
  call: (endpoint: string) => Promise<any>,
  account: string,
  sinceMs: number,
  opts: { pageSize?: number; maxPages?: number; nowMs?: number } = {},
): Promise<Map<string, any>> {
  const now = opts.nowMs ?? Date.now()
  const floor = now - (TS_HISTORY_MAX_DAYS - 1) * DAY_MS
  const since = dayOf(Math.max(sinceMs, floor))
  const pageSize = opts.pageSize ?? 600
  const maxPages = opts.maxPages ?? 50
  const out = new Map<string, any>()
  let nextToken: string | undefined
  for (let page = 0; page < maxPages; page++) {
    const q = new URLSearchParams({ since, pageSize: String(pageSize) })
    if (nextToken) q.set('nextToken', nextToken)
    const data = await call(`/v3/brokerage/accounts/${account}/historicalorders?${q.toString()}`)
    for (const o of data?.Orders ?? []) {
      if (o?.OrderID != null) out.set(String(o.OrderID), o)
    }
    nextToken = typeof data?.NextToken === 'string' && data.NextToken ? data.NextToken : undefined
    if (!nextToken) break
  }
  return out
}

/**
 * One account's history window, fetched once and reused while fresh. A
 * request for an earlier `since` than the cached window widens it (one
 * refetch), a later one reuses it: the commission backfill walks fills oldest
 * first, so a whole account costs one paginated fetch.
 */
export class TradeStationHistoryCache {
  private windows = new Map<string, { sinceDay: string; fetchedAt: number; orders: Map<string, any> }>()
  constructor(private ttlMs = 5 * 60_000) {}

  async orders(
    call: (endpoint: string) => Promise<any>,
    account: string,
    sinceMs: number,
    nowMs = Date.now(),
  ): Promise<Map<string, any>> {
    const wanted = dayOf(Math.max(sinceMs, nowMs - (TS_HISTORY_MAX_DAYS - 1) * DAY_MS))
    const cached = this.windows.get(account)
    if (cached && cached.sinceDay <= wanted && nowMs - cached.fetchedAt < this.ttlMs) return cached.orders
    const orders = await fetchTradeStationHistoricalOrders(call, account, sinceMs, { nowMs })
    this.windows.set(account, { sinceDay: wanted, fetchedAt: nowMs, orders })
    return orders
  }
}

/**
 * Fee of one order for the commission backfill. The status lookup (working
 * set, then /historicalorders/{id} over the last two weeks) answers for a
 * recent order; an older one is looked up in the account's history window
 * from `sinceMs` on. Null when the venue has no filled order for the id.
 */
export async function lookupTradeStationOrderFee(
  call: (endpoint: string) => Promise<any>,
  account: string,
  orderId: string,
  opts: { sinceMs?: number; history?: TradeStationHistoryCache; nowMs?: number } = {},
): Promise<FillFee | null> {
  const status = await lookupTradeStationOrderStatus(call, account, orderId)
  if (status.state === 'filled' || status.state === 'partially_filled') {
    return tradeStationOrderFee(status.raw)
  }
  if (status.state !== 'unknown' || opts.sinceMs == null) return null
  const history = opts.history ?? new TradeStationHistoryCache()
  const order = (await history.orders(call, account, opts.sinceMs, opts.nowMs)).get(String(orderId))
  if (!order) return null
  const mapped = mapTradeStationOrderStatus(orderId, order)
  if (mapped.state !== 'filled' && mapped.state !== 'partially_filled') return null
  return tradeStationOrderFee(order)
}

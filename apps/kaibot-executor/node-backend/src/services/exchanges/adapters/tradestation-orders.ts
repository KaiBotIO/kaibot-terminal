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

import type { Order, OrderStatus } from '../types.js'

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

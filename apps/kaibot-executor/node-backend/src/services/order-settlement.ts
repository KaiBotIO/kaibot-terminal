// Order settlement: after placeOrder, poll the broker until the order reaches a
// terminal status (filled / rejected / cancelled). If it's still working after
// the poll window, cancel it and poll once more for the final outcome (the
// cancel races a possible fill — both resolve to a terminal status). When even
// the post-cancel outcome is unknown, return TIMEOUT: the caller must persist
// the order as unresolved and never treat it as gone. A later pass over the
// broker order history (resolveUnknownOrders) settles it for real.
//
// Ported from kaibot-exec/src/ts-trade.ts `pollFill` / `settleOrder`, adapted to
// the executor's generic ExchangeAdapter.getOrderStatus.

import type {
  ExchangeAdapter,
  OrderQueryContext,
  OrderStatus,
  OrderStatusState,
} from './exchanges/types.js'

export type SettlementStatus =
  | 'filled'
  | 'partially_filled'
  | 'cancelled'
  | 'rejected'
  | 'timeout'

export interface SettlementResult {
  status: SettlementStatus
  filledQuantity?: number
  averagePrice?: number
  commission?: number
  raw?: any
}

export interface SettleOptions {
  attempts?: number
  intervalMs?: number
  // Injection point for tests so they don't sleep on real timers.
  sleep?: (ms: number) => Promise<void>
}

const TERMINAL_STATES: ReadonlySet<OrderStatusState> = new Set([
  'filled',
  'partially_filled',
  'cancelled',
  'rejected',
])

export function isTerminalState(state: OrderStatusState): boolean {
  return TERMINAL_STATES.has(state)
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function toSettlement(s: OrderStatus): SettlementResult {
  return {
    status: s.state as SettlementStatus,
    filledQuantity: s.filledQuantity,
    averagePrice: s.averagePrice,
    commission: s.commission,
    raw: s.raw,
  }
}

/** Poll getOrderStatus until terminal or attempts exhausted. */
async function pollStatus(
  adapter: ExchangeAdapter,
  orderId: string,
  ctx: OrderQueryContext,
  opts: Required<Pick<SettleOptions, 'attempts' | 'intervalMs' | 'sleep'>>,
): Promise<SettlementResult> {
  for (let i = 0; i < opts.attempts; i++) {
    await opts.sleep(opts.intervalMs)
    let status: OrderStatus
    try {
      status = await adapter.getOrderStatus!(orderId, ctx)
    } catch {
      // A transient query failure shouldn't abort settlement; keep polling.
      continue
    }
    if (status.state === 'unknown') continue // not reported yet
    if (isTerminalState(status.state)) return toSettlement(status)
  }
  return { status: 'timeout' }
}

/**
 * Settle a placed order. Returns a terminal outcome, or `timeout` when the
 * outcome stays unknown even after a cancel attempt. Adapters without
 * getOrderStatus can't be settled — the caller should treat the placeOrder
 * result as authoritative in that case (this function shouldn't be called).
 */
export async function settleAdapterOrder(
  adapter: ExchangeAdapter,
  orderId: string,
  ctx: OrderQueryContext = {},
  options: SettleOptions = {},
): Promise<SettlementResult> {
  if (!adapter.getOrderStatus) return { status: 'timeout' }

  const opts = {
    attempts: options.attempts ?? 20,
    intervalMs: options.intervalMs ?? 500,
    sleep: options.sleep ?? defaultSleep,
  }

  const first = await pollStatus(adapter, orderId, ctx, opts)
  if (first.status !== 'timeout') return first

  // Still working after the poll window: cancel and poll once more. The cancel
  // races a possible fill, so the post-cancel poll decides the real outcome.
  // SPINE: this is stuck-order recovery (settlement hygiene on an order the
  // SERVER already told us to place), NOT an autonomous trade decision — the
  // executor is abandoning an unfilled order, not opening/closing a position.
  try {
    await adapter.cancelOrder(orderId, ctx)
  } catch {
    // Cancel may legitimately fail (already filled/gone). The second poll still
    // tells us what happened.
  }
  return pollStatus(adapter, orderId, ctx, opts)
}

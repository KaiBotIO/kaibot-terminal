// One-shot book repair for the 2026-09-01 MGCZ26 reconciler-rebuy incident.
//
// What happened: the Ascender MGC entry's GTC stop (order 1301382064) filled at
// the broker, but the running build predated the exit-attribution wiring, so
// nothing was booked. The reconciler then saw "expected 1, broker 0" and bought
// the position BACK twice (orders 1303499149 and 1303896425); each rebuy was
// manually flattened (orders 1303889340 and 1303959955). The book still says
// the bot is long.
//
// What this repairs, idempotently, with every price/time taken from the
// broker's own order history:
//  1. The bot trade closes on its REAL exit: the stop fill is booked as the
//     exit fill of execution 4c82168b, which goes 'closed'.
//  2. The two reconciler round-trips become their own closed executions under
//     synthetic non-bot signal ids (reconcile-roundtrip:<orderId>), so
//     analytics shows them as separate unattributed posts — never swept into
//     the strategy's scorecard.
//  3. The spent protective state retires (server_exit_state, bracket pair).
//  4. The server is told the position is flat (venue-exit report), so the
//     Ascender MGC runner stops thinking it is long.
//
// Exposed as an operations route, never as a free-form DB edit: the exact
// order ids live here, in reviewed code.

import type { KaiBotDatabase } from '../storage/database.js'
import type { OrderStatus } from './exchanges/types.js'
import { attributeVenueExit } from './exit-attribution.js'

export const MGC_REPAIR_20260901 = {
  exchange: 'tradestation',
  accountId: '21084933',
  symbol: 'MGCZ26',
  entrySignalId: '4c82168b-61cf-407e-8d92-920d868e7e1f',
  serverPositionId: '3d4c9a7f-dd5c-4959-9a9a-d4a25b46feda',
  // GTC stop that flattened the bot position (~4396.8, 2026-09-01 ~13:00 UTC).
  stopOrderId: '1301382064',
  // Reconciler rebuy → manual flatten, twice (reconciliations id 4/10,
  // settlements id 8/9).
  roundTrips: [
    { entryOrderId: '1303499149', exitOrderId: '1303889340' },
    { entryOrderId: '1303896425', exitOrderId: '1303959955' },
  ],
} as const

export interface RepairAdapter {
  getOrderStatus?: (
    orderId: string,
    ctx?: { accountId?: string; symbol?: string },
  ) => Promise<OrderStatus>
}

export interface RepairDeps {
  // Server flat report (signal client's venue-exit POST). Optional: without it
  // the local book still repairs and the report step is listed as skipped.
  reportVenueExit?: (
    positionId: string,
    fill: { price: number | null; timeMs: number; orderId?: string | null },
  ) => Promise<void>
}

export interface RepairStepResult {
  step: string
  status: 'done' | 'skipped' | 'error'
  detail?: string
}

export interface RepairReport {
  ok: boolean
  steps: RepairStepResult[]
}

// Every referenced order must be venue-confirmed filled before anything is
// written — a repair on guessed prices would be exactly the corruption it fixes.
async function fetchFilled(
  adapter: RepairAdapter,
  orderId: string,
  ctx: { accountId: string; symbol: string },
): Promise<OrderStatus> {
  if (!adapter.getOrderStatus) throw new Error('adapter has no getOrderStatus')
  const s = await adapter.getOrderStatus(orderId, ctx)
  if (s.state !== 'filled') {
    throw new Error(`order ${orderId} is '${s.state}', expected 'filled'`)
  }
  if (!(s.averagePrice && s.averagePrice > 0)) {
    throw new Error(`order ${orderId} filled but reports no price`)
  }
  return s
}

export async function repairReconcilerRebuy20260901(
  db: KaiBotDatabase,
  adapter: RepairAdapter,
  deps: RepairDeps = {},
): Promise<RepairReport> {
  const C = MGC_REPAIR_20260901
  const steps: RepairStepResult[] = []
  const ctx = { accountId: C.accountId, symbol: C.symbol }

  // ─── Verify the venue's account of all five orders up front ───
  let stop: OrderStatus
  const trips: Array<{ entry: OrderStatus; exit: OrderStatus }> = []
  try {
    stop = await fetchFilled(adapter, C.stopOrderId, ctx)
    for (const t of C.roundTrips) {
      trips.push({
        entry: await fetchFilled(adapter, t.entryOrderId, ctx),
        exit: await fetchFilled(adapter, t.exitOrderId, ctx),
      })
    }
  } catch (err: any) {
    return {
      ok: false,
      steps: [{ step: 'verify-orders', status: 'error', detail: err?.message }],
    }
  }
  steps.push({ step: 'verify-orders', status: 'done', detail: 'all 5 orders venue-confirmed filled' })

  // ─── 1. Book the stop fill as the bot execution's exit ───
  const exec = db.getSignalExecution(C.entrySignalId)
  if (!exec) {
    steps.push({ step: 'book-stop-exit', status: 'error', detail: 'entry execution not found' })
    return { ok: false, steps }
  }
  const targetLabel = `venue-exit:${C.stopOrderId}`
  if (exec.status === 'closed' || db.targetAlreadyProcessed(C.entrySignalId, 'exit', targetLabel)) {
    steps.push({ step: 'book-stop-exit', status: 'skipped', detail: 'already booked' })
  } else {
    const openQty = exec.qty_opened - exec.qty_closed
    const qty = stop.filledQuantity && stop.filledQuantity > 0 ? Math.min(stop.filledQuantity, openQty) : openQty
    db.insertOrderSettlement({
      signalId: C.entrySignalId,
      exchange: C.exchange,
      accountId: C.accountId,
      symbol: C.symbol,
      kind: 'exit',
      side: 'sell',
      qty,
      orderId: C.stopOrderId,
      targetLabel,
      status: 'filled',
    })
    const plan = attributeVenueExit(db, {
      exchange: C.exchange,
      accountId: C.accountId,
      symbol: C.symbol,
      side: 'sell',
      qty,
      price: stop.averagePrice ?? null,
      orderId: C.stopOrderId,
      filledAtMs: stop.filledAtMs ?? null,
      reason: 'venue stop filled (repair 2026-09-01)',
    })
    steps.push({
      step: 'book-stop-exit',
      status: plan.length > 0 ? 'done' : 'error',
      detail: `qty ${qty} @ ${stop.averagePrice} (order ${C.stopOrderId})`,
    })
  }

  // ─── 2. The two reconciler round-trips as separate non-bot posts ───
  for (const [i, t] of trips.entries()) {
    const signalId = `reconcile-roundtrip:${C.roundTrips[i]!.entryOrderId}`
    const step = `roundtrip-${i + 1}`
    if (db.getSignalExecution(signalId)) {
      steps.push({ step, status: 'skipped', detail: 'already recorded' })
      continue
    }
    const qty = t.entry.filledQuantity && t.entry.filledQuantity > 0 ? t.entry.filledQuantity : 1
    db.insertSignalExecution({
      signalId,
      symbol: C.symbol,
      exchange: C.exchange,
      direction: 'long',
      status: 'closed',
      qtyOpened: qty,
      qtyClosed: qty,
      accountId: C.accountId,
      ...(t.entry.filledAtMs ? { createdAtMs: t.entry.filledAtMs } : {}),
    })
    db.insertSignalFill({
      signalId,
      kind: 'entry',
      symbol: C.symbol,
      side: 'buy',
      qty,
      price: t.entry.averagePrice ?? null,
      commission: t.entry.commission ?? 0,
      orderId: C.roundTrips[i]!.entryOrderId,
      ...(t.entry.filledAtMs ? { createdAtMs: t.entry.filledAtMs } : {}),
    })
    db.insertSignalFill({
      signalId,
      kind: 'exit',
      symbol: C.symbol,
      side: 'sell',
      qty,
      price: t.exit.averagePrice ?? null,
      commission: t.exit.commission ?? 0,
      orderId: C.roundTrips[i]!.exitOrderId,
      ...(t.exit.filledAtMs ? { createdAtMs: t.exit.filledAtMs } : {}),
    })
    steps.push({
      step,
      status: 'done',
      detail: `buy ${qty} @ ${t.entry.averagePrice} → sell @ ${t.exit.averagePrice}`,
    })
  }

  // ─── 3. Retire the spent protective state ───
  const state = db.getServerExitState(C.serverPositionId)
  if (state?.active) {
    db.deactivateServerExitState(C.serverPositionId)
    steps.push({ step: 'deactivate-exit-state', status: 'done' })
  } else {
    steps.push({ step: 'deactivate-exit-state', status: 'skipped', detail: 'already inactive' })
  }
  db.deleteBracketPair(C.entrySignalId)

  // ─── 4. Tell the server the position is flat ───
  if (deps.reportVenueExit) {
    try {
      await deps.reportVenueExit(C.serverPositionId, {
        price: stop.averagePrice ?? null,
        timeMs: stop.filledAtMs ?? Date.now(),
        orderId: C.stopOrderId,
      })
      steps.push({ step: 'report-server-flat', status: 'done' })
    } catch (err: any) {
      steps.push({ step: 'report-server-flat', status: 'error', detail: err?.message })
    }
  } else {
    steps.push({ step: 'report-server-flat', status: 'skipped', detail: 'no report hook wired' })
  }

  const ok = steps.every((s) => s.status !== 'error')
  db.log(ok ? 'info' : 'error', 'trading', 'MGC 2026-09-01 book repair ran', { steps })
  return { ok, steps }
}

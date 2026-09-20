// One-shot book repair for the 2026-09-03 MNQU26 virtualClose incident.
//
// What happened: the Ascender MNQ 6m short (signal 41e292e1, entry sell 1 @
// 29142) was exited at 12:00 UTC by the tf-ladder lead-trail — but the server
// wired that exit as a plain BUY with metadata {virtualClose:true, positionId}
// (signal e9aba6ba). The executor had no virtualClose handling and ran it
// through the ENTRY path: the buy fill @ 29108.5 (order 1304546684) landed as
// a phantom LONG execution, the short stayed open in the book, and its GTC
// buy-stop (order 1304545343) kept resting on a flat account until it was
// cancelled by hand.
//
// What this repairs, idempotently:
//  1. The venue fill of order 1304546684 is RE-ASSIGNED from the phantom's
//     entry to the short's exit (one ledger row per venue fill — timestamp and
//     price stay the broker's own), and execution 41e292e1 goes 'closed'.
//  2. The phantom execution e9aba6ba is voided: status 'error', qty_opened 0
//     ("never held a position"), reason on the row for the audit trail.
//  3. The short's spent protective state retires (server_exit_state row still
//     active with the cancelled stop id, bracket pair).
//  4. The server is told position 86531dd0 is flat (best-effort — the
//     virtualClose ack likely closed the row already; a duplicate report is a
//     server-side no-op).
//
// Safety gates before any write: order 1304546684 must be venue-confirmed
// FILLED, and the old buy-stop 1304545343 must be venue-confirmed terminal
// (cancelled) — repairing the book while a live stop still rests would recreate
// exactly the incident this fixes.

import type { KaiBotDatabase } from '../storage/database.js'
import type { OrderStatus } from './exchanges/types.js'

export const VIRTUALCLOSE_REPAIR_20260903 = {
  exchange: 'tradestation',
  accountId: '21084933',
  symbol: 'MNQU26',
  shortEntrySignalId: '41e292e1-3fa4-4cce-ba87-4dc8932180b2',
  phantomSignalId: 'e9aba6ba-30f5-469f-820e-459cc1109a3c',
  serverPositionId: '86531dd0-c8e0-42be-acdf-47e6c1cdc2b7',
  /** The buy that flattened the short at the venue (12:00:19 UTC, ~29108.5). */
  exitOrderId: '1304546684',
  /** The short's GTC buy-stop, cancelled by hand on 2026-09-03. */
  cancelledStopOrderId: '1304545343',
} as const

export interface VirtualCloseRepairAdapter {
  getOrderStatus?: (
    orderId: string,
    ctx?: { accountId?: string; symbol?: string },
  ) => Promise<OrderStatus>
}

export interface VirtualCloseRepairDeps {
  reportVenueExit?: (
    positionId: string,
    fill: { price: number | null; timeMs: number; orderId?: string | null },
  ) => Promise<void>
}

export interface VirtualCloseRepairStep {
  step: string
  status: 'done' | 'skipped' | 'error'
  detail?: string
}

export interface VirtualCloseRepairReport {
  ok: boolean
  steps: VirtualCloseRepairStep[]
}

export async function repairVirtualClose20260903(
  db: KaiBotDatabase,
  adapter: VirtualCloseRepairAdapter,
  deps: VirtualCloseRepairDeps = {},
): Promise<VirtualCloseRepairReport> {
  const C = VIRTUALCLOSE_REPAIR_20260903
  const steps: VirtualCloseRepairStep[] = []
  const ctx = { accountId: C.accountId, symbol: C.symbol }

  // ─── Verify the venue's account before any write ───
  if (!adapter.getOrderStatus) {
    return { ok: false, steps: [{ step: 'verify-orders', status: 'error', detail: 'adapter has no getOrderStatus' }] }
  }
  let exitFill: OrderStatus
  try {
    exitFill = await adapter.getOrderStatus(C.exitOrderId, ctx)
    if (exitFill.state !== 'filled' || !(exitFill.averagePrice && exitFill.averagePrice > 0)) {
      throw new Error(`order ${C.exitOrderId} is '${exitFill.state}', expected a priced fill`)
    }
    const stop = await adapter.getOrderStatus(C.cancelledStopOrderId, ctx)
    if (stop.state === 'working' || stop.state === 'filled' || stop.state === 'partially_filled') {
      throw new Error(
        `buy-stop ${C.cancelledStopOrderId} is '${stop.state}' — cancel it first, the book repair must not run under a live or filled stop`,
      )
    }
  } catch (err: any) {
    return { ok: false, steps: [{ step: 'verify-orders', status: 'error', detail: err?.message }] }
  }
  steps.push({
    step: 'verify-orders',
    status: 'done',
    detail: `exit ${C.exitOrderId} filled @ ${exitFill.averagePrice}; stop ${C.cancelledStopOrderId} terminal`,
  })

  // ─── 1. Re-assign the venue fill: phantom entry → short exit ───
  const fillRow = db.get(
    'SELECT signal_id, kind FROM signal_fills WHERE order_id = ? LIMIT 1',
    [C.exitOrderId],
  ) as { signal_id: string; kind: string } | undefined
  if (!fillRow) {
    steps.push({ step: 'reassign-fill', status: 'error', detail: `no ledger fill for order ${C.exitOrderId}` })
    return { ok: false, steps }
  }
  if (fillRow.signal_id === C.shortEntrySignalId && fillRow.kind === 'exit') {
    steps.push({ step: 'reassign-fill', status: 'skipped', detail: 'already the short\'s exit' })
  } else if (fillRow.signal_id === C.phantomSignalId && fillRow.kind === 'entry') {
    db.run("UPDATE signal_fills SET signal_id = ?, kind = 'exit' WHERE order_id = ?", [
      C.shortEntrySignalId,
      C.exitOrderId,
    ])
    steps.push({ step: 'reassign-fill', status: 'done', detail: `entry fill of ${C.phantomSignalId.slice(0, 8)} → exit of ${C.shortEntrySignalId.slice(0, 8)}` })
  } else {
    steps.push({
      step: 'reassign-fill',
      status: 'error',
      detail: `unexpected ledger state: fill belongs to ${fillRow.signal_id} as ${fillRow.kind}`,
    })
    return { ok: false, steps }
  }

  // ─── 2. Close the short, void the phantom ───
  const short = db.getSignalExecution(C.shortEntrySignalId)
  if (!short) {
    steps.push({ step: 'close-short', status: 'error', detail: 'short execution not found' })
    return { ok: false, steps }
  }
  if (short.status === 'closed') {
    steps.push({ step: 'close-short', status: 'skipped', detail: 'already closed' })
  } else {
    db.insertOrderSettlement({
      signalId: C.shortEntrySignalId,
      exchange: C.exchange,
      accountId: C.accountId,
      symbol: C.symbol,
      kind: 'exit',
      side: 'buy',
      qty: short.qty_opened - short.qty_closed,
      orderId: C.exitOrderId,
      targetLabel: `venue-exit:${C.exitOrderId}`,
      status: 'filled',
    })
    db.updateSignalExecution(C.shortEntrySignalId, {
      status: 'closed',
      qtyClosed: short.qty_opened,
      qtyPendingClose: null,
    })
    db.markEntrySignalClosed(C.shortEntrySignalId, 'closed by virtualClose exit (repair 2026-09-03)')
    steps.push({ step: 'close-short', status: 'done', detail: `exit @ ${exitFill.averagePrice} (order ${C.exitOrderId})` })
  }

  const phantom = db.getSignalExecution(C.phantomSignalId)
  if (!phantom) {
    steps.push({ step: 'void-phantom', status: 'skipped', detail: 'no phantom execution' })
  } else if (phantom.status === 'error') {
    steps.push({ step: 'void-phantom', status: 'skipped', detail: 'already voided' })
  } else {
    db.updateSignalExecution(C.phantomSignalId, {
      status: 'error',
      qtyOpened: 0,
      qtyClosed: 0,
      errorReason: 'voided: virtualClose exit was booked as an entry (repair 2026-09-03)',
    })
    steps.push({ step: 'void-phantom', status: 'done' })
  }

  // ─── 3. Retire the spent protective state ───
  const state = db.getServerExitState(C.serverPositionId)
  if (state?.active) {
    db.deactivateServerExitState(C.serverPositionId)
    steps.push({ step: 'deactivate-exit-state', status: 'done' })
  } else {
    steps.push({ step: 'deactivate-exit-state', status: 'skipped', detail: 'already inactive' })
  }
  db.deleteBracketPair(C.shortEntrySignalId)

  // ─── 4. Tell the server the position is flat (idempotent no-op if the
  //        virtualClose ack already closed the row) ───
  if (deps.reportVenueExit) {
    try {
      await deps.reportVenueExit(C.serverPositionId, {
        price: exitFill.averagePrice ?? null,
        timeMs: exitFill.filledAtMs ?? Date.now(),
        orderId: C.exitOrderId,
      })
      steps.push({ step: 'report-server-flat', status: 'done' })
    } catch (err: any) {
      steps.push({ step: 'report-server-flat', status: 'error', detail: err?.message })
    }
  } else {
    steps.push({ step: 'report-server-flat', status: 'skipped', detail: 'no report hook wired' })
  }

  const ok = steps.every((s) => s.status !== 'error')
  db.log(ok ? 'info' : 'error', 'trading', 'MNQ 2026-09-03 virtualClose book repair ran', { steps })
  return { ok, steps }
}

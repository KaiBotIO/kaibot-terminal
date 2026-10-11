// One-shot repair for the 2026-10-06 17:15 UTC daily-loss PANIC.
//
// The guardrail tripped on a wrong number (inverse perp priced as linear) and
// PANIC flattened everything without booking it:
//  - the two Deribit rides stayed open locally with no exit fill (the reconciler
//    reports "expected N, broker holds 0" and never auto-corrects Deribit);
//  - the MES execution was closed by the reconciler with an exit fill without
//    a price (fill 76);
//  - none of the three server position rows heard about the exit.
// This books the exits with the venue's own fill price (fallback: the price in
// the incident log, flagged priceEstimate) and reports them upstream.
//
// Idempotent: the local part checks the book before writing; a server report
// leaves a repair log row only on a confirmed 2xx. dryRun (default) only looks
// up and reports what it would do.

import type { KaiBotDatabase } from '../storage/database.js'
import type { ExchangeManager } from './exchanges/exchangeManager.js'
import type { OrderStatus } from './exchanges/types.js'
import { accountKeyOf } from './exchanges/account-scope.js'
import { wireIdOf } from './fanout.js'

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

type RepairPosition = {
  positionId: string
  exchange: string
  symbol: string
  orderId: string
  fallbackPrice: number
} & (
  | { kind: 'open-execution'; executionId: string }
  | { kind: 'priceless-fill'; executionId: string; fillId: number }
)

export const PANIC_CLOSE_REPAIR_20261006: { incidentAtMs: number; positions: RepairPosition[] } = {
  incidentAtMs: Date.UTC(2026, 9, 6, 17, 15, 14),
  positions: [
    {
      positionId: 'd2a0b92f-cd64-43b9-b57c-a4e7262c9386',
      exchange: 'deribit',
      symbol: 'BTC-PERPETUAL',
      orderId: '177430997094',
      fallbackPrice: 85555,
      kind: 'open-execution',
      executionId: 'handover:d2a0b92f-cd64-43b9-b57c-a4e7262c9386',
    },
    {
      positionId: 'f96c9559-9bc4-478c-9f30-0f9ca54fb146',
      exchange: 'deribit',
      symbol: 'ETH-PERPETUAL',
      orderId: 'ETH-137821297618',
      fallbackPrice: 2695.85,
      kind: 'open-execution',
      executionId: 'handover:f96c9559-9bc4-478c-9f30-0f9ca54fb146',
    },
    {
      positionId: 'bcdfcafb-6739-4a7e-a572-50de6bae9e39',
      exchange: 'tradestation',
      symbol: 'MES',
      orderId: '1319225338',
      fallbackPrice: 7877,
      kind: 'priceless-fill',
      executionId: '5eea400b-3665-4a00-8dae-c22ee852ede7',
      fillId: 76,
    },
  ],
}

const DONE_MESSAGE = 'Repair panic-close-20261006: exit reported'

export interface PanicCloseRepairDeps {
  reportVenueExit?: (
    positionId: string,
    fill: { price: number | null; timeMs: number; orderId?: string | null },
  ) => Promise<{ sent: boolean; reason?: string } | void>
}

export interface PanicCloseRepairItem {
  positionId: string
  exchange: string
  orderId: string
  price: number
  priceEstimate: boolean
  timeMs: number
  priceDetail?: string
  local: { status: 'booked' | 'would-book' | 'skipped' | 'error'; detail?: string }
  server: { status: 'reported' | 'would-report' | 'skipped' | 'error'; detail?: string }
  /** Other active states of the same server position (fan-out). Non-empty blocks the report. */
  familyStates: Array<{ positionId: string; entrySignalId: string; active: boolean }>
}

export interface PanicCloseRepairReport {
  ok: boolean
  dryRun: boolean
  items: PanicCloseRepairItem[]
}

function alreadyReported(db: KaiBotDatabase, positionId: string): boolean {
  const row = db.get(`SELECT 1 AS hit FROM logs WHERE category = 'repair' AND message = ? AND metadata LIKE ? LIMIT 1`, [
    DONE_MESSAGE,
    `%"positionId":"${positionId}"%`,
  ])
  return !!row
}

interface VenueFill {
  price: number
  priceEstimate: boolean
  timeMs: number
  commission?: number
  feeNative?: number
  feeCurrency?: string
  detail?: string
}

async function venueFillOf(
  exchangeManager: Pick<ExchangeManager, 'getSession'>,
  p: RepairPosition,
  accountId: string | undefined,
  symbol: string,
  incidentAtMs: number,
): Promise<VenueFill> {
  const fallback = (detail: string): VenueFill => ({ price: p.fallbackPrice, priceEstimate: true, timeMs: incidentAtMs, detail })
  try {
    const session = await exchangeManager.getSession('default', p.exchange, accountKeyOf(accountId))
    const adapter = session?.status === 'connected' ? session.adapter : undefined
    if (!adapter?.getOrderStatus) return fallback(`${p.exchange} not connected`)
    const st: OrderStatus = await adapter.getOrderStatus(p.orderId, { accountId, symbol, sinceMs: incidentAtMs - 3_600_000 })
    if ((st.state === 'filled' || st.state === 'partially_filled') && st.averagePrice && st.averagePrice > 0) {
      return {
        price: st.averagePrice,
        priceEstimate: false,
        timeMs: st.filledAtMs ?? incidentAtMs,
        commission: st.commission,
        feeNative: st.feeNative,
        feeCurrency: st.feeCurrency,
      }
    }
    return fallback(`venue state ${st.state}, no fill price`)
  } catch (err) {
    return fallback(`venue lookup failed: ${errMsg(err)}`)
  }
}

// What the local book needs, or why it needs nothing / can't be touched.
function localPlan(db: KaiBotDatabase, p: RepairPosition): { todo: boolean; detail: string } {
  const exec = db.getSignalExecution(p.executionId)
  if (!exec) return { todo: false, detail: `execution ${p.executionId} not found` }
  if (p.kind === 'open-execution') {
    if (exec.status === 'closed') return { todo: false, detail: 'execution already closed' }
    if (exec.status !== 'open' && exec.status !== 'closing') return { todo: false, detail: `execution status ${exec.status}` }
    const open = exec.qty_opened - exec.qty_closed
    if (!(open > 0)) return { todo: false, detail: 'nothing open on the execution' }
    return { todo: true, detail: `exit fill ${open} + close execution` }
  }
  const fill = db.get('SELECT * FROM signal_fills WHERE id = ?', [p.fillId]) as
    | { signal_id: string; kind: string; price: number | null }
    | undefined
  if (!fill || fill.signal_id !== p.executionId || fill.kind !== 'exit') {
    return { todo: false, detail: `fill ${p.fillId} is not the exit of ${p.executionId}` }
  }
  if (fill.price != null) return { todo: false, detail: 'fill already priced' }
  return { todo: true, detail: `price fill ${p.fillId}` }
}

function bookLocal(db: KaiBotDatabase, p: RepairPosition, vf: VenueFill): void {
  const exec = db.getSignalExecution(p.executionId)!
  if (p.kind === 'open-execution') {
    const qty = exec.qty_opened - exec.qty_closed
    db.insertSignalFill({
      signalId: exec.signal_id,
      kind: 'exit',
      symbol: exec.symbol,
      side: exec.direction === 'long' ? 'sell' : 'buy',
      qty,
      price: vf.price,
      commission: vf.commission ?? 0,
      feeNative: vf.feeNative ?? null,
      feeCurrency: vf.feeCurrency ?? null,
      orderId: p.orderId,
      createdAtMs: vf.timeMs,
    })
    db.updateSignalExecution(exec.signal_id, { status: 'closed', qtyClosed: exec.qty_opened, qtyPendingClose: null })
    db.markEntrySignalClosed(exec.signal_id, 'closed by PANIC (repair 2026-10-06)')
    // Venue stops were already cancelled: the rows only.
    db.deleteBracketPair(exec.signal_id)
    db.deactivateLocalTrail(exec.signal_id)
  } else {
    db.run('UPDATE signal_fills SET price = ? WHERE id = ? AND price IS NULL', [vf.price, p.fillId])
  }
  db.log('warn', 'repair', 'Repair panic-close-20261006: local book fixed', {
    positionId: p.positionId,
    executionId: p.executionId,
    price: vf.price,
    priceEstimate: vf.priceEstimate,
  })
}

export async function repairPanicClose20261006(
  db: KaiBotDatabase,
  exchangeManager: Pick<ExchangeManager, 'getSession'>,
  deps: PanicCloseRepairDeps,
  opts: { dryRun: boolean },
): Promise<PanicCloseRepairReport> {
  const C = PANIC_CLOSE_REPAIR_20261006
  const items: PanicCloseRepairItem[] = []

  for (const p of C.positions) {
    const exec = db.getSignalExecution(p.executionId)
    const accountId = exec?.account_id ?? undefined
    const symbol = exec?.symbol ?? p.symbol
    const vf = await venueFillOf(exchangeManager, p, accountId, symbol, C.incidentAtMs)
    const familyStates = db
      .listServerExitStatesForFamily(wireIdOf(p.positionId))
      .filter((st) => st.position_id !== p.positionId)
      .map((st) => ({ positionId: st.position_id, entrySignalId: st.entry_signal_id, active: !!st.active }))

    const item: PanicCloseRepairItem = {
      positionId: p.positionId,
      exchange: p.exchange,
      orderId: p.orderId,
      price: vf.price,
      priceEstimate: vf.priceEstimate,
      timeMs: vf.timeMs,
      priceDetail: vf.detail,
      local: { status: 'skipped' },
      server: { status: 'skipped' },
      familyStates,
    }
    items.push(item)

    // ─── Local book ───
    const plan = localPlan(db, p)
    if (!plan.todo) item.local = { status: 'skipped', detail: plan.detail }
    else if (opts.dryRun) item.local = { status: 'would-book', detail: plan.detail }
    else {
      try {
        bookLocal(db, p, vf)
        item.local = { status: 'booked', detail: plan.detail }
      } catch (err) {
        db.log('error', 'repair', 'Repair panic-close-20261006: local book failed', { positionId: p.positionId, error: errMsg(err) })
        item.local = { status: 'error', detail: errMsg(err) }
      }
    }

    // ─── Server report ───
    if (alreadyReported(db, p.positionId)) {
      item.server = { status: 'skipped', detail: 'already reported' }
      continue
    }
    if (opts.dryRun) {
      item.server = { status: 'would-report' }
      continue
    }
    if (!deps.reportVenueExit) {
      item.server = { status: 'error', detail: 'no server reporter wired' }
      continue
    }
    try {
      const res = await deps.reportVenueExit(p.positionId, { price: vf.price, timeMs: vf.timeMs, orderId: p.orderId })
      if (!res || !res.sent) {
        item.server = { status: 'error', detail: res?.reason ?? 'reporter gave no confirmation' }
        continue
      }
      // Retired only once the server confirmed, so a failed report stays visible.
      if (db.getServerExitState(p.positionId)?.active) db.deactivateServerExitState(p.positionId)
      db.log('warn', 'repair', DONE_MESSAGE, {
        positionId: p.positionId,
        orderId: p.orderId,
        price: vf.price,
        priceEstimate: vf.priceEstimate,
        timeMs: vf.timeMs,
      })
      item.server = { status: 'reported' }
    } catch (err) {
      db.log('error', 'repair', 'Repair panic-close-20261006: report failed', { positionId: p.positionId, error: errMsg(err) })
      item.server = { status: 'error', detail: errMsg(err) }
    }
  }

  const ok = items.every((i) => i.local.status !== 'error' && i.server.status !== 'error')
  return { ok, dryRun: opts.dryRun, items }
}

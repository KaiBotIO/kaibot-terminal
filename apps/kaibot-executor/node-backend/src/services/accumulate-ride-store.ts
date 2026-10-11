// Persistence for accumulate plans (migration 043). Plain SQL on the shared
// database handle; the service owns all the logic.

import type { KaiBotDatabase } from '../storage/database.js'
import {
  DEFAULT_ACCUMULATE_PARAMS,
  type AccumulateAction,
  type AccumulateParams,
  type AccumulatePhase,
  type Direction,
  type PlanCore,
} from './accumulate-ride.js'

export interface AccumulatePlanRow {
  id: string
  exchange: string
  account_id: string
  symbol: string
  direction: Direction
  ride_bot_id: string
  params: string
  phase: AccumulatePhase
  reference: number
  entry_bar_time: number
  local_level: number | null
  last_evaluated_bar: number | null
  ladder_seq: number
  basis_usd: number | null
  ride_position_id: string | null
  ride_entry_signal_id: string | null
  stop_sized_qty: number | null
  pending: string | null
  last_note: string | null
  last_error: string | null
  last_breakout: string | null
  created_at: number
  updated_at: number
}

export interface AccumulateRungRow {
  order_id: string
  plan_id: string
  ladder_seq: number
  idx: number
  price: number
  qty: number
  state: 'open' | 'filled' | 'cancelled'
  filled_qty: number
  adopted: number
  created_at: number
  updated_at: number
}

// A decision in flight: the actions still to run and the state to commit once
// they all succeeded. `done` counts the actions already completed.
export interface PendingDecision {
  actions: AccumulateAction[]
  done: number
  next: PlanCore
  note: string
  breakout?: { barTime: number; close: number; level: number }
}

export function planParams(row: AccumulatePlanRow): AccumulateParams {
  try {
    return { ...DEFAULT_ACCUMULATE_PARAMS, ...(JSON.parse(row.params) as Partial<AccumulateParams>) }
  } catch {
    return { ...DEFAULT_ACCUMULATE_PARAMS }
  }
}

export function planCore(row: AccumulatePlanRow): PlanCore {
  return {
    phase: row.phase,
    direction: row.direction,
    reference: row.reference,
    entryBarTime: row.entry_bar_time,
    localLevel: row.local_level,
    lastEvaluatedBar: row.last_evaluated_bar,
  }
}

export function pendingOf(row: AccumulatePlanRow): PendingDecision | null {
  if (!row.pending) return null
  try {
    return JSON.parse(row.pending) as PendingDecision
  } catch {
    return null
  }
}

export function createAccumulateStore(db: KaiBotDatabase) {
  function get(id: string): AccumulatePlanRow | null {
    return (db.get('SELECT * FROM accumulate_plans WHERE id = ?', [id]) as AccumulatePlanRow | undefined) ?? null
  }

  function list(includeStopped = false): AccumulatePlanRow[] {
    return db.all(
      `SELECT * FROM accumulate_plans ${includeStopped ? '' : "WHERE phase != 'stopped'"} ORDER BY created_at DESC`,
    ) as AccumulatePlanRow[]
  }

  function activeFor(exchange: string, accountId: string, symbol: string): AccumulatePlanRow | null {
    return (
      (db.get(
        "SELECT * FROM accumulate_plans WHERE exchange = ? AND account_id = ? AND UPPER(symbol) = UPPER(?) AND phase != 'stopped'",
        [exchange, accountId, symbol],
      ) as AccumulatePlanRow | undefined) ?? null
    )
  }

  function insert(row: Omit<AccumulatePlanRow, 'created_at' | 'updated_at'>): void {
    const now = Date.now()
    db.run(
      `INSERT INTO accumulate_plans (id, exchange, account_id, symbol, direction, ride_bot_id, params, phase,
         reference, entry_bar_time, local_level, last_evaluated_bar, ladder_seq, basis_usd, ride_position_id,
         ride_entry_signal_id, stop_sized_qty, pending, last_note, last_error, last_breakout, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id, row.exchange, row.account_id, row.symbol, row.direction, row.ride_bot_id, row.params, row.phase,
        row.reference, row.entry_bar_time, row.local_level, row.last_evaluated_bar, row.ladder_seq, row.basis_usd,
        row.ride_position_id, row.ride_entry_signal_id, row.stop_sized_qty, row.pending, row.last_note,
        row.last_error, row.last_breakout, now, now,
      ],
    )
  }

  const PATCHABLE = new Set<keyof AccumulatePlanRow>([
    'phase', 'reference', 'entry_bar_time', 'local_level', 'last_evaluated_bar', 'ladder_seq', 'basis_usd',
    'ride_position_id', 'ride_entry_signal_id', 'stop_sized_qty', 'pending', 'last_note', 'last_error',
    'last_breakout', 'params',
  ])

  function update(id: string, patch: Partial<AccumulatePlanRow>): void {
    const keys = (Object.keys(patch) as Array<keyof AccumulatePlanRow>).filter((k) => PATCHABLE.has(k))
    if (keys.length === 0) return
    const sets = keys.map((k) => `${k} = ?`).join(', ')
    db.run(`UPDATE accumulate_plans SET ${sets}, updated_at = ? WHERE id = ?`, [
      ...keys.map((k) => (patch[k] === undefined ? null : patch[k])),
      Date.now(),
      id,
    ])
  }

  function setPending(id: string, pending: PendingDecision | null): void {
    update(id, { pending: pending ? JSON.stringify(pending) : null })
  }

  function rungs(planId: string, state?: AccumulateRungRow['state']): AccumulateRungRow[] {
    return (
      state
        ? db.all('SELECT * FROM accumulate_rungs WHERE plan_id = ? AND state = ? ORDER BY ladder_seq, idx', [planId, state])
        : db.all('SELECT * FROM accumulate_rungs WHERE plan_id = ? ORDER BY ladder_seq, idx', [planId])
    ) as AccumulateRungRow[]
  }

  function upsertRung(row: Omit<AccumulateRungRow, 'created_at' | 'updated_at'>): void {
    const now = Date.now()
    db.run(
      `INSERT INTO accumulate_rungs (order_id, plan_id, ladder_seq, idx, price, qty, state, filled_qty, adopted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(order_id) DO UPDATE SET state = excluded.state, filled_qty = excluded.filled_qty, updated_at = excluded.updated_at`,
      [row.order_id, row.plan_id, row.ladder_seq, row.idx, row.price, row.qty, row.state, row.filled_qty, row.adopted, now, now],
    )
  }

  function setRungState(orderId: string, state: AccumulateRungRow['state'], filledQty: number): void {
    db.run('UPDATE accumulate_rungs SET state = ?, filled_qty = ?, updated_at = ? WHERE order_id = ?', [
      state,
      filledQty,
      Date.now(),
      orderId,
    ])
  }

  return { get, list, activeFor, insert, update, setPending, rungs, upsertRung, setRungState }
}

export type AccumulateStore = ReturnType<typeof createAccumulateStore>

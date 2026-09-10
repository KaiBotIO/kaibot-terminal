// Local realized-P&L-since-00:00-UTC tracker for the daily-loss guardrail.
//
// The executor already records every fill (signal_fills, kind 'entry' | 'exit',
// with price + created_at epoch-ms). Realized P&L is computed per signal from
// those fills (computeSignalPnl). For the daily-loss rail we want realized P&L
// for closes that happened TODAY (UTC) — so we look at signals whose LAST exit
// fill landed at/after 00:00 UTC and sum their realized net.
//
// This runs locally off the executor's own audit data, so the daily-loss rail
// works with no cloud involvement (the whole point of an offline-proof safety
// rail). Pure math here (utcDayStartMs + realizedPnlSince) is unit tested; the DB
// wiring lives on the caller.

import type { SignalExecutionRow, SignalFillRow } from '../storage/types.js'
import { computeSignalPnl } from './pnl.js'

/** Epoch-ms of the most recent 00:00:00.000 UTC at or before `now`. */
export function utcDayStartMs(now: number = Date.now()): number {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

export interface DailyRealizedInput {
  // One execution row + that signal's fills. Only signals with at least one exit
  // fill at/after `sinceMs` contribute (a close that happened today).
  exec: Pick<SignalExecutionRow, 'symbol' | 'direction' | 'status'> & { exchange?: string | null }
  fills: SignalFillRow[]
}

/**
 * Sum realized net P&L over signals whose latest exit fill is at/after `sinceMs`.
 * A signal counts wholly toward `sinceMs`'s day when its closing happened that
 * day — partial closes spanning midnight are attributed by their last exit fill,
 * which is a deliberate simplicity choice (the rail is a coarse daily safety
 * stop, not tax accounting). Signals with no exit fill at/after `sinceMs` are
 * skipped entirely.
 */
export function realizedPnlSince(inputs: readonly DailyRealizedInput[], sinceMs: number): number {
  let total = 0
  for (const { exec, fills } of inputs) {
    const exitFills = fills.filter((f) => f.kind === 'exit')
    if (exitFills.length === 0) continue
    const lastExitAt = Math.max(...exitFills.map((f) => f.created_at))
    if (lastExitAt < sinceMs) continue
    total += computeSignalPnl(exec, fills).realizedNet
  }
  return total
}

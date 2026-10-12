// Market-closed entries wait for the next session (2026-09-19).
//
// The market guard used to reject a market entry outright when the venue was
// not trading. A 1D bot on CME futures fires on the 21:00 UTC daily close,
// which is exactly the Globex maintenance pause (21:00-22:00 UTC), so such a
// bot never got a live entry. A guardrail must never hinder a strategy: the
// entry is parked instead and resumed through the normal entry path once the
// venue trades again. Pure decision helpers live here; the executor wiring
// (persistence, poller, cancellation) sits in signal-client.

import type { DeferredEntryRow } from '../storage/database.js'
import { inFanoutFamily } from './fanout.js'

export const DEFAULT_DEFER_MAX_WAIT_MS = 3 * 60 * 60 * 1000
export const DEFAULT_DEFER_POLL_MS = 30_000

// Globex weekly close: Friday 21:00 UTC → Sunday 22:00 UTC (CME equity-index
// and metals futures). An entry parked inside that gap would wait far past the
// default limit, so it is dropped with a clear reason unless the operator
// opted in to holding entries over the weekend.
const WEEKEND_CLOSE_DOW = 5 // Friday
const WEEKEND_CLOSE_HOUR_UTC = 21
const WEEKEND_OPEN_DOW = 0 // Sunday
const WEEKEND_OPEN_HOUR_UTC = 22

export interface DeferConfig {
  maxWaitMs: number
  pollMs: number
  deferOverWeekend: boolean
}

export function resolveDeferConfig(env: NodeJS.ProcessEnv = process.env): DeferConfig {
  const maxWait = Number(env.DEFER_MAX_WAIT_MS)
  const poll = Number(env.DEFER_POLL_MS)
  return {
    maxWaitMs: Number.isFinite(maxWait) && maxWait > 0 ? maxWait : DEFAULT_DEFER_MAX_WAIT_MS,
    pollMs: Number.isFinite(poll) && poll > 0 ? poll : DEFAULT_DEFER_POLL_MS,
    deferOverWeekend: env.DEFER_OVER_WEEKEND === '1',
  }
}

export function isWeekendGap(nowMs: number): boolean {
  const d = new Date(nowMs)
  const dow = d.getUTCDay()
  const hour = d.getUTCHours()
  if (dow === WEEKEND_CLOSE_DOW) return hour >= WEEKEND_CLOSE_HOUR_UTC
  if (dow === 6) return true
  if (dow === WEEKEND_OPEN_DOW) return hour < WEEKEND_OPEN_HOUR_UTC
  return false
}

// Next Sunday 22:00 UTC at or after nowMs.
export function nextWeekendOpenMs(nowMs: number): number {
  const d = new Date(nowMs)
  const daysToSunday = (7 - d.getUTCDay()) % 7
  const open = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() + daysToSunday,
    WEEKEND_OPEN_HOUR_UTC,
  )
  return open >= nowMs ? open : open + 7 * 24 * 60 * 60 * 1000
}

// "18/09 00:03 UTC": what the activity feed shows next to a parked entry.
export function fmtUtc(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`
}

export type DeferPlan =
  | { kind: 'defer'; deadlineMs: number; reason: string }
  | { kind: 'drop'; reason: string }

export function planDeferral(params: {
  nowMs: number
  maxWaitMs: number
  deferOverWeekend: boolean
}): DeferPlan {
  const { nowMs, maxWaitMs, deferOverWeekend } = params
  if (isWeekendGap(nowMs)) {
    if (!deferOverWeekend) {
      return {
        kind: 'drop',
        reason: 'market closed for the weekend; entry dropped (DEFER_OVER_WEEKEND=1 holds it until Sunday)',
      }
    }
    const deadlineMs = nextWeekendOpenMs(nowMs) + maxWaitMs
    return {
      kind: 'defer',
      deadlineMs,
      reason: `deferred: market closed for the weekend, holding until ${fmtUtc(deadlineMs)}`,
    }
  }
  const deadlineMs = nowMs + maxWaitMs
  return {
    kind: 'defer',
    deadlineMs,
    reason: `deferred: market closed, waiting for the next session until ${fmtUtc(deadlineMs)}`,
  }
}

export interface LineageProbe {
  canonicalSymbol: string
  signalBotId?: string
  subscriptionId?: string
  positionId?: string
  entrySignalId?: string
}

// Which waiting entries a close / cancel retires. An explicit target
// (entrySignalId, positionId) wins; otherwise the close's bot / subscription on
// the same market; an identity-less close flattens every waiting entry on the
// market, mirroring the legacy unscoped close.
export function matchesDeferredLineage(row: DeferredEntryRow, probe: LineageProbe): boolean {
  // An entry that fanned out over several subscriptions parked one row per
  // subscription under a derived id; the cancel names the wire id.
  if (probe.entrySignalId) return inFanoutFamily(row.signal_id, probe.entrySignalId)
  if (probe.positionId && row.position_id) return row.position_id === probe.positionId
  if (row.canonical_symbol.toLowerCase() !== probe.canonicalSymbol.toLowerCase()) return false
  const hasIdentity = !!probe.signalBotId || !!probe.subscriptionId
  if (!hasIdentity) return true
  return (
    (!!probe.signalBotId && row.signal_bot_id === probe.signalBotId) ||
    (!!probe.subscriptionId && row.subscription_id === probe.subscriptionId)
  )
}

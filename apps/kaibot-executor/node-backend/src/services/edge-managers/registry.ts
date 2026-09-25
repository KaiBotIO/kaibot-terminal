// Allowlist registry of the IP-free edge managers the executor may run on a
// MANUAL position (F2, pilot-ladder decomposition). Every entry mirrors an SDK
// reference manager verbatim (parity-locked per reducer); the params here are
// the user's OWN attach input — nothing tuned/protected is ever on this list.
//
// Composition order is canonical and fixed: stop movers first, the TP ladder
// after, the risk guard LAST (it also filters the composed action list). The
// attach surface assigns exec_order from this table; the runtime sorts by it.

import { breakEvenMoverManager, BREAK_EVEN_MOVER_DEFAULTS, type BreakEvenMoverParams } from './break-even-mover.js'
import { tpLadderManager, TP_LADDER_DEFAULTS, FIB_LEVELS, type TpLadderParams } from './tp-ladder.js'
import { riskGuardManager, type RiskGuardParams } from './risk-guard.js'
import { groupRiskGuardManager, type GroupRiskGuardParams } from './group-risk-guard.js'
import { drawdownTrailingStopManager, DRAWDOWN_TRAILING_STOP_DEFAULTS } from './drawdown-trailing-stop.js'
import type { EdgeManagerPlugin } from './contract.js'

export interface EdgeManagerDefinition {
  plugin: EdgeManagerPlugin<unknown>
  // Canonical composition slot. Lower runs earlier; risk-guard is highest.
  execOrder: number
  // Whether the attach surface (/api/trade/managers) exposes it. The drawdown
  // trail is runtime-supported (parity harness) but armed via /api/trade/manage
  // — the F1 trail row owns the venue stop (one stop owner per position).
  attachable: boolean
  // Whether the manager's reducer can emit set_stop_loss. Attaching one requires
  // a stop owner (F1 trail row) so the candidate has a dispatch channel. Kept on
  // the definition so this capability can never desync from the registry — the
  // edge-manager capability test derives it from each reducer and asserts it.
  emitsStop: boolean
  // Validate + normalize raw user params (applies the SDK schema defaults).
  // Throws with a human-readable message on invalid input. The result is the
  // manager's typed params object (opaque here — the plugin knows its shape).
  normalizeParams(raw: Record<string, unknown>): unknown
}

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function numField(
  raw: Record<string, unknown>,
  key: string,
  opts: { min?: number; max?: number; positive?: boolean },
): number | undefined {
  const v = raw[key]
  if (v == null) return undefined
  if (!isFiniteNum(v)) throw new Error(`${key} must be a finite number`)
  if (opts.positive && !(v > 0)) throw new Error(`${key} must be positive`)
  if (opts.min !== undefined && v < opts.min) throw new Error(`${key} must be >= ${opts.min}`)
  if (opts.max !== undefined && v > opts.max) throw new Error(`${key} must be <= ${opts.max}`)
  return v
}

function boolField(raw: Record<string, unknown>, key: string): boolean | undefined {
  const v = raw[key]
  if (v == null) return undefined
  if (typeof v !== 'boolean') throw new Error(`${key} must be a boolean`)
  return v
}

// Mirrors breakEvenMoverParamsSchema.
export function normalizeBreakEvenParams(raw: Record<string, unknown>): BreakEvenMoverParams {
  return {
    feePercentage: numField(raw, 'feePercentage', { min: 0, max: 1 }) ?? BREAK_EVEN_MOVER_DEFAULTS.feePercentage,
    triggerPercentage:
      numField(raw, 'triggerPercentage', { min: 0, max: 100 }) ?? BREAK_EVEN_MOVER_DEFAULTS.triggerPercentage,
    useEntryReference: boolField(raw, 'useEntryReference') ?? BREAK_EVEN_MOVER_DEFAULTS.useEntryReference,
    referencePrice: numField(raw, 'referencePrice', { min: 0 }) ?? BREAK_EVEN_MOVER_DEFAULTS.referencePrice,
  }
}

// Mirrors tpLadderParamsSchema (incl. the prices-or-target refinement).
export function normalizeTpLadderParams(raw: Record<string, unknown>): TpLadderParams {
  const pricesRaw = raw.prices
  let prices: number[] = []
  if (pricesRaw != null) {
    if (!Array.isArray(pricesRaw)) throw new Error('prices must be an array of positive numbers')
    for (const p of pricesRaw) {
      if (!isFiniteNum(p) || !(p > 0)) throw new Error('prices must be an array of positive numbers')
    }
    prices = [...(pricesRaw as number[])]
  }
  const target = numField(raw, 'target', { positive: true })
  const levelCount = numField(raw, 'levelCount', { min: 1, max: 6 }) ?? TP_LADDER_DEFAULTS.levelCount
  if (!Number.isInteger(levelCount)) throw new Error('levelCount must be an integer')
  const params: TpLadderParams = {
    prices,
    ...(target !== undefined ? { target } : {}),
    levelCount,
    fractionPerTranche:
      numField(raw, 'fractionPerTranche', { min: 0, max: 1 }) ?? TP_LADDER_DEFAULTS.fractionPerTranche,
    runnerFraction: numField(raw, 'runnerFraction', { min: 0, max: 1 }) ?? TP_LADDER_DEFAULTS.runnerFraction,
  }
  if (params.prices.length === 0 && params.target === undefined) {
    throw new Error('tp-ladder requires either explicit prices or a target to derive from')
  }
  return params
}

// Mirrors riskGuardParamsSchema (all optional; at least one must be set for the
// attach to mean anything).
export function normalizeRiskGuardParams(raw: Record<string, unknown>): RiskGuardParams {
  const params: RiskGuardParams = {}
  const maxSize = numField(raw, 'maxSize', { positive: true })
  const globalStopPrice = numField(raw, 'globalStopPrice', { positive: true })
  const releaseLockAfter = numField(raw, 'releaseLockAfter', { positive: true })
  if (maxSize !== undefined) params.maxSize = maxSize
  if (globalStopPrice !== undefined) params.globalStopPrice = globalStopPrice
  if (releaseLockAfter !== undefined) params.releaseLockAfter = releaseLockAfter
  if (maxSize === undefined && globalStopPrice === undefined && releaseLockAfter === undefined) {
    throw new Error('risk-guard needs at least one of maxSize, globalStopPrice, releaseLockAfter')
  }
  return params
}

// Mirrors groupRiskGuardParamsSchema (all optional; at least one threshold must
// be set for the attach to mean anything).
export function normalizeGroupRiskGuardParams(raw: Record<string, unknown>): GroupRiskGuardParams {
  const params: GroupRiskGuardParams = {}
  const maxGroupLossFraction = numField(raw, 'maxGroupLossFraction', { positive: true, max: 1 })
  const maxGroupNotional = numField(raw, 'maxGroupNotional', { positive: true })
  if (maxGroupLossFraction !== undefined) params.maxGroupLossFraction = maxGroupLossFraction
  if (maxGroupNotional !== undefined) params.maxGroupNotional = maxGroupNotional
  if (maxGroupLossFraction === undefined && maxGroupNotional === undefined) {
    throw new Error('group-risk-guard needs at least one of maxGroupLossFraction, maxGroupNotional')
  }
  return params
}

// Mirrors drawdownTrailingStopParamsSchema (runtime-only; not attachable here).
export function normalizeDrawdownParams(raw: Record<string, unknown>) {
  return {
    maxTrailingPercentage:
      numField(raw, 'maxTrailingPercentage', { min: 0, max: 100 }) ?? DRAWDOWN_TRAILING_STOP_DEFAULTS.maxTrailingPercentage,
    maxTrailingPoints: numField(raw, 'maxTrailingPoints', { min: 0 }) ?? DRAWDOWN_TRAILING_STOP_DEFAULTS.maxTrailingPoints,
    minTrailingPercentage:
      numField(raw, 'minTrailingPercentage', { min: 0, max: 100 }) ?? DRAWDOWN_TRAILING_STOP_DEFAULTS.minTrailingPercentage,
    minTrailingPoints: numField(raw, 'minTrailingPoints', { min: 0 }) ?? DRAWDOWN_TRAILING_STOP_DEFAULTS.minTrailingPoints,
    trailingLock: boolField(raw, 'trailingLock') ?? DRAWDOWN_TRAILING_STOP_DEFAULTS.trailingLock,
    onlyWhenProfit: boolField(raw, 'onlyWhenProfit') ?? DRAWDOWN_TRAILING_STOP_DEFAULTS.onlyWhenProfit,
    referencePrice: numField(raw, 'referencePrice', { min: 0 }) ?? DRAWDOWN_TRAILING_STOP_DEFAULTS.referencePrice,
    freezeExtreme: boolField(raw, 'freezeExtreme') ?? DRAWDOWN_TRAILING_STOP_DEFAULTS.freezeExtreme,
  }
}

export const EDGE_MANAGER_REGISTRY: Record<string, EdgeManagerDefinition> = {
  'drawdown-trailing-stop': {
    plugin: drawdownTrailingStopManager as EdgeManagerPlugin<unknown>,
    execOrder: 10,
    attachable: false,
    emitsStop: true,
    normalizeParams: normalizeDrawdownParams,
  },
  'break-even-mover': {
    plugin: breakEvenMoverManager as EdgeManagerPlugin<unknown>,
    execOrder: 20,
    attachable: true,
    emitsStop: true,
    normalizeParams: normalizeBreakEvenParams,
  },
  'tp-ladder': {
    plugin: tpLadderManager as EdgeManagerPlugin<unknown>,
    execOrder: 30,
    attachable: true,
    emitsStop: false,
    normalizeParams: normalizeTpLadderParams,
  },
  'risk-guard': {
    plugin: riskGuardManager as EdgeManagerPlugin<unknown>,
    execOrder: 100, // After all stop/TP movers: it filters the composed list.
    attachable: true,
    emitsStop: false,
    normalizeParams: normalizeRiskGuardParams,
  },
  'group-risk-guard': {
    plugin: groupRiskGuardManager as EdgeManagerPlugin<unknown>,
    execOrder: 110, // After the per-position risk-guard (group scope, G2).
    attachable: true,
    emitsStop: false,
    normalizeParams: normalizeGroupRiskGuardParams,
  },
}

export const ATTACHABLE_MANAGER_IDS = Object.entries(EDGE_MANAGER_REGISTRY)
  .filter(([, def]) => def.attachable)
  .map(([id]) => id)

// Managers whose reducer may emit set_stop_loss — attaching one requires a
// stop-owner (F1 trail row) so the candidate has a dispatch channel. Derived
// from the registry's emitsStop capability so the two can never desync.
export const STOP_EMITTING_MANAGER_IDS = new Set(
  Object.entries(EDGE_MANAGER_REGISTRY)
    .filter(([, def]) => def.emitsStop)
    .map(([id]) => id),
)

export { FIB_LEVELS }

// Pure edge-manager composition runtime: drive every attached reducer's onTick
// for ONE mark-price tick and compose the actions, mirroring the backtester's
// ManagerPipeline per-tick loop (packages/backtester/src/managers.ts runBar):
//
//   1. onTick per manager in composition order (a later manager sees the state
//      threaded from ITS previous tick; guards record wasLocked/wasCapReleased
//      BEFORE their own onTick, exactly like the pipeline);
//   2. every guard's filterActions runs over the COMPOSED list (risk-guard is
//      ordered last by the registry, so it governs the whole composition);
//   3. the edge sanitizer drops anything that is not protect/reduce-only —
//      set_stop_loss and close pass; scale_in / open_hedge / close_hedge /
//      close_all / set_tag are dropped (design rule §3: entries are authored,
//      never edge-decided; no hedge slots on the edge).
//
// Free of DB/adapter so composition ordering, guard filtering and the sanitize
// rule are unit-testable, and so the backtester parity harness can drive it.

import type {
  EdgeManagerPlugin,
  GroupAggregateState,
  ManagedPositionState,
  ManagerAction,
  ManagerRunnerState,
} from './contract.js'
import { EMPTY_MANAGER_STATE, isFavourableStop } from './contract.js'

export interface RuntimeManagerEntry {
  managerId: string
  plugin: EdgeManagerPlugin<unknown>
  params: unknown
  state: ManagerRunnerState
  execOrder: number
}

export interface ManagerTickResult {
  // Protect/reduce-only actions, guard-filtered, in emission order.
  actions: Array<Extract<ManagerAction, { type: 'set_stop_loss' } | { type: 'close' }>>
  // Actions dropped by the edge sanitizer (for logging/audit).
  dropped: ManagerAction[]
  // Next per-manager states, keyed by managerId.
  states: Map<string, ManagerRunnerState>
}

// Guard lock-state scratch keys the pipeline reads pre-onTick (mirrors
// packages/backtester/src/managers.ts:353-358).
const LOCKED_KEY = 'riskLocked'
const CAP_RELEASED_KEY = 'riskCapReleased'

export function runManagersTick(input: {
  position: ManagedPositionState
  managers: RuntimeManagerEntry[]
  price: number
  ts: number
  // Group aggregates for the position's groupId, frozen at cycle start (G2).
  group?: GroupAggregateState
}): ManagerTickResult {
  const ordered = [...input.managers].sort((a, b) => a.execOrder - b.execOrder)

  let composed: ManagerAction[] = []
  const states = new Map<string, ManagerRunnerState>()
  const wasLockedByGuard = new Map<string, boolean>()
  const wasCapReleasedByGuard = new Map<string, boolean>()

  for (const entry of ordered) {
    const state = entry.state ?? EMPTY_MANAGER_STATE
    if (entry.plugin.filterActions) {
      wasLockedByGuard.set(entry.managerId, state.scratch[LOCKED_KEY] === true)
      wasCapReleasedByGuard.set(entry.managerId, state.scratch[CAP_RELEASED_KEY] === true)
    }
    const res = entry.plugin.onTick({
      params: entry.params,
      position: input.position,
      price: input.price,
      ts: input.ts,
      ...(input.group ? { group: input.group } : {}),
      state,
    })
    states.set(entry.managerId, res.state)
    composed = composed.concat(res.actions)
  }

  // Guard filters over the composed list (same wiring as the pipeline: every
  // guard sees the flags recorded before its own onTick ran).
  for (const entry of ordered) {
    if (!entry.plugin.filterActions) continue
    composed = entry.plugin.filterActions({
      params: entry.params,
      position: input.position,
      price: input.price,
      wasLocked: wasLockedByGuard.get(entry.managerId) ?? false,
      wasCapReleased: wasCapReleasedByGuard.get(entry.managerId) ?? false,
      actions: composed,
    })
  }

  // Edge sanitize: protect/reduce-only.
  const actions: ManagerTickResult['actions'] = []
  const dropped: ManagerAction[] = []
  for (const action of composed) {
    if (action.type === 'set_stop_loss' || action.type === 'close') {
      actions.push(action)
    } else {
      dropped.push(action)
    }
  }
  return { actions, dropped, states }
}

// Fold the tick's set_stop_loss actions into ONE stop candidate: the most
// favourable emitted price that improves on the position's current stop.
// Mirrors the pipeline's per-action favourable clamp (managers.ts:461-471) —
// applying the actions in order with that clamp is equivalent to taking the
// directional best, so a single composed candidate feeds composeEffectiveStop
// (the ONE stop-composition regelset) without a second rule.
export function foldStopCandidate(
  position: Pick<ManagedPositionState, 'direction' | 'currentStopLoss'>,
  actions: Array<Extract<ManagerAction, { type: 'set_stop_loss' } | { type: 'close' }>>,
): number | null {
  let best: number | null = null
  for (const a of actions) {
    if (a.type !== 'set_stop_loss') continue
    if (!isFavourableStop(a.price, position.currentStopLoss, position.direction)) continue
    if (best === null || isFavourableStop(a.price, best, position.direction)) best = a.price
  }
  return best
}

// Sum the tick's close actions into a single fraction of the CURRENT remaining
// size, applying them sequentially exactly like the pipeline's slotReduce loop:
// each fraction reduces what remains, so the combined fraction is
// 1 - Π(1 - fᵢ), clamped to [0, 1]. 1 = full close.
export function foldCloseFraction(
  actions: Array<Extract<ManagerAction, { type: 'set_stop_loss' } | { type: 'close' }>>,
): { fraction: number; reasons: string[] } {
  let remaining = 1
  const reasons: string[] = []
  for (const a of actions) {
    if (a.type !== 'close') continue
    const f = Math.max(0, Math.min(1, a.fraction))
    if (f <= 0) continue
    remaining *= 1 - f
    if (a.reason) reasons.push(a.reason)
  }
  const fraction = Math.min(1, Math.max(0, 1 - remaining))
  // Guard against float dust on a nominal full close.
  return { fraction: fraction > 1 - 1e-9 ? 1 : fraction, reasons }
}

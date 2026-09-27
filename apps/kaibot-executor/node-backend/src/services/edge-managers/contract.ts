// Edge expression of the shared manager contract. The types, helpers and
// reducer cores live in @kaibot/types/manager-core — the SINGLE source shared
// with the SDK reference managers (packages/strategy-sdk/src/managers/*), so
// the two runtimes cannot drift. @kaibot/types ships with this standalone
// user-shipped package (carve-out INV10 allows it; the proprietary engine
// packages stay server-side). Parity of the wrapper plumbing is still locked
// by the per-reducer parity tests.
//
// Managers ("sub-strategies") never open positions: they receive an already-open
// position and may move its stop or reduce/close it. On this edge runtime the
// allowlist is protect/reduce-only by construction — entry-side actions
// (scale_in, open_hedge) are dropped by the runtime (see runtime.ts).

import type { ManagerCoreState } from '@kaibot/types/manager-core'
import type {
  GroupAggregateState,
  ManagedPositionState,
  ManagerAction,
} from '@kaibot/types/manager-core'

export {
  advanceManagedPosition,
  EMPTY_MANAGER_CORE_STATE as EMPTY_MANAGER_STATE,
  isFavourableStop,
  isPointBasedExchange,
} from '@kaibot/types/manager-core'
export type {
  GroupAggregateState,
  ManagedPositionState,
  ManagerAction,
  ManagerDirection,
} from '@kaibot/types/manager-core'

// The per-manager runner state (structural equivalent of the SDK's
// RunnerState; JSON-serializable).
export type ManagerRunnerState = ManagerCoreState

// One edge manager: data + an onTick reducer, structurally identical to the
// SDK's ManagerPlugin (params pre-parsed — the executor validates at attach).
export interface EdgeManagerPlugin<P = unknown> {
  id: string
  init?(input: { params: P; position: ManagedPositionState }): ManagerRunnerState
  onTick(ctx: {
    params: P
    position: ManagedPositionState
    price: number
    ts: number
    group?: GroupAggregateState
    state: ManagerRunnerState
  }): { actions: ManagerAction[]; state: ManagerRunnerState }
  // Guard hook (risk-guard): filters the COMPOSED action list of all managers
  // for the tick. Mirrors the backtester ManagerPipeline's filterActions wiring.
  filterActions?(input: {
    params: P
    position: ManagedPositionState
    price: number
    wasLocked: boolean
    wasCapReleased?: boolean
    actions: ManagerAction[]
  }): ManagerAction[]
}

// Core: group risk-guard (G2, position-groups).
//
// Watches the AGGREGATE of all open positions sharing the tick position's
// groupId (ctx.group, computed by the caller — see GroupAggregateState). On
// breach it emits a full close for ITS OWN position; because the same manager
// runs in every group member's pipeline against the same frozen aggregates,
// every member closes — group-wide reaction from per-position actions.
//
// Breach conditions (either; loss checked first):
//   - maxGroupLossFraction: aggregate unrealized PnL <= -(fraction × equity).
//     Needs an equity basis; equity null/<=0 ⇒ the check cannot evaluate.
//   - maxGroupNotional: aggregate gross notional exceeds the cap.
//
// Defaults leave BOTH conditions off, and without ctx.group the guard is inert
// — attaching it with default params is byte-identical to not attaching it.
// Reduce/protect-only: it never scales in, never opens, never moves a stop.

import {
  EMPTY_MANAGER_CORE_STATE,
  type GroupAggregateState,
  type ManagerAction,
  type ManagerCoreState,
  type ManagerCoreTickInput,
  type ManagerCoreTickResult,
} from './contract.js';

export interface GroupRiskGuardParams {
  // Max aggregate unrealized LOSS as a fraction of equity (0.05 = 5%). Omit to
  // disable (default: guard off).
  maxGroupLossFraction?: number;
  // Max aggregate gross notional, in account currency. Omit to disable.
  maxGroupNotional?: number;
}

// Latch: the close is emitted once per breach episode, not every tick while
// the aggregates stay beyond the threshold. Resets when the breach clears.
const GROUP_CLOSED_KEY = 'groupGuardClosed';

// Which condition (if any) is breached for these aggregates. Pure.
export function evaluateGroupBreach(
  params: GroupRiskGuardParams,
  group: GroupAggregateState | undefined,
): 'group-loss' | 'group-notional' | null {
  if (!group || group.memberCount <= 0) return null;
  if (
    params.maxGroupLossFraction !== undefined &&
    group.equity !== null &&
    group.equity > 0 &&
    group.unrealizedPnl <= -(params.maxGroupLossFraction * group.equity)
  ) {
    return 'group-loss';
  }
  if (params.maxGroupNotional !== undefined && group.notional > params.maxGroupNotional) {
    return 'group-notional';
  }
  return null;
}

export function groupRiskGuardInit(): ManagerCoreState {
  return { ...EMPTY_MANAGER_CORE_STATE, scratch: { [GROUP_CLOSED_KEY]: false } };
}

export function groupRiskGuardOnTick(
  ctx: ManagerCoreTickInput<GroupRiskGuardParams>,
): ManagerCoreTickResult {
  const { params, position, state } = ctx;
  const wasClosed = state.scratch[GROUP_CLOSED_KEY] === true;
  const breach = evaluateGroupBreach(params, ctx.group);
  const actions: ManagerAction[] = [];

  if (breach !== null && !wasClosed && position.size > 0) {
    actions.push({ type: 'close', fraction: 1, reason: breach });
  }
  const closedNow = breach !== null;

  return {
    actions,
    state:
      closedNow === wasClosed
        ? state
        : { ...state, scratch: { ...state.scratch, [GROUP_CLOSED_KEY]: closedNow } },
  };
}

// Core: risk-cap / lock guard.
//
// A defensive overlay that sits LAST in a manager composition. It does three
// things, ported from the addon/BBLight lock + global-stop logic:
//
//   1. max-size cap (decisionFlow.ts:139 / BBLight trading.ts) — once the open
//      size reaches `maxSize` the guard locks the position and blocks any
//      further scale_in, by filtering the COMPOSED action list (filterActions).
//   2. globalStopPrice hard stop (BBLight trading.ts:549-561) — when price
//      crosses the global stop in the adverse direction the guard emits
//      close { fraction: 1 } and locks the position.
//   3. releaseLockAfter (decisionFlow.ts:27 / BBLight trading.ts:196-207) —
//      a favourable price level that releases the lock. One-shot for maxSize
//      locks (addon semantics).
//
// While locked, the guard drops every scale_in. set_stop_loss / close from
// earlier managers are left untouched — locking is about not ADDING risk, not
// about abandoning protective exits.

import {
  EMPTY_MANAGER_CORE_STATE,
  type ManagedPositionState,
  type ManagerAction,
  type ManagerCoreState,
  type ManagerCoreTickInput,
  type ManagerCoreTickResult,
  type ManagerDirection,
} from './contract.js';

export interface RiskGuardParams {
  // Hard cap on the open position size. Once reached the guard locks and blocks
  // further scale-ins. Omit to disable the cap.
  maxSize?: number;
  // Hard stop price. Crossing it in the adverse direction closes the whole
  // position and locks. Omit to disable.
  globalStopPrice?: number;
  // Price level in the favourable direction that releases an active lock. Omit
  // to keep the lock until the position closes.
  releaseLockAfter?: number;
}

const LOCKED_KEY = 'riskLocked';
const GLOBAL_STOP_CLOSED_KEY = 'globalStopClosed';
// One-shot release memory for maxSize locks (legacy addon semantics): once a
// release fires while the cap condition holds, the cap lock stays released
// until a NEW size-cap transition (size drops below the cap and reaches it
// again). Without it the size >= maxSize check re-locks on the very next
// evaluation and releaseLockAfter is a no-op for cap locks.
const CAP_RELEASED_KEY = 'riskCapReleased';

// Has price crossed the global stop in the ADVERSE direction (below for a long,
// above for a short)? Mirrors BBLight's compare(price, "<", globalStopPrice).
function globalStopBreached(stop: number, price: number, dir: ManagerDirection): boolean {
  return dir === 'long' ? price < stop : price > stop;
}

// Has price reached the release level in the FAVOURABLE direction? Mirrors the
// addon's compare(price, ">", releaseLockAfter, positive) with >= semantics.
function releaseReached(level: number, price: number, dir: ManagerDirection): boolean {
  return dir === 'long' ? price >= level : price <= level;
}

function isLocked(state: ManagerCoreState): boolean {
  return state.scratch[LOCKED_KEY] === true;
}

function isGlobalStopClosed(state: ManagerCoreState): boolean {
  return state.scratch[GLOBAL_STOP_CLOSED_KEY] === true;
}

function withScratch(
  state: ManagerCoreState,
  patch: { locked: boolean; globalStopClosed: boolean; capReleased: boolean },
): ManagerCoreState {
  return {
    ...state,
    scratch: {
      ...state.scratch,
      [LOCKED_KEY]: patch.locked,
      [GLOBAL_STOP_CLOSED_KEY]: patch.globalStopClosed,
      [CAP_RELEASED_KEY]: patch.capReleased,
    },
  };
}

// Should the guard be locked at this tick, given its prior lock state? Pure so
// callers can use it both inside onTick and when filtering composed actions.
// Lock engages on cap-reached or global-stop; it releases when the release
// level is reached. `capReleased` = a release already consumed the current cap
// condition (one-shot): the size >= maxSize check is suppressed until a new
// cap transition re-arms it (tracked by onTick).
export function evaluateLock(input: {
  params: RiskGuardParams;
  position: ManagedPositionState;
  price: number;
  wasLocked: boolean;
  capReleased?: boolean;
}): boolean {
  const { params, position, price, wasLocked } = input;
  const dir = position.direction;

  const releaseNow =
    params.releaseLockAfter !== undefined && releaseReached(params.releaseLockAfter, price, dir);
  const capHit = params.maxSize !== undefined && position.size >= params.maxSize;

  // Release takes effect first (so a release level reached this tick frees the
  // lock before any new lock condition is re-evaluated against the same tick).
  let locked = wasLocked;
  if (locked && releaseNow) {
    locked = false;
  }

  // One-shot: a cap condition already consumed by a release (capReleased), or
  // being released on this very tick, must not re-lock.
  if (capHit && !(input.capReleased || (wasLocked && releaseNow))) {
    locked = true;
  }
  if (params.globalStopPrice !== undefined && globalStopBreached(params.globalStopPrice, price, dir)) {
    locked = true;
  }
  return locked;
}

// Filter a COMPOSED action list (this guard's + earlier managers' actions) for
// the given tick. Drops every scale_in while locked; set_stop_loss and closes
// pass through. The caller applies this AFTER running all managers, so the
// guard governs the whole composition.
export function filterRiskGuardActions(input: {
  params: RiskGuardParams;
  position: ManagedPositionState;
  price: number;
  wasLocked: boolean;
  /** Pre-tick one-shot cap-release memory (scratch riskCapReleased). */
  wasCapReleased?: boolean;
  actions: ManagerAction[];
}): ManagerAction[] {
  const { params, position, price, wasLocked } = input;
  const dir = position.direction;
  const releaseNow =
    params.releaseLockAfter !== undefined && releaseReached(params.releaseLockAfter, price, dir);
  const capHit = params.maxSize !== undefined && position.size >= params.maxSize;
  // Mirror onTick's one-shot lock computation exactly (same capReleased
  // derivation), so the composed filter never diverges from the guard's own
  // lock state — in particular a FIRST cap hit on a tick where price already
  // sits beyond releaseLockAfter still locks and strips scale_ins.
  const capReleased = capHit && (input.wasCapReleased === true || (wasLocked && releaseNow));
  const locked = evaluateLock({ params, position, price, wasLocked, capReleased });
  if (!locked) return input.actions;
  // Locked: strip scale_ins; protective exits stay.
  return input.actions.filter((a) => a.type !== 'scale_in');
}

export function riskGuardInit(): ManagerCoreState {
  return {
    ...EMPTY_MANAGER_CORE_STATE,
    scratch: { [LOCKED_KEY]: false, [GLOBAL_STOP_CLOSED_KEY]: false, [CAP_RELEASED_KEY]: false },
  };
}

export function riskGuardOnTick(
  ctx: ManagerCoreTickInput<RiskGuardParams>,
): ManagerCoreTickResult {
  const { params, position, price, state } = ctx;
  const wasLocked = isLocked(state);
  const wasGlobalStopClosed = isGlobalStopClosed(state);
  const wasCapReleased = state.scratch[CAP_RELEASED_KEY] === true;
  const dir = position.direction;
  const actions: ManagerAction[] = [];

  // One-shot cap-release memory: set when a release frees an active lock
  // while the cap condition still holds; cleared once size drops below the
  // cap (the next cap hit is a NEW transition and locks again).
  const capHit = params.maxSize !== undefined && position.size >= params.maxSize;
  const releaseNow =
    params.releaseLockAfter !== undefined && releaseReached(params.releaseLockAfter, price, dir);
  const capReleasedNow = capHit && (wasCapReleased || (wasLocked && releaseNow));

  const lockedNow = evaluateLock({ params, position, price, wasLocked, capReleased: capReleasedNow });

  const breached =
    params.globalStopPrice !== undefined &&
    globalStopBreached(params.globalStopPrice, price, dir) &&
    position.size > 0;

  // Global-stop hard close: emit exactly once per breach. The
  // globalStopClosed flag guards against re-emitting on subsequent ticks
  // while price stays beyond the stop; it resets once the breach clears so a
  // later breach can fire again.
  if (breached && !wasGlobalStopClosed) {
    actions.push({ type: 'close', fraction: 1, reason: 'global-stop' });
  }
  const globalStopClosedNow = breached;

  return {
    actions,
    state:
      lockedNow === wasLocked &&
      globalStopClosedNow === wasGlobalStopClosed &&
      capReleasedNow === wasCapReleased
        ? state
        : withScratch(state, {
            locked: lockedNow,
            globalStopClosed: globalStopClosedNow,
            capReleased: capReleasedNow,
          }),
  };
}

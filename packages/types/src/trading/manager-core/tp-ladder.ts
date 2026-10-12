// Core: golden-fib take-profit ladder.
//
// The mirror image of the DCA entry ladder. Where the golden-fib calculator
// builds accumulation levels BELOW an extreme (for a long), this manager places
// take-profit levels ABOVE the average entry in the winning direction and skims
// a fraction of the position off at each one, leaving a runner open.
//
// Two ways to specify the rungs:
//   - explicit `prices`: absolute TP prices in instrument units.
//   - derived: give a `target` extreme and a `levelCount`; the manager spaces
//     the rungs from avg entry toward the target on golden-fib percentages
//     (FIB_LEVELS scaled into [0, target]).
//
// Each rung that price touches emits a `close { fraction }` of the ORIGINAL
// size. `runnerFraction` is held back and never laddered out, so a trend can
// keep running under a trailing stop installed by another manager.
//
// State: the set of already-triggered rung indices (JSON-encoded in scratch,
// which only holds primitives), so a rung fires at most once across bars.

import {
  EMPTY_MANAGER_CORE_STATE,
  type ManagedPositionState,
  type ManagerAction,
  type ManagerCoreInitInput,
  type ManagerCoreState,
  type ManagerCoreTickInput,
  type ManagerCoreTickResult,
  type ManagerDirection,
} from './contract.js';

// Golden-ratio ladder percentages (canonical — the SDK's lib/golden-fib and
// the edge registry both re-export this constant).
export const FIB_LEVELS = [23.6, 38.2, 50, 61.8, 78.6, 100] as const;

export interface TpLadderParams {
  // Explicit TP prices. Non-empty wins over the derived ladder.
  prices: number[];
  // Far target used to derive rungs when `prices` is empty. Must lie in the
  // winning direction (above entry for a long, below for a short).
  target?: number;
  // How many rungs to derive from `target` (first N FIB_LEVELS).
  levelCount: number;
  // Fraction of the ORIGINAL position closed at each rung (0..1].
  fractionPerTranche: number;
  // Fraction held back as a runner; never laddered out.
  runnerFraction: number;
}

// Canonical defaults — the SDK zod schema and the edge normalizer both read
// these, so they cannot diverge.
export const TP_LADDER_DEFAULTS: Omit<TpLadderParams, 'target'> = {
  prices: [],
  levelCount: FIB_LEVELS.length,
  fractionPerTranche: 0.25,
  runnerFraction: 0,
};

const TRIGGERED_KEY = 'tpTriggered';
const ORIGINAL_SIZE_KEY = 'tpOriginalSize';
// Rung prices FROZEN when the ladder arms (init, or first tick when init was
// skipped). Derived rungs read avgEntryPrice; recomputing them per tick while
// the `triggered` index set persists means a mid-trade DCA (which drops the
// average) shifts the remaining rungs below already-fired ones → premature
// tranche exits. Freezing pins each index to one price for the position's life.
const LEVELS_KEY = 'tpLevels';

// Resolve the rung prices for a position: explicit list, or golden-fib-spaced
// rungs between avg entry and the target. Always returned ordered nearest-entry
// first so they trigger in sequence as price advances.
export function resolveTpLevels(
  params: TpLadderParams,
  position: Pick<ManagedPositionState, 'avgEntryPrice' | 'direction'>,
): number[] {
  const dir = position.direction;
  let levels: number[];

  if (params.prices.length > 0) {
    levels = [...params.prices];
  } else {
    const target = params.target!;
    const span = target - position.avgEntryPrice; // signed
    const fibs = FIB_LEVELS.slice(0, params.levelCount);
    levels = fibs.map((pct) => position.avgEntryPrice + span * (pct / 100));
  }

  // Keep only rungs in the winning direction, ordered nearest-entry first.
  const profitable = levels.filter((p) =>
    dir === 'long' ? p > position.avgEntryPrice : p < position.avgEntryPrice,
  );
  profitable.sort((a, b) => (dir === 'long' ? a - b : b - a));
  return profitable;
}

// Has `price` reached `level` in the winning direction?
function levelReached(level: number, price: number, dir: ManagerDirection): boolean {
  return dir === 'long' ? price >= level : price <= level;
}

function readTriggered(state: ManagerCoreState): Set<number> {
  const raw = state.scratch[TRIGGERED_KEY];
  if (typeof raw !== 'string' || raw.length === 0) return new Set();
  try {
    const arr = JSON.parse(raw) as number[];
    return new Set(arr);
  } catch {
    return new Set();
  }
}

function writeTriggered(state: ManagerCoreState, triggered: Set<number>): ManagerCoreState {
  return {
    ...state,
    scratch: { ...state.scratch, [TRIGGERED_KEY]: JSON.stringify([...triggered]) },
  };
}

// null = not frozen yet (init skipped by the caller).
function readLevels(state: ManagerCoreState): number[] | null {
  const raw = state.scratch[LEVELS_KEY];
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const arr = JSON.parse(raw) as number[];
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

export function tpLadderInit({
  params,
  position,
}: ManagerCoreInitInput<TpLadderParams>): ManagerCoreState {
  return {
    ...EMPTY_MANAGER_CORE_STATE,
    scratch: {
      [TRIGGERED_KEY]: JSON.stringify([]),
      [ORIGINAL_SIZE_KEY]: position.size,
      [LEVELS_KEY]: JSON.stringify(resolveTpLevels(params, position)),
    },
  };
}

export function tpLadderOnTick({
  params,
  position,
  price,
  state,
}: ManagerCoreTickInput<TpLadderParams>): ManagerCoreTickResult {
  // Frozen-at-arm rung prices; resolve once when init was skipped.
  let levels = readLevels(state);
  let frozenNow = false;
  if (levels === null) {
    levels = resolveTpLevels(params, position);
    frozenNow = true;
  }
  const triggered = readTriggered(state);

  // The original size is captured on init; fall back to the current size the
  // first time we see it (caller may have skipped init).
  const cachedOriginal = state.scratch[ORIGINAL_SIZE_KEY];
  const originalSize =
    typeof cachedOriginal === 'number' && cachedOriginal > 0 ? cachedOriginal : position.size;

  const actions: ManagerAction[] = [];

  // Budget: never ladder out more than (1 - runnerFraction) of the original.
  const closableBudget = Math.max(0, 1 - params.runnerFraction);
  let alreadyClosed = triggered.size * params.fractionPerTranche;

  // The caller applies our close fractions sequentially against a shrinking
  // remaining size, but does so only AFTER this onTick returns. When several
  // rungs fire on one tick we must therefore track the remaining size
  // ourselves so each subsequent fraction is measured against what the earlier
  // closes in the same tick already removed.
  let remainingSize = position.size;

  let changed = false;
  for (let i = 0; i < levels.length; i++) {
    if (triggered.has(i)) continue;
    if (!levelReached(levels[i]!, price, position.direction)) continue;

    const remainingBudget = closableBudget - alreadyClosed;
    if (remainingBudget <= 1e-9) break; // runner reached; stop laddering
    const originalFraction = Math.min(params.fractionPerTranche, remainingBudget);
    triggered.add(i);
    changed = true;
    alreadyClosed += originalFraction;
    if (originalFraction <= 1e-9) continue;

    // close.fraction is a fraction of the CURRENT remaining size (per the
    // ManagerAction contract). The tranche is sized off the ORIGINAL size, so
    // convert: closing X*originalSize units off remainingSize is
    // (X*originalSize)/remainingSize of what remains.
    const sliceSize = originalFraction * originalSize;
    const remainingFraction = remainingSize > 0 ? Math.min(1, sliceSize / remainingSize) : 0;
    if (remainingFraction <= 1e-9) continue;
    actions.push({ type: 'close', fraction: remainingFraction, reason: `tp-ladder:${i}` });
    remainingSize -= remainingFraction * remainingSize;
  }

  let next = changed ? writeTriggered(state, triggered) : state;
  if (frozenNow) {
    next = { ...next, scratch: { ...next.scratch, [LEVELS_KEY]: JSON.stringify(levels) } };
  }
  return { actions, state: next };
}

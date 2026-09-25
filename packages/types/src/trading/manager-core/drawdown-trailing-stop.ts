// Core: drawdown-depth trailing stop.
//
// Ported from kaibotautomationaddon src/services/positions.ts
// (updateOppositePrice + updateTrailingStoploss, lines 363-523).
//
// The trail distance is NOT a fixed percentage. It is the drawdown depth the
// position carried at entry: extremePriceAtEntry - oppositePrice. That distance
// is then capped — by maxTrailingPercentage in percentage mode (default 40%),
// or by maxTrailingPoints in point-based mode (default 500). The resulting stop
// trails the current price by that capped distance and only ever moves in the
// winning direction. `trailingLock` disables trailing entirely.
//
// Mode (point-based vs percentage) follows the position's exchange exactly like
// the addon: TradeStation => point-based, everything else => percentage.

import {
  EMPTY_MANAGER_CORE_STATE,
  isFavourableStop,
  isPointBasedExchange,
  type ManagerAction,
  type ManagerCoreInitInput,
  type ManagerCoreState,
  type ManagerCoreTickInput,
  type ManagerCoreTickResult,
  type ManagerDirection,
} from './contract.js';

export interface DrawdownTrailingStopParams {
  // Cap on the trail distance in percentage mode, in percent (addon
  // PRICE.MAX_TRAILING_PERCENTAGE).
  maxTrailingPercentage: number;
  // Cap on the trail distance in point-based mode, in instrument points
  // (addon PRICE.MAX_TRAILING_POINTS).
  maxTrailingPoints: number;
  // Floor on the trail distance in percentage mode. The addon trail is the
  // drawdown depth carried at entry, ~0 for a position handed off right after
  // opening — flooring keeps at least this much distance. 0 preserves exact
  // addon behaviour.
  minTrailingPercentage: number;
  // Floor on the trail distance in point-based mode, in instrument points.
  minTrailingPoints: number;
  // When true the trailing stop never moves (addon trailing_lock).
  trailingLock: boolean;
  // When true the trail is inert while the position is underwater and only
  // starts once price is in profit (addon: trailing gated behind PROMOTE).
  onlyWhenProfit: boolean;
  // Original-entry reference for the onlyWhenProfit gate, set live at attach.
  // 0/absent → seed from the opening avg entry at init() (the backtester path).
  referencePrice: number;
  // When true the trail extreme is the FIXED pre-entry swing (the addon's
  // extreme_price_at_entry, snapshotted at open and never updated) instead of
  // the advancing post-entry max. Default false preserves the
  // advancing-extreme behaviour exactly.
  freezeExtreme: boolean;
}

// Canonical defaults — the SDK zod schema and the edge normalizer both read
// these, so they cannot diverge.
export const DRAWDOWN_TRAILING_STOP_DEFAULTS: DrawdownTrailingStopParams = {
  maxTrailingPercentage: 40,
  maxTrailingPoints: 500,
  minTrailingPercentage: 0,
  minTrailingPoints: 0,
  trailingLock: false,
  onlyWhenProfit: false,
  referencePrice: 0,
  freezeExtreme: false,
};

// The slice of ManagedPositionState the compute reads — callers with a leaner
// row (the executor's F1 trail) can pass a view instead of a full position.
export interface DrawdownPositionView {
  direction: ManagerDirection;
  avgEntryPrice: number;
  extremePriceAtEntry: number;
  oppositePrice: number;
  currentStopLoss: number | null;
  exchange?: string | undefined;
}

const REF_KEY = 'ddTrailRef';

// Compute the trailing stop for the current price using the addon's exact math.
// Returns null when no favourable move is available or trailing is locked.
export function computeDrawdownTrailingStop(input: {
  params: DrawdownTrailingStopParams;
  position: DrawdownPositionView;
  price: number;
  // The "in profit" yardstick for onlyWhenProfit. Pass the ORIGINAL entry for a
  // DCA bot (the addon promotes on price > referencePrice); defaults to the live
  // average, which drops as the ladder fills and would arm the trail intra-bar.
  reference?: number;
  // Fixed pre-entry swing used as the trail extreme when params.freezeExtreme
  // is set. Falls back to `reference`, then to the advancing position extreme.
  frozenExtreme?: number;
  // Explicit point-vs-percentage mode. Absent → derived from the position's
  // exchange (isPointBasedExchange), byte-identical to before.
  pointBased?: boolean;
}): number | null {
  const { params, position, price } = input;
  if (params.trailingLock) return null;

  // Gated behind profit (addon promote): no stop while underwater, so a DCA
  // position accumulates through the drawdown instead of being stopped out.
  if (params.onlyWhenProfit) {
    const base = input.reference ?? position.avgEntryPrice;
    const inProfit = position.direction === 'long' ? price > base : price < base;
    if (!inProfit) return null;
  }

  const pointBased = input.pointBased ?? isPointBasedExchange(position.exchange);

  // Trail extreme: the advancing post-entry max by default; the frozen
  // pre-entry swing under freezeExtreme (legacy extreme_price_at_entry).
  const frozen =
    params.freezeExtreme && (input.frozenExtreme ?? input.reference ?? 0) > 0
      ? (input.frozenExtreme ?? input.reference)!
      : null;
  const extreme = frozen ?? position.extremePriceAtEntry;

  // priceRange = drawdown depth at entry (always >= 0 for a normal position
  // whose extreme moved with it and opposite moved against it).
  const priceRange =
    position.direction === 'long'
      ? extreme - position.oppositePrice
      : position.oppositePrice - extreme;

  let newStopLoss: number;
  if (pointBased) {
    // Floor never exceeds the cap (a misconfigured floor > cap can't invert).
    const floor = Math.min(params.minTrailingPoints, params.maxTrailingPoints);
    const capped = Math.max(Math.min(priceRange, params.maxTrailingPoints), floor);
    newStopLoss =
      position.direction === 'long' ? price - capped : price + capped;
  } else {
    const percentageDistance = (priceRange / extreme) * 100;
    const floorPct = Math.min(params.minTrailingPercentage, params.maxTrailingPercentage);
    const cappedPct = Math.max(
      Math.min(percentageDistance, params.maxTrailingPercentage),
      floorPct,
    );
    newStopLoss =
      position.direction === 'long'
        ? price * (1 - cappedPct / 100)
        : price * (1 + cappedPct / 100);
  }

  if (!isFavourableStop(newStopLoss, position.currentStopLoss, position.direction)) {
    return null;
  }
  return newStopLoss;
}

export function drawdownTrailingStopInit({
  params,
  position,
}: ManagerCoreInitInput<DrawdownTrailingStopParams>): ManagerCoreState {
  // Anchor priority: the entry signal's manager anchor (e.g. golden-fib's
  // pre-drop peak, via Signal.managerReference) > attach-injected param >
  // opening avg entry. Mirrors fault-ladder / crashbot-trail so onlyWhenProfit
  // gates off the strategy's reference, not the fill below it.
  const ref =
    (position.referencePrice ?? 0) > 0
      ? position.referencePrice!
      : params.referencePrice > 0
        ? params.referencePrice
        : position.avgEntryPrice;
  return { ...EMPTY_MANAGER_CORE_STATE, scratch: { [REF_KEY]: ref } };
}

export function drawdownTrailingStopOnTick({
  params,
  position,
  price,
  state,
}: ManagerCoreTickInput<DrawdownTrailingStopParams>): ManagerCoreTickResult {
  let seededRef =
    typeof state.scratch[REF_KEY] === 'number' ? (state.scratch[REF_KEY] as number) : 0;
  let nextState = state;
  // freezeExtreme needs a genuinely frozen anchor. Live the runner never calls
  // init(), so seed the scratch anchor on the first tick — the position's
  // referencePrice (pre-entry swing) first, else the current extreme — and
  // persist it so later DCA fills / advancing extremes can't move it.
  if (params.freezeExtreme && !(seededRef > 0)) {
    seededRef =
      (position.referencePrice ?? 0) > 0
        ? position.referencePrice!
        : params.referencePrice > 0
          ? params.referencePrice
          : position.extremePriceAtEntry;
    nextState = { ...state, scratch: { ...state.scratch, [REF_KEY]: seededRef } };
  }
  // Resolve the original-entry reference: the init-seeded scratch (backtester),
  // else the live-injected param (the runner never calls init), else the live
  // average. Under freezeExtreme the same anchor is the frozen trail extreme
  // (legacy seeds both from automation.extremePrice).
  const reference =
    seededRef > 0 ? seededRef : params.referencePrice > 0 ? params.referencePrice : position.avgEntryPrice;
  const newStop = computeDrawdownTrailingStop({ params, position, price, reference });
  const actions: ManagerAction[] = [];
  if (newStop !== null) {
    actions.push({
      type: 'set_stop_loss',
      price: newStop,
      reason: 'trailing-stop',
    });
  }
  return { actions, state: nextState };
}

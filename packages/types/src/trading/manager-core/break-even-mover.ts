// Core: break-even stop mover.
//
// Ported from kaibotautomationaddon updateStoplossToBreakeven
// (src/services/positions.ts:177-227) + calculateBreakeven
// (src/utils/calculations.ts:5).
//
// Once price has moved into profit by the trigger distance, the stop jumps to
// break-even: entryPrice * (1 +/- feePercentage) in percentage mode, or
// entryPrice +/- 1 point in point-based mode (TradeStation). One-way: the move
// fires once and never reverses.

import {
  EMPTY_MANAGER_CORE_STATE,
  isFavourableStop,
  isPointBasedExchange,
  type ManagedPositionState,
  type ManagerAction,
  type ManagerCoreInitInput,
  type ManagerCoreState,
  type ManagerCoreTickInput,
  type ManagerCoreTickResult,
} from './contract.js';

export interface BreakEvenMoverParams {
  // Fee buffer past entry in percentage mode (fraction: 0.0015 = 0.15%).
  feePercentage: number;
  // Profit distance required before the move, in percent of the base. 0 arms on
  // any favourable tick.
  triggerPercentage: number;
  // Trigger off the ORIGINAL entry reference instead of the live average.
  useEntryReference: boolean;
  // Original-entry reference injected at attach (the live runner never calls
  // init()). 0/absent → seed from the opening avg entry at init().
  referencePrice: number;
}

// Canonical defaults — the SDK zod schema and the edge normalizer both read
// these, so they cannot diverge.
export const BREAK_EVEN_MOVER_DEFAULTS: BreakEvenMoverParams = {
  feePercentage: 0.0015,
  triggerPercentage: 0,
  useEntryReference: false,
  referencePrice: 0,
};

const ARMED_KEY = 'breakEvenArmed';
const REF_KEY = 'breakEvenRef';

// The break-even stop price. Mirrors addon calculateBreakeven.
export function computeBreakeven(input: {
  params: BreakEvenMoverParams;
  position: ManagedPositionState;
}): number {
  const { params, position } = input;
  if (isPointBasedExchange(position.exchange)) {
    return position.direction === 'long'
      ? position.avgEntryPrice + 1
      : position.avgEntryPrice - 1;
  }
  return position.direction === 'long'
    ? position.avgEntryPrice * (1 + params.feePercentage)
    : position.avgEntryPrice * (1 - params.feePercentage);
}

// Has price moved enough into profit to arm the break-even move? `base` is the
// average entry, or the seeded original entry when useEntryReference is set.
function triggerReached(
  params: BreakEvenMoverParams,
  position: ManagedPositionState,
  price: number,
  base: number,
): boolean {
  if (params.triggerPercentage <= 0) {
    return position.direction === 'long' ? price > base : price < base;
  }
  const mult = params.triggerPercentage / 100;
  const threshold =
    position.direction === 'long' ? base * (1 + mult) : base * (1 - mult);
  return position.direction === 'long' ? price >= threshold : price <= threshold;
}

export function breakEvenMoverInit({
  params,
  position,
}: ManagerCoreInitInput<BreakEvenMoverParams>): ManagerCoreState {
  // Anchor priority: the entry signal's manager anchor (e.g. golden-fib's
  // pre-drop peak, via Signal.managerReference) > attach-injected param >
  // opening avg entry. Mirrors fault-ladder / crashbot-trail — without it a
  // DCA seed that enters BELOW its reference arms break-even on the first
  // bounce over the fill and the resting ~entry stop kills the accumulation.
  const ref =
    (position.referencePrice ?? 0) > 0
      ? position.referencePrice!
      : params.referencePrice > 0
        ? params.referencePrice
        : position.avgEntryPrice;
  return { ...EMPTY_MANAGER_CORE_STATE, scratch: { [ARMED_KEY]: false, [REF_KEY]: ref } };
}

export function breakEvenMoverOnTick({
  params,
  position,
  price,
  state,
}: ManagerCoreTickInput<BreakEvenMoverParams>): ManagerCoreTickResult {
  const armed = state.scratch[ARMED_KEY] === true;
  if (armed) {
    return { actions: [], state };
  }
  const seededRef =
    typeof state.scratch[REF_KEY] === 'number' ? (state.scratch[REF_KEY] as number) : 0;
  // Resolve the original-entry reference: the init-seeded scratch (backtester),
  // else the live-injected param (the runner never calls init), else the live
  // average. Mirrors crashbot-trail so the DCA average dropping can't collapse
  // the reference live.
  const ref =
    seededRef > 0 ? seededRef : params.referencePrice > 0 ? params.referencePrice : position.avgEntryPrice;
  const base = params.useEntryReference ? ref : position.avgEntryPrice;
  if (!triggerReached(params, position, price, base)) {
    return { actions: [], state };
  }

  const breakeven = computeBreakeven({ params, position });
  const actions: ManagerAction[] = [];
  if (isFavourableStop(breakeven, position.currentStopLoss, position.direction)) {
    actions.push({ type: 'set_stop_loss', price: breakeven, reason: 'break-even' });
  }
  return {
    actions,
    state: { ...state, scratch: { ...state.scratch, [ARMED_KEY]: true } },
  };
}

// Position-manager core contract — the SINGLE source for the manager types and
// reducer logic shared by the SDK reference managers
// (packages/strategy-sdk/src/managers/*) and the executor edge managers
// (apps/kaibot-executor/node-backend/src/services/edge-managers/*). Both
// runtimes wrap these cores in their own plugin shells (zod schema + registry
// on the SDK side; the lean EdgeManagerPlugin on the executor side), so the
// behaviour cannot drift. IP-free by design: only the allowlisted
// protect/reduce reference managers live here — @kaibot/types ships with the
// executor (public repo), the proprietary engine does not (carve-out INV10).
//
// A manager never opens positions. It receives an already-open position and,
// on every tick, may adjust its stop-loss, scale in, or close part/all of it.

export type ManagerDirection = 'long' | 'short';

// The position as seen by a manager. All prices are in instrument units.
// The caller (backtester or live runner) keeps it current between ticks.
export interface ManagedPositionState {
  // Stable id so 'close' actions can reference a specific position downstream.
  id: string;
  direction: ManagerDirection;
  // Volume-weighted average entry price across all fills.
  avgEntryPrice: number;
  // Remaining open size (always positive; direction disambiguates).
  size: number;
  // Best price reached in the position's favour since entry. For a long this
  // is the highest high seen; for a short the lowest low. Seeded to the entry
  // price. This is the addon's "extreme_price_at_entry" once trailing engages.
  extremePriceAtEntry: number;
  // Worst price reached against the position since entry. Seeded to the entry
  // price. This is the addon's "opposite_price". The drawdown depth at entry
  // (extreme - opposite) is what the reference trailing stop uses as its trail
  // distance.
  oppositePrice: number;
  // Active stop-loss price, or null when none is set yet.
  currentStopLoss: number | null;
  // Epoch ms when the position opened.
  openedTs: number;
  // Exchange tag so point-vs-percentage behaviour matches the live system
  // (the addon treats TradeStation as point-based). Optional; defaults to
  // percentage mode when absent.
  exchange?: string;
  // Manager anchor the entry signal carried (Signal.managerReference), e.g.
  // the cracked base a fault-line position trades off. Managers that resolve
  // a reference should prefer it over params/avg-entry. Absent = legacy
  // resolution, byte-identical.
  referencePrice?: number;
}

// Aggregate view of all open positions sharing the tick position's groupId
// (G2, position-groups). The CALLER computes it (the backtester freezes
// membership + equity once per bar; the executor once per poll cycle) —
// cross-position VISIBILITY flows in, but actions stay per-position. Absent
// (no group, or the caller doesn't feed groups) ⇒ group-scoped managers must
// stay inert.
export interface GroupAggregateState {
  groupId: string;
  memberCount: number;
  // Sum of members' unrealized PnL in account currency (negative = losing).
  unrealizedPnl: number;
  // Sum of members' |size| × mark — gross notional at risk.
  notional: number;
  // Account-equity basis for loss-fraction checks. null = unknown; guards must
  // treat null as "cannot evaluate", never as 0.
  equity: number | null;
}

// Actions a manager can emit on a tick. The caller decides how to apply them.
export type ManagerAction =
  // Move (or set) the protective stop. Managers are expected to only emit
  // favourable moves, but the caller must still clamp defensively.
  | { type: 'set_stop_loss'; price: number; reason?: string }
  // Close a fraction (0..1] of the remaining size at the current tick.
  | { type: 'close'; fraction: number; reason?: string }
  // Add to the position. Exactly one of `sizeFraction` (fraction of current
  // cash) / `notional` (cash amount, units = notional / fill price — the seed
  // convention) / `size` (absolute units); `sizeFraction` wins over
  // `notional`, which wins over `size`. `liveSize` is the FACTOR the live
  // runner emits on the add-signal. `limitPrice` (optional): the rung/limit
  // level this scale-in targets.
  | {
      type: 'scale_in';
      size?: number;
      sizeFraction?: number;
      notional?: number;
      liveSize?: number;
      limitPrice?: number;
      reason?: string;
    }
  // Open the opposite-side hedge leg (addon handleHedging; dual-slot engine).
  | { type: 'open_hedge'; side: ManagerDirection; size?: number; reason?: string }
  // Close the hedge leg only.
  | { type: 'close_hedge'; reason?: string }
  // Joint close: realize BOTH legs at this tick (addon fullRecovery).
  | { type: 'close_all'; reason?: string }
  // Append a lifecycle tag to the managed position (idempotent).
  | { type: 'set_tag'; tag: string; reason?: string };

// The JSON-serializable per-manager state the core reducers thread. Both the
// SDK's RunnerState and the executor's ManagerRunnerState are structural
// supersets of this shape, so the same reducers serve both runtimes (extra
// fields survive via spread).
export interface ManagerCoreState {
  lastTs: number | null;
  position: 'none' | 'long' | 'short';
  scratch: Record<string, number | string | boolean | null>;
}

export const EMPTY_MANAGER_CORE_STATE: ManagerCoreState = {
  lastTs: null,
  position: 'none',
  scratch: {},
};

export interface ManagerCoreInitInput<P> {
  params: P;
  position: ManagedPositionState;
}

// The tick slice the core reducers read. Callers may pass richer contexts
// (candle, ladder frames, ts, …) — extra fields are ignored.
export interface ManagerCoreTickInput<P> {
  params: P;
  position: ManagedPositionState;
  price: number;
  group?: GroupAggregateState;
  state: ManagerCoreState;
}

export interface ManagerCoreTickResult {
  actions: ManagerAction[];
  state: ManagerCoreState;
}

// True when the exchange tag is one the addon treats as point-based
// (TradeStation). Mirrors automationaddon utils/index.ts isPointBased.
export function isPointBasedExchange(exchange: string | undefined): boolean {
  return !!exchange && exchange.toLowerCase() === 'tradestation';
}

// Directional comparison helper mirroring the addon's compare(): for a long a
// "greater" stop is numerically higher; for a short it is numerically lower.
export function isFavourableStop(
  candidate: number,
  current: number | null,
  direction: ManagerDirection,
): boolean {
  if (current === null) return true;
  return direction === 'long' ? candidate > current : candidate < current;
}

// Advance a position's extreme/opposite trackers given a tick's high/low.
// Pure — returns a new object.
// LONG: extreme = max(extreme, high), opposite = min(opposite, low).
// SHORT: extreme = min(extreme, low),  opposite = max(opposite, high).
export function advanceManagedPosition(
  pos: ManagedPositionState,
  tick: { high: number; low: number },
): ManagedPositionState {
  if (pos.direction === 'long') {
    return {
      ...pos,
      extremePriceAtEntry: Math.max(pos.extremePriceAtEntry, tick.high),
      oppositePrice: Math.min(pos.oppositePrice, tick.low),
    };
  }
  return {
    ...pos,
    extremePriceAtEntry: Math.min(pos.extremePriceAtEntry, tick.low),
    oppositePrice: Math.max(pos.oppositePrice, tick.high),
  };
}

// Order-plan payload — an optional, structured execution recipe a strategy can
// attach to an entry signal. It lets a single signal express limit entries,
// pyramiding, a stop-loss, scaled take-profits, a trailing rule, an order TTL,
// and a postpone flag, instead of just "go long at next open".
//
// This type is the canonical, serializable shape. It lives in @kaibot/types so
// the backtester, the live executor, and the frontend can all reference it
// without depending on each other. The backtester honours it; live executors
// forward the parts the exchange supports.

// A single planned entry. `size` is in equity-fraction units (0..1) so it is
// instrument-agnostic, matching Signal.sizePct. Omit `price` for a market entry
// at the next bar's open; provide it for a resting limit entry.
export interface PlannedEntry {
  // Limit price. When omitted the entry is a market fill at the next bar open.
  price?: number;
  // Fraction of equity to commit to this leg (0..1]. Multiple entries sum to
  // the total intended exposure (pyramiding); the backtester weights fills into
  // a single average position.
  size: number;
}

// A scaled take-profit level. `fraction` is the portion of the *current* open
// size to close when the level is touched (0..1]. Levels fire independently.
export interface PlannedTakeProfit {
  price: number;
  fraction: number;
}

// Trailing-stop rule attached to a plan. Mirrors the SDK manager params so a
// plan can request the same drawdown-depth trail the reference manager applies.
// All fields optional; an empty object means "use engine defaults".
export interface PlannedTrail {
  // Fixed percentage trail distance (percent). When set, overrides the
  // drawdown-depth derivation with a constant distance.
  percentage?: number;
  // Fixed point trail distance (instrument points). Alternative to percentage.
  points?: number;
  // Cap on the trail distance in percentage mode (percent).
  maxPercentage?: number;
  // Cap on the trail distance in point mode (points).
  maxPoints?: number;
  // Break-even fee buffer (fraction, e.g. 0.0015): once price is in profit the
  // stop is floored at entry +/- this buffer. Author it in the strategy/trail
  // config. Absent/null = no break-even floor (the engine never injects a
  // default fee on the user's behalf).
  breakevenFee?: number;
}

export interface OrderPlan {
  // Resting/limit entries. When absent the signal behaves like a plain market
  // entry (back-compat). When present, the listed entries replace the implicit
  // market entry.
  entries?: PlannedEntry[];
  // Protective stop price for the resulting position.
  stopLoss?: number;
  // Scaled exits. Each level closes its fraction when price touches it.
  takeProfits?: PlannedTakeProfit[];
  // Trailing-stop rule. Engine-honoured; null/absent = no trailing.
  trail?: PlannedTrail;
  // Time-to-live for unfilled limit entries, in bars after the signal bar.
  // After ttlBars bars with no fill the unfilled entries are cancelled.
  ttlBars?: number;
  // When true the engine defers the entry by one bar (skip the immediate fill,
  // re-evaluate next bar). Mirrors the legacy "postpone" entry flag.
  postpone?: boolean;
}

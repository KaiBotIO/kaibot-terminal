import type { StrategyConfig as StrategyConfigV2Impl } from './strategy-config.js';

// Legacy strategy types live in ./strategy-legacy.ts (no strategy-runner dep).
// Re-exported here so existing `@kaibot/types` (root barrel) imports of
// Strategy / StrategyParameter / StrategyConfig keep working unchanged.
export type { StrategyParameter, Strategy, StrategyConfig } from './strategy-legacy.js';

// --- Strategy system v2 (canonical source lives in ./strategy-config.ts) ---
// Runtime Zod schemas + typed configs. strategy-runner re-exports these via its
// own ./schemas shim, so @kaibot/strategy-runner stays the discoverable surface
// for runner-side consumers while the canonical definitions live here — keeping
// @kaibot/types free of any back-dependency on strategy-runner (that cross-dep
// was a turbo build cycle).

export {
  STRATEGY_TYPES,
  STRATEGY_STATUSES,
  type StrategyType,
  type StrategyStatus,
  type StrategyRecord,
} from './strategy-config.js';

// StrategyConfigV2 keeps the legacy name used by earlier drafts. It is an alias
// for the v2 discriminated union StrategyConfig in ./strategy-config.ts.
export type StrategyConfigV2 = StrategyConfigV2Impl;

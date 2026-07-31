// Pure-type barrel for @kaibot/types.
//
// Identical to the root barrel (`@kaibot/types`) EXCEPT it does not re-export
// `trading/strategy.ts`, which re-exports runtime values + types from
// `@kaibot/strategy-runner` and so drags that package's transitive graph
// (incl. exchange adapters) into every consumer's type graph.
//
// Import from `@kaibot/types/core` when you only need the plain data types and
// want to keep `@kaibot/strategy-runner` out of your dependency graph. The root
// `@kaibot/types` entrypoint still re-exports everything (incl. strategy) for
// back-compat; strategy-runner re-exports also live at `@kaibot/types/strategy`.
export * from './core/user.js';
export * from './core/exchange.js';
export * from './trading/position.js';
export * from './trading/trade.js';
export * from './trading/bot.js';
export * from './trading/strategy-legacy.js';
export * from './trading/market.js';
export * from './trading/canonical-symbols.js';
export * from './trading/accounting.js';
export * from './trading/sizing.js';
export * from './trading/metrics.js';
export * from './common/enums.js';
export * from './common/base.js';
export * from './common/notifications.js';
export * from './chat/index.js';
export * from './social/index.js';

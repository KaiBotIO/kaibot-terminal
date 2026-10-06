// Drawdown-depth trailing stop — pure compute for the F1 trail row.
//
// The implementation lives in @kaibot/types/manager-core (the single source
// also driving the SDK reference manager and the edge-manager wrapper); this
// module re-exports it under the executor's historical import path.
// drawdown-trail.parity.test.ts still locks SDK↔edge equivalence.

export {
  computeDrawdownTrailingStop,
  isPointBasedExchange,
  type DrawdownPositionView,
  type DrawdownTrailingStopParams,
} from '@kaibot/types/manager-core'

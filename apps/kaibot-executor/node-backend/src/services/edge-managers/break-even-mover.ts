// Break-even stop mover — edge wrapper around the shared core
// (@kaibot/types/manager-core, the single source also driving the SDK
// reference manager). Parity of the plumbing is locked by
// break-even-mover.parity.test.ts.
//
// Once price has moved into profit by the trigger distance, the stop jumps to
// break-even: entry * (1 +/- feePercentage) in percentage mode, or entry +/- 1
// point on TradeStation. One-way: fires once and never reverses.

import {
  breakEvenMoverInit,
  breakEvenMoverOnTick,
} from '@kaibot/types/manager-core'
import type { EdgeManagerPlugin } from './contract.js'

export {
  BREAK_EVEN_MOVER_DEFAULTS,
  computeBreakeven,
  type BreakEvenMoverParams,
} from '@kaibot/types/manager-core'
import type { BreakEvenMoverParams } from '@kaibot/types/manager-core'

export const breakEvenMoverManager: EdgeManagerPlugin<BreakEvenMoverParams> = {
  id: 'break-even-mover',
  init: breakEvenMoverInit,
  onTick: breakEvenMoverOnTick,
}

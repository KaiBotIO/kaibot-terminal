// Take-profit ladder — edge wrapper around the shared core
// (@kaibot/types/manager-core, the single source also driving the SDK
// reference manager). Parity of the plumbing is locked by
// tp-ladder.parity.test.ts.
//
// Golden-fib TP ladder: skims fractionPerTranche of the ORIGINAL size off the
// position at each rung (explicit prices, or derived from a target on
// FIB_LEVELS), holding runnerFraction back as a trend runner. Each rung fires
// once; rung prices are FROZEN when the ladder arms.

import { tpLadderInit, tpLadderOnTick } from '@kaibot/types/manager-core'
import type { EdgeManagerPlugin } from './contract.js'

export {
  FIB_LEVELS,
  resolveTpLevels,
  TP_LADDER_DEFAULTS,
  type TpLadderParams,
} from '@kaibot/types/manager-core'
import type { TpLadderParams } from '@kaibot/types/manager-core'

export const tpLadderManager: EdgeManagerPlugin<TpLadderParams> = {
  id: 'tp-ladder',
  init: tpLadderInit,
  onTick: tpLadderOnTick,
}

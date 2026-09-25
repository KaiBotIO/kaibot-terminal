// Drawdown-depth trailing stop — edge wrapper around the shared core
// (@kaibot/types/manager-core, the single source also driving the SDK
// reference manager). Parity of the plumbing is locked by
// drawdown-trailing-stop.parity.test.ts.
//
// NOTE: the ATTACH surface does not expose this manager — a drawdown trail on a
// position is armed via /api/trade/manage (the F1 trail row owns the venue
// stop; two trails on one position would break the one-stop-owner rule).

import {
  drawdownTrailingStopInit,
  drawdownTrailingStopOnTick,
} from '@kaibot/types/manager-core'
import type { EdgeManagerPlugin } from './contract.js'

export {
  DRAWDOWN_TRAILING_STOP_DEFAULTS,
  type DrawdownTrailingStopParams,
} from '@kaibot/types/manager-core'
import type { DrawdownTrailingStopParams } from '@kaibot/types/manager-core'

export const drawdownTrailingStopManager: EdgeManagerPlugin<DrawdownTrailingStopParams> = {
  id: 'drawdown-trailing-stop',
  init: drawdownTrailingStopInit,
  onTick: drawdownTrailingStopOnTick,
}

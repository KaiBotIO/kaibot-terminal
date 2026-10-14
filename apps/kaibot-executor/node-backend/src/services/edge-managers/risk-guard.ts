// Risk-cap / lock guard — edge wrapper around the shared core
// (@kaibot/types/manager-core, the single source also driving the SDK
// reference manager). Parity of the plumbing is locked by
// risk-guard.parity.test.ts.
//
// Defensive overlay, LAST in a manager composition: locks and blocks scale-ins
// once size reaches maxSize, hard-closes on globalStopPrice, releases the lock
// at releaseLockAfter (one-shot for cap locks). While locked it drops every
// scale_in from the COMPOSED action list; protective exits pass through.

import {
  filterRiskGuardActions,
  riskGuardInit,
  riskGuardOnTick,
} from '@kaibot/types/manager-core'
import type { EdgeManagerPlugin } from './contract.js'

export {
  evaluateLock,
  filterRiskGuardActions,
  type RiskGuardParams,
} from '@kaibot/types/manager-core'
import type { RiskGuardParams } from '@kaibot/types/manager-core'

export const riskGuardManager: EdgeManagerPlugin<RiskGuardParams> = {
  id: 'risk-guard',
  init: riskGuardInit,
  onTick: riskGuardOnTick,
  filterActions: (input) => filterRiskGuardActions(input),
}

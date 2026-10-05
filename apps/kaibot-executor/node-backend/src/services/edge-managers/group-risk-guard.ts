// Group risk-guard — edge wrapper around the shared core
// (@kaibot/types/manager-core, the single source also driving the SDK
// reference manager). Parity of the plumbing is locked by
// group-risk-guard.parity.test.ts.
//
// Watches the AGGREGATE of all open positions sharing the tick position's
// groupId (ctx.group, computed by the runner once per poll cycle). On breach it
// emits a full close for ITS OWN position; attach it to every group member and
// the whole group closes on the same cycle (frozen aggregates). Inert without
// ctx.group and with default (empty) params. Reduce/protect-only.

import {
  groupRiskGuardInit,
  groupRiskGuardOnTick,
} from '@kaibot/types/manager-core'
import type { EdgeManagerPlugin } from './contract.js'

export {
  evaluateGroupBreach,
  type GroupRiskGuardParams,
} from '@kaibot/types/manager-core'
import type { GroupRiskGuardParams } from '@kaibot/types/manager-core'

export const groupRiskGuardManager: EdgeManagerPlugin<GroupRiskGuardParams> = {
  id: 'group-risk-guard',
  init: groupRiskGuardInit,
  onTick: groupRiskGuardOnTick,
}

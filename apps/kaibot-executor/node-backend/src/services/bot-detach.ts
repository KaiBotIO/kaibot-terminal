// Bot TAKE-OVER / detach — shared between the local bot route and the remote
// companion command handler so both paths run the exact same logic (no drift).
//
// "Stop listening to this bot": pause the bot config so the executor stops acting
// on its signals, and retire its active local trails so the position reverts to
// manual on the edge. Runs the pure planTakeOver decision first; a no-op (already
// manual, no managers) returns needed:false without writing. Nothing is closed —
// only WHO manages the exit changes.

import type { KaiBotDatabase } from '../storage/database.js';
import { planTakeOver, deriveBotManager, type TakeOverPlan } from './take-over.js';
import { linkTakeoverLineage } from './position-groups.js';

export interface DetachResult {
  id: string;
  needed: boolean;
  retiredManagers: number;
  paused: boolean;
  manager: 'manual';
}

// Thrown when the bot id is unknown, so callers can map it to a 404 / error code.
export class BotNotFoundError extends Error {
  constructor(public id: string) {
    super('not found');
    this.name = 'BotNotFoundError';
  }
}

export function detachBot(db: KaiBotDatabase, id: string): DetachResult {
  const cfg = db.getBotConfig(id);
  if (!cfg) throw new BotNotFoundError(id);

  const openSignals = db.getOpenSignalsForBotConfig(id);
  const activeTrails = db.activeLocalTrailsForSignals(openSignals.map((s) => s.id));

  const plan: TakeOverPlan = planTakeOver({
    currentManager: deriveBotManager({ status: cfg.status, strategyId: cfg.strategyId }),
    activeManagerCount: activeTrails.length,
  });

  if (!plan.needed) {
    return { id, needed: false, retiredManagers: 0, paused: false, manager: 'manual' };
  }

  // Pause the strategy run loop (deactivateStrategyId set ⇒ a running bot).
  let paused = false;
  if (plan.deactivateStrategyId) {
    db.setBotConfigStatus(id, 'paused');
    paused = true;
  }

  // Retire the local position managers (active trails) for this bot's positions.
  let retired = 0;
  if (plan.retireManagers) {
    for (const t of activeTrails) {
      db.deactivateLocalTrail(t.signal_id);
      retired++;
    }
  }

  // G0: take-over keeps group lineage. Positions that predate grouping get
  // linked into the bot's group here (from the retired trail rows — the only
  // edge record carrying the account id). Existing links persist untouched.
  try {
    linkTakeoverLineage(db, cfg, activeTrails);
  } catch {
    /* visibility only — never block a detach */
  }

  db.log('warn', 'trading', 'Bot detached — position reverts to manual', {
    botConfigId: id,
    paused,
    retiredManagers: retired,
  });

  return { id, needed: true, retiredManagers: retired, paused, manager: 'manual' };
}

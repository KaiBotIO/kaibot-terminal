// Edge-side TAKE-OVER / detach decision logic — pure (no DB, no I/O).
//
// Ported from packages/trpc/src/lib/position-control.ts (planTakeOver + the mode
// selectors) so the executor decides take-over EDGE-SIDE: the executor owns the
// live position + its manager pointer (it holds local_trail_state) while the
// server (the brain) decides whether to keep emitting signals for the bot.
// Take-over = "stop listening to this bot" → pause the bot config so the executor
// stops acting on its signals AND retire its local position managers (the active
// local trails) so the position reverts to manual on the edge. Nothing is closed —
// this only changes WHO manages the exit.
//
// Kept a separate copy (not an import of @kaibot/trpc) on purpose: the executor
// backend stays off the server's heavy transitive graph (see storage/types.ts
// header). The decision is identical; only the side-effects differ (bot_configs +
// local_trail_state instead of server tables).

// The current manager pointer for a position, as derivable edge-side.
//   manual    — no running bot + no active local trail steering it.
//   strategy  — a running bot config drives it (the server emits its signals).
//   signal_bot — an online signal-bot subscription drives it (factor-sized inbound
//                signals) rather than a local strategy.
export type CurrentManager =
  | { kind: 'manual' }
  | { kind: 'strategy'; strategyId: string }
  | { kind: 'signal_bot'; botId: string; subscriptionId: string };

export interface TakeOverPlan {
  // Whether take-over is needed at all (false = already manual, no managers).
  needed: boolean;
  // The strategy whose run loop must stop touching the position (kind==='strategy').
  // Edge-side this maps to pausing the bot config so the runner stops ticking it.
  deactivateStrategyId: string | null;
  // Whether active local position managers (local trails) must be retired so the
  // position reverts to manual.
  retireManagers: boolean;
}

/**
 * Plan a TAKE-OVER: what must be torn down so a strategy/bot fully lets go of a
 * position and the user gets manual control. Two manager systems can be live at
 * once and BOTH must be released:
 *   - currentManager={kind:'strategy'} → the server emits its signals
 *     (pause the bot config so the executor stops acting on them).
 *   - active local trails (position_managers analog) → retire them.
 * A position can have either, both, or neither. Take-over is a no-op only when it
 * is already manual AND has no active managers. Nothing is closed — this only
 * changes WHO manages the exit.
 *
 * Pure function of its input; mirrors planTakeOver in
 * packages/trpc/src/lib/position-control.ts exactly.
 */
export function planTakeOver(input: {
  currentManager: CurrentManager;
  activeManagerCount: number;
}): TakeOverPlan {
  const isStrategy = input.currentManager.kind === 'strategy';
  const hasManagers = input.activeManagerCount > 0;
  return {
    needed: isStrategy || hasManagers || input.currentManager.kind === 'signal_bot',
    deactivateStrategyId: isStrategy
      ? (input.currentManager as { kind: 'strategy'; strategyId: string }).strategyId
      : null,
    retireManagers: hasManagers,
  };
}

/**
 * Derive a bot's current manager pointer from its edge-side state. A running bot
 * config means its strategy run loop owns the exit; a paused/stopped one with no
 * active local trails is manual. Used to drive planTakeOver from DB rows.
 */
export function deriveBotManager(input: {
  status: 'running' | 'paused' | 'stopped';
  strategyId: string;
}): CurrentManager {
  return input.status === 'running'
    ? { kind: 'strategy', strategyId: input.strategyId }
    : { kind: 'manual' };
}

/**
 * Guard rail F3: after take-over the bot may NEVER touch that position again.
 * Pausing the bot config alone doesn't enforce that — inbound signals are gated
 * per subscription, not per config — so the signal path asks this before acting
 * on ANY signal (entries, adds AND closes) from a bot with local configs.
 *
 * Blocked when the bot has configs for the signal's symbol and none of them is
 * running (the position was taken over / the bot stopped). Without a symbol
 * match the fully-detached fallback applies: every config non-running blocks
 * the whole bot (covers canonical-vs-venue symbol drift for single-market
 * bots). A bot with no local configs (pure signal-bot subscription) is never
 * blocked here — the subscription gate owns those.
 */
export function botConfigsBlockSignal(
  configs: Array<{ symbol: string; status: 'running' | 'paused' | 'stopped' }>,
  signalSymbol: string,
): boolean {
  if (configs.length === 0) return false;
  const matching = configs.filter(
    (c) => c.symbol.toUpperCase() === signalSymbol.toUpperCase(),
  );
  if (matching.length > 0) return matching.every((c) => c.status !== 'running');
  return configs.every((c) => c.status !== 'running');
}

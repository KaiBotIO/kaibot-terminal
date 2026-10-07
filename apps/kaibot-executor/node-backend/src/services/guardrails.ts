// Opt-in auto-guardrails — the USER's own pre-set safety rails, enforced LOCALLY.
//
// PHILOSOPHY: these are limits the user pre-decided (opt-in, default-off, clearly
// labelled). The executor only ENFORCES them; it never decides a strategy. Think
// of it as the same kind of safety rail an exchange runs for liquidation
// protection — a hard stop the user asked for, not a trading opinion. They live
// in the executor (not the cloud) on purpose: the executor holds the keys and
// talks to the exchange directly, so the rails still bite when the cloud / WS is
// down. Default-off everywhere so turning a rail on is the only thing that ever
// changes behaviour.
//
// Three rails, all per (exchange, account), all extensions of the migration-015
// margin guard config:
//   • max daily loss          → realized P&L since 00:00 UTC breaches the limit
//                               ⇒ flatten all + halt (handled by the caller).
//   • max concurrent positions → refuse a new open that would exceed the count.
//   • max total notional       → refuse a new open that would exceed exposure.
//
// The math here is pure (no I/O) so it's unit tested; the DB resolver lives in
// margin-guard.ts alongside effectiveMarginGuard.

export interface GuardrailsConfig {
  // Max realized loss per UTC day before flatten+halt. 0 = disabled. The value is
  // a positive loss magnitude: realized P&L breaching -maxDailyLoss trips it.
  maxDailyLoss: number
  // Max number of distinct open positions on the account. 0 = disabled.
  maxConcurrentPositions: number
  // Max total notional exposure on the account (post-open). 0 = disabled.
  maxTotalNotional: number
}

// Built-in defaults: every rail off. Turning one on is opt-in, so a fresh
// account never silently refuses or flattens.
export const DEFAULT_GUARDRAILS: GuardrailsConfig = {
  maxDailyLoss: 0,
  maxConcurrentPositions: 0,
  maxTotalNotional: 0,
}

export interface ConcurrencyCheck {
  ok: boolean
  enabled: boolean
  openCount: number // distinct open positions before the new open
  limit: number
  // Whether the new open lands on a symbol that already has a live position.
  // Adding to an existing position doesn't raise the concurrent-position count,
  // so it's allowed even at the limit.
  addsToExisting: boolean
}

/**
 * Would opening on `newSymbol` push the account past `maxConcurrentPositions`
 * distinct open positions? Scaling into a symbol that already has a position
 * doesn't add a new concurrent position, so it passes even at the cap. Disabled
 * (limit 0) always passes.
 */
export function checkConcurrency(
  cfg: GuardrailsConfig,
  openSymbols: readonly string[],
  newSymbol: string,
): ConcurrencyCheck {
  const limit = cfg.maxConcurrentPositions
  const norm = (s: string) => s.toLowerCase()
  const distinct = new Set(openSymbols.map(norm))
  const openCount = distinct.size
  const addsToExisting = distinct.has(norm(newSymbol))
  if (limit <= 0) {
    return { ok: true, enabled: false, openCount, limit, addsToExisting }
  }
  // At/over the cap, only adds to an already-open symbol are allowed (they don't
  // increase the count). A brand-new symbol would make it openCount + 1.
  const ok = addsToExisting || openCount < limit
  return { ok, enabled: true, openCount, limit, addsToExisting }
}

export interface NotionalCheck {
  ok: boolean
  enabled: boolean
  currentNotional: number // total open notional before the new open
  orderNotional: number // notional the new open adds
  afterNotional: number // total after the new open
  limit: number
}

/**
 * Would the new open push total account notional past `maxTotalNotional`?
 * `currentNotional` is the summed |size × price| of existing open positions in
 * the same currency as the limit; `orderNotional` is the new open's notional in
 * that currency. Disabled (limit 0) always passes.
 */
export function checkNotional(
  cfg: GuardrailsConfig,
  currentNotional: number,
  orderNotional: number,
): NotionalCheck {
  const limit = cfg.maxTotalNotional
  const afterNotional = currentNotional + orderNotional
  if (limit <= 0) {
    return { ok: true, enabled: false, currentNotional, orderNotional, afterNotional, limit }
  }
  return { ok: afterNotional <= limit, enabled: true, currentNotional, orderNotional, afterNotional, limit }
}

export interface DailyLossCheck {
  ok: boolean // true = within the loss budget (no trip)
  enabled: boolean
  realized: number // realized P&L since 00:00 UTC (negative = a loss)
  limit: number // configured max loss magnitude (positive)
  breached: boolean // realized <= -limit
}

/**
 * Has realized P&L since 00:00 UTC breached the daily-loss limit? `realized` is
 * signed (a loss is negative); the limit is a positive magnitude. Breaches when
 * realized <= -limit. Disabled (limit 0) never trips. The caller acts on a breach
 * (flatten all + halt); this only detects it.
 */
export function checkDailyLoss(cfg: GuardrailsConfig, realized: number): DailyLossCheck {
  const limit = cfg.maxDailyLoss
  if (limit <= 0) {
    return { ok: true, enabled: false, realized, limit, breached: false }
  }
  const breached = realized <= -limit
  return { ok: !breached, enabled: true, realized, limit, breached }
}

/** Any rail switched on? Used to skip all guardrail work when fully default-off. */
export function guardrailsActive(cfg: GuardrailsConfig): boolean {
  return cfg.maxDailyLoss > 0 || cfg.maxConcurrentPositions > 0 || cfg.maxTotalNotional > 0
}

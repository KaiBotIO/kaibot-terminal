// Armed (dynamic) synthetic USD guard: the operator authors a price trigger up
// front; the synthetic short is only minted — through the normal synthetic-USD
// mint path — once the mark breaches it. Until then the holdings keep their
// full upside, and the row counts as a CONDITIONAL USD floor (holdings ×
// trigger). An optional recovery level unwinds the short and re-arms the row.
//
// Same carve-out as the hedge guard: edge execution of a pre-authorized
// protective instruction, no server signal, no autonomous decision. State
// lives only in the synthetic_usd_positions row (status 'armed' + arm_*
// columns), so a restart resumes exactly where it left off.
//
// Sizing: the short notional is holdings_coin × TRIGGER (Kai: the protected
// value is defined at the trigger, not at the fire-time mark). Fills are market
// orders (stop-market semantics): a gap through the trigger fills lower and the
// realized floor is holdings × fill — recorded honestly in the mutation meta.

import type { KaiBotDatabase } from '../storage/database.js'
import type { SyntheticUsdPositionRow } from '../storage/types.js'
import type { ExchangeManager } from './exchanges/exchangeManager.js'
import type { ExchangeAdapter, Position } from './exchanges/types.js'
import type { NotificationBus } from './notifications/notification-bus.js'
import { getContractConstraints } from './exchanges/contract-constraints.js'
import { isInverseContract } from '@kaibot/types/core'
import { accountKeyOf, adapterAccountKey, normalizeConnectionLabel, scopeAccountId } from './exchanges/account-scope.js'
import { DEFAULT_SYNTHETIC_USD_LEVERAGE_CAP, type SyntheticUsdService } from './synthetic-usd.js'

export type ArmDirection = 'long' | 'short'

export interface SyntheticArmInput {
  exchange: string
  // Venue account ('btc') or namespaced ('acct1/btc'). With accountKey set, a
  // bare id is namespaced onto that connection.
  accountId: string
  // Connection label (multi-connection venues); undefined/'default' = the
  // default connection. Must name a connected session.
  accountKey?: string | null
  symbol: string
  triggerPrice: number
  // Holdings in coin units. Omit to derive from the USD holdings basis / mark.
  holdingsCoin?: number
  // v1 routes only pass 'long' (holdings are long by nature).
  direction?: ArmDirection
  trailPct?: number | null
  trailAbs?: number | null
  recoveryPrice?: number | null
  recoveryPct?: number | null
  tolerancePct?: number
  leverageCap?: number
}

export interface SyntheticArmUpdate {
  triggerPrice?: number
  holdingsCoin?: number
  trailPct?: number | null
  trailAbs?: number | null
  recoveryPrice?: number | null
  recoveryPct?: number | null
  tolerancePct?: number
}

export interface ArmedView {
  // The row is in an arm cycle (armed, or open after a trigger mint).
  inCycle: boolean
  direction: ArmDirection | null
  triggerPrice: number | null
  triggerPriceInitial: number | null
  holdingsCoin: number | null
  // holdings × trigger while armed; holdings × fill once minted.
  protectedUsd: number | null
  protection: 'planned' | 'realized' | null
  mark: number | null
  markAt: number | null
  // Signed: positive = mark still on the safe side of the trigger.
  distanceToTriggerPct: number | null
  // Value above the floor still riding the market (armed only; 0 once locked).
  upsideUsd: number | null
  // Open arm-cycle rows: short notional − holdings × fill. Positive after a
  // gap (the trigger-sized short exceeds what the fill locked).
  overHedgeUsd: number | null
  trailPct: number | null
  trailAbs: number | null
  highWater: number | null
  recoveryPrice: number | null
  recoveryPct: number | null
  // Resolved recovery level for the current cycle (open rows only).
  recoveryLevel: number | null
  tolerancePct: number
  firedTriggerPrice: number | null
  firedPrice: number | null
  firedAt: number | null
  cycle: number
  armedAt: number | null
  lastError: string | null
}

export interface SyntheticGuardService {
  arm(input: SyntheticArmInput): Promise<SyntheticUsdPositionRow>
  updateArm(id: string, patch: SyntheticArmUpdate): SyntheticUsdPositionRow
  disarm(id: string): SyntheticUsdPositionRow
  view(row: SyntheticUsdPositionRow): ArmedView
  /** Exchanges with at least one arm-cycle row (for the tick loop's fetch set). */
  activeExchanges(): string[]
  /** Drive every arm-cycle row on one exchange with this cycle's positions. */
  tickExchange(exchange: string, adapter: ExchangeAdapter, positions: Position[]): Promise<void>
}

// ── Pure rules (unit-testable, DB/adapter-free) ─────────────────────────────

// Adverse breach with an optional wick margin: long holdings fire when the
// mark drops below trigger × (1 − tolerance%). Tolerance 0 = plain breach.
export function armedBreached(
  direction: ArmDirection,
  mark: number,
  triggerPrice: number,
  tolerancePct = 0,
): boolean {
  const tol = Math.max(0, tolerancePct) / 100
  return direction === 'long'
    ? mark < triggerPrice * (1 - tol)
    : mark > triggerPrice * (1 + tol)
}

// Ratchet: the trigger follows the market's favourable extreme at a fixed
// distance and never moves back. Returns the unchanged inputs without a trail.
export function ratchetTrigger(
  input: {
    direction: ArmDirection
    triggerPrice: number
    highWater: number | null
    trailPct: number | null
    trailAbs: number | null
  },
  mark: number,
): { triggerPrice: number; highWater: number } {
  const favourable = input.direction === 'long' ? Math.max : Math.min
  const highWater = input.highWater == null ? mark : favourable(input.highWater, mark)
  let candidate = input.triggerPrice
  if (input.trailPct != null && input.trailPct > 0) {
    const f = input.trailPct / 100
    candidate = input.direction === 'long' ? highWater * (1 - f) : highWater * (1 + f)
  } else if (input.trailAbs != null && input.trailAbs > 0) {
    candidate = input.direction === 'long' ? highWater - input.trailAbs : highWater + input.trailAbs
  }
  const triggerPrice = favourable(input.triggerPrice, candidate)
  return { triggerPrice, highWater }
}

// Recovery level for the cycle that fired at `firedTrigger`: an explicit price
// wins, else trigger ± pct. Null = no automatic unwind.
export function resolveRecoveryLevel(input: {
  direction: ArmDirection
  firedTriggerPrice: number | null
  recoveryPrice: number | null
  recoveryPct: number | null
}): number | null {
  if (input.recoveryPrice != null && input.recoveryPrice > 0) return input.recoveryPrice
  // recoveryPct 0 = unwind as soon as the mark is back on the safe side of the
  // trigger (the bc-macro-C regime-line config).
  if (input.recoveryPct != null && input.recoveryPct >= 0 && input.firedTriggerPrice != null) {
    const f = input.recoveryPct / 100
    return input.direction === 'long'
      ? input.firedTriggerPrice * (1 + f)
      : input.firedTriggerPrice * (1 - f)
  }
  return null
}

// Recovery past the level in the holdings' favourable direction.
export function recoveryReached(direction: ArmDirection, mark: number, level: number): boolean {
  return direction === 'long' ? mark > level : mark < level
}

export function plannedUsd(holdingsCoin: number, triggerPrice: number): number {
  return Math.max(0, holdingsCoin) * Math.max(0, triggerPrice)
}

// Display numbers for a row. `mark` overrides the stored last mark.
export function armedView(row: SyntheticUsdPositionRow, mark?: number | null): ArmedView {
  const inCycle = row.arm_trigger_price != null && (row.status === 'armed' || row.status === 'open')
  const direction = (row.arm_direction ?? 'long') as ArmDirection
  const m = mark ?? row.arm_last_mark ?? null
  const trigger = row.arm_trigger_price
  const coin = row.arm_holdings_coin
  let protectedUsd: number | null = null
  let protection: ArmedView['protection'] = null
  let upsideUsd: number | null = null
  let overHedgeUsd: number | null = null
  if (inCycle && trigger != null && coin != null) {
    if (row.status === 'armed') {
      protectedUsd = plannedUsd(coin, trigger)
      protection = 'planned'
      if (m != null) upsideUsd = direction === 'long' ? coin * (m - trigger) : coin * (trigger - m)
    } else {
      const fill = row.arm_fired_price ?? row.arm_fired_trigger_price ?? trigger
      protectedUsd = coin * fill
      protection = 'realized'
      upsideUsd = 0
      overHedgeUsd = row.target_usd - coin * fill
    }
  }
  let distanceToTriggerPct: number | null = null
  if (inCycle && trigger != null && m != null && m > 0) {
    distanceToTriggerPct = direction === 'long' ? ((m - trigger) / m) * 100 : ((trigger - m) / m) * 100
  }
  const recoveryLevel =
    inCycle && row.status === 'open'
      ? resolveRecoveryLevel({
          direction,
          firedTriggerPrice: row.arm_fired_trigger_price ?? trigger,
          recoveryPrice: row.arm_recovery_price,
          recoveryPct: row.arm_recovery_pct,
        })
      : null
  return {
    inCycle,
    direction: inCycle ? direction : null,
    triggerPrice: trigger,
    triggerPriceInitial: row.arm_trigger_price_initial,
    holdingsCoin: coin,
    protectedUsd,
    protection,
    mark: m,
    markAt: mark != null ? Date.now() : row.arm_last_mark_at,
    distanceToTriggerPct,
    upsideUsd,
    overHedgeUsd,
    trailPct: row.arm_trail_pct,
    trailAbs: row.arm_trail_abs,
    highWater: row.arm_high_water,
    recoveryPrice: row.arm_recovery_price,
    recoveryPct: row.arm_recovery_pct,
    recoveryLevel,
    tolerancePct: row.arm_tolerance_pct ?? 0,
    firedTriggerPrice: row.arm_fired_trigger_price,
    firedPrice: row.arm_fired_price,
    firedAt: row.arm_fired_at,
    cycle: row.arm_cycle ?? 0,
    armedAt: row.arm_armed_at,
    lastError: row.arm_last_error,
  }
}

// ── Service ─────────────────────────────────────────────────────────────────

const positive = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n > 0

function validateOptional(name: string, v: number | null | undefined) {
  if (v == null) return
  if (!positive(v)) throw new Error(`${name} must be a positive number`)
}

export function createSyntheticGuardService(
  db: KaiBotDatabase,
  exchangeManager: ExchangeManager,
  service: SyntheticUsdService,
  notifications: NotificationBus | null = null,
  userId = 'default',
): SyntheticGuardService {
  // Rows with an order in flight this process: overlapping ticks must not fire
  // the same row twice (the order lock serializes orders but would let a
  // second mint through after the first one's status flip).
  const inflight = new Set<string>()

  // Mark from the row's own connection (accountKeyOf routes a namespaced
  // account id to its labeled session; a bare id = the default connection).
  async function markFor(
    exchange: string,
    accountId: string | null | undefined,
    symbol: string,
    adapter?: ExchangeAdapter,
  ): Promise<number | null> {
    try {
      let a = adapter
      if (!a) {
        const session = await exchangeManager.getSession(userId, exchange, accountKeyOf(accountId))
        if (!session || session.status !== 'connected') return null
        a = session.adapter
      }
      const p = await a.getLastPrice?.(symbol)
      return p != null && p > 0 ? p : null
    } catch {
      return null
    }
  }

  function notifyOnce(row: SyntheticUsdPositionRow, error: string, title: string) {
    if (row.arm_last_error !== error) {
      notifications?.publish({
        type: 'synthetic_armed_failed',
        title,
        body: `${row.symbol}: ${error}`,
        data: { positionId: row.id, symbol: row.symbol, error },
      })
    }
    db.updateSyntheticUsdPosition(row.id, { arm_last_error: error })
  }

  function validateConfig(cfg: {
    triggerPrice: number
    holdingsCoin: number
    trailPct: number | null
    trailAbs: number | null
    recoveryPrice: number | null
    recoveryPct: number | null
    tolerancePct: number
    direction: ArmDirection
  }) {
    if (!positive(cfg.triggerPrice)) throw new Error('triggerPrice must be a positive number')
    if (!positive(cfg.holdingsCoin)) throw new Error('holdingsCoin must be a positive number')
    validateOptional('trailPct', cfg.trailPct)
    validateOptional('trailAbs', cfg.trailAbs)
    validateOptional('recoveryPrice', cfg.recoveryPrice)
    if (cfg.recoveryPct != null && !(Number.isFinite(cfg.recoveryPct) && cfg.recoveryPct >= 0)) {
      throw new Error('recoveryPct must be zero or a positive number')
    }
    if (cfg.trailPct != null && cfg.trailAbs != null) {
      throw new Error('set trailPct or trailAbs, not both')
    }
    if (cfg.trailPct != null && cfg.trailPct >= 100) throw new Error('trailPct must be below 100')
    if (!(Number.isFinite(cfg.tolerancePct) && cfg.tolerancePct >= 0 && cfg.tolerancePct < 100)) {
      throw new Error('tolerancePct must be between 0 and 100')
    }
    if (cfg.recoveryPrice != null) {
      const ok = cfg.direction === 'long' ? cfg.recoveryPrice > cfg.triggerPrice : cfg.recoveryPrice < cfg.triggerPrice
      if (!ok) throw new Error('recoveryPrice must sit on the favourable side of the trigger')
    }
  }

  // Cap on THIS row's collateral only: the declared coin valued at the mark
  // (never the summed basis, so a BTC row is never capped by ETH holdings and
  // vice versa). Without a mark the trigger stands in (leverage 1).
  function accountBasisUsd(holdingsCoin: number, triggerPrice: number, mark: number | null) {
    return holdingsCoin * (mark ?? triggerPrice)
  }
  function checkCap(holdingsCoin: number, triggerPrice: number, mark: number | null, leverageCap: number) {
    const planned = plannedUsd(holdingsCoin, triggerPrice)
    const basis = accountBasisUsd(holdingsCoin, triggerPrice, mark)
    if (basis > 0 && planned > basis * leverageCap) {
      throw new Error(
        `planned notional $${Math.round(planned)} exceeds the ${leverageCap}x cap on this account's $${Math.round(basis)} holdings (trigger ${triggerPrice} vs mark ${mark})`,
      )
    }
  }

  // Deribit: perpetuals only. A dated inverse future expires under the short
  // and is not rolled by the guard.
  function checkInstrument(exchange: string, symbol: string) {
    if (exchange.toLowerCase() === 'deribit' && !/-PERPETUAL$/i.test(symbol)) {
      throw new Error('armed synthetic supports Deribit perpetuals only (BTC-PERPETUAL, BTC_USDC-PERPETUAL, …)')
    }
  }

  // Connection routing: resolve (accountKey, accountId) to the namespaced
  // account id the row will carry, and refuse a label with no session.
  async function resolveAccountId(exchange: string, accountId: string, accountKey: unknown): Promise<string> {
    const key = normalizeConnectionLabel(accountKey)
    const idKey = accountKeyOf(accountId)
    if (idKey && key && idKey !== key) {
      throw new Error(`accountId belongs to connection "${idKey}", not "${key}"`)
    }
    const effective = key ?? idKey
    if (effective && typeof exchangeManager.getSession === 'function') {
      const session = await exchangeManager.getSession(userId, exchange, effective)
      if (!session) throw new Error(`no "${effective}" connection on ${exchange}`)
    }
    return scopeAccountId(effective, accountId)
  }

  async function arm(raw: SyntheticArmInput): Promise<SyntheticUsdPositionRow> {
    const input: SyntheticArmInput = {
      ...raw,
      accountId: await resolveAccountId(raw.exchange, raw.accountId, raw.accountKey),
    }
    const direction: ArmDirection = input.direction ?? 'long'
    const existing = db.getLiveSyntheticUsdPosition(input.exchange, input.accountId, input.symbol)
    if (existing?.status === 'armed') {
      throw new Error('this market is already armed — update or disarm it first')
    }
    if (existing?.status === 'open' && existing.arm_trigger_price != null) {
      throw new Error('this position is already in an arm cycle — update or disarm it first')
    }

    checkInstrument(input.exchange, input.symbol)
    const mark = await markFor(input.exchange, input.accountId, input.symbol)
    let holdingsCoin = input.holdingsCoin
    if (holdingsCoin == null) {
      // Derive from THIS account's venue basis line at today's mark (never the
      // summed basis). No line for the account → the operator must pass the coin.
      const line = db
        .listHoldingsBasis()
        .find((l) => !l.is_manual && l.source === `${input.exchange}:${input.accountId}`)
      if (!line || !(line.usd_value > 0)) {
        throw new Error(`no venue holdings line for ${input.exchange}:${input.accountId} — pass holdingsCoin explicitly`)
      }
      if (mark == null) throw new Error(`no mark for ${input.symbol} — pass holdingsCoin explicitly`)
      holdingsCoin = line.usd_value / mark
    }
    const cfg = {
      triggerPrice: input.triggerPrice,
      holdingsCoin,
      trailPct: input.trailPct ?? null,
      trailAbs: input.trailAbs ?? null,
      recoveryPrice: input.recoveryPrice ?? null,
      recoveryPct: input.recoveryPct ?? null,
      tolerancePct: input.tolerancePct ?? 0,
      direction,
    }
    validateConfig(cfg)
    const leverageCap = input.leverageCap ?? existing?.leverage_cap ?? DEFAULT_SYNTHETIC_USD_LEVERAGE_CAP
    if (!positive(leverageCap)) throw new Error('leverageCap must be a positive number')
    const planned = plannedUsd(holdingsCoin, input.triggerPrice)
    checkCap(holdingsCoin, input.triggerPrice, mark, leverageCap)
    const now = Date.now()

    if (existing) {
      // Migration path: attach the cycle to an already-minted short. It counts
      // as fired at the trigger; recovery unwinds it and re-arms at the trigger.
      db.updateSyntheticUsdPosition(existing.id, {
        leverage_cap: leverageCap,
        auto_rebalance: 0,
        arm_direction: direction,
        arm_trigger_price: input.triggerPrice,
        arm_trigger_price_initial: input.triggerPrice,
        arm_holdings_coin: holdingsCoin,
        arm_planned_usd: planned,
        arm_trail_pct: cfg.trailPct,
        arm_trail_abs: cfg.trailAbs,
        arm_high_water: mark,
        arm_recovery_price: cfg.recoveryPrice,
        arm_recovery_pct: cfg.recoveryPct,
        arm_tolerance_pct: cfg.tolerancePct,
        arm_fired_trigger_price: input.triggerPrice,
        arm_fired_price: mark,
        arm_fired_at: now,
        arm_cycle: 1,
        arm_armed_at: now,
        arm_last_mark: mark,
        arm_last_mark_at: mark != null ? now : null,
        arm_last_error: null,
      })
      db.insertSyntheticUsdMutation({
        position_id: existing.id,
        kind: 'arm',
        target_usd_before: existing.target_usd,
        target_usd_after: existing.target_usd,
        short_size_before: existing.short_size,
        short_size_after: existing.short_size,
        meta: { attached: true, trigger: input.triggerPrice, holdingsCoin, plannedUsd: planned, mark },
      })
      db.log('info', 'trading', 'Synthetic arm attached to open position', {
        id: existing.id, symbol: existing.symbol, triggerPrice: input.triggerPrice, plannedUsd: planned,
      })
      return db.getSyntheticUsdPosition(existing.id)!
    }

    const id = crypto.randomUUID()
    db.insertSyntheticUsdPosition({
      id,
      exchange: input.exchange,
      account_id: input.accountId,
      symbol: input.symbol,
      target_usd: 0,
      holdings_basis_usd: accountBasisUsd(holdingsCoin, input.triggerPrice, mark),
      leverage: 0,
      short_size: 0,
      leverage_cap: leverageCap,
      status: 'armed',
    })
    db.updateSyntheticUsdPosition(id, {
      arm_direction: direction,
      arm_trigger_price: input.triggerPrice,
      arm_trigger_price_initial: input.triggerPrice,
      arm_holdings_coin: holdingsCoin,
      arm_planned_usd: planned,
      arm_trail_pct: cfg.trailPct,
      arm_trail_abs: cfg.trailAbs,
      arm_high_water: mark,
      arm_recovery_price: cfg.recoveryPrice,
      arm_recovery_pct: cfg.recoveryPct,
      arm_tolerance_pct: cfg.tolerancePct,
      arm_cycle: 0,
      arm_armed_at: now,
      arm_last_mark: mark,
      arm_last_mark_at: mark != null ? now : null,
    })
    db.insertSyntheticUsdMutation({
      position_id: id,
      kind: 'arm',
      target_usd_before: 0,
      target_usd_after: 0,
      short_size_before: 0,
      short_size_after: 0,
      meta: { trigger: input.triggerPrice, holdingsCoin, plannedUsd: planned, mark },
    })
    db.log('info', 'trading', 'Synthetic USD armed', {
      id, symbol: input.symbol, triggerPrice: input.triggerPrice, plannedUsd: planned,
    })
    return db.getSyntheticUsdPosition(id)!
  }

  function updateArm(id: string, patch: SyntheticArmUpdate): SyntheticUsdPositionRow {
    const row = db.getSyntheticUsdPosition(id)
    if (!row || row.arm_trigger_price == null || (row.status !== 'armed' && row.status !== 'open')) {
      throw new Error('position is not in an arm cycle')
    }
    if (row.status === 'open' && (patch.triggerPrice != null || patch.holdingsCoin != null)) {
      // The short is live: only the wind-down / re-arm knobs may move.
      throw new Error('short is open — only recovery, trail and tolerance can be updated')
    }
    const direction = (row.arm_direction ?? 'long') as ArmDirection
    const cfg = {
      triggerPrice: patch.triggerPrice ?? row.arm_trigger_price,
      holdingsCoin: patch.holdingsCoin ?? row.arm_holdings_coin ?? 0,
      trailPct: patch.trailPct !== undefined ? patch.trailPct : row.arm_trail_pct,
      trailAbs: patch.trailAbs !== undefined ? patch.trailAbs : row.arm_trail_abs,
      recoveryPrice: patch.recoveryPrice !== undefined ? patch.recoveryPrice : row.arm_recovery_price,
      recoveryPct: patch.recoveryPct !== undefined ? patch.recoveryPct : row.arm_recovery_pct,
      tolerancePct: patch.tolerancePct ?? row.arm_tolerance_pct ?? 0,
      direction,
    }
    validateConfig(cfg)
    const planned = plannedUsd(cfg.holdingsCoin, cfg.triggerPrice)
    if (row.status === 'armed') {
      checkCap(cfg.holdingsCoin, cfg.triggerPrice, row.arm_last_mark, row.leverage_cap ?? DEFAULT_SYNTHETIC_USD_LEVERAGE_CAP)
    }
    const triggerMoved = patch.triggerPrice != null && patch.triggerPrice !== row.arm_trigger_price
    db.updateSyntheticUsdPosition(id, {
      arm_trigger_price: cfg.triggerPrice,
      // An explicit new trigger restarts the ratchet from the next mark.
      arm_trigger_price_initial: triggerMoved ? cfg.triggerPrice : row.arm_trigger_price_initial,
      arm_high_water: triggerMoved ? null : row.arm_high_water,
      arm_holdings_coin: cfg.holdingsCoin,
      arm_planned_usd: row.status === 'armed' ? planned : row.arm_planned_usd,
      arm_trail_pct: cfg.trailPct,
      arm_trail_abs: cfg.trailAbs,
      arm_recovery_price: cfg.recoveryPrice,
      arm_recovery_pct: cfg.recoveryPct,
      arm_tolerance_pct: cfg.tolerancePct,
      arm_last_error: null,
    })
    db.insertSyntheticUsdMutation({
      position_id: id,
      kind: 'arm_update',
      target_usd_before: row.target_usd,
      target_usd_after: row.target_usd,
      short_size_before: row.short_size,
      short_size_after: row.short_size,
      meta: { ...patch, plannedUsd: planned },
    })
    return db.getSyntheticUsdPosition(id)!
  }

  function disarm(id: string): SyntheticUsdPositionRow {
    const row = db.getSyntheticUsdPosition(id)
    if (!row || row.arm_trigger_price == null || (row.status !== 'armed' && row.status !== 'open')) {
      throw new Error('position is not in an arm cycle')
    }
    if (row.status === 'armed') {
      // Nothing was ever minted: the row retires without an order. A retired
      // row can no longer be the sizing basis — signals on the account fall
      // back to plain contract sizing, which is worth a loud warning.
      if (row.is_factor_basis === 1) {
        db.setSyntheticUsdFactorBasis(id, false)
        db.log('warn', 'trading', 'Synthetic sizing basis removed by disarm — signals fall back to contract sizing', {
          id, exchange: row.exchange, account: row.account_id, plannedUsd: row.arm_planned_usd,
        })
        notifications?.publish({
          type: 'error',
          title: 'Synthetic sizing basis removed',
          body: `${row.symbol} on ${row.exchange}·${row.account_id} was disarmed while it was the sizing basis. Signals on this account now size in plain contracts.`,
          data: { positionId: id, exchange: row.exchange, account: row.account_id },
        })
      }
      db.updateSyntheticUsdPosition(id, { status: 'closed', arm_last_error: null })
      db.insertSyntheticUsdMutation({
        position_id: id,
        kind: 'disarm',
        target_usd_before: 0,
        target_usd_after: 0,
        short_size_before: 0,
        short_size_after: 0,
        meta: { retired: true, trigger: row.arm_trigger_price },
      })
      db.log('info', 'trading', 'Synthetic USD disarmed', { id, symbol: row.symbol })
      return db.getSyntheticUsdPosition(id)!
    }
    // The short stays: the row becomes a plain open synthetic (close it via
    // the normal close if the short must go too).
    db.updateSyntheticUsdPosition(id, {
      arm_direction: null,
      arm_trigger_price: null,
      arm_trigger_price_initial: null,
      arm_holdings_coin: null,
      arm_planned_usd: null,
      arm_trail_pct: null,
      arm_trail_abs: null,
      arm_high_water: null,
      arm_recovery_price: null,
      arm_recovery_pct: null,
      arm_fired_trigger_price: null,
      arm_fired_price: null,
      arm_fired_at: null,
      arm_last_error: null,
    })
    db.insertSyntheticUsdMutation({
      position_id: id,
      kind: 'disarm',
      target_usd_before: row.target_usd,
      target_usd_after: row.target_usd,
      short_size_before: row.short_size,
      short_size_after: row.short_size,
      meta: { detached: true, shortKept: true, trigger: row.arm_trigger_price },
    })
    db.log('info', 'trading', 'Synthetic arm detached (short kept)', { id, symbol: row.symbol })
    return db.getSyntheticUsdPosition(id)!
  }

  function view(row: SyntheticUsdPositionRow): ArmedView {
    return armedView(row)
  }

  function activeExchanges(): string[] {
    return [...new Set(db.listArmCycleSyntheticUsdPositions().map((r) => r.exchange))]
  }

  function liveNetShort(positions: Position[], row: SyntheticUsdPositionRow): number {
    let net = 0
    for (const p of positions) {
      if (p.symbol.toLowerCase() !== row.symbol.toLowerCase()) continue
      if (p.accountId && row.account_id && p.accountId !== row.account_id) continue
      net += p.side === 'short' ? Math.abs(p.size) : -Math.abs(p.size)
    }
    return net
  }

  // The executor's own open bot/manual book on the instrument (long +,
  // short −). The strategies trade the same inverse perp the synthetic hedges
  // on and the venue nets them into one position (2026-09-08 inverse switch),
  // so the venue net alone says nothing about the synthetic's own short.
  // Defensive on the db surface (test doubles).
  function ownBookNet(row: SyntheticUsdPositionRow): number {
    const lister = (db as Partial<KaiBotDatabase>).listOpenExecutionsForExchange
    if (typeof lister !== 'function') return 0
    let net = 0
    for (const e of lister.call(db, row.exchange)) {
      if (String(e.symbol).toLowerCase() !== row.symbol.toLowerCase()) continue
      if (e.account_id && row.account_id && e.account_id !== row.account_id) continue
      const q = e.status === 'open' || e.status === 'closing' ? Math.max(0, e.qty_opened - e.qty_closed) : 0
      if (q <= 0) continue
      net += e.direction === 'long' ? q : -q
    }
    return net
  }

  // The short the synthetic itself holds at the venue: the venue net short
  // plus whatever the executor's own book explains (a bot long hides part of
  // the synthetic short, a bot short inflates it). Anything left over is
  // activity the executor does not know about.
  function syntheticShortAtVenue(positions: Position[], row: SyntheticUsdPositionRow): number {
    return liveNetShort(positions, row) + ownBookNet(row)
  }

  async function tickExchange(
    exchange: string,
    adapter: ExchangeAdapter,
    positions: Position[],
  ): Promise<void> {
    // Only this connection's rows: the adapter/positions belong to one
    // connection; a row on another connection would read the wrong mark and
    // the wrong (flat) instrument.
    const connectionKey = adapterAccountKey(adapter)
    const rows = db
      .listArmCycleSyntheticUsdPositions()
      .filter(
        (r) =>
          r.exchange.toLowerCase() === exchange.toLowerCase() &&
          accountKeyOf(r.account_id) === connectionKey,
      )
    for (const row of rows) {
      if (inflight.has(row.id)) continue
      try {
        // Mark: a live position on the instrument carries one; else ask the venue.
        const live = positions.find(
          (p) => p.symbol.toLowerCase() === row.symbol.toLowerCase() && p.markPrice != null && p.markPrice > 0,
        )
        const mark = live?.markPrice ?? (await markFor(row.exchange, row.account_id, row.symbol, adapter))
        if (mark == null) continue
        if (row.status === 'armed') {
          await tickArmed(row, mark, positions)
        } else {
          await tickOpen(row, mark, positions)
        }
      } catch (err: any) {
        db.log('error', 'trading', 'Synthetic guard tick failed', { id: row.id, error: err?.message })
      }
    }
  }

  async function tickArmed(row: SyntheticUsdPositionRow, mark: number, positions: Position[]) {
    const direction = (row.arm_direction ?? 'long') as ArmDirection
    const now = Date.now()
    const r = ratchetTrigger(
      {
        direction,
        triggerPrice: row.arm_trigger_price!,
        highWater: row.arm_high_water,
        trailPct: row.arm_trail_pct,
        trailAbs: row.arm_trail_abs,
      },
      mark,
    )
    const coin = row.arm_holdings_coin ?? 0
    const patch: Parameters<KaiBotDatabase['updateSyntheticUsdPosition']>[1] = {
      arm_last_mark: mark,
      arm_last_mark_at: now,
    }
    if (r.triggerPrice !== row.arm_trigger_price || r.highWater !== row.arm_high_water) {
      patch.arm_trigger_price = r.triggerPrice
      patch.arm_high_water = r.highWater
      patch.arm_planned_usd = plannedUsd(coin, r.triggerPrice)
    }
    db.updateSyntheticUsdPosition(row.id, patch)
    const trigger = r.triggerPrice
    if (!armedBreached(direction, mark, trigger, row.arm_tolerance_pct ?? 0)) return

    // Restart safety: a short already standing on the instrument that matches
    // the plan is OUR mint whose persist never happened — adopt it. Any other
    // live position on the instrument blocks the mint (it would net against
    // it, the runbook's synthetic-mint conflict); the operator resolves.
    const fresh = db.getSyntheticUsdPosition(row.id)
    if (!fresh || fresh.status !== 'armed') return
    const { stepSize } = getContractConstraints(row.exchange, row.symbol)
    const net = syntheticShortAtVenue(positions, row)
    const planned = fresh.arm_planned_usd ?? plannedUsd(coin, trigger)
    const plannedNative = isInverseContract(row.exchange, row.symbol) ? planned : planned / mark
    if (net > 0 && Math.abs(net - plannedNative) <= Math.max(stepSize, plannedNative * 0.02)) {
      const adopted = service.adoptArmed(row.id, net, { mark })
      db.log('warn', 'trading', 'Synthetic armed mint adopted from live short (restart)', {
        id: row.id, symbol: row.symbol, liveShort: net,
      })
      notifications?.publish({
        type: 'synthetic_armed_minted',
        title: 'Synthetic USD minted (adopted)',
        body: `${row.symbol}: a matching short was already live — booked it as the armed mint.`,
        data: { positionId: row.id, symbol: row.symbol, shortSize: adopted.short_size },
      })
      return
    }
    if (Math.abs(net) > Math.max(stepSize / 2, 1e-9)) {
      notifyOnce(fresh, `instrument not flat (unexplained net short ${net}) — mint would net against it`, 'Synthetic mint blocked')
      return
    }

    inflight.add(row.id)
    try {
      const result = await service.mintArmed(row.id, { mark })
      const p = result.position
      db.log('info', 'trading', 'Synthetic USD minted on trigger', {
        id: row.id, symbol: row.symbol, trigger, mark,
        plannedUsd: result.plannedUsd, realizedUsd: result.realizedUsd,
        avgFillPrice: result.avgFillPrice, capped: result.capped,
      })
      notifications?.publish({
        type: 'synthetic_armed_minted',
        title: 'Synthetic USD minted',
        body: `${row.symbol} breached ${trigger} — minted $${Math.round(result.realizedUsd)} (planned $${Math.round(result.plannedUsd)}${result.avgFillPrice ? `, fill ${result.avgFillPrice}` : ''}).`,
        data: {
          positionId: row.id, symbol: row.symbol, trigger, mark,
          plannedUsd: result.plannedUsd, realizedUsd: result.realizedUsd,
          avgFillPrice: result.avgFillPrice, shortSize: p.short_size,
        },
      })
    } catch (err: any) {
      const msg = err?.message ?? String(err)
      db.log('warn', 'trading', 'Synthetic armed mint failed — stays armed', { id: row.id, error: msg })
      const again = db.getSyntheticUsdPosition(row.id)
      if (again) notifyOnce(again, msg, 'Synthetic mint failed')
    } finally {
      inflight.delete(row.id)
    }
  }

  async function tickOpen(row: SyntheticUsdPositionRow, mark: number, positions: Position[]) {
    const direction = (row.arm_direction ?? 'long') as ArmDirection
    db.updateSyntheticUsdPosition(row.id, { arm_last_mark: mark, arm_last_mark_at: Date.now() })
    const level = resolveRecoveryLevel({
      direction,
      firedTriggerPrice: row.arm_fired_trigger_price ?? row.arm_trigger_price,
      recoveryPrice: row.arm_recovery_price,
      recoveryPct: row.arm_recovery_pct,
    })
    if (level == null || !recoveryReached(direction, mark, level)) return
    inflight.add(row.id)
    try {
      const fresh = db.getSyntheticUsdPosition(row.id)
      if (!fresh || fresh.status !== 'open' || fresh.arm_trigger_price == null) return
      // Netting guard (review §4.6): the buy-back is a reduce-only order for
      // the whole recorded short. If strategy or manual activity changed the
      // venue net on this instrument, Deribit would trim the order and the
      // books would drift silently — pause and let the operator resolve.
      const { stepSize } = getContractConstraints(row.exchange, row.symbol)
      const net = syntheticShortAtVenue(positions, row)
      if (Math.abs(net - fresh.short_size) > Math.max(stepSize, fresh.short_size * 0.005)) {
        notifyOnce(
          fresh,
          `venue net short ${net} ≠ recorded ${fresh.short_size} — other activity on the instrument; unwind paused`,
          'Synthetic unwind paused',
        )
        return
      }
      // A bot long on the instrument hides part of the short at the venue: the
      // buy-back must not be reduce-only there (Deribit would trim it).
      const reduceOnly = liveNetShort(positions, row) >= fresh.short_size - Math.max(stepSize / 2, 1e-9)
      const rearmed = await service.closeToArmed(row.id, { mark, recoveryLevel: level, reduceOnly })
      db.log('info', 'trading', 'Synthetic USD unwound on recovery, re-armed', {
        id: row.id, symbol: row.symbol, mark, level, trigger: rearmed.arm_trigger_price,
      })
      notifications?.publish({
        type: 'synthetic_armed_closed',
        title: 'Synthetic USD unwound (recovery)',
        body: `${row.symbol} recovered past ${level} — short bought back, re-armed at ${rearmed.arm_trigger_price}.`,
        data: { positionId: row.id, symbol: row.symbol, mark, level, trigger: rearmed.arm_trigger_price },
      })
    } catch (err: any) {
      const msg = err?.message ?? String(err)
      db.log('warn', 'trading', 'Synthetic recovery close failed — stays open', { id: row.id, error: msg })
      const again = db.getSyntheticUsdPosition(row.id)
      if (again) notifyOnce(again, msg, 'Synthetic unwind failed')
    } finally {
      inflight.delete(row.id)
    }
  }

  return { arm, updateArm, disarm, view, activeExchanges, tickExchange }
}

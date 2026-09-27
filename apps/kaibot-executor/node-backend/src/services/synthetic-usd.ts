// Synthetic USD: a delta-neutral short on an inverse (coin-margined) perpetual
// that locks the USD value of crypto holdings. Tracked as its own entity, fully
// separate from discretionary/signal/bot positions.
//
// On Deribit, BTC-PERPETUAL is quoted in USD and margined in BTC, so the short
// notional in USD *is* the synthetic USD value to hedge — no price conversion is
// needed to size the short itself. The holdings basis (the collateral the 10x
// cap measures against) does need a BTC→USD value, which comes from live
// balances and manual off-exchange lines.

import type { KaiBotDatabase } from '../storage/database.js'
import type { ExchangeManager } from './exchanges/exchangeManager.js'
import type { SyntheticUsdPositionRow, SyntheticUsdRebalanceBasis } from '../storage/types.js'
import { getContractConstraints, roundToStep } from './exchanges/contract-constraints.js'
import { withOrderLock } from './order-lock.js'
import { settleAdapterOrder } from './order-settlement.js'
import { accountKeyOf } from './exchanges/account-scope.js'
import { isInverseContract, usdToNativeSize } from '@kaibot/types/core'

// Default for the user's protective leverage ceiling when they don't set one.
// This is NOT a KaiBot risk decision imposed on the user — it's the starting
// value for a user-authored, user-editable ceiling (see leverage_cap on the
// position). The cap only ever LOWERS the user's own requested target; KaiBot
// never raises a target or injects a tighter bound the user didn't author.
// Seeded at 2 to match the EU retail crypto-derivative standard (ESMA 2:1);
// raising it is a deliberate user choice made in the mint UI (R4).
export const DEFAULT_SYNTHETIC_USD_LEVERAGE_CAP = 2

export interface SizingResult {
  // Target after the leverage cap is applied (may be lower than requested).
  targetUsd: number
  // target / holdings basis. 0 when the basis is 0.
  leverage: number
  // Short notional to hold, rounded to the contract step (USD for inverse).
  shortContracts: number
  // True when the request was reduced to satisfy the cap.
  capped: boolean
}

// Pure sizing: clamp the requested target to the leverage cap, then round the
// short notional to the contract step. Never raises the request.
export function computeSizing(
  requestedUsd: number,
  holdingsBasisUsd: number,
  stepSize: number,
  leverageCap: number = DEFAULT_SYNTHETIC_USD_LEVERAGE_CAP,
): SizingResult {
  const safeRequested = Math.max(0, requestedUsd)
  const maxTarget = Math.max(0, holdingsBasisUsd) * leverageCap
  const targetUsd = Math.min(safeRequested, maxTarget)
  const capped = safeRequested > maxTarget
  const shortContracts = stepSize > 0 ? roundToStep(targetUsd, stepSize) : targetUsd
  const leverage = holdingsBasisUsd > 0 ? targetUsd / holdingsBasisUsd : 0
  return { targetUsd, leverage, shortContracts, capped }
}

export type MutationKind = 'mint' | 'scale_up' | 'scale_down' | 'close' | 'auto_rebalance'

export interface MutationPlan {
  kind: MutationKind
  // 'sell' grows the short (mint/scale up), 'buy' shrinks it (scale down/close).
  side: 'buy' | 'sell' | null
  // Order notional in USD, rounded to the step. 0 → no order needed.
  orderQty: number
  // The short notional the position should hold afterwards.
  nextShortSize: number
  reduceOnly: boolean
}

// Pure plan: given the current short and a new target, return the order that
// moves the short to the (rounded) target. A target of 0 is a full close.
export function planMutation(
  currentShortSize: number,
  nextTargetUsd: number,
  stepSize: number,
): MutationPlan {
  const target = roundToStep(Math.max(0, nextTargetUsd), stepSize)
  const delta = roundToStep(Math.abs(target - currentShortSize), stepSize)

  if (target <= 0) {
    return {
      kind: 'close',
      side: currentShortSize > 0 ? 'buy' : null,
      orderQty: currentShortSize,
      nextShortSize: 0,
      reduceOnly: true,
    }
  }
  if (delta <= 0) {
    // Already at target within one step → no-op.
    return { kind: 'scale_up', side: null, orderQty: 0, nextShortSize: currentShortSize, reduceOnly: false }
  }
  if (target > currentShortSize) {
    return { kind: 'scale_up', side: 'sell', orderQty: delta, nextShortSize: target, reduceOnly: false }
  }
  return { kind: 'scale_down', side: 'buy', orderQty: delta, nextShortSize: target, reduceOnly: true }
}

// Sum the holdings basis: live exchange lines + manual off-exchange lines.
export function holdingsBasisTotal(db: KaiBotDatabase): number {
  return db.listHoldingsBasis().reduce((sum, row) => sum + (row.usd_value || 0), 0)
}

export interface BasisRefreshResult {
  // holdingsBasisTotal(db) after the refresh.
  totalUsd: number
  // Venue lines successfully rewritten this call ('<exchange>:<account>').
  refreshedSources: string[]
  // Exchange names whose refresh failed (disconnected, getBalances threw, or
  // no price for a coin balance). Their existing lines are left untouched.
  failures: string[]
}

// Currencies that are USD for basis purposes.
const USD_LIKE = new Set(['USD', 'USDC', 'USDT'])
// Coin → the inverse perp whose mark prices it.
const COIN_PRICE_INSTRUMENT: Record<string, string> = {
  BTC: 'BTC-PERPETUAL',
  ETH: 'ETH-PERPETUAL',
}

// Refresh the venue (is_manual=0) holdings-basis lines from live balances ×
// the venue's mark price. Fail-closed per venue: a venue that cannot be
// priced or read lands in `failures` and never overwrites an existing line.
// Manual lines are never touched here.
export async function aggregateHoldingsBasis(
  db: KaiBotDatabase,
  exchangeManager: ExchangeManager,
  userId = 'default',
): Promise<BasisRefreshResult> {
  const refreshedSources: string[] = []
  const failures: string[] = []
  let sessions
  try {
    sessions = await exchangeManager.getAllSessions(userId)
  } catch {
    return { totalUsd: holdingsBasisTotal(db), refreshedSources, failures: ['*'] }
  }

  for (const session of sessions) {
    if (session.status !== 'connected') continue
    try {
      const balances = await session.adapter.getBalances()
      // Value every line first; only write when the whole venue priced clean.
      const lines: Array<{ source: string; usd: number }> = []
      let venueOk = true
      for (const b of balances) {
        const currency = (b.currency ?? '').toUpperCase()
        const equity = b.equity ?? 0
        let usd: number | null = null
        if (USD_LIKE.has(currency)) {
          usd = equity
        } else if (COIN_PRICE_INSTRUMENT[currency] && typeof session.adapter.getLastPrice === 'function') {
          const price = await session.adapter.getLastPrice(COIN_PRICE_INSTRUMENT[currency])
          if (price && price > 0) usd = equity * price
        }
        if (usd === null) {
          venueOk = false
          break
        }
        lines.push({ source: `${session.exchangeName}:${b.accountId}`, usd })
      }
      if (!venueOk) {
        failures.push(session.exchangeName)
        continue
      }
      for (const line of lines) {
        db.setHoldingsBasis(line.source, line.usd, false)
        refreshedSources.push(line.source)
      }
    } catch {
      failures.push(session.exchangeName)
    }
  }

  return { totalUsd: holdingsBasisTotal(db), refreshedSources, failures }
}

export interface AutoRebalanceConfig {
  enabled: boolean
  // Required when enabling: % of the holdings basis the short should track.
  targetPct?: number
  // Deadband % of drift before the loop acts. Default 5.
  bandPct?: number
  // v1: only 'holdings' is accepted; 'equity' is reserved.
  basis?: SyntheticUsdRebalanceBasis
}

export interface ScaleOptions {
  // Mutation-log kind override — the rebalancer logs 'auto_rebalance' so
  // autonomous orders stay distinguishable from manual scales in the audit
  // trail. Only applies to scale_up/scale_down plans.
  kindOverride?: MutationKind
}

export interface ArmedMintContext {
  // Mark at the trigger tick (for planned-vs-realized in the mutation meta).
  mark: number
}

export interface ArmedMintResult {
  position: SyntheticUsdPositionRow
  plannedUsd: number
  realizedUsd: number
  avgFillPrice: number | null
  capped: boolean
}

export interface RecoveryCloseContext {
  mark: number
  recoveryLevel: number
  // false when the executor's own bot book on the instrument hides part of
  // the short at the venue (a bot long nets it): a reduce-only buy would then
  // be trimmed. Default true (nothing else on the instrument).
  reduceOnly?: boolean
}

export interface SyntheticUsdService {
  mint(input: {
    exchange: string
    accountId: string
    symbol: string
    targetUsd: number
    // User-set protective ceiling for this position. Omit to use the default.
    leverageCap?: number
  }): Promise<SyntheticUsdPositionRow>
  // The position's stored (user-authored) leverage_cap is reused. Pass
  // leverageCap to let the user re-set their own ceiling on this mutation.
  scale(
    id: string,
    nextTargetUsd: number,
    leverageCap?: number,
    opts?: ScaleOptions,
  ): Promise<SyntheticUsdPositionRow>
  close(id: string): Promise<SyntheticUsdPositionRow>
  setFactorBasis(id: string, enabled: boolean): void
  setAutoRebalance(id: string, cfg: AutoRebalanceConfig): SyntheticUsdPositionRow
  // Armed (dynamic) synthetic: mint the planned notional of an 'armed' row
  // through the same order path as mint(), flipping the SAME row to 'open'.
  mintArmed(id: string, ctx: ArmedMintContext): Promise<ArmedMintResult>
  // Buy back the whole short of an open arm-cycle row (same path as close())
  // and return the row to 'armed' at the trigger it fired on.
  closeToArmed(id: string, ctx: RecoveryCloseContext): Promise<SyntheticUsdPositionRow>
  // Restart safety: the short already exists on the venue but the row is still
  // armed (crash between fill and persist). Book it instead of minting twice.
  adoptArmed(id: string, liveShortSize: number, ctx: ArmedMintContext): SyntheticUsdPositionRow
}

// Validate a user-supplied leverage cap. Must be a finite positive number; any
// invalid input is rejected rather than silently swapped for a KaiBot default.
function resolveLeverageCap(requested: number | undefined, fallback: number): number {
  if (requested === undefined) return fallback
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new Error('leverageCap must be a positive number')
  }
  return requested
}

// USD notional of a short of `size` native units. Inverse: the size IS USD.
// Linear: size × price (null without a price).
export function shortNotionalUsd(
  exchange: string,
  symbol: string,
  size: number,
  price: number | null | undefined,
): number | null {
  if (isInverseContract(exchange, symbol)) return size
  if (!price || price <= 0) return null
  return size * price
}

export function createSyntheticUsdService(
  db: KaiBotDatabase,
  exchangeManager: ExchangeManager,
  userId = 'default',
): SyntheticUsdService {
  async function adapterFor(exchange: string, accountId?: string | null) {
    const session = await exchangeManager.getSession(userId, exchange, accountKeyOf(accountId))
    if (!session || session.status !== 'connected') {
      throw new Error(`exchange ${exchange} not connected`)
    }
    return session.adapter
  }

  // Venue-native order size for a USD notional. Inverse contracts: the
  // notional is the quantity, rounded to the step — byte-identical to the
  // original computeSizing rounding. Linear (USDC) contracts: usd / mark,
  // priced from the adapter; fail closed without a price.
  async function nativeQtyFor(
    exchange: string,
    accountId: string,
    symbol: string,
    usdNotional: number,
    stepSize: number,
  ): Promise<{ qty: number; price: number | null }> {
    if (isInverseContract(exchange, symbol)) {
      return { qty: stepSize > 0 ? roundToStep(usdNotional, stepSize) : usdNotional, price: null }
    }
    const adapter = await adapterFor(exchange, accountId)
    let price: number | null = null
    try {
      price = (await adapter.getLastPrice?.(symbol)) ?? null
    } catch {
      price = null
    }
    const r = usdToNativeSize({ exchange, symbol, usdNotional, price: price ?? undefined, stepSize })
    if (r.priceMissing) throw new Error(`no price for ${symbol} — cannot size a linear synthetic short`)
    return { qty: r.size, price }
  }

  // Place the short-side order and wait for settlement under the global order
  // lock, the same path the signal pipeline uses. Returns the settled notional.
  async function placeAndSettle(
    exchange: string,
    accountId: string,
    symbol: string,
    side: 'buy' | 'sell',
    qty: number,
    reduceOnly: boolean,
  ): Promise<{ orderId: string; filledQty: number; averagePrice: number | null }> {
    const adapter = await adapterFor(exchange, accountId)
    return withOrderLock(exchange, async () => {
      const result = await adapter.placeOrder({
        accountId,
        symbol,
        side,
        orderType: 'market',
        quantity: qty,
        reduceOnly,
        label: 'kaibot-synthetic-usd',
      })
      const settled = await settleAdapterOrder(adapter, result.orderId, { symbol })
      // Do NOT book the position as if it filled when it didn't: a rejected/
      // cancelled/timed-out order that mint/scale/close persisted anyway diverged
      // the DB from the venue (phantom short / phantom close). Only proceed on a
      // real (partial) fill; the caller leaves its DB state unchanged otherwise.
      if (settled.status !== 'filled' && settled.status !== 'partially_filled') {
        throw new Error(`synthetic-usd order did not fill (status: ${settled.status})`)
      }
      return {
        orderId: result.orderId,
        filledQty: settled.filledQuantity ?? qty,
        averagePrice: settled.averagePrice ?? result.averagePrice ?? null,
      }
    })
  }

  // Shared mint leg: size against the holdings basis + cap, convert to the
  // venue's native quantity, sell. Persistence is the caller's (a fresh row
  // for mint(), the existing armed row for mintArmed()).
  async function executeMintOrder(input: {
    exchange: string
    accountId: string
    symbol: string
    targetUsd: number
    leverageCap: number
    // Collateral the cap measures against. Default = the summed holdings
    // basis (manual mint). Arm-cycle mints pass their own account's holdings
    // (coin × mark) so BTC and ETH never cap each other.
    basisUsd?: number
  }) {
    const basis = input.basisUsd ?? holdingsBasisTotal(db)
    const { stepSize } = getContractConstraints(input.exchange, input.symbol)
    const sizing = computeSizing(input.targetUsd, basis, stepSize, input.leverageCap)
    if (sizing.shortContracts <= 0) throw new Error('target rounds to zero contracts')
    const native = await nativeQtyFor(input.exchange, input.accountId, input.symbol, sizing.targetUsd, stepSize)
    if (native.qty <= 0) throw new Error('target rounds to zero contracts')
    const order = await placeAndSettle(
      input.exchange,
      input.accountId,
      input.symbol,
      'sell',
      native.qty,
      false,
    )
    return { basis, sizing, plannedQty: native.qty, markPrice: native.price, order }
  }

  // Shared close leg: buy back the whole recorded short, reduce-only.
  async function executeCloseOrder(pos: SyntheticUsdPositionRow, opts?: { reduceOnly?: boolean }) {
    const { stepSize } = getContractConstraints(pos.exchange, pos.symbol)
    const plan = planMutation(pos.short_size, 0, stepSize)
    let order: { orderId: string; filledQty: number; averagePrice: number | null } | null = null
    if (plan.side && plan.orderQty > 0) {
      order = await placeAndSettle(
        pos.exchange,
        pos.account_id,
        pos.symbol,
        plan.side,
        plan.orderQty,
        opts?.reduceOnly ?? true,
      )
    }
    return { plan, order }
  }

  async function mint(input: {
    exchange: string
    accountId: string
    symbol: string
    targetUsd: number
    leverageCap?: number
  }): Promise<SyntheticUsdPositionRow> {
    const existing = db.getLiveSyntheticUsdPosition(input.exchange, input.accountId, input.symbol)
    if (existing) {
      throw new Error(
        existing.status === 'armed'
          ? 'an armed synthetic USD position already exists for this market — disarm it first'
          : 'an open synthetic USD position already exists for this market',
      )
    }

    const leverageCap = resolveLeverageCap(input.leverageCap, DEFAULT_SYNTHETIC_USD_LEVERAGE_CAP)
    const { basis, sizing, plannedQty, order } = await executeMintOrder({
      exchange: input.exchange,
      accountId: input.accountId,
      symbol: input.symbol,
      targetUsd: input.targetUsd,
      leverageCap,
    })

    const id = crypto.randomUUID()
    db.insertSyntheticUsdPosition({
      id,
      exchange: input.exchange,
      account_id: input.accountId,
      symbol: input.symbol,
      target_usd: sizing.targetUsd,
      holdings_basis_usd: basis,
      leverage: sizing.leverage,
      short_size: plannedQty,
      leverage_cap: leverageCap,
    })
    db.insertSyntheticUsdMutation({
      position_id: id,
      kind: 'mint',
      target_usd_before: 0,
      target_usd_after: sizing.targetUsd,
      short_size_before: 0,
      short_size_after: plannedQty,
      order_id: order.orderId,
      order_side: 'sell',
      order_qty: plannedQty,
    })
    return db.getSyntheticUsdPosition(id)!
  }

  async function scale(
    id: string,
    nextTargetUsd: number,
    leverageCap?: number,
    opts?: ScaleOptions,
  ): Promise<SyntheticUsdPositionRow> {
    const pos = db.getSyntheticUsdPosition(id)
    if (!pos || pos.status !== 'open') throw new Error('position not found or already closed')

    // Carry the user's stored ceiling unless they explicitly re-set it here.
    const effectiveCap = resolveLeverageCap(
      leverageCap,
      pos.leverage_cap ?? DEFAULT_SYNTHETIC_USD_LEVERAGE_CAP,
    )
    const basis = holdingsBasisTotal(db)
    const { stepSize } = getContractConstraints(pos.exchange, pos.symbol)
    const sizing = computeSizing(nextTargetUsd, basis, stepSize, effectiveCap)
    // Inverse: native == USD, so this is the original planMutation input.
    const desired = await nativeQtyFor(pos.exchange, pos.account_id, pos.symbol, sizing.targetUsd, stepSize)
    const plan = planMutation(pos.short_size, desired.qty, stepSize)

    let orderId: string | null = null
    if (plan.side && plan.orderQty > 0) {
      const order = await placeAndSettle(
        pos.exchange,
        pos.account_id,
        pos.symbol,
        plan.side,
        plan.orderQty,
        plan.reduceOnly,
      )
      orderId = order.orderId
    }

    db.updateSyntheticUsdPosition(id, {
      target_usd: sizing.targetUsd,
      holdings_basis_usd: basis,
      leverage: sizing.leverage,
      short_size: plan.nextShortSize,
      leverage_cap: effectiveCap,
    })
    db.insertSyntheticUsdMutation({
      position_id: id,
      kind:
        opts?.kindOverride && (plan.kind === 'scale_up' || plan.kind === 'scale_down')
          ? opts.kindOverride
          : plan.kind,
      target_usd_before: pos.target_usd,
      target_usd_after: sizing.targetUsd,
      short_size_before: pos.short_size,
      short_size_after: plan.nextShortSize,
      order_id: orderId,
      order_side: plan.side,
      order_qty: plan.orderQty,
    })
    return db.getSyntheticUsdPosition(id)!
  }

  async function close(id: string): Promise<SyntheticUsdPositionRow> {
    const pos = db.getSyntheticUsdPosition(id)
    if (!pos || pos.status !== 'open') throw new Error('position not found or already closed')

    const { plan, order } = await executeCloseOrder(pos)

    db.updateSyntheticUsdPosition(id, { short_size: 0, target_usd: 0, leverage: 0, status: 'closed' })
    db.insertSyntheticUsdMutation({
      position_id: id,
      kind: 'close',
      target_usd_before: pos.target_usd,
      target_usd_after: 0,
      short_size_before: pos.short_size,
      short_size_after: 0,
      order_id: order?.orderId ?? null,
      order_side: plan.side,
      order_qty: plan.orderQty,
    })
    return db.getSyntheticUsdPosition(id)!
  }

  // Open OR armed: an armed row sizes signals on its planned floor
  // (services/synthetic-sizing.ts syntheticBasisUsd).
  function setFactorBasis(id: string, enabled: boolean) {
    const pos = db.getSyntheticUsdPosition(id)
    if (!pos || (pos.status !== 'open' && pos.status !== 'armed')) {
      throw new Error('position not found or already closed')
    }
    db.setSyntheticUsdFactorBasis(id, enabled)
  }

  // Configure auto-rebalance. Rejects invalid input outright rather than
  // silently clamping — the stored numbers stay user intent. Disabling only
  // flips the flag and keeps the numbers for re-enable.
  function setAutoRebalance(id: string, cfg: AutoRebalanceConfig): SyntheticUsdPositionRow {
    const pos = db.getSyntheticUsdPosition(id)
    if (!pos || pos.status !== 'open') throw new Error('position not found or already closed')
    if (!cfg.enabled) {
      db.updateSyntheticUsdPosition(id, { auto_rebalance: 0 })
      return db.getSyntheticUsdPosition(id)!
    }
    // An arm-cycle row's short is sized to the trigger and unwinds on
    // recovery; a rebalancer moving it would fight the guard.
    if (pos.arm_trigger_price != null) {
      throw new Error('an armed (dynamic) synthetic cannot be auto-rebalanced — disarm it first')
    }
    const targetPct = cfg.targetPct
    if (!Number.isFinite(targetPct) || (targetPct as number) <= 0) {
      throw new Error('targetPct must be a positive number')
    }
    if ((targetPct as number) > pos.leverage_cap * 100) {
      throw new Error(
        `targetPct exceeds the position's leverage cap (max ${pos.leverage_cap * 100}%)`,
      )
    }
    const bandPct = cfg.bandPct ?? 5
    if (!Number.isFinite(bandPct) || bandPct < 1 || bandPct >= 100) {
      throw new Error('bandPct must be between 1 and 100')
    }
    const basis = cfg.basis ?? 'holdings'
    if (basis !== 'holdings') {
      throw new Error("only the 'holdings' basis is supported")
    }
    db.updateSyntheticUsdPosition(id, {
      auto_rebalance: 1,
      rebalance_target_pct: targetPct as number,
      rebalance_band_pct: bandPct,
      rebalance_basis: basis,
    })
    return db.getSyntheticUsdPosition(id)!
  }

  // ── Armed (dynamic) synthetic ─────────────────────────────────────────────

  function requireArmed(id: string): SyntheticUsdPositionRow {
    const pos = db.getSyntheticUsdPosition(id)
    if (!pos || pos.status !== 'armed') throw new Error('position is not armed')
    if (pos.arm_trigger_price == null || pos.arm_planned_usd == null) {
      throw new Error('armed position has no trigger')
    }
    return pos
  }

  function gapPct(direction: 'long' | 'short' | null, trigger: number, fill: number | null) {
    if (fill == null || !(trigger > 0)) return null
    // Long holdings: a fill BELOW the trigger is the adverse gap.
    const raw = ((trigger - fill) / trigger) * 100
    return direction === 'short' ? -raw : raw
  }

  async function mintArmed(id: string, ctx: ArmedMintContext): Promise<ArmedMintResult> {
    const pos = requireArmed(id)
    const trigger = pos.arm_trigger_price!
    const plannedUsd = pos.arm_planned_usd!
    const coin = pos.arm_holdings_coin ?? 0
    const { basis, sizing, plannedQty, order } = await executeMintOrder({
      exchange: pos.exchange,
      accountId: pos.account_id,
      symbol: pos.symbol,
      targetUsd: plannedUsd,
      leverageCap: pos.leverage_cap ?? DEFAULT_SYNTHETIC_USD_LEVERAGE_CAP,
      // Per-account, collateral-only: the declared coin at today's mark.
      basisUsd: coin * ctx.mark,
    })
    // Book what actually filled: the armed mint is edge-executed with nobody
    // watching, so a partial fill must not be recorded as the full plan.
    const filledQty = order.filledQty > 0 ? order.filledQty : plannedQty
    const realizedUsd =
      shortNotionalUsd(pos.exchange, pos.symbol, filledQty, order.averagePrice ?? ctx.mark) ??
      sizing.targetUsd
    const now = Date.now()
    db.updateSyntheticUsdPosition(id, {
      status: 'open',
      target_usd: realizedUsd,
      holdings_basis_usd: basis,
      leverage: basis > 0 ? realizedUsd / basis : 0,
      short_size: filledQty,
      arm_fired_trigger_price: trigger,
      arm_fired_price: order.averagePrice ?? ctx.mark,
      arm_fired_at: now,
      arm_cycle: (pos.arm_cycle ?? 0) + 1,
      arm_last_mark: ctx.mark,
      arm_last_mark_at: now,
      arm_last_error: null,
    })
    db.insertSyntheticUsdMutation({
      position_id: id,
      kind: 'mint',
      target_usd_before: 0,
      target_usd_after: realizedUsd,
      short_size_before: 0,
      short_size_after: filledQty,
      order_id: order.orderId,
      order_side: 'sell',
      order_qty: plannedQty,
      meta: {
        armed: true,
        cycle: (pos.arm_cycle ?? 0) + 1,
        trigger,
        mark: ctx.mark,
        plannedUsd,
        cappedUsd: sizing.targetUsd,
        capped: sizing.capped,
        realizedUsd,
        avgFillPrice: order.averagePrice,
        gapPct: gapPct(pos.arm_direction, trigger, order.averagePrice ?? ctx.mark),
        // Floor actually locked (holdings × fill) and how much the trigger-
        // sized short exceeds it after a gap. Kai's choice: size to the
        // trigger, show the over-hedge rather than shrink the short.
        lockedUsd: coin * (order.averagePrice ?? ctx.mark),
        overHedgeUsd: realizedUsd - coin * (order.averagePrice ?? ctx.mark),
      },
    })
    return {
      position: db.getSyntheticUsdPosition(id)!,
      plannedUsd,
      realizedUsd,
      avgFillPrice: order.averagePrice,
      capped: sizing.capped,
    }
  }

  function adoptArmed(id: string, liveShortSize: number, ctx: ArmedMintContext): SyntheticUsdPositionRow {
    const pos = requireArmed(id)
    const trigger = pos.arm_trigger_price!
    const basis = (pos.arm_holdings_coin ?? 0) * ctx.mark
    const realizedUsd =
      shortNotionalUsd(pos.exchange, pos.symbol, liveShortSize, ctx.mark) ?? pos.arm_planned_usd!
    const now = Date.now()
    db.updateSyntheticUsdPosition(id, {
      status: 'open',
      target_usd: realizedUsd,
      holdings_basis_usd: basis,
      leverage: basis > 0 ? realizedUsd / basis : 0,
      short_size: liveShortSize,
      arm_fired_trigger_price: trigger,
      arm_fired_price: ctx.mark,
      arm_fired_at: now,
      arm_cycle: (pos.arm_cycle ?? 0) + 1,
      arm_last_mark: ctx.mark,
      arm_last_mark_at: now,
      arm_last_error: null,
    })
    db.insertSyntheticUsdMutation({
      position_id: id,
      kind: 'mint',
      target_usd_before: 0,
      target_usd_after: realizedUsd,
      short_size_before: 0,
      short_size_after: liveShortSize,
      order_id: null,
      order_side: 'sell',
      order_qty: liveShortSize,
      meta: {
        armed: true,
        adopted: true,
        cycle: (pos.arm_cycle ?? 0) + 1,
        trigger,
        mark: ctx.mark,
        plannedUsd: pos.arm_planned_usd,
        realizedUsd,
      },
    })
    return db.getSyntheticUsdPosition(id)!
  }

  async function closeToArmed(id: string, ctx: RecoveryCloseContext): Promise<SyntheticUsdPositionRow> {
    const pos = db.getSyntheticUsdPosition(id)
    if (!pos || pos.status !== 'open') throw new Error('position not found or already closed')
    if (pos.arm_trigger_price == null || pos.arm_holdings_coin == null) {
      throw new Error('position is not in an arm cycle')
    }
    const { plan, order } = await executeCloseOrder(pos, { reduceOnly: ctx.reduceOnly })
    // Hysteresis: re-arm at the trigger this cycle fired on (never chase the
    // recovery level); the ratchet resumes from today's mark.
    const trigger = pos.arm_fired_trigger_price ?? pos.arm_trigger_price
    const now = Date.now()
    db.updateSyntheticUsdPosition(id, {
      status: 'armed',
      short_size: 0,
      target_usd: 0,
      leverage: 0,
      auto_rebalance: 0,
      arm_trigger_price: trigger,
      arm_planned_usd: pos.arm_holdings_coin * trigger,
      arm_high_water: ctx.mark,
      arm_armed_at: now,
      arm_fired_trigger_price: null,
      arm_fired_price: null,
      arm_fired_at: null,
      arm_last_mark: ctx.mark,
      arm_last_mark_at: now,
      arm_last_error: null,
    })
    db.insertSyntheticUsdMutation({
      position_id: id,
      kind: 'recovery_close',
      target_usd_before: pos.target_usd,
      target_usd_after: 0,
      short_size_before: pos.short_size,
      short_size_after: 0,
      order_id: order?.orderId ?? null,
      order_side: plan.side,
      order_qty: plan.orderQty,
      meta: {
        cycle: pos.arm_cycle,
        mark: ctx.mark,
        recoveryLevel: ctx.recoveryLevel,
        avgFillPrice: order?.averagePrice ?? null,
        reArmTrigger: trigger,
        reArmPlannedUsd: pos.arm_holdings_coin * trigger,
      },
    })
    return db.getSyntheticUsdPosition(id)!
  }

  return { mint, scale, close, setFactorBasis, setAutoRebalance, mintArmed, closeToArmed, adoptArmed }
}

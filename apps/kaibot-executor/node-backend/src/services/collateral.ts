// Collateral floor (Bybit UTA). Coins held as margin, a floor under each coin
// and a sizing basis built on those floors. Same carve-out as the armed
// synthetic: the operator arms, the edge executes a pre-authorized
// protective instruction. Two floor modes:
//   hedge: the existing armed synthetic on the coin's USDT perp (trigger,
//          trail, recovery, tolerance; synthetic-guard.ts drives it)
//   sell:  a resting conditional spot sell on the venue, optional buy-back
//          on recovery. The order lives on Bybit, so it fires with the
//          executor down; the tick reconciles it after a restart.

import crypto from 'node:crypto'
import type { KaiBotDatabase } from '../storage/database.js'
import type { ExchangeManager } from './exchanges/exchangeManager.js'
import type { AccountMargin, ExchangeAdapter, Position } from './exchanges/types.js'
import type {
  BybitCollateralWallet,
  CollateralRatioTier,
} from './exchanges/adapters/bybit.js'
import type { NotificationBus } from './notifications/notification-bus.js'
import type { SyntheticGuardService } from './synthetic-guard.js'
import { armedView, ratchetTrigger, resolveRecoveryLevel } from './synthetic-guard.js'
import {
  getCollateralFloor,
  getCollateralSettings,
  getLiveCollateralFloor,
  insertCollateralFloor,
  insertCollateralFloorEvent,
  listCollateralSettingsRows,
  listLiveCollateralFloors,
  touchCollateralSettings,
  updateCollateralFloor,
  upsertCollateralSettings,
  type CollateralFloorRow,
  type CollateralSettings,
  type FloorMode,
  type FloorStatus,
  type SizingBasisMode,
  type UnflooredMode,
} from '../storage/collateral-store.js'
import {
  checkPotCap,
  computeCollateralPot,
  entriesBlocked,
  isUsdLikeCoin,
  largestReducible,
  marginState,
  resolveCollateralRatio,
  usedNotionalUsd,
  validateThresholds,
  type MarginState,
  type PotComponent,
  type PotFloorInput,
} from './collateral-pot.js'
import { accountKeyOf, adapterAccountKey, normalizeConnectionLabel, scopeAccountId, venueAccountOf } from './exchanges/account-scope.js'
import { withOrderLock } from './order-lock.js'
import { settleAdapterOrder } from './order-settlement.js'

// ── Adapter capability (duck-typed: only Bybit implements it today) ─────────

export interface CollateralAdapter extends ExchangeAdapter {
  getCollateralWallet(): Promise<BybitCollateralWallet>
  getCollateralRatioTiers?(coins: string[]): Promise<Map<string, CollateralRatioTier[]>>
  amendOrder?(
    orderId: string,
    ctx: { symbol?: string; category?: string },
    patch: { quantity?: number; price?: number; triggerPrice?: number },
  ): Promise<{ orderId: string }>
}

export function isCollateralAdapter(a: unknown): a is CollateralAdapter {
  return !!a && typeof (a as CollateralAdapter).getCollateralWallet === 'function'
}

// ── View types (the UI contract, apps/kaibot-executor/src/lib/collateral-api.ts) ──

export interface CollateralFloorView {
  id: string
  exchange: string
  accountId: string
  coin: string
  mode: FloorMode
  status: FloorStatus
  symbol: string
  holdingsCoin: number
  triggerPrice: number
  triggerPriceInitial: number | null
  trailPct: number | null
  recoveryPct: number | null
  tolerancePct: number
  buyBack: boolean
  plannedFloorUsd: number
  realizedFloorUsd: number | null
  mark: number | null
  distanceToTriggerPct: number | null
  firedPrice: number | null
  firedAt: number | null
  cycle: number
  syntheticPositionId: string | null
  venueOrderId: string | null
  lastError: string | null
  createdAt: number
  updatedAt: number
}

export interface CollateralCoinView {
  coin: string
  walletBalance: number
  equity: number
  borrowAmount: number
  markPrice: number | null
  usdValue: number
  collateralSwitch: boolean
  marginCollateral: boolean
  collateralRatio: number
  ratioSource: 'venue' | 'override' | 'default'
  marginValueUsd: number
  floor: CollateralFloorView | null
}

export interface PotView {
  mode: SizingBasisMode
  unfloored: UnflooredMode
  potUsd: number
  components: PotComponent[]
  usedNotionalUsd: number
  freeUsd: number
  capMult: number
}

export interface MarginView {
  accountIMRate: number | null
  accountMMRate: number | null
  totalEquity: number | null
  totalAvailableBalance: number | null
  totalInitialMargin: number | null
  totalMaintenanceMargin: number | null
  blockMmrPct: number
  warnMmrPct: number
  autoReduce: boolean
  autoReducePct: number
  state: MarginState
}

export interface CollateralOverview {
  exchange: string
  accountId: string
  coins: CollateralCoinView[]
  pot: PotView
  margin: MarginView
  settings: CollateralSettings
  fetchedAt: number
  error: string | null
}

export interface CollateralAccountRef {
  exchange: string
  accountId: string
  label: string | null
  connected: boolean
}

export interface ArmFloorInput {
  exchange: string
  accountId: string
  accountKey?: string | null
  coin: string
  mode: FloorMode
  triggerPrice: number
  holdingsCoin?: number
  trailPct?: number | null
  recoveryPct?: number | null
  tolerancePct?: number
  buyBack?: boolean
}

export interface UpdateFloorInput {
  triggerPrice?: number
  holdingsCoin?: number
  trailPct?: number | null
  recoveryPct?: number | null
  tolerancePct?: number
  buyBack?: boolean
}

export interface CollateralService {
  listAccounts(): Promise<CollateralAccountRef[]>
  overview(exchange: string, accountId: string): Promise<CollateralOverview>
  armFloor(input: ArmFloorInput): Promise<CollateralFloorView>
  updateFloor(id: string, patch: UpdateFloorInput): Promise<CollateralFloorView>
  disarmFloor(id: string): Promise<CollateralFloorView>
  updateSettings(input: Partial<CollateralSettings> & { exchange: string; accountId: string }): CollateralSettings
  activeExchanges(): string[]
  tickExchange(exchange: string, adapter: ExchangeAdapter, positions: Position[]): Promise<void>
}

// ── Shared helpers (also used by the signal pipeline + manual guards) ──────

const CAP_MULT = 1
const WALLET_TTL_MS = 5_000
const TIER_TTL_MS = 60 * 60 * 1000
// Sell floors: venue status checked this often, every tick once the mark is
// within NEAR_PCT of the trigger.
const SELL_CHECK_MS = 15_000
const NEAR_PCT = 1.5
// Minimum trigger move before the resting order is amended, and spacing.
const AMEND_MIN_MOVE_PCT = 0.1
const AMEND_MIN_GAP_MS = 30_000
const MARGIN_CHECK_MS = 30_000
const WARN_THROTTLE_MS = 15 * 60 * 1000
const AUTO_REDUCE_COOLDOWN_MS = 30 * 60 * 1000

export const floorPerpSymbol = (coin: string) => `${coin.toUpperCase()}USDT`
export const floorSpotSymbol = (coin: string) => `${coin.toUpperCase()}USDT`

let walletCache = new WeakMap<object, { at: number; wallet: BybitCollateralWallet }>()
const tierCache = new Map<string, { at: number; tiers: CollateralRatioTier[] | null }>()

export async function readWallet(adapter: CollateralAdapter, maxAgeMs = WALLET_TTL_MS): Promise<BybitCollateralWallet> {
  const cached = walletCache.get(adapter)
  if (cached && Date.now() - cached.at < maxAgeMs) return cached.wallet
  const wallet = await adapter.getCollateralWallet()
  walletCache.set(adapter, { at: Date.now(), wallet })
  return wallet
}

async function readTiers(adapter: CollateralAdapter, coins: string[]): Promise<Map<string, CollateralRatioTier[]>> {
  const out = new Map<string, CollateralRatioTier[]>()
  const missing: string[] = []
  for (const c of coins) {
    const hit = tierCache.get(c)
    if (hit && Date.now() - hit.at < TIER_TTL_MS) {
      if (hit.tiers) out.set(c, hit.tiers)
    } else missing.push(c)
  }
  if (missing.length && typeof adapter.getCollateralRatioTiers === 'function') {
    try {
      const fresh = await adapter.getCollateralRatioTiers(missing)
      for (const c of missing) {
        const tiers = fresh.get(c) ?? null
        tierCache.set(c, { at: Date.now(), tiers })
        if (tiers) out.set(c, tiers)
      }
    } catch {
      // Fall back to configured/default ratios.
    }
  }
  return out
}

export function resetCollateralCaches() {
  tierCache.clear()
  walletCache = new WeakMap()
}

interface PricedCoin {
  coin: string
  walletBalance: number
  equity: number
  borrowAmount: number
  usdValue: number
  mark: number | null
  collateralSwitch: boolean
  marginCollateral: boolean
  ratio: number
  ratioSource: 'venue' | 'override' | 'default'
}

async function priceCoins(
  adapter: CollateralAdapter,
  wallet: BybitCollateralWallet,
  settings: CollateralSettings,
): Promise<PricedCoin[]> {
  const nonUsd = wallet.coins.filter((c) => !isUsdLikeCoin(c.coin)).map((c) => c.coin)
  const tiers = await readTiers(adapter, nonUsd)
  const out: PricedCoin[] = []
  for (const c of wallet.coins) {
    let mark: number | null = null
    if (isUsdLikeCoin(c.coin)) mark = 1
    else if (c.equity > 0 && c.usdValue > 0) mark = c.usdValue / c.equity
    else {
      try {
        mark = (await adapter.getLastPrice?.(floorPerpSymbol(c.coin))) ?? null
      } catch {
        mark = null
      }
    }
    const r = resolveCollateralRatio({
      coin: c.coin,
      qty: Math.max(0, c.walletBalance),
      override: settings.ratioOverrides[c.coin],
      tiers: tiers.get(c.coin),
    })
    out.push({
      coin: c.coin,
      walletBalance: c.walletBalance,
      equity: c.equity,
      borrowAmount: c.borrowAmount,
      usdValue: c.usdValue,
      mark,
      collateralSwitch: c.collateralSwitch,
      marginCollateral: c.marginCollateral,
      ratio: r.ratio,
      ratioSource: r.source,
    })
  }
  return out
}

// A hedge floor's live numbers come from its synthetic row; a sell floor
// carries its own.
function floorPotInput(db: KaiBotDatabase, f: CollateralFloorRow): PotFloorInput {
  if (f.mode === 'hedge' && f.synthetic_position_id) {
    const s = db.getSyntheticUsdPosition(f.synthetic_position_id)
    if (s && s.arm_trigger_price != null) {
      return {
        coin: f.coin,
        mode: 'hedge',
        status: s.status === 'open' ? 'fired' : s.status === 'armed' ? 'armed' : 'closed',
        holdingsCoin: s.arm_holdings_coin ?? f.holdings_coin,
        triggerPrice: s.arm_fired_trigger_price ?? s.arm_trigger_price,
        proceedsUsd: null,
      }
    }
  }
  return {
    coin: f.coin,
    mode: f.mode,
    status: f.status,
    holdingsCoin: f.holdings_coin,
    triggerPrice: f.fired_trigger_price ?? f.trigger_price,
    proceedsUsd: f.proceeds_usd,
  }
}

// Short notional of the account's synthetic hedges per symbol (native qty),
// so the cap never counts protection as risk.
function hedgeShortBySymbol(db: KaiBotDatabase, exchange: string, accountId: string): Map<string, number> {
  const map = new Map<string, number>()
  const lister = (db as Partial<KaiBotDatabase>).listSyntheticUsdPositions
  if (typeof lister !== 'function') return map
  for (const r of lister.call(db)) {
    if (r.status !== 'open' || r.exchange.toLowerCase() !== exchange.toLowerCase() || r.account_id !== accountId) continue
    const k = r.symbol.toUpperCase()
    map.set(k, (map.get(k) ?? 0) + r.short_size)
  }
  return map
}

function positionsOfAccount(positions: Position[], accountId: string): Position[] {
  return positions.filter((p) => !p.accountId || p.accountId === accountId || venueAccountOf(p.accountId) === accountId)
}

export interface AccountPot {
  settings: CollateralSettings
  wallet: BybitCollateralWallet
  coins: PricedCoin[]
  potUsd: number
  components: PotComponent[]
}

export async function computeAccountPot(
  db: KaiBotDatabase,
  exchange: string,
  accountId: string,
  adapter: CollateralAdapter,
): Promise<AccountPot> {
  const settings = getCollateralSettings(db, exchange, accountId)
  const wallet = await readWallet(adapter)
  const coins = await priceCoins(adapter, wallet, settings)
  const floors = listLiveCollateralFloors(db, exchange, accountId).map((f) => floorPotInput(db, f))
  const pot = computeCollateralPot(
    coins.map((c) => ({
      coin: c.coin,
      walletCoin: Math.max(0, c.walletBalance),
      mark: c.mark,
      ratio: c.ratio,
      collateral: c.marginCollateral && c.collateralSwitch,
    })),
    floors,
    settings.unfloored,
  )
  return { settings, wallet, coins, potUsd: pot.potUsd, components: pot.components }
}

// Sizing basis for the signal pipeline: the pot when the account opted in,
// else null (plain sizing). Throws when the pot cannot be read: the caller
// rejects the signal (fail-closed, like synthetic sizing without a price).
export async function getCollateralSizingBasis(
  db: KaiBotDatabase,
  exchange: string,
  accountId: string,
  adapter: ExchangeAdapter,
): Promise<{ basisUsd: number; components: PotComponent[] } | null> {
  const settings = getCollateralSettings(db, exchange, accountId)
  if (settings.sizingBasis !== 'floor') return null
  if (!isCollateralAdapter(adapter)) throw new Error(`${exchange} does not report collateral`)
  const pot = await computeAccountPot(db, exchange, accountId, adapter)
  return { basisUsd: pot.potUsd, components: pot.components }
}

export interface EntryCheck {
  ok: boolean
  guard: 'collateral cap' | 'margin ratio' | null
  reason: string | null
}

// Pre-open gate: (1) the UTA maintenance-margin rate against the account's
// thresholds, (2) with the collateral basis on, the 1x pot cap. MMR is
// fail-open on a wallet hiccup (same stance as breathing room); the cap is
// fail-closed because the order was sized on that pot.
export async function checkCollateralEntry(
  db: KaiBotDatabase,
  exchange: string,
  accountId: string,
  adapter: ExchangeAdapter,
  order: { symbol: string; side: 'buy' | 'sell'; quantity: number; price?: number | null; positions?: Position[] },
): Promise<EntryCheck> {
  if (!isCollateralAdapter(adapter)) return { ok: true, guard: null, reason: null }
  const settings = getCollateralSettings(db, exchange, accountId)
  let wallet: BybitCollateralWallet | null = null
  try {
    wallet = await readWallet(adapter)
  } catch {
    wallet = null
  }
  if (wallet) {
    const state = marginState(wallet.accountMMRate, settings.blockMmrPct, settings.warnMmrPct)
    if (entriesBlocked(state)) {
      return {
        ok: false,
        guard: 'margin ratio',
        reason: `account maintenance margin at ${((wallet.accountMMRate ?? 0) * 100).toFixed(1)}% (entries blocked from ${settings.blockMmrPct}%)`,
      }
    }
  }
  if (settings.sizingBasis !== 'floor') return { ok: true, guard: null, reason: null }
  if (!wallet) return { ok: false, guard: 'collateral cap', reason: 'collateral cap: wallet unavailable' }

  const pot = await computeAccountPot(db, exchange, accountId, adapter)
  const all = order.positions ?? (await adapter.getPositions())
  const positions = positionsOfAccount(all, accountId)
  const hedges = hedgeShortBySymbol(db, exchange, accountId)
  const used = usedNotionalUsd(positions, hedges)
  let price = order.price ?? null
  const same = positions.find((p) => p.symbol.toUpperCase() === order.symbol.toUpperCase())
  if (!(price && price > 0)) price = same?.markPrice || same?.entryPrice || (await adapter.getLastPrice?.(order.symbol)) || null
  if (!(price && price > 0)) return { ok: false, guard: 'collateral cap', reason: `collateral cap: no price for ${order.symbol}` }
  // The part of the order that closes an opposing position adds no exposure.
  const opposing =
    same && ((order.side === 'buy' && same.side === 'short') || (order.side === 'sell' && same.side === 'long'))
      ? Math.max(0, Math.abs(same.size) - (same.side === 'short' ? hedges.get(same.symbol.toUpperCase()) ?? 0 : 0))
      : 0
  const netNew = Math.max(0, order.quantity - opposing)
  const cap = checkPotCap({ potUsd: pot.potUsd, usedNotionalUsd: used, orderNotionalUsd: netNew * price, capMult: CAP_MULT })
  return cap.ok ? { ok: true, guard: null, reason: null } : { ok: false, guard: 'collateral cap', reason: cap.reason }
}

// ── Service ─────────────────────────────────────────────────────────────────

const positive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0

function validateFloorNumbers(cfg: {
  triggerPrice: number
  holdingsCoin: number
  trailPct: number | null
  recoveryPct: number | null
  tolerancePct: number
}) {
  if (!positive(cfg.triggerPrice)) throw new Error('triggerPrice must be a positive number')
  if (!positive(cfg.holdingsCoin)) throw new Error('holdingsCoin must be a positive number')
  if (cfg.trailPct != null && !(positive(cfg.trailPct) && cfg.trailPct < 100)) {
    throw new Error('trailPct must be between 0 and 100')
  }
  if (cfg.recoveryPct != null && !(Number.isFinite(cfg.recoveryPct) && cfg.recoveryPct >= 0)) {
    throw new Error('recoveryPct must be zero or a positive number')
  }
  if (!(Number.isFinite(cfg.tolerancePct) && cfg.tolerancePct >= 0 && cfg.tolerancePct < 100)) {
    throw new Error('tolerancePct must be between 0 and 100')
  }
}

// The venue trigger of a sell floor: the tolerance widens it downwards.
export const sellVenueTrigger = (trigger: number, tolerancePct: number) => trigger * (1 - Math.max(0, tolerancePct) / 100)

const pctMove = (a: number, b: number) => (b > 0 ? (Math.abs(a - b) / b) * 100 : Infinity)

export function createCollateralService(
  db: KaiBotDatabase,
  exchangeManager: ExchangeManager,
  guard: SyntheticGuardService,
  notifications: NotificationBus | null = null,
  userId = 'default',
): CollateralService {
  const inflight = new Set<string>()
  const lastMarginCheck = new Map<string, number>()

  async function sessionFor(exchange: string, accountId: string) {
    const session = await exchangeManager.getSession(userId, exchange, accountKeyOf(accountId))
    if (!session || session.status !== 'connected') throw new Error(`exchange ${exchange} not connected`)
    return session
  }

  async function collateralAdapterFor(exchange: string, accountId: string): Promise<CollateralAdapter> {
    const { adapter } = await sessionFor(exchange, accountId)
    if (!isCollateralAdapter(adapter)) throw new Error(`${exchange} does not support coin collateral`)
    return adapter
  }

  function notify(type: string, title: string, body: string, data: Record<string, unknown>) {
    notifications?.publish({ type: type as any, title, body, data })
  }

  function notifyOnce(f: CollateralFloorRow, error: string, title: string) {
    if (f.last_error !== error) notify('synthetic_armed_failed', title, `${f.coin}: ${error}`, { floorId: f.id, coin: f.coin, error })
    updateCollateralFloor(db, f.id, { last_error: error })
  }

  // ── views ──

  function view(f: CollateralFloorRow, mark?: number | null): CollateralFloorView {
    if (f.mode === 'hedge' && f.synthetic_position_id) {
      const s = db.getSyntheticUsdPosition(f.synthetic_position_id)
      if (s) {
        const v = armedView(s, mark ?? undefined)
        const status: FloorStatus =
          s.status === 'armed' && v.inCycle ? 'armed' : s.status === 'open' && v.inCycle ? 'fired' : 'closed'
        const holdings = v.holdingsCoin ?? f.holdings_coin
        const trigger = v.triggerPrice ?? f.trigger_price
        return {
          id: f.id,
          exchange: f.exchange,
          accountId: f.account_id,
          coin: f.coin,
          mode: 'hedge',
          status: f.status === 'closed' ? 'closed' : status,
          symbol: s.symbol,
          holdingsCoin: holdings,
          triggerPrice: trigger,
          triggerPriceInitial: v.triggerPriceInitial,
          trailPct: v.trailPct,
          recoveryPct: v.recoveryPct,
          tolerancePct: v.tolerancePct,
          buyBack: false,
          plannedFloorUsd: holdings * trigger,
          realizedFloorUsd: status === 'fired' ? v.protectedUsd : null,
          mark: v.mark,
          distanceToTriggerPct: v.distanceToTriggerPct,
          firedPrice: v.firedPrice,
          firedAt: v.firedAt,
          cycle: v.cycle,
          syntheticPositionId: s.id,
          venueOrderId: null,
          lastError: v.lastError ?? f.last_error,
          createdAt: f.created_at,
          updatedAt: Math.max(f.updated_at, s.updated_at),
        }
      }
    }
    const m = mark ?? f.last_mark
    const distance = f.status === 'armed' && m != null && m > 0 ? ((m - f.trigger_price) / m) * 100 : null
    return {
      id: f.id,
      exchange: f.exchange,
      accountId: f.account_id,
      coin: f.coin,
      mode: f.mode,
      status: f.status,
      symbol: f.symbol,
      holdingsCoin: f.holdings_coin,
      triggerPrice: f.trigger_price,
      triggerPriceInitial: f.trigger_price_initial,
      trailPct: f.trail_pct,
      recoveryPct: f.recovery_pct,
      tolerancePct: f.tolerance_pct,
      buyBack: f.buy_back === 1,
      plannedFloorUsd: f.holdings_coin * f.trigger_price,
      realizedFloorUsd: f.status === 'fired' ? f.proceeds_usd : null,
      mark: m,
      distanceToTriggerPct: distance,
      firedPrice: f.fired_price,
      firedAt: f.fired_at,
      cycle: f.cycle,
      syntheticPositionId: null,
      venueOrderId: f.venue_order_id,
      lastError: f.last_error,
      createdAt: f.created_at,
      updatedAt: f.updated_at,
    }
  }

  async function listAccounts(): Promise<CollateralAccountRef[]> {
    const out: CollateralAccountRef[] = []
    const sessions = await exchangeManager.getAllSessions(userId).catch(() => [])
    for (const session of sessions) {
      if (!isCollateralAdapter(session.adapter)) continue
      try {
        const accounts = await session.adapter.getAccounts()
        for (const a of accounts) {
          out.push({
            exchange: session.exchangeName,
            accountId: a.accountId,
            label: normalizeConnectionLabel(accountKeyOf(a.accountId)) ?? null,
            connected: session.status === 'connected',
          })
        }
      } catch {
        // A session that cannot list its account is skipped.
      }
    }
    return out
  }

  async function overview(exchange: string, accountId: string): Promise<CollateralOverview> {
    const settings = getCollateralSettings(db, exchange, accountId)
    const floors = listLiveCollateralFloors(db, exchange, accountId)
    const empty: CollateralOverview = {
      exchange: exchange.toLowerCase(),
      accountId,
      coins: [],
      pot: {
        mode: settings.sizingBasis,
        unfloored: settings.unfloored,
        potUsd: 0,
        components: [],
        usedNotionalUsd: 0,
        freeUsd: 0,
        capMult: CAP_MULT,
      },
      margin: {
        accountIMRate: null,
        accountMMRate: null,
        totalEquity: null,
        totalAvailableBalance: null,
        totalInitialMargin: null,
        totalMaintenanceMargin: null,
        blockMmrPct: settings.blockMmrPct,
        warnMmrPct: settings.warnMmrPct,
        autoReduce: settings.autoReduce,
        autoReducePct: settings.autoReducePct,
        state: 'unknown',
      },
      settings,
      fetchedAt: Date.now(),
      error: null,
    }
    let adapter: CollateralAdapter
    let pot: AccountPot
    try {
      adapter = await collateralAdapterFor(exchange, accountId)
      pot = await computeAccountPot(db, exchange, accountId, adapter)
    } catch (e: any) {
      return { ...empty, error: e?.message ?? String(e) }
    }
    let used = 0
    try {
      const positions = positionsOfAccount(await adapter.getPositions(), accountId)
      used = usedNotionalUsd(positions, hedgeShortBySymbol(db, exchange, accountId))
    } catch {
      used = 0
    }
    const floorByCoin = new Map(floors.map((f) => [f.coin, f]))
    const coins: CollateralCoinView[] = pot.coins.map((c) => {
      const f = floorByCoin.get(c.coin)
      const collateral = c.marginCollateral && c.collateralSwitch
      return {
        coin: c.coin,
        walletBalance: c.walletBalance,
        equity: c.equity,
        borrowAmount: c.borrowAmount,
        markPrice: c.mark,
        usdValue: c.usdValue,
        collateralSwitch: c.collateralSwitch,
        marginCollateral: c.marginCollateral,
        collateralRatio: c.ratio,
        ratioSource: c.ratioSource,
        marginValueUsd: collateral ? c.usdValue * c.ratio : 0,
        floor: f ? view(f, c.mark) : null,
      }
    })
    // A floor on a coin the wallet no longer holds still shows.
    for (const f of floors) {
      if (!coins.some((c) => c.coin === f.coin)) {
        coins.push({
          coin: f.coin, walletBalance: 0, equity: 0, borrowAmount: 0, markPrice: f.last_mark, usdValue: 0,
          collateralSwitch: false, marginCollateral: false, collateralRatio: 0, ratioSource: 'default',
          marginValueUsd: 0, floor: view(f),
        })
      }
    }
    const w = pot.wallet
    return {
      ...empty,
      coins,
      pot: {
        mode: settings.sizingBasis,
        unfloored: settings.unfloored,
        potUsd: pot.potUsd,
        components: pot.components,
        usedNotionalUsd: used,
        freeUsd: Math.max(0, pot.potUsd * CAP_MULT - used),
        capMult: CAP_MULT,
      },
      margin: {
        ...empty.margin,
        accountIMRate: w.accountIMRate,
        accountMMRate: w.accountMMRate,
        totalEquity: w.totalEquity,
        totalAvailableBalance: w.totalAvailableBalance,
        totalInitialMargin: w.totalInitialMargin,
        totalMaintenanceMargin: w.totalMaintenanceMargin,
        state: marginState(w.accountMMRate, settings.blockMmrPct, settings.warnMmrPct),
      },
    }
  }

  // ── arm / update / disarm ──

  async function armFloor(raw: ArmFloorInput): Promise<CollateralFloorView> {
    const exchange = raw.exchange.toLowerCase()
    const key = normalizeConnectionLabel(raw.accountKey)
    const accountId = key && !accountKeyOf(raw.accountId) ? scopeAccountId(key, raw.accountId) : raw.accountId
    const coin = String(raw.coin ?? '').toUpperCase()
    if (!/^[A-Z0-9]{2,15}$/.test(coin) || isUsdLikeCoin(coin)) throw new Error('coin must be a non-stable coin symbol')
    if (raw.mode !== 'hedge' && raw.mode !== 'sell') throw new Error("mode must be 'hedge' or 'sell'")
    if (getLiveCollateralFloor(db, exchange, accountId, coin)) {
      throw new Error(`${coin} already has a floor. Disarm it first (switching mode = disarm + arm)`)
    }
    const adapter = await collateralAdapterFor(exchange, accountId)
    const wallet = await readWallet(adapter, 0)
    const w = wallet.coins.find((c) => c.coin === coin)
    const walletCoin = Math.max(0, w?.walletBalance ?? 0)
    const holdingsCoin = raw.holdingsCoin ?? walletCoin
    const cfg = {
      triggerPrice: Number(raw.triggerPrice),
      holdingsCoin,
      trailPct: raw.trailPct ?? null,
      recoveryPct: raw.recoveryPct ?? null,
      tolerancePct: raw.tolerancePct ?? 0,
    }
    validateFloorNumbers(cfg)
    if (holdingsCoin > walletCoin + 1e-12) {
      throw new Error(`holdings ${holdingsCoin} ${coin} exceed the ${walletCoin} ${coin} in the wallet`)
    }
    const mark = (await adapter.getLastPrice?.(floorPerpSymbol(coin)).catch(() => null)) ?? null
    if (mark != null && cfg.triggerPrice >= mark) {
      throw new Error(`trigger ${cfg.triggerPrice} must sit below the mark ${mark}`)
    }

    if (raw.mode === 'hedge') {
      const syn = await guard.arm({
        exchange,
        accountId,
        symbol: floorPerpSymbol(coin),
        triggerPrice: cfg.triggerPrice,
        holdingsCoin,
        trailPct: cfg.trailPct,
        recoveryPct: cfg.recoveryPct,
        tolerancePct: cfg.tolerancePct,
        // Default cap, same as Deribit: the short is sized to the trigger and a
        // gap shows as over-hedge in the mint meta (Kai's rule, 04/09).
      })
      const row = insertCollateralFloor(db, {
        id: crypto.randomUUID(),
        exchange,
        account_id: accountId,
        coin,
        mode: 'hedge',
        status: 'armed',
        symbol: syn.symbol,
        holdings_coin: holdingsCoin,
        trigger_price: cfg.triggerPrice,
        trail_pct: cfg.trailPct,
        recovery_pct: cfg.recoveryPct,
        tolerance_pct: cfg.tolerancePct,
        buy_back: 0,
        synthetic_position_id: syn.id,
        high_water: mark,
        last_mark: mark,
        last_mark_at: mark != null ? Date.now() : null,
      })
      insertCollateralFloorEvent(db, row.id, 'arm', { mode: 'hedge', trigger: cfg.triggerPrice, holdingsCoin, mark, syntheticId: syn.id })
      return view(row, mark)
    }

    // sell: the row goes in first, so a crash between the venue call and the
    // persist is found again by its orderLinkId.
    const id = crypto.randomUUID()
    const row = insertCollateralFloor(db, {
      id,
      exchange,
      account_id: accountId,
      coin,
      mode: 'sell',
      status: 'armed',
      symbol: floorSpotSymbol(coin),
      holdings_coin: holdingsCoin,
      trigger_price: cfg.triggerPrice,
      trail_pct: cfg.trailPct,
      recovery_pct: cfg.recoveryPct,
      tolerance_pct: cfg.tolerancePct,
      buy_back: raw.buyBack ? 1 : 0,
      high_water: mark,
      last_mark: mark,
      last_mark_at: mark != null ? Date.now() : null,
      venue_order_link_id: linkId(id, 0, 's'),
    })
    try {
      await placeSellStop(adapter, row)
    } catch (e: any) {
      // Only adopt what the venue confirms; otherwise the floor never existed.
      const adopted = await adoptByLink(adapter, row).catch(() => false)
      if (!adopted) {
        updateCollateralFloor(db, id, { status: 'closed', last_error: e?.message ?? String(e) })
        insertCollateralFloorEvent(db, id, 'arm_failed', { error: e?.message ?? String(e) })
        throw e
      }
    }
    insertCollateralFloorEvent(db, id, 'arm', {
      mode: 'sell', trigger: cfg.triggerPrice, holdingsCoin, mark, buyBack: !!raw.buyBack,
    })
    return view(getCollateralFloor(db, id)!, mark)
  }

  function linkId(id: string, cycle: number, leg: 's' | 'b') {
    // 36-char venue limit: kbcf-<leg><cycle>-<first 24 of the uuid, no dashes>
    return `kbcf-${leg}${cycle}-${id.replace(/-/g, '').slice(0, 24)}`
  }

  async function placeSellStop(adapter: CollateralAdapter, f: CollateralFloorRow): Promise<void> {
    const trigger = sellVenueTrigger(f.trigger_price, f.tolerance_pct)
    const linkRef = f.venue_order_link_id ?? linkId(f.id, f.cycle, 's')
    const res = await withOrderLock(f.exchange, () =>
      adapter.placeOrder({
        accountId: f.account_id,
        symbol: f.symbol,
        side: 'sell',
        orderType: 'stop',
        quantity: f.holdings_coin,
        stopPrice: trigger,
        clientOrderId: linkRef,
        label: 'kaibot-collateral-floor',
        category: 'spot',
      } as Parameters<ExchangeAdapter['placeOrder']>[0]),
    )
    updateCollateralFloor(db, f.id, {
      venue_order_id: res.orderId,
      venue_order_link_id: linkRef,
      venue_order_side: 'sell',
      venue_trigger_price: trigger,
      last_error: null,
      last_check_at: Date.now(),
    })
  }

  async function placeBuyBack(adapter: CollateralAdapter, f: CollateralFloorRow, level: number): Promise<void> {
    const proceeds = f.proceeds_usd ?? 0
    if (!(proceeds > 0)) throw new Error('no sale proceeds to buy back with')
    const linkRef = linkId(f.id, f.cycle, 'b')
    const res = await withOrderLock(f.exchange, () =>
      adapter.placeOrder({
        accountId: f.account_id,
        symbol: f.symbol,
        side: 'buy',
        orderType: 'stop',
        // Spend the proceeds, never more: no fresh USDT loan for the buy-back.
        quantity: proceeds,
        stopPrice: level,
        clientOrderId: linkRef,
        label: 'kaibot-collateral-buyback',
        category: 'spot',
        marketUnit: 'quoteCoin',
      } as Parameters<ExchangeAdapter['placeOrder']>[0]),
    )
    updateCollateralFloor(db, f.id, {
      venue_order_id: res.orderId,
      venue_order_link_id: linkRef,
      venue_order_side: 'buy',
      venue_trigger_price: level,
      last_error: null,
      last_check_at: Date.now(),
    })
  }

  async function cancelVenueOrder(adapter: CollateralAdapter, f: CollateralFloorRow): Promise<void> {
    if (!f.venue_order_id) return
    try {
      await withOrderLock(f.exchange, () =>
        adapter.cancelOrder(f.venue_order_id!, { symbol: f.symbol, category: 'spot', orderFilter: 'StopOrder' }),
      )
    } catch (e: any) {
      // Already gone (filled/cancelled on the venue) is fine; anything else
      // must not leave a resting order we no longer track.
      const st = await adapter
        .getOrderStatus?.(f.venue_order_id, { symbol: f.symbol, category: 'spot', orderFilter: 'StopOrder' })
        .catch(() => null)
      if (!st || st.state === 'working' || st.state === 'partially_filled') throw e
    }
  }

  // The venue has an order with our link id that the row never recorded.
  async function adoptByLink(adapter: CollateralAdapter, f: CollateralFloorRow): Promise<boolean> {
    if (!f.venue_order_link_id || typeof adapter.getOrderStatus !== 'function') return false
    const st = await adapter.getOrderStatus(`client:${f.venue_order_link_id}`, {
      symbol: f.symbol,
      category: 'spot',
      orderFilter: 'StopOrder',
    })
    const venueId = (st.raw as { orderId?: string } | undefined)?.orderId
    if (st.state === 'unknown' || !venueId) return false
    updateCollateralFloor(db, f.id, {
      venue_order_id: String(venueId),
      venue_order_side: f.venue_order_link_id.startsWith('kbcf-b') ? 'buy' : 'sell',
      last_error: null,
    })
    insertCollateralFloorEvent(db, f.id, 'adopted', { orderId: venueId, link: f.venue_order_link_id })
    return true
  }

  async function updateFloor(id: string, patch: UpdateFloorInput): Promise<CollateralFloorView> {
    const f = getCollateralFloor(db, id)
    if (!f || f.status === 'closed') throw new Error('floor not found or disarmed')
    if (f.mode === 'hedge') {
      if (!f.synthetic_position_id) throw new Error('hedge floor lost its synthetic position')
      const s = guard.updateArm(f.synthetic_position_id, {
        triggerPrice: patch.triggerPrice,
        holdingsCoin: patch.holdingsCoin,
        trailPct: patch.trailPct,
        recoveryPct: patch.recoveryPct,
        tolerancePct: patch.tolerancePct,
      })
      updateCollateralFloor(db, id, {
        trigger_price: s.arm_trigger_price ?? f.trigger_price,
        holdings_coin: s.arm_holdings_coin ?? f.holdings_coin,
        trail_pct: s.arm_trail_pct,
        recovery_pct: s.arm_recovery_pct,
        tolerance_pct: s.arm_tolerance_pct ?? 0,
        last_error: null,
      })
      insertCollateralFloorEvent(db, id, 'update', { ...patch })
      return view(getCollateralFloor(db, id)!)
    }

    // sell
    const next = {
      triggerPrice: patch.triggerPrice ?? f.trigger_price,
      holdingsCoin: patch.holdingsCoin ?? f.holdings_coin,
      trailPct: patch.trailPct !== undefined ? patch.trailPct : f.trail_pct,
      recoveryPct: patch.recoveryPct !== undefined ? patch.recoveryPct : f.recovery_pct,
      tolerancePct: patch.tolerancePct ?? f.tolerance_pct,
    }
    validateFloorNumbers(next)
    if (f.status === 'fired' && (patch.triggerPrice != null || patch.holdingsCoin != null)) {
      throw new Error('the floor has fired: only recovery and buy-back can change')
    }
    const adapter = await collateralAdapterFor(f.exchange, f.account_id)
    const buyBack = patch.buyBack !== undefined ? (patch.buyBack ? 1 : 0) : f.buy_back
    const triggerMoved = patch.triggerPrice != null && patch.triggerPrice !== f.trigger_price
    updateCollateralFloor(db, id, {
      trigger_price: next.triggerPrice,
      trigger_price_initial: triggerMoved ? next.triggerPrice : f.trigger_price_initial,
      high_water: triggerMoved ? null : f.high_water,
      holdings_coin: next.holdingsCoin,
      trail_pct: next.trailPct,
      recovery_pct: next.recoveryPct,
      tolerance_pct: next.tolerancePct,
      buy_back: buyBack,
    })
    const fresh = getCollateralFloor(db, id)!
    if (fresh.status === 'armed') {
      if (!fresh.venue_order_id) {
        await placeSellStop(adapter, { ...fresh, venue_order_link_id: linkId(id, fresh.cycle, 's') + 'u' })
      } else if (
        patch.holdingsCoin != null ||
        pctMove(sellVenueTrigger(next.triggerPrice, next.tolerancePct), fresh.venue_trigger_price ?? 0) > 1e-9
      ) {
        await amendOrReplace(adapter, fresh, sellVenueTrigger(next.triggerPrice, next.tolerancePct), next.holdingsCoin)
      }
    } else if (fresh.status === 'fired') {
      const level = resolveRecoveryLevel({
        direction: 'long',
        firedTriggerPrice: fresh.fired_trigger_price ?? fresh.trigger_price,
        recoveryPrice: null,
        recoveryPct: fresh.recovery_pct,
      })
      const hasBuyBack = fresh.venue_order_side === 'buy' && fresh.venue_order_id
      if (hasBuyBack && (!buyBack || level == null)) {
        await cancelVenueOrder(adapter, fresh)
        updateCollateralFloor(db, id, { venue_order_id: null, venue_order_side: null, venue_trigger_price: null })
      } else if (buyBack && level != null && !hasBuyBack) {
        await placeBuyBack(adapter, fresh, level)
      } else if (hasBuyBack && level != null && pctMove(level, fresh.venue_trigger_price ?? 0) > 1e-9) {
        await amendOrReplace(adapter, fresh, level)
      }
    }
    insertCollateralFloorEvent(db, id, 'update', { ...patch })
    return view(getCollateralFloor(db, id)!)
  }

  async function amendOrReplace(
    adapter: CollateralAdapter,
    f: CollateralFloorRow,
    venueTrigger: number,
    quantity?: number,
  ): Promise<void> {
    try {
      if (typeof adapter.amendOrder !== 'function') throw new Error('amend unsupported')
      await withOrderLock(f.exchange, () =>
        adapter.amendOrder!(f.venue_order_id!, { symbol: f.symbol, category: 'spot' }, {
          triggerPrice: venueTrigger,
          ...(quantity != null ? { quantity } : {}),
        }),
      )
      updateCollateralFloor(db, f.id, { venue_trigger_price: venueTrigger, last_amend_at: Date.now(), last_error: null })
    } catch {
      // Cancel + replace: never two resting sells for one floor.
      await cancelVenueOrder(adapter, f)
      const fresh = { ...f, venue_order_id: null }
      if (f.venue_order_side === 'buy') {
        await placeBuyBack(adapter, fresh, venueTrigger)
      } else {
        await placeSellStop(adapter, {
          ...fresh,
          holdings_coin: quantity ?? f.holdings_coin,
          venue_order_link_id: linkId(f.id, f.cycle, 's') + String(Date.now() % 1000),
        })
      }
      updateCollateralFloor(db, f.id, { last_amend_at: Date.now() })
    }
  }

  async function disarmFloor(id: string): Promise<CollateralFloorView> {
    const f = getCollateralFloor(db, id)
    if (!f || f.status === 'closed') throw new Error('floor not found or already disarmed')
    if (f.mode === 'hedge') {
      if (f.synthetic_position_id) {
        const s = db.getSyntheticUsdPosition(f.synthetic_position_id)
        // Armed: retires without an order. Fired: the short stays as a plain
        // synthetic (close it on the Synthetic USD page).
        if (s && s.arm_trigger_price != null && (s.status === 'armed' || s.status === 'open')) {
          guard.disarm(f.synthetic_position_id)
        }
      }
    } else if (f.venue_order_id) {
      const adapter = await collateralAdapterFor(f.exchange, f.account_id)
      await cancelVenueOrder(adapter, f)
    }
    updateCollateralFloor(db, id, { status: 'closed', last_error: null })
    insertCollateralFloorEvent(db, id, 'disarm', { mode: f.mode, status: f.status })
    return view(getCollateralFloor(db, id)!)
  }

  function updateSettings(input: Partial<CollateralSettings> & { exchange: string; accountId: string }): CollateralSettings {
    const cur = getCollateralSettings(db, input.exchange, input.accountId)
    const next: CollateralSettings = {
      ...cur,
      sizingBasis: input.sizingBasis ?? cur.sizingBasis,
      unfloored: input.unfloored ?? cur.unfloored,
      blockMmrPct: input.blockMmrPct ?? cur.blockMmrPct,
      warnMmrPct: input.warnMmrPct ?? cur.warnMmrPct,
      autoReduce: input.autoReduce ?? cur.autoReduce,
      autoReducePct: input.autoReducePct ?? cur.autoReducePct,
      ratioOverrides: input.ratioOverrides
        ? Object.fromEntries(Object.entries(input.ratioOverrides).map(([k, v]) => [k.toUpperCase(), v]))
        : cur.ratioOverrides,
    }
    if (next.sizingBasis !== 'off' && next.sizingBasis !== 'floor') throw new Error("sizingBasis must be 'off' or 'floor'")
    if (next.unfloored !== 'exclude' && next.unfloored !== 'margin') throw new Error("unfloored must be 'exclude' or 'margin'")
    validateThresholds(next.blockMmrPct, next.warnMmrPct)
    if (!(Number.isFinite(next.autoReducePct) && next.autoReducePct > 0 && next.autoReducePct <= 100)) {
      throw new Error('autoReducePct must be between 0 and 100')
    }
    for (const [coin, r] of Object.entries(next.ratioOverrides)) {
      if (!(typeof r === 'number' && Number.isFinite(r) && r >= 0 && r <= 1)) {
        throw new Error(`collateral ratio for ${coin} must be between 0 and 1`)
      }
    }
    upsertCollateralSettings(db, next)
    return getCollateralSettings(db, input.exchange, input.accountId)
  }

  // ── tick ──

  function activeExchanges(): string[] {
    const set = new Set<string>()
    for (const f of listLiveCollateralFloors(db)) if (f.mode === 'sell') set.add(f.exchange)
    for (const r of listCollateralSettingsRows(db)) set.add(r.exchange)
    return [...set]
  }

  async function tickExchange(exchange: string, adapter: ExchangeAdapter, positions: Position[]): Promise<void> {
    if (!isCollateralAdapter(adapter)) return
    // Only this connection's rows (same rule as the synthetic guard).
    const connectionKey = adapterAccountKey(adapter)
    const owns = (accountId: string) => accountKeyOf(accountId) === connectionKey
    const sells = listLiveCollateralFloors(db, exchange).filter((f) => f.mode === 'sell' && owns(f.account_id))
    for (const f of sells) {
      if (inflight.has(f.id)) continue
      inflight.add(f.id)
      try {
        await tickSell(adapter, f)
      } catch (e: any) {
        db.log('error', 'trading', 'Collateral floor tick failed', { id: f.id, error: e?.message })
      } finally {
        inflight.delete(f.id)
      }
    }
    // Account guard on every collateral account of this connection.
    const accounts = new Set<string>([
      ...listCollateralSettingsRows(db)
        .filter((r) => r.exchange === exchange.toLowerCase() && owns(r.account_id))
        .map((r) => r.account_id),
      ...listLiveCollateralFloors(db, exchange)
        .filter((r) => owns(r.account_id))
        .map((r) => r.account_id),
    ])
    for (const accountId of accounts) {
      try {
        await tickMargin(exchange, accountId, adapter, positions)
      } catch (e: any) {
        db.log('warn', 'trading', 'Collateral margin check failed', { exchange, accountId, error: e?.message })
      }
    }
  }

  async function tickSell(adapter: CollateralAdapter, row: CollateralFloorRow): Promise<void> {
    const now = Date.now()
    let mark: number | null = null
    try {
      mark = (await adapter.getLastPrice?.(floorPerpSymbol(row.coin))) ?? null
    } catch {
      mark = null
    }
    let f = row
    if (mark != null) updateCollateralFloor(db, f.id, { last_mark: mark, last_mark_at: now })

    // Restart after a crash between insert and venue ack.
    if (f.status === 'armed' && !f.venue_order_id) {
      if (f.last_error) return
      if (await adoptByLink(adapter, f).catch(() => false)) return
      await placeSellStop(adapter, f).catch((e) => notifyOnce(f, e?.message ?? String(e), 'Collateral floor not placed'))
      return
    }

    if (f.status === 'armed' && mark != null) {
      const r = ratchetTrigger(
        { direction: 'long', triggerPrice: f.trigger_price, highWater: f.high_water, trailPct: f.trail_pct, trailAbs: null },
        mark,
      )
      if (r.triggerPrice !== f.trigger_price || r.highWater !== f.high_water) {
        updateCollateralFloor(db, f.id, { trigger_price: r.triggerPrice, high_water: r.highWater })
        f = getCollateralFloor(db, f.id)!
      }
      const venueTarget = sellVenueTrigger(f.trigger_price, f.tolerance_pct)
      if (
        f.venue_order_id &&
        f.venue_trigger_price != null &&
        venueTarget > f.venue_trigger_price &&
        pctMove(venueTarget, f.venue_trigger_price) >= AMEND_MIN_MOVE_PCT &&
        now - (f.last_amend_at ?? 0) >= AMEND_MIN_GAP_MS
      ) {
        await amendOrReplace(adapter, f, venueTarget)
        insertCollateralFloorEvent(db, f.id, 'ratchet', { trigger: f.trigger_price, venueTrigger: venueTarget, mark })
        f = getCollateralFloor(db, f.id)!
      }
    }

    if (!f.venue_order_id || typeof adapter.getOrderStatus !== 'function') return
    const vt = f.venue_trigger_price
    // Past the venue trigger (sell: at/below, buy-back: at/above) or close to
    // it → check now; otherwise every SELL_CHECK_MS.
    const crossed = mark != null && vt != null && (f.venue_order_side === 'buy' ? mark >= vt : mark <= vt)
    const near = mark != null && vt != null && pctMove(mark, vt) <= NEAR_PCT
    if (!crossed && !near && now - (f.last_check_at ?? 0) < SELL_CHECK_MS) return
    const st = await adapter.getOrderStatus(f.venue_order_id, { symbol: f.symbol, category: 'spot', orderFilter: 'StopOrder' })
    updateCollateralFloor(db, f.id, { last_check_at: now })

    if (st.state === 'filled') {
      if (f.venue_order_side === 'sell') await onSellFilled(adapter, f, st, mark)
      else await onBuyBackFilled(adapter, f, st, mark)
      return
    }
    if (st.state === 'cancelled' || st.state === 'rejected' || (st.state === 'unknown' && st.absenceConfirmed)) {
      updateCollateralFloor(db, f.id, { venue_order_id: null, venue_trigger_price: null })
      notifyOnce(
        { ...f, venue_order_id: null },
        `${f.venue_order_side === 'buy' ? 'buy-back' : 'resting sell'} is gone from the venue (${st.state}); update the floor to place it again`,
        'Collateral floor order gone',
      )
    }
  }

  async function onSellFilled(adapter: CollateralAdapter, f: CollateralFloorRow, st: { filledQuantity?: number; averagePrice?: number; commission?: number }, mark: number | null) {
    const qty = st.filledQuantity && st.filledQuantity > 0 ? st.filledQuantity : f.holdings_coin
    const avg = st.averagePrice && st.averagePrice > 0 ? st.averagePrice : mark ?? f.trigger_price
    const fee = Math.max(0, st.commission ?? 0)
    const proceeds = qty * avg - fee
    updateCollateralFloor(db, f.id, {
      status: 'fired',
      fired_trigger_price: f.trigger_price,
      fired_price: avg,
      fired_qty: qty,
      fired_at: Date.now(),
      proceeds_usd: proceeds,
      cycle: f.cycle + 1,
      venue_order_id: null,
      venue_order_side: null,
      venue_trigger_price: null,
      last_error: null,
    })
    insertCollateralFloorEvent(db, f.id, 'fired', {
      trigger: f.trigger_price, venueTrigger: f.venue_trigger_price, avgFillPrice: avg, qty, proceedsUsd: proceeds,
      gapPct: f.trigger_price > 0 ? ((f.trigger_price - avg) / f.trigger_price) * 100 : null,
    })
    notify(
      'synthetic_armed_minted',
      'Collateral floor sold',
      `${f.coin} broke ${f.trigger_price}: sold ${qty} at ${avg} ($${Math.round(proceeds)}).`,
      { floorId: f.id, coin: f.coin, qty, avgFillPrice: avg, proceedsUsd: proceeds },
    )
    const fired = getCollateralFloor(db, f.id)!
    const level = resolveRecoveryLevel({
      direction: 'long',
      firedTriggerPrice: fired.fired_trigger_price,
      recoveryPrice: null,
      recoveryPct: fired.recovery_pct,
    })
    if (fired.buy_back === 1 && level != null) {
      await placeBuyBack(adapter, fired, level).catch((e) => notifyOnce(fired, e?.message ?? String(e), 'Collateral buy-back not placed'))
    }
  }

  async function onBuyBackFilled(adapter: CollateralAdapter, f: CollateralFloorRow, st: { filledQuantity?: number; averagePrice?: number }, mark: number | null) {
    // Spot market buy in quote: cumExecQty is the coin received.
    const coins = st.filledQuantity && st.filledQuantity > 0 ? st.filledQuantity : f.fired_qty ?? f.holdings_coin
    // Hysteresis: re-arm at the trigger this cycle fired on.
    const trigger = f.fired_trigger_price ?? f.trigger_price
    updateCollateralFloor(db, f.id, {
      status: 'armed',
      holdings_coin: coins,
      trigger_price: trigger,
      high_water: mark,
      fired_trigger_price: null,
      fired_price: null,
      fired_qty: null,
      fired_at: null,
      proceeds_usd: null,
      venue_order_id: null,
      venue_order_side: null,
      venue_trigger_price: null,
      venue_order_link_id: linkId(f.id, f.cycle, 's'),
      last_error: null,
    })
    insertCollateralFloorEvent(db, f.id, 'buy_back', { coins, avgFillPrice: st.averagePrice ?? null, reArmTrigger: trigger })
    notify(
      'synthetic_armed_closed',
      'Collateral floor bought back',
      `${f.coin} recovered: bought back ${coins} ${f.coin}, floor re-armed at ${trigger}.`,
      { floorId: f.id, coin: f.coin, coins, trigger },
    )
    const armed = getCollateralFloor(db, f.id)!
    await placeSellStop(adapter, armed).catch((e) => notifyOnce(armed, e?.message ?? String(e), 'Collateral floor not placed'))
  }

  async function tickMargin(exchange: string, accountId: string, adapter: CollateralAdapter, positions: Position[]) {
    const k = `${exchange}:${accountId}`
    const now = Date.now()
    if (now - (lastMarginCheck.get(k) ?? 0) < MARGIN_CHECK_MS) return
    lastMarginCheck.set(k, now)
    const settings = getCollateralSettings(db, exchange, accountId)
    const wallet = await readWallet(adapter)
    const state = marginState(wallet.accountMMRate, settings.blockMmrPct, settings.warnMmrPct)
    if (state !== 'warn') return
    const row = listCollateralSettingsRows(db).find((r) => r.exchange === exchange.toLowerCase() && r.account_id === accountId)
    const pct = ((wallet.accountMMRate ?? 0) * 100).toFixed(1)
    if (now - (row?.last_warn_at ?? 0) >= WARN_THROTTLE_MS) {
      touchCollateralSettings(db, exchange, accountId, { last_warn_at: now })
      notify('error', 'Margin ratio high', `${exchange}·${accountId}: maintenance margin at ${pct}% (warning from ${settings.warnMmrPct}%).`, {
        exchange, accountId, mmRate: wallet.accountMMRate,
      })
    }
    if (!settings.autoReduce) return
    if (now - (row?.last_auto_reduce_at ?? 0) < AUTO_REDUCE_COOLDOWN_MS) return
    const pick = largestReducible(positionsOfAccount(positions, accountId), hedgeShortBySymbol(db, exchange, accountId))
    if (!pick) return
    const qty = pick.reducibleSize * (settings.autoReducePct / 100)
    touchCollateralSettings(db, exchange, accountId, { last_auto_reduce_at: now })
    try {
      const res = await withOrderLock(exchange, () =>
        adapter.placeOrder({
          accountId,
          symbol: pick.position.symbol,
          side: pick.position.side === 'long' ? 'sell' : 'buy',
          orderType: 'market',
          quantity: qty,
          reduceOnly: true,
          label: 'kaibot-collateral-reduce',
        }),
      )
      await settleAdapterOrder(adapter, res.orderId, { symbol: pick.position.symbol }).catch(() => null)
      db.log('warn', 'trading', 'Collateral auto-reduce placed', {
        exchange, accountId, symbol: pick.position.symbol, qty, mmRate: wallet.accountMMRate,
      })
      notify('error', 'Position reduced (margin)', `${pick.position.symbol}: reduced ${qty} at maintenance margin ${pct}%.`, {
        exchange, accountId, symbol: pick.position.symbol, qty,
      })
    } catch (e: any) {
      notify('error', 'Auto-reduce failed', `${pick.position.symbol}: ${e?.message ?? e}`, { exchange, accountId })
    }
  }

  return { listAccounts, overview, armFloor, updateFloor, disarmFloor, updateSettings, activeExchanges, tickExchange }
}

export type { AccountMargin }

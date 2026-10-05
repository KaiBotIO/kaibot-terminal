// Collateral floor: pure rules (no I/O). The service feeds them the UTA wallet,
// the floors and the open positions; everything here is unit-tested.
//
// Pot (sizing basis "collateral floor", per exchange account):
//   floored coin   → min(coins on the floor, coins in the wallet) × trigger × ratio
//   sold (fired)   → the sale proceeds in USDT (ratio 1)
//   unfloored coin → 0 by default; 'margin' mode: coins × mark × ratio
// A floor's trigger only moves up (ratchet) or by an explicit operator
// update, so a price drop alone never shrinks the floored part of the pot.
//
// Virtual coins (off-exchange, operator-declared) follow the same rules as
// the venue coin, as a separate `virtual` component: armed floor → trigger,
// fired floor → min(mark, trigger) (the floor never protected them),
// unfloored → per `unfloored`. They size; they are never margin.
// With virtualCoverage 'hedge' a fired hedge leg locks them: `hedged`
// component at qty × the short's fill (ratio 1, it is USD now).

import type { CollateralRatioTier } from './exchanges/adapters/bybit.js'
import type { FloorMode, FloorStatus, UnflooredMode } from '../storage/collateral-store.js'

// Bybit publishes 0,95 for BTC/ETH in its help center; the tiered endpoint is
// authoritative when it answers.
export const DEFAULT_COLLATERAL_RATIO: Record<string, number> = { BTC: 0.95, ETH: 0.95 }
// Other coins without venue data: conservative until the operator overrides.
export const FALLBACK_COLLATERAL_RATIO = 0.8

const USD_LIKE = new Set(['USDT', 'USDC', 'USD'])
export const isUsdLikeCoin = (coin: string) => USD_LIKE.has(coin.toUpperCase())

// Effective ratio for `qty` coins over a tiered schedule: each tier values the
// slice of qty that falls inside it. 0 qty → the first tier's ratio.
export function tieredCollateralRatio(qty: number, tiers: CollateralRatioTier[]): number | null {
  if (!tiers.length) return null
  const sorted = [...tiers].sort((a, b) => a.minQty - b.minQty)
  if (!(qty > 0)) return sorted[0].ratio
  let valued = 0
  for (const t of sorted) {
    const hi = t.maxQty == null ? Infinity : t.maxQty
    const slice = Math.max(0, Math.min(qty, hi) - t.minQty)
    valued += slice * t.ratio
  }
  return valued / qty
}

export function resolveCollateralRatio(input: {
  coin: string
  qty: number
  override?: number
  tiers?: CollateralRatioTier[]
}): { ratio: number; source: 'venue' | 'override' | 'default' } {
  if (input.override != null && Number.isFinite(input.override)) {
    return { ratio: input.override, source: 'override' }
  }
  const tiered = input.tiers ? tieredCollateralRatio(input.qty, input.tiers) : null
  if (tiered != null) return { ratio: tiered, source: 'venue' }
  const coin = input.coin.toUpperCase()
  if (isUsdLikeCoin(coin)) return { ratio: 1, source: 'default' }
  return { ratio: DEFAULT_COLLATERAL_RATIO[coin] ?? FALLBACK_COLLATERAL_RATIO, source: 'default' }
}

export interface PotCoinInput {
  coin: string
  walletCoin: number
  mark: number | null
  ratio: number
  // Collateral switch off (or not accepted by the venue) → contributes nothing.
  collateral: boolean
}

export interface PotFloorInput {
  coin: string
  mode: FloorMode
  status: FloorStatus
  holdingsCoin: number
  triggerPrice: number
  // Sell floor that fired without buying back yet: USDT the sale produced.
  proceedsUsd: number | null
}

export interface PotVirtualInput {
  coin: string
  qty: number
  mark: number | null
  ratio: number
  // Open hedge leg on this coin: the price the short locked.
  hedgedPrice?: number | null
}

export interface PotComponent {
  coin: string
  usd: number
  source: 'floor' | 'margin' | 'sold' | 'hedged'
  virtual?: true
}

export interface PotResult {
  potUsd: number
  venueUsd: number
  virtualUsd: number
  components: PotComponent[]
}

export function computeCollateralPot(
  coins: PotCoinInput[],
  floors: PotFloorInput[],
  unfloored: UnflooredMode,
  virtual: PotVirtualInput[] = [],
): PotResult {
  const components: PotComponent[] = []
  const byCoin = new Map(coins.map((c) => [c.coin.toUpperCase(), c]))
  const flooredCoins = new Set<string>()
  for (const f of floors) {
    if (f.status === 'closed') continue
    const coin = f.coin.toUpperCase()
    flooredCoins.add(coin)
    if (f.mode === 'sell' && f.status === 'fired') {
      components.push({ coin, usd: Math.max(0, f.proceedsUsd ?? 0), source: 'sold' })
      continue
    }
    const c = byCoin.get(coin)
    if (!c || !c.collateral) {
      components.push({ coin, usd: 0, source: 'floor' })
      continue
    }
    // Coins withdrawn after arming shrink the pot; extra coins without a
    // floor do not grow it.
    const qty = Math.max(0, Math.min(f.holdingsCoin, c.walletCoin))
    components.push({ coin, usd: qty * Math.max(0, f.triggerPrice) * c.ratio, source: 'floor' })
  }
  if (unfloored === 'margin') {
    for (const c of coins) {
      const coin = c.coin.toUpperCase()
      if (flooredCoins.has(coin) || isUsdLikeCoin(coin) || !c.collateral) continue
      if (!(c.walletCoin > 0) || c.mark == null || !(c.mark > 0)) continue
      components.push({ coin, usd: c.walletCoin * c.mark * c.ratio, source: 'margin' })
    }
  }
  const floorByCoin = new Map(floors.filter((f) => f.status !== 'closed').map((f) => [f.coin.toUpperCase(), f]))
  for (const v of virtual) {
    const coin = v.coin.toUpperCase()
    if (!(v.qty > 0) || isUsdLikeCoin(coin)) continue
    const f = floorByCoin.get(coin)
    let price: number | null = null
    let source: PotComponent['source'] = 'floor'
    if (v.hedgedPrice != null && v.hedgedPrice > 0) {
      components.push({ coin, usd: v.qty * v.hedgedPrice, source: 'hedged', virtual: true })
      continue
    }
    if (f && f.status === 'armed') price = f.triggerPrice
    else if (f) price = v.mark != null ? Math.min(v.mark, f.triggerPrice) : null
    else if (unfloored === 'margin') {
      price = v.mark
      source = 'margin'
    } else continue
    const usd = price != null && price > 0 ? v.qty * price * v.ratio : 0
    components.push({ coin, usd, source, virtual: true })
  }
  const virtualUsd = components.reduce((s, c) => s + (c.virtual ? c.usd : 0), 0)
  const potUsd = components.reduce((s, c) => s + c.usd, 0)
  return { potUsd, venueUsd: potUsd - virtualUsd, virtualUsd, components }
}

// Real-margin cap: the 1x cap against the venue part of the pot only. An
// order the full pot allows but the venue part does not needs a deposit.
export function topUpNeededUsd(input: {
  venueUsd: number
  usedNotionalUsd: number
  orderNotionalUsd: number
  capMult?: number
}): number {
  const limit = Math.max(0, input.venueUsd) * (input.capMult ?? 1)
  const after = input.usedNotionalUsd + Math.max(0, input.orderNotionalUsd)
  return Math.max(0, after - limit)
}

// Whole USD with European thousands dots: 12345.6 → "12.346".
export const usdWhole = (n: number) => String(Math.ceil(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')

// Cap: total open notional (hedge shorts excluded) may not exceed capMult × pot.
export interface CapCheck {
  ok: boolean
  potUsd: number
  usedNotionalUsd: number
  orderNotionalUsd: number
  limitUsd: number
  reason: string | null
}

export function checkPotCap(input: {
  potUsd: number
  usedNotionalUsd: number
  orderNotionalUsd: number
  capMult?: number
}): CapCheck {
  const limitUsd = Math.max(0, input.potUsd) * (input.capMult ?? 1)
  const after = input.usedNotionalUsd + Math.max(0, input.orderNotionalUsd)
  const ok = after <= limitUsd + 1e-6
  return {
    ok,
    potUsd: input.potUsd,
    usedNotionalUsd: input.usedNotionalUsd,
    orderNotionalUsd: input.orderNotionalUsd,
    limitUsd,
    reason: ok
      ? null
      : `collateral cap: open notional $${Math.round(input.usedNotionalUsd)} + order $${Math.round(
          input.orderNotionalUsd,
        )} exceeds ${input.capMult ?? 1}x the collateral pot ($${Math.round(limitUsd)})`,
  }
}

// Open notional that counts against the cap: every position at its mark,
// except the part of a short that is a floor hedge (it protects collateral,
// it is not risk taken on it).
export function usedNotionalUsd(
  positions: Array<{ symbol: string; side: 'long' | 'short'; size: number; markPrice?: number; entryPrice?: number }>,
  hedgeShortBySymbol: Map<string, number>,
): number {
  let total = 0
  for (const p of positions) {
    const price = p.markPrice && p.markPrice > 0 ? p.markPrice : p.entryPrice ?? 0
    let size = Math.abs(p.size)
    if (p.side === 'short') {
      const hedge = hedgeShortBySymbol.get(p.symbol.toUpperCase()) ?? 0
      size = Math.max(0, size - hedge)
    }
    total += size * price
  }
  return total
}

export type MarginState = 'ok' | 'warn' | 'block' | 'unknown'

// UTA maintenance-margin rate against the operator thresholds. Both are % of
// equity; warn sits above block (default 60 / 80): past block new entries are
// refused, past warn the operator is alerted (and optionally a position cut).
export function marginState(mmRate: number | null, blockMmrPct: number, warnMmrPct: number): MarginState {
  if (mmRate == null || !Number.isFinite(mmRate)) return 'unknown'
  const pct = mmRate * 100
  if (pct >= warnMmrPct) return 'warn'
  if (pct >= blockMmrPct) return 'block'
  return 'ok'
}

// Entries are refused in both 'block' and 'warn' (warn is the worse state).
export const entriesBlocked = (s: MarginState) => s === 'block' || s === 'warn'

export function validateThresholds(blockMmrPct: number, warnMmrPct: number): void {
  const ok = (n: number) => Number.isFinite(n) && n > 0 && n < 100
  if (!ok(blockMmrPct) || !ok(warnMmrPct)) throw new Error('margin thresholds must be between 0 and 100')
  if (warnMmrPct <= blockMmrPct) throw new Error('the warning threshold must sit above the entry-block threshold')
}

// Largest non-hedge position by notional: the auto-reduce candidate.
export function largestReducible<P extends { symbol: string; side: 'long' | 'short'; size: number; markPrice?: number; entryPrice?: number }>(
  positions: P[],
  hedgeShortBySymbol: Map<string, number>,
): { position: P; reducibleSize: number; notionalUsd: number } | null {
  let best: { position: P; reducibleSize: number; notionalUsd: number } | null = null
  for (const p of positions) {
    const price = p.markPrice && p.markPrice > 0 ? p.markPrice : p.entryPrice ?? 0
    let size = Math.abs(p.size)
    if (p.side === 'short') size = Math.max(0, size - (hedgeShortBySymbol.get(p.symbol.toUpperCase()) ?? 0))
    const notionalUsd = size * price
    if (size > 0 && (!best || notionalUsd > best.notionalUsd)) best = { position: p, reducibleSize: size, notionalUsd }
  }
  return best
}

// ── Virtual hedge plan (cross margin, Bybit UTA) ────────────────────────────
//
// Scenario "every hedge leg fires": each sell floor has sold its venue coins
// at the trigger (USDT, ratio 1) and each leg is short virtualQty at its
// trigger. Margin balance E = stables + sale proceeds + other collateral at
// mark × ratio. Shorts N = Σ qty × trigger, their maintenance margin
// Mh = Σ N_i × mmr_i, other positions keep otherMmUsd.
//   leverage   = N / E
//   liquidation: UTA liquidates at account MMR 100% (MM ≥ margin balance).
//   With every hedged coin up x from its trigger: E − N·x = Mh·(1 + x) + otherMm
//   → x = (E − Mh − otherMm) / (N + Mh). Liquidation price_i = trigger_i × (1 + x).
// Fees and funding are left out; other coins rising with the shorts would add
// equity, also left out (conservative).

export const HEDGE_MAX_LEVERAGE = 5
export const HEDGE_MIN_LIQ_DISTANCE_PCT = 15
// Mark within this % above the trigger: the "top up now" alert.
export const HEDGE_NEAR_PCT = 3
// Bybit tier-1 MMR when the venue does not answer (BTC/ETH 0,33 %, SOL 0,5 % on 05/10/2026).
export const FALLBACK_PERP_MMR = 0.01

export interface HedgeLegInput {
  coin: string
  qty: number
  // The trigger it fires at, or the fill once open.
  price: number
  mmr: number
}

export interface HedgePlan {
  marginUsd: number
  notionalUsd: number
  maintenanceUsd: number
  leverage: number | null
  // Uniform rise of the hedged coins (%) that liquidates the account; null = no shorts.
  liqDistancePct: number | null
  // Deposit (USD) needed to pass the arm rules / reach 2x / reach 1x.
  topUpToArmUsd: number
  topUp2xUsd: number
  topUp1xUsd: number
  ok: boolean
  // Stable refusal causes (dedup key); the amounts live in `reason`.
  causes: Array<'lev' | 'liq'>
  reason: string | null
}

export function hedgePlan(input: {
  marginUsd: number
  legs: HedgeLegInput[]
  otherMmUsd?: number
  maxLeverage?: number
  minLiqDistancePct?: number
}): HedgePlan {
  const E = input.marginUsd
  const other = Math.max(0, input.otherMmUsd ?? 0)
  const maxLev = input.maxLeverage ?? HEDGE_MAX_LEVERAGE
  const minLiq = (input.minLiqDistancePct ?? HEDGE_MIN_LIQ_DISTANCE_PCT) / 100
  let N = 0
  let Mh = 0
  for (const l of input.legs) {
    if (!(l.qty > 0) || !(l.price > 0)) continue
    N += l.qty * l.price
    Mh += l.qty * l.price * Math.max(0, l.mmr)
  }
  if (!(N > 0)) {
    return {
      marginUsd: E, notionalUsd: 0, maintenanceUsd: 0, leverage: null, liqDistancePct: null,
      topUpToArmUsd: 0, topUp2xUsd: 0, topUp1xUsd: 0, ok: true, causes: [], reason: null,
    }
  }
  const leverage = E > 0 ? N / E : Infinity
  const x = (E - Mh - other) / (N + Mh)
  const needForLev = N / maxLev
  const needForLiq = minLiq * (N + Mh) + Mh + other
  const topUpToArmUsd = Math.max(0, Math.max(needForLev, needForLiq) - E)
  const levOk = leverage <= maxLev + 1e-9
  const liqOk = x >= minLiq - 1e-9
  const reasons: string[] = []
  const eu = (n: number, d: number) => n.toLocaleString('nl-BE', { maximumFractionDigits: d })
  if (!levOk) reasons.push(`Leverage after it fires ${Number.isFinite(leverage) ? eu(leverage, 2) : '∞'}x (max ${maxLev}x)`)
  if (!liqOk) reasons.push(`${reasons.length ? 'liquidation' : 'Liquidation'} ${eu(x * 100, 1)}% above the trigger (min ${eu(minLiq * 100, 0)}%)`)
  return {
    marginUsd: E,
    notionalUsd: N,
    maintenanceUsd: Mh,
    leverage,
    liqDistancePct: x * 100,
    topUpToArmUsd,
    topUp2xUsd: Math.max(0, N / 2 - E),
    topUp1xUsd: Math.max(0, N - E),
    ok: levOk && liqOk,
    causes: [...(levOk ? [] : ['lev' as const]), ...(liqOk ? [] : ['liq' as const])],
    reason: reasons.length ? `${reasons.join('; ')}. Deposit ${usdWhole(topUpToArmUsd)} USD to arm it` : null,
  }
}

// Margin balance once every sell floor has sold at its trigger: stables,
// proceeds of fired floors, coins on armed sell floors at trigger (ratio 1,
// they become USDT), everything else collateral at mark × ratio.
export function marginAfterFire(
  coins: Array<{ coin: string; walletCoin: number; mark: number | null; ratio: number; collateral: boolean }>,
  floors: Array<{ coin: string; mode: FloorMode; status: FloorStatus; holdingsCoin: number; triggerPrice: number; proceedsUsd: number | null }>,
): number {
  const sellByCoin = new Map(
    floors.filter((f) => f.mode === 'sell' && f.status !== 'closed').map((f) => [f.coin.toUpperCase(), f]),
  )
  let E = 0
  for (const c of coins) {
    const coin = c.coin.toUpperCase()
    if (isUsdLikeCoin(coin)) {
      E += c.walletCoin
      continue
    }
    const f = sellByCoin.get(coin)
    if (f && f.status === 'armed') {
      const sold = Math.min(f.holdingsCoin, Math.max(0, c.walletCoin))
      E += sold * f.triggerPrice
      if (c.collateral && c.mark != null) E += Math.max(0, c.walletCoin - sold) * c.mark * c.ratio
      continue
    }
    if (c.collateral && c.mark != null && c.walletCoin > 0) E += c.walletCoin * c.mark * c.ratio
  }
  return E
}

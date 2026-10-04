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
}

export interface PotComponent {
  coin: string
  usd: number
  source: 'floor' | 'margin' | 'sold'
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

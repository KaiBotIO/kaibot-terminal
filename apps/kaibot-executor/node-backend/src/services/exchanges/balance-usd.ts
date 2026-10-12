// USD valuation of coin-denominated balances.
//
// Deribit keeps one wallet per settlement currency (BTC, ETH, USDC), so a
// connection's equity is "0.1 BTC + 5 ETH + 9 USDC". Summing those numbers as
// if they were dollars reads the whole account as ~14, which is how the
// Exchanges strip came to show $5.248 for a book worth far more. Each coin
// amount needs the venue's own mark before anything may be added up.

import type { Balance } from './types.js'

/** Currencies already worth ~$1. No rate lookup, no drift. */
const USD_LIKE = new Set(['USD', 'USDC', 'USDT', 'USDD', 'DAI'])

export function isUsdLike(currency: string | null | undefined): boolean {
  return USD_LIKE.has((currency ?? '').toUpperCase())
}

/**
 * The venue instrument whose mark prices one unit of `currency` in USD, or null
 * when the currency needs no conversion (or we know no instrument for it).
 */
export function usdMarkSymbol(currency: string | null | undefined): string | null {
  const c = (currency ?? '').toUpperCase()
  if (!c || isUsdLike(c)) return null
  return `${c}-PERPETUAL`
}

/** Amount in USD, or null when a coin amount has no rate to convert with. */
export function usdValue(
  amount: number,
  currency: string | null | undefined,
  rate: number | null | undefined,
): number | null {
  if (!Number.isFinite(amount)) return null
  if (isUsdLike(currency)) return amount
  if (rate == null || !Number.isFinite(rate) || rate <= 0) return null
  return amount * rate
}

export interface UsdValuedBalance extends Balance {
  /** Equity in USD, null when the coin has no usable mark. */
  usdEquity: number | null
  /** Wallet balance in USD, null when the coin has no usable mark. */
  usdBalance: number | null
  /** The mark used, 1 for USD-like currencies, null when none was found. */
  usdRate: number | null
}

export function withUsdValues(
  balances: Balance[],
  rates: Map<string, number | null>,
): UsdValuedBalance[] {
  return balances.map((b) => {
    const currency = (b.currency ?? '').toUpperCase()
    const rate = isUsdLike(currency) ? 1 : rates.get(currency) ?? null
    return {
      ...b,
      usdEquity: usdValue(b.equity, currency, rate),
      usdBalance: usdValue(b.balance, currency, rate),
      usdRate: rate,
    }
  })
}

/**
 * Venue marks for every coin currency in `balances`, one lookup per currency.
 * Best effort: an adapter without a price hook, or a failing call, yields null
 * and the caller reports the coin amount without a USD figure rather than
 * inventing one.
 */
export async function usdRatesFor(
  balances: Balance[],
  getLastPrice?: (symbol: string) => Promise<number | null>,
): Promise<Map<string, number | null>> {
  const rates = new Map<string, number | null>()
  const wanted = new Map<string, string>()
  for (const b of balances) {
    const currency = (b.currency ?? '').toUpperCase()
    if (!currency || isUsdLike(currency) || wanted.has(currency)) continue
    const symbol = usdMarkSymbol(currency)
    if (symbol) wanted.set(currency, symbol)
  }
  if (wanted.size === 0 || typeof getLastPrice !== 'function') {
    for (const currency of wanted.keys()) rates.set(currency, null)
    return rates
  }
  await Promise.all(
    [...wanted].map(async ([currency, symbol]) => {
      try {
        rates.set(currency, await getLastPrice(symbol))
      } catch {
        rates.set(currency, null)
      }
    }),
  )
  return rates
}

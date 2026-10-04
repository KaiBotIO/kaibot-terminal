// Venue fees to USD.
//
// TradeStation and the USDC/USDT venues charge in the account currency, so the
// figure is the fee. Deribit's coin-margined contracts charge in the coin
// (BTC-PERPETUAL fees are in BTC): the USD figure is fee × the coin's USD
// price. For a coin future or perp the fill price IS that price, so the
// conversion is exact at the fill; anything else (an option, a fee on a
// currency the fill price does not quote) falls back to the coin's mark.

import type { FillFee } from './types.js'

const STABLE = new Set(['USD', 'USDC', 'USDT'])

// BTC-PERPETUAL, ETH-26DEC25, SOL-PERPETUAL: the instrument is priced in USD
// per unit of the fee coin.
export function isCoinUsdFuture(symbol: string, coin: string): boolean {
  const re = new RegExp(`^${coin}-(PERPETUAL|\\d{1,2}[A-Z]{3}\\d{2})$`)
  return re.test(symbol.toUpperCase())
}

export interface FeeToUsdInput {
  fee: number
  feeCurrency: string
  symbol: string
  /** Average fill price of the order the fee belongs to. */
  fillPrice?: number | null
  /** USD mark of a coin, for fees the fill price cannot convert. */
  markFor?: (coin: string) => Promise<number | null>
}

export async function feeToUsd(input: FeeToUsdInput): Promise<FillFee | null> {
  const fee = Number(input.fee)
  if (!Number.isFinite(fee)) return null
  const ccy = (input.feeCurrency || '').toUpperCase()
  const native = { feeNative: fee, feeCurrency: ccy }
  if (fee === 0) return { commission: 0, ...native }
  if (STABLE.has(ccy)) return { commission: fee, ...native }
  if (isCoinUsdFuture(input.symbol, ccy) && input.fillPrice != null && input.fillPrice > 0) {
    return { commission: fee * input.fillPrice, ...native }
  }
  const mark = input.markFor ? await input.markFor(ccy) : null
  if (mark == null || !(mark > 0)) return null
  return { commission: fee * mark, ...native }
}

// The currency Deribit charges an instrument's fees in: the stablecoin for
// linear contracts, the base coin for everything else.
export function deribitFeeCurrency(symbol: string): string {
  const s = symbol.toUpperCase()
  if (/USDC/.test(s)) return 'USDC'
  if (/USDT/.test(s)) return 'USDT'
  return s.split('-')[0] || s.split('_')[0] || 'BTC'
}

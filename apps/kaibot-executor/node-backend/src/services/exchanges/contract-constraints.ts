// Per-contract size constraints (min order size + step) keyed by
// "<exchange>:<symbol>" (lowercased). Used both when opening a position
// (factor → clip → round → min-size reject) and when closing one (round the
// resolved close quantity to a valid step, drop dust below min size).
//
// Source: Deribit (min BTC-PERPETUAL = 10 USD, step = 10; ETH-PERPETUAL = 1,
// step = 1). Bybit linear: min BTCUSDT = 0.001 BTC step 0.001; ETHUSDT 0.01.
export const EXCHANGE_CONTRACT_CONSTRAINTS: Record<string, { minSize: number; stepSize: number }> = {
  'deribit:btc-perpetual': { minSize: 10, stepSize: 10 },
  'deribit:eth-perpetual': { minSize: 1, stepSize: 1 },
  'bybit:btcusdt': { minSize: 0.001, stepSize: 0.001 },
  'bybit:ethusdt': { minSize: 0.01, stepSize: 0.01 },
}

export interface ContractConstraints {
  minSize: number
  stepSize: number
}

// Runtime-fetched constraints for symbols outside the static map (registry-
// added altcoins, USDC perps). Populated by ensureContractConstraints; the
// sync getter below reads it. Process-lifetime cache — instrument filters
// change rarely and a stale step only over-rounds.
const dynamicConstraints = new Map<string, ContractConstraints>()

function keyOf(exchange: string, symbol: string): string {
  return `${exchange.toLowerCase()}:${symbol.toLowerCase()}`
}

/**
 * Fetch min/step from the venue's public instrument info when neither the
 * static map nor the cache covers (exchange, symbol). Without this, unknown
 * symbols get {0,0} → unrounded quantities → venue rejects. Mainnet endpoints
 * on purpose: filters are metadata and testnet listings are spotty.
 */
export async function ensureContractConstraints(exchange: string, symbol: string): Promise<void> {
  const key = keyOf(exchange, symbol)
  if (EXCHANGE_CONTRACT_CONSTRAINTS[key] || dynamicConstraints.has(key)) return
  const ex = exchange.toLowerCase()
  try {
    if (ex === 'bybit') {
      const s = symbol.toUpperCase()
      const category = /(USDT|USDC|PERP)$/.test(s) ? 'linear' : /USD$/.test(s) ? 'inverse' : 'linear'
      const res = await fetch(
        `https://api.bybit.com/v5/market/instruments-info?category=${category}&symbol=${encodeURIComponent(s)}`,
      )
      const data: any = await res.json()
      const lot = data?.result?.list?.[0]?.lotSizeFilter
      const minSize = parseFloat(lot?.minOrderQty ?? '')
      const stepSize = parseFloat(lot?.qtyStep ?? '')
      if (Number.isFinite(minSize) && Number.isFinite(stepSize)) {
        dynamicConstraints.set(key, { minSize, stepSize })
      }
    } else if (ex === 'deribit') {
      const res = await fetch(
        `https://www.deribit.com/api/v2/public/get_instrument?instrument_name=${encodeURIComponent(symbol)}`,
      )
      const data: any = await res.json()
      const r = data?.result
      // Deribit amounts step in contract_size units with min_trade_amount floor
      // (inverse: USD notional; linear USDC perps: base-coin units).
      const minSize = Number(r?.min_trade_amount)
      const stepSize = Number(r?.contract_size)
      if (Number.isFinite(minSize) && Number.isFinite(stepSize) && stepSize > 0) {
        dynamicConstraints.set(key, { minSize, stepSize })
      }
    }
  } catch {
    // Offline/venue hiccup: caller proceeds with the static fallback.
  }
}

export function getContractConstraints(exchange: string, symbol: string): ContractConstraints {
  const key = keyOf(exchange, symbol)
  return EXCHANGE_CONTRACT_CONSTRAINTS[key] ?? dynamicConstraints.get(key) ?? { minSize: 0, stepSize: 0 }
}

// Single source of truth for step-rounding lives in @kaibot/types so the sim
// and the executor round identically.
export { roundToStep } from '@kaibot/types/core'

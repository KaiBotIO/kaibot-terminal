// Which venue account (wallet) a symbol trades from, per exchange. Used
// wherever a signal or a close has to name an account before the adapter is
// asked: sizing, the breathing-room guard, execution lineage rows.
//
// Multi-wallet venues (Deribit: btc / eth / usdc coin pools) derive it from
// the symbol; single-wallet venues have one fixed id, the same one their
// adapter reports on balances and positions. Adding a venue means one row
// here, not another `if (exchange === …)` in the signal client.
import { BYBIT_ACCOUNT_ID } from './adapters/bybit.js'

const FALLBACK_ACCOUNT_ID = 'default'

const SINGLE_WALLET_VENUES: Record<string, string> = {
  bybit: BYBIT_ACCOUNT_ID,
  binance: 'usdm-futures',
}

// Deribit account = settle currency. Linear USDC perps (SOL_USDC-PERPETUAL,
// BTC_USDC-PERPETUAL) settle in the USDC account — checked before the coin
// prefixes, BTC_USDC starts with BTC too.
function deribitAccountId(symbol: string): string {
  const s = symbol.toUpperCase()
  if (s.includes('_USDC')) return 'usdc'
  if (s.startsWith('BTC')) return 'btc'
  if (s.startsWith('ETH')) return 'eth'
  return 'btc'
}

export function defaultAccountIdFor(exchangeName: string, symbol: string): string {
  const ex = exchangeName.toLowerCase()
  if (ex === 'deribit') return deribitAccountId(symbol)
  return SINGLE_WALLET_VENUES[ex] ?? FALLBACK_ACCOUNT_ID
}

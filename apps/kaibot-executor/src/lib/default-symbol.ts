// Default symbol per venue for the manual-order panel. TradeStation trades
// futures roots (the backend resolves a root to the front month), the crypto
// venues their flagship perp. Unknown venue → no default.
const VENUE_DEFAULT_SYMBOL: Record<string, string> = {
  tradestation: 'MNQ',
  'interactive-brokers': 'MNQ',
  interactivebrokers: 'MNQ',
  deribit: 'BTC-PERPETUAL',
  bybit: 'BTCUSDT',
  binance: 'BTCUSDT',
  paper: 'MNQ',
};

export function defaultSymbolFor(exchange: string | null | undefined): string {
  if (!exchange) return '';
  return VENUE_DEFAULT_SYMBOL[exchange.toLowerCase()] ?? '';
}

// True when the field still holds one of the venue defaults (never typed by
// the user), so switching venue may replace it.
export function isVenueDefault(symbol: string): boolean {
  return Object.values(VENUE_DEFAULT_SYMBOL).includes(symbol.toUpperCase());
}

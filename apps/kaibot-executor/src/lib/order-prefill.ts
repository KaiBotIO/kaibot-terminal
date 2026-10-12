import { accountKeyOf, sessionKey, type ConnectionRef } from './connection';

// What the chart is showing: from /terminal?symbol=&exchange= or the Studio
// bridge's symbolChanged.
export interface OrderPrefill {
  exchange: string;
  symbol: string;
}

export interface ResolvedPrefill {
  connectionKey: string;
  symbol: string;
}

// 'interactive-brokers' vs 'interactivebrokers', 'BYBIT' vs 'bybit'.
const venueKey = (exchange: string) => exchange.toLowerCase().replace(/[^a-z0-9]/g, '');

// Accepts a bare symbol plus exchange, or a Studio pair 'BYBIT:DYDXUSDT'.
export function parseOrderPrefill(
  symbol: string | null | undefined,
  exchange: string | null | undefined,
): OrderPrefill | null {
  let sym = symbol?.trim() ?? '';
  let venue = exchange?.trim() ?? '';
  const colon = sym.indexOf(':');
  if (colon >= 0) {
    if (!venue) venue = sym.slice(0, colon);
    sym = sym.slice(colon + 1);
  }
  if (!sym || !venue) return null;
  return { exchange: venue.toLowerCase(), symbol: sym.toUpperCase() };
}

// Same chart pair → same key, so a re-sent pair is not applied twice.
export const prefillKey = (p: OrderPrefill | null): string =>
  p ? `${venueKey(p.exchange)}:${p.symbol}` : '';

// The connection on the chart's venue. The current one stays when it is
// already on that venue (acct1 keeps acct1 from BTC to ETH); otherwise the
// default one wins when an exchange has several. No connection on that venue
// (composite feed, unconnected exchange) → null.
export function resolveOrderPrefill<T extends ConnectionRef>(
  prefill: OrderPrefill | null,
  connections: T[],
  currentKey = '',
): ResolvedPrefill | null {
  if (!prefill) return null;
  const venue = venueKey(prefill.exchange);
  const onVenue = connections.filter((c) => venueKey(c.exchangeName) === venue);
  if (onVenue.length === 0) return null;
  const pick =
    onVenue.find((c) => sessionKey(c) === currentKey) ??
    onVenue.find((c) => accountKeyOf(c) === null) ??
    onVenue[0];
  return { connectionKey: sessionKey(pick), symbol: prefill.symbol };
}

// Deribit accounts are settle-currency wallets ('btc', 'acct1/eth'). Mirrors
// node-backend venue-accounts.ts: USDC linears first, BTC_USDC starts with BTC.
function deribitCurrencyOf(symbol: string): string | null {
  const s = symbol.toUpperCase();
  if (s.includes('_USDC')) return 'usdc';
  if (s.startsWith('BTC')) return 'btc';
  if (s.startsWith('ETH')) return 'eth';
  return null;
}

// The listed account a symbol trades from on a per-currency venue; null when
// the venue has one wallet or the symbol names no known currency.
export function venueAccountIdFor(
  exchange: string,
  symbol: string,
  accounts: Array<{ accountId: string }>,
): string | null {
  if (exchange.toLowerCase() !== 'deribit') return null;
  const currency = deribitCurrencyOf(symbol);
  if (!currency) return null;
  const hit = accounts.find((a) => a.accountId === currency || a.accountId.endsWith(`/${currency}`));
  return hit?.accountId ?? null;
}

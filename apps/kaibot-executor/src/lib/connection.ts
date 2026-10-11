// One exchange can carry several connections (two Deribit accounts, each with
// its own API key). A session is identified by exchange + connection label;
// per-exchange API routes take `?account=<label>` to pick a labeled one.
export interface ConnectionRef {
  exchangeName: string;
  label?: string | null;
  accountKey?: string | null;
  connectionId?: string;
}

export const DEFAULT_LABEL = "default";

export function accountKeyOf(ref: ConnectionRef): string | null {
  const key = ref.accountKey ?? (ref.label && ref.label !== DEFAULT_LABEL ? ref.label : null);
  return key || null;
}

// Stable map/row key for a session.
export function sessionKey(ref: ConnectionRef): string {
  const key = accountKeyOf(ref);
  return key ? `${ref.exchangeName}:${key}` : ref.exchangeName;
}

// Human label: "deribit" or "deribit · acct2".
export function connectionLabel(ref: ConnectionRef): string {
  const key = accountKeyOf(ref);
  return key ? `${ref.exchangeName} · ${key}` : ref.exchangeName;
}

// Query suffix for the per-exchange routes. Always names the connection:
// without it the backend aggregates every connection on the exchange, which
// would fold a second account's balances into the default row.
export function accountQuery(ref: ConnectionRef): string {
  return `?account=${encodeURIComponent(accountKeyOf(ref) ?? DEFAULT_LABEL)}`;
}

// Connection label carried by a namespaced account id ('acct2/btc' → 'acct2').
export function accountKeyFromAccountId(accountId: string | null | undefined): string | null {
  if (!accountId) return null;
  const i = accountId.indexOf("/");
  return i > 0 ? accountId.slice(0, i) : null;
}

// Typed client for the edge hedge guard (/api/trade/hedge). The user arms a
// pre-authorized protective hedge on an open position: on an adverse breach of
// the trigger the executor opens an opposite position on a PAIRED instrument
// (a same-symbol hedge would net the position away on the venue) and links it
// into the position's group.
import { apiFetch } from './api';

export type HedgeAction = 'arm' | 'update' | 'disarm' | 'close';
export type HedgeSizeMode = 'match' | 'fixed-usd';
export type HedgeOnMainClose = 'keep' | 'close';
export type HedgeStatus = 'armed' | 'hedged' | 'closed' | 'orphaned';

export interface HedgeInput {
  action: HedgeAction;
  exchange: string;
  symbol: string;
  accountId?: string;
  triggerPrice?: number;
  hedgeSymbol?: string;
  hedgeAccountId?: string;
  sizeMode?: HedgeSizeMode;
  fixedUsd?: number | null;
  recoveryPrice?: number | null;
  onMainClose?: HedgeOnMainClose;
}

export interface HedgeGuardView {
  positionKey: string;
  exchange: string;
  accountId: string;
  symbol: string;
  direction: 'long' | 'short';
  hedgeSymbol: string;
  hedgeAccountId: string;
  triggerPrice: number;
  sizeMode: HedgeSizeMode;
  fixedUsd: number | null;
  recoveryPrice: number | null;
  onMainClose: HedgeOnMainClose;
  status: HedgeStatus;
  hedgeSide: 'buy' | 'sell' | null;
  hedgeQty: number | null;
  hedgeEntryPrice: number | null;
  hedgeOpenedTs: number | null;
  closeReason: string | null;
  lastError: string | null;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await apiFetch(path);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error || `HTTP ${res.status}`);
  return json as T;
}

export const hedgeApi = {
  manage: (input: HedgeInput) => postJson<HedgeGuardView>('/api/trade/hedge', input),
  list: () => getJson<{ hedges: HedgeGuardView[] }>('/api/trade/hedge'),
};

// Default paired instrument (mirror of the backend derivation, prefill only).
export function defaultHedgeSymbolFor(exchange: string, symbol: string): string | null {
  if (exchange.toLowerCase() !== 'deribit') return null;
  const s = symbol.toUpperCase();
  let m = s.match(/^([A-Z]+)_USDC-PERPETUAL$/);
  if (m) return `${m[1]}-PERPETUAL`;
  m = s.match(/^([A-Z]+)-PERPETUAL$/);
  if (m) return `${m[1]}_USDC-PERPETUAL`;
  return null;
}

// Typed client for the Synthetic USD feature (/api/synthetic-usd/*).
import { apiFetch } from './api';

export interface SyntheticUsdPosition {
  id: string;
  exchange: string;
  account_id: string;
  symbol: string;
  target_usd: number;
  holdings_basis_usd: number;
  leverage: number;
  short_size: number;
  // User-authored protective ceiling (target_usd <= basis * leverage_cap).
  leverage_cap: number;
  status: 'open' | 'closed';
  is_factor_basis: number;
  auto_rebalance: number;
  rebalance_target_pct: number;
  rebalance_band_pct: number;
  rebalance_basis: string;
  last_rebalance_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface SyntheticUsdMutation {
  id: number;
  position_id: string;
  kind: 'mint' | 'scale_up' | 'scale_down' | 'close' | 'auto_rebalance';
  target_usd_before: number;
  target_usd_after: number;
  short_size_before: number;
  short_size_after: number;
  order_id: string | null;
  order_side: string | null;
  order_qty: number | null;
  created_at: number;
}

export interface HoldingsBasisLine {
  source: string;
  usd_value: number;
  is_manual: number;
  updated_at: number;
}

export interface SyntheticUsdList {
  positions: SyntheticUsdPosition[];
  holdingsBasisUsd: number;
  leverageCap: number;
  // Global loop gate (SYNTHETIC_REBALANCE_ENABLED on the executor).
  rebalanceEnabled: boolean;
}

export interface SyntheticUsdDetail {
  position: SyntheticUsdPosition;
  mutations: SyntheticUsdMutation[];
}

export interface HoldingsBasis {
  lines: HoldingsBasisLine[];
  total: number;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await apiFetch(path);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await apiFetch(path, {
    method: body === undefined ? 'POST' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error || `HTTP ${res.status}`);
  return json as T;
}

export const syntheticUsdApi = {
  list: (includeClosed = false) =>
    getJson<SyntheticUsdList>(`/api/synthetic-usd${includeClosed ? '?includeClosed=true' : ''}`),
  holdingsBasis: () => getJson<HoldingsBasis>('/api/synthetic-usd/holdings-basis'),
  setManualHoldings: async (label: string, usdValue: number) => {
    const res = await apiFetch('/api/synthetic-usd/holdings-basis', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, usdValue }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((json as { error?: string }).error || `HTTP ${res.status}`);
    return json as HoldingsBasis;
  },
  detail: (id: string) => getJson<SyntheticUsdDetail>(`/api/synthetic-usd/${id}`),
  mint: (input: {
    exchange: string;
    accountId: string;
    symbol: string;
    targetUsd: number;
    leverageCap?: number;
  }) => postJson<SyntheticUsdDetail>('/api/synthetic-usd', input),
  scale: (id: string, targetUsd: number) =>
    postJson<SyntheticUsdDetail>(`/api/synthetic-usd/${id}/scale`, { targetUsd }),
  close: (id: string) => postJson<SyntheticUsdDetail>(`/api/synthetic-usd/${id}/close`),
  setFactorBasis: (id: string, enabled: boolean) =>
    postJson<SyntheticUsdDetail>(`/api/synthetic-usd/${id}/factor-basis`, { enabled }),
  setAutoRebalance: (id: string, cfg: { enabled: boolean; targetPct?: number; bandPct?: number }) =>
    postJson<SyntheticUsdDetail>(`/api/synthetic-usd/${id}/auto-rebalance`, cfg),
};

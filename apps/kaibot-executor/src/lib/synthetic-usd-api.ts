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
  // 'armed' = trigger authored, nothing minted yet (dynamic synthetic).
  status: 'open' | 'closed' | 'armed';
  is_factor_basis: number;
  auto_rebalance: number;
  rebalance_target_pct: number;
  rebalance_band_pct: number;
  rebalance_basis: string;
  last_rebalance_at: number | null;
  arm_trigger_price: number | null;
  arm_holdings_coin: number | null;
  arm_planned_usd: number | null;
  arm_cycle: number;
  created_at: number;
  updated_at: number;
  // Computed by the backend for every listed row.
  armed: ArmedView;
  // 'usd' (inverse: short_size is a USD notional) | 'coin' (linear: coin qty).
  shortUnit: 'usd' | 'coin';
  // Connection label carried by account_id (null = default connection).
  accountKey: string | null;
  // Value + phase this row lends to signal sizing while flagged (null otherwise).
  sizingBasis: { usd: number; kind: 'armed' | 'realized' | 'open' } | null;
}

// Armed (dynamic) synthetic view. inCycle=false on a plain position.
export interface ArmedView {
  inCycle: boolean;
  direction: 'long' | 'short' | null;
  triggerPrice: number | null;
  triggerPriceInitial: number | null;
  holdingsCoin: number | null;
  // holdings × trigger while armed (planned); holdings × fill once minted (realized).
  protectedUsd: number | null;
  protection: 'planned' | 'realized' | null;
  mark: number | null;
  markAt: number | null;
  distanceToTriggerPct: number | null;
  upsideUsd: number | null;
  // Open arm-cycle rows: short notional − holdings × fill (the gap over-hedge).
  overHedgeUsd: number | null;
  trailPct: number | null;
  trailAbs: number | null;
  highWater: number | null;
  recoveryPrice: number | null;
  recoveryPct: number | null;
  recoveryLevel: number | null;
  tolerancePct: number;
  firedTriggerPrice: number | null;
  firedPrice: number | null;
  firedAt: number | null;
  cycle: number;
  armedAt: number | null;
  lastError: string | null;
}

export interface SyntheticUsdMutation {
  id: number;
  position_id: string;
  kind:
    | 'mint'
    | 'scale_up'
    | 'scale_down'
    | 'close'
    | 'auto_rebalance'
    | 'arm'
    | 'arm_update'
    | 'disarm'
    | 'recovery_close';
  target_usd_before: number;
  target_usd_after: number;
  short_size_before: number;
  short_size_after: number;
  order_id: string | null;
  order_side: string | null;
  order_qty: number | null;
  // JSON (planned vs realized on arm-cycle mutations).
  meta: string | null;
  created_at: number;
}

export interface SyntheticArmInput {
  exchange: string;
  accountId: string;
  // Connection label; omit for the default connection.
  accountKey?: string | null;
  symbol: string;
  triggerPrice: number;
  holdingsCoin?: number;
  trailPct?: number | null;
  trailAbs?: number | null;
  recoveryPrice?: number | null;
  recoveryPct?: number | null;
  tolerancePct?: number;
  leverageCap?: number;
}

export type SyntheticArmUpdate = Partial<
  Pick<SyntheticArmInput, 'triggerPrice' | 'holdingsCoin' | 'trailPct' | 'trailAbs' | 'recoveryPrice' | 'recoveryPct' | 'tolerancePct'>
>;

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
  arm: (input: SyntheticArmInput) => postJson<SyntheticUsdDetail>('/api/synthetic-usd/arm', input),
  updateArm: (id: string, patch: SyntheticArmUpdate) =>
    postJson<SyntheticUsdDetail>(`/api/synthetic-usd/${id}/arm-update`, patch),
  disarm: (id: string) => postJson<SyntheticUsdDetail>(`/api/synthetic-usd/${id}/disarm`),
};

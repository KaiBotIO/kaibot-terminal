import { apiFetch } from './api';

export type AccumulatePhase = 'ladder' | 'riding' | 'waiting' | 'stopped';

export interface AccumulateParams {
  lookbackBars: number;
  barMinutes: number;
  rungStepPct: number;
  rungPct: number;
  rungCount: number;
  startPct: number;
  rideStopExtraSteps: number;
  reanchorOnBreakout: boolean;
}

export const DEFAULT_ACCUMULATE_PARAMS: AccumulateParams = {
  lookbackBars: 48,
  barMinutes: 60,
  rungStepPct: 1,
  rungPct: 1,
  rungCount: 10,
  startPct: 34,
  rideStopExtraSteps: 1,
  reanchorOnBreakout: true,
};

export interface AccumulateInput {
  exchange: string;
  symbol: string;
  accountId: string;
  rideBotId: string;
  params?: Partial<AccumulateParams>;
  direction?: 'long' | 'short';
  reference?: number;
  adoptRungs?: boolean;
}

export interface AccumulateRung {
  idx: number;
  price: number;
  qty: number;
}

export interface AccumulatePreview {
  direction: 'long' | 'short';
  mark: number;
  basisUsd: number;
  reference: number;
  entryBarTime: number;
  localLevel: number | null;
  position: { qty: number; entryPrice: number; usd: number } | null;
  positionPctOfBasis: number | null;
  ladder: AccumulateRung[];
  rideStop: number;
  adoptableRungs: Array<{ orderId: string; price: number | null; qty: number }>;
  activeRide: { positionId: string; botName: string | null } | null;
  floor: AccumulateFloor | null;
  params: AccumulateParams;
}

export interface AccumulateFloor {
  status: string;
  triggerPrice: number | null;
  holdingsCoin: number | null;
  shortSize: number;
}

export interface AccumulatePlan {
  id: string;
  exchange: string;
  accountId: string;
  symbol: string;
  direction: 'long' | 'short';
  rideBotId: string;
  params: AccumulateParams;
  phase: AccumulatePhase;
  reference: number;
  entryBarTime: number;
  localLevel: number | null;
  watchLevel: number | null;
  basisUsd: number | null;
  position: { qty: number } | null;
  ride: { positionId: string; currentStop: number | null; botId: string | null; botName: string | null } | null;
  rungs: {
    open: number;
    filled: number;
    openQty: number;
    filledQty: number;
    list: Array<{
      order_id: string;
      idx: number;
      price: number;
      qty: number;
      state: 'open' | 'filled' | 'cancelled';
      filled_qty: number;
      ladder_seq: number;
      adopted: number;
    }>;
  };
  floor: AccumulateFloor | null;
  pending: boolean;
  lastNote: string | null;
  lastError: string | null;
  lastBreakout: { barTime: number; close: number; level: number } | null;
  createdAt: number;
  updatedAt: number;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await apiFetch(path);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await apiFetch(path, {
    method: 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error || `HTTP ${res.status}`);
  return json as T;
}

export const accumulateApi = {
  list: () => getJson<{ plans: AccumulatePlan[] }>('/api/accumulate'),
  preview: (input: AccumulateInput) => postJson<AccumulatePreview>('/api/accumulate/preview', input),
  create: (input: AccumulateInput) => postJson<{ plan: AccumulatePlan }>('/api/accumulate', input),
  stop: (id: string) => postJson<{ plan: AccumulatePlan }>(`/api/accumulate/${encodeURIComponent(id)}/stop`),
  check: (id: string) => postJson<{ plan: AccumulatePlan }>(`/api/accumulate/${encodeURIComponent(id)}/check`),
};

export const PHASE_LABEL: Record<AccumulatePhase, string> = {
  ladder: 'Laddering',
  riding: 'Riding',
  waiting: 'Waiting for breakout',
  stopped: 'Stopped',
};

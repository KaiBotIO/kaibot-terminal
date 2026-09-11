// Typed client for the edge manager engine on the local executor
// (/api/trade/managers — F2, pilot-ladder decomposition). Allowlisted IP-free
// reducers attached per position; protect/reduce-only (stops + reduce-closes,
// never entries). Kept out of manual-trade-api.ts so the manual-order surface
// and the manager surface evolve independently.
import { apiFetch } from './api';

export type ManagersAction = 'attach' | 'configure' | 'detach';

export type EdgeManagerId = 'break-even-mover' | 'tp-ladder' | 'risk-guard' | 'group-risk-guard';

// Params mirror the SDK schemas (defaults applied server-side).
export interface BreakEvenMoverParams {
  feePercentage?: number; // fraction, e.g. 0.0015
  triggerPercentage?: number; // % into profit before the move; 0 = immediately
  useEntryReference?: boolean;
  referencePrice?: number;
}

export interface TpLadderParams {
  prices?: number[]; // explicit rungs (win over the derived ladder)
  target?: number; // derived mode: golden-fib spacing from entry toward target
  levelCount?: number; // 1..6 rungs from the target
  fractionPerTranche?: number; // fraction of the ORIGINAL size per rung
  runnerFraction?: number; // held back, never laddered out
}

export interface RiskGuardParams {
  maxSize?: number; // lock adds past this size
  globalStopPrice?: number; // hard full-close level (max-loss lock)
  releaseLockAfter?: number;
}

// Group scope (G2): watches the group aggregate, closes its OWN position on
// breach. Attach it on every member of the group. At least one threshold.
export interface GroupRiskGuardParams {
  maxGroupLossFraction?: number; // fraction of equity, e.g. 0.02
  maxGroupNotional?: number;
}

export interface ManagersInput {
  action: ManagersAction;
  exchange: string;
  symbol: string;
  accountId?: string;
  managerId: EdgeManagerId;
  params?: Record<string, unknown>;
}

export interface ManagerRunnerStateView {
  lastTs: number | null;
  position: 'none' | 'long' | 'short';
  scratch: Record<string, number | string | boolean | null>;
}

export interface AttachedManagerView {
  managerId: string;
  execOrder: number;
  params: Record<string, unknown>;
  state: ManagerRunnerStateView;
  active: boolean;
  updatedAt: number;
}

export interface ManagedPositionView {
  key: string;
  exchange: string;
  accountId: string | null;
  symbol: string;
  direction: 'long' | 'short';
  avgEntryPrice: number;
  size: number;
  extremePrice: number;
  oppositePrice: number;
  currentStopLoss: number | null;
  referencePrice: number | null;
  openedTs: number;
  active: boolean;
  updatedAt: number;
  managers: AttachedManagerView[];
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

export const positionManagersApi = {
  manage: (input: ManagersInput) => postJson<ManagedPositionView>('/api/trade/managers', input),
  list: () => getJson<{ positions: ManagedPositionView[] }>('/api/trade/managers'),
};

// Count of already-fired TP rungs from the reducer's threaded state.
export function tpFiredCount(state: ManagerRunnerStateView | undefined): number {
  const raw = state?.scratch?.tpTriggered;
  if (typeof raw !== 'string' || raw.length === 0) return 0;
  try {
    const arr = JSON.parse(raw) as number[];
    return Array.isArray(arr) ? arr.length : 0;
  } catch {
    return 0;
  }
}

// Typed client for the Collateral feature (/api/collateral/*).
import { apiFetch } from './api';

export type FloorMode = 'hedge' | 'sell'
export type FloorStatus = 'armed' | 'fired' | 'closed'
export type SizingBasisMode = 'off' | 'floor'
export type UnflooredMode = 'exclude' | 'margin'
export type MarginState = 'ok' | 'warn' | 'block' | 'unknown'

export interface CollateralFloorView {
  id: string
  exchange: string
  accountId: string
  coin: string
  mode: FloorMode
  status: FloorStatus
  symbol: string              // hedge: 'BTCUSDT' perp; sell: 'BTCUSDT' spot
  holdingsCoin: number
  triggerPrice: number
  triggerPriceInitial: number | null
  trailPct: number | null
  recoveryPct: number | null
  tolerancePct: number
  buyBack: boolean            // sell mode only
  plannedFloorUsd: number     // holdings × trigger
  realizedFloorUsd: number | null  // after fire: holdings × fill
  mark: number | null
  distanceToTriggerPct: number | null
  firedPrice: number | null
  firedAt: number | null
  cycle: number
  syntheticPositionId: string | null  // hedge mode
  venueOrderId: string | null         // sell mode: resting conditional sell (or buy-back when fired)
  lastError: string | null
  createdAt: number
  updatedAt: number
}

export interface CollateralCoinView {
  coin: string
  walletBalance: number
  equity: number
  borrowAmount: number
  markPrice: number | null
  usdValue: number
  collateralSwitch: boolean
  marginCollateral: boolean
  collateralRatio: number
  ratioSource: 'venue' | 'override' | 'default'
  marginValueUsd: number      // usdValue × ratio (0 when collateral off)
  floor: CollateralFloorView | null
}

export interface PotComponent { coin: string; usd: number; source: 'floor' | 'margin' | 'sold' }
export interface PotView {
  mode: SizingBasisMode
  unfloored: UnflooredMode
  potUsd: number
  components: PotComponent[]
  usedNotionalUsd: number
  freeUsd: number
  capMult: number             // 1
}

export interface MarginView {
  accountIMRate: number | null   // fraction, 0.12 = 12 %
  accountMMRate: number | null
  totalEquity: number | null
  totalAvailableBalance: number | null
  totalInitialMargin: number | null
  totalMaintenanceMargin: number | null
  blockMmrPct: number
  warnMmrPct: number
  autoReduce: boolean
  autoReducePct: number
  state: MarginState
}

export interface CollateralSettings {
  exchange: string
  accountId: string
  sizingBasis: SizingBasisMode
  unfloored: UnflooredMode
  blockMmrPct: number
  warnMmrPct: number
  autoReduce: boolean
  autoReducePct: number
  ratioOverrides: Record<string, number>
}

export interface CollateralOverview {
  exchange: string
  accountId: string
  coins: CollateralCoinView[]
  pot: PotView
  margin: MarginView
  settings: CollateralSettings
  fetchedAt: number
  error: string | null
}

export interface CollateralAccountRef { exchange: string; accountId: string; label: string | null; connected: boolean }

export interface ArmFloorInput {
  exchange: string
  accountId: string
  coin: string
  mode: FloorMode
  triggerPrice: number
  holdingsCoin?: number
  trailPct?: number | null
  recoveryPct?: number | null
  tolerancePct?: number
  buyBack?: boolean
}

export type UpdateFloorInput = Partial<
  Pick<ArmFloorInput, 'triggerPrice' | 'holdingsCoin' | 'trailPct' | 'recoveryPct' | 'tolerancePct' | 'buyBack'>
>

export type CollateralSettingsPatch = Partial<CollateralSettings> & { exchange: string; accountId: string }

async function send<T>(path: string, method: 'GET' | 'POST' | 'PUT', body?: unknown): Promise<T> {
  const res = await apiFetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error || `HTTP ${res.status}`);
  return json as T;
}

export const collateralApi = {
  accounts: () => send<{ accounts: CollateralAccountRef[] }>('/api/collateral/accounts', 'GET'),
  overview: (exchange: string, accountId: string) =>
    send<CollateralOverview>(
      `/api/collateral?exchange=${encodeURIComponent(exchange)}&accountId=${encodeURIComponent(accountId)}`,
      'GET',
    ),
  arm: (input: ArmFloorInput) => send<{ floor: CollateralFloorView }>('/api/collateral/floors', 'POST', input),
  update: (id: string, patch: UpdateFloorInput) =>
    send<{ floor: CollateralFloorView }>(`/api/collateral/floors/${encodeURIComponent(id)}/update`, 'POST', patch),
  disarm: (id: string) =>
    send<{ floor: CollateralFloorView }>(`/api/collateral/floors/${encodeURIComponent(id)}/disarm`, 'POST'),
  saveSettings: (patch: CollateralSettingsPatch) =>
    send<{ settings: CollateralSettings }>('/api/collateral/settings', 'PUT', patch),
};

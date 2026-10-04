// Typed client for manual (discretionary) trading on the local executor
// (/api/trade/*) plus the bot take-over control plane (/api/bots/*). All of it
// runs edge-side against the user's own connected exchange — no server signal.
import { apiFetch } from './api';

export type ManualOrderType = 'market' | 'limit' | 'stop';

export type SizeUnit = 'native' | 'usd';

// One authored entry rung. Only the first rung may omit `price` (market
// entry); every later rung rests as a limit add at the venue — the user
// authorizes all adds up front, the executor never originates one.
export interface ManualEntryRung {
  price?: number;
  size: number;
}

// One TP ladder leg: close `fraction` of the TOTAL position at `price`.
// Fractions sum to ≤ 1.
export interface ManualTakeProfitLeg {
  price: number;
  fraction: number;
}

export interface ManualOrderInput {
  exchange: string;
  symbol: string;
  side: 'buy' | 'sell';
  orderType?: ManualOrderType;
  quantity: number; // TOTAL size in sizeUnit (with entries: the ladder's sum)
  // 'native' (default) = contracts/coin; 'usd' = USD notional, converted to
  // venue-native (rounded to the contract step) by the executor.
  sizeUnit?: SizeUnit;
  price?: number;
  stopLoss?: number;
  takeProfit?: number;
  // Entry ladder — replaces the single entry (omit orderType/price when set).
  entries?: ManualEntryRung[];
  // TP ladder — replaces the single takeProfit when set.
  takeProfits?: ManualTakeProfitLeg[];
  accountId?: string;
  // Per-submit token so a retried/duplicate POST doesn't place a second order.
  idempotencyKey?: string;
}

export interface ManualOrderResult {
  orderId: string;
  status: 'pending' | 'filled' | 'partially_filled' | 'cancelled' | 'rejected';
  filledQuantity?: number;
  averagePrice?: number;
  stopLossOrderId?: string;
  takeProfitOrderId?: string; // first TP leg (back-compat)
  takeProfitOrderIds?: string[]; // full TP ladder
  entryRungOrderIds?: string[]; // resting entry rungs after the main order
  warnings?: string[];
}

export interface ManualCloseResult {
  orderId: string;
  status: 'pending' | 'filled' | 'partially_filled' | 'cancelled' | 'rejected';
  filledQuantity?: number;
  averagePrice?: number;
  closedQuantity: number;
}

export interface ExecutorBot {
  id: string;
  signalBotId: string;
  botName: string | null;
  strategyId: string;
  strategyName: string | null;
  strategyType: string;
  exchange: string;
  symbol: string;
  timeframe: string;
  status: 'running' | 'paused' | 'stopped';
  executionTarget: 'kaibot' | 'webhook';
  alertWebhookUrl: string | null;
}

// detachBot returns the applied take-over plan (or needed:false when the
// position was already manual). We only read `needed` in the UI.
export interface TakeOverResult {
  needed: boolean;
  deactivateStrategyId?: string | null;
  retireManagers?: boolean;
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

// ── Recovery-ladder composer (protected server calculator) ──
// The executor backend proxies tRPC manualTools.computeRecoveryLadder with the
// user's own kb_ API key; only rung prices + sizes come back. The user reviews
// and can edit every rung before placing — they stay user-authored orders.

export type ComposeErrorCode =
  | 'no-config'
  | 'unauthorized'
  | 'forbidden'
  | 'rate-limited'
  | 'bad-request'
  | 'unavailable';

export class ComposeError extends Error {
  constructor(
    message: string,
    public readonly code: ComposeErrorCode | undefined,
  ) {
    super(message);
    this.name = 'ComposeError';
  }
}

export interface RecoveryComposeInput {
  extreme: number; // pre-drop peak (band anchor)
  entry: number; // entry / reference price
  totalQty: number; // total size across all rungs (panel's size unit)
  assetClass: 'crypto' | 'tradfi';
  levels?: number;
  includeRecoveryTail?: boolean;
}

export interface RecoveryComposeResult {
  rungs: Array<{ price: number; size: number }>;
  avgIfAllFilled: number;
  meta: { levelsUsed: number };
}

export const composeApi = {
  recoveryLadder: async (input: RecoveryComposeInput): Promise<RecoveryComposeResult> => {
    const res = await apiFetch('/api/trade/compose-recovery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const json = (await res.json().catch(() => ({}))) as {
      error?: string;
      code?: ComposeErrorCode;
    };
    if (!res.ok) throw new ComposeError(json.error || `HTTP ${res.status}`, json.code);
    return json as unknown as RecoveryComposeResult;
  },
};

export const manualTradeApi = {
  place: (input: ManualOrderInput) => postJson<ManualOrderResult>('/api/trade/order', input),
  close: (input: {
    exchange: string;
    symbol: string;
    fraction?: number;
    accountId?: string;
    idempotencyKey?: string;
  }) => postJson<ManualCloseResult>('/api/trade/close', input),
};

// ── Contract roll: close an expiring dated future, reopen on the next one ──

export type RollLegOrderType = 'market' | 'limit';

export interface RollPreview {
  exchange: string;
  accountId: string;
  fromSymbol: string;
  toSymbol: string;
  side: 'long' | 'short';
  size: number;
  closeSide: 'buy' | 'sell';
  openSide: 'buy' | 'sell';
  multiplier: number;
  fromPrice: number | null;
  toPrice: number | null;
  spread: number | null;
  /** Signed cost excl. fees (positive = the roll costs money). */
  estCost: number | null;
  expiry: {
    date: string;
    daysLeft: number;
    source: 'exchange-provided' | 'calculated';
    nextSymbol: string | null;
  } | null;
}

export interface RollLegReport {
  symbol: string;
  orderId: string;
  status: 'pending' | 'filled' | 'partially_filled' | 'cancelled' | 'rejected';
  filledQuantity?: number;
  averagePrice?: number;
}

export interface RollResult {
  status: 'rolled' | 'aborted' | 'restored' | 'incomplete';
  requestedQuantity: number;
  rolledQuantity: number;
  closeLeg?: RollLegReport;
  openLeg?: RollLegReport;
  restoreLeg?: RollLegReport;
  warnings: string[];
}

export const rollApi = {
  preview: (input: { exchange: string; symbol: string; accountId?: string; toSymbol?: string }) =>
    postJson<RollPreview>('/api/trade/roll/preview', input),
  execute: (input: {
    exchange: string;
    symbol: string;
    toSymbol: string;
    accountId?: string;
    legOrderType?: RollLegOrderType;
    closeLimitPrice?: number;
    openLimitPrice?: number;
    idempotencyKey?: string;
  }) => postJson<RollResult>('/api/trade/roll', input),
};

// ── Position management: edge trail + break-even on any open position ──
// Reduce/protect-only: arm/adjust/lock/remove a protective STOP. Never entries.

export type ManageAction = 'arm' | 'update' | 'lock' | 'unlock' | 'remove';

export type TrailMode = 'fixed' | 'drawdown';

export interface ManageTrailParams {
  mode: TrailMode;
  // fixed: constant trail distance; drawdown: floor on the trail distance.
  // Points win over pct.
  trailPercentage?: number | null;
  trailPoints?: number | null;
  maxPercentage?: number | null;
  maxPoints?: number | null;
  // Drawdown only: trail off a FIXED pre-arm swing (referencePrice, defaults to
  // the arm-time mark) instead of the advancing favourable extreme.
  freezeExtreme?: boolean;
  referencePrice?: number | null;
  usePoints?: boolean;
}

export interface ManagePositionInput {
  action: ManageAction;
  exchange: string;
  symbol: string;
  accountId?: string;
  trail?: ManageTrailParams | null;
  breakevenFee?: number | null;
  // The user's own stop — always participates; under lock it is absolute.
  manualStop?: number | null;
  trailingLock?: boolean;
}

export interface ManagedTrailView {
  key: string;
  exchange: string;
  accountId: string | null;
  symbol: string;
  direction: 'long' | 'short';
  source: 'signal' | 'manual';
  mode: TrailMode;
  entryPrice: number;
  trailPercentage: number | null;
  trailPoints: number | null;
  maxPercentage: number | null;
  maxPoints: number | null;
  breakevenFee: number | null;
  freezeExtreme: boolean;
  usePoints: boolean;
  referencePrice: number | null;
  trailingLock: boolean;
  manualStop: number | null;
  engineStop: number | null;
  // The stop actually resting at the venue right now.
  currentStop: number | null;
  // What the composition rule resolves to (manual participates, engine
  // improves, lock = manual absolute).
  effectiveStop: number | null;
  extremePrice: number;
  oppositePrice: number | null;
  active: boolean;
  updatedAt: number;
}

// The user's stop floor on a BOT-managed position: the bot keeps the exit,
// the floor only lifts its venue stop (locked: the floor is the stop). One
// row per active bot position, floor set or not.
export interface StopFloorView {
  kind: 'floor';
  positionId: string;
  entrySignalId: string;
  exchange: string;
  accountId: string | null;
  symbol: string;
  direction: 'long' | 'short';
  manualStop: number | null;
  trailingLock: boolean;
  // The bot's own stop.
  engineStop: number | null;
  // The stop actually resting at the venue right now.
  currentStop: number | null;
  effectiveStop: number | null;
  active: boolean;
  updatedAt: number;
}

export const positionManageApi = {
  // arm yields a trail row; update/lock/unlock/remove land on the trail row
  // or, on a bot position without one, on its stop floor.
  manage: (input: ManagePositionInput) =>
    postJson<ManagedTrailView | StopFloorView>('/api/trade/manage', input),
  list: () => getJson<{ trails: ManagedTrailView[]; floors: StopFloorView[] }>('/api/trade/manage'),
};

// ── Ride hand-over (server-side ride-only bot manages the exit) ──
export interface RideBot {
  id: string;
  name: string;
  strategyName: string;
  rootMinutes: number;
  timeframe: string;
  ladderMinutes: number[];
  markets: string[];
}

export interface HandOverInput {
  exchange: string;
  symbol: string;
  accountId?: string;
  botId: string;
  botName?: string;
  canonicalSymbol?: string;
  marketExchange?: string;
  openedAt?: string;
  stopPrice?: number;
  anchor?: number;
  ladderFrom?: 'entry' | 'now';
}

export interface HandOverPreview {
  position: { symbol: string; side: 'long' | 'short'; size: number; entryPrice: number; accountId: string };
  canonicalSymbol: string;
  marketExchange: string;
  openedAt: string;
  adoptableStop: { slOrderId: string; currentStop: number | null } | null;
  stopPrice: number | null;
  detaches: { managers: string[]; trails: number };
  server: {
    error?: string;
    timeframe?: string;
    barsReplayed?: number;
    level?: number;
    exit?: { reason: string; barTs: string } | null;
    partials?: number;
    framesReady?: boolean;
  } | null;
}

export interface HandOverResult {
  positionId: string;
  runId: string;
  timeframe: string;
  plan: string;
  stop: { price: number; slOrderId: string; placed: boolean };
  detached: { managers: string[]; trails: number };
}

export interface ActiveRide {
  positionId: string;
  exchange: string;
  symbol: string;
  accountId: string | null;
  direction: 'long' | 'short';
  botId: string | null;
  botName: string | null;
  currentStop: number | null;
}

export const rideApi = {
  bots: () => getJson<{ bots: RideBot[] }>('/api/trade/handover/bots'),
  list: () => getJson<{ rides: ActiveRide[] }>('/api/trade/handover/list'),
  preview: (input: HandOverInput) => postJson<HandOverPreview>('/api/trade/handover/preview', input),
  handOver: (input: HandOverInput) => postJson<HandOverResult>('/api/trade/handover', input),
  takeBack: (positionId: string) =>
    postJson<{ positionId: string; released: boolean }>('/api/trade/takeback', { positionId }),
};

// ── Adopt a manual position into a refused bot entry's lineage ──
export interface AdoptCandidate {
  signalId: string;
  botId: string;
  botName: string | null;
  subscriptionId: string;
  strategyName: string | null;
  action: 'buy' | 'sell';
  price: number | null;
  stopLoss: number | null;
  receivedAt: string;
  reason: string | null;
  positionId: string | null;
  venueSymbol: string;
}

export interface AdoptInput {
  exchange: string;
  symbol: string;
  accountId?: string;
  signalId: string;
  stopPrice?: number;
  openedAt?: string;
}

export interface AdoptResult {
  signalId: string;
  botId: string;
  botName: string | null;
  exchange: string;
  accountId: string;
  symbol: string;
  canonicalSymbol: string;
  direction: 'long' | 'short';
  qty: number;
  avgPrice: number;
  openedAt: string;
  stop: { price: number | null; slOrderId: string | null; source: 'lineage' | 'manual' | 'placed' };
  positionId: string | null;
  serverAck: { ok: boolean; positionId: string | null } | null;
  alreadyAdopted: boolean;
  detached: { managers: string[]; trails: number };
}

export const adoptApi = {
  candidates: (q: { exchange: string; symbol: string; accountId?: string; side?: 'long' | 'short' }) => {
    const params = new URLSearchParams({ exchange: q.exchange, symbol: q.symbol });
    if (q.accountId) params.set('accountId', q.accountId);
    if (q.side) params.set('side', q.side);
    return getJson<{ candidates: AdoptCandidate[] }>(`/api/trade/adopt/candidates?${params.toString()}`);
  },
  adopt: (input: AdoptInput) => postJson<AdoptResult>('/api/trade/adopt', input),
};

export const botsApi = {
  list: () => getJson<{ bots: ExecutorBot[] }>('/api/bots'),
  // Take over: stop listening to the bot + retire its local trails → the
  // position reverts to manual on the edge. Closes nothing.
  takeOver: (botConfigId: string) => postJson<TakeOverResult>(`/api/bots/${botConfigId}/detach`),
};

// Typed client for the operational views over real broker data (/api/ops/*).
import { apiFetch } from './api';

export interface PortfolioExchange {
  exchange: string;
  status: string;
  equity: number;
  balance: number;
  unrealizedPnL: number;
  currency: string;
  accounts: number;
}

export interface PortfolioPosition {
  id: string;
  accountId: string;
  exchange: string;
  symbol: string;
  side: 'long' | 'short';
  size: number;
  entryPrice: number;
  markPrice?: number;
  unrealizedPnL?: number;
  leverage?: number;
}

export interface Portfolio {
  totalEquity: number;
  totalBalance: number;
  totalUnrealizedPnL: number;
  exchanges: PortfolioExchange[];
  allocation: Array<{ symbol: string; notional: number }>;
  positions: PortfolioPosition[];
}

export interface FuturesMarket {
  root: string;
  label: string;
  symbol: string | null;
  last: number | null;
  open: boolean;
  exchange: string;
}

/** Why a crypto market is being watched. */
export type CryptoMarketSource = 'subscription' | 'synthetic' | 'position';

export interface CryptoMarket {
  exchange: string;
  /** Connection label; null on the default connection. */
  accountKey: string | null;
  /** Human connection label ('deribit' or 'deribit · acct1'). */
  connection: string;
  symbol: string;
  sources: CryptoMarketSource[];
  position: { size: number; side: 'long' | 'short' | null } | null;
  last: number | null;
  change24hPct: number | null;
  /** Funding as a fraction (0.0001 = 1 bp), null when the venue reports none. */
  fundingRate: number | null;
  open: boolean;
}

export interface Markets {
  futures: FuturesMarket[];
  crypto: CryptoMarket[];
}

export interface AccountSizesRow {
  exchange: string;
  account: string;
  accountName: string;
  sizes: Array<{ root: string; label: string; maxContracts: number; isDefault: boolean }>;
}

export type FloorMode = 'maintenance' | 'initial' | 'equityPct';

export interface MarginGuardConfigDto {
  enabled: boolean;
  bufferMult: number;
  floorMode: FloorMode;
  equityPct: number;
}

export interface GuardrailsConfigDto {
  maxDailyLoss: number;
  maxConcurrentPositions: number;
  maxTotalNotional: number;
}

export interface HaltState {
  halted: boolean;
  reason: string | null;
  tripped_at: number | null;
}

export interface MarginGuardsResponse {
  defaults: MarginGuardConfigDto;
  guardrailDefaults: GuardrailsConfigDto;
  global: MarginGuardConfigDto | null;
  globalGuardrails: GuardrailsConfigDto;
  accounts: Array<{
    exchange: string;
    account: string;
    accountName: string;
    config: MarginGuardConfigDto;
    guardrails: GuardrailsConfigDto;
    isDefault: boolean;
  }>;
  halt: HaltState;
}

export interface PanicCloseResult {
  exchange: string;
  symbol: string;
  accountId: string;
  side: 'buy' | 'sell';
  size: number;
  ok: boolean;
  orderId?: string;
  error?: string;
}

export interface PanicReport {
  closed: number;
  failed: number;
  results: PanicCloseResult[];
  halted: boolean;
}

export interface ReconciliationRow {
  id: number;
  exchange: string;
  account_id: string;
  symbol: string;
  expected_net: number;
  broker_net: number;
  delta: number;
  action: string;
  side: string | null;
  qty: number | null;
  order_id: string | null;
  status: string | null;
  ts: number;
}

/** settled = drift resolved · open = still out of sync · archived = legacy row. */
export type FindingStatus = "settled" | "open" | "archived";

export type LatestFinding = ReconciliationRow & { finding: FindingStatus };

export interface Reconciliations {
  recent: ReconciliationRow[];
  latestPerSymbol: LatestFinding[];
  mismatched: LatestFinding[];
  /** Pre-account-scoping findings; they can never resolve, so they sit apart. */
  archived: LatestFinding[];
  reconciler: {
    lastTickAt: number | null;
    lastCleanPassAt: number | null;
    intervalMs: number;
  } | null;
}

export interface SignalRowDetail {
  id: string;
  strategy_id: string;
  strategy_name: string | null;
  symbol: string;
  action: string;
  quantity: number | null;
  price: number | null;
  type: string | null;
  stop_loss: number | null;
  take_profit: number | null;
  stop_loss_order_id: string | null;
  take_profit_order_id: string | null;
  metadata: string | null;
  received_at: string;
  processed_at: string | null;
  acked_at: string | null;
  ack_status: 'ok' | 'failed' | null;
  status: string;
  error_message: string | null;
}

export interface SubscriptionSummary {
  id: string;
  signalBotId: string;
  botName: string | null;
  factor: number;
  exchange: string;
  accountId: string | null;
  accountKey: string | null;
  status: string;
  sizeUnit: string;
  maxPositionSize: number | null;
  maxConcurrentTrades: number | null;
}

export interface SafetyClipRow {
  id: number;
  signal_id: string;
  subscription_id: string | null;
  reason: string;
  original_quantity: number | null;
  adjusted_quantity: number | null;
  created_at: string;
}

export interface SignalQueueRow {
  id: number;
  signal_id: string;
  action: string;
  received_at: string;
  processed_at: string | null;
  reason: string | null;
  metadata: string | null;
}

export interface ExecutionDetail {
  signal: SignalRowDetail | null;
  /** The subscription that routed this signal, when it is still configured. */
  subscription: SubscriptionSummary | null;
  /** Every quantity a guardrail changed, original to adjusted. */
  clips: SafetyClipRow[];
  /** Queue trail: arrival, processing and why it was parked. */
  queue: SignalQueueRow[];
  execution: {
    signal_id: string;
    symbol: string;
    exchange: string;
    account_id: string | null;
    direction: 'long' | 'short';
    status: string;
    qty_opened: number;
    qty_closed: number;
    error_reason: string | null;
    created_at: number;
    updated_at: number;
  } | null;
  fills: Array<{
    id: number;
    kind: 'entry' | 'exit';
    side: 'buy' | 'sell';
    qty: number;
    price: number | null;
    commission: number;
    order_id: string | null;
    created_at: number;
  }>;
  settlements: Array<{
    id: number;
    kind: 'entry' | 'exit';
    side: 'buy' | 'sell';
    qty: number;
    order_id: string;
    status: string;
    created_at: number;
    resolved_at: number | null;
  }>;
  bracket: { sl_order_id: string | null; tp_order_id: string | null } | null;
  pnl: {
    entryAvg: number | null;
    exitAvg: number | null;
    qtyOpened: number;
    qtyClosed: number;
    realizedPnl: number;
    realizedNet: number;
    commission: number;
    unrealizedPnl: number | null;
    multiplier: number;
  } | null;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await apiFetch(path);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

// Which lineage holds a live position (the book, not a symbol match): see
// node-backend services/position-lineage.ts.
export interface PositionLineage {
  exchange: string;
  accountId: string | null;
  symbol: string;
  source: 'bot' | 'manual';
  signalBotId: string | null;
  botName: string | null;
  botQty: number;
}

// Studio-in-Terminal hand-off: the backend trades its API key for a single-use
// verify URL; the key itself never reaches the browser.
export const studioApi = {
  embedToken: () => getJson<{ verifyUrl: string; expiresAt: string }>('/api/studio/embed-token'),
};

export const opsApi = {
  positionLineage: () => getJson<{ lineages: PositionLineage[] }>('/api/ops/position-lineage'),
  portfolio: () => getJson<Portfolio>('/api/ops/portfolio'),
  markets: () => getJson<Markets>('/api/ops/markets'),
  accountSizes: () => getJson<AccountSizesRow[]>('/api/ops/account-sizes'),
  reconciliations: (exchange?: string) =>
    getJson<Reconciliations>(
      `/api/ops/reconciliations${exchange ? `?exchange=${encodeURIComponent(exchange)}` : ''}`,
    ),
  execution: (signalId: string) =>
    getJson<ExecutionDetail>(`/api/ops/executions/${encodeURIComponent(signalId)}`),
  updateAccountSize: async (exchange: string, account: string, root: string, maxContracts: number) => {
    const res = await apiFetch('/api/ops/account-sizes', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exchange, account, root, maxContracts }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
  marginGuards: () => getJson<MarginGuardsResponse>('/api/ops/margin-guards'),
  updateMarginGuard: async (exchange: string, account: string, cfg: MarginGuardConfigDto) => {
    const res = await apiFetch('/api/ops/margin-guards', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exchange, account, ...cfg }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
  updateGuardrails: async (exchange: string, account: string, cfg: GuardrailsConfigDto) => {
    const res = await apiFetch('/api/ops/guardrails', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exchange, account, ...cfg }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
  panic: async (halt: boolean) => {
    const res = await apiFetch('/api/ops/panic', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ halt }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<PanicReport>;
  },
  haltState: () => getJson<HaltState>('/api/ops/halt'),
  setHalt: async (halted: boolean, reason?: string) => {
    const res = await apiFetch('/api/ops/halt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ halted, reason }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<HaltState>;
  },
  alertingStatus: () => getJson<{ active: boolean }>('/api/ops/alerting/status'),
  alertingTest: async () => {
    const res = await apiFetch('/api/ops/alerting/test', { method: 'POST' });
    return res.json() as Promise<{ ok: boolean; error?: string }>;
  },
};

// ── Remote management (companion control plane), opt-in, default OFF ──

export interface CompanionDevice {
  id: string;
  label: string | null;
  pairedAt: number;
  verified: boolean;
}

export interface CompanionStatus {
  enabled: boolean;
  enabledAt: number | null;
  devices: CompanionDevice[];
}

export const companionApi = {
  status: () => getJson<CompanionStatus>('/api/companion/status'),
  pairingCode: () => getJson<{ code: string | null }>('/api/companion/pairing-code'),
  enable: async () => {
    const res = await apiFetch('/api/companion/enable', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<{ enabled: boolean; pairingCode: string | null }>;
  },
  disable: async () => {
    const res = await apiFetch('/api/companion/disable', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<CompanionStatus>;
  },
  unpair: async (id: string) => {
    const res = await apiFetch('/api/companion/unpair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<CompanionStatus>;
  },
};

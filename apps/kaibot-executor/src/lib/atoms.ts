import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import type { PositionGroupInfo } from "./position-groups-api";
import type { LadderLevel } from "@kaibot/shared";

export {
  brandVariantAtom,
  effectiveBrandVariantAtom,
  userGroupsAtom,
  isClassicMemberAtom,
  type BrandVariant,
} from "@kaibot/shared";

// Sidebar state atoms
export const sidebarOpenAtom = atom(false);
export const sidebarCollapsedAtom = atomWithStorage(
  "kaibot-executor-sidebar-collapsed",
  false,
);

// User state atoms
export interface User {
  name: string;
  email: string;
}

// Initialize with null, will be populated from backend
export const userAtom = atom<User | null>(null);

// App state atoms
export const appVersionAtom = atom("0.0.1");

// Settings atoms
export const obfuscateSensitiveDataAtom = atomWithStorage(
  "kaibot-executor-obfuscate-sensitive",
  false,
);

// Skip the order confirmation dialog for manual trades.
export const skipOrderConfirmAtom = atomWithStorage(
  "kaibot-executor-skip-order-confirm",
  false,
);

// Timestamp display zone. Empty string = follow the browser, which is the
// default; anything else is an IANA zone name applied on every page.
export const displayTimeZoneAtom = atomWithStorage(
  "kaibot-executor-display-timezone",
  "",
);

// Positions page: flat table instead of the grouped sections.
export const positionsFlatViewAtom = atomWithStorage(
  "kaibot-executor-positions-flat-view",
  false,
);

// Bot state atoms
export type BotStatus = "active" | "paused" | "stopped";
export interface Bot {
  id: string;
  name: string;
  status: BotStatus;
  health: number; // 0-100
}

export const currentBotsAtom = atom<Bot[]>([
  { id: "1", name: "KaiBot Momentum", status: "active", health: 95 },
  { id: "2", name: "Recovery Bot", status: "active", health: 88 },
  { id: "3", name: "My Custom BTC Bot", status: "paused", health: 100 },
]);

// Exchange session atoms
export interface ExchangeSession {
  exchangeName: string;
  // Connection label ('default' for the unlabeled connection) and the account
  // key its positions/balances are namespaced with (null on default).
  label?: string;
  accountKey?: string | null;
  connectionId?: string;
  status: 'connected' | 'disconnected' | 'error';
  lastRefresh?: number;
  error?: string;
  prices?: Record<string, number>;
}

export const exchangeSessionsAtom = atom<ExchangeSession[]>([]);

// Balance atoms
export interface Balance {
  accountId: string;
  balance: number;
  equity: number;
  realizedPnL: number;
  unrealizedPnL: number;
  initialMargin?: number;
  maintenanceMargin?: number;
  currency: string;
  timestamp: number;
  /** USD value at the venue mark; null when the coin could not be priced. */
  usdEquity?: number | null;
  usdBalance?: number | null;
  /** The mark used (1 for dollar wallets), null when none was found. */
  usdRate?: number | null;
  /** Connection this wallet belongs to; null = the default connection. */
  accountKey?: string | null;
}

export const balancesAtom = atom<Map<string, Balance[]>>(new Map());

// Signal atoms
export interface Signal {
  id: string;
  symbol: string;
  action: string;
  price: number;
  strategy: string;
  timestamp: string;
  botName?: string;
  botTag?: string;
}

export const signalsAtom = atom<Signal[]>([]);

// ── Connection + activity surfacing ──────────────────────────────────────────

export type NotificationEventType =
  | 'signal_received'
  | 'order_filled'
  | 'order_rejected'
  | 'connection_lost'
  | 'connection_restored'
  | 'executor_conflict'
  | 'update_available'
  | 'update_required'
  | 'error';

export interface ActivityEvent {
  id: string;
  type: NotificationEventType;
  title: string;
  body: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

// Rolling log of backend notification events (newest first), capped in the
// reducer that writes it. Drives the Activity view's live event feed.
export const activityEventsAtom = atom<ActivityEvent[]>([]);

// When the Activity page last showed the feed; topbar bell counts events newer
// than this as unread.
export const activityLastSeenAtom = atomWithStorage<string>("activityLastSeen", "");

// Liveness of the backend notification socket itself (is the executor backend
// reachable from this UI at all).
export type BackendLink = 'connecting' | 'online' | 'offline';
export const backendLinkAtom = atom<BackendLink>('connecting');

// Signal-service (upstream API WS) connection, polled from /api/ws/status.
export interface SignalServiceStatus {
  connected: boolean;
  status: string; // connecting | connected | closing | disconnected | unknown
  downSince: string | null; // ISO timestamp of when it went down, if down
}
export const signalServiceStatusAtom = atom<SignalServiceStatus>({
  connected: false,
  status: 'disconnected',
  downSince: null,
});

// Timestamp (ISO) of the last signal_received event seen.
export const lastSignalAtAtom = atom<string | null>(null);

// Soft-update banner state. Set when the API reports a newer release is out
// (still above the hard floor). `required` flips it to the blocking variant
// when the executor was refused with a 426.
export interface UpdateInfo {
  latestVersion: string;
  current: string;
  required?: boolean;
}
export const updateInfoAtom = atom<UpdateInfo | null>(null);

// Dated-futures expiry info on a position (from the v2 positions endpoint).
// source 'calculated' = derived from the standard contract calendar;
// 'exchange-provided' = the venue publishes the expiry.
export interface PositionExpiryInfo {
  date: string; // ISO
  daysLeft: number;
  source: 'exchange-provided' | 'calculated';
  nextSymbol: string | null;
}

// Ladder level a bot-driven position currently rides (from the v2 positions
// endpoint; null/absent for anything that is not on a ladder strategy).
export interface PositionLadderInfo {
  timeframe: string;
  levels: LadderLevel[];
}

// Position atoms
export interface Position {
  id: string;
  accountId: string;
  symbol: string;
  side: 'long' | 'short';
  size: number;
  entryPrice: number;
  markPrice?: number;
  unrealizedPnL?: number;
  marginType?: string;
  leverage?: number;
  botName?: string;
  botTag?: string;
  /** Exchange the position was fetched from (tagged client-side by useBrokerData). */
  exchange?: string;
  /** Connection the position lives on (null = default connection). */
  accountKey?: string | null;
  /** Position group (from the v2 positions endpoint); null/absent = Unsorted. */
  group?: PositionGroupInfo | null;
  /** Dated-futures expiry; null/absent for perpetuals and spot. */
  expiry?: PositionExpiryInfo | null;
  /** Ladder level of the owning bot; null/absent for non-ladder positions. */
  ladder?: PositionLadderInfo | null;
  /** Server-side ride this position was handed to; null/absent = not riding. */
  ride?: { positionId: string; botId: string | null; botName: string | null } | null;
  /** Contract multiplier from the v2 positions endpoint (1 outside futures). */
  multiplier?: number;
  /** USD notional incl. the contract multiplier, from the v2 endpoint. */
  notional?: number;
}

export const positionsAtom = atom<Position[]>([]);

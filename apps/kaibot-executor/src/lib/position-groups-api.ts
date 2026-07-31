// Typed client for position groups on the local executor
// (/api/position-groups — G0/G1) plus the two G2 operator actions
// (close-group, tighten-stops: reduce/protect-only, live-only). Kept out of
// manual-trade-api.ts so the grouping surface evolves independently (same
// split as position-managers-api).
import { apiFetch } from './api';
import type { PositionExpiryInfo } from './atoms';

export type PositionGroupSource = 'bot' | 'takeover' | 'manual';

export interface PositionGroupInfo {
  id: string;
  name: string;
  source: PositionGroupSource;
}

export interface PositionGroupSummary extends PositionGroupInfo {
  botConfigId: string | null;
  signalBotId: string | null;
  linkedPositions: number;
  createdAt: number;
}

export interface GroupAggregates {
  positionCount: number;
  netUnrealizedPnl: number;
  // Sum of |size| × (mark ?? entry) — gross notional at risk.
  exposure: number;
  // Signed money from mark to the effective stop, summed over members that
  // HAVE one. Positive = at risk if all stops hit; negative = locked-in
  // profit. null when no member carries a stop.
  stopRisk: number | null;
  stoppedCount: number;
}

export interface GroupedPosition {
  exchange: string;
  accountId: string;
  symbol: string;
  side: 'long' | 'short';
  size: number;
  entryPrice: number;
  markPrice?: number;
  unrealizedPnL?: number;
  positionKey: string;
  group: PositionGroupInfo | null;
  effectiveStop: number | null;
  expiry: PositionExpiryInfo | null;
}

export interface GroupOverviewEntry {
  group: PositionGroupInfo | null; // null = Unsorted bucket (server sorts it last)
  aggregates: GroupAggregates;
  positions: GroupedPosition[];
}

export interface AssignPositionInput {
  exchange: string;
  accountId: string;
  symbol: string;
  groupId: string | null; // null = unassign (back to Unsorted)
}

export interface GroupCloseResultRow {
  positionKey: string;
  exchange: string;
  accountId: string;
  symbol: string;
  status: 'closed' | 'skipped' | 'failed';
  orderId?: string;
  reason?: string;
}

export interface GroupCloseReport {
  groupId: string;
  requested: number;
  closed: number;
  skipped: number;
  failed: number;
  results: GroupCloseResultRow[];
}

// Exactly one of level (absolute stop price) / pct (distance off the mark).
export type TightenStopsInput = { level: number } | { pct: number };

export interface GroupTightenResultRow {
  positionKey: string;
  exchange: string;
  accountId: string;
  symbol: string;
  status: 'tightened' | 'skipped' | 'failed';
  previousStop?: number | null;
  newStop?: number;
  reason?: string;
}

export interface GroupTightenReport {
  groupId: string;
  requested: number;
  tightened: number;
  skipped: number;
  failed: number;
  results: GroupTightenResultRow[];
}

async function getJson<T>(path: string): Promise<T> {
  const res = await apiFetch(path);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

async function sendJson<T>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const res = await apiFetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error || `HTTP ${res.status}`);
  return json as T;
}

export const positionGroupsApi = {
  list: () => getJson<{ groups: PositionGroupSummary[] }>('/api/position-groups'),
  create: (name: string) => sendJson<PositionGroupInfo>('POST', '/api/position-groups', { name }),
  rename: (id: string, name: string) =>
    sendJson<{ id: string; name: string }>('PATCH', `/api/position-groups/${encodeURIComponent(id)}`, { name }),
  // Members revert to Unsorted — deleting a group never touches positions.
  remove: (id: string) =>
    sendJson<{ success: boolean }>('DELETE', `/api/position-groups/${encodeURIComponent(id)}`),
  // A user assignment pins the link — auto rules never overwrite it.
  assign: (input: AssignPositionInput) =>
    sendJson<{ success: boolean }>('POST', '/api/position-groups/assign', input),
  overview: () => getJson<{ entries: GroupOverviewEntry[] }>('/api/position-groups/overview'),
  // Sequential reduce-only market closes; partial failures come back per
  // position, never as a thrown error.
  closeGroup: (id: string) =>
    sendJson<GroupCloseReport>('POST', `/api/position-groups/${encodeURIComponent(id)}/close`),
  // Improve-only: members whose current stop is already tighter (or with no
  // armed trail) are skipped and reported.
  tightenStops: (id: string, input: TightenStopsInput) =>
    sendJson<GroupTightenReport>(
      'POST',
      `/api/position-groups/${encodeURIComponent(id)}/tighten-stops`,
      input,
    ),
};

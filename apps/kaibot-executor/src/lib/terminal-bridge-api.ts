// Typed executor-side client the terminal bridge uses to read local state and
// route inbound terminal commands to the executor LOCAL api (Task A routes:
// /api/bots, /api/positions, /api/ops/*). Kept thin so it is the single place
// to adjust if a route shape changes.
import { apiFetch } from './api';
import type { RawBotConfig, RawExecutorPosition } from '@kaibot/terminal-bridge';

async function getJson<T>(path: string): Promise<T> {
  const res = await apiFetch(path);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

async function post(path: string, body?: unknown): Promise<void> {
  const res = await apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export interface DeployBotInput {
  signalBotId?: string;
  strategy: string;
  symbol: string;
  timeframe: string;
  executionTarget?: 'kaibot' | 'webhook';
  alertWebhookUrl?: string;
  alertPayloadTemplate?: string;
}

export const bridgeApi = {
  // READ — local state pushed to the iframe.
  positions: () => getJson<RawExecutorPosition[]>('/api/positions'),
  bots: () => getJson<RawBotConfig[]>('/api/bots'),
  halt: () => getJson<{ halted: boolean }>('/api/ops/halt'),

  // WRITE — inbound terminal commands → executor LOCAL api.
  startBot: (id: string) => post(`/api/bots/${encodeURIComponent(id)}/start`),
  stopBot: (id: string) => post(`/api/bots/${encodeURIComponent(id)}/stop`),
  deployBot: (bot: DeployBotInput) => post('/api/bots', bot),
  // Take-over / detach — "stop listening to a signal id" (refactor §4.6).
  detachBot: (id: string) => post(`/api/bots/${encodeURIComponent(id)}/detach`),
};

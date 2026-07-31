// Edge bot-config sync — identity/routing projection ONLY.
//
// Pulls the user's bots from the server (over the same tRPC the executor already
// authenticates to with its per-user API key) into the local bot_configs table.
// This is NOT the brain: the executor runs NO strategy/indicator code, so it
// never fetches strategy config, strategy type, or indicator source. It mirrors
// only WHAT bots exist, WHERE they trade, and HOW their alerts are routed
// (executionTarget). The decision logic lives on the server; the executor just
// shows these rows in its bot control plane and uses them for take-over/detach.
//
// One bot_configs row per (bot, supportedMarket), keyed by botConfigId.

import type { KaiBotDatabase } from '../storage/database.js';

interface SyncAuth {
  getApiUrl: () => string | null;
  getApiKey: () => string | null;
}

interface ServerMarket {
  exchange: string;
  symbol: string;
  timeframe: string;
}

interface ServerBot {
  id: string;
  name?: string;
  strategyId?: string | null;
  supportedMarkets?: ServerMarket[];
  metadata?: Record<string, unknown> | null;
  // Per-bot execution routing (where this bot's strategy alerts go). May arrive
  // as top-level columns or nested under metadata; resolveExecutionTarget reads
  // both. NB: when executionTarget==='webhook' the SERVER fires the webhook —
  // the executor never does; this is purely the projection the control plane shows.
  executionTarget?: string | null;
  alertWebhookUrl?: string | null;
  alertPayloadTemplate?: string | null;
}

interface ResolvedExecutionTarget {
  executionTarget: 'kaibot' | 'webhook';
  alertWebhookUrl: string | null;
  alertPayloadTemplate: string | null;
}

export function botConfigId(signalBotId: string, m: ServerMarket): string {
  return `${signalBotId}:${m.exchange}:${m.symbol}:${m.timeframe}`;
}

export class BotConfigSync {
  constructor(
    private db: KaiBotDatabase,
    private auth: SyncAuth,
  ) {}

  private buildHeaders(): Record<string, string> | null {
    const apiKey = this.auth.getApiKey();
    const sessionToken = process.env.EXECUTOR_SESSION_TOKEN;
    if (!apiKey && !sessionToken) return null;
    const headers: Record<string, string> = {};
    if (apiKey) headers['x-api-key'] = apiKey;
    if (sessionToken) headers['x-session-token'] = sessionToken;
    return headers;
  }

  private async trpcQuery<T>(proc: string, headers: Record<string, string>): Promise<T | null> {
    const apiUrl = this.auth.getApiUrl();
    if (!apiUrl) return null;
    try {
      const res = await fetch(`${apiUrl}/api/trpc/${proc}`, { method: 'GET', headers });
      if (!res.ok) return null;
      const body: any = await res.json();
      return (body?.result?.data?.json ?? body?.result?.data ?? null) as T | null;
    } catch {
      return null;
    }
  }

  // Resolve the per-bot execution target from the server bot. Reads top-level
  // fields first, then falls back to metadata. Only treats the bot as 'webhook'
  // when a non-empty URL is present. NB: the executor does NOT fire the webhook —
  // the server does. This is the routing projection the control plane displays.
  private resolveExecutionTarget(bot: ServerBot): ResolvedExecutionTarget {
    const meta = (bot.metadata ?? {}) as Record<string, unknown>;
    const pick = (top: unknown, key: string): unknown =>
      top != null ? top : meta[key];

    const rawTarget = pick(bot.executionTarget, 'executionTarget');
    const rawUrl = pick(bot.alertWebhookUrl, 'alertWebhookUrl');
    const rawTemplate = pick(bot.alertPayloadTemplate, 'alertPayloadTemplate');

    const url = typeof rawUrl === 'string' && rawUrl.trim().length > 0 ? rawUrl : null;
    const template =
      typeof rawTemplate === 'string' && rawTemplate.length > 0 ? rawTemplate : null;
    const wantsWebhook = rawTarget === 'webhook';

    return {
      executionTarget: wantsWebhook && url ? 'webhook' : 'kaibot',
      alertWebhookUrl: url,
      alertPayloadTemplate: template,
    };
  }

  // Fetch bots and project them into bot_configs (identity + routing only, NO
  // strategy/indicator code). Returns the number of (bot, market) configs synced,
  // or null when auth/server is unavailable (caller keeps whatever was last synced).
  async sync(): Promise<number | null> {
    const headers = this.buildHeaders();
    if (!headers) return null;

    const bots = await this.trpcQuery<ServerBot[]>('signalBots.myList', headers);
    if (!Array.isArray(bots)) return null;

    const seenConfigIds = new Set<string>();
    let synced = 0;

    for (const bot of bots) {
      if (!bot.strategyId) continue; // discretionary bots have no strategy to project
      const markets = Array.isArray(bot.supportedMarkets) ? bot.supportedMarkets : [];
      if (markets.length === 0) continue;

      const route = this.resolveExecutionTarget(bot);

      for (const m of markets) {
        if (!m?.exchange || !m?.symbol || !m?.timeframe) continue;
        const id = botConfigId(bot.id, m);
        seenConfigIds.add(id);
        // Preserve a locally-set status (stop/pause via the control plane or
        // take-over/detach) — a periodic re-sync must never silently restart a
        // bot the user stopped. New rows start 'running'.
        const existing = this.db.getBotConfig(id);
        this.db.upsertBotConfig({
          id,
          signalBotId: bot.id,
          botName: bot.name,
          strategyId: bot.strategyId,
          exchange: m.exchange,
          symbol: m.symbol,
          timeframe: m.timeframe,
          status: existing?.status ?? 'running',
          executionTarget: route.executionTarget,
          alertWebhookUrl: route.alertWebhookUrl,
          alertPayloadTemplate: route.alertPayloadTemplate,
        });
        synced += 1;
      }
    }

    // Drop projected configs whose bot/market no longer exists server-side.
    for (const existing of this.db.getBotConfigs(false)) {
      if (!seenConfigIds.has(existing.id)) {
        this.db.deleteBotConfig(existing.id);
      }
    }

    return synced;
  }
}

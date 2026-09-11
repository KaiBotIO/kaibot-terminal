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

// Ladder level of a running bot, as the server derives it from the run scratch
// (see @kaibot/shared parseLadderLevels). Display-only projection.
export interface LadderLevel {
  side: 'long' | 'short';
  level: number;
  tfLabel: string;
  entryBar: number;
  entryPrice: number;
  lastUpgradeBar: number | null;
}

// What the positions route hands the UI for one position.
export interface LadderSnapshot {
  /** Root timeframe the bot runs on. */
  timeframe: string;
  levels: LadderLevel[];
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
  // Per-market ladder levels, keyed `exchange|symbol|timeframe`. Absent for
  // bots that carry no ladder state.
  ladderByMarket?: Record<string, LadderLevel[]> | null;
}

interface ResolvedExecutionTarget {
  executionTarget: 'kaibot' | 'webhook';
  alertWebhookUrl: string | null;
  alertPayloadTemplate: string | null;
}

export function botConfigId(signalBotId: string, m: ServerMarket): string {
  return `${signalBotId}:${m.exchange}:${m.symbol}:${m.timeframe}`;
}

// A ladder is looked up per (bot, symbol): the run's exchange can be the
// composite feed ('index') while the position sits on a real venue, so the
// venue is deliberately not part of the key.
export function ladderKey(signalBotId: string, symbol: string): string {
  return `${signalBotId}|${symbol.toUpperCase()}`;
}

// Dated tradfi contract (MGCZ26 → MGC); same shape as contract-expiry's parser.
const TRADFI_CONTRACT_RE = /^([A-Z]+)[FGHJKMNQUVXZ]\d{2}$/;

// A bot runs on the root symbol (MGC, BTC) while the position carries the
// venue's instrument (MGCZ26, BTC-PERPETUAL). Try the instrument first, then
// the roots it could have come from.
export function ladderSymbolCandidates(symbol: string): string[] {
  const s = symbol.toUpperCase();
  const out = [s];
  const dated = TRADFI_CONTRACT_RE.exec(s);
  if (dated?.[1]) out.push(dated[1]);
  const base = s.split(/[-_]/)[0];
  if (base && base !== s) out.push(base);
  return [...new Set(out)];
}

// Read the ladder levels the server sent for a bot into the lookup map. Only
// markets that actually carry a level end up in it.
export function collectLadders(bot: ServerBot): Map<string, LadderSnapshot> {
  const out = new Map<string, LadderSnapshot>();
  const byMarket = bot.ladderByMarket;
  if (!byMarket || typeof byMarket !== 'object') return out;
  for (const [key, levels] of Object.entries(byMarket)) {
    if (!Array.isArray(levels) || levels.length === 0) continue;
    const [, symbol, timeframe] = key.split('|');
    if (!symbol || !timeframe) continue;
    out.set(ladderKey(bot.id, symbol), { timeframe, levels });
  }
  return out;
}

// Ladder badge for one position: the ladder of the bot that owns its group,
// narrowed to the position's own side. Display only.
export function ladderForPosition(
  lookup: ((signalBotId: string, symbol: string) => LadderSnapshot | null) | undefined,
  signalBotId: string | null | undefined,
  p: { symbol: string; side: 'long' | 'short' },
): LadderSnapshot | null {
  if (!lookup || !signalBotId) return null;
  for (const candidate of ladderSymbolCandidates(p.symbol)) {
    const snap = lookup(signalBotId, candidate);
    if (!snap) continue;
    const levels = snap.levels.filter((l) => l.side === p.side);
    if (levels.length > 0) return { timeframe: snap.timeframe, levels };
  }
  return null;
}

export class BotConfigSync {
  // Ladder levels from the last successful sync. Kept in memory on purpose:
  // bot_configs is the identity/routing projection, and a level that moves with
  // every upgrade has no business being persisted there.
  private ladders = new Map<string, LadderSnapshot>();

  constructor(
    private db: KaiBotDatabase,
    private auth: SyncAuth,
  ) {}

  /** Ladder a bot's position on `symbol` currently rides, if any. */
  getLadder(signalBotId: string, symbol: string): LadderSnapshot | null {
    return this.ladders.get(ladderKey(signalBotId, symbol)) ?? null;
  }

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
    const ladders = new Map<string, LadderSnapshot>();
    let synced = 0;

    for (const bot of bots) {
      for (const [key, snap] of collectLadders(bot)) ladders.set(key, snap);
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

    this.ladders = ladders;

    return synced;
  }
}

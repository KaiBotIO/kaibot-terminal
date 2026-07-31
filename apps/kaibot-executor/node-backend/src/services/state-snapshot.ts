// Executor state assembly — the single source of truth for the portfolio,
// account-size and guardrail/margin-guard projections.
//
// These blocks were inline in routes/operations.ts; they are EXTRACTED here so
// the HTTP routes AND the remote-companion state snapshot share one impl (no
// drift). Every exchange read is fail-soft: a venue erroring degrades to a
// partial snapshot, never throws. NO key/secret/model field is ever read or
// emitted — the snapshot carries only risk/config/lifecycle state.

import type { KaiBotDatabase } from '../storage/database.js';
import type { ExchangeManager } from './exchanges/exchangeManager.js';
import type { Balance, Position } from './exchanges/types.js';
import {
  DEFAULT_ACCOUNT_SIZES,
  sizingRoot,
} from './account-sizing.js';
import {
  DEFAULT_MARGIN_GUARD,
  effectiveMarginGuard,
  effectiveGuardrails,
  type MarginGuardConfig,
} from './margin-guard.js';
import { DEFAULT_GUARDRAILS, type GuardrailsConfig } from './guardrails.js';
import { KNOWN_FUTURES_ROOTS } from './exchanges/futures-contracts.js';
import { toBotDto, type BotDto } from '../routes/bots.js';
import { positionNotional } from './position-trail.js';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Display labels for the futures roots the executor can size/trade. (Kept here
// so the account-size assembly is self-contained.)
const ROOT_LABELS: Record<string, string> = {
  MNQ: 'Micro Nasdaq',
  MES: 'Micro S&P 500',
  MGC: 'Micro Gold',
  SIL: 'Micro Silver',
  NQ: 'Nasdaq',
  ES: 'S&P 500',
  GC: 'Gold',
};

// ── Portfolio ───────────────────────────────────────────────────────────────

export interface PortfolioExchangeRow {
  exchange: string;
  status: string;
  equity: number;
  balance: number;
  unrealizedPnL: number;
  currency: string;
  accounts: number;
}

export interface Portfolio {
  totalEquity: number;
  totalBalance: number;
  totalUnrealizedPnL: number;
  exchanges: PortfolioExchangeRow[];
  allocation: Array<{ symbol: string; notional: number }>;
  positions: Array<Position & { exchange: string }>;
}

export async function assemblePortfolio(
  db: KaiBotDatabase,
  exchangeManager: ExchangeManager,
): Promise<Portfolio> {
  const sessions = await exchangeManager.getAllSessions('default');
  const byExchange: PortfolioExchangeRow[] = [];
  const positions: Array<Position & { exchange: string }> = [];

  for (const session of sessions) {
    if (session.status !== 'connected') {
      byExchange.push({
        exchange: session.exchangeName,
        status: session.status,
        equity: 0,
        balance: 0,
        unrealizedPnL: 0,
        currency: 'USD',
        accounts: 0,
      });
      continue;
    }
    let balances: Balance[] = [];
    let livePositions: Position[] = [];
    try {
      balances = await session.adapter.getBalances();
    } catch (err) {
      db.log('warn', 'trading', 'Portfolio: getBalances failed', {
        exchange: session.exchangeName,
        error: errMsg(err),
      });
    }
    try {
      livePositions = await session.adapter.getPositions();
    } catch (err) {
      db.log('warn', 'trading', 'Portfolio: getPositions failed', {
        exchange: session.exchangeName,
        error: errMsg(err),
      });
    }

    const equity = balances.reduce((s, b) => s + (b.equity || 0), 0);
    const balance = balances.reduce((s, b) => s + (b.balance || 0), 0);
    const unrealizedPnL = balances.reduce((s, b) => s + (b.unrealizedPnL || 0), 0);
    byExchange.push({
      exchange: session.exchangeName,
      status: session.status,
      equity,
      balance,
      unrealizedPnL,
      currency: balances[0]?.currency ?? 'USD',
      accounts: balances.length,
    });
    for (const p of livePositions) {
      if (Math.abs(p.size) > 0) positions.push({ ...p, exchange: session.exchangeName });
    }
  }

  const totalEquity = byExchange.reduce((s, e) => s + e.equity, 0);
  const totalBalance = byExchange.reduce((s, e) => s + e.balance, 0);
  const totalUnrealized = byExchange.reduce((s, e) => s + e.unrealizedPnL, 0);

  // Notional allocation per symbol (abs size × mark/entry price).
  const allocMap = new Map<string, number>();
  for (const p of positions) {
    const notional = positionNotional(p);
    if (notional > 0) allocMap.set(p.symbol, (allocMap.get(p.symbol) ?? 0) + notional);
  }
  const allocation = Array.from(allocMap.entries())
    .map(([symbol, notional]) => ({ symbol, notional }))
    .sort((a, b) => b.notional - a.notional);

  return {
    totalEquity,
    totalBalance,
    totalUnrealizedPnL: totalUnrealized,
    exchanges: byExchange,
    allocation,
    positions,
  };
}

// ── Account sizes ─────────────────────────────────────────────────────────────

export interface AccountSizesRow {
  exchange: string;
  account: string;
  accountName: string;
  sizes: Array<{ root: string; label: string; maxContracts: number; isDefault: boolean }>;
}

export async function assembleAccountSizes(
  db: KaiBotDatabase,
  exchangeManager: ExchangeManager,
): Promise<AccountSizesRow[]> {
  const sessions = await exchangeManager.getAllSessions('default');
  const configured = db.listAccountSizes();
  const out: AccountSizesRow[] = [];

  for (const session of sessions) {
    if (session.status !== 'connected') continue;
    const adapter = session.adapter;
    // Roots offered per venue: futures roots for futures venues, the live
    // position symbols for crypto venues (so each tradeable market is sized).
    let roots: string[] = [];
    if (adapter.resolveSymbol && adapter.getMarketStatus) {
      roots = ['MNQ', 'MES', 'MGC', 'SIL'];
    } else {
      try {
        const positions = await adapter.getPositions();
        roots = [...new Set(positions.map((p) => sizingRoot(p.symbol)))];
      } catch {
        roots = [];
      }
    }

    let accounts: Array<{ accountId: string; name: string }> = [];
    try {
      const accs = await adapter.getAccounts();
      accounts = accs.map((a) => ({ accountId: a.accountId, name: a.name }));
    } catch {
      accounts = [{ accountId: 'default', name: 'default' }];
    }
    if (accounts.length === 0) accounts = [{ accountId: 'default', name: 'default' }];

    for (const acc of accounts) {
      out.push({
        exchange: session.exchangeName,
        account: acc.accountId,
        accountName: acc.name,
        sizes: roots.map((root) => {
          const row = configured.find(
            (s) => s.exchange === session.exchangeName && s.account === acc.accountId && s.root === root,
          );
          const max = row ? row.max_contracts : DEFAULT_ACCOUNT_SIZES[root] ?? 0;
          return {
            root,
            label: ROOT_LABELS[root] ?? root,
            maxContracts: max,
            isDefault: !row,
          };
        }),
      });
    }
  }
  return out;
}

// ── Margin guards + opt-in guardrails (shared row) ───────────────────────────

const guardrailsOf = (row: ReturnType<KaiBotDatabase['getMarginGuard']>): GuardrailsConfig => ({
  maxDailyLoss: row && row.max_daily_loss > 0 ? row.max_daily_loss : 0,
  maxConcurrentPositions: row && row.max_concurrent_positions > 0 ? row.max_concurrent_positions : 0,
  maxTotalNotional: row && row.max_total_notional > 0 ? row.max_total_notional : 0,
});

export interface MarginGuardsView {
  defaults: typeof DEFAULT_MARGIN_GUARD;
  guardrailDefaults: typeof DEFAULT_GUARDRAILS;
  global: {
    enabled: boolean;
    bufferMult: number;
    floorMode: string;
    equityPct: number;
  } | null;
  globalGuardrails: GuardrailsConfig;
  accounts: Array<{
    exchange: string;
    account: string;
    accountName: string;
    config: MarginGuardConfig;
    guardrails: GuardrailsConfig;
    isDefault: boolean;
  }>;
  halt: ReturnType<KaiBotDatabase['getHaltState']>;
}

export async function assembleMarginGuards(
  db: KaiBotDatabase,
  exchangeManager: ExchangeManager,
): Promise<MarginGuardsView> {
  const sessions = await exchangeManager.getAllSessions('default');
  const globalRow = db.getMarginGuard('*', '*');
  const accounts: MarginGuardsView['accounts'] = [];

  for (const session of sessions) {
    if (session.status !== 'connected') continue;
    let accs: Array<{ accountId: string; name: string }> = [];
    try {
      const list = await session.adapter.getAccounts();
      accs = list.map((a) => ({ accountId: a.accountId, name: a.name }));
    } catch {
      accs = [{ accountId: 'default', name: 'default' }];
    }
    if (accs.length === 0) accs = [{ accountId: 'default', name: 'default' }];

    for (const acc of accs) {
      accounts.push({
        exchange: session.exchangeName,
        account: acc.accountId,
        accountName: acc.name,
        config: effectiveMarginGuard(db, session.exchangeName, acc.accountId),
        guardrails: effectiveGuardrails(db, session.exchangeName, acc.accountId),
        isDefault: !db.getMarginGuard(session.exchangeName, acc.accountId),
      });
    }
  }

  return {
    defaults: DEFAULT_MARGIN_GUARD,
    guardrailDefaults: DEFAULT_GUARDRAILS,
    global: globalRow
      ? {
          enabled: !!globalRow.enabled,
          bufferMult: globalRow.buffer_mult,
          floorMode: globalRow.floor_mode,
          equityPct: globalRow.equity_pct,
        }
      : null,
    globalGuardrails: guardrailsOf(globalRow),
    accounts,
    halt: db.getHaltState(),
  };
}

// keep KNOWN_FUTURES_ROOTS imported as a doc anchor for futures sizing scope.
void KNOWN_FUTURES_ROOTS;

// ── Composed executor state snapshot (the companion `blob` body) ─────────────

export interface ExecutorStateSnapshot {
  halt: ReturnType<KaiBotDatabase['getHaltState']>;
  portfolio: Portfolio;
  guardrails: MarginGuardsView;
  accountSizes: AccountSizesRow[];
  bots: BotDto[];
  subscriptions: SubscriptionDto[];
}

// Subscription projection for the snapshot — risk/lifecycle fields only, no keys.
export interface SubscriptionDto {
  id: string;
  signalBotId: string;
  botName: string | null;
  selectedMarkets: string[];
  factor: number;
  maxPositionSize: number | null;
  maxConcurrentTrades: number | null;
  exchange: string | null;
  accountId: string | null;
  status: string;
}

function toSubscriptionDto(r: Record<string, unknown>): SubscriptionDto {
  let selectedMarkets: string[] = [];
  try {
    selectedMarkets = r.selected_markets ? (JSON.parse(String(r.selected_markets)) as string[]) : [];
  } catch {
    selectedMarkets = [];
  }
  return {
    id: String(r.id),
    signalBotId: String(r.signal_bot_id ?? ''),
    botName: (r.bot_name as string | null) ?? null,
    selectedMarkets,
    factor: Number(r.factor ?? 1),
    maxPositionSize: (r.max_position_size as number | null) ?? null,
    maxConcurrentTrades: (r.max_concurrent_trades as number | null) ?? null,
    exchange: (r.exchange as string | null) ?? null,
    accountId: (r.account_id as string | null) ?? null,
    status: String(r.status ?? 'active'),
  };
}

/**
 * Assemble the full executor state the companion app monitors. Reuses the
 * extracted portfolio/account-size/guardrail assembly + toBotDto + the
 * subscription/halt reads. Exchange reads fail-soft (partial snapshot, never
 * throws). EXCLUDES every key/secret/model field — toBotDto and toSubscriptionDto
 * are identity/routing projections that never carry strategy/indicator code.
 */
export async function assembleExecutorState(
  db: KaiBotDatabase,
  exchangeManager: ExchangeManager,
): Promise<ExecutorStateSnapshot> {
  const [portfolio, accountSizes, guardrails] = await Promise.all([
    assemblePortfolio(db, exchangeManager).catch((err) => {
      db.log('warn', 'system', 'Snapshot: portfolio assembly failed', { error: errMsg(err) });
      return {
        totalEquity: 0,
        totalBalance: 0,
        totalUnrealizedPnL: 0,
        exchanges: [],
        allocation: [],
        positions: [],
      } as Portfolio;
    }),
    assembleAccountSizes(db, exchangeManager).catch((err) => {
      db.log('warn', 'system', 'Snapshot: account-size assembly failed', { error: errMsg(err) });
      return [] as AccountSizesRow[];
    }),
    assembleMarginGuards(db, exchangeManager).catch((err) => {
      db.log('warn', 'system', 'Snapshot: guardrail assembly failed', { error: errMsg(err) });
      return {
        defaults: DEFAULT_MARGIN_GUARD,
        guardrailDefaults: DEFAULT_GUARDRAILS,
        global: null,
        globalGuardrails: { maxDailyLoss: 0, maxConcurrentPositions: 0, maxTotalNotional: 0 },
        accounts: [],
        halt: db.getHaltState(),
      } as MarginGuardsView;
    }),
  ]);

  let bots: BotDto[] = [];
  try {
    bots = db.getBotConfigs(false).map(toBotDto);
  } catch (err) {
    db.log('warn', 'system', 'Snapshot: bot assembly failed', { error: errMsg(err) });
  }

  let subscriptions: SubscriptionDto[] = [];
  try {
    subscriptions = (db.getSubscriptions(false) as Array<Record<string, unknown>>).map(toSubscriptionDto);
  } catch (err) {
    db.log('warn', 'system', 'Snapshot: subscription assembly failed', { error: errMsg(err) });
  }

  return {
    halt: db.getHaltState(),
    portfolio,
    guardrails,
    accountSizes,
    bots,
    subscriptions,
  };
}

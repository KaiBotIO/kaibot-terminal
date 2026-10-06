/**
 * Pure adapters: executor LOCAL api row shapes → bridge payload types.
 *
 * The executor's routes return exchange-native / db-native shapes. These pure
 * functions normalise them into the {@link BridgePosition}/{@link BridgeBot}
 * payloads the terminal consumes, so the executor host can post snapshots
 * without inline mapping logic. Unit-tested against fixtures.
 */

import type {
  BridgeBot,
  BridgeBotStatus,
  BridgeFill,
  BridgePosition,
  PositionSide,
} from './protocol.js';

/** Shape of a row from GET /api/positions (executor exchange-adapter Position). */
export interface RawExecutorPosition {
  id?: string;
  accountId?: string;
  exchange_name?: string;
  symbol: string;
  side: PositionSide;
  size: number;
  entryPrice?: number;
  markPrice?: number;
  unrealizedPnL?: number;
  stopLoss?: number;
  takeProfit?: number;
  signalId?: string;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function toBridgePosition(p: RawExecutorPosition): BridgePosition {
  const exchange = p.exchange_name ?? '';
  return {
    id: p.id ?? `${exchange}:${p.symbol}:${p.side}`,
    exchange,
    symbol: p.symbol,
    side: p.side,
    size: num(p.size) ?? 0,
    entryPrice: num(p.entryPrice),
    markPrice: num(p.markPrice),
    unrealizedPnl: num(p.unrealizedPnL),
    stopLoss: num(p.stopLoss),
    takeProfit: num(p.takeProfit),
    signalId: p.signalId ?? null,
  };
}

/** Map + drop flat positions (size 0) in one pass. */
export function toBridgePositions(rows: RawExecutorPosition[] | undefined): BridgePosition[] {
  if (!rows) return [];
  const out: BridgePosition[] = [];
  for (const r of rows) {
    const bp = toBridgePosition(r);
    if (Math.abs(bp.size) > 0) out.push(bp);
  }
  return out;
}

/** Shape of a bot_configs row as projected by the executor bots route DTO. */
export interface RawBotConfig {
  id: string;
  signalBotId?: string | null;
  strategy?: string | null;
  symbol?: string | null;
  timeframe?: string | null;
  status?: string | null;
  executionTarget?: string | null;
}

function normaliseBotStatus(s: string | null | undefined): BridgeBotStatus {
  if (s === 'running' || s === 'paused' || s === 'stopped') return s;
  return 'stopped';
}

export function toBridgeBot(row: RawBotConfig): BridgeBot {
  const target =
    row.executionTarget === 'kaibot' || row.executionTarget === 'webhook'
      ? row.executionTarget
      : null;
  return {
    id: row.id,
    signalBotId: row.signalBotId ?? null,
    strategy: row.strategy ?? null,
    symbol: row.symbol ?? null,
    timeframe: row.timeframe ?? null,
    status: normaliseBotStatus(row.status),
    executionTarget: target,
  };
}

export function toBridgeBots(rows: RawBotConfig[] | undefined): BridgeBot[] {
  return (rows ?? []).map(toBridgeBot);
}

/** Shape of a row from GET /api/ops/fills (signal_fills joined to its execution). */
export interface RawExecutorFill {
  id: number | string;
  signalId: string;
  exchange: string;
  accountId?: string | null;
  symbol: string;
  /** Position side of the execution the fill belongs to. */
  direction: PositionSide;
  kind: 'entry' | 'exit';
  qty: number;
  price: number | null;
  commission?: number | null;
  /** epoch ms */
  createdAt: number;
}

/** A fill without a price cannot be anchored on a chart; returns null for those. */
export function toBridgeFill(f: RawExecutorFill): BridgeFill | null {
  const price = num(f.price);
  const size = num(f.qty);
  const timestamp = num(f.createdAt);
  if (price === null || price <= 0 || size === null || size <= 0 || timestamp === null) return null;
  if (f.kind !== 'entry' && f.kind !== 'exit') return null;
  if (f.direction !== 'long' && f.direction !== 'short') return null;
  return {
    id: String(f.id),
    signalId: f.signalId,
    exchange: f.exchange,
    symbol: f.symbol,
    side: f.direction,
    kind: f.kind,
    price,
    size,
    timestamp,
    commission: num(f.commission),
    accountId: f.accountId ?? null,
  };
}

export function toBridgeFills(rows: RawExecutorFill[] | undefined): BridgeFill[] {
  const out: BridgeFill[] = [];
  for (const r of rows ?? []) {
    const bf = toBridgeFill(r);
    if (bf) out.push(bf);
  }
  return out;
}

import { describe, expect, it } from 'bun:test';
import {
  toBridgeBot,
  toBridgeBots,
  toBridgeFill,
  toBridgeFills,
  toBridgePosition,
  toBridgePositions,
} from '../adapters.js';

describe('toBridgePosition', () => {
  it('maps an exchange-native position row', () => {
    const bp = toBridgePosition({
      id: 'pos-1',
      exchange_name: 'bybit',
      symbol: 'BTCUSDT',
      side: 'long',
      size: 0.5,
      entryPrice: 60000,
      markPrice: 61000,
      unrealizedPnL: 500,
      stopLoss: 58000,
      takeProfit: 65000,
      signalId: 'sig-9',
    });
    expect(bp).toEqual({
      id: 'pos-1',
      exchange: 'bybit',
      symbol: 'BTCUSDT',
      side: 'long',
      size: 0.5,
      entryPrice: 60000,
      markPrice: 61000,
      unrealizedPnl: 500,
      stopLoss: 58000,
      takeProfit: 65000,
      signalId: 'sig-9',
    });
  });

  it('synthesises an id when missing and coerces string numerics', () => {
    const bp = toBridgePosition({
      exchange_name: 'binance',
      symbol: 'ETHUSDT',
      side: 'short',
      // @ts-expect-error exchange sometimes hands back stringy numbers
      size: '2',
      // @ts-expect-error
      entryPrice: '3000',
    });
    expect(bp.id).toBe('binance:ETHUSDT:short');
    expect(bp.size).toBe(2);
    expect(bp.entryPrice).toBe(3000);
    expect(bp.signalId).toBeNull();
  });

  it('entryPrice is null when unparseable (pending fill)', () => {
    const bp = toBridgePosition({ exchange_name: 'x', symbol: 'S', side: 'long', size: 1 });
    expect(bp.entryPrice).toBeNull();
  });
});

describe('toBridgePositions', () => {
  it('drops flat (size 0) rows', () => {
    const out = toBridgePositions([
      { exchange_name: 'a', symbol: 'A', side: 'long', size: 0 },
      { exchange_name: 'a', symbol: 'B', side: 'short', size: -1, entryPrice: 10 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.symbol).toBe('B');
  });
  it('undefined → empty', () => {
    expect(toBridgePositions(undefined)).toEqual([]);
  });
});

describe('toBridgeBot', () => {
  it('normalises status and execution target', () => {
    expect(toBridgeBot({ id: 'b1', status: 'running', executionTarget: 'kaibot' }).status).toBe('running');
    expect(toBridgeBot({ id: 'b2', status: 'weird' }).status).toBe('stopped');
    expect(toBridgeBot({ id: 'b3', executionTarget: 'bogus' }).executionTarget).toBeNull();
    expect(toBridgeBot({ id: 'b4', executionTarget: 'webhook' }).executionTarget).toBe('webhook');
  });
  it('toBridgeBots maps a list', () => {
    expect(toBridgeBots([{ id: 'a', status: 'paused' }])).toEqual([
      { id: 'a', signalBotId: null, strategy: null, symbol: null, timeframe: null, status: 'paused', executionTarget: null },
    ]);
  });
});

describe('toBridgeFill', () => {
  const row = {
    id: 7,
    signalId: 'sig-1',
    exchange: 'deribit',
    accountId: 'main',
    symbol: 'BTC-PERPETUAL',
    direction: 'long' as const,
    kind: 'entry' as const,
    qty: 0.5,
    price: 60000,
    commission: 1.2,
    createdAt: 1_700_000_000_000,
  };

  it('maps a fills-route row, keeping the position side and the fill kind', () => {
    expect(toBridgeFill(row)).toEqual({
      id: '7',
      signalId: 'sig-1',
      exchange: 'deribit',
      symbol: 'BTC-PERPETUAL',
      side: 'long',
      kind: 'entry',
      price: 60000,
      size: 0.5,
      timestamp: 1_700_000_000_000,
      commission: 1.2,
      accountId: 'main',
    });
  });

  it('drops fills that cannot be anchored (no price, zero size, bad kind)', () => {
    expect(toBridgeFill({ ...row, price: null })).toBeNull();
    expect(toBridgeFill({ ...row, qty: 0 })).toBeNull();
    expect(toBridgeFill({ ...row, kind: 'oops' as 'entry' })).toBeNull();
    expect(toBridgeFills([row, { ...row, id: 8, price: null }])).toHaveLength(1);
    expect(toBridgeFills(undefined)).toEqual([]);
  });

  it('coerces string numerics from sqlite', () => {
    const bf = toBridgeFill({ ...row, price: '61000' as unknown as number, qty: '2' as unknown as number });
    expect(bf?.price).toBe(61000);
    expect(bf?.size).toBe(2);
  });
});

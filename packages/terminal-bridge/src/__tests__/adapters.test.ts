import { describe, expect, it } from 'bun:test';
import {
  toBridgeBot,
  toBridgeBots,
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

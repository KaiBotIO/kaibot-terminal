import { describe, expect, it } from 'bun:test';
import {
  pnlCurrencyOf,
  positionNotionalUsd,
  positionPnlPercent,
  positionPnlSinceEntryUsd,
  positionPnlUsd,
} from '../futures-multipliers';

// Regression (portfolio review 27/09): the Portfolio page valued 981 USD of
// ETH-PERPETUAL contracts at 981 x the ETH price ($2,66M) and summed Deribit's
// coin-denominated P&L into the dollar total.
describe('positionNotionalUsd per contract kind', () => {
  it('deribit inverse: the contract count is the USD notional', () => {
    expect(positionNotionalUsd({ exchange: 'deribit', symbol: 'ETH-PERPETUAL', size: 981, price: 2714 })).toBe(981);
    expect(positionNotionalUsd({ exchange: 'deribit', symbol: 'BTC-PERPETUAL', size: -2000, price: 84_000 })).toBe(2000);
    // No price needed: inverse contracts are dollars by definition.
    expect(positionNotionalUsd({ exchange: 'deribit', symbol: 'BTC-27MAR26', size: 500 })).toBe(500);
  });

  it('deribit USDC linear: coin qty x price', () => {
    expect(positionNotionalUsd({ exchange: 'deribit', symbol: 'SOL_USDC-PERPETUAL', size: 10, price: 150 })).toBe(1500);
    expect(positionNotionalUsd({ exchange: 'deribit', symbol: 'SOL_USDC-PERPETUAL', size: 10 })).toBe(0);
  });

  it('tradestation futures: qty x price x multiplier', () => {
    expect(positionNotionalUsd({ exchange: 'tradestation', symbol: 'MESZ26', size: 1, price: 7800 })).toBe(39_000);
    expect(positionNotionalUsd({ exchange: 'tradestation', symbol: 'MNQZ26', size: 1, price: 30_900 })).toBe(61_800);
    expect(positionNotionalUsd({ exchange: 'tradestation', symbol: 'MGCZ26', size: 1, price: 4500 })).toBe(45_000);
  });

  it('bybit: linear qty x price, inverse contracts are USD', () => {
    expect(positionNotionalUsd({ exchange: 'bybit', symbol: 'BTCUSDT', size: 0.5, price: 84_000 })).toBe(42_000);
    expect(positionNotionalUsd({ exchange: 'bybit', symbol: 'BTCUSD', size: 42_000, price: 84_000 })).toBe(42_000);
  });
});

describe('positionPnlUsd', () => {
  it('values inverse coin P&L at the mark', () => {
    expect(positionPnlUsd({ exchange: 'deribit', symbol: 'ETH-PERPETUAL', unrealizedPnL: -0.000735, markPrice: 2714 })).toBeCloseTo(-1.995, 3);
    expect(positionPnlUsd({ exchange: 'deribit', symbol: 'ETH-PERPETUAL', unrealizedPnL: 0.01 })).toBeNull();
    expect(positionPnlUsd({ exchange: 'deribit', symbol: 'ETH-PERPETUAL', unrealizedPnL: 0 })).toBe(0);
  });

  it('passes dollar P&L through', () => {
    expect(positionPnlUsd({ exchange: 'tradestation', symbol: 'MESZ26', unrealizedPnL: 163.75 })).toBe(163.75);
    expect(positionPnlUsd({ exchange: 'deribit', symbol: 'SOL_USDC-PERPETUAL', unrealizedPnL: -3.2, markPrice: 150 })).toBe(-3.2);
    expect(positionPnlUsd({ exchange: 'bybit', symbol: 'BTCUSDT', unrealizedPnL: 12 })).toBe(12);
  });

  it('names the P&L currency', () => {
    expect(pnlCurrencyOf('deribit', 'ETH-PERPETUAL')).toBe('ETH');
    expect(pnlCurrencyOf('deribit', 'BTC-27MAR26')).toBe('BTC');
    expect(pnlCurrencyOf('bybit', 'BTCUSD')).toBe('BTC');
    expect(pnlCurrencyOf('deribit', 'SOL_USDC-PERPETUAL')).toBe('USD');
    expect(pnlCurrencyOf('tradestation', 'MESZ26')).toBe('USD');
  });
});

// Regression (positions review 05/10): ETH-PERPETUAL 981 @ 2629.65, mark 2712.41
// showed -$4.99 (Deribit floating P&L since the 08:00 settlement) beside +3.15 %
// since entry. Since entry it is +0.0114 ETH, about +$30.87.
describe('positionPnlSinceEntryUsd per venue', () => {
  it('deribit inverse: coin P&L since entry valued at the mark', () => {
    const p = { exchange: 'deribit', symbol: 'ETH-PERPETUAL', side: 'long' as const, size: 981, entryPrice: 2629.65, markPrice: 2712.41, unrealizedPnL: -0.00184 };
    const usd = positionPnlSinceEntryUsd(p)!;
    expect(usd).toBeCloseTo(30.87, 2);
    expect(usd).toBeCloseTo(981 * (1 / 2629.65 - 1 / 2712.41) * 2712.41, 9);
    expect(Math.sign(usd)).toBe(Math.sign(positionPnlPercent(p)!));
  });

  it('deribit inverse short: sign follows the side', () => {
    const usd = positionPnlSinceEntryUsd({ exchange: 'deribit', symbol: 'BTC-PERPETUAL', side: 'short', size: 1000, entryPrice: 80_000, markPrice: 88_000 })!;
    expect(usd).toBeCloseTo(-100, 9);
    expect(positionPnlPercent({ side: 'short', entryPrice: 80_000, markPrice: 88_000 })).toBeCloseTo(-10, 9);
  });

  it('deribit USDC linear: coin qty x move', () => {
    expect(positionPnlSinceEntryUsd({ exchange: 'deribit', symbol: 'SOL_USDC-PERPETUAL', side: 'long', size: 10, entryPrice: 150, markPrice: 147.5, unrealizedPnL: 4 })).toBeCloseTo(-25, 9);
  });

  it('bybit linear: qty x move, short flips', () => {
    expect(positionPnlSinceEntryUsd({ exchange: 'bybit', symbol: 'ETHUSDT', side: 'short', size: 2, entryPrice: 2500, markPrice: 2450 })).toBeCloseTo(100, 9);
  });

  it('tradestation futures: qty x move x multiplier', () => {
    expect(positionPnlSinceEntryUsd({ exchange: 'tradestation', symbol: 'MESZ26', side: 'long', size: 1, entryPrice: 7773.5, markPrice: 7830.25 })).toBeCloseTo(283.75, 9);
    expect(positionPnlSinceEntryUsd({ exchange: 'tradestation', symbol: 'MGCZ26', side: 'short', size: 2, entryPrice: 4500, markPrice: 4510 })).toBeCloseTo(-200, 9);
  });

  it('falls back to the venue figure without a usable mark', () => {
    expect(positionPnlSinceEntryUsd({ exchange: 'tradestation', symbol: 'MESZ26', side: 'long', size: 1, entryPrice: 7773.5, markPrice: 0, unrealizedPnL: 12.5 })).toBe(12.5);
    expect(positionPnlSinceEntryUsd({ exchange: 'deribit', symbol: 'ETH-PERPETUAL', side: 'long', size: 981, entryPrice: 0, markPrice: null, unrealizedPnL: 0.01 })).toBeNull();
    expect(positionPnlPercent({ side: 'long', entryPrice: 0, markPrice: 100 })).toBeNull();
  });
});

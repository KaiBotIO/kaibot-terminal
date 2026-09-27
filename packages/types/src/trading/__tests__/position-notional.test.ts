import { describe, expect, it } from 'bun:test';
import { pnlCurrencyOf, positionNotionalUsd, positionPnlUsd } from '../futures-multipliers';

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

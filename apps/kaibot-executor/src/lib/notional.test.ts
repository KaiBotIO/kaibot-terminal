import { describe, expect, it } from "bun:test";
import { notionalOf, orderNotional, pnlUsdOf } from "./notional";

// Regression (live-data-review 28/08): Dashboard, Portfolio, Positions and the
// manual-trade confirm all valued a futures position at bare size x price, so
// the live MGC long read as $4.531 instead of $45.053 while the P&L column
// beside it did use the multiplier.
describe("notionalOf", () => {
  it("values 1 MGC at the 10x contract multiplier", () => {
    expect(
      notionalOf({ exchange: "tradestation", symbol: "MGCZ26", size: 1, entryPrice: 4500 }),
    ).toBe(45_000);
  });

  it("values MNQ at 2x and MES at 5x", () => {
    expect(
      notionalOf({ exchange: "tradestation", symbol: "MNQU26", size: 2, entryPrice: 29_228 }),
    ).toBe(116_912);
    expect(
      notionalOf({ exchange: "tradestation", symbol: "MESU26", size: 1, entryPrice: 7696.25 }),
    ).toBe(38_481.25);
  });

  it("prefers the mark over the entry price", () => {
    expect(
      notionalOf({
        exchange: "tradestation",
        symbol: "MGCZ26",
        size: 1,
        entryPrice: 4500,
        markPrice: 4600,
      }),
    ).toBe(46_000);
  });

  it("leaves linear crypto at 1x", () => {
    expect(
      notionalOf({ exchange: "bybit", symbol: "BTCUSDT", size: 2, entryPrice: 60_000 }),
    ).toBe(120_000);
  });

  it("uses the notional the backend sent when present", () => {
    expect(
      notionalOf({
        exchange: "tradestation",
        symbol: "MGCZ26",
        size: 1,
        entryPrice: 4500,
        notional: 45_053,
      }),
    ).toBe(45_053);
  });

  it("is 0 without a usable price", () => {
    expect(notionalOf({ exchange: "tradestation", symbol: "MGCZ26", size: 1, entryPrice: 0 })).toBe(0);
  });

  it("is unsigned for shorts", () => {
    expect(
      notionalOf({ exchange: "tradestation", symbol: "MNQU26", size: -1, entryPrice: 29_205 }),
    ).toBe(58_410);
  });
});

describe("orderNotional", () => {
  it("multiplies a close of 1 MGC to $45.076", () => {
    expect(
      orderNotional({ exchange: "tradestation", symbol: "MGCZ26", qty: 1, price: 4507.6 }),
    ).toBeCloseTo(45_076, 6);
  });

  it("keeps a linear crypto order at qty x price", () => {
    expect(
      orderNotional({ exchange: "deribit", symbol: "SOL_USDC-PERPETUAL", qty: 0.5, price: 150 }),
    ).toBe(75);
    expect(orderNotional({ exchange: "bybit", symbol: "BTCUSDT", qty: 0.5, price: 60_000 })).toBe(30_000);
  });

  // Regression (portfolio review 27/09): an inverse order's qty is already the
  // USD notional (1 contract = 1 USD), never qty x price.
  it("takes an inverse order's contract count as its USD notional", () => {
    expect(
      orderNotional({ exchange: "deribit", symbol: "BTC-PERPETUAL", qty: 500, price: 60_000 }),
    ).toBe(500);
    expect(orderNotional({ exchange: "bybit", symbol: "BTCUSD", qty: 500, price: 60_000 })).toBe(500);
  });
});

describe("notionalOf on inverse contracts", () => {
  it("values 981 ETH-PERPETUAL contracts as $981 without a backend notional", () => {
    expect(
      notionalOf({ exchange: "deribit", symbol: "ETH-PERPETUAL", size: 981, entryPrice: 2700, markPrice: 2714 }),
    ).toBe(981);
    // Even when an older backend attached multiplier 1 but no notional.
    expect(
      notionalOf({ exchange: "deribit", symbol: "ETH-PERPETUAL", size: 981, entryPrice: 2700, multiplier: 1 }),
    ).toBe(981);
  });

  it("values a USDC linear perp at qty x mark", () => {
    expect(
      notionalOf({ exchange: "deribit", symbol: "SOL_USDC-PERPETUAL", size: 10, entryPrice: 148, markPrice: 150 }),
    ).toBe(1500);
  });
});

describe("pnlUsdOf", () => {
  it("prefers the backend USD figure and values coin P&L at the mark otherwise", () => {
    expect(pnlUsdOf({ symbol: "ETH-PERPETUAL", exchange: "deribit", unrealizedPnL: -0.001, unrealizedPnLUsd: -2.7 })).toBe(-2.7);
    expect(pnlUsdOf({ symbol: "ETH-PERPETUAL", exchange: "deribit", unrealizedPnL: -0.001, markPrice: 2700 })).toBeCloseTo(-2.7, 9);
    expect(pnlUsdOf({ symbol: "ETH-PERPETUAL", exchange: "deribit", unrealizedPnL: -0.001 })).toBeNull();
    expect(pnlUsdOf({ symbol: "ETH-PERPETUAL", exchange: "deribit", unrealizedPnL: -0.001, unrealizedPnLUsd: null })).toBeNull();
    expect(pnlUsdOf({ symbol: "MESZ26", exchange: "tradestation", unrealizedPnL: 163.75 })).toBe(163.75);
  });
});

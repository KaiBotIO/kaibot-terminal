import { describe, expect, it } from "bun:test";
import { notionalOf, orderNotional } from "./notional";

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

  it("leaves crypto at 1x", () => {
    expect(
      notionalOf({ exchange: "deribit", symbol: "BTC-PERPETUAL", size: 2, entryPrice: 60_000 }),
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

  it("keeps a crypto order at qty x price", () => {
    expect(
      orderNotional({ exchange: "deribit", symbol: "BTC-PERPETUAL", qty: 0.5, price: 60_000 }),
    ).toBe(30_000);
  });
});

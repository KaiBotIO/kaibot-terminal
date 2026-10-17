import { describe, expect, it } from "bun:test";
import { chartPathFor, chartPathForMarket, chartTargetFor } from "./chart-link";

describe("chartTargetFor", () => {
  it("keeps crypto venue symbols as the row shows them", () => {
    expect(chartTargetFor("bybit", "1000BONKUSDT")).toEqual({ exchange: "bybit", symbol: "1000BONKUSDT" });
    expect(chartTargetFor("deribit", "BTC-PERPETUAL")).toEqual({ exchange: "deribit", symbol: "BTC-PERPETUAL" });
  });

  it("charts a dated TradeStation contract on its root", () => {
    expect(chartTargetFor("tradestation", "MGCZ26")).toEqual({ exchange: "tradestation", symbol: "MGC" });
    expect(chartTargetFor("TradeStation", "mnqh27")).toEqual({ exchange: "tradestation", symbol: "MNQ" });
    expect(chartTargetFor("tradestation", "MGC")?.symbol).toBe("MGC");
  });

  it("never strips a crypto dated future", () => {
    expect(chartTargetFor("bybit", "BTCUSDH26")?.symbol).toBe("BTCUSDH26");
  });

  it("does not link options or dated futures", () => {
    expect(chartTargetFor("deribit", "BTC-27DEC26")).toBeNull();
    expect(chartTargetFor("deribit", "BTC-27DEC26-90000-C")).toBeNull();
    expect(chartTargetFor("deribit", "ETH_USDC-3OCT26-2500-P")).toBeNull();
    expect(chartTargetFor("bybit", "BTCUSDT-01MAY26")).toBeNull();
    expect(chartPathForMarket("deribit:BTC-27DEC26:1h", null)).toBeNull();
  });

  it("returns null without a venue or symbol", () => {
    expect(chartTargetFor(null, "BTCUSDT")).toBeNull();
    expect(chartTargetFor("bybit", " ")).toBeNull();
  });
});

describe("chartPathFor", () => {
  it("builds the executor chart route", () => {
    expect(chartPathFor("bybit", "BTCUSDT")).toBe("/terminal?symbol=BTCUSDT&exchange=bybit");
    expect(chartPathFor("tradestation", "MGCZ26")).toBe("/terminal?symbol=MGC&exchange=tradestation");
  });
});

describe("chartPathForMarket", () => {
  it("uses the subscription venue for a bare market", () => {
    expect(chartPathForMarket("SOLUSDT", "bybit")).toBe("/terminal?symbol=SOLUSDT&exchange=bybit");
  });

  it("reads the venue from a qualified market string", () => {
    expect(chartPathForMarket("deribit:BTC-PERPETUAL:1h", "bybit")).toBe(
      "/terminal?symbol=BTC-PERPETUAL&exchange=deribit",
    );
  });

  it("maps a composite bot's canonical market to the sub venue's symbol", () => {
    expect(chartPathForMarket("BTC", "deribit")).toBe("/terminal?symbol=BTC-PERPETUAL&exchange=deribit");
    expect(chartPathForMarket("ETH", "bybit")).toBe("/terminal?symbol=ETHUSDT&exchange=bybit");
  });

  it("returns null when no venue is known", () => {
    expect(chartPathForMarket("BTCUSDT", null)).toBeNull();
  });
});

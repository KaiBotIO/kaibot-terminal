import { describe, expect, it } from "bun:test";
import { parseOrderPrefill, prefillKey, resolveOrderPrefill, venueAccountIdFor } from "./order-prefill";

const sessions = [
  { exchangeName: "tradestation", label: "default", accountKey: null },
  { exchangeName: "deribit", label: "acct1", accountKey: "acct1" },
  { exchangeName: "deribit", label: "default", accountKey: null },
  { exchangeName: "bybit", label: "default", accountKey: null },
];

describe("parseOrderPrefill", () => {
  it("takes the URL pair as venue + upper-case symbol", () => {
    expect(parseOrderPrefill("dydxusdt", "Bybit")).toEqual({ exchange: "bybit", symbol: "DYDXUSDT" });
  });

  it("splits a Studio pair and keeps an explicit exchange", () => {
    expect(parseOrderPrefill("BYBIT:DYDXUSDT", null)).toEqual({ exchange: "bybit", symbol: "DYDXUSDT" });
    expect(parseOrderPrefill("DERIBIT:BTC-PERPETUAL", "deribit")).toEqual({ exchange: "deribit", symbol: "BTC-PERPETUAL" });
  });

  it("needs both a symbol and a venue", () => {
    expect(parseOrderPrefill("BTCUSDT", null)).toBeNull();
    expect(parseOrderPrefill(null, "bybit")).toBeNull();
    expect(parseOrderPrefill("  ", "bybit")).toBeNull();
  });
});

describe("prefillKey", () => {
  it("is the same for the same pair however it is spelled", () => {
    expect(prefillKey(parseOrderPrefill("dydxusdt", "bybit"))).toBe(prefillKey(parseOrderPrefill("BYBIT:DYDXUSDT", null)));
    expect(prefillKey(null)).toBe("");
  });
});

describe("resolveOrderPrefill", () => {
  it("selects the connection on the chart's venue", () => {
    expect(resolveOrderPrefill({ exchange: "bybit", symbol: "DYDXUSDT" }, sessions)).toEqual({
      connectionKey: "bybit",
      symbol: "DYDXUSDT",
    });
  });

  it("prefers the default connection when a venue has several", () => {
    expect(resolveOrderPrefill({ exchange: "deribit", symbol: "BTC-PERPETUAL" }, sessions)?.connectionKey).toBe("deribit");
  });

  it("keeps the current connection when it is already on the venue", () => {
    expect(resolveOrderPrefill({ exchange: "deribit", symbol: "ETH-PERPETUAL" }, sessions, "deribit:acct1")?.connectionKey).toBe(
      "deribit:acct1",
    );
    expect(resolveOrderPrefill({ exchange: "deribit", symbol: "ETH-PERPETUAL" }, sessions, "bybit")?.connectionKey).toBe("deribit");
  });

  it("falls back to a labeled connection when there is no default", () => {
    const only = [{ exchangeName: "deribit", label: "acct1", accountKey: "acct1" }];
    expect(resolveOrderPrefill({ exchange: "deribit", symbol: "ETH-PERPETUAL" }, only)?.connectionKey).toBe("deribit:acct1");
  });

  it("matches venue spellings loosely", () => {
    const ib = [{ exchangeName: "interactive-brokers", label: "default", accountKey: null }];
    expect(resolveOrderPrefill({ exchange: "interactivebrokers", symbol: "MNQ" }, ib)?.connectionKey).toBe("interactive-brokers");
  });

  it("drops a pair on a venue without a connection", () => {
    expect(resolveOrderPrefill({ exchange: "binance", symbol: "BTCUSDT" }, sessions)).toBeNull();
    expect(resolveOrderPrefill({ exchange: "composite", symbol: "BTC" }, sessions)).toBeNull();
    expect(resolveOrderPrefill(null, sessions)).toBeNull();
  });
});

describe("venueAccountIdFor", () => {
  const acct1 = [{ accountId: "acct1/btc" }, { accountId: "acct1/eth" }, { accountId: "acct1/usdc" }];
  it("maps a Deribit symbol to its settle-currency account", () => {
    expect(venueAccountIdFor("deribit", "ETH-PERPETUAL", acct1)).toBe("acct1/eth");
    expect(venueAccountIdFor("deribit", "BTC-PERPETUAL", acct1)).toBe("acct1/btc");
    expect(venueAccountIdFor("deribit", "BTC_USDC-PERPETUAL", acct1)).toBe("acct1/usdc");
    expect(venueAccountIdFor("deribit", "eth-perpetual", [{ accountId: "btc" }, { accountId: "eth" }])).toBe("eth");
  });

  it("leaves single-wallet venues and unknown currencies alone", () => {
    expect(venueAccountIdFor("bybit", "ETHUSDT", [{ accountId: "UTA" }])).toBeNull();
    expect(venueAccountIdFor("deribit", "SOL-PERPETUAL", acct1)).toBeNull();
    expect(venueAccountIdFor("deribit", "ETH-PERPETUAL", [{ accountId: "acct1/btc" }])).toBeNull();
  });
});

import { describe, expect, it } from "bun:test";
import type { Balance, ExchangeSession, Position } from "@/lib/atoms";
import { fmtSignedUsd, fmtUsd, portfolioFigures, walletSummary } from "./portfolio-figures";

// Regression (portfolio review 27/09): with TradeStation + two Deribit
// connections the page showed total equity $54.367 (coin amounts added as
// dollars), Deribit exposure $2,66M (981 USD contracts x the ETH price) and a
// 96 % ETH-PERPETUAL allocation.

const session = (over: Partial<ExchangeSession>): ExchangeSession => ({
  exchangeName: "deribit",
  status: "connected",
  ...over,
});

const bal = (over: Partial<Balance>): Balance => ({
  accountId: "x",
  balance: 0,
  equity: 0,
  realizedPnL: 0,
  unrealizedPnL: 0,
  currency: "USD",
  timestamp: 0,
  ...over,
});

const pos = (over: Partial<Position>): Position => ({
  id: over.symbol ?? "p",
  accountId: "a",
  symbol: "X",
  side: "long",
  size: 1,
  entryPrice: 100,
  ...over,
});

function fixture() {
  const sessions = [
    session({ exchangeName: "tradestation" }),
    session({ exchangeName: "deribit" }),
    session({ exchangeName: "deribit", accountKey: "acct1", label: "acct1" }),
    session({ exchangeName: "bybit", status: "disconnected" }),
  ];
  const balances = new Map<string, Balance[]>([
    [
      "tradestation",
      [
        bal({ accountId: "21084931", equity: 14_700.43, usdEquity: 14_700.43, usdRate: 1 }),
        bal({ accountId: "21084933", equity: 27_693.82, usdEquity: 27_693.82, usdRate: 1 }),
        bal({ accountId: "21084936", equity: 11_953.51, usdEquity: 11_953.51, usdRate: 1 }),
      ],
    ],
    [
      "deribit",
      [
        bal({ accountId: "btc", equity: 0.1, currency: "BTC", usdEquity: 8407, usdRate: 84_070 }),
        bal({ accountId: "eth", equity: 5.01, currency: "ETH", usdEquity: 13_537, usdRate: 2702 }),
        bal({ accountId: "usdc", equity: 0, currency: "USDC", usdEquity: 0, usdRate: 1 }),
      ],
    ],
    [
      "deribit:acct1",
      [
        bal({ accountId: "acct1/btc", equity: 0.1, currency: "BTC", usdEquity: 8407, usdRate: 84_070 }),
        bal({ accountId: "acct1/eth", equity: 5.01, currency: "ETH", usdEquity: 13_537, usdRate: 2702 }),
        bal({ accountId: "acct1/usdc", equity: 9.39, currency: "USDC", usdEquity: 9.39, usdRate: 1 }),
      ],
    ],
  ]);
  const positions: Position[] = [
    // TradeStation futures: the backend already attached notional + USD pnl.
    pos({ exchange: "tradestation", symbol: "MESZ26", size: 1, entryPrice: 7790, markPrice: 7800, multiplier: 5, notional: 39_000, unrealizedPnL: 50, unrealizedPnLUsd: 50 }),
    pos({ exchange: "tradestation", symbol: "MNQZ26", size: 1, entryPrice: 30_850, markPrice: 30_900, multiplier: 2, notional: 61_800, unrealizedPnL: 100, unrealizedPnLUsd: 100 }),
    // Deribit inverse on acct1, from an older backend: no notional/usd pnl on the wire.
    pos({ exchange: "deribit", accountKey: "acct1", symbol: "ETH-PERPETUAL", side: "short", size: 981, entryPrice: 2700, markPrice: 2714, unrealizedPnL: -0.000735 }),
    // Deribit USDC linear on the default connection, with the backend figures.
    pos({ exchange: "deribit", symbol: "SOL_USDC-PERPETUAL", size: 10, entryPrice: 148, markPrice: 150, notional: 1500, unrealizedPnL: 20, unrealizedPnLUsd: 20 }),
  ];
  return { sessions, balances, positions };
}

describe("portfolioFigures", () => {
  it("adds equity in USD and keeps coin wallets as secondary text", () => {
    const f = portfolioFigures(fixture());
    expect(f.totalEquity).toBeCloseTo(54_347.76 + 21_944 + 21_953.39, 2);
    expect(f.equityComplete).toBe(true);
    const acct1 = f.exchanges.find((r) => r.exchange === "deribit · acct1")!;
    expect(acct1.equity).toBeCloseTo(21_953.39, 2);
    expect(acct1.wallets).toBe("0.1 BTC · 5.01 ETH");
    const ts = f.exchanges.find((r) => r.exchange === "tradestation")!;
    expect(ts.wallets).toBe("");
    expect(f.exchanges.map((r) => r.exchange)).toEqual(["tradestation", "deribit · acct1", "deribit"]);
  });

  it("values inverse exposure as the contract count and allocates on USD notional", () => {
    const f = portfolioFigures(fixture());
    const acct1 = f.exchanges.find((r) => r.exchange === "deribit · acct1")!;
    expect(acct1.exposure).toBe(981);
    const ts = f.exchanges.find((r) => r.exchange === "tradestation")!;
    expect(ts.exposure).toBe(100_800);
    expect(f.totalNotional).toBe(100_800 + 981 + 1500);
    expect(f.allocation[0]).toEqual({ symbol: "MNQZ26", notional: 61_800 });
    expect(f.allocation.find((a) => a.symbol === "ETH-PERPETUAL")!.notional).toBe(981);
  });

  it("sums unrealized P&L since entry in USD", () => {
    const f = portfolioFigures(fixture());
    // Inverse short without a backend figure: 981 USD x (2700 - 2714) / 2700.
    expect(f.unrealizedPnL).toBeCloseTo(50 + 100 + 20 - (981 * 14) / 2700, 4);
    expect(f.pnlComplete).toBe(true);
    expect(f.openPositions).toBe(4);
    expect(f.connectedCount).toBe(3);
    expect(f.sessionCount).toBe(4);
  });

  it("flags totals as floors when a wallet or a coin P&L cannot be valued", () => {
    const fx = fixture();
    fx.balances.get("deribit")!.push(bal({ accountId: "sol", equity: 2, currency: "SOL", usdEquity: null, usdRate: null }));
    fx.positions.push(pos({ exchange: "deribit", symbol: "BTC-PERPETUAL", size: 100, entryPrice: 84_000, unrealizedPnL: 0.001 }));
    const f = portfolioFigures(fx);
    expect(f.equityComplete).toBe(false);
    expect(f.pnlComplete).toBe(false);
    expect(f.exchanges.find((r) => r.exchange === "deribit")!.equityComplete).toBe(false);
    expect(fmtUsd(f.totalEquity, f.equityComplete)).toMatch(/^≥ \$/);
    expect(fmtSignedUsd(-1.5, false)).toBe("-$1.50 +?");
  });

  it("ignores balances of a disconnected session's positions and empty maps", () => {
    const f = portfolioFigures({ sessions: [], balances: new Map(), positions: [] });
    expect(f).toMatchObject({ totalEquity: 0, equityComplete: true, totalNotional: 0, exchanges: [] });
  });
});

describe("walletSummary", () => {
  it("formats coin amounts by magnitude and skips dollar and empty wallets", () => {
    expect(
      walletSummary([
        bal({ equity: 0.09999987, currency: "BTC" }),
        bal({ equity: 5.013764, currency: "ETH" }),
        bal({ equity: 1234.5, currency: "SOL" }),
        bal({ equity: 9.39, currency: "USDC" }),
        bal({ equity: 0, currency: "LTC" }),
      ]),
    ).toBe("0.1 BTC · 5.01 ETH · 1,235 SOL");
  });
});

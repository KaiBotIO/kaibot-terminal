import { describe, expect, it } from "bun:test";
import {
  accountMargin,
  countOpenPositions,
  usdTotals,
  worstMarginState,
  type BalanceRow,
} from "./exchange-stats";

const wallet = (over: Partial<BalanceRow>): BalanceRow => ({
  accountId: "btc",
  currency: "BTC",
  balance: 0.1,
  equity: 0.1,
  ...over,
});

// Kai, 2026-09-05: the strip read $5.248 for a book that also held 0,1 BTC and
// 5 ETH per Deribit account. Coin wallets were summed as if they were dollars.
describe("usdTotals", () => {
  it("values coin wallets at their venue mark", () => {
    const t = usdTotals([
      wallet({ currency: "BTC", balance: 0.1, equity: 0.1, usdBalance: 7950, usdEquity: 7950, usdRate: 79500 }),
      wallet({ accountId: "eth", currency: "ETH", balance: 5, equity: 5, usdBalance: 12250, usdEquity: 12250, usdRate: 2450 }),
      wallet({ accountId: "usdc", currency: "USDC", balance: 9.36, equity: 9.36, usdBalance: 9.36, usdEquity: 9.36, usdRate: 1 }),
    ]);
    expect(t.equity).toBeCloseTo(20_209.36, 2);
    expect(t.balance).toBeCloseTo(20_209.36, 2);
    expect(t.complete).toBe(true);
  });

  it("marks the total incomplete when a funded wallet has no mark", () => {
    const t = usdTotals([
      wallet({ currency: "USD", balance: 5248, equity: 5248, usdBalance: 5248, usdEquity: 5248, usdRate: 1 }),
      wallet({ currency: "SOL", balance: 12, equity: 12, usdBalance: null, usdEquity: null, usdRate: null }),
    ]);
    expect(t.equity).toBe(5248);
    expect(t.complete).toBe(false);
  });

  it("an empty unpriced wallet does not make the total incomplete", () => {
    const t = usdTotals([
      wallet({ currency: "USD", balance: 100, equity: 100, usdBalance: 100, usdEquity: 100 }),
      wallet({ currency: "SOL", balance: 0, equity: 0, usdBalance: null, usdEquity: null }),
    ]);
    expect(t.complete).toBe(true);
  });

  it("is zero on an empty book", () => {
    expect(usdTotals([])).toEqual({ equity: 0, balance: 0, complete: true });
  });
});

// Kai, 2026-09-05: "OPEN POSITIONS 11" while Deribit was flat. Deribit lists
// every instrument the account ever touched with size 0.
describe("countOpenPositions", () => {
  it("counts only rows that hold size", () => {
    expect(
      countOpenPositions([
        { size: 0 },
        { size: 0 },
        { size: 1 },
        { size: -2 },
        { size: null },
        {},
      ]),
    ).toBe(2);
  });
});

describe("accountMargin", () => {
  it("reports free margin against the breathing-room floor", () => {
    const m = accountMargin(
      wallet({ accountId: "21084931", currency: "USD", balance: 15146, equity: 14991, initialMargin: 2869, maintenanceMargin: 2608 }),
    );
    expect(m.used).toBe(2869);
    expect(m.free).toBe(12122);
    expect(m.floor).toBe(2608);
    expect(m.state).toBe("healthy");
  });

  it("goes tight once free margin drops under the floor", () => {
    const m = accountMargin(
      wallet({ accountId: "x", currency: "USD", balance: 3000, equity: 3000, initialMargin: 2000, maintenanceMargin: 1500 }),
    );
    expect(m.free).toBe(1000);
    expect(m.floor).toBe(1500);
    expect(m.state).toBe("tight");
  });

  it("honours a buffer multiple", () => {
    const m = accountMargin(
      wallet({ accountId: "x", currency: "USD", balance: 3000, equity: 3000, initialMargin: 1000, maintenanceMargin: 1500 }),
      2,
    );
    expect(m.floor).toBe(3000);
    expect(m.state).toBe("tight");
  });

  it("says unknown when the venue reports no margin numbers", () => {
    const m = accountMargin(wallet({ accountId: "btc", currency: "BTC", initialMargin: undefined, maintenanceMargin: undefined }));
    expect(m.state).toBe("unknown");
    expect(m.free).toBeNull();
    expect(m.floor).toBeNull();
  });
});

describe("worstMarginState", () => {
  it("ranks tight over unknown over healthy", () => {
    expect(worstMarginState(["healthy", "unknown", "tight"])).toBe("tight");
    expect(worstMarginState(["healthy", "unknown"])).toBe("unknown");
    expect(worstMarginState(["healthy", "healthy"])).toBe("healthy");
    expect(worstMarginState([])).toBe("healthy");
  });
});

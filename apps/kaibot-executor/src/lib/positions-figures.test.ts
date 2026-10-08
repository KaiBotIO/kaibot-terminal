import { describe, expect, it } from "bun:test";
import type { GroupOverviewEntry, GroupedPosition } from "./position-groups-api";
import { listedPositions, positionsKpis, sizeNotionalLabel, toPosition } from "./positions-figures";
import { notionalOf } from "./notional";
import { fmtPrice, fmtSignedPct, fmtSignedUsd, fmtUsd, pnlTone } from "./portfolio-figures";

const row = (over: Partial<GroupedPosition>): GroupedPosition => ({
  exchange: "deribit",
  accountId: "eth",
  symbol: "ETH-PERPETUAL",
  side: "long",
  size: 1,
  entryPrice: 100,
  markPrice: 100,
  positionKey: "k",
  group: null,
  effectiveStop: null,
  expiry: null,
  ladder: null,
  ...over,
});

// The four rows of the 05/10 screenshot, as the overview endpoint of an older
// backend sends them (no USD figure): P&L must come from entry and mark.
const entries: GroupOverviewEntry[] = [
  {
    group: { id: "g1", name: "Regime-Slow MES 30m", source: "bot" },
    aggregates: { positionCount: 1, netUnrealizedPnl: 283.75, exposure: 39_151.25, stopRisk: null, stoppedCount: 0 },
    positions: [
      row({ positionKey: "a", exchange: "tradestation", accountId: "21084931", symbol: "MESZ26", size: 1, entryPrice: 7773.5, markPrice: 7830.25, unrealizedPnL: 283.75 }),
    ],
  },
  {
    group: { id: "g2", name: "Fault-Line ETH 4h", source: "bot" },
    aggregates: { positionCount: 1, netUnrealizedPnl: -0.00184, exposure: 981, stopRisk: null, stoppedCount: 0 },
    positions: [
      row({ positionKey: "b", size: 981, entryPrice: 2629.65, markPrice: 2712.41, unrealizedPnL: -0.00184, pnlCurrency: "ETH" }),
    ],
  },
  {
    group: null,
    aggregates: { positionCount: 2, netUnrealizedPnl: -0.01, exposure: 9374, stopRisk: null, stoppedCount: 0 },
    positions: [
      row({ positionKey: "c", accountId: "eth", size: 6424, entryPrice: 2731.01, markPrice: 2712.41, unrealizedPnL: -0.004 }),
      row({ positionKey: "d", accountId: "btc", symbol: "BTC-PERPETUAL", size: 2950, entryPrice: 86_116.5, markPrice: 86_400, unrealizedPnL: -0.0000001 }),
    ],
  },
];

describe("positionsKpis", () => {
  // Regression (positions review 05/10): the KPI strip counted the broker
  // snapshot while the list showed the overview, and the header repeated it.
  it("counts and sums exactly the rows the list shows", () => {
    const rows = listedPositions(entries, []);
    expect(rows.map((p) => p.id)).toEqual(["a", "b", "c", "d"]);
    const k = positionsKpis(rows);
    const shown = {
      open: k.openPositions,
      notional: fmtUsd(k.totalNotional),
      pnl: fmtSignedUsd(k.unrealizedPnL, k.pnlComplete),
      tone: pnlTone(k.unrealizedPnL),
    };
    expect(shown).toMatchSnapshot();
    // Row by row the same figures the P&L cells print.
    expect(k.unrealizedPnL).toBeCloseTo(
      283.75 + (981 * (2712.41 - 2629.65)) / 2629.65 + (6424 * (2712.41 - 2731.01)) / 2731.01 + (2950 * (86_400 - 86_116.5)) / 86_116.5,
      9,
    );
  });

  it("falls back to the broker snapshot while the overview loads", () => {
    const snapshot = [toPosition(entries[0].positions[0])];
    expect(listedPositions(null, snapshot)).toBe(snapshot);
  });

  it("carries the backend USD figure through toPosition", () => {
    expect(toPosition(row({ unrealizedPnLUsd: 12.5 })).unrealizedPnLUsd).toBe(12.5);
  });
});

describe("number notation and zero", () => {
  it("prints zero without a sign or colour", () => {
    expect(fmtSignedUsd(-0.0018)).toBe("$0.00");
    expect(fmtSignedUsd(-0.004)).toBe("$0.00");
    expect(pnlTone(-0.004)).toBe("flat");
    expect(fmtSignedUsd(-0.01)).toBe("-$0.01");
    expect(pnlTone(-0.01)).toBe("down");
    expect(fmtSignedPct(-0.001)).toBe("0.00%");
    expect(fmtSignedPct(3.147)).toBe("+3.15%");
  });

  it("uses one grouped en-US notation for prices", () => {
    expect(fmtPrice(7773.5)).toBe("7,773.50");
    expect(fmtPrice(86_116.5)).toBe("86,116.50");
    expect(fmtPrice(0.004512)).toBe("0.004512");
    expect(fmtPrice(null)).toBe("—");
  });
});

describe("sizeNotionalLabel", () => {
  const rows = [
    toPosition(row({ positionKey: "bybit", exchange: "bybit", accountId: "alts", symbol: "DYDXUSDT", size: 3739.5, entryPrice: 0.13, markPrice: 0.1343 })),
    toPosition(row({ positionKey: "btc", accountId: "main", symbol: "BTC-PERPETUAL", size: 2950, entryPrice: 61_000, markPrice: 62_500 })),
    toPosition(row({ positionKey: "mgc", exchange: "tradestation", accountId: "21084931", symbol: "MGCZ26", size: 1, entryPrice: 4100, markPrice: 4138.7 })),
    toPosition(row({ positionKey: "mes", exchange: "tradestation", accountId: "21084931", symbol: "MESZ26", size: 2, entryPrice: 7773.5, markPrice: 7830.25 })),
  ];

  it("values a linear perp at size x mark", () => {
    expect(notionalOf(rows[0]!)).toBeCloseTo(502.21, 2);
    expect(sizeNotionalLabel(rows[0]!)).toBe("≈ $502");
  });

  it("labels an inverse perp USD: the size is the notional", () => {
    expect(notionalOf(rows[1]!)).toBe(2950);
    expect(sizeNotionalLabel(rows[1]!)).toBe("USD");
  });

  it("values futures at contracts x multiplier x mark", () => {
    expect(sizeNotionalLabel(rows[2]!)).toBe("≈ $41,387");
    expect(sizeNotionalLabel(rows[3]!)).toBe("≈ $78,303");
  });

  it("rows add up to the Total Notional card", () => {
    const sum = rows.reduce((s, p) => s + notionalOf(p), 0);
    expect(sum).toBeCloseTo(positionsKpis(rows).totalNotional, 9);
    expect(sum).toBeCloseTo(502.2133 + 2950 + 41_387 + 78_302.5, 2);
  });

  it("is null without a usable price", () => {
    expect(sizeNotionalLabel({ exchange: "bybit", symbol: "DYDXUSDT", size: 1, entryPrice: 0 })).toBeNull();
  });
});

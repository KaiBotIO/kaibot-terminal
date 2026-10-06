import { describe, expect, it } from "bun:test";
import type { Position } from "@/lib/atoms";
import type { AccumulatePlan } from "@/lib/accumulate-api";
import type { HedgeGuardView } from "@/lib/hedge-api";
import type { ActiveRide, ManagedTrailView, StopFloorView } from "@/lib/manual-trade-api";
import type { SyntheticUsdPosition } from "@/lib/synthetic-usd-api";
import {
  activeFilter,
  ALL_FILTER,
  deriveProtection,
  EMPTY_SOURCES,
  filterRows,
  groupFilterChips,
  holdingsFloors,
  managedBy,
  MANUAL_FILTER,
  plansWithoutPosition,
  rowActionIds,
} from "./position-protection";

const pos = (over: Partial<Position> = {}): Position => ({
  id: `deribit:${over.accountId ?? "btc"}:${over.symbol ?? "BTC-PERPETUAL"}`,
  accountId: "btc",
  symbol: "BTC-PERPETUAL",
  side: "long",
  size: 2950,
  entryPrice: 86_116.5,
  markPrice: 86_400,
  unrealizedPnL: 0,
  exchange: "deribit",
  ...over,
});

const trail = (over: Partial<ManagedTrailView>): ManagedTrailView =>
  ({ active: true, exchange: "deribit", accountId: "btc", symbol: "BTC-PERPETUAL", effectiveStop: null, trailingLock: false, ...over }) as ManagedTrailView;
const stopFloor = (over: Partial<StopFloorView>): StopFloorView =>
  ({ kind: "floor", active: true, exchange: "deribit", accountId: "btc", symbol: "BTC-PERPETUAL", manualStop: null, effectiveStop: null, trailingLock: false, ...over }) as StopFloorView;
const ride = (over: Partial<ActiveRide> = {}): ActiveRide => ({
  positionId: "r1",
  exchange: "deribit",
  symbol: "BTC-PERPETUAL",
  accountId: "btc",
  direction: "long",
  botId: "b1",
  botName: "ETH tf-ride 1h",
  currentStop: 79_227,
  ...over,
});
const floor = (over: { coverManual: boolean; triggerPrice: number; account_id?: string; symbol?: string; exchange?: string; status?: SyntheticUsdPosition["status"]; inCycle?: boolean }): SyntheticUsdPosition =>
  ({
    id: `f-${over.account_id ?? "btc"}-${over.symbol ?? "BTC-PERPETUAL"}-${over.coverManual}`,
    exchange: over.exchange ?? "deribit",
    account_id: over.account_id ?? "btc",
    symbol: over.symbol ?? "BTC-PERPETUAL",
    status: over.status ?? "armed",
    accountKey: null,
    armed: {
      inCycle: over.inCycle ?? true,
      coverManual: over.coverManual,
      triggerPrice: over.triggerPrice,
      firedPrice: null,
      lastError: null,
    },
  }) as unknown as SyntheticUsdPosition;
const hedge = (over: Partial<HedgeGuardView>): HedgeGuardView =>
  ({ exchange: "deribit", accountId: "btc", symbol: "BTC-PERPETUAL", status: "armed", triggerPrice: 80_000, lastError: null, ...over }) as HedgeGuardView;
const plan = (over: Partial<AccumulatePlan> = {}): AccumulatePlan =>
  ({ id: "p1", exchange: "deribit", accountId: "btc", symbol: "BTC-PERPETUAL", phase: "riding", ride: null, lastError: null, ...over }) as AccumulatePlan;

describe("deriveProtection: which layer wins", () => {
  it("long: the highest level acts first", () => {
    const pr = deriveProtection(pos(), {
      ...EMPTY_SOURCES,
      rides: [ride()],
      floors: [floor({ coverManual: true, triggerPrice: 76_904.63 })],
      hedges: [hedge({ triggerPrice: 78_000 })],
    });
    expect(pr.primary?.kind).toBe("ride");
    expect(pr.primary?.level).toBe(79_227);
    expect(pr.layers.map((l) => l.kind)).toEqual(["ride", "hedge", "floor"]);
  });

  it("short: the lowest level acts first", () => {
    const pr = deriveProtection(pos({ side: "short" }), {
      ...EMPTY_SOURCES,
      trails: [trail({ effectiveStop: 90_000 })],
      hedges: [hedge({ triggerPrice: 88_000 })],
    });
    expect(pr.primary?.kind).toBe("hedge");
  });

  it("a stop beats a ride at the same level; a layer without a level ranks last", () => {
    const pr = deriveProtection(pos(), {
      ...EMPTY_SOURCES,
      trails: [trail({ effectiveStop: 79_227 })],
      rides: [ride({ currentStop: 79_227 })],
    });
    expect(pr.layers.map((l) => l.kind)).toEqual(["stop", "ride"]);
    const noLevel = deriveProtection(pos(), {
      ...EMPTY_SOURCES,
      rides: [ride({ currentStop: null })],
      hedges: [hedge({ triggerPrice: 70_000 })],
    });
    expect(noLevel.layers.map((l) => l.kind)).toEqual(["hedge", "ride"]);
  });

  it("falls back to the bot's stop floor without a trail", () => {
    const pr = deriveProtection(pos(), { ...EMPTY_SOURCES, stopFloors: [stopFloor({ manualStop: 80_000, trailingLock: true })] });
    expect(pr.primary).toMatchObject({ kind: "stop", level: 80_000, note: "locked" });
  });

  it("a plan shows as a chip but never protects on its own", () => {
    const pr = deriveProtection(pos(), { ...EMPTY_SOURCES, plans: [plan({ phase: "ladder" })] });
    expect(pr.primary).toBeNull();
    expect(pr.layers).toEqual([expect.objectContaining({ kind: "plan", note: "laddering" })]);
    expect(deriveProtection(pos(), { ...EMPTY_SOURCES, plans: [plan({ phase: "stopped" })] }).plan).toBeNull();
  });

  it("a floor on the coins only is not position protection", () => {
    const pr = deriveProtection(pos(), { ...EMPTY_SOURCES, floors: [floor({ coverManual: false, triggerPrice: 76_000 })] });
    expect(pr.primary).toBeNull();
    expect(pr.holdingsFloor).not.toBeNull();
  });

  it("matches the connection: acct1 and the default account are different positions", () => {
    const acct1 = pos({ accountId: "acct1/eth", symbol: "ETH-PERPETUAL" });
    const dflt = pos({ accountId: "eth", symbol: "ETH-PERPETUAL" });
    const src = { ...EMPTY_SOURCES, floors: [floor({ coverManual: true, triggerPrice: 2471.24, account_id: "eth", symbol: "ETH-PERPETUAL" })] };
    expect(deriveProtection(dflt, src).primary?.kind).toBe("floor");
    expect(deriveProtection(acct1, src).primary).toBeNull();
    // A legacy trail row without an account belongs to the default connection only.
    const legacy = { ...EMPTY_SOURCES, trails: [trail({ accountId: null, symbol: "ETH-PERPETUAL", effectiveStop: 2500 })] };
    expect(deriveProtection(dflt, legacy).primary?.kind).toBe("stop");
    expect(deriveProtection(acct1, legacy).primary).toBeNull();
  });

  it("a fired floor or an open hedge turns amber", () => {
    const pr = deriveProtection(pos(), {
      ...EMPTY_SOURCES,
      floors: [floor({ coverManual: true, triggerPrice: 80_000, status: "open" })],
      hedges: [hedge({ status: "hedged", triggerPrice: 70_000 })],
    });
    expect(pr.layers.map((l) => [l.kind, l.note, l.tone])).toEqual([
      ["floor", "fired", "warn"],
      ["hedge", "open", "warn"],
    ]);
  });
});

describe("deriveProtection: fails closed", () => {
  // Review 06/10: a badge must never claim protection the position doesn't have.
  it("a ride without a stop alone is not protection", () => {
    const pr = deriveProtection(pos(), { ...EMPTY_SOURCES, rides: [ride({ currentStop: null })] });
    expect(pr.layers.map((l) => l.kind)).toEqual(["ride"]);
    expect(pr.primary).toBeNull();
  });

  it("a floor with lastError is not protection", () => {
    const broken = floor({ coverManual: true, triggerPrice: 76_000 });
    broken.armed.lastError = "venue rejected the short";
    const pr = deriveProtection(pos(), { ...EMPTY_SOURCES, floors: [broken] });
    expect(pr.layers[0]).toMatchObject({ kind: "floor", tone: "bad" });
    expect(pr.primary).toBeNull();
  });

  it("a floor or hedge without a trigger is not protection", () => {
    const pr = deriveProtection(pos(), {
      ...EMPTY_SOURCES,
      floors: [floor({ coverManual: true, triggerPrice: null as unknown as number })],
      hedges: [hedge({ triggerPrice: null as unknown as number })],
    });
    expect(pr.primary).toBeNull();
  });

  it("an error layer never wins over a working one", () => {
    const broken = floor({ coverManual: true, triggerPrice: 80_000 });
    broken.armed.lastError = "x";
    const pr = deriveProtection(pos(), { ...EMPTY_SOURCES, floors: [broken], hedges: [hedge({ triggerPrice: 75_000 })] });
    expect(pr.primary?.kind).toBe("hedge");
  });

  it("a coverManual floor protects a long only", () => {
    const f = floor({ coverManual: true, triggerPrice: 90_000 });
    const short = deriveProtection(pos({ side: "short" }), { ...EMPTY_SOURCES, floors: [f] });
    expect(short.floor).toBeNull();
    expect(short.primary).toBeNull();
    expect(short.holdingsFloor).toBe(f);
  });
});

describe("blocks under the table", () => {
  it("keeps coin floors and plans without a listed position", () => {
    const rows = [pos({ accountId: "eth", symbol: "ETH-PERPETUAL" })];
    const floors = [
      floor({ coverManual: true, triggerPrice: 2471, account_id: "eth", symbol: "ETH-PERPETUAL" }),
      floor({ coverManual: false, triggerPrice: 70_000 }),
      floor({ coverManual: false, triggerPrice: 150, exchange: "bybit", account_id: "unified", symbol: "SOLUSDT" }),
      floor({ coverManual: false, triggerPrice: 1, inCycle: false }),
    ];
    expect(holdingsFloors(floors, rows).map((f) => f.symbol)).toEqual(["BTC-PERPETUAL", "SOLUSDT"]);
    const plans = [plan({ accountId: "eth", symbol: "ETH-PERPETUAL" }), plan({ id: "p2" }), plan({ id: "p3", phase: "stopped" })];
    expect(plansWithoutPosition(plans, rows).map((p) => p.id)).toEqual(["p2"]);
  });
});

describe("group filter", () => {
  const rows = [
    pos({ id: "a", group: { id: "g1", name: "Regime-Slow MES 30m", source: "bot" } }),
    pos({ id: "b", group: { id: "g2", name: "Fault-Line ETH 4h", source: "bot" } }),
    pos({ id: "c" }),
    pos({ id: "d" }),
  ];

  it("shows All, the groups and Manual", () => {
    expect(groupFilterChips(rows).map((c) => `${c.label} ${c.count}`)).toEqual([
      "All 4",
      "Regime-Slow MES 30m 1",
      "Fault-Line ETH 4h 1",
      "Manual 2",
    ]);
    expect(filterRows(rows, MANUAL_FILTER).map((p) => p.id)).toEqual(["c", "d"]);
    expect(filterRows(rows, "g2").map((p) => p.id)).toEqual(["b"]);
    expect(filterRows(rows, ALL_FILTER)).toHaveLength(4);
  });

  it("drops Manual when empty and falls back to All when the chosen chip is gone", () => {
    const grouped = rows.slice(0, 2);
    const chips = groupFilterChips(grouped);
    expect(chips.map((c) => c.key)).not.toContain(MANUAL_FILTER);
    expect(activeFilter(chips, MANUAL_FILTER)).toBe(ALL_FILTER);
    expect(activeFilter(chips, "g1")).toBe("g1");
  });

  it("names who manages a row", () => {
    expect(managedBy(rows[0], { ride: null, plan: null })).toBe("Regime-Slow MES 30m");
    expect(managedBy(rows[2], { ride: ride(), plan: null })).toBe("ETH tf-ride 1h");
    expect(managedBy(rows[2], { ride: null, plan: plan() })).toBe("accumulate plan");
    expect(managedBy(rows[2], { ride: null, plan: null })).toBe("manual");
  });
});

describe("row menu", () => {
  it("without an account: no accumulate, no move", () => {
    const ids = rowActionIds(pos({ accountId: "" }), { isViewer: false, riding: false, hasPlan: false, canAccount: false });
    expect(ids).not.toContain("accumulate");
    expect(ids).not.toContain("move");
    expect(ids).toContain("close");
  });

  it("viewers get no menu", () => {
    expect(rowActionIds(pos(), { isViewer: true, riding: false, hasPlan: true, canAccount: true })).toEqual([]);
  });

  it("keeps every existing action, situational ones only when they apply", () => {
    expect(rowActionIds(pos(), { isViewer: false, riding: false, hasPlan: false, canAccount: true })).toEqual([
      "manage-stop",
      "hand-over",
      "adopt",
      "accumulate",
      "move",
      "reduce",
      "close",
    ]);
    const dated = pos({ symbol: "MESZ26", exchange: "tradestation", expiry: { date: "2026-12-18", daysLeft: 74, source: "calculated", nextSymbol: "MESH27" } as Position["expiry"] });
    expect(rowActionIds(dated, { isViewer: false, riding: true, hasPlan: true, canAccount: true })).toEqual([
      "manage-stop",
      "take-back",
      "accumulate",
      "roll",
      "move",
      "plan-check",
      "plan-stop",
      "reduce",
      "close",
    ]);
  });
});

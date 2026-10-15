import { describe, expect, it } from "bun:test";
import type { Position } from "@/lib/atoms";
import type { AccumulatePlan } from "@/lib/accumulate-api";
import type { ActiveRide, BracketStopView, ManagedTrailView, StopFloorView } from "@/lib/manual-trade-api";
import type { SyntheticUsdPosition } from "@/lib/synthetic-usd-api";
import {
  activeFilter,
  ALL_FILTER,
  deriveProtection,
  EMPTY_SOURCES,
  filterRows,
  floorChipLabel,
  floorSentence,
  floorTooltip,
  groupFilterChips,
  hedgeTag,
  holdingsFloors,
  isProtected,
  managedBy,
  managedByLines,
  MANUAL_FILTER,
  plansWithoutPosition,
  rowActionIds,
  stopChipLabel,
  stopSentence,
  venueNetLine,
  type ProtectionSources,
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
  ({ active: true, exchange: "deribit", accountId: "btc", symbol: "BTC-PERPETUAL", effectiveStop: null, trailingLock: false, slOrderId: "sl-1", ...over }) as ManagedTrailView;
const stopFloor = (over: Partial<StopFloorView>): StopFloorView =>
  ({ kind: "floor", positionId: "p1", active: true, exchange: "deribit", accountId: "btc", symbol: "BTC-PERPETUAL", manualStop: null, effectiveStop: null, trailingLock: false, slOrderId: "sl-1", ...over }) as StopFloorView;
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
const plan = (over: Partial<AccumulatePlan> = {}): AccumulatePlan =>
  ({ id: "p1", exchange: "deribit", accountId: "btc", symbol: "BTC-PERPETUAL", phase: "riding", ride: null, lastError: null, ...over }) as AccumulatePlan;

const bracket = (over: Partial<BracketStopView> = {}): BracketStopView => ({
  kind: "bracket",
  signalId: "2f041267",
  source: "signal",
  exchange: "deribit",
  accountId: "btc",
  symbol: "BTC-PERPETUAL",
  direction: "long",
  stop: 75_956.83,
  slOrderId: "SLTS-82355385",
  ...over,
});

// Live 14/10: what each row showed vs what protects it.
describe("deriveProtection: live rows 14/10", () => {
  const btcPlan = plan({ id: "6fcc70de-17b1-4c70-98e2-b95f15638288", phase: "waiting" });
  const btcFloor = { ...floor({ coverManual: false, triggerPrice: 76_904.63 }), id: "a3ff2ebf" };
  const acct1 = pos({ accountId: "acct1/btc", size: 5770 });
  const acct1Floor = { ...floor({ coverManual: true, triggerPrice: 57_725.5, account_id: "acct1/btc" }), id: "65877062" };
  const src: ProtectionSources = {
    ...EMPTY_SOURCES,
    brackets: [bracket(), bracket({ signalId: "2f041267~88f88c54", accountId: "acct1/btc", slOrderId: "SLTS-82355386" })],
    floors: [btcFloor, acct1Floor],
    plans: [btcPlan],
  };

  it("bc-macro long on btc: bot stop on venue; the plan floor is a coin floor, not protection", () => {
    const pr = deriveProtection(pos({ size: 7510 }), src);
    expect(pr.stop).toMatchObject({ kind: "bot", price: 75_956.83, onVenue: true });
    expect(stopChipLabel(pr.stop)).toBe("bot stop 75,956.83 on venue");
    expect(pr.accountFloors.map((f) => [f.kind, f.price, f.planId])).toEqual([["coin", 76_904.63, btcPlan.id]]);
    expect(floorChipLabel(pr.accountFloors[0])).toBe("coin floor 76,904.63");
    expect(floorTooltip(pr.accountFloors[0])).toBe("Accumulate plan 6fcc70de: sells the coin holdings below this price");
    expect(isProtected(pr)).toBe(true);
  });

  it("same bot on acct1: bot stop; the synthetic floor is the account's collateral floor", () => {
    const pr = deriveProtection(acct1, src);
    expect(pr.stop).toMatchObject({ kind: "bot", price: 75_956.83, onVenue: true });
    expect(pr.accountFloors.map((f) => [f.kind, f.price])).toEqual([["collateral", 57_725.5]]);
    expect(floorTooltip(pr.accountFloors[0])).toBe("Synthetic floor of the account");
    expect(floorSentence(pr.accountFloors[0])).toBe("Collateral floor 57,725.50, armed, covers the coin holdings.");
  });

  it("crack-scalp alt: no manual floor, the bot stop rests at the venue and trails up", () => {
    const strk = pos({ exchange: "bybit", accountId: "unified", symbol: "STRKUSDT", entryPrice: 0.06 });
    const pr = deriveProtection(strk, {
      ...EMPTY_SOURCES,
      stopFloors: [stopFloor({ exchange: "bybit", accountId: "unified", symbol: "STRKUSDT", engineStop: 0.05544, currentStop: 0.05544, effectiveStop: 0.05544 })],
    });
    expect(pr.stop).toMatchObject({ kind: "bot", price: 0.05544, onVenue: true, trails: true });
    // Same precision as ENTRY (fmtPrice), chip and sentence alike.
    expect(stopChipLabel(pr.stop)).toBe("bot stop 0.0554 on venue");
    expect(stopSentence(pr.stop, "long")).toBe("No manual floor. Bot stop 0.0554 on the venue, trails up.");
  });

  it("only a manual floor or a bot stop counts as protected", () => {
    const rows = [pos({ size: 7510 }), acct1, pos({ accountId: "eth", symbol: "ETH-PERPETUAL" })];
    expect(rows.filter((p) => isProtected(deriveProtection(p, src))).length).toBe(2);
    // A floor alone protects nothing.
    expect(isProtected(deriveProtection(pos(), { ...EMPTY_SOURCES, floors: [btcFloor] }))).toBe(false);
  });

  it("the waiting plan moves to Managed by, never into protection", () => {
    const grouped = pos({ group: { id: "g1", name: "[ALLOC] B&C Alpha Macro BTC 1D", source: "bot" } });
    const pr = deriveProtection(grouped, src);
    expect(managedByLines(grouped, pr)).toEqual(["[ALLOC] B&C Alpha Macro BTC 1D", "Plan 6fcc70de waiting"]);
    expect(managedByLines(pos(), pr)).toEqual(["Plan 6fcc70de waiting", null]);
  });
});

describe("deriveProtection: precedence", () => {
  it("manual floor wins over the bot stop, both in the sentence", () => {
    const pr = deriveProtection(pos({ entryPrice: 0.06 }), {
      ...EMPTY_SOURCES,
      stopFloors: [stopFloor({ manualStop: 0.05, engineStop: 0.05544, currentStop: 0.05544 })],
    });
    expect(pr.stop).toMatchObject({ kind: "manual", manualKind: "floor", price: 0.05, botStop: 0.05544 });
    expect(stopChipLabel(pr.stop)).toBe("manual floor 0.0500");
    expect(stopSentence(pr.stop, "long")).toBe("Manual floor 0.0500. Bot stop 0.0554 above it.");
  });

  it("a locked floor says the bot's moves are held back", () => {
    const pr = deriveProtection(pos(), { ...EMPTY_SOURCES, stopFloors: [stopFloor({ manualStop: 80_000, trailingLock: true, engineStop: 81_000 })] });
    expect(stopSentence(pr.stop, "long")).toBe("Manual floor 80,000.00, locked. The bot cannot move the stop until you unlock it.");
  });

  it("a user trail on a manual position is a manual stop", () => {
    const pr = deriveProtection(pos(), { ...EMPTY_SOURCES, trails: [trail({ source: "manual", effectiveStop: 82_000, currentStop: 82_000 })] });
    expect(stopChipLabel(pr.stop)).toBe("manual stop 82,000.00");
    expect(stopSentence(pr.stop, "long")).toBe("Manual stop 82,000.00 on the venue, trails up.");
  });

  it("a bot trail with the user's floor reads as manual floor", () => {
    const pr = deriveProtection(pos(), { ...EMPTY_SOURCES, trails: [trail({ source: "signal", manualStop: 80_000, engineStop: 81_500, currentStop: 81_500, effectiveStop: 81_500 })] });
    expect(pr.stop).toMatchObject({ kind: "manual", manualKind: "floor", price: 80_000, botStop: 81_500 });
  });

  it("the ride bot owns the stop; a ride without a placed stop is not protected", () => {
    const rideRow = stopFloor({ positionId: "r1", engineStop: 79_227, currentStop: 79_227 });
    const pr = deriveProtection(pos(), { ...EMPTY_SOURCES, rides: [ride()], stopFloors: [rideRow], brackets: [bracket()] });
    expect(pr.stop).toMatchObject({ kind: "bot", price: 79_227, rideBot: "ETH tf-ride 1h", onVenue: true });
    expect(isProtected(pr)).toBe(true);
    expect(stopSentence(pr.stop, "long")).toBe("Handed to ETH tf-ride 1h. Ride stop 79,227.00.");
    const pending = deriveProtection(pos(), { ...EMPTY_SOURCES, rides: [ride({ currentStop: null })] });
    expect(stopChipLabel(pending.stop)).toBe("bot stop pending");
    expect(isProtected(pending)).toBe(false);
  });

  // Review r1: a manual floor on a ridden position lands on the ride's exit state.
  it("a manual floor on a ride wins over the ride stop", () => {
    const rideRow = stopFloor({ positionId: "r1", manualStop: 78_000, engineStop: 79_227, currentStop: 79_227, trailingLock: true });
    const pr = deriveProtection(pos(), { ...EMPTY_SOURCES, rides: [ride()], stopFloors: [rideRow] });
    expect(pr.stop).toMatchObject({ kind: "manual", manualKind: "floor", price: 78_000, botStop: 79_227, rideBot: "ETH tf-ride 1h", locked: true });
    expect(stopChipLabel(pr.stop)).toBe("manual floor 78,000.00");
    expect(stopSentence(pr.stop, "long")).toBe("Handed to ETH tf-ride 1h. Manual floor 78,000.00, locked. The bot cannot move the stop until you unlock it.");
    const open = deriveProtection(pos(), { ...EMPTY_SOURCES, rides: [ride()], stopFloors: [{ ...rideRow, trailingLock: false }] });
    expect(stopSentence(open.stop, "long")).toBe("Handed to ETH tf-ride 1h. Manual floor 78,000.00. Ride stop 79,227.00 above it.");
  });

  // Review r1: a failed replace keeps current_stop but clears sl_order_id.
  it("a stop without a venue order is not ON VENUE and not protected", () => {
    const floorRow = stopFloor({ engineStop: 76_000, currentStop: 76_000, slOrderId: null });
    const pr = deriveProtection(pos(), { ...EMPTY_SOURCES, stopFloors: [floorRow] });
    expect(stopChipLabel(pr.stop)).toBe("bot stop 76,000.00 not on venue");
    expect(stopSentence(pr.stop, "long")).toBe("No manual floor. Bot stop 76,000.00, not on the venue, trails up.");
    expect(isProtected(pr)).toBe(false);
    const manualOff = deriveProtection(pos(), { ...EMPTY_SOURCES, stopFloors: [{ ...floorRow, manualStop: 75_000 }] });
    expect(stopChipLabel(manualOff.stop)).toBe("manual floor 75,000.00 not on venue");
    expect(isProtected(manualOff)).toBe(false);
    const trailOff = deriveProtection(pos(), { ...EMPTY_SOURCES, trails: [trail({ source: "manual", effectiveStop: 82_000, currentStop: 82_000, slOrderId: null })] });
    expect(isProtected(trailOff)).toBe(false);
    const localBracket = deriveProtection(pos(), { ...EMPTY_SOURCES, brackets: [bracket({ slOrderId: null })] });
    expect(localBracket.stop).toMatchObject({ kind: "bot", onVenue: false });
    expect(isProtected(localBracket)).toBe(false);
  });

  it("several entries: the binding stop (highest for a long, lowest for a short)", () => {
    const brackets = [bracket({ stop: 74_000 }), bracket({ signalId: "b2", stop: 76_000, slOrderId: null })];
    const long = deriveProtection(pos(), { ...EMPTY_SOURCES, brackets });
    expect(long.stop).toMatchObject({ price: 76_000, onVenue: false });
    expect(stopSentence(long.stop, "long")).toBe("No manual floor. Bot stop 76,000.00, not on the venue.");
    const short = deriveProtection(pos({ side: "short" }), { ...EMPTY_SOURCES, brackets: brackets.map((b) => ({ ...b, direction: "short" as const })) });
    expect(short.stop.price).toBe(74_000);
  });

  it("a manual entry bracket is the user's stop", () => {
    const pr = deriveProtection(pos(), { ...EMPTY_SOURCES, brackets: [bracket({ signalId: "manual:1", source: "manual" })] });
    expect(stopChipLabel(pr.stop)).toBe("manual stop 75,956.83");
  });

  it("other accounts and the legacy default stay apart", () => {
    const acct1 = pos({ accountId: "acct1/btc" });
    expect(deriveProtection(acct1, { ...EMPTY_SOURCES, brackets: [bracket()] }).stop.kind).toBe("none");
    expect(deriveProtection(pos(), { ...EMPTY_SOURCES, brackets: [bracket({ accountId: null })] }).stop.kind).toBe("bot");
    expect(deriveProtection(acct1, { ...EMPTY_SOURCES, brackets: [bracket({ accountId: null })] }).stop.kind).toBe("none");
  });

  it("nothing at all: none, with a plain sentence", () => {
    const pr = deriveProtection(pos(), EMPTY_SOURCES);
    expect(stopChipLabel(pr.stop)).toBe("none");
    expect(stopSentence(pr.stop, "long")).toBe("No stop on this position.");
  });

  it("a fired or broken floor keeps its own state", () => {
    const fired = { ...floor({ coverManual: true, triggerPrice: 76_000, status: "open" }) };
    (fired.armed as { firedPrice: number | null }).firedPrice = 75_800;
    const pr = deriveProtection(pos(), { ...EMPTY_SOURCES, floors: [fired] });
    expect(pr.accountFloors[0]).toMatchObject({ fired: true, price: 75_800 });
    expect(floorSentence(pr.accountFloors[0])).toBe("Collateral floor fired at 75,800.00.");
    expect(floorChipLabel(pr.accountFloors[0])).toBe("collateral floor 75,800.00 fired");
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

describe("synthetic USD short (live 08/10: read as manual, no stop)", () => {
  const synthetic = { id: "syn-eth", triggerPrice: 2_471.2424, firedPrice: 2_460.79, firedAt: 1, shortUsd: 12_356, holdingsCoin: 5, holdingsUsd: 12_297.65 };
  const short = pos({ accountId: "eth", symbol: "ETH-PERPETUAL", side: "short", size: 12_356, synthetic });
  const fired = { ...floor({ coverManual: true, triggerPrice: 2_471.2424, account_id: "eth", symbol: "ETH-PERPETUAL", status: "open" }), id: "syn-eth" };

  it("is managed by Synthetic USD with the trigger, not manual", () => {
    const prot = deriveProtection(short, { ...EMPTY_SOURCES, floors: [fired] });
    expect(managedBy(short, prot)).toBe("Synthetic USD · trigger 2,471");
    expect(managedBy(pos({ synthetic: { ...synthetic, triggerPrice: null } }), prot)).toBe("Synthetic USD");
  });

  it("carries the hedge and its row; the fired floor is not a 'covers the coins' floor on it", () => {
    const prot = deriveProtection(short, { ...EMPTY_SOURCES, floors: [fired] });
    expect(prot.syntheticHedge).toBe(synthetic);
    expect(prot.syntheticRow).toBe(fired);
    expect(prot.accountFloors).toEqual([]);
    expect(isProtected(prot)).toBe(false);
  });

  it("gets its own chip; Manual does not count it", () => {
    const manual = pos({ accountId: "btc" });
    const chips = groupFilterChips([short, manual]);
    expect(chips.map((c) => [c.key, c.count])).toEqual([["all", 2], ["synthetic", 1], ["manual", 1]]);
    expect(filterRows([short, manual], MANUAL_FILTER)).toEqual([manual]);
    expect(filterRows([short, manual], "synthetic")).toEqual([short]);
  });

  it("a grouped (bot) short stays its bot's: no Synthetic label, no hedge, still 'no stop'", () => {
    const botShort = { ...short, group: { id: "g1", name: "Fault-Line ETH 4h", source: "bot" as const } };
    const prot = deriveProtection(botShort, EMPTY_SOURCES);
    expect(managedBy(botShort, prot)).toBe("Fault-Line ETH 4h");
    expect(prot.syntheticHedge).toBeNull();
    expect(groupFilterChips([botShort]).map((c) => c.key)).toEqual(["all", "g1"]);
  });
});

// ETH floor hedge -12.356 and Fault Line +1.972 share one Deribit position of -10.384.
describe("netted venue legs", () => {
  const synthetic = { id: "syn-eth", triggerPrice: 2_471.24, firedPrice: 2_468.5, firedAt: null, shortUsd: 12_356, holdingsCoin: 5, holdingsUsd: 12_297 };
  const hedgeLeg = pos({ accountId: "eth", symbol: "ETH-PERPETUAL", side: "short", size: 12_356, synthetic, leg: { kind: "floor-hedge", venueNet: -10_384 } });
  const botLeg = pos({
    accountId: "eth",
    symbol: "ETH-PERPETUAL",
    size: 1_972,
    group: { id: "g1", name: "Fault Line ETH", source: "bot" },
    leg: { kind: "bots", venueNet: -10_384 },
  });

  it("no close, reduce or stop on either leg; only the bots' leg can move group", () => {
    const ctx = { isViewer: false, riding: false, hasPlan: false, canAccount: true };
    expect(rowActionIds(hedgeLeg, ctx)).toEqual([]);
    expect(rowActionIds(botLeg, ctx)).toEqual(["move"]);
  });

  it("shows the venue net under each leg, nothing on a whole position", () => {
    expect(venueNetLine(hedgeLeg)).toBe("venue net -10,384");
    expect(venueNetLine(botLeg)).toBe("venue net -10,384");
    expect(venueNetLine(pos())).toBeNull();
  });

  it("tags the hedge leg as floor hedge, a plain synthetic row stays synthetic", () => {
    expect(hedgeTag(hedgeLeg)).toBe("floor hedge");
    expect(hedgeTag(pos({ side: "short", synthetic }))).toBe("synthetic");
    expect(managedBy(botLeg, { ride: null, plan: null })).toBe("Fault Line ETH");
    expect(deriveProtection(hedgeLeg, EMPTY_SOURCES).syntheticHedge?.id).toBe("syn-eth");
    expect(deriveProtection(botLeg, EMPTY_SOURCES).syntheticHedge).toBeNull();
  });
});

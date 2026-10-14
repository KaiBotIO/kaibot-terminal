// Joins the protection sources the Positions page polls (trails, stop floors,
// entry brackets, rides, synthetic floors, hedge guards, accumulate plans)
// onto one position. Pure so the "what protects this row" rule is testable
// without the page.

import type { Position, PositionSyntheticInfo } from "@/lib/atoms";
import type { AccumulatePlan } from "@/lib/accumulate-api";
import type { HedgeGuardView } from "@/lib/hedge-api";
import type { ActiveRide, BracketStopView, ManagedTrailView, StopFloorView } from "@/lib/manual-trade-api";
import { fmtPrice } from "@/lib/portfolio-figures";
import type { SyntheticUsdPosition } from "@/lib/synthetic-usd-api";

/**
 * What stops THIS position. Precedence: the user's floor or stop, then the
 * managing bot's stop, else none. Account and plan floors are not in here.
 */
export interface PositionStop {
  kind: "manual" | "bot" | "none";
  /** "floor" = the user's floor under a bot; "stop" = the user's own stop on a manual position. */
  manualKind?: "floor" | "stop";
  /** Level shown in the chip; null on a ride whose stop is not placed yet. */
  price: number | null;
  /** A stop order rests at the venue. */
  onVenue: boolean;
  /** The bot's own stop under a manual floor. */
  botStop: number | null;
  /** The bot keeps moving its stop in the position's favour. */
  trails: boolean;
  locked: boolean;
  /** Ride bot the position was handed to. */
  rideBot: string | null;
}

/** A floor on the account's coin holdings: it never closes this position. */
export interface AccountFloor {
  kind: "coin" | "collateral";
  /** Trigger while armed, fill price once fired. */
  price: number | null;
  fired: boolean;
  error: string | null;
  /** Live accumulate plan the coin floor sits under. */
  planId: string | null;
  row: SyntheticUsdPosition;
}

export interface PositionProtection {
  stop: PositionStop;
  accountFloors: AccountFloor[];
  trail: ManagedTrailView | null;
  stopFloor: StopFloorView | null;
  bracket: BracketStopView | null;
  ride: ActiveRide | null;
  /** The position IS a synthetic USD short hedging coin holdings: no stop by design. */
  syntheticHedge: PositionSyntheticInfo | null;
  /** Its synthetic row, when the floors list has it. */
  syntheticRow: SyntheticUsdPosition | null;
  hedge: HedgeGuardView | null;
  plan: AccumulatePlan | null;
  /** Every live plan on the market (accumulate tranches). */
  tranches: AccumulatePlan[];
}

export interface ProtectionSources {
  trails: ManagedTrailView[];
  stopFloors: StopFloorView[];
  brackets: BracketStopView[];
  rides: ActiveRide[];
  floors: SyntheticUsdPosition[];
  hedges: HedgeGuardView[];
  plans: AccumulatePlan[];
}

export const EMPTY_SOURCES: ProtectionSources = {
  trails: [],
  stopFloors: [],
  brackets: [],
  rides: [],
  floors: [],
  hedges: [],
  plans: [],
};

type Coords = { exchange?: string | null; accountId?: string | null; symbol: string };

// A row without an account (legacy) belongs to the default connection only.
function sameAccount(rowAccount: string | null | undefined, posAccount: string | null | undefined): boolean {
  if (rowAccount && posAccount) return rowAccount === posAccount;
  return !(rowAccount || posAccount || "").includes("/");
}

export function onPosition(row: Coords, p: Coords): boolean {
  return (
    !!row.exchange &&
    !!p.exchange &&
    row.exchange.toLowerCase() === p.exchange.toLowerCase() &&
    row.symbol.toUpperCase() === p.symbol.toUpperCase() &&
    sameAccount(row.accountId, p.accountId)
  );
}

const floorCoords = (f: SyntheticUsdPosition): Coords => ({
  exchange: f.exchange,
  accountId: f.account_id,
  symbol: f.symbol,
});

const LIVE_PLAN = (p: AccumulatePlan) => p.phase !== "stopped" && p.phase !== "closed";
const LIVE_HEDGE = (h: HedgeGuardView) => h.status === "armed" || h.status === "hedged";

const NO_STOP: PositionStop = {
  kind: "none",
  price: null,
  onVenue: false,
  botStop: null,
  trails: false,
  locked: false,
  rideBot: null,
};

/** The stop that acts first on an adverse move: highest for a long, lowest for a short. */
export function bindingLevel(side: Position["side"], levels: Array<number | null | undefined>): number | null {
  const xs = levels.filter((n): n is number => n != null && Number.isFinite(n) && n > 0);
  if (xs.length === 0) return null;
  return side === "short" ? Math.min(...xs) : Math.max(...xs);
}

type RideRef = { positionId: string; botName: string | null; currentStop: number | null };

// The exit-state row that sets `level`, so its venue order decides "on venue".
const rowAt = (rows: StopFloorView[], level: number, pick: (f: StopFloorView) => number | null) =>
  rows.find((f) => pick(f) === level);

function stopOf(
  p: Position,
  trail: ManagedTrailView | null,
  stopFloors: StopFloorView[],
  brackets: BracketStopView[],
  ride: RideRef | null,
): PositionStop {
  if (ride) {
    // A ride is a server exit state: the user's floor on it lands there too.
    const own = stopFloors.find((f) => f.positionId === ride.positionId) ?? null;
    const rideBot = ride.botName ?? "ride bot";
    const botStop = ride.currentStop ?? own?.engineStop ?? null;
    const onVenue = own?.slOrderId != null;
    if (own?.manualStop != null) {
      return { ...NO_STOP, kind: "manual", manualKind: "floor", price: own.manualStop, onVenue, botStop, locked: own.trailingLock, rideBot };
    }
    return { ...NO_STOP, kind: "bot", price: botStop, onVenue, rideBot };
  }
  if (trail) {
    const onVenue = trail.slOrderId != null;
    const locked = trail.trailingLock;
    if (trail.source === "manual") {
      const price = trail.effectiveStop ?? trail.currentStop ?? trail.manualStop;
      if (price != null) return { ...NO_STOP, kind: "manual", manualKind: "stop", price, onVenue, trails: true, locked };
    } else if (trail.manualStop != null) {
      return { ...NO_STOP, kind: "manual", manualKind: "floor", price: trail.manualStop, onVenue, botStop: trail.engineStop, trails: true, locked };
    } else {
      const price = trail.effectiveStop ?? trail.currentStop;
      if (price != null) return { ...NO_STOP, kind: "bot", price, onVenue, trails: true, locked };
    }
  }
  if (stopFloors.length > 0) {
    const locked = stopFloors.some((f) => f.trailingLock);
    const botLevel = (f: StopFloorView) => f.engineStop ?? f.currentStop;
    const botStop = bindingLevel(p.side, stopFloors.map(botLevel));
    const manual = bindingLevel(p.side, stopFloors.map((f) => f.manualStop));
    if (manual != null) {
      const onVenue = rowAt(stopFloors, manual, (f) => f.manualStop)?.slOrderId != null;
      return { ...NO_STOP, kind: "manual", manualKind: "floor", price: manual, onVenue, botStop, trails: true, locked };
    }
    if (botStop != null) {
      const onVenue = rowAt(stopFloors, botStop, botLevel)?.slOrderId != null;
      return { ...NO_STOP, kind: "bot", price: botStop, onVenue, trails: true, locked };
    }
  }
  if (brackets.length > 0) {
    const price = bindingLevel(p.side, brackets.map((b) => b.stop))!;
    const onVenue = brackets.some((b) => b.stop === price && b.slOrderId != null);
    return brackets.every((b) => b.source === "manual")
      ? { ...NO_STOP, kind: "manual", manualKind: "stop", price, onVenue }
      : { ...NO_STOP, kind: "bot", price, onVenue };
  }
  return NO_STOP;
}

export function deriveProtection(p: Position, src: ProtectionSources): PositionProtection {
  const trail = src.trails.find((t) => t.active && onPosition(t, p)) ?? null;
  const stopFloors = src.stopFloors.filter((f) => f.active && onPosition(f, p));
  const brackets = src.brackets.filter((b) => onPosition(b, p));
  const ride = src.rides.find((r) => onPosition(r, p)) ?? null;
  // A grouped short belongs to its bot: only an ungrouped one reads as a hedge.
  const syntheticHedge = (!p.group && p.synthetic) || null;
  const syntheticRow = syntheticHedge ? (src.floors.find((f) => f.id === syntheticHedge.id) ?? null) : null;
  const hedge = src.hedges.find((h) => LIVE_HEDGE(h) && onPosition(h, p)) ?? null;
  const tranches = src.plans.filter((pl) => LIVE_PLAN(pl) && onPosition(pl, p));
  const plan = tranches[0] ?? null;

  const rideSrc: RideRef | null =
    ride ?? plan?.ride ?? (p.ride ? { positionId: p.ride.positionId, botName: p.ride.botName, currentStop: null } : null);
  const stop = syntheticHedge ? NO_STOP : stopOf(p, trail, stopFloors, brackets, rideSrc);

  // The plan's floor is the armed synthetic on its instrument (accumulate service, floorOf).
  const accountFloors: AccountFloor[] = src.floors
    .filter((f) => f.armed.inCycle && f.id !== syntheticHedge?.id && onPosition(floorCoords(f), p))
    .map((f) => {
      const fired = f.status === "open";
      return {
        kind: plan ? "coin" : "collateral",
        price: fired ? (f.armed.firedPrice ?? f.armed.triggerPrice) : f.armed.triggerPrice,
        fired,
        error: f.armed.lastError ?? null,
        planId: plan?.id ?? null,
        row: f,
      };
    });

  return {
    stop,
    accountFloors,
    trail,
    stopFloor: stopFloors[0] ?? null,
    bracket: brackets[0] ?? null,
    ride,
    syntheticHedge,
    syntheticRow,
    hedge,
    plan,
    tranches,
  };
}

/** Counts toward PROTECTED: a stop order actually rests at the venue. */
export const isProtected = (pr: PositionProtection) =>
  pr.stop.kind !== "none" && pr.stop.price != null && pr.stop.onVenue;

export function planPhaseWord(plan: AccumulatePlan): string {
  return plan.phase === "ladder" ? "laddering" : plan.phase === "waiting" ? "waiting" : plan.phase;
}

export const shortId = (id: string) => id.slice(0, 8);

/** "Plan 6fcc70de waiting" */
export const planLine = (plan: AccumulatePlan) => `Plan ${shortId(plan.id)} ${planPhaseWord(plan)}`;

// ── Labels and sentences (chip and detail share fmtPrice with ENTRY) ──

export function stopChipLabel(s: PositionStop): string {
  if (s.kind === "none") return "none";
  if (s.kind === "manual") return `manual ${s.manualKind ?? "floor"} ${fmtPrice(s.price)}${s.onVenue ? "" : " not on venue"}`;
  if (s.price == null) return "bot stop pending";
  return `bot stop ${fmtPrice(s.price)}${s.onVenue ? " on venue" : " not on venue"}`;
}

export function floorChipLabel(f: AccountFloor): string {
  return `${f.kind} floor ${fmtPrice(f.price)}${f.fired ? " fired" : ""}`;
}

export function floorTooltip(f: AccountFloor): string {
  return f.kind === "coin" && f.planId
    ? `Accumulate plan ${shortId(f.planId)}: sells the coin holdings below this price`
    : "Synthetic floor of the account";
}

export function stopSentence(s: PositionStop, side: Position["side"]): string {
  if (s.kind === "none") return "No stop on this position.";
  const offVenue = s.onVenue ? "" : " Nothing rests on the venue.";
  if (s.rideBot && s.kind === "bot") {
    return s.price == null
      ? `Handed to ${s.rideBot}. Its stop is not placed yet.`
      : `Handed to ${s.rideBot}. Ride stop ${fmtPrice(s.price)}.${offVenue}`;
  }
  const venue = s.onVenue ? " on the venue" : ", not on the venue";
  const trails = s.trails && !s.locked ? (side === "short" ? ", trails down" : ", trails up") : "";
  if (s.kind === "manual" && s.manualKind === "stop") return `Manual stop ${fmtPrice(s.price)}${venue}${trails}.`;
  if (s.kind === "manual") {
    const handed = s.rideBot ? `Handed to ${s.rideBot}. ` : "";
    const bot = s.rideBot ? "Ride stop" : "Bot stop";
    if (s.locked) {
      return `${handed}Manual floor ${fmtPrice(s.price)}, locked. The bot cannot move the stop until you unlock it.${offVenue}`;
    }
    const under = s.botStop != null && s.botStop !== s.price
      ? ` ${bot} ${fmtPrice(s.botStop)} ${s.price != null && s.botStop < s.price ? "below" : "above"} it.`
      : "";
    return `${handed}Manual floor ${fmtPrice(s.price)}.${under}${offVenue}`;
  }
  return `No manual floor. Bot stop ${fmtPrice(s.price)}${venue}${trails}.`;
}

export function floorSentence(f: AccountFloor): string {
  const name = f.kind === "coin" ? "Coin floor" : "Collateral floor";
  if (f.fired) return `${name} fired at ${fmtPrice(f.price)}.`;
  return f.kind === "coin"
    ? `${name} ${fmtPrice(f.price)}, armed, sells the coin holdings below it.`
    : `${name} ${fmtPrice(f.price)}, armed, covers the coin holdings.`;
}

/** Floors in an arm cycle that protect no listed position: coin holdings. */
export function holdingsFloors(floors: SyntheticUsdPosition[], rows: Position[]): SyntheticUsdPosition[] {
  return floors.filter(
    (f) => f.armed.inCycle && !(f.armed.coverManual && rows.some((p) => onPosition(floorCoords(f), p))),
  );
}

/** Live plans whose position is not on the list (closed, or not fetched). */
export function plansWithoutPosition(plans: AccumulatePlan[], rows: Position[]): AccumulatePlan[] {
  return plans.filter((pl) => LIVE_PLAN(pl) && !rows.some((p) => onPosition(pl, p)));
}

// ── Managed by + group filter ─────────────────────────────────────────

export const MANUAL_FILTER = "manual";
export const SYNTHETIC_FILTER = "synthetic";
export const ALL_FILTER = "all";

export function syntheticLabel(s: PositionSyntheticInfo): string {
  return s.triggerPrice != null
    ? `Synthetic USD · trigger ${Math.round(s.triggerPrice).toLocaleString("en-US")}`
    : "Synthetic USD";
}

export function managedBy(p: Position, prot: Pick<PositionProtection, "ride" | "plan">): string {
  if (p.ride || prot.ride) return p.ride?.botName ?? prot.ride?.botName ?? "ride bot";
  if (p.synthetic && !p.group) return syntheticLabel(p.synthetic);
  if (p.group) return p.group.name;
  if (prot.plan) return "accumulate plan";
  return "manual";
}

/** Managed-by cell: who, plus the live plan as a second line. A plan-only row names the plan once. */
export function managedByLines(p: Position, prot: Pick<PositionProtection, "ride" | "plan">): [string, string | null] {
  const who = managedBy(p, prot);
  if (!prot.plan) return [who, null];
  return who === "accumulate plan" ? [planLine(prot.plan), null] : [who, planLine(prot.plan)];
}

export interface GroupFilterChip {
  key: string;
  label: string;
  count: number;
}

const isSyntheticRow = (p: Position) => !p.group && !!p.synthetic;

/** All · one chip per group in list order · Synthetic · Manual (each only when it holds rows). */
export function groupFilterChips(rows: Position[]): GroupFilterChip[] {
  const byGroup = new Map<string, GroupFilterChip>();
  let manual = 0;
  let synthetic = 0;
  for (const p of rows) {
    if (isSyntheticRow(p)) {
      synthetic++;
      continue;
    }
    if (!p.group) {
      manual++;
      continue;
    }
    const chip = byGroup.get(p.group.id) ?? { key: p.group.id, label: p.group.name, count: 0 };
    chip.count++;
    byGroup.set(p.group.id, chip);
  }
  const chips = [{ key: ALL_FILTER, label: "All", count: rows.length }, ...byGroup.values()];
  if (synthetic > 0) chips.push({ key: SYNTHETIC_FILTER, label: "Synthetic", count: synthetic });
  if (manual > 0) chips.push({ key: MANUAL_FILTER, label: "Manual", count: manual });
  return chips;
}

export function filterRows(rows: Position[], key: string): Position[] {
  if (key === ALL_FILTER) return rows;
  if (key === SYNTHETIC_FILTER) return rows.filter(isSyntheticRow);
  if (key === MANUAL_FILTER) return rows.filter((p) => !p.group && !p.synthetic);
  return rows.filter((p) => p.group?.id === key);
}

/** A chip that vanished (its group emptied) falls back to All. */
export function activeFilter(chips: GroupFilterChip[], key: string): string {
  return chips.some((c) => c.key === key) ? key : ALL_FILTER;
}

// ── Row menu ──────────────────────────────────────────────────────────

export type RowActionId =
  | "manage-stop"
  | "hand-over"
  | "take-back"
  | "adopt"
  | "accumulate"
  | "roll"
  | "move"
  | "plan-check"
  | "plan-stop"
  | "reduce"
  | "close";

/** Menu entries for one row, in menu order. Viewers get none. */
export function rowActionIds(
  p: Position,
  ctx: { isViewer: boolean; riding: boolean; hasPlan: boolean; canAccount: boolean },
): RowActionId[] {
  if (ctx.isViewer) return [];
  const ids: RowActionId[] = ["manage-stop"];
  ids.push(ctx.riding ? "take-back" : "hand-over");
  if (!ctx.riding) ids.push("adopt");
  // Accumulate and group links key on the account.
  if (ctx.canAccount) ids.push("accumulate");
  if (p.expiry) ids.push("roll");
  if (ctx.canAccount) ids.push("move");
  if (ctx.hasPlan) ids.push("plan-check", "plan-stop");
  ids.push("reduce", "close");
  return ids;
}

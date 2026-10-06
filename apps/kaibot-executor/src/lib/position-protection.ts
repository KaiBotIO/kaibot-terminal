// Joins the protection sources the Positions page polls (trails, stop floors,
// rides, synthetic floors, hedge guards, accumulate plans) onto one position.
// Pure so the "which layer wins" rule is testable without the page.

import type { Position } from "@/lib/atoms";
import type { AccumulatePlan } from "@/lib/accumulate-api";
import type { HedgeGuardView } from "@/lib/hedge-api";
import type { ActiveRide, ManagedTrailView, StopFloorView } from "@/lib/manual-trade-api";
import type { SyntheticUsdPosition } from "@/lib/synthetic-usd-api";

export type ProtectionKind = "stop" | "ride" | "floor" | "hedge" | "plan";

export interface ProtectionLayer {
  kind: ProtectionKind;
  /** Price the layer acts at; null when it has none (a plan, a floor without a trigger). */
  level: number | null;
  /** Short state word next to the kind: "locked", "fired", "laddering", ... */
  note?: string;
  tone: "ok" | "warn" | "bad";
}

export interface PositionProtection {
  /** Protective layers, binding one first; the plan chip comes last. */
  layers: ProtectionLayer[];
  /** The layer that acts first on an adverse move: has a level, not in error. Null = unprotected. */
  primary: ProtectionLayer | null;
  trail: ManagedTrailView | null;
  stopFloor: StopFloorView | null;
  ride: ActiveRide | null;
  floor: SyntheticUsdPosition | null;
  /** In-cycle floor on the same instrument that covers only the coins. */
  holdingsFloor: SyntheticUsdPosition | null;
  hedge: HedgeGuardView | null;
  plan: AccumulatePlan | null;
}

export interface ProtectionSources {
  trails: ManagedTrailView[];
  stopFloors: StopFloorView[];
  rides: ActiveRide[];
  floors: SyntheticUsdPosition[];
  hedges: HedgeGuardView[];
  plans: AccumulatePlan[];
}

export const EMPTY_SOURCES: ProtectionSources = {
  trails: [],
  stopFloors: [],
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

const LIVE_PLAN = (p: AccumulatePlan) => p.phase !== "stopped";
const LIVE_HEDGE = (h: HedgeGuardView) => h.status === "armed" || h.status === "hedged";

// Tie-break when two layers act at the same price.
const KIND_ORDER: ProtectionKind[] = ["stop", "ride", "floor", "hedge"];

/**
 * The binding layer acts first on an adverse move: for a long the highest
 * level, for a short the lowest. Layers without a level rank after those with
 * one; ties go stop, ride, floor, hedge.
 */
export function rankLayers(side: Position["side"], layers: ProtectionLayer[]): ProtectionLayer[] {
  return [...layers].sort((a, b) => {
    if (a.level != null && b.level != null && a.level !== b.level) {
      return side === "short" ? a.level - b.level : b.level - a.level;
    }
    if ((a.level == null) !== (b.level == null)) return a.level == null ? 1 : -1;
    return KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
  });
}

export function deriveProtection(p: Position, src: ProtectionSources): PositionProtection {
  const trail = src.trails.find((t) => t.active && onPosition(t, p)) ?? null;
  const stopFloor = src.stopFloors.find((f) => f.active && onPosition(f, p)) ?? null;
  const ride = src.rides.find((r) => onPosition(r, p)) ?? null;
  const sameFloors = src.floors.filter((f) => f.armed.inCycle && onPosition(floorCoords(f), p));
  // A floor's short offsets a manual LONG; on a short it is not protection.
  const floor = p.side === "long" ? (sameFloors.find((f) => f.armed.coverManual) ?? null) : null;
  const holdingsFloor = sameFloors.find((f) => f !== floor) ?? null;
  const hedge = src.hedges.find((h) => LIVE_HEDGE(h) && onPosition(h, p)) ?? null;
  const plan = src.plans.find((pl) => LIVE_PLAN(pl) && onPosition(pl, p)) ?? null;

  const layers: ProtectionLayer[] = [];
  if (trail?.effectiveStop != null) {
    layers.push({ kind: "stop", level: trail.effectiveStop, note: trail.trailingLock ? "locked" : "trail", tone: "ok" });
  } else if (stopFloor && (stopFloor.effectiveStop ?? stopFloor.manualStop) != null) {
    layers.push({
      kind: "stop",
      level: (stopFloor.effectiveStop ?? stopFloor.manualStop)!,
      note: stopFloor.trailingLock ? "locked" : undefined,
      tone: "ok",
    });
  }
  const rideStop = ride?.currentStop ?? plan?.ride?.currentStop ?? null;
  if (ride || p.ride || plan?.ride) layers.push({ kind: "ride", level: rideStop, tone: rideStop == null ? "warn" : "ok" });
  if (floor) {
    const fired = floor.status === "open";
    layers.push({
      kind: "floor",
      level: fired ? (floor.armed.firedPrice ?? floor.armed.triggerPrice) : floor.armed.triggerPrice,
      note: fired ? "fired" : undefined,
      tone: floor.armed.lastError ? "bad" : fired ? "warn" : "ok",
    });
  }
  if (hedge) {
    layers.push({
      kind: "hedge",
      level: hedge.triggerPrice,
      note: hedge.status === "hedged" ? "open" : undefined,
      tone: hedge.lastError ? "bad" : hedge.status === "hedged" ? "warn" : "ok",
    });
  }
  const ranked = rankLayers(p.side, layers);
  if (plan) ranked.push({ kind: "plan", level: null, note: planPhaseWord(plan), tone: plan.lastError ? "bad" : "ok" });

  return {
    layers: ranked,
    // Fail closed: a layer without a level or in error protects nothing.
    primary: ranked.find((l) => l.kind !== "plan" && l.level != null && l.tone !== "bad") ?? null,
    trail,
    stopFloor,
    ride,
    floor,
    holdingsFloor,
    hedge,
    plan,
  };
}

export function planPhaseWord(plan: AccumulatePlan): string {
  return plan.phase === "ladder" ? "laddering" : plan.phase === "waiting" ? "waiting" : plan.phase;
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
export const ALL_FILTER = "all";

export function managedBy(p: Position, prot: Pick<PositionProtection, "ride" | "plan">): string {
  if (p.ride || prot.ride) return p.ride?.botName ?? prot.ride?.botName ?? "ride bot";
  if (p.group) return p.group.name;
  if (prot.plan) return "accumulate plan";
  return "manual";
}

export interface GroupFilterChip {
  key: string;
  label: string;
  count: number;
}

/** All · one chip per group in list order · Manual (only when it holds rows). */
export function groupFilterChips(rows: Position[]): GroupFilterChip[] {
  const byGroup = new Map<string, GroupFilterChip>();
  let manual = 0;
  for (const p of rows) {
    if (!p.group) {
      manual++;
      continue;
    }
    const chip = byGroup.get(p.group.id) ?? { key: p.group.id, label: p.group.name, count: 0 };
    chip.count++;
    byGroup.set(p.group.id, chip);
  }
  const chips = [{ key: ALL_FILTER, label: "All", count: rows.length }, ...byGroup.values()];
  if (manual > 0) chips.push({ key: MANUAL_FILTER, label: "Manual", count: manual });
  return chips;
}

export function filterRows(rows: Position[], key: string): Position[] {
  if (key === ALL_FILTER) return rows;
  if (key === MANUAL_FILTER) return rows.filter((p) => !p.group);
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

// Read-only projection of the ladder level a strategy engine persists in a run's
// scratch (ascender: `ascEngineState`, breakout-continuation: `bcEngineState`).
// Display only — nothing here feeds a decision.

export interface LadderLevel {
  side: "long" | "short";
  /** 1 = root entry, 2..n = upgrades through the parent timeframes. */
  level: number;
  /** Timeframe the position currently rides, e.g. '6m', '1H'. */
  tfLabel: string;
  entryBar: number;
  entryPrice: number;
  lastUpgradeBar: number | null;
}

/** Scratch keys carrying a ladder engine state, in read order. */
export const LADDER_SCRATCH_KEYS = ["ascEngineState", "bcEngineState"] as const;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function toLevel(side: "long" | "short", raw: unknown): LadderLevel | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const level = num(o.level);
  const tfLabel = typeof o.tfLabel === "string" ? o.tfLabel.trim() : "";
  if (level === null || level < 1 || tfLabel === "") return null;
  return {
    side,
    level,
    tfLabel,
    entryBar: num(o.entryBar) ?? 0,
    entryPrice: num(o.entryPrice) ?? 0,
    lastUpgradeBar: num(o.lastUpgradeBar),
  };
}

/**
 * Parse the engine state (JSON string as stored, or an already-decoded object)
 * into the open ladder levels. Anything unparseable or levelless yields [] —
 * a bot without a ladder simply has no badge.
 */
export function parseLadderLevels(raw: unknown): LadderLevel[] {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    if (raw.trim() === "") return [];
    try {
      obj = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!obj || typeof obj !== "object") return [];
  const o = obj as Record<string, unknown>;
  const levels: LadderLevel[] = [];
  const long = toLevel("long", o.longLevel);
  if (long) levels.push(long);
  const short = toLevel("short", o.shortLevel);
  if (short) levels.push(short);
  return levels;
}

/** Pull the ladder levels out of a full run state (`state.scratch.<key>`). */
export function ladderLevelsFromRunState(state: unknown): LadderLevel[] {
  if (!state || typeof state !== "object") return [];
  const scratch = (state as { scratch?: unknown }).scratch;
  if (!scratch || typeof scratch !== "object") return [];
  const s = scratch as Record<string, unknown>;
  for (const key of LADDER_SCRATCH_KEYS) {
    const levels = parseLadderLevels(s[key]);
    if (levels.length > 0) return levels;
  }
  return [];
}

export function ladderBadgeLabel(l: LadderLevel): string {
  return `${l.tfLabel} · L${l.level}${l.level > 1 ? " ↑" : ""}`;
}

/** Tooltip lines: what the badge itself does not already show. */
export function ladderTooltipLines(l: LadderLevel, rootTimeframe: string): string[] {
  const side = l.side === "long" ? "Long" : "Short";
  return [
    `${side} · L${l.level}, entered on ${rootTimeframe}`,
    l.lastUpgradeBar === null
      ? "No upgrade yet"
      : `Last upgrade at bar ${l.lastUpgradeBar}`,
  ];
}

// Badge colours for subscription statuses (Subscriptions) and per-bot run
// statuses (Analytics). One mapping so both pages read the same.

export type StrategyRunStatus = "running" | "paused" | "stopped" | "unknown";

export function statusVariant(status: string): "success" | "warning" | "neutral" {
  if (status === "active" || status === "running") return "success";
  if (status === "paused") return "warning";
  return "neutral";
}

export function statusColor(status: string): string {
  const v = statusVariant(status);
  if (v === "success") return "var(--kb-green)";
  if (v === "warning") return "var(--kb-amber)";
  return "hsl(var(--muted-foreground))";
}

export const isActiveRunStatus = (s: StrategyRunStatus | undefined): boolean => s === "running";

// Under "Active only": running bots, plus any bot that still holds an open position.
export const showsUnderActiveOnly = (c: { status?: StrategyRunStatus; openExecutions?: number }): boolean =>
  isActiveRunStatus(c.status) || (c.openExecutions ?? 0) > 0;

// Inactive rows sink below the active ones; the column sort applies within each tier.
export const runStatusTier = (s: StrategyRunStatus | undefined): number => (isActiveRunStatus(s) ? 0 : 1);

const ACTIVE_ONLY_KEY = "kaibot-executor-analytics-active-only";

export function readActiveOnly(): boolean {
  try {
    return localStorage.getItem(ACTIVE_ONLY_KEY) !== "0";
  } catch {
    return true;
  }
}

export function writeActiveOnly(on: boolean): void {
  try {
    localStorage.setItem(ACTIVE_ONLY_KEY, on ? "1" : "0");
  } catch {
    // private window / blocked storage: keep the in-memory value only
  }
}

// Why a signal ended the way it did, in one line for the feed row.
//
// The executor already writes a reason on every rejection, but the feed only
// showed the status, so "rejected" gave no clue whether a guardrail held it, a
// subscription was paused, or the venue refused the order. The account matters
// too: "max concurrent positions reached (1/1)" is a different story on an
// account that already runs a bot than on an empty one.

export type ClipReason =
  | "factor_applied"
  | "max_position_size"
  | "max_concurrent_positions"
  | "max_concurrent_trades"
  | "min_contract_size"
  | "step_size_round"
  | string;

export interface SafetyClip {
  reason: ClipReason;
  original_quantity?: number | null;
  adjusted_quantity?: number | null;
}

/**
 * One account's outcome of a signal that ran on several subscriptions of the
 * same bot (signals.account_outcomes, written by the executor's fan-out).
 */
export interface AccountOutcome {
  subscriptionId: string;
  accountId: string | null;
  accountKey: string | null;
  exchange: string | null;
  signalId: string;
  status: "executed" | "rejected" | "deferred" | "pending" | "skipped";
  orderId: string | null;
  reason: string | null;
  stopLossOrderId: string | null;
  takeProfitOrderId: string | null;
  fillPrice: number | null;
  fillTime: number | null;
}

export function parseAccountOutcomes(json: string | null | undefined): AccountOutcome[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as AccountOutcome[]) : [];
  } catch {
    return [];
  }
}

/** The account an outcome ran on, for display. */
export function outcomeAccount(o: AccountOutcome): string {
  return o.accountId ?? o.accountKey ?? o.subscriptionId;
}

/**
 * A rejection reason cut to what fits on a feed row: the part before the
 * first colon when that names the guard ("basis guard: signal 7779 vs venue
 * 7791 (15 bps > 10)" → "basis guard"), else the message itself, capped.
 */
export function shortReason(reason: string | null | undefined): string {
  const r = (reason ?? "").trim();
  if (!r) return "rejected";
  const head = r.split(":")[0].trim();
  if (head.length > 0 && head.length < r.length && head.length <= 28) return head;
  return r.length > 48 ? `${r.slice(0, 47)}…` : r;
}

/**
 * "3 accounts: 2 filled, 1 rejected (basis guard)" for a signal that fanned
 * out; null for a signal that ran on one account.
 */
export function accountOutcomeSummary(outcomes: AccountOutcome[]): string | null {
  if (outcomes.length < 2) return null;
  const count = (st: AccountOutcome["status"]) => outcomes.filter((o) => o.status === st).length;
  const parts: string[] = [];
  const filled = count("executed");
  if (filled > 0) parts.push(`${filled} filled`);
  const rejected = outcomes.filter((o) => o.status === "rejected");
  if (rejected.length > 0) {
    const reasons = [...new Set(rejected.map((o) => shortReason(o.reason)))].join(" / ");
    parts.push(`${rejected.length} rejected (${reasons})`);
  }
  const deferred = count("deferred");
  if (deferred > 0) parts.push(`${deferred} waiting for market open`);
  const pending = count("pending");
  if (pending > 0) parts.push(`${pending} pending`);
  const skipped = count("skipped");
  if (skipped > 0) parts.push(`${skipped} skipped`);
  return `${outcomes.length} accounts: ${parts.join(", ")}`;
}

export interface SignalReasonInput {
  status: string;
  errorMessage?: string | null;
  /** Broker account the execution landed on, when there is one. */
  accountId?: string | null;
  /** Per-account outcomes of a fan-out; two or more replace the account suffix. */
  accountOutcomes?: AccountOutcome[];
  clips?: SafetyClip[];
  /**
   * How many guardrail clips the signal took, for the feed row where the clip
   * detail is not loaded. Ignored when `clips` is given.
   */
  clipCount?: number;
}

/** Human label per guardrail that changed a quantity. */
export const CLIP_LABEL: Record<string, string> = {
  factor_applied: "factor",
  max_position_size: "max position size",
  max_concurrent_positions: "max concurrent positions",
  max_concurrent_trades: "max concurrent trades",
  min_contract_size: "min contract size",
  step_size_round: "step size",
};

export function clipLabel(reason: ClipReason): string {
  return CLIP_LABEL[reason] ?? reason.replace(/_/g, " ");
}

const num = (n: number | null | undefined): string | null =>
  typeof n === "number" && Number.isFinite(n)
    ? n.toLocaleString("en-US", { maximumFractionDigits: 8 })
    : null;

/** "100 → 1 (max position size)" for one clip. */
export function clipSummary(clip: SafetyClip): string {
  const from = num(clip.original_quantity);
  const to = num(clip.adjusted_quantity);
  const label = clipLabel(clip.reason);
  if (from == null || to == null) return label;
  return `${from} → ${to} (${label})`;
}

/**
 * The one line a feed row shows under its title. Null when the outcome speaks
 * for itself (a plain execution with nothing clipped).
 *
 * The account is appended only when the reason does not already name it, so a
 * message that carries its own account never says it twice.
 */
export function signalReason(input: SignalReasonInput): string | null {
  const message = (input.errorMessage ?? "").trim();
  const clips = input.clips ?? [];

  // A bot on several accounts: the per-account line IS the reason, and it
  // already names every account.
  const summary = accountOutcomeSummary(input.accountOutcomes ?? []);
  if (summary) {
    if (clips.length > 0) return `${summary} · ${clips.map(clipSummary).join(" · ")}`;
    return summary;
  }

  let base = message || null;
  if (!base && input.status === "pending") base = "waiting on the venue";
  if (!base && input.status === "deferred") base = "waiting for market open";
  if (!base && clips.length > 0) {
    base = clips.map(clipSummary).join(" · ");
  }
  if (!base && (input.clipCount ?? 0) > 0) {
    const n = input.clipCount!;
    base = `size clipped by ${n} guardrail${n === 1 ? "" : "s"}`;
  }
  if (!base) return null;

  const account = (input.accountId ?? "").trim();
  if (account && !base.includes(account)) return `${base} · account ${account}`;
  return base;
}

/** Tone for the row accent: a clipped execution is not an error. */
export function reasonTone(status: string): "error" | "warning" | "muted" {
  if (status === "rejected") return "error";
  if (status === "expired" || status === "pending" || status === "deferred") return "warning";
  return "muted";
}

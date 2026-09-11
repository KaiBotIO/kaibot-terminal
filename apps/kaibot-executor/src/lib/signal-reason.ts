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

export interface SignalReasonInput {
  status: string;
  errorMessage?: string | null;
  /** Broker account the execution landed on, when there is one. */
  accountId?: string | null;
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

  let base = message || null;
  if (!base && input.status === "pending") base = "waiting on the venue";
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
  if (status === "expired" || status === "pending") return "warning";
  return "muted";
}

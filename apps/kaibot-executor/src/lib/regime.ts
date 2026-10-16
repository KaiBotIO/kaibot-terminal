import { REGIME_LABEL_TEXT, type RegimeLabel, type RegimeMarket, type RegimeState } from "@kaibot/types/core";

// Regime label (C1, weekly) as the Terminal shows it: per subscription row and in the dashboard strip.

export interface SubRegimeView {
  market: RegimeMarket;
  label: RegimeLabel;
  since: string | null;
  phaseSince?: string | null;
  weekClosed: string | null;
  multiplier: number;
}

export interface RegimeFactorsView {
  notBull?: number;
  earlyBull?: number;
  lateBull?: number;
}

/** "2026-04-06" -> "06/04" in the current year, "10/11/2025" otherwise. */
export function fmtWeek(iso: string | null | undefined, year = new Date().getUTCFullYear()): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  if (!m) return null;
  return Number(m[1]) === year ? `${m[3]}/${m[2]}` : `${m[3]}/${m[2]}/${m[1]}`;
}

/** 1.5 -> "1,5" (European decimal comma). */
export function fmtFactor(n: number): string {
  return n.toLocaleString("nl-BE", { maximumFractionDigits: 2 });
}

/**
 * "late bull since 13/04 (bull since 06/04)" when the phase started later than the bull spell,
 * else "not bull since 10/11/2025"; just the label without a date.
 */
export function regimeText(
  label: RegimeLabel,
  since: string | null | undefined,
  phaseSince?: string | null,
  year?: number,
): string {
  if (label === "unknown") return REGIME_LABEL_TEXT[label];
  const spell = fmtWeek(since, year);
  const phase = fmtWeek(phaseSince, year);
  if (phase && spell && phase !== spell) return `${REGIME_LABEL_TEXT[label]} since ${phase} (bull since ${spell})`;
  const d = phase ?? spell;
  return d ? `${REGIME_LABEL_TEXT[label]} since ${d}` : REGIME_LABEL_TEXT[label];
}

/** "x1,5 late bull" when the sub has regime factors, null otherwise. */
export function multiplierText(regime: SubRegimeView | null, factors: RegimeFactorsView | null | undefined): string | null {
  if (!regime || !factors || Object.keys(factors).length === 0) return null;
  return `x${fmtFactor(regime.multiplier)} ${REGIME_LABEL_TEXT[regime.label]}`;
}

export function regimeColor(label: RegimeLabel): string {
  if (label === "late_bull") return "var(--kb-green)";
  if (label === "early_bull") return "var(--kb-teal)";
  if (label === "not_bull") return "var(--kb-red)";
  return "var(--muted-foreground)";
}

/** Groups in the dashboard strip; ALTS reads BTC and SPX backs MES/MNQ, so both stay out. */
export const STRIP_MARKETS: RegimeMarket[] = ["MNQ", "MES", "MGC", "BTC", "ETH"];

export function stripItems(markets: Partial<Record<RegimeMarket, RegimeState>> | null | undefined, year?: number) {
  return STRIP_MARKETS.filter((k) => markets?.[k]).map((k) => {
    const st = markets![k]!;
    return { market: k, label: st.label, text: `${k} ${regimeText(st.label, st.since, st.phaseSince, year)}` };
  });
}

export type RegimeKey = "notBull" | "earlyBull" | "lateBull";

export const REGIME_INPUTS: Array<[RegimeKey, string]> = [
  ["notBull", "Not bull"],
  ["earlyBull", "Early bull"],
  ["lateBull", "Late bull"],
];

// Empty inputs drop out; all empty = null (clears the factors).
export function parseRegimeInputs(v: Record<RegimeKey, string>): RegimeFactorsView | null | "invalid" {
  const out: RegimeFactorsView = {};
  for (const [key] of REGIME_INPUTS) {
    const raw = v[key].trim().replace(",", ".");
    if (raw === "") continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 10) return "invalid";
    out[key] = n;
  }
  return Object.keys(out).length > 0 ? out : null;
}

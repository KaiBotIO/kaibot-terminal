// Price + AI-usage config. Product prices are DERIVED from the tier catalogue
// (tiers.ts) so there is exactly one home for a price and the two can never
// drift. This file adds the usage-metering layer (per-token AI pricing, spend
// caps, prepaid credit packs). Keep it dependency-free so the Astro site can
// import it directly.

import { PRODUCT_CATALOGUE, type ProductKey } from './tiers';

export type { ProductKey };

export interface ProductPrice {
  key: ProductKey;
  name: string;
  /** Per-month price, EUR. */
  monthly: number;
  /** Discounted per-month price when billed yearly, EUR. */
  yearlyPerMonth: number;
  /** Total annual charge, EUR. */
  yearlyTotal: number;
  currency: 'EUR';
}

// Derived from the catalogue — the catalogue is the single price source.
export const PRODUCT_PRICING: Record<ProductKey, ProductPrice> = Object.fromEntries(
  (Object.keys(PRODUCT_CATALOGUE) as ProductKey[]).map((key) => {
    const p = PRODUCT_CATALOGUE[key];
    return [
      key,
      {
        key,
        name: p.name,
        monthly: p.monthly,
        yearlyPerMonth: p.yearlyPerMonth,
        yearlyTotal: p.yearlyTotal,
        currency: 'EUR' as const,
      },
    ];
  }),
) as Record<ProductKey, ProductPrice>;

/** "€10/mo" style label for a product's monthly price. */
export function monthlyPriceLabel(key: ProductKey): string {
  return `€${PRODUCT_PRICING[key].monthly}/mo`;
}

// --- Strategy AI tool pricing + caps (Deel C) ---
//
// Per-token price the running user pays for an in-strategy LLM call = provider
// cost × markup. All amounts in EUR micros (1e-6 EUR) so integer math stays
// exact. Tune these as provider prices move; kept here (dependency-free) so the
// billing router, the resolver, and the UI all read one source.

export const AI_USAGE_PRICING = {
  // Per 1M tokens, EUR micros. Standard ≈ a Haiku-class model; advanced ≈ an
  // Opus-class model. Includes markup over raw provider cost.
  standard: { inputPerMTokMicros: 1_500_000, outputPerMTokMicros: 8_000_000 },
  advanced: { inputPerMTokMicros: 12_000_000, outputPerMTokMicros: 60_000_000 },
  // Floor charged per call so tiny calls still cover overhead (EUR micros).
  minChargeMicros: 1_000, // €0.001
  // Flat per-call surcharge for live Grok/X research scans. xAI bills source
  // fees (~$25/1k sources) on top of tokens; those fees dominate the call cost
  // (~90%), so token-only metering systematically undercharges the live path.
  liveScanSurchargeMicros: 45_000, // €0.045
} as const;

export type AiModelClass = keyof Omit<
  typeof AI_USAGE_PRICING,
  'minChargeMicros' | 'liveScanSurchargeMicros'
>;

// Compute the EUR-micros charge for a resolved call.
export function aiUsageChargeMicros(
  modelClass: AiModelClass,
  inputTokens: number,
  outputTokens: number,
): number {
  const p = AI_USAGE_PRICING[modelClass];
  const raw = (inputTokens * p.inputPerMTokMicros + outputTokens * p.outputPerMTokMicros) / 1_000_000;
  return Math.max(AI_USAGE_PRICING.minChargeMicros, Math.ceil(raw));
}

// Charge for one live Grok/X research scan: standard token rate + the flat
// source-fee surcharge.
export function aiLiveScanChargeMicros(inputTokens: number, outputTokens: number): number {
  return (
    aiUsageChargeMicros('standard', inputTokens, outputTokens) +
    AI_USAGE_PRICING.liveScanSurchargeMicros
  );
}

// Non-monetary AI guardrails (shared by every tier). The per-user daily/monthly
// SPEND caps are now per-tier and live in TierEntitlements (aiDailyMicros /
// aiMonthlyMicros); evaluateAiGate reads them from the resolved tier. The
// values below are a conservative fallback used only when a caller has no
// resolved tier to hand.
export const AI_USAGE_CAPS = {
  maxRequestsPerBar: 2,
  maxPromptChars: 8_000,
  maxOutputTokensCap: 1_000,
  maxResponseStoredBytes: 16_384,
  // Fallback per-user rolling caps (EUR micros) — €5/day, €50/month.
  perUserDailyMicros: 5_000_000,
  perUserMonthlyMicros: 50_000_000,
  // How long a pending AI request may wait before it is expired to 'timeout'.
  pendingTimeoutMs: 90_000,
  // Keep at most this many response entries per run (prune oldest).
  maxRunEntries: 20,
} as const;

// Prepaid credit packs sold via one-off Stripe Checkout (EUR).
export interface AiCreditPack {
  key: string;
  label: string;
  eur: number;
  micros: number;
}
export const AI_CREDIT_PACKS: AiCreditPack[] = [
  { key: 'ai_credits_5', label: '€5 AI credits', eur: 5, micros: 5_000_000 },
  { key: 'ai_credits_20', label: '€20 AI credits', eur: 20, micros: 20_000_000 },
  { key: 'ai_credits_50', label: '€50 AI credits', eur: 50, micros: 50_000_000 },
];

/** "€1.23" style label from EUR micros. */
export function microsToEurLabel(micros: number): string {
  return `€${(micros / 1_000_000).toFixed(2)}`;
}

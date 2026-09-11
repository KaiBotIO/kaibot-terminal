import { describe, expect, test } from 'bun:test';
import { AI_USAGE_PRICING, aiUsageChargeMicros, aiLiveScanChargeMicros } from '../pricing';

describe('AI usage pricing', () => {
  // Margin guard (2026-07-24 pricing advisory): standard output must stay at
  // €8/Mtok — raw provider cost is ~€4.60/Mtok, €6 left too thin a markup.
  test('standard output rate is €8/Mtok', () => {
    expect(AI_USAGE_PRICING.standard.outputPerMTokMicros).toBe(8_000_000);
  });

  test('standard input rate is €1.5/Mtok', () => {
    expect(AI_USAGE_PRICING.standard.inputPerMTokMicros).toBe(1_500_000);
  });

  test('charge = tokens × per-Mtok rate', () => {
    // 1M in + 1M out at standard = €1.5 + €8 = €9.5
    expect(aiUsageChargeMicros('standard', 1_000_000, 1_000_000)).toBe(9_500_000);
    // Typical chat turn: 2k in + 300 out = 2k×1.5 + 300×8 per Mtok = 3000 + 2400
    expect(aiUsageChargeMicros('standard', 2_000, 300)).toBe(5_400);
  });

  test('tiny calls floor at minChargeMicros', () => {
    expect(aiUsageChargeMicros('standard', 1, 1)).toBe(AI_USAGE_PRICING.minChargeMicros);
  });

  test('advanced rates unchanged (€12/€60 per Mtok)', () => {
    expect(AI_USAGE_PRICING.advanced.inputPerMTokMicros).toBe(12_000_000);
    expect(AI_USAGE_PRICING.advanced.outputPerMTokMicros).toBe(60_000_000);
  });
});

describe('live scan charge (Grok/X research)', () => {
  // xAI source fees (~$25/1k sources) dominate a live scan's cost; token-only
  // metering undercharged the Live Intel path (2026-07-24 pricing advisory).
  test('flat source-fee surcharge is €0.045', () => {
    expect(AI_USAGE_PRICING.liveScanSurchargeMicros).toBe(45_000);
  });

  test('charge = standard token charge + surcharge', () => {
    expect(aiLiveScanChargeMicros(2_000, 1_000)).toBe(
      aiUsageChargeMicros('standard', 2_000, 1_000) + 45_000,
    );
  });

  test('typical scan bills ~€0.05', () => {
    // ~500 tokens prompt, ~1000 tokens answer → 750 + 8000 + 45000 micros
    const charged = aiLiveScanChargeMicros(500, 1_000);
    expect(charged).toBeGreaterThanOrEqual(45_000);
    expect(charged).toBeLessThanOrEqual(60_000);
  });

  test('even an empty answer still carries the surcharge', () => {
    expect(aiLiveScanChargeMicros(1, 0)).toBe(AI_USAGE_PRICING.minChargeMicros + 45_000);
  });
});

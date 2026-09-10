import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

// RG2 lock — the 4 legal disclosure texts in disclosures.ts must stay rendered
// on their surfaces. The frontend has no component-test infra, so this asserts
// the wiring at the import level: if a future refactor drops one of these
// imports (unwiring the disclosure), this test goes red.
const ROOT = join(import.meta.dir, "..", "..", "..", "..");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

const SURFACES: Array<{ file: string; mustContain: string[] }> = [
  {
    // ToS / risk acceptance flow.
    file: "apps/frontend/src/components/TermsAcceptanceGate.tsx",
    mustContain: ["POSITIONING", "DISCLAIMER"],
  },
  {
    // Mobile counterpart of the acceptance gate.
    file: "apps/mobile/components/ConsentGate.tsx",
    mustContain: ["POSITIONING", "DISCLAIMER", "TERMS_VERSION"],
  },
  {
    // KAI output surface: standing not-advice line under the input.
    file: "apps/frontend/src/components/kai/KAIChatShell.tsx",
    mustContain: ["DISCLAIMER.notAdvice"],
  },
  {
    // Marketplace listing (MAR recommendation disclosure + buyer AI-cost line).
    file: "apps/frontend/src/components/RecommendationDisclosure.tsx",
    mustContain: ["RECOMMENDATION_DISCLOSURE", "AI_STRATEGY_DISCLOSURE.buyer"],
  },
  {
    file: "apps/frontend/src/pages/(authenticated)/marketplace/[id]/page.tsx",
    mustContain: ["RecommendationDisclosure"],
  },
  {
    // AI-strategy go-live dialog.
    file: "apps/frontend/src/components/strategies/RunLiveAsBotDialog.tsx",
    mustContain: ["AI_STRATEGY_DISCLOSURE.cost", "AI_STRATEGY_DISCLOSURE.nondeterministic"],
  },
  {
    // AI-strategy creation surface (strategy agent).
    file: "apps/frontend/src/components/strategies/StrategyAgentChat.tsx",
    mustContain: ["AI_STRATEGY_DISCLOSURE"],
  },
];

describe("disclosures stay wired into their surfaces (RG2)", () => {
  for (const { file, mustContain } of SURFACES) {
    it(file, () => {
      const src = read(file);
      for (const needle of mustContain) {
        expect(src).toContain(needle);
      }
    });
  }
});

import { describe, expect, it } from "bun:test";
import { fmtFactor, fmtWeek, multiplierText, parseRegimeInputs, regimeText, stripItems } from "./regime";

const st = (label: any, since: string | null, phaseSince = since) => ({ label, since, phaseSince, weekClosed: "2026-10-05", close: 1, sma40: 1, sma40_4ago: 1 });

describe("regime display", () => {
  it("dates and factors in European notation", () => {
    expect(fmtWeek("2026-04-06", 2026)).toBe("06/04");
    expect(fmtWeek("2025-11-10", 2026)).toBe("10/11/2025");
    expect(fmtWeek(null)).toBeNull();
    expect(fmtFactor(1.5)).toBe("1,5");
    expect(fmtFactor(2)).toBe("2");
  });

  it("badge text", () => {
    expect(regimeText("late_bull", "2026-04-06", "2026-04-13", 2026)).toBe("late bull since 13/04 (bull since 06/04)");
    expect(regimeText("early_bull", "2026-04-06", "2026-04-06", 2026)).toBe("early bull since 06/04");
    expect(regimeText("not_bull", "2026-08-24", undefined, 2026)).toBe("not bull since 24/08");
    expect(regimeText("not_bull", "2025-11-10", "2025-11-10", 2026)).toBe("not bull since 10/11/2025");
    expect(regimeText("unknown", "2026-08-24")).toBe("unknown");
  });

  it("multiplier chip only with factors set", () => {
    const r = { market: "MNQ" as const, label: "late_bull" as const, since: "2026-04-06", weekClosed: null, multiplier: 1.5 };
    expect(multiplierText(r, { lateBull: 1.5 })).toBe("x1,5 late bull");
    expect(multiplierText({ ...r, label: "early_bull", multiplier: 1 }, { lateBull: 1.5 })).toBe("x1 early bull");
    expect(multiplierText(r, null)).toBeNull();
    expect(multiplierText(r, {})).toBeNull();
    expect(multiplierText(null, { lateBull: 1.5 })).toBeNull();
  });

  it("strip lists the groups the API returned, in a fixed order", () => {
    const items = stripItems(
      { BTC: st("not_bull", "2025-11-10"), MGC: st("not_bull", "2026-08-24"), MNQ: st("late_bull", "2026-04-06", "2026-04-13"), ALTS: st("not_bull", "2025-11-10") },
      2026,
    );
    expect(items.map((i) => i.text)).toEqual([
      "MNQ late bull since 13/04 (bull since 06/04)",
      "MGC not bull since 24/08",
      "BTC not bull since 10/11/2025",
    ]);
    expect(stripItems(null)).toEqual([]);
  });
});

describe("parseRegimeInputs", () => {
  it("empty = clear, comma decimals, range 0..10", () => {
    expect(parseRegimeInputs({ notBull: "", earlyBull: "", lateBull: "" })).toBeNull();
    expect(parseRegimeInputs({ notBull: "0", earlyBull: "", lateBull: "1,5" })).toEqual({ notBull: 0, lateBull: 1.5 });
    expect(parseRegimeInputs({ notBull: "-1", earlyBull: "", lateBull: "" })).toBe("invalid");
    expect(parseRegimeInputs({ notBull: "", earlyBull: "11", lateBull: "" })).toBe("invalid");
  });
});

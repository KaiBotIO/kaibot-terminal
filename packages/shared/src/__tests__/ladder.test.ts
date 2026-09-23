import { describe, expect, test } from "bun:test";
import {
  ladderBadgeLabel,
  ladderLevelsFromRunState,
  ladderTooltipLines,
  parseLadderLevels,
  type LadderLevel,
} from "../lib/ladder";

const LONG = {
  level: 3,
  tfLabel: "60m",
  entryBar: 120,
  entryPrice: 3412.5,
  lastUpgradeBar: 412,
};

describe("parseLadderLevels", () => {
  test("reads a long level out of the engine-state JSON string", () => {
    const levels = parseLadderLevels(
      JSON.stringify({ longLevel: LONG, shortLevel: null }),
    );
    expect(levels).toEqual([
      {
        side: "long",
        level: 3,
        tfLabel: "60m",
        entryBar: 120,
        entryPrice: 3412.5,
        lastUpgradeBar: 412,
      },
    ]);
  });

  test("accepts an already-decoded object", () => {
    expect(parseLadderLevels({ shortLevel: { ...LONG, level: 1 } })).toHaveLength(1);
    expect(parseLadderLevels({ shortLevel: { ...LONG, level: 1 } })[0]!.side).toBe(
      "short",
    );
  });

  test("returns both sides when both are open", () => {
    const levels = parseLadderLevels({ longLevel: LONG, shortLevel: LONG });
    expect(levels.map((l) => l.side)).toEqual(["long", "short"]);
  });

  test("defaults the optional numbers instead of dropping the level", () => {
    const [l] = parseLadderLevels({ longLevel: { level: 1, tfLabel: "6m" } });
    expect(l).toEqual({
      side: "long",
      level: 1,
      tfLabel: "6m",
      entryBar: 0,
      entryPrice: 0,
      lastUpgradeBar: null,
    });
  });

  test.each([
    ["null", null],
    ["undefined", undefined],
    ["empty string", ""],
    ["broken json", "{not json"],
    ["a number", 42],
    ["state without levels", { longLevel: null, shortLevel: null }],
    ["a level without tfLabel", { longLevel: { level: 2 } }],
    ["a level with an empty tfLabel", { longLevel: { level: 2, tfLabel: "  " } }],
    ["a level below 1", { longLevel: { level: 0, tfLabel: "6m" } }],
    ["a non-numeric level", { longLevel: { level: "3", tfLabel: "6m" } }],
  ])("yields no levels for %s", (_label, input) => {
    expect(parseLadderLevels(input)).toEqual([]);
  });
});

describe("ladderLevelsFromRunState", () => {
  test("reads the ascender scratch key", () => {
    const state = { scratch: { ascEngineState: JSON.stringify({ longLevel: LONG }) } };
    expect(ladderLevelsFromRunState(state)).toHaveLength(1);
  });

  test("falls back to the breakout-continuation scratch key", () => {
    const state = { scratch: { bcEngineState: JSON.stringify({ shortLevel: LONG }) } };
    expect(ladderLevelsFromRunState(state)[0]!.side).toBe("short");
  });

  test.each([
    ["no state", null],
    ["no scratch", {}],
    ["scratch without a ladder key", { scratch: { rootMinutes: 60 } }],
    ["a flat ladder state", { scratch: { ascEngineState: '{"longLevel":null}' } }],
  ])("yields no levels for %s", (_label, input) => {
    expect(ladderLevelsFromRunState(input)).toEqual([]);
  });
});

describe("badge text", () => {
  const level = (over: Partial<LadderLevel> = {}): LadderLevel => ({
    side: "long",
    level: 1,
    tfLabel: "6m",
    entryBar: 0,
    entryPrice: 0,
    lastUpgradeBar: null,
    ...over,
  });

  test("marks an upgraded level", () => {
    expect(ladderBadgeLabel(level())).toBe("6m · L1");
    expect(ladderBadgeLabel(level({ level: 3, tfLabel: "60m" }))).toBe("60m · L3 ↑");
  });

  test("tooltip carries side, entry timeframe and last upgrade", () => {
    expect(ladderTooltipLines(level({ level: 3, lastUpgradeBar: 412 }), "6m")).toEqual([
      "Long · L3, entered on 6m",
      "Last upgrade at bar 412",
    ]);
    expect(ladderTooltipLines(level({ side: "short" }), "1h")).toEqual([
      "Short · L1, entered on 1h",
      "No upgrade yet",
    ]);
  });
});

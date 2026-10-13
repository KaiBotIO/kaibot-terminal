import { afterEach, describe, expect, it } from "bun:test";
import { readActiveOnly, runStatusTier, showsUnderActiveOnly, statusVariant, writeActiveOnly } from "./bot-status";

const g = globalThis as { localStorage?: unknown };
const original = g.localStorage;
afterEach(() => {
  g.localStorage = original;
});

describe("statusVariant", () => {
  it("shares the Subscriptions colours", () => {
    expect(statusVariant("active")).toBe("success");
    expect(statusVariant("running")).toBe("success");
    expect(statusVariant("paused")).toBe("warning");
    expect(statusVariant("stopped")).toBe("neutral");
    expect(statusVariant("unknown")).toBe("neutral");
    expect(statusVariant("cancelled")).toBe("neutral");
  });
});

describe("runStatusTier", () => {
  it("puts running first, everything else below", () => {
    expect(runStatusTier("running")).toBe(0);
    for (const s of ["paused", "stopped", "unknown", undefined] as const) expect(runStatusTier(s)).toBe(1);
  });
});

describe("showsUnderActiveOnly", () => {
  it("keeps running bots and any bot with an open position", () => {
    expect(showsUnderActiveOnly({ status: "running" })).toBe(true);
    expect(showsUnderActiveOnly({ status: "stopped", openExecutions: 1 })).toBe(true);
    expect(showsUnderActiveOnly({ status: "paused", openExecutions: 0 })).toBe(false);
    expect(showsUnderActiveOnly({ status: "unknown" })).toBe(false);
  });
});

describe("active-only preference", () => {
  it("defaults on and persists off", () => {
    const store = new Map<string, string>();
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    expect(readActiveOnly()).toBe(true);
    writeActiveOnly(false);
    expect(readActiveOnly()).toBe(false);
    writeActiveOnly(true);
    expect(readActiveOnly()).toBe(true);
  });

  it("survives a throwing storage", () => {
    g.localStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readActiveOnly()).toBe(true);
    expect(() => writeActiveOnly(false)).not.toThrow();
  });
});

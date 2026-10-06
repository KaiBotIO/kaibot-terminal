import { describe, expect, it } from "bun:test";
import { equalSizes, weightedSizes } from "./rung-presets";

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

describe("equalSizes", () => {
  it("splits evenly and sums to the exact total", () => {
    expect(equalSizes(10, 4)).toEqual([2.5, 2.5, 2.5, 2.5]);
    // Non-dividing total: last rung sweeps the remainder.
    const sizes = equalSizes(10, 3);
    expect(sizes).toHaveLength(3);
    expect(sum(sizes)).toBeCloseTo(10, 10);
    expect(sizes[0]).toBe(sizes[1]);
  });

  it("returns empty on invalid input", () => {
    expect(equalSizes(0, 3)).toEqual([]);
    expect(equalSizes(10, 0)).toEqual([]);
    expect(equalSizes(-5, 2)).toEqual([]);
    expect(equalSizes(10, 2.5)).toEqual([]);
  });
});

describe("weightedSizes", () => {
  it("sums to the exact total", () => {
    for (const [total, count] of [
      [10, 3],
      [1, 5],
      [0.0007, 4],
      [123.456789, 7],
    ] as const) {
      const sizes = weightedSizes(total, count);
      expect(sizes).toHaveLength(count);
      expect(sum(sizes)).toBeCloseTo(total, 8);
    }
  });

  it("allocates strictly more size to deeper rungs", () => {
    const sizes = weightedSizes(12, 4);
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i]).toBeGreaterThan(sizes[i - 1]);
    }
    // Linear 1..4 over weight sum 10.
    expect(sizes).toEqual([1.2, 2.4, 3.6, 4.8]);
  });

  it("degenerates to the full size on a single rung", () => {
    expect(weightedSizes(3.5, 1)).toEqual([3.5]);
  });

  it("returns empty on invalid input", () => {
    expect(weightedSizes(0, 3)).toEqual([]);
    expect(weightedSizes(10, -1)).toEqual([]);
  });
});

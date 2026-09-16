import { describe, expect, it } from "bun:test";
import { hasRealized } from "./Activity";

// Regression (live-data-review 28/08): `qty_closed` comes from the executions
// table and is set on close even when no exit fill was ever booked, so a close
// without a price rendered as a green "+$0.00": the MNQ close that was really
// worth about -$428 read as break-even.
describe("hasRealized", () => {
  it("is false for a close with no priced exit fill", () => {
    expect(hasRealized({ qtyClosed: 1, exitAvg: null })).toBe(false);
  });

  it("is true once an exit price exists", () => {
    expect(hasRealized({ qtyClosed: 1, exitAvg: 29_214.5 })).toBe(true);
  });

  it("is false while nothing is closed", () => {
    expect(hasRealized({ qtyClosed: 0, exitAvg: null })).toBe(false);
    expect(hasRealized({ qtyClosed: 0, exitAvg: 29_214.5 })).toBe(false);
  });
});

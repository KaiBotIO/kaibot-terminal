import { describe, expect, it } from "bun:test";
import { clipSummary, reasonTone, signalReason } from "./signal-reason";

// Kai, 2026-09-07: a rejected signal row said "rejected" and nothing else, so
// the reason the executor had already recorded never reached the screen.
describe("signalReason", () => {
  it("states a guardrail rejection with the account it happened on", () => {
    expect(
      signalReason({
        status: "rejected",
        errorMessage: "max concurrent positions reached (1/1)",
        accountId: "21084931",
      }),
    ).toBe("max concurrent positions reached (1/1) · account 21084931");
  });

  it("does not repeat an account the message already names", () => {
    expect(
      signalReason({
        status: "rejected",
        errorMessage: "margin guard blocked the open on 21084931",
        accountId: "21084931",
      }),
    ).toBe("margin guard blocked the open on 21084931");
  });

  it("carries a replay expiry through unchanged", () => {
    expect(signalReason({ status: "expired", errorMessage: "stale on replay" })).toBe(
      "stale on replay",
    );
  });

  it("carries a venue error through", () => {
    expect(
      signalReason({
        status: "rejected",
        errorMessage: "Stop-loss placement failed (Max 8 decimal places supported for 'StopPrice')",
        accountId: "21084933",
      }),
    ).toBe(
      "Stop-loss placement failed (Max 8 decimal places supported for 'StopPrice') · account 21084933",
    );
  });

  it("says nothing for a clean execution", () => {
    expect(signalReason({ status: "executed", accountId: "21084933" })).toBeNull();
  });

  it("reports the guardrail clips of an execution that went through", () => {
    expect(
      signalReason({
        status: "executed",
        accountId: "21084931",
        clips: [
          { reason: "factor_applied", original_quantity: 100, adjusted_quantity: 1 },
          { reason: "max_position_size", original_quantity: 1, adjusted_quantity: 1 },
        ],
      }),
    ).toBe("100 → 1 (factor) · 1 → 1 (max position size) · account 21084931");
  });

  it("prefers the recorded message over the clips", () => {
    expect(
      signalReason({
        status: "rejected",
        errorMessage: "subscription paused",
        clips: [{ reason: "factor_applied", original_quantity: 100, adjusted_quantity: 0 }],
      }),
    ).toBe("subscription paused");
  });

  it("explains a pending signal that has no message yet", () => {
    expect(signalReason({ status: "pending" })).toBe("waiting on the venue");
  });

  it("ignores a blank message", () => {
    expect(signalReason({ status: "executed", errorMessage: "   " })).toBeNull();
  });
});

describe("signalReason from a clip count alone", () => {
  it("says the size was clipped when the feed has no clip detail", () => {
    expect(signalReason({ status: "executed", clipCount: 2, accountId: "21084931" })).toBe(
      "size clipped by 2 guardrails · account 21084931",
    );
    expect(signalReason({ status: "executed", clipCount: 1 })).toBe(
      "size clipped by 1 guardrail",
    );
  });

  it("prefers the loaded clip detail over the count", () => {
    expect(
      signalReason({
        status: "executed",
        clipCount: 9,
        clips: [{ reason: "factor_applied", original_quantity: 100, adjusted_quantity: 1 }],
      }),
    ).toBe("100 → 1 (factor)");
  });
});

describe("clipSummary", () => {
  it("shows the quantity before and after", () => {
    expect(clipSummary({ reason: "factor_applied", original_quantity: 100, adjusted_quantity: 1 })).toBe(
      "100 → 1 (factor)",
    );
  });

  it("falls back to the label when a quantity is missing", () => {
    expect(clipSummary({ reason: "step_size_round", original_quantity: null, adjusted_quantity: 2 })).toBe(
      "step size",
    );
  });

  it("humanises an unknown reason instead of printing the raw key", () => {
    expect(clipSummary({ reason: "some_new_guard" })).toBe("some new guard");
  });
});

describe("reasonTone", () => {
  it("separates a rejection from a delay from a clip", () => {
    expect(reasonTone("rejected")).toBe("error");
    expect(reasonTone("expired")).toBe("warning");
    expect(reasonTone("pending")).toBe("warning");
    expect(reasonTone("executed")).toBe("muted");
  });
});

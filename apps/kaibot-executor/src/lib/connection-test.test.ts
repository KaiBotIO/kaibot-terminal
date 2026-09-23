import { describe, expect, it } from "bun:test";
import { interpretConnectionTest } from "./connection-test";

describe("interpretConnectionTest", () => {
  it("is ok when the server reports success", () => {
    expect(interpretConnectionTest({ success: true, message: "Connection successful" })).toEqual({
      ok: true,
    });
  });

  // Regression (delta review 2026-07-08): a 200 with { success: false } used to
  // fall through the Connect button with no toast at all. It must surface the
  // server's message instead of silently doing nothing.
  it("surfaces the server message on a 200 with success:false", () => {
    expect(interpretConnectionTest({ success: false, error: "Invalid API key" })).toEqual({
      ok: false,
      message: "Invalid API key",
    });
  });

  it("falls back to a generic message when none is given", () => {
    expect(interpretConnectionTest({ success: false })).toEqual({
      ok: false,
      message: "Connection test failed",
    });
    expect(interpretConnectionTest(undefined)).toEqual({
      ok: false,
      message: "Connection test failed",
    });
  });
});

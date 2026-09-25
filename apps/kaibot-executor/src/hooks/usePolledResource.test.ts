import { describe, expect, it } from "bun:test";
import {
  initialPolledState,
  pollReducer,
  type PolledState,
} from "./usePolledResource";

describe("pollReducer", () => {
  it("first load failure sets error, no data", () => {
    let state = initialPolledState<string>();
    state = pollReducer(state, { type: "start" });
    state = pollReducer(state, { type: "failure", error: new Error("down") });

    expect(state.data).toBeNull();
    expect(state.error?.message).toBe("down");
    expect(state.isStale).toBe(false);
    expect(state.isLoading).toBe(false);
  });

  it("success stores data and clears error/stale", () => {
    let state: PolledState<string> = {
      data: null,
      error: new Error("down"),
      isStale: false,
      lastUpdated: null,
      isLoading: true,
    };
    state = pollReducer(state, { type: "success", data: "payload", at: 123 });

    expect(state.data).toBe("payload");
    expect(state.error).toBeNull();
    expect(state.isStale).toBe(false);
    expect(state.lastUpdated).toBe(123);
    expect(state.isLoading).toBe(false);
  });

  it("failed poll after success keeps last data and marks it stale", () => {
    let state = initialPolledState<string[]>();
    state = pollReducer(state, {
      type: "success",
      data: ["BTC-long"],
      at: 100,
    });
    state = pollReducer(state, { type: "start" });
    state = pollReducer(state, { type: "failure", error: new Error("down") });

    expect(state.data).toEqual(["BTC-long"]);
    expect(state.error).toBeNull();
    expect(state.isStale).toBe(true);
    expect(state.lastUpdated).toBe(100);
    expect(state.isLoading).toBe(false);
  });

  it("recovery after stale clears the stale flag", () => {
    let state = initialPolledState<number>();
    state = pollReducer(state, { type: "success", data: 1, at: 100 });
    state = pollReducer(state, { type: "failure", error: new Error("down") });
    state = pollReducer(state, { type: "success", data: 2, at: 200 });

    expect(state.data).toBe(2);
    expect(state.isStale).toBe(false);
    expect(state.lastUpdated).toBe(200);
  });
});

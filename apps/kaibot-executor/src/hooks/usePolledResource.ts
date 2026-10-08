import { useCallback, useEffect, useRef, useState } from "react";

export interface PolledState<T> {
  data: T | null;
  /** Only set when there is no data at all (first load failed). */
  error: Error | null;
  /** True when the last poll failed but we still show the last good payload. */
  isStale: boolean;
  lastUpdated: number | null;
  isLoading: boolean;
}

export type PollEvent<T> =
  | { type: "start" }
  | { type: "success"; data: T; at: number }
  | { type: "failure"; error: Error };

export function initialPolledState<T>(): PolledState<T> {
  return {
    data: null,
    error: null,
    isStale: false,
    lastUpdated: null,
    isLoading: true,
  };
}

// Pure state transition — a failed poll never clears data, it only marks it stale.
export function pollReducer<T>(
  state: PolledState<T>,
  event: PollEvent<T>,
): PolledState<T> {
  switch (event.type) {
    case "start":
      return { ...state, isLoading: true };
    case "success":
      return {
        data: event.data,
        error: null,
        isStale: false,
        lastUpdated: event.at,
        isLoading: false,
      };
    case "failure":
      return state.data !== null
        ? { ...state, isStale: true, isLoading: false }
        : { ...state, error: event.error, isLoading: false };
  }
}

export interface UsePolledResourceOptions {
  intervalMs: number;
  enabled?: boolean;
}

export function usePolledResource<T>(
  fetcher: () => Promise<T>,
  { intervalMs, enabled = true }: UsePolledResourceOptions,
) {
  const [state, setState] = useState<PolledState<T>>(initialPolledState<T>());
  // Latest fetcher without resetting the interval on identity changes.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const refresh = useCallback(async () => {
    setState((s) => pollReducer(s, { type: "start" }));
    try {
      const data = await fetcherRef.current();
      setState((s) =>
        pollReducer(s, { type: "success", data, at: Date.now() }),
      );
    } catch (err) {
      setState((s) =>
        pollReducer(s, {
          type: "failure",
          error: err instanceof Error ? err : new Error(String(err)),
        }),
      );
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    refresh();
    const interval = setInterval(refresh, intervalMs);
    return () => clearInterval(interval);
  }, [refresh, intervalMs, enabled]);

  return { ...state, refresh };
}

import { useEffect, useRef } from "react";
import { apiFetch } from "@/lib/api";
import { usePolledResource } from "@/hooks/usePolledResource";

// A point with `equity: null` is a gap: the poller tick missed a connected
// session (token outage, maintenance) and the curve must not dip to whatever
// fraction of the book did answer.
export interface EquityPoint {
  date: string;
  equity: number | null;
  pnl: number | null;
  unrealizedPnL: number | null;
  /** True when some wallet had no USD mark, so the point is a floor. */
  incomplete?: boolean;
  gap?: boolean;
}

export type EquityRange = "1W" | "1M" | "3M" | "1Y" | "ALL";

// Polled equity-history series for the given range (Dashboard + Portfolio).
export function useEquityHistory(range: EquityRange) {
  const { data, error, isStale, isLoading, refresh } = usePolledResource<
    EquityPoint[]
  >(
    async () => {
      const res = await apiFetch(
        `/api/performance/equity-history?range=${range}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      return json.series || [];
    },
    { intervalMs: 30000 },
  );

  // Refetch immediately when the range changes (skip the mount fetch the
  // hook already does).
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    refresh();
  }, [range, refresh]);

  return { equityData: data ?? [], error, isStale, isLoading, refresh };
}

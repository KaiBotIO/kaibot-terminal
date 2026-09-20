import { useEffect, useRef } from "react";
import { apiFetch } from "@/lib/api";
import { usePolledResource } from "@/hooks/usePolledResource";

export interface EquityPoint {
  date: string;
  equity: number;
  pnl: number;
  unrealizedPnL: number;
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

import { Badge } from "@kaibot/shared";
import type { RegimeApiResponse } from "@kaibot/types/core";
import { apiFetch } from "@/lib/api";
import { usePolledResource } from "@/hooks/usePolledResource";
import {
  fmtWeek,
  multiplierText,
  regimeColor,
  regimeText,
  stripItems,
  type RegimeFactorsView,
  type SubRegimeView,
} from "@/lib/regime";

async function fetchRegime(): Promise<RegimeApiResponse> {
  const res = await apiFetch("/api/regime");
  if (!res.ok) throw new Error("Failed to load regime");
  return res.json();
}

/** One line: "Regime: MNQ late bull since 13/04 (bull since 06/04), MGC not bull since 24/08, BTC not bull since 10/11/2025". */
export function RegimeStrip({ markets }: { markets?: RegimeApiResponse["markets"] | null }) {
  const { data } = usePolledResource(fetchRegime, { intervalMs: 5 * 60_000, enabled: markets === undefined });
  const items = stripItems(markets === undefined ? data?.markets : markets);
  if (items.length === 0) return null;
  return (
    <div
      data-testid="regime-strip"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-6 py-2 font-mono text-[11px] text-muted-foreground"
    >
      <span className="uppercase tracking-wide">Regime</span>
      {items.map((i) => (
        <span key={i.market} className="inline-flex items-center gap-1.5">
          <span className="size-1.5 rounded-full" style={{ backgroundColor: regimeColor(i.label) }} />
          <span className="text-foreground">{i.text}</span>
        </span>
      ))}
    </div>
  );
}

/** Label + since per subscription row, plus the effective multiplier when regime factors are set. */
export function RegimeBadge({ regime, factors }: { regime: SubRegimeView | null | undefined; factors?: RegimeFactorsView | null }) {
  if (!regime) return null;
  const mult = multiplierText(regime, factors);
  return (
    <>
      <Badge
        variant="outline"
        className="text-[10px] py-0 px-1.5 font-mono"
        title={`${regime.market} C1 weekly regime${regime.weekClosed ? `, week of ${fmtWeek(regime.weekClosed) ?? regime.weekClosed}` : ""}`}
      >
        <span className="mr-1 size-1.5 rounded-full" style={{ backgroundColor: regimeColor(regime.label) }} />
        {regimeText(regime.label, regime.since, regime.phaseSince)}
      </Badge>
      {mult && (
        <Badge variant="secondary" className="text-[10px] py-0 px-1.5 font-mono" data-testid="regime-multiplier">
          {mult}
        </Badge>
      )}
    </>
  );
}

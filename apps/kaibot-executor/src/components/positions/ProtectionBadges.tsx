import { Badge } from "@kaibot/shared";
import { fmtPrice } from "@/lib/portfolio-figures";
import {
  floorChipLabel,
  floorTooltip,
  isProtected,
  type AccountFloor,
  type PositionProtection,
  stopChipLabel,
  stopSentence,
} from "@/lib/position-protection";

const STOP_TONE = "border-[var(--kb-teal)]/40 text-[var(--kb-teal)]";
const WARN_TONE = "border-[var(--kb-amber)]/40 text-[var(--kb-amber)]";
const MUTED = "border-border text-muted-foreground";
// Account and plan floors: dashed outline, never the protection colour.
const FLOOR = "border-dashed border-border bg-transparent text-muted-foreground";
const FLOOR_BAD = "border-dashed border-[var(--kb-red)]/40 bg-transparent text-[var(--kb-red)]";

// Levels as the venue quotes them: no padded zeros ("79,227", "2,471.24").
export const fmtLevel = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: n >= 1 ? 2 : 6 });

function FloorChip({ floor, onOpenPlan }: { floor: AccountFloor; onOpenPlan?: (planId: string) => void }) {
  const title = floor.error ? `${floorTooltip(floor)}. ${floor.error}` : floorTooltip(floor);
  const badge = (
    <Badge
      variant="outline"
      data-kind={`${floor.kind}-floor`}
      title={title}
      className={`font-mono text-[9px] ${floor.error ? FLOOR_BAD : FLOOR}`}
    >
      {floorChipLabel(floor)}
    </Badge>
  );
  if (!(floor.planId && onOpenPlan)) return badge;
  return (
    <button
      type="button"
      className="rounded hover:opacity-80"
      onClick={(e) => {
        e.stopPropagation();
        onOpenPlan(floor.planId!);
      }}
    >
      {badge}
    </button>
  );
}

export function ProtectionBadges({
  protection,
  side,
  onOpenPlan,
}: {
  protection: PositionProtection;
  side: "long" | "short";
  onOpenPlan?: (planId: string) => void;
}) {
  const { stop, accountFloors, syntheticHedge, hedge } = protection;
  const missing = !isProtected(protection);
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-1">
      {syntheticHedge ? (
        // A synthetic short hedges coin holdings: no stop by design.
        <Badge variant="outline" className={`font-mono text-[9px] ${MUTED}`} data-kind="synthetic-hedge">
          synthetic hedge
        </Badge>
      ) : (
        <Badge
          variant="outline"
          data-kind={`stop-${stop.kind}`}
          title={stopSentence(stop, side)}
          className={`font-mono text-[9px] ${missing ? WARN_TONE : STOP_TONE}`}
        >
          {stopChipLabel(stop)}
        </Badge>
      )}
      {accountFloors.map((f) => (
        <FloorChip key={f.row.id} floor={f} onOpenPlan={onOpenPlan} />
      ))}
      {hedge && (
        <Badge
          variant="outline"
          data-kind="hedge"
          title={`Hedge guard: opens ${hedge.hedgeSymbol} at ${fmtPrice(hedge.triggerPrice)}`}
          className={`font-mono text-[9px] ${hedge.lastError ? FLOOR_BAD : FLOOR}`}
        >
          hedge {fmtPrice(hedge.triggerPrice)}
          {hedge.status === "hedged" ? " open" : ""}
        </Badge>
      )}
    </span>
  );
}

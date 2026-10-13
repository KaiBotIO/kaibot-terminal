import { Badge } from "@kaibot/shared";
import type { ArmedView } from "@/lib/synthetic-usd-api";

// Floor minted at its recovery limit: the short stays until closed or re-armed.
export function HeldBadge({
  armed,
  compact = false,
}: {
  armed: Pick<ArmedView, "held" | "triggersAtLevel">;
  compact?: boolean;
}) {
  if (!armed.held) return null;
  const badge = (
    <Badge variant="outline" className="py-0 px-1 text-[9px] uppercase tracking-normal text-muted-foreground">
      Held
    </Badge>
  );
  if (compact) return badge;
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[10px] normal-case text-muted-foreground">
      {badge}
      recovery off after {armed.triggersAtLevel} trigger{armed.triggersAtLevel === 1 ? "" : "s"}
    </span>
  );
}

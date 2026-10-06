import { Badge } from "@kaibot/shared";
import type { PositionProtection, ProtectionLayer } from "@/lib/position-protection";

const TONE: Record<ProtectionLayer["tone"], string> = {
  ok: "border-[var(--kb-teal)]/40 text-[var(--kb-teal)]",
  warn: "border-[var(--kb-amber)]/40 text-[var(--kb-amber)]",
  bad: "border-[var(--kb-red)]/40 text-[var(--kb-red)]",
};
const SECONDARY = "border-border text-muted-foreground";

// Levels as the venue quotes them: no padded zeros ("79,227", "2,471.24").
const fmtLevel = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: n >= 1 ? 2 : 6 });

export function layerLabel(l: ProtectionLayer): string {
  const kind = l.kind === "ride" ? "ride stop" : l.kind;
  if (l.kind === "plan") return `plan · ${l.note ?? ""}`.trim();
  const level = l.level != null ? ` ${fmtLevel(l.level)}` : "";
  return `${kind}${level}${l.note ? ` · ${l.note}` : ""}`;
}

// The binding layer in its tone; the others muted behind it.
export function ProtectionBadges({ protection }: { protection: PositionProtection }) {
  const { layers, primary } = protection;
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-1">
      {!primary && (
        <Badge variant="outline" className={`font-mono text-[9px] ${TONE.warn}`} data-kind="none">
          no stop
        </Badge>
      )}
      {layers.map((l) => (
        <Badge
          key={l.kind}
          variant="outline"
          data-kind={l.kind}
          data-primary={l === primary ? "true" : undefined}
          className={`font-mono text-[9px] ${l === primary || l.tone === "bad" ? TONE[l.tone] : SECONDARY}`}
        >
          {layerLabel(l)}
        </Badge>
      ))}
    </span>
  );
}

import type { FC, ReactNode } from "react";
import { Info } from "lucide-react";
import { cn } from "../../lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../ui/tooltip";

type IconType = FC<{ className?: string; size?: number | string }>;

export interface StatItem {
  label: string;
  value: ReactNode;
  caption?: ReactNode;
  icon?: IconType;
  /** Plain-language explanation, shown as an info tooltip next to the label. */
  hint?: string;
  /** Render the value in gold (--primary). Use for the single focal stat per strip. */
  focal?: boolean;
  /** Semantic colour override for the value (e.g. `text-[var(--kb-green)]`). */
  valueClassName?: string;
}

// Safelisted column classes (Tailwind JIT can't see dynamic `grid-cols-${n}`).
const COL_CLASS: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-1 sm:grid-cols-3",
  4: "grid-cols-2 lg:grid-cols-4",
  5: "grid-cols-2 lg:grid-cols-5",
  6: "grid-cols-2 lg:grid-cols-6",
  7: "grid-cols-2 sm:grid-cols-4",
  8: "grid-cols-2 sm:grid-cols-4",
};

/**
 * Canonical Gridline Tokyo stat strip: one hairline-framed row of equal columns
 * (mono uppercase micro-label + mono tabular value). The container draws top+left
 * rules and each cell its right+bottom rule, so the divider grid stays clean at
 * any column count and when it wraps on mobile. Not floating cards.
 *
 * `size="md"` (default) = large KPI numerals (dashboards). `size="sm"` = compact
 * metadata strips (list-card metrics, where values can be short strings/dates).
 */
export function StatStrip({
  items,
  className,
  size = "md",
}: {
  items: StatItem[];
  className?: string;
  size?: "sm" | "md";
}) {
  const cols = COL_CLASS[items.length] ?? "grid-cols-2";
  const cellPad = size === "sm" ? "p-3" : "px-5 py-4";
  const valueSize = size === "sm" ? "mt-1 text-sm" : "mt-2 text-[28px] leading-none";
  return (
    <TooltipProvider>
    <div className={cn("grid border-t border-l border-border", cols, className)}>
      {items.map((it, i) => (
        <div key={i} className={cn("border-r border-b border-border", cellPad)}>
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              {it.label}
              {it.hint && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={`About ${it.label}`}
                      className="text-muted-foreground/60 hover:text-foreground"
                    >
                      <Info className="size-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent className="normal-case tracking-normal">
                    {it.hint}
                  </TooltipContent>
                </Tooltip>
              )}
            </span>
            {it.icon && <it.icon className="size-4 shrink-0 text-muted-foreground" />}
          </div>
          <div
            className={cn(
              "font-mono font-medium tabular-nums",
              valueSize,
              it.focal ? "text-primary" : "text-foreground",
              it.valueClassName,
            )}
          >
            {it.value}
          </div>
          {it.caption != null && (
            <div className="mt-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              {it.caption}
            </div>
          )}
        </div>
      ))}
    </div>
    </TooltipProvider>
  );
}

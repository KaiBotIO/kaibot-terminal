import { Badge } from "../ui/badge";
import { cn } from "../../lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../ui/tooltip";
import {
  ladderBadgeLabel,
  ladderTooltipLines,
  type LadderLevel,
} from "../../lib/ladder";

export interface TimeframeBadgeProps {
  /** The run's root timeframe — what a non-ladder bot shows. */
  timeframe: string;
  /** Open ladder levels; empty/absent falls back to the plain timeframe. */
  levels?: LadderLevel[] | null;
  className?: string;
}

/**
 * Timeframe of a run. A ladder strategy sitting above its root shows the
 * timeframe it upgraded to plus its level; everything else shows its fixed
 * timeframe.
 */
export function TimeframeBadge({ timeframe, levels, className }: TimeframeBadgeProps) {
  const open = levels ?? [];
  if (open.length === 0) {
    return (
      <Badge variant="outline" className={className}>
        {timeframe}
      </Badge>
    );
  }
  return (
    <TooltipProvider delayDuration={150}>
      <span className="inline-flex flex-wrap items-center gap-1">
        {open.map((l) => (
          <Tooltip key={l.side}>
            <TooltipTrigger asChild>
              <Badge
                variant="outline"
                className={cn(
                  l.level > 1 && "border-primary/50 text-primary",
                  className,
                )}
              >
                {ladderBadgeLabel(l)}
              </Badge>
            </TooltipTrigger>
            <TooltipContent className="flex-col items-start gap-0.5">
              {ladderTooltipLines(l, timeframe).map((line) => (
                <span key={line}>{line}</span>
              ))}
            </TooltipContent>
          </Tooltip>
        ))}
      </span>
    </TooltipProvider>
  );
}

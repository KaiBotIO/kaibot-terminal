import type { ReactNode, SyntheticEvent } from "react";
import { Link } from "react-router-dom";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@kaibot/shared";
import { LineChart } from "@/lib/icons";
import { cn } from "@/lib/utils";

// Rows with their own click/Enter handler must not also fire on the link.
const stop = (e: SyntheticEvent) => e.stopPropagation();

/**
 * Link to the embedded chart. Without children it renders the muted chart
 * icon; with children (a symbol) the text itself is the link.
 */
export function ChartLink({
  to,
  children,
  className,
}: {
  to: string;
  children?: ReactNode;
  className?: string;
}) {
  const iconOnly = children == null;
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            to={to}
            onClick={stop}
            onKeyDown={stop}
            aria-label={iconOnly ? "Open chart" : undefined}
            className={cn(
              "rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              iconOnly
                ? "inline-flex size-5 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
                : "hover:underline hover:underline-offset-2",
              className,
            )}
          >
            {iconOnly ? <LineChart className="size-3.5" /> : children}
          </Link>
        </TooltipTrigger>
        <TooltipContent>Open chart</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

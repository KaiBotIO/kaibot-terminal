import type { ReactNode, KeyboardEvent, HTMLAttributes } from "react";
import { ArrowUp, ArrowDown, Clock, Zap } from "lucide-react";
import { cn } from "../../lib/utils";

type SignalDirection = "LONG" | "SHORT" | "BUY" | "SELL";

interface SignalFeedRowProps {
  asset: string;
  direction: SignalDirection;
  strategy?: string;
  price?: string | number;
  confidence?: number;
  timestamp?: string;
  onClick?: () => void;
  className?: string;
}

function isBullish(direction: SignalDirection) {
  return direction === "LONG" || direction === "BUY";
}

export function SignalFeedRow({
  asset,
  direction,
  strategy,
  price,
  confidence,
  timestamp,
  onClick,
  className,
}: SignalFeedRowProps) {
  const bullish = isBullish(direction);

  const interactiveProps: HTMLAttributes<HTMLDivElement> = onClick
    ? {
        role: "button",
        tabIndex: 0,
        onClick,
        onKeyDown: (e: KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClick();
          }
        },
      }
    : {};

  const confidenceColor =
    confidence === undefined
      ? "text-muted-foreground"
      : confidence >= 80
        ? "text-primary"
        : confidence >= 65
          ? "text-foreground"
          : "text-muted-foreground";

  const confidenceIconColor =
    confidence === undefined
      ? "text-muted-foreground/40"
      : confidence >= 80
        ? "text-primary"
        : confidence >= 65
          ? "text-muted-foreground"
          : "text-muted-foreground/40";

  return (
    <div
      className={cn(
        "flex items-center justify-between px-6 py-3 hover:bg-sidebar-accent/30 transition-colors",
        onClick && "cursor-pointer",
        className,
      )}
      {...interactiveProps}
    >
      <div className="flex items-center gap-4">
        <div
          className={cn(
            "flex items-center justify-center size-8",
            bullish ? "bg-[var(--kb-green)]/10" : "bg-[var(--kb-red)]/10",
          )}
        >
          {bullish ? (
            <ArrowUp className="size-4 text-[var(--kb-green)]" />
          ) : (
            <ArrowDown className="size-4 text-[var(--kb-red)]" />
          )}
        </div>
        <div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-semibold text-[var(--kb-teal)]">
              {asset}
            </span>
            <span
              className={cn(
                "font-mono text-[10px] uppercase tracking-wider px-1.5 py-0.5",
                bullish
                  ? "bg-[var(--kb-green)]/10 text-[var(--kb-green)]"
                  : "bg-[var(--kb-red)]/10 text-[var(--kb-red)]",
              )}
            >
              {direction}
            </span>
          </div>
          {(strategy || price !== undefined) && (
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">
              {strategy && (
                <span className="text-[var(--kb-violet)]">{strategy}</span>
              )}
              {strategy && price !== undefined && " · "}
              {price !== undefined && `$${price}`}
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-4">
        {confidence !== undefined && (
          <div className="text-right">
            <div className="flex items-center gap-1">
              <Zap className={cn("size-3", confidenceIconColor)} />
              <span className={cn("font-mono text-sm font-medium", confidenceColor)}>
                {confidence}%
              </span>
            </div>
          </div>
        )}
        {timestamp && (
          <div className="flex items-center gap-1 text-muted-foreground/40 min-w-[60px] justify-end">
            <Clock className="size-3" />
            <span className="font-mono text-[10px]">{timestamp}</span>
          </div>
        )}
      </div>
    </div>
  );
}

interface SignalFeedListProps {
  children: ReactNode;
  className?: string;
}

export function SignalFeedList({ children, className }: SignalFeedListProps) {
  return (
    <div className={cn("divide-y divide-border", className)}>
      {children}
    </div>
  );
}

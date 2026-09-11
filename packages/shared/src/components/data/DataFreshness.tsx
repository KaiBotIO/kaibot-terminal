import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";

interface DataFreshnessProps {
  updatedAt: Date | number | null;
  isRefreshing?: boolean;
  onRefresh: () => void;
  /** Age past which the label turns amber. */
  staleAfterMs?: number;
  className?: string;
}

function ageLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** "Updated Xs ago" + refresh button; fits the PageHeader meta/actions slots. */
export function DataFreshness({
  updatedAt,
  isRefreshing = false,
  onRefresh,
  staleAfterMs,
  className,
}: DataFreshnessProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const ts = updatedAt instanceof Date ? updatedAt.getTime() : updatedAt;
  const age = ts == null ? null : now - ts;
  const stale = age != null && staleAfterMs != null && age > staleAfterMs;

  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <span
        className={cn(
          "font-mono text-[10px] uppercase tracking-wider",
          stale ? "text-[var(--kb-amber)]" : "text-muted-foreground",
        )}
      >
        {age == null ? "No data yet" : `Updated ${ageLabel(age)} ago`}
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onRefresh}
        disabled={isRefreshing}
        aria-label="Refresh"
      >
        <RefreshCw className={cn(isRefreshing && "animate-spin")} />
      </Button>
    </div>
  );
}

import { AlertTriangle } from "lucide-react";
import { Button } from "../ui/button";
import { fmtDateTime } from "../../lib/format";
import { cn } from "../../lib/utils";

interface StaleDataBannerProps {
  updatedAt: Date | number | null;
  onRetry: () => void;
  className?: string;
}

export function StaleDataBanner({ updatedAt, onRetry, className }: StaleDataBannerProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 border border-[var(--kb-amber)]/40 bg-[var(--kb-amber)]/5 px-4 py-2",
        className,
      )}
    >
      <AlertTriangle className="size-4 shrink-0 text-[var(--kb-amber)]" />
      <p className="flex-1 text-sm text-[var(--kb-amber)]">
        Live data unavailable — showing snapshot from{" "}
        {updatedAt != null ? fmtDateTime(updatedAt) : "an earlier session"}
      </p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

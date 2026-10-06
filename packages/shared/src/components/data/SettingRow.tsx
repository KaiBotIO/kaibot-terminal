import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

interface SettingRowProps {
  label: ReactNode;
  description?: ReactNode;
  /** Right-aligned control (Input / Switch / Button / value). */
  control?: ReactNode;
  className?: string;
}

/**
 * 22a hairline form row: label (+ optional description) on the left, control on
 * the right, divided from siblings by a faint hairline. Stack these inside a
 * `<Section>` instead of a stack of bordered cards.
 */
export function SettingRow({ label, description, control, className }: SettingRowProps) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-4 border-b border-border/60 px-6 py-3 last:border-b-0",
        className,
      )}
    >
      <div className="min-w-0 space-y-0.5">
        <div className="text-[13px] text-foreground">{label}</div>
        {description != null && (
          <div className="text-xs text-muted-foreground">{description}</div>
        )}
      </div>
      {control != null && <div className="flex shrink-0 items-center gap-2">{control}</div>}
    </div>
  );
}

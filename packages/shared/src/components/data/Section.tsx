import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

interface SectionProps {
  /** Mono-caps micro label in the 40px section head. Omit for a head-less block. */
  label?: ReactNode;
  /** Right-aligned meta inside the head (counts, totals, timestamps). */
  meta?: ReactNode;
  /** Right-aligned controls inside the head (buttons, toggles). */
  actions?: ReactNode;
  /** Drop the bottom hairline — use on the last section in a column. */
  noBorder?: boolean;
  /** Skip the default body padding (24px h / 16px v) — for tables / list rows that pad themselves. */
  flush?: boolean;
  bodyClassName?: string;
  className?: string;
  children: ReactNode;
}

/**
 * Canonical Gridline Tokyo section: a full-bleed block that butts against its
 * neighbours on a 1px hairline (no gaps, no floating cards). An optional 40px
 * head carries a mono-caps micro label + right-aligned meta/actions, divided
 * from the body by a fainter hairline. Mirrors 22a's `section` + `.sechead`.
 */
export function Section({
  label,
  meta,
  actions,
  noBorder,
  flush,
  bodyClassName,
  className,
  children,
}: SectionProps) {
  return (
    <section className={cn(!noBorder && "border-b border-border", className)}>
      {(label != null || meta != null || actions != null) && (
        <div className="flex h-10 items-center gap-3 border-b border-border/60 px-6">
          {label != null && (
            <span className="font-mono text-[10px] font-medium uppercase tracking-wider text-foreground">
              {label}
            </span>
          )}
          {(meta != null || actions != null) && (
            <div className="ml-auto flex items-center gap-4">
              {meta != null && (
                <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                  {meta}
                </span>
              )}
              {actions}
            </div>
          )}
        </div>
      )}
      <div className={cn(!flush && "px-6 py-4", bodyClassName)}>{children}</div>
    </section>
  );
}

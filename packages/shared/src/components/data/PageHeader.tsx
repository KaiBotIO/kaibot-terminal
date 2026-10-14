import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

interface PageHeaderProps {
  title: string;
  description?: string;
  /** Right-aligned page metadata (e.g. equity / key stat), 22a `.title-meta`. */
  meta?: ReactNode;
  actions?: ReactNode;
  /**
   * `hero` (default) = full 22a titleblock: 30px H1 + lead description + right
   * meta/actions, framed by a bottom hairline and 24px padding (full-bleed, no
   * outer page padding needed). `inline` = compact header for embeds.
   */
  variant?: "hero" | "inline";
  className?: string;
}

export function PageHeader({
  title,
  description,
  meta,
  actions,
  variant = "hero",
  className,
}: PageHeaderProps) {
  if (variant === "inline") {
    return (
      <div className={cn("flex items-start justify-between gap-4", className)}>
        <div className="space-y-1 min-w-0">
          <h1 className="font-heading text-[22px] font-semibold tracking-tight">{title}</h1>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">{actions}</div>
        )}
      </div>
    );
  }

  return (
    <div className={cn("flex items-end justify-between gap-6 border-b border-border px-6 py-5", className)}>
      <div className="min-w-0 space-y-2">
        <h1 className="font-heading text-[30px] font-semibold leading-none tracking-[-0.02em]">
          {title}
        </h1>
        {description && (
          <p className="max-w-[60ch] text-[13px] leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {(meta || actions) && (
        <div className="flex shrink-0 flex-col items-end gap-3">
          {meta && <div className="text-right">{meta}</div>}
          {actions && (
            <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div>
          )}
        </div>
      )}
    </div>
  );
}

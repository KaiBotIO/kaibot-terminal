import type { FC, ReactNode } from "react";
import { cn } from "../../lib/utils";

// Accepts both lucide and Nucleo icon components (SVG component with size).
type IconType = FC<{ className?: string; size?: number | string }>;

interface EmptyStateProps {
  icon: IconType;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div className={cn("space-y-3 py-10 text-center", className)}>
      <Icon className="mx-auto size-8 text-muted-foreground" />
      <div className="space-y-1">
        <h3 className="font-heading text-base font-semibold tracking-tight">
          {title}
        </h3>
        {description && (
          <p className="mx-auto max-w-md text-sm text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {action && <div className="flex justify-center">{action}</div>}
    </div>
  );
}

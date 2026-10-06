import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Card, CardContent } from "../ui/card";
import { cn } from "../../lib/utils";

interface StubBannerProps {
  title: string;
  children: ReactNode;
  className?: string;
}

export function StubBanner({ title, children, className }: StubBannerProps) {
  return (
    <Card className={cn("border-[var(--kb-amber)]/40 bg-[var(--kb-amber)]/5", className)}>
      <CardContent className="flex items-start gap-3 p-4">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--kb-amber)]" />
        <div className="text-sm text-muted-foreground">
          <div className="font-medium text-[var(--kb-amber)]">{title}</div>
          {children}
        </div>
      </CardContent>
    </Card>
  );
}

import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { cn } from "../../lib/utils";

interface InfoBannerProps {
  children: ReactNode;
  linkHref?: string;
  linkLabel?: string;
  className?: string;
}

export function InfoBanner({ children, linkHref, linkLabel, className }: InfoBannerProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 border border-[var(--kb-teal)]/40 bg-[var(--kb-teal)]/5 px-4 py-2",
        className,
      )}
    >
      <Info className="size-4 shrink-0 text-[var(--kb-teal)]" />
      <p className="flex-1 text-sm text-[var(--kb-text-2)]">{children}</p>
      {linkHref && (
        <a
          href={linkHref}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 whitespace-nowrap text-sm text-[var(--kb-teal)] hover:underline"
        >
          {linkLabel ?? "Learn more →"}
        </a>
      )}
    </div>
  );
}

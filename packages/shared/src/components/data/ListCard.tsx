import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "../../lib/utils";
import { DashboardCard } from "./DashboardCard";
import { CardHeader, CardTitle, CardContent, CardFooter } from "../ui/card";

type TitleAccent = "violet" | "teal" | "none";

const ACCENT_CLASS: Record<TitleAccent, string> = {
  violet: "text-[var(--kb-violet)]",
  teal: "text-[var(--kb-teal)]",
  none: "text-foreground",
};

export interface ListCardProps {
  /** When set, the whole card becomes a react-router Link to this path. */
  to?: string;
  title: ReactNode;
  /** Title colour treatment. Defaults to "none" (foreground). */
  titleAccent?: TitleAccent;
  /** Header right-hand slot (badges/status). */
  badges?: ReactNode;
  /** Card body. */
  children?: ReactNode;
  /** Optional footer row (e.g. action buttons). */
  actions?: ReactNode;
  className?: string;
}

/**
 * Canonical list card: a DashboardCard (hairline border, no shadow, zero radius)
 * with a unified header (title + badges), body, and optional actions footer.
 * One hover treatment for both linked and static cards. Pass `to` to make the
 * whole card a navigable Link.
 */
export function ListCard({
  to,
  title,
  titleAccent = "none",
  badges,
  children,
  actions,
  className,
}: ListCardProps) {
  const card = (
    <DashboardCard
      className={cn(
        "hover:bg-muted/50 transition-colors",
        to && "block",
        className,
      )}
    >
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <CardTitle
          className={cn(
            "font-heading text-base font-medium tracking-tight",
            ACCENT_CLASS[titleAccent],
          )}
        >
          {title}
        </CardTitle>
        {badges && <div className="flex items-center gap-2">{badges}</div>}
      </CardHeader>
      {children != null && <CardContent>{children}</CardContent>}
      {actions != null && (
        <CardFooter className="gap-2">{actions}</CardFooter>
      )}
    </DashboardCard>
  );

  if (to) {
    return (
      <Link to={to} className="block">
        {card}
      </Link>
    );
  }

  return card;
}

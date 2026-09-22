import type { ReactNode } from "react";
import { Card } from "../ui/card";
import { cn } from "../../lib/utils";

interface DashboardCardProps extends React.ComponentProps<typeof Card> {
  children: ReactNode;
  className?: string;
}

export function DashboardCard({
  children,
  className,
  ...props
}: DashboardCardProps) {
  return (
    <Card
      className={cn("border border-border bg-transparent", className)}
      {...props}
    >
      {children}
    </Card>
  );
}

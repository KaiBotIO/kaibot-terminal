import type { FC, ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "../ui/button";
import { EmptyState } from "./EmptyState";

type IconType = FC<{ className?: string; size?: number | string }>;

interface QueryStateGateProps {
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  icon?: IconType;
  errorTitle?: string;
  errorDescription?: string;
  loadingLabel?: string;
  isEmpty?: boolean;
  emptyState?: ReactNode;
  children: ReactNode;
}

/** Shared line under every load-error title: the read failed, nothing on the account did. */
export const LOAD_ERROR_DESCRIPTION = "The request failed. Nothing on your account changed.";

/** Loading → error (with Retry) → empty → children, so pages never show an empty state for a load error. */
export function QueryStateGate({
  isLoading,
  isError,
  onRetry,
  icon,
  errorTitle,
  errorDescription,
  loadingLabel,
  isEmpty,
  emptyState,
  children,
}: QueryStateGateProps) {
  if (isLoading) {
    return (
      <p className="px-6 py-4 text-sm text-muted-foreground">
        {loadingLabel ?? "Loading…"}
      </p>
    );
  }
  if (isError) {
    return (
      <EmptyState
        icon={icon ?? AlertTriangle}
        title={errorTitle ?? "Couldn't load data"}
        description={errorDescription ?? LOAD_ERROR_DESCRIPTION}
        action={<Button onClick={onRetry}>Retry</Button>}
        className="py-10"
      />
    );
  }
  if (isEmpty && emptyState != null) return <>{emptyState}</>;
  return <>{children}</>;
}

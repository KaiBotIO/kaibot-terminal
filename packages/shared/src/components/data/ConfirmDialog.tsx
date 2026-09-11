import { type ReactNode, useCallback, useState } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { cn } from "../../lib/utils";

export type ConfirmTone = "destructive" | "danger-money";

export interface ConfirmSummaryItem {
  label: string;
  value: ReactNode;
}

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  tone: ConfirmTone;
  /** Compact key/value block (side / symbol / qty / price / notional). */
  summary?: ConfirmSummaryItem[];
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void | Promise<void>;
  skipPreference?: {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
  };
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  tone,
  summary,
  confirmLabel,
  cancelLabel = "Cancel",
  onConfirm,
  skipPreference,
}: ConfirmDialogProps) {
  const [pending, setPending] = useState(false);

  const handleConfirm = async () => {
    setPending(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } finally {
      setPending(false);
    }
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => {
        if (!pending) onOpenChange(o);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle
            className={tone === "danger-money" ? "text-[var(--kb-red)]" : undefined}
          >
            {title}
          </AlertDialogTitle>
          {description && (
            <AlertDialogDescription>{description}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        {summary && summary.length > 0 && (
          <div
            className={cn(
              "space-y-1.5 border p-3",
              tone === "danger-money"
                ? "border-[var(--kb-red)]/40 bg-[var(--kb-red)]/5"
                : "border-border bg-muted/30",
            )}
          >
            {summary.map((item) => (
              <div
                key={item.label}
                className="flex items-center justify-between gap-4 text-sm"
              >
                <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  {item.label}
                </span>
                <span className="font-medium tabular-nums">{item.value}</span>
              </div>
            ))}
          </div>
        )}
        {skipPreference && (
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Checkbox
              checked={skipPreference.checked}
              onCheckedChange={(c) => skipPreference.onCheckedChange(c === true)}
            />
            Don't ask again
          </label>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{cancelLabel}</AlertDialogCancel>
          <Button variant="destructive" disabled={pending} onClick={handleConfirm}>
            {pending ? "Working…" : confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export type ConfirmOptions = Omit<
  ConfirmDialogProps,
  "open" | "onOpenChange" | "onConfirm"
>;

interface ConfirmRequest {
  opts: ConfirmOptions;
  resolve: (ok: boolean) => void;
}

/** Imperative confirm: `if (await confirm({...})) doIt()`. Mount `dialog` once in the page. */
export function useConfirm(): {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  dialog: ReactNode;
} {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => setRequest({ opts, resolve })),
    [],
  );

  const dialog = request ? (
    <ConfirmDialog
      {...request.opts}
      open
      onOpenChange={(open) => {
        if (!open) {
          request.resolve(false);
          setRequest(null);
        }
      }}
      onConfirm={() => {
        request.resolve(true);
        setRequest(null);
      }}
    />
  ) : null;

  return { confirm, dialog };
}

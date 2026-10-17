// Roll an expiring dated-futures position to the next contract: preview both
// legs (close old, open new, same exposure) with the estimated spread cost,
// then execute edge-side after an explicit confirm. No auto-roll anywhere —
// this dialog is the only path and every roll is user-initiated.
import { useEffect, useState } from "react";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@kaibot/shared";
import { ArrowRight, Loader2 } from "@/lib/icons";
import { toast } from "sonner";
import { rollApi, type RollLegOrderType, type RollPreview, type RollResult } from "@/lib/manual-trade-api";
import type { PositionExpiryInfo } from "@/lib/atoms";

export interface RollPositionTarget {
  exchange: string;
  symbol: string;
  accountId?: string;
  expiry?: PositionExpiryInfo | null;
}

const labelClass = "font-mono text-[10px] uppercase tracking-wider text-muted-foreground";
const inputClass =
  "h-8 w-28 rounded-md border border-border bg-background px-2 text-right font-mono text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary";

function fmtPrice(n: number | null | undefined): string {
  return n != null && n > 0 ? `$${n.toFixed(2)}` : "—";
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function daysLabel(days: number): string {
  if (days <= 0) return "today";
  if (days === 1) return "in 1 day";
  return `in ${days} days`;
}

function resultToast(r: RollResult) {
  const detail = r.warnings.join(" ");
  switch (r.status) {
    case "rolled":
      if (r.warnings.length > 0) toast.warning("Rolled with warnings", { description: detail });
      else toast.success("Position rolled", { description: `${r.rolledQuantity} contracts moved` });
      return;
    case "aborted":
      toast.warning("Roll aborted, position unchanged", { description: detail });
      return;
    case "restored":
      toast.error("Roll failed, original position restored", { description: detail });
      return;
    case "incomplete":
      toast.error("ROLL INCOMPLETE, check your position", { description: detail, duration: 30000 });
      return;
  }
}

export function RollPositionDialog({
  target,
  onOpenChange,
  onDone,
}: {
  target: RollPositionTarget;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [preview, setPreview] = useState<RollPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [orderType, setOrderType] = useState<RollLegOrderType>("market");
  const [closePrice, setClosePrice] = useState("");
  const [openPrice, setOpenPrice] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    rollApi
      .preview({ exchange: target.exchange, symbol: target.symbol, accountId: target.accountId })
      .then((p) => {
        if (cancelled) return;
        setPreview(p);
        if (p.fromPrice != null) setClosePrice(String(p.fromPrice));
        if (p.toPrice != null) setOpenPrice(String(p.toPrice));
      })
      .catch((e) => {
        if (!cancelled) setPreviewError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [target.exchange, target.symbol, target.accountId]);

  const closeN = parseFloat(closePrice);
  const openN = parseFloat(openPrice);
  const limitsValid =
    orderType === "market" ||
    (Number.isFinite(closeN) && closeN > 0 && Number.isFinite(openN) && openN > 0);

  const submit = async () => {
    if (!preview || busy || !limitsValid) return;
    setBusy(true);
    try {
      const r = await rollApi.execute({
        exchange: preview.exchange,
        symbol: preview.fromSymbol,
        toSymbol: preview.toSymbol,
        accountId: preview.accountId,
        legOrderType: orderType,
        closeLimitPrice: orderType === "limit" ? closeN : undefined,
        openLimitPrice: orderType === "limit" ? openN : undefined,
        idempotencyKey: crypto.randomUUID(),
      });
      resultToast(r);
      onDone();
      onOpenChange(false);
    } catch (e) {
      toast.error("Roll failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const expiry = preview?.expiry ?? target.expiry ?? null;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-mono text-sm">
            Roll {target.symbol}
            {preview && (
              <>
                <ArrowRight className="size-3.5 text-muted-foreground" />
                <span className="text-[var(--kb-teal)]">{preview.toSymbol}</span>
              </>
            )}
          </DialogTitle>
          <DialogDescription>
            Closes the expiring contract and reopens the same exposure on the next
            one, never one leg without the other.
          </DialogDescription>
        </DialogHeader>

        {previewError && (
          <p className="text-xs text-[var(--kb-red)]">{previewError}</p>
        )}
        {!preview && !previewError && (
          <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Building preview…
          </div>
        )}

        {preview && (
          <>
            {expiry && (
              <div className="flex items-center gap-2">
                <Badge
                  variant={expiry.daysLeft <= 7 ? "warning" : "outline"}
                  className="text-[10px]"
                >
                  rolls {daysLabel(expiry.daysLeft)}
                </Badge>
                <span className="text-[11px] text-muted-foreground">
                  Expires {fmtDate(expiry.date)}
                  {expiry.source === "calculated" ? " (calculated)" : ""}
                </span>
              </div>
            )}

            <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-2 rounded border border-border p-3 text-xs">
              <span className={labelClass}>Close</span>
              <span className="font-mono">
                <span
                  className={
                    preview.closeSide === "sell"
                      ? "text-[var(--kb-red)]"
                      : "text-[var(--kb-green)]"
                  }
                >
                  {preview.closeSide}
                </span>{" "}
                {preview.size} × <span className="text-[var(--kb-teal)]">{preview.fromSymbol}</span>
              </span>
              {orderType === "limit" ? (
                <input
                  className={inputClass}
                  type="number"
                  min="0"
                  step="any"
                  value={closePrice}
                  onChange={(e) => setClosePrice(e.target.value)}
                />
              ) : (
                <span className="font-mono text-muted-foreground">{fmtPrice(preview.fromPrice)}</span>
              )}

              <span className={labelClass}>Open</span>
              <span className="font-mono">
                <span
                  className={
                    preview.openSide === "buy"
                      ? "text-[var(--kb-green)]"
                      : "text-[var(--kb-red)]"
                  }
                >
                  {preview.openSide}
                </span>{" "}
                {preview.size} × <span className="text-[var(--kb-teal)]">{preview.toSymbol}</span>
              </span>
              {orderType === "limit" ? (
                <input
                  className={inputClass}
                  type="number"
                  min="0"
                  step="any"
                  value={openPrice}
                  onChange={(e) => setOpenPrice(e.target.value)}
                />
              ) : (
                <span className="font-mono text-muted-foreground">{fmtPrice(preview.toPrice)}</span>
              )}
            </div>

            <div className="flex items-center justify-between text-[11px]">
              <div className="flex overflow-hidden rounded border border-border text-[10px]">
                {(
                  [
                    { v: "market", label: "Market" },
                    { v: "limit", label: "Limit" },
                  ] as const
                ).map((o) => (
                  <button
                    key={o.v}
                    type="button"
                    onClick={() => setOrderType(o.v)}
                    className={`px-2 py-1 font-mono uppercase ${
                      orderType === o.v ? "bg-muted text-foreground" : "text-muted-foreground"
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              <span className="font-mono text-muted-foreground">
                {preview.estCost != null ? (
                  <>
                    Est. cost{" "}
                    <span
                      className={
                        preview.estCost > 0 ? "text-[var(--kb-red)]" : "text-[var(--kb-green)]"
                      }
                    >
                      {preview.estCost >= 0 ? "" : "+"}${Math.abs(preview.estCost).toFixed(2)}
                    </span>{" "}
                    excl. fees
                  </>
                ) : (
                  `No price for ${preview.toSymbol} yet`
                )}
              </span>
            </div>

            <p className="text-[10px] leading-snug text-muted-foreground">
              {orderType === "limit"
                ? "A close leg that doesn't fill in time cancels and nothing is rolled. An open leg that doesn't fill completes at market so you're never left one-legged."
                : "If the open leg is refused, the original position is restored at market."}
            </p>

            <Button className="w-full" disabled={busy || !limitsValid} onClick={() => void submit()}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : "Roll position"}
            </Button>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

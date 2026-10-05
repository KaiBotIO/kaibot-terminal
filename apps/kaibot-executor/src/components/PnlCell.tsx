import type { Position } from "@/lib/atoms";
import { pnlUsdOf } from "@/lib/notional";
import { fmtCoin } from "@/lib/portfolio-figures";

// Unrealized P&L of one position in USD; on an inverse contract the venue's
// coin figure sits underneath so the two stay auditable side by side.
export function PnlCell({ p }: { p: Position }) {
  const usd = pnlUsdOf(p);
  const native = p.unrealizedPnL ?? 0;
  const currency = (p.pnlCurrency ?? "USD").toUpperCase();
  const isProfit = (usd ?? native) >= 0;
  const color = isProfit ? "text-[var(--kb-green)]" : "text-[var(--kb-red)]";
  return (
    <div className="flex flex-col items-end">
      <span className={`font-mono ${color}`}>
        {usd == null ? "n/a" : `${isProfit ? "+" : "-"}$${Math.abs(usd).toFixed(2)}`}
      </span>
      {currency !== "USD" && (
        <span className="font-mono text-[10px] text-muted-foreground">
          {native >= 0 ? "+" : "-"}
          {fmtCoin(Math.abs(native))} {currency}
        </span>
      )}
    </div>
  );
}

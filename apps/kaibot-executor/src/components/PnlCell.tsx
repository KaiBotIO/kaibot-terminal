import type { Position } from "@/lib/atoms";
import { pnlUsdOf } from "@/lib/notional";
import { fmtCoin, fmtSignedUsd, pnlTone, PNL_TONE_CLASS } from "@/lib/portfolio-figures";

// Unrealized P&L since entry in USD; on an inverse contract the same figure in
// coin (USD / mark) sits underneath.
export function PnlCell({ p }: { p: Position }) {
  const usd = pnlUsdOf(p);
  const currency = (p.pnlCurrency ?? "USD").toUpperCase();
  const mark = p.markPrice ?? 0;
  const coin = usd != null && mark > 0 ? usd / mark : null;
  return (
    <div className="flex flex-col items-end">
      <span className={`font-mono ${PNL_TONE_CLASS[pnlTone(usd)]}`}>
        {usd == null ? "n/a" : fmtSignedUsd(usd)}
      </span>
      {currency !== "USD" && coin != null && (
        <span className="font-mono text-[10px] text-muted-foreground">
          {coin > 0 ? "+" : coin < 0 ? "-" : ""}
          {fmtCoin(Math.abs(coin))} {currency}
        </span>
      )}
    </div>
  );
}

import { Link } from "react-router-dom";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@kaibot/shared";
import { FloorPreflightLine } from "@/components/FloorPreflight";
import { MoreHorizontal } from "@/lib/icons";
import { fmtPrice } from "@/lib/portfolio-figures";
import type { AccumulatePlan } from "@/lib/accumulate-api";
import type { SyntheticUsdPosition } from "@/lib/synthetic-usd-api";
import { PlanPhaseBadge } from "./PlanDetail";

const LINK = "text-[var(--kb-teal)] hover:underline";
const coords = (exchange: string, accountKey: string | null) =>
  `${exchange}${accountKey ? ` · ${accountKey}` : ""}`;

// Floors on coin holdings and plans without an open position, under the table.
export function HoldingsBlock({
  floors,
  plans,
  readOnly,
  onPlan,
}: {
  floors: SyntheticUsdPosition[];
  plans: AccumulatePlan[];
  readOnly: boolean;
  onPlan: (plan: AccumulatePlan, kind: "check" | "stop") => void;
}) {
  if (floors.length === 0 && plans.length === 0) return null;
  return (
    <div className="mx-4 my-3 rounded-md border border-border font-mono text-[11px] tabular-nums">
      <div className="flex items-center gap-3 border-b border-border px-3 py-2">
        <span className="uppercase tracking-wider text-muted-foreground">Holdings floors &amp; plans</span>
        <span className="ml-auto flex gap-3">
          <Link to="/collateral" className={LINK}>
            Collateral →
          </Link>
          <Link to="/synthetic-usd" className={LINK}>
            Synthetic USD →
          </Link>
        </span>
      </div>
      <div className="divide-y divide-border">
        {floors.map((f) => (
          <div key={f.id} className="grid items-baseline gap-x-3 px-3 py-1.5 sm:grid-cols-[minmax(0,14rem)_6rem_1fr]">
            <span>
              {f.symbol} <span className="text-muted-foreground">· {coords(f.exchange, f.accountKey)}</span>
            </span>
            <span className="text-muted-foreground">{fmtPrice(f.armed.triggerPrice)}</span>
            <FloorPreflightLine id={f.id} />
          </div>
        ))}
        {plans.map((p) => (
          <div key={p.id} className="grid items-center gap-x-3 px-3 py-1.5 sm:grid-cols-[minmax(0,14rem)_6rem_1fr_auto]">
            <span>
              {p.symbol} <span className="text-muted-foreground">· {coords(p.exchange, p.accountId.includes("/") ? p.accountId.split("/")[0] : null)} · plan</span>
            </span>
            <span className="text-muted-foreground">{fmtPrice(p.watchLevel)}</span>
            <span className="flex items-center gap-2">
              <PlanPhaseBadge plan={p} />
              <span className={p.lastError ? "text-[var(--kb-red)]" : "text-muted-foreground"}>
                {p.lastError ?? p.lastNote}
              </span>
            </span>
            {!readOnly && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-6 w-7 px-0" aria-label="Plan actions">
                    <MoreHorizontal className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem className="cursor-pointer font-mono text-xs" onClick={() => onPlan(p, "check")}>
                    Check now
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="cursor-pointer font-mono text-xs text-[var(--kb-red)] focus:text-[var(--kb-red)]"
                    onClick={() => onPlan(p, "stop")}
                  >
                    Stop, cancel rungs
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

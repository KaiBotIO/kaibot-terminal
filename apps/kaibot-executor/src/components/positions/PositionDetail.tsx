import { Link } from "react-router-dom";
import { FloorPreflightLine } from "@/components/FloorPreflight";
import { fmtPrice } from "@/lib/portfolio-figures";
import type { PositionProtection } from "@/lib/position-protection";
import { PlanDetail } from "./PlanDetail";

const labelClass = "font-mono text-[10px] uppercase tracking-wider text-muted-foreground";

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className={labelClass}>{title}</div>
      <div className="font-mono text-[11px] tabular-nums">{children}</div>
    </div>
  );
}

const LINK = "text-[var(--kb-teal)] hover:underline";

// Expanded row: the detail behind each protection badge.
export function PositionDetail({ protection: pr }: { protection: PositionProtection }) {
  const { trail, stopFloor, ride, floor, holdingsFloor, hedge, plan } = pr;
  return (
    <div className="flex flex-col gap-4 py-1">
      {plan && (
        <Block title="Accumulate plan">
          <PlanDetail plan={plan} />
        </Block>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {trail && trail.effectiveStop != null && (
          <Block title="Stop">
            <div>
              {fmtPrice(trail.effectiveStop)}
              {trail.trailingLock && " · locked"}
            </div>
            <div className="text-muted-foreground">
              {trail.mode === "drawdown" ? "drawdown" : "fixed"} trail
              {trail.breakevenFee != null && " + break-even"}
              {trail.currentStop != null && ` · at venue ${fmtPrice(trail.currentStop)}`}
            </div>
          </Block>
        )}
        {!trail && stopFloor && (
          <Block title="Stop floor">
            <div>
              {fmtPrice(stopFloor.manualStop)}
              {stopFloor.trailingLock ? " · locked" : ", the bot trails above it"}
            </div>
            {stopFloor.currentStop != null && (
              <div className="text-muted-foreground">at venue {fmtPrice(stopFloor.currentStop)}</div>
            )}
          </Block>
        )}
        {!plan?.ride && pr.layers.some((l) => l.kind === "ride") && (
          <Block title="Ride">
            <div>{ride?.botName ?? "ride bot"}</div>
            <div className="text-muted-foreground">
              stop {ride?.currentStop != null ? fmtPrice(ride.currentStop) : "pending"}
            </div>
          </Block>
        )}
        {hedge && (
          <Block title="Hedge">
            <div>
              {hedge.hedgeSymbol} at {fmtPrice(hedge.triggerPrice)}
            </div>
            <div className={hedge.lastError ? "text-[var(--kb-red)]" : "text-muted-foreground"}>
              {hedge.lastError ??
                (hedge.status === "hedged"
                  ? `open since ${fmtPrice(hedge.hedgeEntryPrice)}`
                  : hedge.recoveryPrice != null
                    ? `recovers at ${fmtPrice(hedge.recoveryPrice)}`
                    : "armed")}
            </div>
          </Block>
        )}
      </div>
      {(floor || holdingsFloor) && (
        <Block title="Synthetic floor">
          <FloorPreflightLine id={(floor ?? holdingsFloor)!.id} />
          {!floor && <div className="text-muted-foreground">covers the coins, not this position</div>}
          <Link to="/synthetic-usd" className={LINK} onClick={(e) => e.stopPropagation()}>
            Synthetic USD →
          </Link>
        </Block>
      )}
    </div>
  );
}

import { Link } from "react-router-dom";
import { FloorPreflightLine } from "@/components/FloorPreflight";
import { fmtPrice } from "@/lib/portfolio-figures";
import { floorSentence, isProtected, type PositionProtection, shortId, stopSentence } from "@/lib/position-protection";
import { PlanDetail, RearmSettings, TrancheChain } from "./PlanDetail";
import { fmtLevel } from "./ProtectionBadges";

const labelClass = "font-mono text-[10px] uppercase tracking-wider text-muted-foreground";

function Block({ title, id, children }: { title: string; id?: string; children: React.ReactNode }) {
  return (
    <div id={id} className="flex flex-col gap-1">
      <div className={labelClass}>{title}</div>
      <div className="font-mono text-[11px] tabular-nums">{children}</div>
    </div>
  );
}

const LINK = "text-[var(--kb-teal)] hover:underline";

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
// "ETH-PERPETUAL" → "ETH", "BTC_USDC-PERPETUAL" → "BTC".
const coinOf = (symbol: string) => symbol.split(/[-_]/)[0];

export const planAnchorId = (planId: string) => `plan-${planId}`;

export function PositionDetail({ protection: pr, side }: { protection: PositionProtection; side: "long" | "short" }) {
  const { stop, trail, accountFloors, syntheticHedge, syntheticRow, hedge, plan } = pr;
  return (
    <div className="flex flex-col gap-4 py-1">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {!syntheticHedge && (
          <Block title="Protection">
            <div className={isProtected(pr) ? undefined : "text-[var(--kb-amber)]"}>{stopSentence(stop, side)}</div>
            {trail && trail.source === "manual" && (
              <div className="text-muted-foreground">
                {trail.mode === "drawdown" ? "Drawdown trail" : "Fixed trail"}
                {trail.breakevenFee != null && " with break-even"}.
              </div>
            )}
          </Block>
        )}
        {accountFloors.length > 0 && (
          <Block title="Account floors">
            {accountFloors.map((f) => (
              <div key={f.row.id} className="flex flex-col gap-0.5">
                <div>
                  {floorSentence(f)}
                  {f.planId && ` Plan ${shortId(f.planId)}.`}
                </div>
                <FloorPreflightLine id={f.row.id} issuesOnly />
                {f.error && <div className="text-[var(--kb-red)]">{f.error}</div>}
              </div>
            ))}
            <Link to="/synthetic-usd" className={LINK} onClick={(e) => e.stopPropagation()}>
              Open Synthetic USD
            </Link>
          </Block>
        )}
        {hedge && (
          <Block title="Hedge guard">
            <div>
              Opens {hedge.hedgeSymbol} at {fmtPrice(hedge.triggerPrice)}.
            </div>
            <div className={hedge.lastError ? "text-[var(--kb-red)]" : "text-muted-foreground"}>
              {hedge.lastError ??
                (hedge.status === "hedged"
                  ? `Open since ${fmtPrice(hedge.hedgeEntryPrice)}.`
                  : hedge.recoveryPrice != null
                    ? `Closes again at ${fmtPrice(hedge.recoveryPrice)}.`
                    : "Armed.")}
            </div>
          </Block>
        )}
      </div>
      {plan && (
        <Block title={`Accumulate plan ${shortId(plan.id)}`} id={planAnchorId(plan.id)}>
          <PlanDetail plan={plan} />
        </Block>
      )}
      {plan && (
        <Block title="Re-arm">
          <RearmSettings key={`${plan.id}:${JSON.stringify(plan.params)}`} plan={plan} />
        </Block>
      )}
      {pr.tranches.length > 1 && (
        <Block title="Tranches">
          <TrancheChain plans={pr.tranches} />
        </Block>
      )}
      {syntheticHedge && (
        <Block title="Synthetic USD">
          <div>
            {syntheticHedge.triggerPrice != null ? `Trigger ${fmtPrice(syntheticHedge.triggerPrice)}` : "No trigger"}
            {syntheticHedge.firedPrice != null && `, filled at ${fmtPrice(syntheticHedge.firedPrice)}`}.
          </div>
          <div className="text-muted-foreground">
            Covers{" "}
            {syntheticHedge.holdingsCoin != null && syntheticRow
              ? `${fmtLevel(syntheticHedge.holdingsCoin)} ${coinOf(syntheticRow.symbol)}`
              : "the coin holdings"}
            {` (${usd(syntheticHedge.holdingsUsd)}) with a ${usd(syntheticHedge.shortUsd)} short.`}
          </div>
          {syntheticRow && <FloorPreflightLine id={syntheticRow.id} />}
          <Link to="/synthetic-usd" className={LINK} onClick={(e) => e.stopPropagation()}>
            Open Synthetic USD
          </Link>
        </Block>
      )}
    </div>
  );
}

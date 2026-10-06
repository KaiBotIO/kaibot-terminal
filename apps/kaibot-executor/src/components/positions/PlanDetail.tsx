import { Badge } from "@kaibot/shared";
import { PHASE_LABEL, type AccumulatePlan } from "@/lib/accumulate-api";
import { fmtNum } from "@/components/AccumulateDialog";
import { fmtPrice } from "@/lib/portfolio-figures";

const labelClass = "font-mono text-[10px] uppercase tracking-wider text-muted-foreground";

export const PHASE_TONE: Record<AccumulatePlan["phase"], string> = {
  ladder: "border-[var(--kb-amber)]/40 text-[var(--kb-amber)]",
  riding: "border-[var(--kb-teal)]/40 text-[var(--kb-teal)]",
  waiting: "border-border text-muted-foreground",
  stopped: "border-border text-muted-foreground",
};

function fmtTime(ms: number) {
  return new Date(ms).toLocaleString("en-GB", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function PlanPhaseBadge({ plan }: { plan: AccumulatePlan }) {
  return (
    <Badge variant="outline" className={`text-[9px] ${PHASE_TONE[plan.phase]}`}>
      {PHASE_LABEL[plan.phase]}
    </Badge>
  );
}

// Live state of one accumulate plan: levels, rungs, ride, floor and its last note.
export function PlanDetail({ plan: p }: { plan: AccumulatePlan }) {
  return (
    <div className="grid gap-3 font-mono text-[11px] tabular-nums sm:grid-cols-3 lg:grid-cols-6">
      <div>
        <div className={labelClass}>Reference</div>
        <div>{fmtPrice(p.reference)}</div>
      </div>
      <div>
        <div className={labelClass}>{p.direction === "long" ? "Breakout above" : "Breakout below"}</div>
        <div>{fmtPrice(p.watchLevel)}</div>
      </div>
      <div>
        <div className={labelClass}>Rungs</div>
        <div>
          {p.rungs.open} open · {p.rungs.filled} filled
        </div>
        {p.basisUsd != null && <div className="text-muted-foreground">basis ${fmtNum(p.basisUsd, 0)}</div>}
      </div>
      <div>
        <div className={labelClass}>Ride</div>
        {p.ride ? (
          <>
            <div>{p.ride.botName ?? "ride bot"}</div>
            {p.ride.currentStop != null && (
              <div className="text-muted-foreground">stop {fmtPrice(p.ride.currentStop)}</div>
            )}
          </>
        ) : (
          <div className="text-muted-foreground">not yet</div>
        )}
      </div>
      <div>
        <div className={labelClass}>Floor</div>
        {p.floor ? (
          <div>
            {p.floor.triggerPrice != null ? fmtPrice(p.floor.triggerPrice) : p.floor.status}
            {p.floor.shortSize > 0 && <div className="text-[var(--kb-amber)]">hedged</div>}
          </div>
        ) : (
          <div className="text-muted-foreground">none</div>
        )}
      </div>
      <div>
        <div className={labelClass}>Phase</div>
        <PlanPhaseBadge plan={p} />
      </div>
      <div className="text-muted-foreground sm:col-span-3 lg:col-span-6">
        {p.lastError ? <span className="text-[var(--kb-red)]">{p.lastError}</span> : p.lastNote}
        {p.lastBreakout && (
          <span>
            {" "}
            · last breakout {fmtTime(p.lastBreakout.barTime)} close {fmtPrice(p.lastBreakout.close)} over{" "}
            {fmtPrice(p.lastBreakout.level)}
          </span>
        )}
        {p.pending && <span className="text-[var(--kb-amber)]"> · last step unfinished, retried every minute</span>}
      </div>
    </div>
  );
}

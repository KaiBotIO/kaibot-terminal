import { useState } from "react";
import { Badge, Button, Input } from "@kaibot/shared";
import { toast } from "sonner";
import { PHASE_LABEL, accumulateApi, type AccumulatePlan } from "@/lib/accumulate-api";
import { fmtNum } from "@/components/AccumulateDialog";
import { fmtPrice } from "@/lib/portfolio-figures";

const labelClass = "font-mono text-[10px] uppercase tracking-wider text-muted-foreground";

export const PHASE_TONE: Record<AccumulatePlan["phase"], string> = {
  ladder: "border-[var(--kb-amber)]/40 text-[var(--kb-amber)]",
  riding: "border-[var(--kb-teal)]/40 text-[var(--kb-teal)]",
  waiting: "border-border text-muted-foreground",
  stopped: "border-border text-muted-foreground",
  armed: "border-[var(--kb-amber)]/40 text-[var(--kb-amber)]",
  closed: "border-border text-muted-foreground",
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

// Re-arm settings of a live plan; the next tick uses them.
export function RearmSettings({ plan }: { plan: AccumulatePlan }) {
  const [rearm, setRearm] = useState(plan.params.rearm);
  const [maxTranches, setMaxTranches] = useState(String(plan.params.maxTranches));
  const [cooldown, setCooldown] = useState(String(plan.params.rearmCooldownBars));
  const [saving, setSaving] = useState(false);
  const dirty =
    rearm !== plan.params.rearm ||
    Number(maxTranches) !== plan.params.maxTranches ||
    Number(cooldown) !== plan.params.rearmCooldownBars;
  if (plan.phase === "stopped" || plan.phase === "closed") return null;
  const save = async () => {
    setSaving(true);
    try {
      await accumulateApi.updateParams(plan.id, {
        rearm,
        maxTranches: Number(maxTranches),
        rearmCooldownBars: Number(cooldown),
      });
      toast.success(rearm ? "Re-arm settings saved" : "Re-arm off for this plan");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="flex flex-wrap items-end gap-3 font-mono text-[11px]">
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={rearm} onChange={(e) => setRearm(e.target.checked)} />
        Re-arm
      </label>
      <div className="space-y-1">
        <div className={labelClass}>Max tranches</div>
        <Input className="h-7 w-20 font-mono text-xs" inputMode="numeric" value={maxTranches} onChange={(e) => setMaxTranches(e.target.value)} />
      </div>
      <div className="space-y-1">
        <div className={labelClass}>Cooldown (bars)</div>
        <Input className="h-7 w-20 font-mono text-xs" inputMode="numeric" value={cooldown} onChange={(e) => setCooldown(e.target.value)} />
      </div>
      <Button variant="outline" size="sm" className="h-7 px-2 text-[10px]" disabled={!dirty || saving} onClick={save}>
        Save
      </Button>
      <p className="w-full text-[10px] text-muted-foreground">Off does not stop a tranche that is already armed: use Stop on that plan.</p>
    </div>
  );
}

const pnlTone = (n: number | null) =>
  n == null ? "text-muted-foreground" : n >= 0 ? "text-[var(--kb-green)]" : "text-[var(--kb-red)]";

// Every tranche the market's plans opened, oldest first.
export function TrancheChain({ plans }: { plans: AccumulatePlan[] }) {
  const chain = [...plans].sort((a, b) => a.trancheIndex - b.trancheIndex);
  const settings = chain[chain.length - 1]?.params;
  return (
    <div className="flex flex-col gap-1 font-mono text-[11px] tabular-nums">
      <div className="grid grid-cols-[2rem_1fr_1fr_1fr_1fr] gap-x-3">
        <div className={labelClass}>#</div>
        <div className={labelClass}>Phase</div>
        <div className={labelClass}>Entry</div>
        <div className={labelClass}>Stop</div>
        <div className={`${labelClass} text-right`}>P&amp;L</div>
        {chain.map((p) => (
          <div key={p.id} className="contents">
            <div>{p.trancheIndex}</div>
            <div>
              <PlanPhaseBadge plan={p} />
            </div>
            <div>{p.tranche?.entryPrice != null ? fmtPrice(p.tranche.entryPrice) : "—"}</div>
            <div>{p.tranche?.stop != null ? fmtPrice(p.tranche.stop) : "—"}</div>
            <div className={`text-right ${pnlTone(p.tranche?.pnlUsd ?? null)}`}>
              {p.tranche?.pnlUsd != null ? `$${fmtNum(p.tranche.pnlUsd, 0)}` : "—"}
            </div>
          </div>
        ))}
      </div>
      {settings && (
        <div className="text-muted-foreground">
          {settings.rearm
            ? `Re-arm on · max ${settings.maxTranches} tranches · cooldown ${settings.rearmCooldownBars} bars`
            : "Re-arm off"}
        </div>
      )}
    </div>
  );
}

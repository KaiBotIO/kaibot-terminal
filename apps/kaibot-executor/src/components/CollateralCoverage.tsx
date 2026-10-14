import { useState } from "react";
import { Badge, Section, Switch, useConfirm } from "@kaibot/shared";
import { toast } from "sonner";
import {
  collateralApi,
  type CollateralAccountRef,
  type CollateralOverview,
  type HedgeLegStatus,
  type VirtualCoverage,
} from "@/lib/collateral-api";
import { coverageChoices } from "@/lib/collateral";

const EU = "nl-BE";
const usd = (n: number) => `$${Math.round(n).toLocaleString(EU)}`;
const num = (n: number | null | undefined, d = 2) => (n == null ? "—" : n.toLocaleString(EU, { maximumFractionDigits: d }));
const lev = (n: number | null) => (n == null ? "—" : Number.isFinite(n) ? `${num(n, 2)}x` : "∞");

const LEG_VARIANT: Record<HedgeLegStatus, "neutral" | "warning" | "error" | "success"> = {
  off: "neutral",
  pending: "neutral",
  refused: "error",
  armed: "warning",
  fired: "error",
};

// What protects the off-exchange (virtual) coins on this account, with the
// numbers behind each choice.
export function CollateralCoverage({
  account,
  overview,
  readOnly,
  onChanged,
}: {
  account: CollateralAccountRef;
  overview: CollateralOverview;
  readOnly: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const { confirm, dialog } = useConfirm();
  const { coverage, settings } = overview;
  const legs = overview.coins.filter((c) => c.hedge);
  if (overview.virtualLines.length === 0 && legs.length === 0) return null;
  const choices = coverageChoices(coverage);
  const plan = coverage.plan;

  const setMode = async (mode: VirtualCoverage) => {
    if (mode === settings.virtualCoverage) return;
    if (mode === "hedge") {
      const ok = await confirm({
        title: "Hedge the off-exchange coins?",
        description:
          "When a sell floor fires, the executor also opens a short on that coin's USDT perp for the off-exchange quantity. Real orders.",
        tone: "danger-money",
        summary: [
          { label: "Hedge size", value: usd(plan.notionalUsd) },
          { label: "Leverage after it fires", value: lev(plan.leverage) },
          { label: "Liquidation", value: plan.liqDistancePct == null ? "—" : `+${num(plan.liqDistancePct, 1)} %` },
        ],
        confirmLabel: "Hedge",
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const res = await collateralApi.saveSettings({
        exchange: account.exchange,
        accountId: account.accountId,
        virtualCoverage: mode,
      });
      const refused = res.hedges.filter((h) => h.status === "refused");
      if (refused.length) toast.error(refused.map((h) => `${h.coin}: ${h.error}`).join("\n"));
      else toast.success(mode === "hedge" ? "Hedge armed" : "Hedge off");
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const toggleLeg = async (floorId: string, on: boolean) => {
    setBusy(true);
    try {
      await collateralApi.update(floorId, { virtualHedge: on });
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      label="Off-exchange coverage"
      meta={
        <Badge variant={settings.virtualCoverage === "hedge" ? "warning" : "neutral"} className="text-[9px] uppercase">
          {settings.virtualCoverage}
        </Badge>
      }
      flush
    >
      <div className="grid gap-px bg-border/60 sm:grid-cols-3">
        {choices.map((c) => {
          const active = c.mode === settings.virtualCoverage;
          const selectable = !readOnly && c.mode !== "deposit";
          return (
            <button
              key={c.mode}
              type="button"
              disabled={!selectable || busy}
              onClick={() => c.mode !== "deposit" && setMode(c.mode)}
              className={`bg-background px-6 py-3 text-left disabled:cursor-default ${
                active ? "outline outline-1 -outline-offset-1 outline-[hsl(var(--primary))]" : selectable ? "hover:bg-muted/40" : ""
              }`}
            >
              <div className="flex items-center gap-2 text-xs font-medium">
                {c.title}
                {active && <Badge variant="outline" className="text-[9px] py-0 px-1">current</Badge>}
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">{c.text}</p>
            </button>
          );
        })}
      </div>

      {legs.length > 0 && (
        <div className="overflow-x-auto border-t border-border/60">
          <table className="w-full text-[11px] font-mono">
            <thead>
              <tr className="text-[10px] uppercase tracking-widest text-muted-foreground">
                <th className="px-6 py-2 text-left font-normal">Coin</th>
                <th className="px-3 py-2 text-left font-normal">Hedge</th>
                <th className="px-3 py-2 text-right font-normal">Off-exchange</th>
                <th className="px-3 py-2 text-right font-normal">Short size</th>
                <th className="px-3 py-2 text-right font-normal">Fires at</th>
                <th className="px-3 py-2 text-right font-normal">Leverage after</th>
                <th className="px-3 py-2 text-right font-normal">Liquidation</th>
                <th className="px-3 py-2 text-right font-normal">Deposit to arm</th>
                <th className="px-6 py-2 text-right font-normal">On</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {legs.map((c) => {
                const h = c.hedge!;
                return (
                  <tr key={c.coin}>
                    <td className="px-6 py-2">{c.coin}</td>
                    <td className="px-3 py-2">
                      <Badge variant={LEG_VARIANT[h.status]} className="text-[9px] py-0 px-1 uppercase">
                        {h.status}
                      </Badge>
                      {h.error && (
                        <span className="ml-1 text-[var(--kb-red)]" title={h.error}>!</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{num(h.qty, 6)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {h.status === "fired" && h.shortSize != null && h.firedPrice != null
                        ? `${usd(h.shortSize * h.firedPrice)} @ ${num(h.firedPrice, 4)}`
                        : usd(h.notionalUsd)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{num(h.triggerPrice, 4)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{lev(h.leverageAtFire)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {h.liqDistancePct == null ? "—" : `+${num(h.liqDistancePct, 1)} % · ${num(h.liqPrice, 4)}`}
                    </td>
                    <td className={`px-3 py-2 text-right tabular-nums ${h.topUpToArmUsd > 0 ? "text-[var(--kb-red)]" : ""}`}>
                      {h.topUpToArmUsd > 0 ? usd(h.topUpToArmUsd) : "—"}
                    </td>
                    <td className="px-6 py-2 text-right">
                      <Switch
                        checked={h.enabled}
                        disabled={readOnly || busy || !c.floor}
                        onCheckedChange={(on: boolean) => c.floor && toggleLeg(c.floor.id, on)}
                        aria-label={`${c.coin} hedge`}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="border-t border-border/60 px-6 py-2 text-[11px] text-muted-foreground">
        Alerts: mark within 3 % of a trigger (with the deposit for 2x), a hedge fired, maintenance margin above{" "}
        {settings.warnMmrPct} %. Each fires once until the hedge re-arms. A hedge is never closed or cut to save margin.
      </p>
      {dialog}
    </Section>
  );
}

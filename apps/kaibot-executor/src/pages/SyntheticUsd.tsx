import { useEffect, useState } from "react";
import { useAtom } from "jotai";
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Input,
  Label,
  PageHeader,
  Section,
  SettingRow,
  StaleDataBanner,
  StatStrip,
  Switch,
  useConfirm,
} from "@kaibot/shared";
import { AlertTriangle, Coins, RefreshCw, Shield, Layers } from "lucide-react";
import { toast } from "sonner";
import { skipOrderConfirmAtom } from "@/lib/atoms";
import {
  syntheticUsdApi,
  type SyntheticUsdPosition,
  type HoldingsBasis,
  type SyntheticUsdMutation,
} from "@/lib/synthetic-usd-api";
import { usePolledResource } from "@/hooks/usePolledResource";

const fmtUsd = (n: number) =>
  `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

// One synthetic USD market is supported today: Deribit BTC-PERPETUAL (inverse).
const MINT_MARKET = { exchange: "deribit", accountId: "btc", symbol: "BTC-PERPETUAL" };

export default function SyntheticUsd() {
  const { data, error, isStale, isLoading: loading, lastUpdated, refresh: load } =
    usePolledResource(
      async () => {
        const [list, basis] = await Promise.all([
          syntheticUsdApi.list(),
          syntheticUsdApi.holdingsBasis(),
        ]);
        // Pull the open position's full mutation history (incl. autonomous
        // auto_rebalance orders) so it's on screen from the first load, not just
        // after an action this session.
        const openPos = list.positions.find((p) => p.status === "open") ?? null;
        const detail = openPos ? await syntheticUsdApi.detail(openPos.id) : null;
        return { list, basis, detail };
      },
      { intervalMs: 5000 },
    );
  const list = data?.list ?? null;
  const basis = data?.basis ?? null;

  const open = list?.positions.find((p) => p.status === "open") ?? null;
  const leverageCap = list?.leverageCap ?? 2;
  const holdingsBasisUsd = basis?.total ?? list?.holdingsBasisUsd ?? 0;
  const overCap = open ? open.leverage > leverageCap : false;

  return (
    <div className="flex flex-col text-foreground">
      <PageHeader
        title="Synthetic USD"
        description="Lock the USD value of your crypto holdings with a delta-neutral short on the inverse perpetual. Tracked separately from your other positions."
        meta={
          open ? (
            <div className="space-y-1.5">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  Target USD
                </div>
                <div className="font-mono text-[22px] font-medium tabular-nums text-primary">
                  {fmtUsd(open.target_usd)}
                </div>
              </div>
              {open.is_factor_basis === 1 && (
                <Badge variant="secondary" className="font-mono text-[10px] uppercase">
                  Synthetic mode · {open.exchange} · {open.account_id}
                </Badge>
              )}
            </div>
          ) : undefined
        }
      />

      {isStale && <StaleDataBanner updatedAt={lastUpdated} onRetry={load} />}

      {open && (
        <StatStrip
          items={[
            { label: "Target USD", value: fmtUsd(open.target_usd), focal: true },
            { label: "Short size", value: fmtUsd(open.short_size) },
            {
              label: "Leverage",
              value: `${open.leverage.toFixed(2)}x`,
              valueClassName: overCap
                ? "text-[var(--kb-red)]"
                : open.leverage > leverageCap * 0.9
                  ? "text-[var(--kb-amber)]"
                  : undefined,
            },
            { label: "Holdings basis", value: fmtUsd(open.holdings_basis_usd) },
          ]}
        />
      )}

      {loading && !data ? (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : error != null ? (
        <EmptyState
          className="py-10"
          icon={AlertTriangle}
          title="Couldn't load synthetic USD state"
          description="The executor backend didn't respond. An open position may still exist."
          action={<Button onClick={load}>Retry</Button>}
        />
      ) : (
        <div className="grid lg:grid-cols-5">
          <div className="lg:col-span-3">
            {open ? (
              <OpenPosition
                position={open}
                leverageCap={leverageCap}
                rebalanceEnabled={list?.rebalanceEnabled ?? false}
                mutations={data?.detail?.mutations ?? []}
                onChange={load}
              />
            ) : (
              <MintForm holdingsBasisUsd={holdingsBasisUsd} leverageCap={leverageCap} onMinted={load} />
            )}
          </div>

          <div className="lg:col-span-2 lg:border-l lg:border-border">
            <HoldingsBasisCard basis={basis} loading={loading} onChange={load} />
          </div>
        </div>
      )}
    </div>
  );
}

function MintForm({
  holdingsBasisUsd,
  leverageCap,
  onMinted,
}: {
  holdingsBasisUsd: number;
  leverageCap: number;
  onMinted: () => void;
}) {
  const [target, setTarget] = useState("");
  const [cap, setCap] = useState(String(leverageCap));
  const [busy, setBusy] = useState(false);
  const { confirm, dialog } = useConfirm();

  const capNum = Number(cap);
  const effectiveCap = capNum > 0 ? capNum : leverageCap;
  const targetUsd = Number(target) || 0;
  const leverage = holdingsBasisUsd > 0 ? targetUsd / holdingsBasisUsd : 0;
  const overCap = leverage > effectiveCap;
  const maxTarget = holdingsBasisUsd * effectiveCap;

  const mint = async () => {
    if (targetUsd <= 0) return;
    const ok = await confirm({
      title: "Mint synthetic USD?",
      description: `Opens a delta-neutral short on ${MINT_MARKET.symbol}.`,
      tone: "danger-money",
      summary: [
        { label: "Target USD", value: fmtUsd(targetUsd) },
        { label: "Holdings basis", value: fmtUsd(holdingsBasisUsd) },
        { label: "Leverage", value: `${leverage.toFixed(2)}x` },
        { label: "Cap", value: `${effectiveCap}x` },
      ],
      confirmLabel: `Mint ${fmtUsd(targetUsd)}`,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await syntheticUsdApi.mint({ ...MINT_MARKET, targetUsd, leverageCap: effectiveCap });
      toast.success(`Minted ${fmtUsd(targetUsd)} synthetic USD`);
      setTarget("");
      onMinted();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Mint failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      label={
        <span className="flex items-center gap-1.5">
          <Coins className="size-3.5 text-primary" />
          Mint synthetic USD
        </span>
      }
      bodyClassName="space-y-4"
    >
      <div className="space-y-1.5">
        <Label htmlFor="target" className="text-[11px]">
          Target USD value
        </Label>
        <div className="flex gap-2">
          <Input
            id="target"
            type="number"
            inputMode="decimal"
            placeholder="10000"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="h-9 font-mono"
          />
          <Button
            variant="outline"
            disabled={busy || holdingsBasisUsd <= 0}
            onClick={() => setTarget(String(holdingsBasisUsd))}
            className="h-9 shrink-0 font-mono"
            title={`Set the target to your full holdings basis (${fmtUsd(holdingsBasisUsd)}, 1x)`}
          >
            100% · 1x
          </Button>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="cap" className="text-[11px]">
          Leverage cap
        </Label>
        <div className="flex items-center gap-2">
          <Input
            id="cap"
            type="number"
            inputMode="decimal"
            min="0"
            step="0.5"
            value={cap}
            onChange={(e) => setCap(e.target.value)}
            className="h-9 w-24 font-mono"
          />
          <span className="text-[10px] leading-tight text-muted-foreground">
            Max target = holdings basis × cap. Defaults to {leverageCap}x (the EU
            retail standard). The server clamps the target to this.
          </span>
        </div>
      </div>

      <StatStrip
        size="sm"
        items={[
          { label: "Holdings basis", value: fmtUsd(holdingsBasisUsd) },
          {
            label: "Leverage",
            value: `${leverage.toFixed(2)}x`,
            valueClassName: overCap
              ? "text-[var(--kb-red)]"
              : leverage > 0
                ? undefined
                : "text-muted-foreground",
          },
          { label: `Max (${effectiveCap}x)`, value: fmtUsd(maxTarget) },
        ]}
      />

      {overCap && (
        <p className="text-[11px] text-[var(--kb-red)] font-mono">
          Over the {effectiveCap}x cap. Raise the holdings basis, lower the target,
          or raise the cap.
        </p>
      )}

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        This opens a leveraged short on an inverse perpetual. Leverage multiplies
        losses as well as gains and your exchange can liquidate the position; EU
        regulators cap comparable retail products at 2x. Your cap is your own
        setting, raising it above 2x is your choice and your risk.
      </p>

      <Button onClick={mint} disabled={busy || targetUsd <= 0 || overCap} className="w-full h-9">
        {busy ? <RefreshCw className="size-4 animate-spin" /> : `Mint ${targetUsd > 0 ? fmtUsd(targetUsd) : "synthetic USD"}`}
      </Button>
      {dialog}
    </Section>
  );
}

function OpenPosition({
  position,
  leverageCap,
  rebalanceEnabled,
  mutations,
  onChange,
}: {
  position: SyntheticUsdPosition;
  leverageCap: number;
  rebalanceEnabled: boolean;
  mutations: SyntheticUsdMutation[];
  onChange: () => void;
}) {
  const [target, setTarget] = useState(String(position.target_usd));
  const [busy, setBusy] = useState(false);
  const [skipConfirm, setSkipConfirm] = useAtom(skipOrderConfirmAtom);
  const [confirmKind, setConfirmKind] = useState<"scale" | "close" | "rebalance" | null>(null);
  const [rebalanceTargetPct, setRebalanceTargetPct] = useState(
    String(position.rebalance_target_pct ?? 100),
  );
  const [rebalanceBandPct, setRebalanceBandPct] = useState(
    String(position.rebalance_band_pct ?? 5),
  );

  useEffect(() => {
    setTarget(String(position.target_usd));
  }, [position.target_usd]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      onChange();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  };

  const targetUsd = Number(target) || 0;
  const scaleUp = targetUsd > position.target_usd;

  const doScale = () =>
    act(() => syntheticUsdApi.scale(position.id, targetUsd), "Position scaled");
  const doClose = () => act(() => syntheticUsdApi.close(position.id), "Position closed");

  return (
    <Section
      label={
        <span className="flex items-center gap-1.5">
          <Coins className="size-3.5 text-primary" />
          Synthetic USD position
        </span>
      }
      meta={
        <Badge variant="secondary" className="font-mono text-[10px] uppercase">
          {position.symbol}
        </Badge>
      }
      bodyClassName="space-y-5"
    >
      <div className="space-y-2">
        <Label htmlFor="newtarget" className="text-[11px]">
          Adjust target USD
        </Label>
        <div className="flex gap-2">
          <Input
            id="newtarget"
            type="number"
            inputMode="decimal"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="h-9 font-mono"
          />
          <Button
            variant="secondary"
            disabled={busy || targetUsd === position.target_usd}
            onClick={() => {
              if (skipConfirm) return void doScale();
              setConfirmKind("scale");
            }}
            className="h-9 shrink-0"
          >
            {scaleUp ? "Scale up" : "Scale down"}
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground font-mono">
          Capped at {position.leverage_cap ?? leverageCap}x the holdings basis.
        </p>
      </div>

      <div className="-mx-6 border-t border-border/60">
        <SettingRow
          label={
            <span className="flex items-center gap-2">
              <Shield className="size-3.5 text-muted-foreground" />
              Synthetic mode
            </span>
          }
          description={`Every signal on ${position.exchange} · ${position.account_id} is sized against this USD value as if it were the account size, all markets, not just ${position.symbol}.`}
          control={
            <Switch
              checked={position.is_factor_basis === 1}
              disabled={busy}
              onCheckedChange={(v) =>
                act(() => syntheticUsdApi.setFactorBasis(position.id, v), v ? "Synthetic mode on" : "Synthetic mode off")
              }
            />
          }
        />
        <SettingRow
          label={
            <span className="flex items-center gap-2">
              <RefreshCw className="size-3.5 text-muted-foreground" />
              Auto-rebalance
            </span>
          }
          description={`Keeps the short tracking ${rebalanceTargetPct || "—"}% of the holdings basis; orders fire automatically when drift exceeds the band.${position.is_factor_basis === 1 ? " This also moves your signal account size." : ""}${rebalanceEnabled ? "" : " Disabled on this executor (SYNTHETIC_REBALANCE_ENABLED)."}`}
          control={
            <Switch
              checked={position.auto_rebalance === 1}
              // Env gate is off → block arming a new one, but still let the user
              // disarm a position that was armed while the gate was on.
              disabled={busy || (!rebalanceEnabled && position.auto_rebalance !== 1)}
              onCheckedChange={(v) => {
                if (!v) {
                  void act(
                    () => syntheticUsdApi.setAutoRebalance(position.id, { enabled: false }),
                    "Auto-rebalance off",
                  );
                  return;
                }
                setConfirmKind("rebalance");
              }}
            />
          }
        />
        {!rebalanceEnabled && (
          <p className="px-6 pb-3 text-[10px] leading-relaxed text-[var(--kb-amber)] font-mono">
            Auto-rebalance won't run on this executor. Set SYNTHETIC_REBALANCE_ENABLED=1
            and restart to arm the loop. The per-position switch and the danger
            confirm still apply on top of it.
          </p>
        )}
        {position.auto_rebalance === 1 && (
          <div className="px-6 pb-4 space-y-2">
            <div className="flex gap-2">
              <div className="space-y-1">
                <Label htmlFor="reb-target" className="text-[11px]">Target %</Label>
                <Input
                  id="reb-target"
                  type="number"
                  inputMode="decimal"
                  value={rebalanceTargetPct}
                  onChange={(e) => setRebalanceTargetPct(e.target.value)}
                  className="h-8 font-mono"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="reb-band" className="text-[11px]">Band %</Label>
                <Input
                  id="reb-band"
                  type="number"
                  inputMode="decimal"
                  value={rebalanceBandPct}
                  onChange={(e) => setRebalanceBandPct(e.target.value)}
                  className="h-8 font-mono"
                />
              </div>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  act(
                    () =>
                      syntheticUsdApi.setAutoRebalance(position.id, {
                        enabled: true,
                        targetPct: Number(rebalanceTargetPct) || 0,
                        bandPct: Number(rebalanceBandPct) || 0,
                      }),
                    "Auto-rebalance updated",
                  )
                }
                className="h-8 self-end shrink-0"
              >
                Save
              </Button>
            </div>
            {position.last_rebalance_at && (
              <p className="text-[10px] text-muted-foreground font-mono">
                Last rebalance: {new Date(position.last_rebalance_at).toLocaleString()}
              </p>
            )}
          </div>
        )}
      </div>

      <Button
        variant="destructive"
        disabled={busy}
        onClick={() => setConfirmKind("close")}
        className="w-full h-9"
      >
        {busy ? <RefreshCw className="size-4 animate-spin" /> : "Close position"}
      </Button>

      {mutations.length > 0 && <MutationHistory mutations={mutations} />}

      {confirmKind && (
        <ConfirmDialog
          open
          onOpenChange={(o) => {
            if (!o) setConfirmKind(null);
          }}
          tone="danger-money"
          title={
            confirmKind === "scale"
              ? scaleUp
                ? "Scale up position?"
                : "Scale down position?"
              : confirmKind === "rebalance"
                ? "Enable auto-rebalance?"
                : "Close synthetic USD position?"
          }
          description={
            confirmKind === "close"
              ? "Buys back the full short at market."
              : confirmKind === "rebalance"
                ? "Authorizes the executor to place real orders on its own whenever the short drifts outside the band."
                : undefined
          }
          summary={
            confirmKind === "scale"
              ? [
                  { label: "Current target", value: fmtUsd(position.target_usd) },
                  { label: "New target", value: fmtUsd(targetUsd) },
                  { label: "Change", value: fmtUsd(targetUsd - position.target_usd) },
                ]
              : confirmKind === "rebalance"
                ? [
                    { label: "Track", value: `${Number(rebalanceTargetPct) || 0}% of basis` },
                    { label: "Band", value: `${Number(rebalanceBandPct) || 0}%` },
                  ]
                : [
                    { label: "Target USD", value: fmtUsd(position.target_usd) },
                    { label: "Short size", value: fmtUsd(position.short_size) },
                  ]
          }
          confirmLabel={
            confirmKind === "scale"
              ? scaleUp
                ? "Scale up"
                : "Scale down"
              : confirmKind === "rebalance"
                ? "Enable auto-rebalance"
                : "Close position"
          }
          onConfirm={async () => {
            if (confirmKind === "scale") await doScale();
            else if (confirmKind === "rebalance")
              await act(
                () =>
                  syntheticUsdApi.setAutoRebalance(position.id, {
                    enabled: true,
                    targetPct: Number(rebalanceTargetPct) || 0,
                    bandPct: Number(rebalanceBandPct) || 0,
                  }),
                "Auto-rebalance on",
              );
            else await doClose();
          }}
          skipPreference={
            confirmKind === "scale"
              ? { checked: skipConfirm, onCheckedChange: setSkipConfirm }
              : undefined
          }
        />
      )}
    </Section>
  );
}

function MutationHistory({ mutations }: { mutations: SyntheticUsdMutation[] }) {
  return (
    <div className="border-t border-border/60 pt-4 space-y-1.5">
      <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
        History
      </span>
      {mutations
        .slice()
        .reverse()
        .map((m) => {
          const auto = m.kind === "auto_rebalance";
          return (
            <div key={m.id} className="flex items-center justify-between gap-2 text-[11px] font-mono">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className={`uppercase ${auto ? "text-[var(--kb-amber)]" : "text-muted-foreground"}`}>
                  {m.kind.replace("_", " ")}
                </span>
                {auto && (
                  <Badge variant="outline" className="text-[9px] py-0 px-1 normal-case tracking-normal">
                    auto
                  </Badge>
                )}
              </span>
              <span className="flex shrink-0 items-center gap-3">
                <span className="tabular-nums">
                  {fmtUsd(m.target_usd_before)} → {fmtUsd(m.target_usd_after)}
                </span>
                <span className="tabular-nums text-muted-foreground">
                  {new Date(m.created_at).toLocaleString()}
                </span>
              </span>
            </div>
          );
        })}
    </div>
  );
}

function HoldingsBasisCard({
  basis,
  loading,
  onChange,
}: {
  basis: HoldingsBasis | null;
  loading: boolean;
  onChange: () => void;
}) {
  const [label, setLabel] = useState("cold-storage");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const usd = Number(value) || 0;
    if (!label || usd < 0) return;
    setBusy(true);
    try {
      await syntheticUsdApi.setManualHoldings(label, usd);
      toast.success("Holdings basis updated");
      setValue("");
      onChange();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(false);
    }
  };

  const lines = basis?.lines ?? [];

  return (
    <Section
      label={
        <span className="flex items-center gap-1.5">
          <Layers className="size-3.5 text-muted-foreground" />
          Holdings basis
        </span>
      }
      meta={<span className="tabular-nums">{fmtUsd(basis?.total ?? 0)}</span>}
      noBorder
      bodyClassName="space-y-4"
    >
      {loading && lines.length === 0 ? (
        <div className="flex justify-center py-4">
          <RefreshCw className="size-4 animate-spin text-muted-foreground" />
        </div>
      ) : lines.length === 0 ? (
        <EmptyState
          icon={Layers}
          title="No holdings recorded"
          description="Add your off-exchange holdings to set the leverage basis."
        />
      ) : (
        <div className="divide-y divide-border/60">
          {lines.map((l) => (
            <div key={l.source} className="flex items-center justify-between py-2 text-[11px] font-mono">
              <span className="flex items-center gap-1.5 min-w-0">
                {l.is_manual === 1 && (
                  <Badge variant="outline" className="text-[9px] py-0 px-1">
                    manual
                  </Badge>
                )}
                <span className="truncate text-muted-foreground">{l.source}</span>
              </span>
              <span className="tabular-nums">{fmtUsd(l.usd_value)}</span>
            </div>
          ))}
          <div className="flex items-center justify-between py-2 text-[11px] font-mono">
            <span className="uppercase tracking-widest text-muted-foreground">Total</span>
            <span className="font-semibold tabular-nums">{fmtUsd(basis?.total ?? 0)}</span>
          </div>
        </div>
      )}

      <div className="space-y-2 border-t border-border/60 pt-3">
        <Label className="text-[11px]">Off-exchange holdings</Label>
        <div className="flex gap-2">
          <Input
            placeholder="label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="h-8 font-mono text-xs"
          />
          <Input
            type="number"
            inputMode="decimal"
            placeholder="USD"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="h-8 font-mono text-xs w-28"
          />
          <Button variant="secondary" disabled={busy} onClick={save} className="h-8 shrink-0">
            Set
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground">Set to 0 to remove a manual line.</p>
      </div>
    </Section>
  );
}

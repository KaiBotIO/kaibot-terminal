import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Input,
  Label,
  NativeSelect,
  NativeSelectOption,
  PageHeader,
  Section,
  StaleDataBanner,
  StatStrip,
  Switch,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@kaibot/shared";
import { AlertTriangle, RefreshCw, Shield, Wallet } from "@/lib/icons";
import { toast } from "sonner";
import { usePolledResource } from "@/hooks/usePolledResource";
import { CollateralAlertBanner } from "@/components/CollateralAlertBanner";
import { CollateralCoverage } from "@/components/CollateralCoverage";
import { useIsViewer } from "@/hooks/useRole";
import {
  collateralApi,
  type CollateralAccountRef,
  type CollateralCoinView,
  type CollateralFloorView,
  type CollateralOverview,
  type CollateralVirtualLine,
  type FloorMode,
  type MarginView,
  type PotView,
} from "@/lib/collateral-api";
import {
  MARGIN_STATE_LABEL,
  QUICK_DROPS,
  accountKey,
  debtOf,
  defaultAccount,
  distanceToTriggerPct,
  meterPos,
  plannedFloorUsd,
  triggerFromMark,
  virtualLineShare,
} from "@/lib/collateral";

// European notation (1.234,56), app-wide rule for amounts.
const EU = "nl-BE";
const fmtUsd = (n: number) =>
  `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString(EU, { maximumFractionDigits: 2 })}`;
const fmtPx = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString(EU, { maximumFractionDigits: 4 });
const fmtPct = (n: number | null | undefined, digits = 2) =>
  n == null ? "—" : `${n.toLocaleString(EU, { minimumFractionDigits: digits, maximumFractionDigits: digits })} %`;
const fmtCoin = (n: number) => n.toLocaleString(EU, { maximumFractionDigits: 6 });
const fmtRatio = (r: number) => `${(r * 100).toLocaleString(EU, { maximumFractionDigits: 1 })} %`;
const numOrNull = (v: string) => (v.trim() === "" ? null : Number(v));

const accountLabel = (a: CollateralAccountRef) => `${a.label ?? a.exchange} · ${a.accountId}`;

const activeFloor = (c: CollateralCoinView): CollateralFloorView | null =>
  c.floor && c.floor.status !== "closed" ? c.floor : null;

const STATUS_VARIANT = { armed: "warning", fired: "error", closed: "neutral" } as const;

const MARGIN_STATE_VARIANT = { ok: "success", block: "warning", warn: "error", unknown: "neutral" } as const;

export default function Collateral() {
  const isViewer = useIsViewer();
  const accountsRes = usePolledResource(() => collateralApi.accounts(), { intervalMs: 30000 });
  const accounts = accountsRes.data?.accounts ?? [];

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const account =
    accounts.find((a) => accountKey(a) === selectedKey) ?? defaultAccount(accounts);

  const overviewRes = usePolledResource(
    async () => (account ? collateralApi.overview(account.exchange, account.accountId) : null),
    { intervalMs: 5000, enabled: account != null },
  );
  const refreshOverview = overviewRes.refresh;
  const currentKey = account ? accountKey(account) : null;
  useEffect(() => {
    if (currentKey) void refreshOverview();
  }, [currentKey, refreshOverview]);

  // Drop a payload that belongs to the previous account until the refetch lands.
  const overview =
    overviewRes.data && account && accountKey(overviewRes.data) === currentKey ? overviewRes.data : null;

  const [dialogCoin, setDialogCoin] = useState<string | null>(null);
  const dialogRow = overview?.coins.find((c) => c.coin === dialogCoin) ?? null;

  const hasBybit = accounts.some((a) => a.exchange.toLowerCase() === "bybit");

  const picker =
    accounts.length > 1 ? (
      <NativeSelect
        size="sm"
        aria-label="Account"
        value={currentKey ?? ""}
        onChange={(e) => setSelectedKey(e.target.value)}
        className="font-mono text-xs"
      >
        {accounts.map((a) => (
          <NativeSelectOption key={accountKey(a)} value={accountKey(a)}>
            {accountLabel(a)}
            {a.connected ? "" : " (offline)"}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    ) : account ? (
      <Badge variant="outline" className="font-mono text-[10px] uppercase">
        {accountLabel(account)}
      </Badge>
    ) : undefined;

  const body = () => {
    if (accountsRes.isLoading && !accountsRes.data) return <Spinner />;
    if (accountsRes.error) {
      return (
        <EmptyState
          className="py-10"
          icon={AlertTriangle}
          title="Couldn't load accounts"
          description="The executor backend didn't respond."
          action={<Button onClick={accountsRes.refresh}>Retry</Button>}
        />
      );
    }
    if (!hasBybit || !account) {
      return (
        <EmptyState
          className="py-10"
          icon={Wallet}
          title="No Bybit account connected"
          description="Collateral floors need a Bybit Unified Trading Account."
          action={
            <Button asChild>
              <Link to="/exchanges">Go to Exchanges</Link>
            </Button>
          }
        />
      );
    }
    if (!overview) {
      if (overviewRes.error) {
        return (
          <EmptyState
            className="py-10"
            icon={AlertTriangle}
            title="Couldn't load collateral"
            description={overviewRes.error.message}
            action={<Button onClick={refreshOverview}>Retry</Button>}
          />
        );
      }
      return <Spinner />;
    }
    return (
      <>
        {overview.error && (
          <p className="border-b border-border px-6 py-2 font-mono text-[11px] text-[var(--kb-amber)]">
            {overview.error}
          </p>
        )}
        <CollateralAlertBanner alerts={overview.alerts} link={false} />
        <Summary overview={overview} />
        <CoinsTable
          coins={overview.coins}
          readOnly={isViewer}
          onOpen={(coin) => setDialogCoin(coin)}
        />
        <VirtualLines
          account={account}
          lines={overview.virtualLines}
          coins={overview.coins}
          readOnly={isViewer}
          onChanged={refreshOverview}
        />
        <CollateralCoverage
          account={account}
          overview={overview}
          readOnly={isViewer}
          onChanged={refreshOverview}
        />
        <div className="grid lg:grid-cols-2">
          <PotCard pot={overview.pot} />
          <div className="lg:border-l lg:border-border">
            <MarginCard margin={overview.margin} />
          </div>
        </div>
      </>
    );
  };

  return (
    <div className="flex flex-col text-foreground">
      <PageHeader
        title="Collateral"
        description="Use BTC, ETH and SOL as margin on a Bybit unified account. Each coin can get a floor: a short on its USDT perp, or a conditional spot sell when price breaks your trigger."
        meta={
          overview && overview.pot.mode === "floor" ? (
            <div>
              <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                Sizing pot
              </div>
              <div className="font-mono text-[22px] font-medium tabular-nums text-primary">
                {fmtUsd(overview.pot.potUsd)}
              </div>
            </div>
          ) : undefined
        }
        actions={picker}
      />

      {overviewRes.isStale && overview && (
        <StaleDataBanner updatedAt={overviewRes.lastUpdated} onRetry={refreshOverview} />
      )}

      {body()}

      {dialogRow && account && overview && (
        <FloorDialog
          key={`${currentKey}|${dialogRow.coin}`}
          account={account}
          coin={dialogRow}
          onClose={() => setDialogCoin(null)}
          onDone={() => {
            setDialogCoin(null);
            void refreshOverview();
          }}
        />
      )}
    </div>
  );
}

function Spinner() {
  return (
    <div className="flex items-center justify-center py-12">
      <RefreshCw className="size-5 animate-spin text-muted-foreground" />
    </div>
  );
}

function Summary({ overview }: { overview: CollateralOverview }) {
  const { pot, margin, coins } = overview;
  const armed = coins.filter((c) => activeFloor(c)).length;
  const debt = coins.reduce((s, c) => s + (c.coin.toUpperCase() === "USDT" ? debtOf(c) : 0), 0);
  const mmr = margin.accountMMRate != null ? margin.accountMMRate * 100 : null;
  return (
    <StatStrip
      items={[
        {
          label: "Margin value",
          value: fmtUsd(coins.reduce((s, c) => s + c.marginValueUsd, 0)),
          focal: true,
        },
        { label: "Floors", value: `${armed} / ${coins.filter((c) => c.coin.toUpperCase() !== "USDT").length}` },
        {
          label: "Borrowed USDT",
          value: debt > 0 ? fmtUsd(-debt) : "0",
          valueClassName: debt > 0 ? "text-[var(--kb-red)]" : undefined,
        },
        {
          label: "Free room",
          value: pot.mode === "floor" ? fmtUsd(pot.freeUsd) : "off",
          valueClassName: pot.mode === "floor" && pot.freeUsd <= 0 ? "text-[var(--kb-red)]" : undefined,
        },
        {
          label: "Maintenance margin",
          value: fmtPct(mmr),
          valueClassName:
            margin.state === "warn"
              ? "text-[var(--kb-red)]"
              : margin.state === "block"
                ? "text-[var(--kb-amber)]"
                : undefined,
        },
      ]}
    />
  );
}

function CoinsTable({
  coins,
  readOnly,
  onOpen,
}: {
  coins: CollateralCoinView[];
  readOnly: boolean;
  onOpen: (coin: string) => void;
}) {
  const debts = coins.filter((c) => debtOf(c) > 0);
  const assets = coins.filter((c) => !(debtOf(c) > 0 && c.walletBalance <= 0));
  return (
    <Section label="Coins" meta={<span className="tabular-nums">{assets.length}</span>} flush>
      {coins.length === 0 ? (
        <p className="px-6 py-6 text-center text-xs text-muted-foreground">No balances on this account.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px] font-mono">
            <thead>
              <tr className="text-[10px] uppercase tracking-widest text-muted-foreground">
                <th className="px-6 py-2 text-left font-normal">Coin</th>
                <th className="px-3 py-2 text-right font-normal">Wallet</th>
                <th className="px-3 py-2 text-right font-normal">Off-exchange</th>
                <th className="px-3 py-2 text-right font-normal">Mark</th>
                <th className="px-3 py-2 text-right font-normal">USD value</th>
                <th className="px-3 py-2 text-right font-normal">Ratio</th>
                <th className="px-3 py-2 text-left font-normal">Collateral</th>
                <th className="px-3 py-2 text-left font-normal">Floor</th>
                <th className="px-3 py-2 text-left font-normal">Mode</th>
                <th className="px-3 py-2 text-right font-normal">Trigger</th>
                <th className="px-3 py-2 text-right font-normal">Distance</th>
                <th className="px-3 py-2 text-right font-normal">Planned floor</th>
                <th className="px-6 py-2 text-right font-normal" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {assets.map((c) => {
                const f = activeFloor(c);
                const isStable = c.coin.toUpperCase() === "USDT" || c.coin.toUpperCase() === "USDC";
                const dist = f?.distanceToTriggerPct ?? (f ? distanceToTriggerPct(c.markPrice, f.triggerPrice) : null);
                return (
                  <tr key={c.coin} className="hover:bg-muted/40">
                    <td className="px-6 py-2">{c.coin}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtCoin(c.walletBalance)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                      {c.virtualQty > 0 ? fmtCoin(c.virtualQty) : "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtPx(c.markPrice)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtUsd(c.usdValue)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {fmtRatio(c.collateralRatio)}
                      {c.ratioSource !== "venue" && (
                        <Badge variant="outline" className="ml-1 text-[9px] py-0 px-1 normal-case tracking-normal">
                          {c.ratioSource}
                        </Badge>
                      )}
                    </td>
                    <td className={`px-3 py-2 ${c.collateralSwitch ? "text-[var(--kb-teal)]" : "text-muted-foreground"}`}>
                      {c.collateralSwitch ? "on" : "off"}
                    </td>
                    <td className="px-3 py-2">
                      {f ? (
                        <Badge variant={STATUS_VARIANT[f.status]} className="text-[9px] py-0 px-1 uppercase">
                          {f.status}
                          {f.cycle > 0 ? ` · ${f.cycle}` : ""}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                      {f?.lastError && (
                        <span className="ml-1 text-[var(--kb-red)]" title={f.lastError}>!</span>
                      )}
                    </td>
                    <td className="px-3 py-2">{f?.mode ?? "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtPx(f?.triggerPrice)}</td>
                    <td
                      className={`px-3 py-2 text-right tabular-nums ${dist != null && dist < 2 ? "text-[var(--kb-amber)]" : ""}`}
                    >
                      {f?.status === "armed" ? fmtPct(dist) : "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {f ? fmtUsd(f.realizedFloorUsd ?? f.plannedFloorUsd) : "—"}
                      {f?.realizedFloorUsd != null && <span className="ml-1 text-muted-foreground">realized</span>}
                    </td>
                    <td className="px-6 py-2 text-right">
                      {!readOnly && !isStable && c.markPrice != null && (f || c.walletBalance > 0) && (
                        <Button variant={f ? "outline" : "secondary"} size="sm" className="h-6 px-2 text-[10px]" onClick={() => onOpen(c.coin)}>
                          {f ? "Edit" : "Arm floor"}
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {debts.map((c) => (
                <tr key={`debt-${c.coin}`} className="text-[var(--kb-red)]">
                  <td className="px-6 py-2">{c.coin} borrowed</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtCoin(-debtOf(c))}</td>
                  <td className="px-3 py-2" />
                  <td className="px-3 py-2 text-right tabular-nums">{fmtPx(c.markPrice)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {fmtUsd(-debtOf(c) * (c.markPrice ?? 1))}
                  </td>
                  <td colSpan={8} className="px-3 py-2 text-muted-foreground">
                    debt against collateral
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function PotCard({ pot }: { pot: PotView }) {
  const usedPct = pot.potUsd > 0 ? (pot.usedNotionalUsd / (pot.potUsd * pot.capMult)) * 100 : 0;
  return (
    <Section
      label={
        <span className="flex items-center gap-1.5">
          <Wallet className="size-3.5" />
          Sizing pot
        </span>
      }
      meta={
        <Badge variant={pot.mode === "floor" ? "secondary" : "neutral"} className="text-[10px] py-0 px-1.5 uppercase">
          {pot.mode === "floor" ? `floor · unfloored ${pot.unfloored}` : "off"}
        </Badge>
      }
      bodyClassName="space-y-4"
    >
      {pot.mode === "off" ? (
        <p className="text-[11px] text-muted-foreground">
          Signals size on the account balance.{" "}
          <Link to="/settings" className="text-primary">Switch the basis in Settings</Link>
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-[11px] font-mono">
            <span className="text-muted-foreground">Pot</span>
            <span className="tabular-nums text-right text-primary">{fmtUsd(pot.potUsd)}</span>
            {pot.virtualUsd > 0 && (
              <>
                <span className="pl-3 text-muted-foreground">Venue</span>
                <span className="tabular-nums text-right">{fmtUsd(pot.venueUsd)}</span>
                <span className="pl-3 text-muted-foreground">Virtual</span>
                <span className="tabular-nums text-right">{fmtUsd(pot.virtualUsd)}</span>
              </>
            )}
            <span className="text-muted-foreground">Open notional</span>
            <span className="tabular-nums text-right">{fmtUsd(pot.usedNotionalUsd)}</span>
            <span className="text-muted-foreground">Free room</span>
            <span className={`tabular-nums text-right ${pot.freeUsd <= 0 ? "text-[var(--kb-red)]" : "text-[var(--kb-green)]"}`}>
              {fmtUsd(pot.freeUsd)}
            </span>
            <span className="text-muted-foreground">Cap</span>
            <span className="tabular-nums text-right">{pot.capMult}× pot</span>
          </div>
          <div className="h-1.5 w-full bg-muted/40">
            <div
              className={`h-full ${usedPct >= 100 ? "bg-[var(--kb-red)]" : "bg-primary"}`}
              style={{ width: `${meterPos(usedPct)}%` }}
            />
          </div>
          {pot.components.length > 0 && (
            <table className="w-full text-[11px] font-mono">
              <tbody className="divide-y divide-border/60">
                {pot.components.map((c) => (
                  <tr key={`${c.coin}-${c.source}-${c.virtual ? "v" : "x"}`}>
                    <td className="py-1.5">{c.coin}</td>
                    <td className="py-1.5 text-muted-foreground">
                      {c.source}
                      {c.virtual && <VirtualBadge />}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{fmtUsd(c.usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </Section>
  );
}

function VirtualBadge() {
  return (
    <Badge variant="outline" className="ml-1.5 text-[9px] py-0 px-1 normal-case tracking-normal text-[var(--kb-amber)]">
      virtual, not margin
    </Badge>
  );
}

function VirtualLines({
  account,
  lines,
  coins,
  readOnly,
  onChanged,
}: {
  account: CollateralAccountRef;
  lines: CollateralVirtualLine[];
  coins: CollateralCoinView[];
  readOnly: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [coin, setCoin] = useState("");
  const [qty, setQty] = useState("");
  const [label, setLabel] = useState("cold-wallet");
  const byCoin = useMemo(() => new Map(coins.map((c) => [c.coin, c])), [coins]);
  const lineKey = (l: { coin: string; label: string }) => `${l.coin}|${l.label}`;

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      onChanged();
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Request failed");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const save = (l: { coin: string; label: string }, quantity: number) =>
    run(
      () => collateralApi.setVirtual(account.exchange, account.accountId, { coin: l.coin, label: l.label, quantity }),
      `${l.coin} line saved`,
    );

  const add = async () => {
    const c = coin.trim().toUpperCase();
    if (await save({ coin: c, label: label.trim() }, Number(qty))) {
      setCoin("");
      setQty("");
    }
  };

  return (
    <Section
      label="Off-exchange holdings (virtual)"
      meta={<VirtualBadge />}
      flush
    >
      <p className="px-6 pt-3 text-[11px] text-muted-foreground">
        An order that needs more than the coins on Bybit is refused with the amount to deposit.
      </p>
      {lines.length === 0 ? (
        <p className="px-6 py-4 text-xs text-muted-foreground">No off-exchange coins.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px] font-mono">
            <thead>
              <tr className="text-[10px] uppercase tracking-widest text-muted-foreground">
                <th className="px-6 py-2 text-left font-normal">Coin</th>
                <th className="px-3 py-2 text-left font-normal">Label</th>
                <th className="px-3 py-2 text-right font-normal">Quantity</th>
                <th className="px-3 py-2 text-right font-normal">In pot</th>
                <th className="px-3 py-2 text-right font-normal">At floor trigger</th>
                <th className="px-6 py-2 text-right font-normal" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {lines.map((l) => {
                const k = lineKey(l);
                const edit = edits[k];
                const { potUsd: pot, floorUsd: floor } = virtualLineShare(byCoin.get(l.coin), l.quantity);
                return (
                  <tr key={k} className="hover:bg-muted/40">
                    <td className="px-6 py-2">{l.coin}</td>
                    <td className="px-3 py-2 text-muted-foreground">{l.label}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {readOnly ? (
                        fmtCoin(l.quantity)
                      ) : (
                        <Input
                          aria-label={`${l.coin} ${l.label} quantity`}
                          type="number"
                          inputMode="decimal"
                          value={edit ?? String(l.quantity)}
                          onChange={(e) => setEdits((m) => ({ ...m, [k]: e.target.value }))}
                          className="ml-auto h-6 w-28 text-right font-mono text-[11px]"
                        />
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{pot != null ? fmtUsd(pot) : "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                      {floor != null ? fmtUsd(floor) : "—"}
                    </td>
                    <td className="px-6 py-2 text-right whitespace-nowrap">
                      {!readOnly && (
                        <>
                          {edit != null && edit !== String(l.quantity) && (
                            <Button
                              size="sm"
                              className="h-6 px-2 text-[10px]"
                              disabled={busy || !(Number(edit) >= 0)}
                              onClick={async () => {
                                if (await save(l, Number(edit))) {
                                  setEdits(({ [k]: _drop, ...rest }) => rest);
                                }
                              }}
                            >
                              Save
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            className="ml-1 h-6 px-2 text-[10px]"
                            disabled={busy}
                            onClick={() =>
                              run(
                                () => collateralApi.deleteVirtual(account.exchange, account.accountId, l),
                                `${l.coin} line removed`,
                              )
                            }
                          >
                            Remove
                          </Button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {!readOnly && (
        <div className="flex flex-wrap items-end gap-2 border-t border-border px-6 py-3">
          <div className="space-y-1">
            <Label htmlFor="virtual-coin" className="text-[11px]">Coin</Label>
            <Input
              id="virtual-coin"
              value={coin}
              onChange={(e) => setCoin(e.target.value)}
              placeholder="SOL"
              className="h-8 w-24 font-mono uppercase"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="virtual-qty" className="text-[11px]">Quantity</Label>
            <Input
              id="virtual-qty"
              type="number"
              inputMode="decimal"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              className="h-8 w-32 font-mono"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="virtual-label" className="text-[11px]">Label</Label>
            <Input
              id="virtual-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="h-8 w-36 font-mono"
            />
          </div>
          <Button
            size="sm"
            className="h-8"
            disabled={busy || !coin.trim() || !label.trim() || !(Number(qty) > 0)}
            onClick={add}
          >
            Add
          </Button>
        </div>
      )}
    </Section>
  );
}

function MarginCard({ margin }: { margin: MarginView }) {
  const mmr = margin.accountMMRate != null ? margin.accountMMRate * 100 : null;
  const imr = margin.accountIMRate != null ? margin.accountIMRate * 100 : null;
  return (
    <Section
      label={
        <span className="flex items-center gap-1.5">
          <Shield className="size-3.5" />
          Account guard
        </span>
      }
      meta={
        <Badge variant={MARGIN_STATE_VARIANT[margin.state]} className="text-[10px] py-0 px-1.5 uppercase">
          {MARGIN_STATE_LABEL[margin.state]}
        </Badge>
      }
      bodyClassName="space-y-4"
    >
      <Meter label="Maintenance margin" value={mmr} block={margin.blockMmrPct} warn={margin.warnMmrPct} />
      <Meter label="Initial margin" value={imr} />
      <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-[11px] font-mono">
        <span className="text-muted-foreground">Equity</span>
        <span className="tabular-nums text-right">{margin.totalEquity != null ? fmtUsd(margin.totalEquity) : "—"}</span>
        <span className="text-muted-foreground">Available</span>
        <span className="tabular-nums text-right">
          {margin.totalAvailableBalance != null ? fmtUsd(margin.totalAvailableBalance) : "—"}
        </span>
        <span className="text-muted-foreground">Block entries at</span>
        <span className="tabular-nums text-right">{fmtPct(margin.blockMmrPct, 0)}</span>
        <span className="text-muted-foreground">Warn at</span>
        <span className="tabular-nums text-right">{fmtPct(margin.warnMmrPct, 0)}</span>
        <span className="text-muted-foreground">Auto-reduce</span>
        <span className="tabular-nums text-right">
          {margin.autoReduce ? `on · ${fmtPct(margin.autoReducePct, 0)} of largest alt` : "off"}
        </span>
      </div>
    </Section>
  );
}

function Meter({
  label,
  value,
  block,
  warn,
}: {
  label: string;
  value: number | null;
  block?: number;
  warn?: number;
}) {
  const color =
    value == null
      ? "bg-muted"
      : warn != null && value >= warn
        ? "bg-[var(--kb-red)]"
        : block != null && value >= block
          ? "bg-[var(--kb-amber)]"
          : "bg-[var(--kb-green)]";
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between font-mono text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums">{fmtPct(value)}</span>
      </div>
      <div className="relative h-1.5 w-full bg-muted/40">
        <div className={`h-full ${color}`} style={{ width: `${meterPos(value ?? 0)}%` }} />
        {block != null && (
          <div
            className="absolute -top-1 h-3.5 w-px bg-[var(--kb-amber)]"
            style={{ left: `${meterPos(block)}%` }}
            title={`Block ${block} %`}
          />
        )}
        {warn != null && (
          <div
            className="absolute -top-1 h-3.5 w-px bg-[var(--kb-red)]"
            style={{ left: `${meterPos(warn)}%` }}
            title={`Warn ${warn} %`}
          />
        )}
      </div>
    </div>
  );
}

function FloorDialog({
  account,
  coin,
  onClose,
  onDone,
}: {
  account: CollateralAccountRef;
  coin: CollateralCoinView;
  onClose: () => void;
  onDone: () => void;
}) {
  const floor = activeFloor(coin);
  const [mode, setMode] = useState<FloorMode>(floor?.mode ?? "hedge");
  const [trigger, setTrigger] = useState(floor ? String(floor.triggerPrice) : "");
  const [holdings, setHoldings] = useState(String(floor?.holdingsCoin ?? Math.max(0, coin.walletBalance)));
  const [trailPct, setTrailPct] = useState(floor?.trailPct != null ? String(floor.trailPct) : "");
  const [recoveryPct, setRecoveryPct] = useState(floor?.recoveryPct != null ? String(floor.recoveryPct) : "");
  const [tolerancePct, setTolerancePct] = useState(String(floor?.tolerancePct ?? 0.2));
  const [buyBack, setBuyBack] = useState(floor?.buyBack ?? false);
  const [busy, setBusy] = useState(false);
  const [confirmDisarm, setConfirmDisarm] = useState(false);

  const triggerNum = Number(trigger) || 0;
  const holdingsNum = Number(holdings) || 0;
  const planned = plannedFloorUsd(holdingsNum, triggerNum);
  const dist = distanceToTriggerPct(coin.markPrice, triggerNum);
  const aboveMark = coin.markPrice != null && triggerNum >= coin.markPrice;
  const quick = useMemo(
    () => QUICK_DROPS.map((d) => ({ d, px: triggerFromMark(coin.markPrice, d) })),
    [coin.markPrice],
  );

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  };

  const fields = {
    triggerPrice: triggerNum,
    holdingsCoin: holdingsNum > 0 ? holdingsNum : undefined,
    trailPct: numOrNull(trailPct),
    recoveryPct: numOrNull(recoveryPct),
    tolerancePct: Number(tolerancePct) || 0,
    buyBack: mode === "sell" ? buyBack : undefined,
  };

  const submit = () =>
    floor
      ? run(() => collateralApi.update(floor.id, fields), `${coin.coin} floor updated`)
      : run(
          () =>
            collateralApi.arm({
              exchange: account.exchange,
              accountId: account.accountId,
              coin: coin.coin,
              mode,
              ...fields,
            }),
          `${coin.coin} floor armed at ${fmtPx(triggerNum)}`,
        );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {floor ? `${coin.coin} floor` : `Arm ${coin.coin} floor`}
          </DialogTitle>
          <DialogDescription className="font-mono text-[11px]">
            {accountLabel(account)} · mark {fmtPx(coin.markPrice)} · wallet {fmtCoin(coin.walletBalance)} {coin.coin}
          </DialogDescription>
        </DialogHeader>

        {confirmDisarm && floor ? (
          <div className="space-y-3 text-[12px]">
            <p>
              {floor.mode === "sell"
                ? "Cancels the resting sell on Bybit. The coins stay unprotected."
                : "Drops the trigger. The coins stay unprotected."}
            </p>
            <DialogFooter>
              <Button variant="ghost" disabled={busy} onClick={() => setConfirmDisarm(false)}>
                Back
              </Button>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => run(() => collateralApi.disarm(floor.id), `${coin.coin} floor disarmed`)}
              >
                Disarm
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-[11px]">Mode</Label>
              {floor ? (
                <p className="font-mono text-[11px]">
                  <span className="uppercase">{floor.mode}</span>
                  <span className="text-muted-foreground"> · to switch, disarm and arm again</span>
                </p>
              ) : (
                <Tabs value={mode} onValueChange={(v) => setMode(v as FloorMode)}>
                  <TabsList variant="line">
                    <TabsTrigger value="hedge" className="px-2">Hedge (short {coin.coin}USDT perp)</TabsTrigger>
                    <TabsTrigger value="sell" className="px-2">Sell (spot)</TabsTrigger>
                  </TabsList>
                </Tabs>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="floor-trigger" className="text-[11px]">Trigger price</Label>
              <Input
                id="floor-trigger"
                type="number"
                inputMode="decimal"
                value={trigger}
                onChange={(e) => setTrigger(e.target.value)}
                className="h-9 font-mono"
              />
              <div className="flex flex-wrap gap-1.5">
                {quick.map(({ d, px }) => (
                  <Button
                    key={d}
                    variant="outline"
                    size="sm"
                    disabled={px == null}
                    onClick={() => px != null && setTrigger(String(px))}
                    className="h-6 px-2 font-mono text-[10px]"
                  >
                    -{d} %
                  </Button>
                ))}
              </div>
              {aboveMark && (
                <p className="font-mono text-[11px] text-[var(--kb-amber)]">
                  Trigger sits at or above the mark and fires right away.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="floor-holdings" className="text-[11px]">Holdings ({coin.coin})</Label>
              <div className="flex gap-2">
                <Input
                  id="floor-holdings"
                  type="number"
                  inputMode="decimal"
                  value={holdings}
                  onChange={(e) => setHoldings(e.target.value)}
                  className="h-9 font-mono"
                />
                <Button
                  variant="outline"
                  className="h-9 shrink-0 font-mono"
                  onClick={() => setHoldings(String(Math.max(0, coin.walletBalance)))}
                >
                  Wallet
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="floor-trail" className="text-[11px]">Trail %</Label>
                <Input id="floor-trail" type="number" inputMode="decimal" placeholder="off" value={trailPct} onChange={(e) => setTrailPct(e.target.value)} className="h-8 font-mono" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="floor-recovery" className="text-[11px]">Recovery %</Label>
                <Input id="floor-recovery" type="number" inputMode="decimal" placeholder="manual" value={recoveryPct} onChange={(e) => setRecoveryPct(e.target.value)} className="h-8 font-mono" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="floor-tol" className="text-[11px]">Wick margin %</Label>
                <Input id="floor-tol" type="number" inputMode="decimal" value={tolerancePct} onChange={(e) => setTolerancePct(e.target.value)} className="h-8 font-mono" />
              </div>
            </div>

            {mode === "sell" && (
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="floor-buyback" className="text-[11px]">
                  Buy back on recovery
                </Label>
                <Switch id="floor-buyback" checked={buyBack} onCheckedChange={setBuyBack} />
              </div>
            )}

            <StatStrip
              size="sm"
              items={[
                { label: "Planned floor", value: planned > 0 ? fmtUsd(planned) : "—", focal: true },
                { label: "Distance", value: fmtPct(dist) },
                { label: "Ratio", value: fmtRatio(coin.collateralRatio) },
              ]}
            />

            {mode === "sell" && !floor && (
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Places a conditional spot sell on Bybit right away. A gap through the trigger fills lower.
              </p>
            )}

            {floor?.lastError && (
              <p className="font-mono text-[11px] text-[var(--kb-red)]">{floor.lastError}</p>
            )}

            <DialogFooter>
              {floor && (
                <Button variant="destructive" disabled={busy} onClick={() => setConfirmDisarm(true)} className="sm:mr-auto">
                  Disarm
                </Button>
              )}
              <Button variant="ghost" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={submit} disabled={busy || triggerNum <= 0}>
                {busy ? <RefreshCw className="size-4 animate-spin" /> : floor ? "Save" : `Arm at ${triggerNum > 0 ? fmtPx(triggerNum) : "trigger"}`}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

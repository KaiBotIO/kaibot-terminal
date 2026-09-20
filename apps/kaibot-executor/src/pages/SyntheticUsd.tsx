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
  Tabs,
  TabsList,
  TabsTrigger,
  useConfirm,
} from "@kaibot/shared";
import { AlertTriangle, Coins, Crosshair, RefreshCw, Shield, Layers } from "lucide-react";
import { toast } from "sonner";
import { skipOrderConfirmAtom } from "@/lib/atoms";
import {
  syntheticUsdApi,
  type SyntheticUsdPosition,
  type HoldingsBasis,
  type SyntheticUsdMutation,
} from "@/lib/synthetic-usd-api";
import { usePolledResource } from "@/hooks/usePolledResource";
import { apiFetch } from "@/lib/api";
import { accountKeyOf, accountQuery, connectionLabel, sessionKey } from "@/lib/connection";

const fmtUsd = (n: number) =>
  `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const fmtPx = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
const fmtPct = (n: number | null | undefined) => (n == null ? "—" : `${n.toFixed(2)}%`);
const numOrNull = (v: string) => (v.trim() === "" ? null : Number(v));
const fmtShort = (p: SyntheticUsdPosition) =>
  p.shortUnit === "coin"
    ? `${p.short_size.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${p.symbol.split(/[-_]/)[0]}`
    : fmtUsd(p.short_size);

// Deribit inverse perpetuals the guard supports; the venue account follows
// the coin (btc/eth), the connection label namespaces it (acct1/btc).
const MARKETS = ["BTC-PERPETUAL", "ETH-PERPETUAL"] as const;
const coinOf = (symbol: string) => symbol.split(/[-_]/)[0];

export interface MarketChoice {
  exchange: string;
  accountKey: string | null;
  symbol: string;
  coin: string;
  // Venue account id ('btc'); the backend namespaces it with accountKey.
  accountId: string;
  // Namespaced id as the rows carry it ('acct1/btc').
  rowAccountId: string;
}

interface SessionRow {
  exchangeName: string;
  label?: string | null;
  accountKey?: string | null;
  status: string;
}

function useConnections(): SessionRow[] {
  const [rows, setRows] = useState<SessionRow[]>([]);
  useEffect(() => {
    let alive = true;
    apiFetch("/api/exchanges/v2/sessions", { headers: { "x-user-id": "default" } })
      .then((r) => (r.ok ? r.json() : []))
      .then((list: SessionRow[]) => {
        if (!alive || !Array.isArray(list)) return;
        setRows(list.filter((r) => r.status === "connected"));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return rows;
}

const rowLabel = (p: SyntheticUsdPosition) => `${p.exchange}${p.accountKey ? ` · ${p.accountKey}` : ""}`;
const rowStatus = (p: SyntheticUsdPosition) =>
  p.status === "armed" ? "armed" : p.armed?.inCycle ? `open · cycle ${p.armed.cycle}` : "open";

export default function SyntheticUsd() {
  const { data, error, isStale, isLoading: loading, lastUpdated, refresh: load } =
    usePolledResource(
      async () => {
        const [list, basis] = await Promise.all([
          syntheticUsdApi.list(),
          syntheticUsdApi.holdingsBasis(),
        ]);
        return { list, basis };
      },
      { intervalMs: 5000 },
    );
  const list = data?.list ?? null;
  const basis = data?.basis ?? null;
  const rows = list?.positions ?? [];
  const leverageCap = list?.leverageCap ?? 2;
  const holdingsBasisUsd = basis?.total ?? list?.holdingsBasisUsd ?? 0;

  // Selection: a row id, or "new" for the add form. Falls back to the first
  // row when the selected one disappears (closed/disarmed).
  const [selectedId, setSelectedId] = useState<string | "new" | null>(null);
  const selected =
    selectedId === "new" ? null : rows.find((p) => p.id === selectedId) ?? rows[0] ?? null;
  const showForm = selectedId === "new" || (rows.length === 0 && !loading);

  // Mutation history of the selected row, polled alongside the list.
  const { data: detail, refresh: loadDetail } = usePolledResource(
    async () => (selected ? syntheticUsdApi.detail(selected.id) : null),
    { intervalMs: 5000, enabled: selected != null },
  );
  const selectedIdForDetail = selected?.id ?? null;
  useEffect(() => {
    if (selectedIdForDetail) void loadDetail();
  }, [selectedIdForDetail, loadDetail]);
  const mutations = detail?.position.id === selected?.id ? detail?.mutations ?? [] : [];

  const reload = () => {
    void load();
    void loadDetail();
  };

  const armedRows = rows.filter((p) => p.status === "armed");
  const openRows = rows.filter((p) => p.status === "open");
  const plannedTotal = armedRows.reduce((s, p) => s + (p.armed?.protectedUsd ?? 0), 0);
  const lockedTotal = openRows.reduce(
    (s, p) => s + (p.armed?.inCycle ? p.armed.protectedUsd ?? p.target_usd : p.target_usd),
    0,
  );
  const nearest = armedRows
    .map((p) => p.armed?.distanceToTriggerPct)
    .filter((d): d is number => d != null)
    .sort((a, b) => a - b)[0];
  const basisRows = rows.filter((p) => p.is_factor_basis === 1).length;
  const [mode, setMode] = useState<"mint" | "arm">("arm");

  return (
    <div className="flex flex-col text-foreground">
      <PageHeader
        title="Synthetic USD"
        description="Lock the USD value of your crypto holdings with a delta-neutral short on the inverse perpetual, now or at a price you set. One row per connection and market, tracked separately from your other positions."
        meta={
          rows.length > 0 ? (
            <div className="space-y-1.5">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  Floor across all rows
                </div>
                <div className="font-mono text-[22px] font-medium tabular-nums text-primary">
                  {fmtUsd(plannedTotal + lockedTotal)}
                </div>
              </div>
              <Badge variant="outline" className="font-mono text-[10px] uppercase">
                {armedRows.length} armed · {openRows.length} open · {basisRows} sizing
              </Badge>
            </div>
          ) : undefined
        }
        actions={
          rows.length > 0 ? (
            <Button variant="outline" size="sm" onClick={() => setSelectedId("new")}>
              <Crosshair className="size-3.5 mr-1" />
              Add
            </Button>
          ) : undefined
        }
      />

      {isStale && <StaleDataBanner updatedAt={lastUpdated} onRetry={load} />}

      {rows.length > 0 && (
        <StatStrip
          items={[
            { label: "Planned floor (armed)", value: fmtUsd(plannedTotal), focal: true },
            { label: "Locked floor (open)", value: fmtUsd(lockedTotal) },
            { label: "Rows", value: `${rows.length}` },
            {
              label: "Nearest trigger",
              value: fmtPct(nearest),
              valueClassName: nearest != null && nearest < 2 ? "text-[var(--kb-amber)]" : undefined,
            },
            { label: "Sizing bases", value: `${basisRows} / ${rows.length}` },
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
          description="The executor backend didn't respond. Open or armed rows may still exist."
          action={<Button onClick={load}>Retry</Button>}
        />
      ) : (
        <>
          {rows.length > 0 && (
            <OverviewTable rows={rows} selectedId={selected?.id ?? null} onSelect={(id) => setSelectedId(id)} />
          )}
          <div className="grid lg:grid-cols-5">
            <div className="lg:col-span-3">
              {showForm || !selected ? (
                <>
                  <div className="flex items-center justify-between border-b border-border px-6 py-2">
                    <Tabs value={mode} onValueChange={(v) => setMode(v as "mint" | "arm")}>
                      <TabsList variant="line">
                        <TabsTrigger value="arm" className="px-2">Arm at a price</TabsTrigger>
                        <TabsTrigger value="mint" className="px-2">Mint now</TabsTrigger>
                      </TabsList>
                    </Tabs>
                    {rows.length > 0 && (
                      <Button variant="ghost" size="sm" onClick={() => setSelectedId(rows[0].id)}>
                        Back to rows
                      </Button>
                    )}
                  </div>
                  {mode === "mint" ? (
                    <MintForm holdingsBasisUsd={holdingsBasisUsd} leverageCap={leverageCap} onMinted={reload} />
                  ) : (
                    <ArmForm leverageCap={leverageCap} existing={rows} onArmed={(id) => { setSelectedId(id); reload(); }} />
                  )}
                </>
              ) : selected.status === "open" ? (
                <OpenPosition
                  position={selected}
                  leverageCap={leverageCap}
                  rebalanceEnabled={list?.rebalanceEnabled ?? false}
                  mutations={mutations}
                  onChange={reload}
                />
              ) : (
                <ArmedPosition position={selected} mutations={mutations} onChange={reload} />
              )}
            </div>

            <div className="lg:col-span-2 lg:border-l lg:border-border">
              <HoldingsBasisCard basis={basis} loading={loading} onChange={load} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// Every synthetic row, one line per connection × market. Click selects.
function OverviewTable({
  rows,
  selectedId,
  onSelect,
}: {
  rows: SyntheticUsdPosition[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <Section label="Rows" meta={<span className="tabular-nums">{rows.length}</span>} flush>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px] font-mono">
          <thead>
            <tr className="text-[10px] uppercase tracking-widest text-muted-foreground">
              <th className="px-6 py-2 text-left font-normal">Connection</th>
              <th className="px-3 py-2 text-left font-normal">Market</th>
              <th className="px-3 py-2 text-left font-normal">Status</th>
              <th className="px-3 py-2 text-right font-normal">Holdings</th>
              <th className="px-3 py-2 text-right font-normal">Trigger</th>
              <th className="px-3 py-2 text-right font-normal">Mark</th>
              <th className="px-3 py-2 text-right font-normal">Distance</th>
              <th className="px-3 py-2 text-right font-normal">Floor</th>
              <th className="px-6 py-2 text-right font-normal">Sizing</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {rows.map((p) => {
              const a = p.armed;
              const active = p.id === selectedId;
              const floor = a?.inCycle ? a.protectedUsd ?? 0 : p.target_usd;
              return (
                <tr
                  key={p.id}
                  onClick={() => onSelect(p.id)}
                  className={`cursor-pointer transition-colors ${active ? "bg-primary/10" : "hover:bg-muted/40"}`}
                >
                  <td className="px-6 py-2">{rowLabel(p)}</td>
                  <td className="px-3 py-2">{p.symbol}</td>
                  <td className={`px-3 py-2 uppercase ${p.status === "armed" ? "text-[var(--kb-amber)]" : "text-[var(--kb-teal)]"}`}>
                    {rowStatus(p)}
                    {a?.lastError && <span className="ml-1 text-[var(--kb-red)]">!</span>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {a?.holdingsCoin != null ? `${a.holdingsCoin.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${coinOf(p.symbol)}` : "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtPx(a?.triggerPrice)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtPx(a?.mark)}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${a?.distanceToTriggerPct != null && a.distanceToTriggerPct < 2 ? "text-[var(--kb-amber)]" : ""}`}>
                    {p.status === "armed" ? fmtPct(a?.distanceToTriggerPct) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {fmtUsd(floor)}
                    <span className="ml-1 text-muted-foreground">{a?.protection ?? (p.status === "open" ? "locked" : "")}</span>
                  </td>
                  <td className="px-6 py-2 text-right">
                    {p.is_factor_basis === 1 ? (
                      <Badge variant="secondary" className="text-[9px] py-0 px-1 normal-case tracking-normal">
                        {p.sizingBasis?.kind ?? "on"}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">off</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

// Connection × market picker shared by the mint and arm forms.
function MarketPicker({
  value,
  onChange,
  taken,
}: {
  value: MarketChoice | null;
  onChange: (m: MarketChoice) => void;
  // Markets already carrying a live row per connection (disabled in the list).
  taken: Set<string>;
}) {
  const connections = useConnections();
  const [connKey, setConnKey] = useState<string>("");
  const [symbol, setSymbol] = useState<string>(MARKETS[0]);

  useEffect(() => {
    if (connections.length === 0) return;
    const current = connections.find((c) => sessionKey(c) === connKey);
    const conn = current ?? connections[0];
    if (!current) setConnKey(sessionKey(conn));
    const key = accountKeyOf(conn);
    const coin = coinOf(symbol);
    const accountId = coin.toLowerCase();
    const next: MarketChoice = {
      exchange: conn.exchangeName,
      accountKey: key,
      symbol,
      coin,
      accountId,
      rowAccountId: key ? `${key}/${accountId}` : accountId,
    };
    if (
      !value ||
      value.exchange !== next.exchange ||
      value.accountKey !== next.accountKey ||
      value.symbol !== next.symbol
    ) {
      onChange(next);
    }
  }, [connections, connKey, symbol, value, onChange]);

  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="space-y-1.5">
        <Label htmlFor="pick-conn" className="text-[11px]">Connection</Label>
        <select
          id="pick-conn"
          value={connKey}
          onChange={(e) => setConnKey(e.target.value)}
          className="h-9 w-full border border-border bg-background px-2 font-mono text-xs"
        >
          {connections.length === 0 && <option value="">no connected exchange</option>}
          {connections.map((c) => (
            <option key={sessionKey(c)} value={sessionKey(c)}>
              {connectionLabel(c)}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="pick-market" className="text-[11px]">Market</Label>
        <select
          id="pick-market"
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          className="h-9 w-full border border-border bg-background px-2 font-mono text-xs"
        >
          {MARKETS.map((m) => {
            const conn = connections.find((c) => sessionKey(c) === connKey);
            const key = conn ? accountKeyOf(conn) : null;
            const acct = key ? `${key}/${coinOf(m).toLowerCase()}` : coinOf(m).toLowerCase();
            const busy = conn ? taken.has(`${conn.exchangeName}|${acct}|${m}`) : false;
            return (
              <option key={m} value={m} disabled={busy}>
                {m}{busy ? " · already has a row" : ""}
              </option>
            );
          })}
        </select>
      </div>
    </div>
  );
}

// Coin balance of the venue account on the chosen connection: the holdings an
// armed row should carry (collateral, no unrealized P&L).
async function fetchAccountBalance(m: MarketChoice): Promise<number | null> {
  const res = await apiFetch(
    `/api/exchanges/v2/balances/${m.exchange}${accountQuery({ exchangeName: m.exchange, accountKey: m.accountKey })}`,
    { headers: { "x-user-id": "default" } },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as Array<{ accountId?: string; balance?: number; currency?: string }>;
  const row = rows.find(
    (b) => b.accountId === m.rowAccountId || (b.accountId === m.accountId && (b.currency ?? "").toUpperCase() === m.coin),
  );
  return row && typeof row.balance === "number" ? row.balance : null;
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
  const [market, setMarket] = useState<MarketChoice | null>(null);
  const { confirm, dialog } = useConfirm();

  const capNum = Number(cap);
  const effectiveCap = capNum > 0 ? capNum : leverageCap;
  const targetUsd = Number(target) || 0;
  const leverage = holdingsBasisUsd > 0 ? targetUsd / holdingsBasisUsd : 0;
  const overCap = leverage > effectiveCap;
  const maxTarget = holdingsBasisUsd * effectiveCap;

  const mint = async () => {
    if (targetUsd <= 0 || !market) return;
    const ok = await confirm({
      title: "Mint synthetic USD?",
      description: `Opens a delta-neutral short on ${market.symbol} (${market.exchange}${market.accountKey ? ` · ${market.accountKey}` : ""}).`,
      tone: "danger-money",
      summary: [
        { label: "Market", value: `${market.symbol} · ${market.rowAccountId}` },
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
      await syntheticUsdApi.mint({
        exchange: market.exchange,
        accountId: market.rowAccountId,
        symbol: market.symbol,
        targetUsd,
        leverageCap: effectiveCap,
      });
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
      <MarketPicker value={market} onChange={setMarket} taken={new Set()} />
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

      <Button onClick={mint} disabled={busy || targetUsd <= 0 || overCap || !market} className="w-full h-9">
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
  const cycle = position.armed?.inCycle ? position.armed : null;

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
          {position.symbol} · {rowLabel(position)}
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

      {cycle && <ArmCycleBlock position={position} onChange={onChange} busy={busy} />}

      <div className="-mx-6 border-t border-border/60">
        <SettingRow
          label={
            <span className="flex items-center gap-2">
              <Shield className="size-3.5 text-muted-foreground" />
              Synthetic mode
            </span>
          }
          description={`Every signal on ${position.exchange} · ${position.account_id} is sized against ${cycle ? `the realized floor (holdings × fill, ${fmtUsd(position.sizingBasis?.usd ?? (cycle.protectedUsd ?? 0))})` : "this USD value"} as if it were the account size, all markets, not just ${position.symbol}.${position.is_factor_basis === 1 && cycle ? ` Sizing basis: realized · ${fmtUsd(position.sizingBasis?.usd ?? 0)}.` : ""}`}
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
          description={`Keeps the short tracking ${rebalanceTargetPct || "—"}% of the holdings basis; orders fire automatically when drift exceeds the band.${position.is_factor_basis === 1 ? " This also moves your signal account size." : ""}${rebalanceEnabled ? "" : " Disabled on this executor (SYNTHETIC_REBALANCE_ENABLED)."}${cycle ? " Not available while the position is in an armed cycle." : ""}`}
          control={
            <Switch
              checked={position.auto_rebalance === 1}
              // Env gate is off → block arming a new one, but still let the user
              // disarm a position that was armed while the gate was on.
              disabled={busy || !!cycle || (!rebalanceEnabled && position.auto_rebalance !== 1)}
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
                    { label: "Short size", value: fmtShort(position) },
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
          const meta = parseMeta(m.meta);
          const auto = m.kind === "auto_rebalance" || (m.kind === "mint" && meta?.armed === true) || m.kind === "recovery_close";
          const armMeta =
            m.kind === "mint" && meta?.armed === true
              ? `trigger ${fmtPx(meta.trigger as number)} · planned ${fmtUsd(Number(meta.plannedUsd) || 0)}${meta.avgFillPrice ? ` · fill ${fmtPx(meta.avgFillPrice as number)}` : ""}${meta.adopted ? " · adopted" : ""}`
              : m.kind === "recovery_close"
                ? `past ${fmtPx(meta?.recoveryLevel as number)} · re-armed at ${fmtPx(meta?.reArmTrigger as number)}`
                : m.kind === "arm" || m.kind === "arm_update"
                  ? `trigger ${fmtPx((meta?.trigger ?? meta?.triggerPrice) as number)}${meta?.plannedUsd ? ` · planned ${fmtUsd(Number(meta.plannedUsd))}` : ""}`
                  : m.kind === "disarm" && meta?.shortKept
                    ? "short kept"
                    : null;
          return (
            <div key={m.id} className="flex items-center justify-between gap-2 text-[11px] font-mono">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className={`uppercase ${auto ? "text-[var(--kb-amber)]" : "text-muted-foreground"}`}>
                  {m.kind.replace(/_/g, " ")}
                </span>
                {auto && (
                  <Badge variant="outline" className="text-[9px] py-0 px-1 normal-case tracking-normal">
                    auto
                  </Badge>
                )}
                {armMeta && <span className="truncate text-muted-foreground">{armMeta}</span>}
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
          Holdings basis (mint now)
        </span>
      }
      meta={<span className="tabular-nums">{fmtUsd(basis?.total ?? 0)}</span>}
      noBorder
      bodyClassName="space-y-4"
    >
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Caps a manual mint and feeds the auto-rebalancer. Armed rows carry
        their own holdings per connection and market (the Holdings column
        above) and never read these lines.
      </p>
      {loading && lines.length === 0 ? (
        <div className="flex justify-center py-4">
          <RefreshCw className="size-4 animate-spin text-muted-foreground" />
        </div>
      ) : lines.length === 0 ? (
        <EmptyState
          icon={Layers}
          title="No basis lines"
          description="Only needed for a manual mint: add off-exchange holdings in USD below."
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

function parseMeta(meta: string | null): Record<string, unknown> | null {
  if (!meta) return null;
  try {
    return JSON.parse(meta) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Arm at a price: holdings × trigger is minted only once the mark breaches the
// trigger. Until then the holdings keep their upside.
function ArmForm({
  leverageCap,
  existing,
  onArmed,
}: {
  leverageCap: number;
  existing: SyntheticUsdPosition[];
  onArmed: (id: string) => void;
}) {
  const [market, setMarket] = useState<MarketChoice | null>(null);
  const [trigger, setTrigger] = useState("");
  const [holdings, setHoldings] = useState("");
  const [trailPct, setTrailPct] = useState("");
  const [recoveryPct, setRecoveryPct] = useState("0");
  const [tolerancePct, setTolerancePct] = useState("0.2");
  const [busy, setBusy] = useState(false);
  const [balanceBusy, setBalanceBusy] = useState(false);
  const { confirm, dialog } = useConfirm();

  const coin = market?.coin ?? "coin";
  const taken = new Set(existing.map((p) => `${p.exchange}|${p.account_id}|${p.symbol}`));
  const triggerNum = Number(trigger) || 0;
  const holdingsNum = Number(holdings) || 0;
  const planned = triggerNum * holdingsNum;

  const useBalance = async () => {
    if (!market) return;
    setBalanceBusy(true);
    try {
      const bal = await fetchAccountBalance(market);
      if (bal == null) toast.error(`No ${coin} balance found on ${market.rowAccountId}`);
      else setHoldings(String(bal));
    } finally {
      setBalanceBusy(false);
    }
  };

  const arm = async () => {
    if (triggerNum <= 0 || !market) return;
    const ok = await confirm({
      title: "Arm synthetic USD?",
      description: `Mints a short on ${market.symbol} (${market.rowAccountId}) at market when the mark drops below the trigger. A gap through the trigger fills lower.`,
      tone: "danger-money",
      summary: [
        { label: "Market", value: `${market.symbol} · ${market.rowAccountId}` },
        { label: "Trigger", value: fmtPx(triggerNum) },
        { label: "Holdings", value: holdingsNum > 0 ? `${holdingsNum} ${coin}` : "from account line" },
        { label: "Planned floor", value: planned > 0 ? fmtUsd(planned) : "holdings × trigger" },
        { label: "Trail", value: trailPct ? `${trailPct}%` : "off" },
        { label: "Recovery", value: recoveryPct ? `+${recoveryPct}% above trigger` : "manual" },
      ],
      confirmLabel: "Arm",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await syntheticUsdApi.arm({
        exchange: market.exchange,
        accountId: market.accountId,
        accountKey: market.accountKey,
        symbol: market.symbol,
        triggerPrice: triggerNum,
        holdingsCoin: holdingsNum > 0 ? holdingsNum : undefined,
        trailPct: numOrNull(trailPct),
        recoveryPct: numOrNull(recoveryPct),
        tolerancePct: Number(tolerancePct) || 0,
        leverageCap,
      });
      toast.success(`Armed ${market.symbol} at ${fmtPx(triggerNum)}`);
      onArmed(res.position.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Arm failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      label={
        <span className="flex items-center gap-1.5">
          <Crosshair className="size-3.5 text-primary" />
          Arm at a price
        </span>
      }
      bodyClassName="space-y-4"
    >
      <MarketPicker value={market} onChange={setMarket} taken={taken} />
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="arm-trigger" className="text-[11px]">Trigger price</Label>
          <Input
            id="arm-trigger"
            type="number"
            inputMode="decimal"
            placeholder="90000"
            value={trigger}
            onChange={(e) => setTrigger(e.target.value)}
            className="h-9 font-mono"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="arm-holdings" className="text-[11px]">Holdings ({coin})</Label>
          <div className="flex gap-2">
            <Input
              id="arm-holdings"
              type="number"
              inputMode="decimal"
              placeholder="from account line"
              value={holdings}
              onChange={(e) => setHoldings(e.target.value)}
              className="h-9 font-mono"
            />
            <Button
              variant="outline"
              disabled={!market || balanceBusy}
              onClick={useBalance}
              className="h-9 shrink-0 font-mono"
              title={market ? `Read the ${coin} balance of ${market.rowAccountId}` : undefined}
            >
              {balanceBusy ? <RefreshCw className="size-4 animate-spin" /> : "Use balance"}
            </Button>
          </div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="arm-trail" className="text-[11px]">Trail %</Label>
          <Input
            id="arm-trail"
            type="number"
            inputMode="decimal"
            placeholder="off"
            value={trailPct}
            onChange={(e) => setTrailPct(e.target.value)}
            className="h-9 font-mono"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="arm-recovery" className="text-[11px]">Recovery % above trigger</Label>
          <Input
            id="arm-recovery"
            type="number"
            inputMode="decimal"
            placeholder="manual"
            value={recoveryPct}
            onChange={(e) => setRecoveryPct(e.target.value)}
            className="h-9 font-mono"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="arm-tol" className="text-[11px]">Wick margin %</Label>
          <Input
            id="arm-tol"
            type="number"
            inputMode="decimal"
            value={tolerancePct}
            onChange={(e) => setTolerancePct(e.target.value)}
            className="h-9 font-mono"
          />
        </div>
      </div>

      <StatStrip
        size="sm"
        items={[
          { label: "Planned floor", value: planned > 0 ? fmtUsd(planned) : "—", focal: true },
          { label: "Holdings", value: holdingsNum > 0 ? `${holdingsNum} ${coin}` : "—" },
          { label: "Cap", value: `${leverageCap}x on ${coin} × mark` },
        ]}
      />

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Sized to holdings × trigger, placed at market on the breach: a gap through
        the trigger fills lower than planned. A trail moves the trigger up with the
        market, never down. A recovery level buys the short back once the mark
        climbs past it and re-arms the trigger.
      </p>

      <Button onClick={arm} disabled={busy || triggerNum <= 0 || !market} className="w-full h-9">
        {busy ? <RefreshCw className="size-4 animate-spin" /> : `Arm ${market?.symbol ?? ""} at ${triggerNum > 0 ? fmtPx(triggerNum) : "trigger"}`}
      </Button>
      {dialog}
    </Section>
  );
}

function ArmedPosition({
  position,
  mutations,
  onChange,
}: {
  position: SyntheticUsdPosition;
  mutations: SyntheticUsdMutation[];
  onChange: () => void;
}) {
  const a = position.armed;
  const [trigger, setTrigger] = useState(String(a.triggerPrice ?? ""));
  const [holdings, setHoldings] = useState(String(a.holdingsCoin ?? ""));
  const [trailPct, setTrailPct] = useState(a.trailPct != null ? String(a.trailPct) : "");
  const [recoveryPct, setRecoveryPct] = useState(a.recoveryPct != null ? String(a.recoveryPct) : "");
  const [tolerancePct, setTolerancePct] = useState(String(a.tolerancePct ?? 0));
  const [busy, setBusy] = useState(false);
  const [confirmDisarm, setConfirmDisarm] = useState(false);

  useEffect(() => {
    setTrigger(String(a.triggerPrice ?? ""));
  }, [a.triggerPrice]);

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

  const save = () =>
    act(
      () =>
        syntheticUsdApi.updateArm(position.id, {
          triggerPrice: Number(trigger) || undefined,
          holdingsCoin: Number(holdings) || undefined,
          trailPct: numOrNull(trailPct),
          recoveryPct: numOrNull(recoveryPct),
          tolerancePct: Number(tolerancePct) || 0,
        }),
      "Arm updated",
    );

  return (
    <Section
      label={
        <span className="flex items-center gap-1.5">
          <Crosshair className="size-3.5 text-primary" />
          Armed synthetic USD
        </span>
      }
      meta={
        <Badge variant="secondary" className="font-mono text-[10px] uppercase">
          {position.symbol} · {rowLabel(position)}
        </Badge>
      }
      bodyClassName="space-y-5"
    >
      <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-[11px] font-mono">
        <span className="text-muted-foreground">Trigger</span>
        <span className="tabular-nums text-right">
          {fmtPx(a.triggerPrice)}
          {a.triggerPriceInitial != null && a.triggerPriceInitial !== a.triggerPrice && (
            <span className="text-muted-foreground"> (from {fmtPx(a.triggerPriceInitial)})</span>
          )}
        </span>
        <span className="text-muted-foreground">Holdings</span>
        <span className="tabular-nums text-right">{a.holdingsCoin?.toFixed(4) ?? "—"} {coinOf(position.symbol)}</span>
        <span className="text-muted-foreground">Planned floor</span>
        <span className="tabular-nums text-right text-primary">{fmtUsd(a.protectedUsd ?? 0)}</span>
        <span className="text-muted-foreground">Mark</span>
        <span className="tabular-nums text-right">
          {fmtPx(a.mark)}
          {a.markAt && <span className="text-muted-foreground"> · {new Date(a.markAt).toLocaleTimeString()}</span>}
        </span>
        <span className="text-muted-foreground">Distance to trigger</span>
        <span className="tabular-nums text-right">{fmtPct(a.distanceToTriggerPct)}</span>
        <span className="text-muted-foreground">Upside above floor</span>
        <span className={`tabular-nums text-right ${(a.upsideUsd ?? 0) >= 0 ? "text-[var(--kb-green)]" : "text-[var(--kb-red)]"}`}>
          {fmtUsd(a.upsideUsd ?? 0)}
        </span>
        {a.highWater != null && a.trailPct != null && (
          <>
            <span className="text-muted-foreground">High water</span>
            <span className="tabular-nums text-right">{fmtPx(a.highWater)}</span>
          </>
        )}
        <span className="text-muted-foreground">Cycles so far</span>
        <span className="tabular-nums text-right">{a.cycle}</span>
        <span className="text-muted-foreground">Sizing basis</span>
        <span className="tabular-nums text-right">
          {position.is_factor_basis === 1
            ? `armed · ${fmtUsd(position.sizingBasis?.usd ?? a.protectedUsd ?? 0)}`
            : "off (contracts)"}
        </span>
      </div>

      {a.lastError && (
        <p className="text-[11px] font-mono text-[var(--kb-red)]">{a.lastError}</p>
      )}

      <div className="-mx-6 border-t border-border/60">
        <SettingRow
          label={
            <span className="flex items-center gap-2">
              <Shield className="size-3.5 text-muted-foreground" />
              Synthetic mode
            </span>
          }
          description={`Every signal on ${position.exchange} · ${position.account_id} is sized against the planned floor (holdings × trigger, ${fmtUsd(a.protectedUsd ?? 0)}) as if it were the account size; after the mint against the realized floor. Factor 1 = 1%.`}
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
      </div>

      <div className="space-y-3 border-t border-border/60 pt-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="armed-trigger" className="text-[11px]">Trigger price</Label>
            <Input id="armed-trigger" type="number" inputMode="decimal" value={trigger} onChange={(e) => setTrigger(e.target.value)} className="h-8 font-mono" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="armed-holdings" className="text-[11px]">Holdings ({coinOf(position.symbol)})</Label>
            <Input id="armed-holdings" type="number" inputMode="decimal" value={holdings} onChange={(e) => setHoldings(e.target.value)} className="h-8 font-mono" />
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1">
            <Label htmlFor="armed-trail" className="text-[11px]">Trail %</Label>
            <Input id="armed-trail" type="number" inputMode="decimal" placeholder="off" value={trailPct} onChange={(e) => setTrailPct(e.target.value)} className="h-8 font-mono" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="armed-recovery" className="text-[11px]">Recovery %</Label>
            <Input id="armed-recovery" type="number" inputMode="decimal" placeholder="manual" value={recoveryPct} onChange={(e) => setRecoveryPct(e.target.value)} className="h-8 font-mono" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="armed-tol" className="text-[11px]">Wick margin %</Label>
            <Input id="armed-tol" type="number" inputMode="decimal" value={tolerancePct} onChange={(e) => setTolerancePct(e.target.value)} className="h-8 font-mono" />
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" disabled={busy} onClick={save} className="h-8">
            Save
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => setConfirmDisarm(true)} className="h-8 ml-auto">
            Disarm
          </Button>
        </div>
      </div>

      {mutations.length > 0 && <MutationHistory mutations={mutations} />}

      {confirmDisarm && (
        <ConfirmDialog
          open
          onOpenChange={(o) => {
            if (!o) setConfirmDisarm(false);
          }}
          tone="destructive"
          title="Disarm synthetic USD?"
          description={`Nothing was minted. The trigger is dropped and the holdings stay unhedged.${position.is_factor_basis === 1 ? " Signals on this account fall back to plain contract sizing." : ""}`}
          summary={[
            { label: "Trigger", value: fmtPx(a.triggerPrice) },
            { label: "Planned floor", value: fmtUsd(a.protectedUsd ?? 0) },
          ]}
          confirmLabel="Disarm"
          onConfirm={() => act(() => syntheticUsdApi.disarm(position.id), "Disarmed")}
        />
      )}
    </Section>
  );
}

// Shown inside an open position that was minted by (or attached to) an arm
// cycle: realized floor, the recovery level, and a detach that keeps the short.
function ArmCycleBlock({
  position,
  onChange,
  busy,
}: {
  position: SyntheticUsdPosition;
  onChange: () => void;
  busy: boolean;
}) {
  const a = position.armed;
  const [recoveryPct, setRecoveryPct] = useState(a.recoveryPct != null ? String(a.recoveryPct) : "");
  const [recoveryPrice, setRecoveryPrice] = useState(a.recoveryPrice != null ? String(a.recoveryPrice) : "");
  const [saving, setSaving] = useState(false);
  const [confirmDetach, setConfirmDetach] = useState(false);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setSaving(true);
    try {
      await fn();
      toast.success(ok);
      onChange();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 rounded-sm border border-border/60 p-3">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
          <Crosshair className="size-3 text-primary" />
          Armed cycle {a.cycle}
        </span>
        <Badge variant="outline" className="font-mono text-[9px] uppercase">
          {a.protection === "realized" ? "realized" : "planned"}
        </Badge>
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-[11px] font-mono">
        <span className="text-muted-foreground">Fired at trigger</span>
        <span className="tabular-nums text-right">{fmtPx(a.firedTriggerPrice)}</span>
        <span className="text-muted-foreground">Fill</span>
        <span className="tabular-nums text-right">{fmtPx(a.firedPrice)}</span>
        <span className="text-muted-foreground">Floor (holdings × fill)</span>
        <span className="tabular-nums text-right text-primary">{fmtUsd(a.protectedUsd ?? 0)}</span>
        <span className="text-muted-foreground">Over-hedge (short − floor)</span>
        <span className={`tabular-nums text-right ${(a.overHedgeUsd ?? 0) > 0 ? "text-[var(--kb-amber)]" : ""}`}>
          {fmtUsd(a.overHedgeUsd ?? 0)}
        </span>
        <span className="text-muted-foreground">Mark</span>
        <span className="tabular-nums text-right">{fmtPx(a.mark)}</span>
        <span className="text-muted-foreground">Recovery level</span>
        <span className="tabular-nums text-right">{a.recoveryLevel != null ? fmtPx(a.recoveryLevel) : "manual"}</span>
        <span className="text-muted-foreground">Re-arms at</span>
        <span className="tabular-nums text-right">{fmtPx(a.firedTriggerPrice ?? a.triggerPrice)}</span>
      </div>
      <div className="flex items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor="cycle-recovery-pct" className="text-[11px]">Recovery %</Label>
          <Input id="cycle-recovery-pct" type="number" inputMode="decimal" placeholder="manual" value={recoveryPct} onChange={(e) => setRecoveryPct(e.target.value)} className="h-8 w-24 font-mono" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="cycle-recovery-price" className="text-[11px]">Recovery price</Label>
          <Input id="cycle-recovery-price" type="number" inputMode="decimal" placeholder="—" value={recoveryPrice} onChange={(e) => setRecoveryPrice(e.target.value)} className="h-8 w-28 font-mono" />
        </div>
        <Button
          variant="secondary"
          disabled={busy || saving}
          onClick={() =>
            run(
              () =>
                syntheticUsdApi.updateArm(position.id, {
                  recoveryPct: numOrNull(recoveryPct),
                  recoveryPrice: numOrNull(recoveryPrice),
                }),
              "Recovery updated",
            )
          }
          className="h-8"
        >
          Save
        </Button>
        <Button variant="outline" disabled={busy || saving} onClick={() => setConfirmDetach(true)} className="h-8 ml-auto">
          Detach
        </Button>
      </div>
      {a.lastError && <p className="text-[11px] font-mono text-[var(--kb-red)]">{a.lastError}</p>}
      {confirmDetach && (
        <ConfirmDialog
          open
          onOpenChange={(o) => {
            if (!o) setConfirmDetach(false);
          }}
          tone="destructive"
          title="Detach the armed cycle?"
          description="The short stays open as a plain synthetic USD position. It will no longer unwind on recovery or re-arm."
          confirmLabel="Detach"
          onConfirm={() => run(() => syntheticUsdApi.disarm(position.id), "Cycle detached")}
        />
      )}
    </div>
  );
}

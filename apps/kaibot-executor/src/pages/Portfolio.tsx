import { useMemo, useState, lazy, Suspense } from "react";
import {
  Button,
  DataFreshness,
  DataMatrix,
  EmptyState,
  PageHeader,
  QueryStateGate,
  Section,
  StaleDataBanner,
  StatStrip,
  Tabs,
  TabsList,
  TabsTrigger,
  downloadCsv,
  toCsv,
} from "@kaibot/shared";
import { Wallet, TrendingUp, Activity, Link2, PieChart, LineChart, Layers, Download } from "@/lib/icons";
import { useAtomValue } from "jotai";
import {
  exchangeSessionsAtom,
  balancesAtom,
  positionsAtom,
} from "@/lib/atoms";
import { fmtSignedUsd, fmtUsd, portfolioFigures } from "@/lib/portfolio-figures";
import { useBrokerData } from "@/hooks/useBrokerData";
import { usePolledResource } from "@/hooks/usePolledResource";
import { syntheticUsdApi } from "@/lib/synthetic-usd-api";
import { useEquityHistory, type EquityRange } from "@/hooks/useEquityHistory";

const AllocationDonut = lazy(() =>
  import("./DashboardCharts").then((m) => ({ default: m.AllocationDonut })),
);
const EquityCurve = lazy(() =>
  import("./DashboardCharts").then((m) => ({ default: m.EquityCurve })),
);

const DONUT_COLORS = [
  "hsl(var(--chart-1))",
  "var(--kb-blue)",
  "var(--kb-green)",
  "var(--kb-red)",
  "var(--kb-violet)",
  "var(--kb-amber)",
  "var(--kb-teal)",
];

export default function Portfolio() {
  const { isLoading, isStale, error, lastUpdated, refresh } = useBrokerData();
  const positions = useAtomValue(positionsAtom);
  const balances = useAtomValue(balancesAtom);
  const exchangeSessions = useAtomValue(exchangeSessionsAtom);
  const [equityRange, setEquityRange] = useState<EquityRange>("1M");
  const {
    equityData,
    error: equityError,
    refresh: refreshEquity,
  } = useEquityHistory(equityRange);

  // Every figure in USD: coin wallets at the mark the backend attached,
  // inverse contracts at their contract count, coin P&L at the mark.
  const figures = useMemo(
    () => portfolioFigures({ sessions: exchangeSessions, balances, positions }),
    [exchangeSessions, balances, positions],
  );
  const {
    totalEquity,
    equityComplete,
    unrealizedPnL,
    pnlComplete,
    openPositions,
    totalNotional,
    allocation: allocationData,
    connectedCount,
    sessionCount,
    exchanges: exchangeBreakdown,
  } = figures;

  // Synthetic USD floors: its own entity, never merged into the positions
  // above. Planned = armed rows (holdings × trigger, conditional); realized =
  // minted shorts (holdings × fill for an arm cycle, the target otherwise).
  const { data: synthetic } = usePolledResource(() => syntheticUsdApi.list(), { intervalMs: 15000 });
  const syntheticRows = synthetic?.positions ?? [];
  const plannedFloor = syntheticRows
    .filter((p) => p.status === "armed")
    .reduce((sum, p) => sum + (p.armed?.protectedUsd ?? 0), 0);
  const realizedFloor = syntheticRows
    .filter((p) => p.status === "open")
    .reduce((sum, p) => sum + (p.armed?.inCycle ? (p.armed.protectedUsd ?? p.target_usd) : p.target_usd), 0);

  const exportCsv = () => {
    downloadCsv(
      "portfolio.csv",
      toCsv(exchangeBreakdown, [
        { header: "Exchange", value: (r) => r.exchange },
        { header: "Equity USD", value: (r) => r.equity.toFixed(2) },
        { header: "Equity complete", value: (r) => (r.equityComplete ? "yes" : "no") },
        { header: "Wallets", value: (r) => r.wallets },
        { header: "Exposure USD", value: (r) => r.exposure.toFixed(2) },
        { header: "Unrealized USD", value: (r) => r.unrealizedPnL.toFixed(2) },
        { header: "Positions", value: (r) => r.positions },
        {
          header: "Share %",
          value: (r) => (totalEquity > 0 ? ((r.equity / totalEquity) * 100).toFixed(1) : "0"),
        },
      ]),
    );
  };

  return (
    <div className="flex flex-col text-foreground">
      <PageHeader
        title="Portfolio"
        description="Equity, allocation and exposure across your connected broker accounts."
        meta={
          <div className="flex flex-col items-end gap-1">
            <div className="font-mono text-[28px] font-medium leading-none tabular-nums">
              {fmtUsd(totalEquity, equityComplete)}
            </div>
            <div
              className={`font-mono text-[11px] tabular-nums ${
                unrealizedPnL >= 0 ? "text-[var(--kb-green)]" : "text-[var(--kb-red)]"
              }`}
            >
              {fmtSignedUsd(unrealizedPnL, pnlComplete)} unrealized
            </div>
          </div>
        }
        actions={
          <div className="flex items-center gap-2">
            <DataFreshness
              updatedAt={lastUpdated}
              isRefreshing={isLoading}
              onRefresh={refresh}
            />
            {exchangeBreakdown.length > 0 && (
              <Button onClick={exportCsv} size="sm" variant="outline">
                <Download className="size-3.5 mr-1" />
                Export CSV
              </Button>
            )}
          </div>
        }
      />

      {isStale && <StaleDataBanner updatedAt={lastUpdated} onRetry={refresh} />}

      <StatStrip
        items={[
          {
            label: "Total Equity",
            value: fmtUsd(totalEquity, equityComplete),
            caption: equityComplete ? "USD, coin at venue mark" : "a wallet has no mark yet",
            icon: Wallet,
            focal: true,
          },
          {
            label: "Unrealized P&L",
            value: fmtSignedUsd(unrealizedPnL, pnlComplete),
            icon: TrendingUp,
            valueClassName:
              unrealizedPnL >= 0 ? "text-[var(--kb-green)]" : "text-[var(--kb-red)]",
          },
          {
            label: "Open Positions",
            value: openPositions,
            icon: Activity,
          },
          {
            label: "Total Notional",
            value: fmtUsd(totalNotional, true, 0),
            icon: PieChart,
          },
          {
            label: "Connected Exchanges",
            value: (
              <>
                {connectedCount}
                <span className="text-sm text-muted-foreground font-normal">
                  {" "}
                  / {sessionCount}
                </span>
              </>
            ),
            icon: Link2,
          },
        ]}
      />

      <Section
        label="Equity Curve"
        actions={
          <Tabs
            value={equityRange}
            onValueChange={(v) => setEquityRange(v as EquityRange)}
          >
            <TabsList variant="line">
              {(["1W", "1M", "3M", "1Y", "ALL"] as EquityRange[]).map((r) => (
                <TabsTrigger key={r} value={r} className="px-2">
                  {r}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        }
      >
        {equityData.length === 0 ? (
          <div className="h-[340px] flex items-center justify-center">
            <QueryStateGate
              isLoading={false}
              isError={equityError != null}
              onRetry={refreshEquity}
              errorTitle="Couldn't load equity history"
            >
              <EmptyState
                className="py-0"
                icon={LineChart}
                title="No equity history yet"
                description="The curve builds up as the executor records balance snapshots."
              />
            </QueryStateGate>
          </div>
        ) : (
          <div className="h-[340px]">
            <Suspense fallback={<div className="h-full" />}>
              <EquityCurve equityData={equityData} />
            </Suspense>
          </div>
        )}
      </Section>

      <div className="grid border-b border-border lg:grid-cols-3">
        <Section
          noBorder
          flush
          label="Per-Exchange Breakdown"
          className="border-b border-border lg:col-span-2 lg:border-b-0"
        >
          {exchangeBreakdown.length === 0 ? (
            <QueryStateGate
              isLoading={false}
              isError={error != null}
              onRetry={refresh}
              errorTitle="Couldn't load portfolio data"
              errorDescription="The executor backend didn't respond. Your accounts may still hold funds and positions."
            >
              <EmptyState
                className="py-12"
                icon={Layers}
                title="No connected exchanges"
                description="Connect an exchange to see its equity and exposure here."
              />
            </QueryStateGate>
          ) : (
            <DataMatrix
              rows={exchangeBreakdown}
              rowKey={(row) => row.key}
              defaultSort={{ key: "equity", dir: "desc" }}
              columns={[
                {
                  key: "exchange",
                  header: "Exchange",
                  sortable: true,
                  sortAccessor: (row) => row.exchange,
                  cell: (row) => (
                    <span className="capitalize text-foreground">{row.exchange}</span>
                  ),
                },
                {
                  key: "equity",
                  header: "Equity",
                  align: "right",
                  sortable: true,
                  sortAccessor: (row) => row.equity,
                  cell: (row) => (
                    <div className="flex flex-col items-end">
                      <span className="font-mono">{fmtUsd(row.equity, row.equityComplete)}</span>
                      {row.wallets && (
                        <span className="font-mono text-[10px] text-muted-foreground">{row.wallets}</span>
                      )}
                    </div>
                  ),
                },
                {
                  key: "exposure",
                  header: "Exposure",
                  align: "right",
                  sortable: true,
                  sortAccessor: (row) => row.exposure,
                  cell: (row) => (
                    <div className="flex flex-col items-end">
                      <span className="font-mono text-muted-foreground">{fmtUsd(row.exposure)}</span>
                      {row.positions > 0 && (
                        <span
                          className={`font-mono text-[10px] ${
                            row.unrealizedPnL >= 0 ? "text-[var(--kb-green)]" : "text-[var(--kb-red)]"
                          }`}
                        >
                          {fmtSignedUsd(row.unrealizedPnL, row.pnlComplete)} · {row.positions} open
                        </span>
                      )}
                    </div>
                  ),
                },
                {
                  key: "share",
                  header: "Share",
                  align: "right",
                  cell: (row) => {
                    const share =
                      totalEquity > 0 ? (row.equity / totalEquity) * 100 : 0;
                    return (
                      <div className="flex items-center justify-end gap-2">
                        <div className="h-0.5 w-16 bg-border">
                          <div
                            className="h-full bg-[var(--kb-teal)]"
                            style={{ width: `${Math.min(share, 100)}%` }}
                          />
                        </div>
                        <span className="font-mono text-[var(--kb-teal)] tabular-nums">
                          {share.toFixed(0)}%
                        </span>
                      </div>
                    );
                  },
                },
              ]}
            />
          )}
        </Section>

        <Section noBorder label="Allocation" className="lg:border-l lg:border-border">
          {allocationData.length === 0 ? (
            <div className="h-[260px] flex items-center justify-center">
              <EmptyState
                className="py-0"
                icon={PieChart}
                title="No open positions"
                description="Allocation shows up once a position is open."
              />
            </div>
          ) : (
            <>
              <div className="relative h-[220px]">
                <Suspense fallback={<div className="h-full" />}>
                  <AllocationDonut allocationData={allocationData} colors={DONUT_COLORS} />
                </Suspense>
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                  <div className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">
                    Notional
                  </div>
                  <div className="font-mono text-xl font-semibold tabular-nums">
                    {fmtUsd(totalNotional, true, 0)}
                  </div>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-1.5">
                {allocationData.slice(0, 8).map((a, idx) => (
                  <div key={a.symbol} className="flex items-center gap-1.5 min-w-0">
                    <span
                      className="size-2 rounded-full flex-shrink-0"
                      style={{ backgroundColor: DONUT_COLORS[idx % DONUT_COLORS.length] }}
                    />
                    <span className="font-mono text-[10px] text-foreground truncate">
                      {a.symbol}
                    </span>
                    <span className="font-mono text-[10px] text-muted-foreground ml-auto flex-shrink-0">
                      {((a.notional / totalNotional) * 100).toFixed(0)}%
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </Section>
      </div>

      {syntheticRows.length > 0 && (
        <Section
          label="Synthetic USD"
          meta={
            <span className="tabular-nums">
              {realizedFloor > 0 && `$${realizedFloor.toFixed(0)} locked`}
              {realizedFloor > 0 && plannedFloor > 0 && " · "}
              {plannedFloor > 0 && `$${plannedFloor.toFixed(0)} planned`}
            </span>
          }
        >
          <div className="divide-y divide-border/60">
            {syntheticRows.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-3 py-2 text-[11px] font-mono">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="uppercase text-muted-foreground">{p.exchange}</span>
                  <span className="truncate">{p.symbol}</span>
                  <span
                    className={`uppercase ${p.status === "armed" ? "text-[var(--kb-amber)]" : "text-[var(--kb-teal)]"}`}
                  >
                    {p.status === "armed" ? "armed" : p.armed?.inCycle ? `cycle ${p.armed.cycle}` : "open"}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-4 tabular-nums">
                  {p.status === "armed" ? (
                    <>
                      <span className="text-muted-foreground">trigger {p.armed.triggerPrice?.toLocaleString()}</span>
                      <span className="text-muted-foreground">
                        {p.armed.distanceToTriggerPct != null ? `${p.armed.distanceToTriggerPct.toFixed(2)}% away` : ""}
                      </span>
                      <span>${(p.armed.protectedUsd ?? 0).toFixed(0)} planned</span>
                    </>
                  ) : (
                    <>
                      <span className="text-muted-foreground">
                        short {p.shortUnit === "coin" ? `${p.short_size.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${p.symbol.split(/[-_]/)[0]}` : `$${p.short_size.toLocaleString()}`}
                      </span>
                      <span>${(p.armed?.inCycle ? p.armed.protectedUsd ?? p.target_usd : p.target_usd).toFixed(0)} locked</span>
                    </>
                  )}
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

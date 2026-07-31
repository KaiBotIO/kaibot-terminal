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
import { useBrokerData } from "@/hooks/useBrokerData";
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

  const totalEquity = useMemo(
    () =>
      Array.from(balances.values())
        .flat()
        .reduce((sum, b) => sum + (b.equity || 0), 0),
    [balances],
  );

  const unrealizedPnL = useMemo(
    () => positions.reduce((sum, p) => sum + (p.unrealizedPnL || 0), 0),
    [positions],
  );

  const connectedCount = exchangeSessions.filter(
    (e) => e.status === "connected",
  ).length;

  const allocationData = useMemo(() => {
    const bySymbol = new Map<string, number>();
    for (const p of positions) {
      const notional = Math.abs((p.size || 0) * (p.markPrice || p.entryPrice || 0));
      if (notional <= 0) continue;
      bySymbol.set(p.symbol, (bySymbol.get(p.symbol) ?? 0) + notional);
    }
    return Array.from(bySymbol.entries())
      .map(([symbol, notional]) => ({ symbol, notional }))
      .sort((a, b) => b.notional - a.notional);
  }, [positions]);

  const totalNotional = allocationData.reduce((sum, a) => sum + a.notional, 0);

  // Per-exchange equity + open-position exposure, built from the balance map
  // and the exchange-tagged positions.
  const exchangeBreakdown = useMemo(() => {
    const rows = exchangeSessions
      .filter((s) => s.status === "connected")
      .map((s) => {
        const eq = (balances.get(s.exchangeName) || []).reduce(
          (sum, b) => sum + (b.equity || 0),
          0,
        );
        const exposure = positions
          .filter((p) => p.exchange === s.exchangeName)
          .reduce(
            (sum, p) =>
              sum + Math.abs((p.size || 0) * (p.markPrice || p.entryPrice || 0)),
            0,
          );
        return { exchange: s.exchangeName, equity: eq, exposure };
      });
    return rows.sort((a, b) => b.equity - a.equity);
  }, [exchangeSessions, balances, positions]);

  const exportCsv = () => {
    downloadCsv(
      "portfolio.csv",
      toCsv(exchangeBreakdown, [
        { header: "Exchange", value: (r) => r.exchange },
        { header: "Equity", value: (r) => r.equity.toFixed(2) },
        { header: "Exposure", value: (r) => r.exposure.toFixed(2) },
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
              ${totalEquity.toFixed(2)}
            </div>
            <div
              className={`font-mono text-[11px] tabular-nums ${
                unrealizedPnL >= 0 ? "text-[var(--kb-green)]" : "text-[var(--kb-red)]"
              }`}
            >
              {unrealizedPnL >= 0 ? "+" : "-"}${Math.abs(unrealizedPnL).toFixed(2)} unrealized
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
            value: `$${totalEquity.toFixed(2)}`,
            icon: Wallet,
            focal: true,
          },
          {
            label: "Unrealized P&L",
            value: `${unrealizedPnL >= 0 ? "+" : "-"}$${Math.abs(unrealizedPnL).toFixed(2)}`,
            icon: TrendingUp,
            valueClassName:
              unrealizedPnL >= 0 ? "text-[var(--kb-green)]" : "text-[var(--kb-red)]",
          },
          {
            label: "Open Positions",
            value: positions.length,
            icon: Activity,
          },
          {
            label: "Total Notional",
            value: `$${totalNotional.toFixed(0)}`,
            icon: PieChart,
          },
          {
            label: "Connected Exchanges",
            value: (
              <>
                {connectedCount}
                <span className="text-sm text-muted-foreground font-normal">
                  {" "}
                  / {exchangeSessions.length}
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
              rowKey={(row) => row.exchange}
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
                    <span className="font-mono">${row.equity.toFixed(2)}</span>
                  ),
                },
                {
                  key: "exposure",
                  header: "Exposure",
                  align: "right",
                  sortable: true,
                  sortAccessor: (row) => row.exposure,
                  cell: (row) => (
                    <span className="font-mono text-muted-foreground">
                      ${row.exposure.toFixed(2)}
                    </span>
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
                    ${totalNotional.toFixed(0)}
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
    </div>
  );
}

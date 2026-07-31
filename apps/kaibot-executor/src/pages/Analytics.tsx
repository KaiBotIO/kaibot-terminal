import { lazy, Suspense, useEffect, useState } from "react";
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
import { BarChart2, Clock, Download, Layers, LineChart, Target, TrendingDown, TrendingUp, Trophy } from "@/lib/icons";
import { usePolledResource } from "@/hooks/usePolledResource";
import { apiFetch } from "@/lib/api";

const CumulativePnlChart = lazy(() =>
  import("./DashboardCharts").then((m) => ({ default: m.CumulativePnlChart })),
);
const TradeDistributionChart = lazy(() =>
  import("./DashboardCharts").then((m) => ({ default: m.TradeDistributionChart })),
);

type Timeframe = "1W" | "1M" | "3M" | "1Y" | "ALL";

interface AnalyticsSummary {
  hasData: boolean;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number | null;
  profitFactor: number | null;
  maxDrawdownPct: number | null;
  maxDrawdownAbs: number | null;
  avgTradeDurationMs: number | null;
  netPnl: number;
}

interface ClosedTrade {
  symbol: string;
  direction: "long" | "short";
  entryAvg: number | null;
  exitAvg: number | null;
  netPnl: number;
  durationMs: number;
  closedAt: number;
}

interface AnalyticsResponse {
  timeframe: string;
  basis: string;
  summary: AnalyticsSummary;
  cumulativePnl: { ts: number; pnl: number }[];
  distribution: { market: string; trades: number; netPnl: number }[];
  closedTrades: ClosedTrade[];
}

const money = (v: number) => `${v >= 0 ? "+" : "-"}$${Math.abs(v).toFixed(2)}`;
const pnlClass = (v: number) => (v >= 0 ? "text-[var(--kb-green)]" : "text-[var(--kb-red)]");
const price = (v: number | null) =>
  v == null ? "—" : v.toLocaleString(undefined, { maximumFractionDigits: 2 });

function pct(v: number | null): string {
  return v == null ? "—" : `${(v * 100).toFixed(1)}%`;
}

function profitFactor(v: number | null): string {
  if (v == null) return "—";
  if (!Number.isFinite(v)) return "∞";
  return v.toFixed(2);
}

function duration(ms: number | null): string {
  if (ms == null) return "—";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export default function Analytics() {
  const [timeframe, setTimeframe] = useState<Timeframe>("ALL");
  const { data, error, isStale, isLoading, lastUpdated, refresh } =
    usePolledResource<AnalyticsResponse>(
      () =>
        apiFetch(`/api/performance/analytics?timeframe=${timeframe}`).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        }),
      { intervalMs: 60_000 },
    );

  // Refetch immediately when the timeframe changes (the poll interval alone would
  // only pick it up on the next tick).
  useEffect(() => {
    refresh();
  }, [timeframe, refresh]);

  const summary = data?.summary;
  const hasData = summary?.hasData ?? false;

  const exportCsv = () => {
    if (!data) return;
    const csv = toCsv(data.distribution, [
      { header: "Market", value: (d) => d.market },
      { header: "Trades", value: (d) => d.trades },
      { header: "Net P&L", value: (d) => d.netPnl.toFixed(2) },
    ]);
    downloadCsv(`analytics-${timeframe.toLowerCase()}.csv`, csv);
  };

  return (
    <div className="space-y-0">
      <PageHeader
        title="Analytics"
        description="Win rate, profit factor, drawdown and P&L by market, computed on your executor from your own fills. Nothing leaves the machine."
        meta={<DataFreshness updatedAt={lastUpdated} isRefreshing={isLoading} onRefresh={refresh} />}
        actions={
          <div className="flex items-center gap-2">
            <Tabs value={timeframe} onValueChange={(v) => setTimeframe(v as Timeframe)}>
              <TabsList variant="line">
                {(["1W", "1M", "3M", "1Y", "ALL"] as Timeframe[]).map((r) => (
                  <TabsTrigger key={r} value={r} className="px-2">
                    {r}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            {hasData && (
              <Button onClick={exportCsv} size="sm" variant="outline">
                <Download className="size-3.5 mr-1" />
                Export CSV
              </Button>
            )}
          </div>
        }
      />

      {isStale && <StaleDataBanner updatedAt={lastUpdated} onRetry={refresh} />}

      {!hasData ? (
        <Section flush noBorder>
          <QueryStateGate
            isLoading={isLoading}
            isError={error != null}
            onRetry={refresh}
            errorTitle="Couldn't load analytics"
            errorDescription="The executor backend didn't respond. Your fills are safe on disk."
          >
            <EmptyState
              icon={BarChart2}
              title="No closed trades yet"
              description="Close a position and its result shows up here. All computed locally from your fills, no portfolio sharing needed."
            />
          </QueryStateGate>
        </Section>
      ) : (
        <>
          <StatStrip
            items={[
              {
                label: "Net P&L",
                value: money(summary!.netPnl),
                icon: TrendingUp,
                focal: true,
                valueClassName: pnlClass(summary!.netPnl),
                caption: "realized · net of fees",
              },
              {
                label: "Win Rate",
                value: pct(summary!.winRate),
                icon: Target,
                caption: `${summary!.winningTrades}W / ${summary!.losingTrades}L`,
              },
              {
                label: "Profit Factor",
                value: profitFactor(summary!.profitFactor),
                icon: Trophy,
                hint: "Gross profit divided by gross loss. Above 1 means winners outweigh losers.",
              },
              {
                label: "Max Drawdown",
                value: pct(summary!.maxDrawdownPct),
                icon: TrendingDown,
                valueClassName: "text-[var(--kb-red)]",
                caption:
                  summary!.maxDrawdownAbs != null
                    ? summary!.maxDrawdownPct == null
                      ? `${money(summary!.maxDrawdownAbs)}, no peak to measure against yet`
                      : money(summary!.maxDrawdownAbs)
                    : undefined,
                hint: "Largest drop from a peak on the cumulative realized-P&L curve. The percentage needs a positive peak first.",
              },
              {
                label: "Avg Duration",
                value: duration(summary!.avgTradeDurationMs),
                icon: Clock,
              },
              {
                label: "Trades",
                value: summary!.totalTrades,
                icon: Layers,
              },
            ]}
          />

          <Section label="Cumulative P&L">
            {data && data.cumulativePnl.length > 0 ? (
              <div className="h-[340px]">
                <Suspense fallback={<div className="h-full" />}>
                  <CumulativePnlChart data={data.cumulativePnl} />
                </Suspense>
              </div>
            ) : (
              <div className="h-[340px] flex items-center justify-center">
                <EmptyState
                  className="py-0"
                  icon={LineChart}
                  title="Nothing to chart yet"
                  description="The curve builds up as closed trades accumulate."
                />
              </div>
            )}
          </Section>

          <Section label="Distribution by Market">
            {data && data.distribution.length > 0 ? (
              <div className="h-[300px]">
                <Suspense fallback={<div className="h-full" />}>
                  <TradeDistributionChart data={data.distribution} />
                </Suspense>
              </div>
            ) : (
              <div className="h-[300px] flex items-center justify-center">
                <EmptyState
                  className="py-0"
                  icon={BarChart2}
                  title="No market breakdown yet"
                  description="Net P&L per market appears once trades close."
                />
              </div>
            )}
          </Section>

          <Section label="Closed trades" flush>
            {data && data.closedTrades.length > 0 ? (
              <DataMatrix
                rows={data.closedTrades}
                rowKey={(t, i) => `${t.symbol}-${t.closedAt}-${i}`}
                defaultSort={{ key: "closedAt", dir: "desc" }}
                columns={[
                  {
                    key: "symbol",
                    header: "Market",
                    sortable: true,
                    sortAccessor: (t) => t.symbol,
                    cell: (t) => <span className="font-mono text-xs">{t.symbol}</span>,
                  },
                  {
                    key: "direction",
                    header: "Side",
                    sortable: true,
                    sortAccessor: (t) => t.direction,
                    cell: (t) => (
                      <span className="inline-flex items-center gap-1 font-mono text-xs uppercase text-muted-foreground">
                        {t.direction === "long" ? (
                          <TrendingUp className="size-3" />
                        ) : (
                          <TrendingDown className="size-3" />
                        )}
                        {t.direction}
                      </span>
                    ),
                  },
                  {
                    key: "entry",
                    header: "Entry",
                    align: "right",
                    sortable: true,
                    sortAccessor: (t) => t.entryAvg,
                    cell: (t) => <span className="font-mono text-xs">{price(t.entryAvg)}</span>,
                  },
                  {
                    key: "exit",
                    header: "Exit",
                    align: "right",
                    sortable: true,
                    sortAccessor: (t) => t.exitAvg,
                    cell: (t) => <span className="font-mono text-xs">{price(t.exitAvg)}</span>,
                  },
                  {
                    key: "pnl",
                    header: "Net P&L",
                    align: "right",
                    sortable: true,
                    sortAccessor: (t) => t.netPnl,
                    cell: (t) => (
                      <span className={`font-mono text-xs ${pnlClass(t.netPnl)}`}>{money(t.netPnl)}</span>
                    ),
                  },
                  {
                    key: "duration",
                    header: "Duration",
                    align: "right",
                    sortable: true,
                    sortAccessor: (t) => t.durationMs,
                    cell: (t) => (
                      <span className="font-mono text-xs text-muted-foreground">{duration(t.durationMs)}</span>
                    ),
                  },
                  {
                    key: "closedAt",
                    header: "Closed",
                    align: "right",
                    sortable: true,
                    sortAccessor: (t) => t.closedAt,
                    cell: (t) => (
                      <span className="font-mono text-xs text-muted-foreground">
                        {new Date(t.closedAt).toLocaleString()}
                      </span>
                    ),
                  },
                ]}
              />
            ) : (
              <div className="py-10 flex items-center justify-center">
                <EmptyState
                  className="py-0"
                  icon={Layers}
                  title="No closed trades in range"
                  description="Individual closed trades show up here for the selected timeframe."
                />
              </div>
            )}
          </Section>
        </>
      )}
    </div>
  );
}

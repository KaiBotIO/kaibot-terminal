import { lazy, Suspense, useCallback, useEffect, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
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
  type MatrixColumn,
} from "@kaibot/shared";
import { BarChart2, Clock, Coins, Download, Layers, LineChart, Target, TrendingDown, TrendingUp, Trophy } from "@/lib/icons";
import { usePolledResource } from "@/hooks/usePolledResource";
import {
  EquitySparkline,
  type AccountScorecard,
  type ScorecardSummary,
  type StrategyScorecard,
} from "@/components/StrategyScorecard";
import { apiFetch } from "@/lib/api";
import {
  AnalyticsFilterBar,
  EMPTY_FILTER,
  isFilterActive,
  type AnalyticsFilterOptions,
  type AnalyticsFilterState,
  type Direction,
} from "@/components/AnalyticsFilterBar";

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
  /** The pct above is the -100% floor, not the measurement. */
  maxDrawdownPctClamped?: boolean;
  maxDrawdownAbs: number | null;
  avgTradeDurationMs: number | null;
  netPnl: number;
  /** netPnl = grossPnl - commission. */
  grossPnl?: number;
  commission?: number;
}

interface ClosedTrade {
  symbol: string;
  direction: "long" | "short";
  accountId?: string | null;
  exchange?: string | null;
  entryAvg: number | null;
  exitAvg: number | null;
  netPnl: number;
  grossPnl?: number;
  commission?: number;
  durationMs: number;
  closedAt: number;
}

interface AnalyticsResponse {
  timeframe: string;
  basis: string;
  /** Choices for the filter bar, from the whole ledger. */
  filterOptions?: AnalyticsFilterOptions;
  /** Closed trades before filtering, so the page can say what it hid. */
  totalClosedTrades?: number;
  /** Closed positions with no recorded exit fill — no result to compute, so
   *  they sit outside every metric below. Counted over the whole ledger. */
  unpricedClosedTrades?: number;
  /** Per-bot scorecards over the same trades and the same conventions. */
  byStrategy?: StrategyScorecard[];
  /** Per-broker-account scorecards, same rows and conventions. */
  byAccount?: AccountScorecard[];
  summary: AnalyticsSummary;
  cumulativePnl: { ts: number; pnl: number }[];
  distribution: { market: string; trades: number; netPnl: number }[];
  closedTrades: ClosedTrade[];
}

const money = (v: number) => `${v >= 0 ? "+" : "-"}$${Math.abs(v).toFixed(2)}`;
// Fees are a cost, shown unsigned; a zero reads as "none recorded", not free.
const fees = (v: number | null | undefined) => (v == null || v === 0 ? "$0.00" : `$${Math.abs(v).toFixed(2)}`);
const pnlClass = (v: number) => (v >= 0 ? "text-[var(--kb-green)]" : "text-[var(--kb-red)]");
const price = (v: number | null) =>
  v == null ? "—" : v.toLocaleString(undefined, { maximumFractionDigits: 2 });

function pct(v: number | null): string {
  return v == null ? "—" : `${(v * 100).toFixed(1)}%`;
}

// A dip deeper than the peak it fell from is floored at -100%, which reads as a
// wiped-out account. Say ">100%" and let the amount carry the size.
function drawdownPct(s: { maxDrawdownPct: number | null; maxDrawdownPctClamped?: boolean }): string {
  return s.maxDrawdownPctClamped ? ">100%" : pct(s.maxDrawdownPct);
}

// JSON has no Infinity: a bot with no losing trade arrives as null. Wins
// without losses IS an infinite profit factor — say so instead of "—".
function profitFactor(s: {
  profitFactor: number | null;
  winningTrades: number;
  losingTrades: number;
}): string {
  if (s.profitFactor == null) {
    return s.losingTrades === 0 && s.winningTrades > 0 ? "∞" : "—";
  }
  if (!Number.isFinite(s.profitFactor)) return "∞";
  return s.profitFactor.toFixed(2);
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

const TIMEFRAMES: Timeframe[] = ["1W", "1M", "3M", "1Y", "ALL"];

// The metric columns both scorecard tables share (per strategy, per account),
// so the two can never disagree on what a column means.
function scorecardColumns<T extends { summary: ScorecardSummary; curve: { pnl: number }[] }>(): MatrixColumn<T>[] {
  return [
    {
      key: "curve",
      header: "Since activation",
      cell: (c) => <EquitySparkline points={c.curve} />,
    },
    {
      key: "trades",
      header: "Trades",
      align: "right",
      sortable: true,
      sortAccessor: (c) => c.summary.totalTrades,
      cell: (c) => <span className="font-mono tabular-nums">{c.summary.totalTrades}</span>,
    },
    {
      key: "winRate",
      header: "Win rate",
      align: "right",
      sortable: true,
      sortAccessor: (c) => c.summary.winRate ?? -1,
      cell: (c) => (
        <span className="font-mono tabular-nums">
          {pct(c.summary.winRate)}
          <span className="ml-1 text-[10px] text-muted-foreground">
            {c.summary.winningTrades}W/{c.summary.losingTrades}L
          </span>
        </span>
      ),
    },
    {
      key: "pf",
      header: "PF",
      align: "right",
      sortable: true,
      sortAccessor: (c) => c.summary.profitFactor ?? -1,
      cell: (c) => <span className="font-mono tabular-nums">{profitFactor(c.summary)}</span>,
    },
    {
      key: "dd",
      header: "Max DD",
      align: "right",
      sortable: true,
      sortAccessor: (c) => c.summary.maxDrawdownAbs ?? 0,
      cell: (c) => (
        <span className="font-mono tabular-nums text-[var(--kb-red)]">
          {drawdownPct(c.summary)}
          {c.summary.maxDrawdownAbs != null && c.summary.maxDrawdownAbs < 0 && (
            <span className="ml-1 text-[10px]">{money(c.summary.maxDrawdownAbs)}</span>
          )}
        </span>
      ),
    },
    {
      key: "fees",
      header: "Fees",
      align: "right",
      sortable: true,
      sortAccessor: (c) => c.summary.commission ?? 0,
      cell: (c) => (
        <span className="font-mono tabular-nums text-muted-foreground">{fees(c.summary.commission)}</span>
      ),
    },
    {
      key: "net",
      header: "Net P&L",
      align: "right",
      sortable: true,
      sortAccessor: (c) => c.summary.netPnl,
      cell: (c) => (
        <span className={`font-mono tabular-nums ${pnlClass(c.summary.netPnl)}`}>
          {money(c.summary.netPnl)}
          {c.summary.grossPnl != null && (
            <span className="ml-1 text-[10px] text-muted-foreground">gross {money(c.summary.grossPnl)}</span>
          )}
        </span>
      ),
    },
  ];
}

// The filter lives in the query string: a link to a slice of the book is the
// same link for whoever opens it, and a refresh keeps what you were looking at.
function filterFromParams(p: URLSearchParams): AnalyticsFilterState {
  const list = (k: string) => (p.get(k) ?? "").split(",").filter(Boolean);
  const dir = p.get("direction");
  return {
    accounts: list("accounts"),
    strategies: list("strategies"),
    symbols: list("symbols"),
    direction: dir === "long" || dir === "short" ? (dir as Direction) : "both",
    from: p.get("from"),
    to: p.get("to"),
    includeNonBot: p.get("nonBot") !== "0",
  };
}

function paramsFromState(f: AnalyticsFilterState, timeframe: Timeframe): URLSearchParams {
  const p = new URLSearchParams();
  if (timeframe !== "ALL") p.set("timeframe", timeframe);
  if (f.accounts.length) p.set("accounts", f.accounts.join(","));
  if (f.strategies.length) p.set("strategies", f.strategies.join(","));
  if (f.symbols.length) p.set("symbols", f.symbols.join(","));
  if (f.direction !== "both") p.set("direction", f.direction);
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (!f.includeNonBot) p.set("nonBot", "0");
  return p;
}

/** Calendar day to an epoch bound in the READER's zone: 00:00 / 23:59:59.999. */
function dayBound(day: string | null, edge: "start" | "end"): number | null {
  if (!day) return null;
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return null;
  return edge === "start"
    ? new Date(y, m - 1, d, 0, 0, 0, 0).getTime()
    : new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
}

function queryFor(filter: AnalyticsFilterState, timeframe: Timeframe): string {
  const q = new URLSearchParams({ timeframe });
  if (filter.accounts.length) q.set("accounts", filter.accounts.join(","));
  if (filter.strategies.length) q.set("strategies", filter.strategies.join(","));
  if (filter.symbols.length) q.set("symbols", filter.symbols.join(","));
  if (filter.direction !== "both") q.set("direction", filter.direction);
  const from = dayBound(filter.from, "start");
  const to = dayBound(filter.to, "end");
  if (from != null) q.set("from", String(from));
  if (to != null) q.set("to", String(to));
  if (!filter.includeNonBot) q.set("nonBot", "0");
  return q.toString();
}

export default function Analytics() {
  const [params, setParams] = useSearchParams();
  const timeframe = (params.get("timeframe")?.toUpperCase() ?? "ALL") as Timeframe;
  const filter = useMemo(() => filterFromParams(params), [params]);
  const query = queryFor(filter, TIMEFRAMES.includes(timeframe) ? timeframe : "ALL");

  const setTimeframe = useCallback(
    (t: Timeframe) => setParams(paramsFromState(filter, t), { replace: true }),
    [filter, setParams],
  );
  const setFilter = useCallback(
    (next: AnalyticsFilterState) => setParams(paramsFromState(next, timeframe), { replace: true }),
    [setParams, timeframe],
  );

  const { data, error, isStale, isLoading, lastUpdated, refresh } =
    usePolledResource<AnalyticsResponse>(
      () =>
        apiFetch(`/api/performance/analytics?${query}`).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        }),
      { intervalMs: 60_000 },
    );

  // Refetch immediately when the window or the filter changes (the poll interval
  // alone would only pick it up on the next tick).
  useEffect(() => {
    refresh();
  }, [query, refresh]);

  const summary = data?.summary;
  const hasData = summary?.hasData ?? false;
  const unpriced = data?.unpricedClosedTrades ?? 0;
  const byStrategy = data?.byStrategy ?? [];
  const byAccount = data?.byAccount ?? [];
  const filterOptions = data?.filterOptions ?? { accounts: [], strategies: [], symbols: [] };
  const totalClosed = data?.totalClosedTrades ?? 0;
  // Empty because of the selection, not because the book is empty. A narrowed
  // window counts too: "1W" with nothing in it is a filter result.
  const filtered =
    totalClosed > 0 && (isFilterActive(filter) || (timeframe !== "ALL" && !hasData));

  const exportCsv = () => {
    if (!data) return;
    const csv = toCsv(data.closedTrades, [
      { header: "Closed", value: (t) => new Date(t.closedAt).toISOString() },
      { header: "Market", value: (t) => t.symbol },
      { header: "Side", value: (t) => t.direction },
      { header: "Account", value: (t) => t.accountId ?? "" },
      { header: "Entry", value: (t) => t.entryAvg ?? "" },
      { header: "Exit", value: (t) => t.exitAvg ?? "" },
      { header: "Gross P&L", value: (t) => (t.grossPnl ?? t.netPnl).toFixed(2) },
      { header: "Fees", value: (t) => (t.commission ?? 0).toFixed(2) },
      { header: "Net P&L", value: (t) => t.netPnl.toFixed(2) },
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
                {TIMEFRAMES.map((r) => (
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

      {(totalClosed > 0 || isFilterActive(filter)) && (
        <AnalyticsFilterBar
          value={filter}
          options={filterOptions}
          onChange={setFilter}
          onReset={() => setFilter(EMPTY_FILTER)}
        />
      )}

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
            {filtered ? (
              <EmptyState
                icon={BarChart2}
                title="No trades match these filters"
                description={`${totalClosed} closed trade${totalClosed === 1 ? "" : "s"} sit outside the current selection.`}
                action={
                  <Button size="sm" variant="outline" onClick={() => setFilter(EMPTY_FILTER)}>
                    Reset filters
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={BarChart2}
                title="No closed trades yet"
                description={
                  unpriced > 0
                    ? `${unpriced} closed position${unpriced === 1 ? "" : "s"} carry no recorded exit fill, so there is no price to compute a result from. Everything here is built from your fills, locally.`
                    : "Close a position and its result shows up here. All computed locally from your fills, no portfolio sharing needed."
                }
              />
            )}
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
                caption:
                  summary!.grossPnl != null
                    ? `gross ${money(summary!.grossPnl)} · fees ${fees(summary!.commission)}`
                    : "realized · net of fees",
              },
              {
                label: "Fees",
                value: fees(summary!.commission),
                icon: Coins,
                caption:
                  summary!.grossPnl != null && summary!.grossPnl !== 0
                    ? `${((Math.abs(summary!.commission ?? 0) / Math.abs(summary!.grossPnl)) * 100).toFixed(1)}% of gross`
                    : undefined,
                hint: "Venue commissions on the closed trades in range. Fills booked before fee tracking show $0.00 until the backfill runs.",
              },
              {
                label: "Win Rate",
                value: pct(summary!.winRate),
                icon: Target,
                caption: `${summary!.winningTrades}W / ${summary!.losingTrades}L`,
              },
              {
                label: "Profit Factor",
                value: profitFactor(summary!),
                icon: Trophy,
                hint: "Gross profit divided by gross loss. Above 1 means winners outweigh losers.",
              },
              {
                label: "Max Drawdown",
                // Percentage only while it measures something. Past -100% and
                // with no peak at all, the amount is the honest headline.
                value:
                  summary!.maxDrawdownAbs != null &&
                  (summary!.maxDrawdownPctClamped || summary!.maxDrawdownPct == null)
                    ? money(summary!.maxDrawdownAbs)
                    : pct(summary!.maxDrawdownPct),
                icon: TrendingDown,
                valueClassName: "text-[var(--kb-red)]",
                caption:
                  summary!.maxDrawdownAbs == null
                    ? undefined
                    : summary!.maxDrawdownPctClamped
                      ? ">100% of the peak it fell from"
                      : summary!.maxDrawdownPct == null
                        ? "below the starting point"
                        : money(summary!.maxDrawdownAbs),
                hint: "Largest drop from a peak on the cumulative realized-P&L curve. A dip deeper than that peak, or one that never had a peak above it, shows only the amount.",
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
                caption: unpriced > 0 ? `${unpriced} more without an exit fill` : undefined,
                hint:
                  unpriced > 0
                    ? "Trades with a recorded entry and exit fill. Closed positions whose exit fill was never recorded carry no price, so they stay out of every figure here."
                    : undefined,
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

          <Section
            label="By strategy"
            meta="same trades, split per bot"
            flush
          >
            {byStrategy.length > 0 ? (
              <DataMatrix
                rows={byStrategy}
                rowKey={(c) => c.key}
                defaultSort={{ key: "net", dir: "desc" }}
                columns={[
                  {
                    key: "strategy",
                    header: "Strategy",
                    sortable: true,
                    sortAccessor: (c) => c.strategy,
                    cell: (c) => (
                      <span className="font-mono text-xs text-[var(--kb-teal)]">
                        {c.strategy}
                      </span>
                    ),
                  },
                  ...scorecardColumns<StrategyScorecard>(),
                ]}
              />
            ) : (
              <EmptyState
                className="py-8"
                icon={BarChart2}
                title="No per-strategy split yet"
                description="Each bot gets its own row once one of its positions closes."
              />
            )}
          </Section>

          <Section
            label="By account"
            meta="per broker account"
            flush
          >
            {byAccount.length > 0 ? (
              <DataMatrix
                rows={byAccount}
                rowKey={(c) => c.key}
                defaultSort={{ key: "net", dir: "desc" }}
                columns={[
                  {
                    key: "account",
                    header: "Account",
                    sortable: true,
                    sortAccessor: (c) => c.account,
                    cell: (c) => (
                      <span className="font-mono text-xs text-[var(--kb-teal)]">
                        {c.account}
                      </span>
                    ),
                  },
                  ...scorecardColumns<AccountScorecard>(),
                ]}
              />
            ) : (
              <EmptyState
                className="py-8"
                icon={BarChart2}
                title="No per-account split yet"
                description="Rows appear once a position closes on an account."
              />
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
                    key: "account",
                    header: "Account",
                    sortable: true,
                    sortAccessor: (t) => t.accountId ?? "",
                    cell: (t) => (
                      <span className="font-mono text-xs text-muted-foreground">{t.accountId ?? "—"}</span>
                    ),
                  },
                  {
                    key: "fees",
                    header: "Fees",
                    align: "right",
                    sortable: true,
                    sortAccessor: (t) => t.commission ?? 0,
                    cell: (t) => (
                      <span className="font-mono text-xs text-muted-foreground">{fees(t.commission)}</span>
                    ),
                  },
                  {
                    key: "pnl",
                    header: "Net P&L",
                    align: "right",
                    sortable: true,
                    sortAccessor: (t) => t.netPnl,
                    cell: (t) => (
                      <span className={`font-mono text-xs ${pnlClass(t.netPnl)}`}>
                        {money(t.netPnl)}
                        {t.grossPnl != null && t.grossPnl !== t.netPnl && (
                          <span className="ml-1 text-[10px] text-muted-foreground">gross {money(t.grossPnl)}</span>
                        )}
                      </span>
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

import { useState, useEffect, useMemo, lazy, Suspense } from "react";
import { DataFreshness, DataMatrix, EmptyState, PageHeader, QueryStateGate, Section, SignalFeedList, SignalFeedRow, StatStrip, Tabs, TabsList, TabsTrigger, fmtDateTime } from "@kaibot/shared";
import { RefreshCw, Bot, Pause, Play, CheckCircle, XCircle, AlertCircle, Wallet, TrendingUp, Activity, Link2, PieChart, LineChart, Radio } from "@/lib/icons";
import { useAtomValue, useSetAtom } from "jotai";
import { exchangeSessionsAtom, balancesAtom, signalsAtom, positionsAtom, type Signal, type Position } from "@/lib/atoms";
import { connectionLabel, sessionKey } from "@/lib/connection";
import { useNavigate } from "react-router-dom";
import { apiFetch } from "@/lib/api";
import { notionalOf } from "@/lib/notional";
import { useApiConnection } from "@/hooks/useApiConnection";
import { useBrokerData } from "@/hooks/useBrokerData";
import { usePolledResource } from "@/hooks/usePolledResource";
import { useEquityHistory, type EquityPoint, type EquityRange } from "@/hooks/useEquityHistory";
const AllocationDonut = lazy(() =>
  import("./DashboardCharts").then((m) => ({ default: m.AllocationDonut })),
);
const EquityCurve = lazy(() =>
  import("./DashboardCharts").then((m) => ({ default: m.EquityCurve })),
);

interface SubscriptionSummary {
  id: string;
  botName: string | null;
  signalBotId: string;
  status: "active" | "paused" | "cancelled";
  factor: number;
}

const DONUT_COLORS = [
  "hsl(var(--chart-1))", // gold
  "var(--kb-blue)",
  "var(--kb-green)",
  "var(--kb-red)",
  "var(--kb-violet)",
  "var(--kb-amber)",
  "var(--kb-teal)",
];

function CircularGauge({
  value,
  size = 32,
  isProfit,
}: {
  value: number;
  size?: number;
  isProfit: boolean;
}) {
  // value = absolute percent (0-100+), capped visually at 100
  const clamped = Math.min(Math.max(Math.abs(value), 0), 100);
  const radius = (size - 4) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (clamped / 100) * circumference;
  const color = isProfit ? "var(--kb-green)" : "var(--kb-red)";
  return (
    <svg width={size} height={size} className="flex-shrink-0">
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        className="text-muted-foreground/20"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text
        x="50%"
        y="50%"
        dominantBaseline="central"
        textAnchor="middle"
        fontSize="8"
        fontFamily="monospace"
        fill={color}
      >
        {clamped.toFixed(0)}
      </text>
    </svg>
  );
}

interface DashboardMeta {
  signals: Signal[];
  subs: SubscriptionSummary[];
  wsStatus: { connected: boolean; status?: string };
}

// Signals, subscriptions and WS status — everything the dashboard needs on top
// of the shared broker snapshot. Each fetch is best effort.
async function fetchDashboardMeta(): Promise<DashboardMeta> {
  let signals: Signal[] = [];
  try {
    const sigRes = await apiFetch(`/api/signals`);
    if (sigRes.ok) {
      const raw = await sigRes.json();
      signals = raw.slice(0, 10).map((r: any) => ({
        id: String(r.id ?? r.signal_id ?? Math.random()),
        symbol: r.symbol ?? r.market ?? '—',
        action: String(r.action ?? 'buy').toUpperCase() as any,
        price: Number(r.price ?? 0),
        strategy: r.status ?? r.strategy ?? '',
        timestamp: r.received_at ? fmtDateTime(r.received_at) : '',
        botName: r.bot_name,
        botTag: r.bot_tag,
      }));
    }
  } catch { /* ignore */ }

  let subs: SubscriptionSummary[] = [];
  try {
    const subRes = await apiFetch(`/api/subscriptions`);
    if (subRes.ok) subs = await subRes.json();
  } catch { /* ignore */ }

  let wsStatus: DashboardMeta["wsStatus"] = { connected: false };
  try {
    const wsRes = await apiFetch(`/api/ws/status`);
    if (wsRes.ok) wsStatus = await wsRes.json();
  } catch { /* ignore */ }

  return { signals, subs, wsStatus };
}

export default function Dashboard() {
  const broker = useBrokerData(5000);
  const { data: meta, refresh: refreshMeta } = usePolledResource(
    fetchDashboardMeta,
    { intervalMs: 5000 },
  );
  const isLoading = broker.isLoading;
  const subs = meta?.subs ?? [];
  const wsStatus = meta?.wsStatus ?? { connected: false };
  const status: 'connecting' | 'connected' | 'error' =
    broker.error != null || broker.isStale
      ? 'error'
      : broker.lastUpdated != null
        ? 'connected'
        : 'connecting';
  const exchangeSessions = useAtomValue(exchangeSessionsAtom);
  const balances = useAtomValue(balancesAtom);
  const signals = useAtomValue(signalsAtom);
  const positions = useAtomValue(positionsAtom);
  const setSignals = useSetAtom(signalsAtom);
  const navigate = useNavigate();
  const apiConnection = useApiConnection();
  const [equityRange, setEquityRange] = useState<EquityRange>("1M");
  const { equityData } = useEquityHistory(equityRange);

  useEffect(() => {
    if (meta) setSignals(meta.signals);
  }, [meta, setSignals]);

  const loadData = () => {
    broker.refresh();
    refreshMeta();
  };

  const allocationData = useMemo(() => {
    const bySymbol = new Map<string, number>();
    for (const p of positions) {
      const notional = notionalOf(p);
      if (notional <= 0) continue;
      bySymbol.set(p.symbol, (bySymbol.get(p.symbol) ?? 0) + notional);
    }
    return Array.from(bySymbol.entries())
      .map(([symbol, notional]) => ({ symbol, notional }))
      .sort((a, b) => b.notional - a.notional);
  }, [positions]);

  const totalNotional = allocationData.reduce((sum, a) => sum + a.notional, 0);

  const totalEquity = Array.from(balances.values())
    .flat()
    .reduce((sum, b) => sum + (b.equity || 0), 0);
  const todayPnL = positions.reduce(
    (sum, p) => sum + (p.unrealizedPnL || 0),
    0,
  );
  const connectedCount = exchangeSessions.filter(
    (e) => e.status === "connected",
  ).length;

  const noApiKey = !apiConnection.isConfigured && !apiConnection.isLoading;

  return (
    <div className="flex flex-col text-foreground">
      <PageHeader
        title="Dashboard"
        description="Live equity, allocation, open positions and recent signals from your connected exchanges."
        meta={<ConnectionStatus noApiKey={noApiKey} status={status} />}
        actions={
          <DataFreshness
            updatedAt={broker.lastUpdated}
            isRefreshing={broker.isLoading}
            onRefresh={loadData}
          />
        }
      />

      <QueryStateGate
        isLoading={false}
        isError={broker.error != null}
        onRetry={loadData}
        errorTitle="Couldn't load your dashboard"
        errorDescription="The executor backend didn't respond. Your exchanges and positions are unaffected."
      >
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
            value: `${todayPnL >= 0 ? "+" : "-"}$${Math.abs(todayPnL).toFixed(2)}`,
            icon: TrendingUp,
            valueClassName:
              todayPnL >= 0 ? "text-[var(--kb-green)]" : "text-[var(--kb-red)]",
          },
          {
            label: "Open Positions",
            value: positions.length,
            icon: Activity,
          },
          {
            label: "Notional",
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

      <AllocationEquityRow
        allocationData={allocationData}
        totalNotional={totalNotional}
        equityData={equityData}
        equityRange={equityRange}
        onEquityRangeChange={setEquityRange}
      />

      <div className="grid border-b border-border lg:grid-cols-2">
        <ActivePositionsCard isLoading={isLoading} positions={positions} />
        <RecentSignalsCard isLoading={isLoading} signals={signals} />
      </div>

      <SubscriptionsStrip
        subs={subs}
        wsConnected={wsStatus.connected}
        onManage={() => navigate('/subscriptions')}
      />

      <ExchangeConnectionsStrip
        exchangeSessions={exchangeSessions}
        onManage={() => navigate('/exchanges')}
      />
      </QueryStateGate>
    </div>
  );
}

function AllocationEquityRow({
  allocationData,
  totalNotional,
  equityData,
  equityRange,
  onEquityRangeChange,
}: {
  allocationData: { symbol: string; notional: number }[];
  totalNotional: number;
  equityData: EquityPoint[];
  equityRange: EquityRange;
  onEquityRangeChange: (range: EquityRange) => void;
}) {
  return (
    <div className="grid border-b border-border lg:grid-cols-3">
      <Section
        noBorder
        label="Equity Curve"
        className="border-b border-border lg:col-span-2 lg:border-b-0"
        actions={
          <Tabs
            value={equityRange}
            onValueChange={(v) => onEquityRangeChange(v as EquityRange)}
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
          <div className="h-[260px] flex items-center justify-center">
            <EmptyState
              className="py-0"
              icon={LineChart}
              title="No equity history yet"
              description="The curve builds up as the executor records balance snapshots."
            />
          </div>
        ) : (
          <div className="h-[260px]">
            <Suspense fallback={<div className="h-full" />}>
              <EquityCurve equityData={equityData} />
            </Suspense>
          </div>
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
            <div className="relative h-[200px]">
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
              {allocationData.slice(0, 6).map((a, idx) => (
                <div key={a.symbol} className="flex items-center gap-1.5 min-w-0">
                  <span
                    className="size-2 rounded-full flex-shrink-0"
                    style={{
                      backgroundColor: DONUT_COLORS[idx % DONUT_COLORS.length],
                    }}
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
  );
}

function ConnectionStatus({
  noApiKey,
  status,
}: {
  noApiKey: boolean;
  status: 'connecting' | 'connected' | 'error';
}) {
  return (
    <div className="flex items-center justify-end gap-2">
      <span
        className={`h-2 w-2 rounded-full ${
          noApiKey
            ? 'bg-[var(--kb-red)]'
            : status === 'connected'
              ? 'bg-[var(--kb-green)] animate-pulse'
              : status === 'connecting'
                ? 'bg-[var(--kb-amber)] animate-pulse'
                : 'bg-[var(--kb-red)]'
        }`}
      />
      <span
        className={`font-mono text-[10px] uppercase tracking-wider ${
          noApiKey
            ? 'text-[var(--kb-red)]'
            : status === 'connected'
              ? 'text-[var(--kb-green)]'
              : status === 'connecting'
                ? 'text-[var(--kb-amber)]'
                : 'text-[var(--kb-red)]'
        }`}
      >
        {noApiKey
          ? 'No API Key'
          : status === 'connected'
            ? 'Backend online'
            : status === 'connecting'
              ? 'Connecting'
              : 'Error'}
      </span>
    </div>
  );
}

function SubscriptionsStrip({
  subs,
  wsConnected,
  onManage,
}: {
  subs: SubscriptionSummary[];
  wsConnected: boolean;
  onManage: () => void;
}) {
  const active = subs.filter(s => s.status !== 'cancelled');
  return (
    <Section
      noBorder
      label="Signal Subscriptions"
      className="border-b border-border"
      meta={
        <span className={wsConnected ? "text-[var(--kb-green)]" : "text-[var(--kb-red)]"}>
          ws {wsConnected ? 'online' : 'offline'}
        </span>
      }
      actions={
        <button
          type="button"
          onClick={onManage}
          className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground hover:underline"
        >
          Manage →
        </button>
      }
    >
      <div className="flex items-center gap-3 flex-wrap">
        {active.slice(0, 4).map((sub) => (
          <div key={sub.id} className="flex items-center gap-1.5">
            <Bot className="size-3 text-muted-foreground" />
            <span className="text-[11px] text-foreground">{sub.botName || sub.signalBotId}</span>
            <span className="text-[10px] font-mono text-muted-foreground">{sub.factor}×</span>
            {sub.status === 'active' ? (
              <Play className="size-2.5 text-[var(--kb-green)]" />
            ) : (
              <Pause className="size-2.5 text-[var(--kb-amber)]" />
            )}
          </div>
        ))}
        {active.length > 4 && (
          <span className="text-[11px] text-muted-foreground">
            +{active.length - 4} more
          </span>
        )}
        {active.length === 0 && (
          <span className="text-[11px] text-muted-foreground">No active subscriptions</span>
        )}
      </div>
    </Section>
  );
}

function ExchangeConnectionsStrip({
  exchangeSessions,
  onManage,
}: {
  exchangeSessions: Array<{ exchangeName: string; accountKey?: string | null; label?: string; status: string }>;
  onManage: () => void;
}) {
  return (
    <Section
      noBorder
      label="Exchange Connections"
      actions={
        <button
          type="button"
          onClick={onManage}
          className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground hover:underline"
        >
          Manage →
        </button>
      }
    >
      <div className="flex items-center gap-3 flex-wrap">
        {exchangeSessions.length === 0 && (
          <span className="text-[11px] text-muted-foreground">No exchanges configured</span>
        )}
        {exchangeSessions.map((session) => (
          <div key={sessionKey(session)} className="flex items-center gap-1.5">
            <span className="text-[11px] capitalize text-foreground">{connectionLabel(session)}</span>
            {session.status === 'connected' ? (
              <CheckCircle className="size-3 text-[var(--kb-green)]" />
            ) : session.status === 'error' ? (
              <XCircle className="size-3 text-[var(--kb-red)]" />
            ) : (
              <AlertCircle className="size-3 text-muted-foreground" />
            )}
          </div>
        ))}
      </div>
    </Section>
  );
}

function ActivePositionsCard({
  isLoading,
  positions,
}: {
  isLoading: boolean;
  positions: Position[];
}) {
  const navigate = useNavigate();
  return (
    <Section
      noBorder
      flush
      label="Active Positions"
      className="border-b border-border lg:border-b-0"
    >
      {isLoading && positions.length === 0 ? (
        <div className="px-6 py-4 text-center text-muted-foreground text-xs">
          <div className="flex items-center justify-center gap-2">
            <RefreshCw className="size-3 animate-spin" />
            Loading…
          </div>
        </div>
      ) : positions.length === 0 ? (
        <EmptyState
          className="py-8"
          icon={Activity}
          title="No active positions"
          description="Positions opened by your subscriptions show up here."
        />
      ) : (
        <DataMatrix
          className="text-[13px]"
          rows={positions}
          rowKey={(p) => p.id}
          defaultSort={{ key: "pnl", dir: "desc" }}
          onRowClick={(p) => {
            if (p.exchange) navigate(`/exchanges/${encodeURIComponent(p.exchange)}`);
          }}
          columns={[
            {
              key: "symbol",
              header: "Symbol",
              sortable: true,
              sortAccessor: (p) => p.symbol,
              cell: (p) => (
                <span className="font-mono text-[var(--kb-teal)]">{p.symbol}</span>
              ),
            },
            {
              key: "side",
              header: "Side",
              cell: (p) => (
                <span
                  className={`font-mono text-[11px] uppercase ${
                    p.side === "long" ? "text-[var(--kb-green)]" : "text-[var(--kb-red)]"
                  }`}
                >
                  {p.side}
                </span>
              ),
            },
            {
              key: "size",
              header: "Size",
              align: "right",
              sortable: true,
              sortAccessor: (p) => notionalOf(p),
              cell: (p) => <span className="font-mono">{p.size}</span>,
            },
            {
              key: "entry",
              header: "Entry",
              align: "right",
              sortable: true,
              sortAccessor: (p) => p.entryPrice,
              cell: (p) => <span className="font-mono">${p.entryPrice.toFixed(2)}</span>,
            },
            {
              key: "mark",
              header: "Mark",
              align: "right",
              sortable: true,
              sortAccessor: (p) => p.markPrice || p.entryPrice,
              cell: (p) => (
                <span className="font-mono">
                  ${(p.markPrice || p.entryPrice).toFixed(2)}
                </span>
              ),
            },
            {
              key: "pnl",
              header: "P&L",
              align: "right",
              sortable: true,
              sortAccessor: (p) => p.unrealizedPnL ?? 0,
              cell: (p) => {
                const pnl = p.unrealizedPnL || 0;
                const isProfit = pnl >= 0;
                return (
                  <span
                    className={`font-mono ${
                      isProfit ? "text-[var(--kb-green)]" : "text-[var(--kb-red)]"
                    }`}
                  >
                    {isProfit ? "+" : "-"}${Math.abs(pnl).toFixed(2)}
                  </span>
                );
              },
            },
            {
              key: "pct",
              header: "%",
              cell: (p) => {
                const pnl = p.unrealizedPnL || 0;
                const markPrice = p.markPrice || p.entryPrice;
                const pnlPercent =
                  ((markPrice - p.entryPrice) / p.entryPrice) *
                  100 *
                  (p.side === "short" ? -1 : 1);
                return (
                  <div className="flex justify-center">
                    <CircularGauge value={pnlPercent} isProfit={pnl >= 0} size={32} />
                  </div>
                );
              },
            },
            {
              key: "bot",
              header: "Bot",
              cell: (p) =>
                p.botTag ? (
                  <span className="font-mono text-[9px] uppercase text-muted-foreground">
                    {p.botTag}
                  </span>
                ) : null,
            },
          ]}
        />
      )}
    </Section>
  );
}

function RecentSignalsCard({
  isLoading,
  signals,
}: {
  isLoading: boolean;
  signals: Signal[];
}) {
  return (
    <Section noBorder flush label="Recent Signals" className="lg:border-l lg:border-border">
      {isLoading && signals.length === 0 ? (
        <div className="py-4 text-center text-muted-foreground flex items-center justify-center gap-2 text-xs">
          <RefreshCw className="size-3 animate-spin" />
          Loading…
        </div>
      ) : signals.length === 0 ? (
        <EmptyState
          className="py-8"
          icon={Radio}
          title="No recent signals"
          description="Incoming signals from subscribed bots land here."
        />
      ) : (
        <SignalFeedList>
          {signals.map((signal) => (
            <SignalFeedRow
              key={signal.id}
              asset={signal.symbol}
              direction={signal.action as "BUY" | "SELL"}
              strategy={signal.strategy}
              price={signal.price.toFixed(2)}
              timestamp={signal.timestamp}
            />
          ))}
        </SignalFeedList>
      )}
    </Section>
  );
}

declare global {
  interface Window {
    __TAURI__?: any;
  }
}

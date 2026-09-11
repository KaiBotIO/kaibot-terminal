import { useMemo } from "react";
import { usePolledResource } from "@/hooks/usePolledResource";
import { apiFetch } from "@/lib/api";

export interface ScorecardSummary {
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

export interface StrategyScorecard {
  key: string;
  strategy: string;
  signalBotId: string | null;
  summary: ScorecardSummary;
  curve: { ts: number; pnl: number }[];
  firstTradeAt: number;
  lastTradeAt: number;
}

const money = (v: number) => `${v >= 0 ? "+" : "-"}$${Math.abs(v).toFixed(2)}`;
const pnlClass = (v: number) =>
  v >= 0 ? "text-[var(--kb-green)]" : "text-[var(--kb-red)]";

export const scorecardPct = (v: number | null) =>
  v == null ? "—" : `${(v * 100).toFixed(1)}%`;

// JSON has no Infinity: a bot with no losing trade arrives as null. Wins
// without losses IS an infinite profit factor — say so instead of "—".
export const scorecardPf = (s: ScorecardSummary) => {
  if (s.profitFactor == null) {
    return s.losingTrades === 0 && s.winningTrades > 0 ? "∞" : "—";
  }
  if (!Number.isFinite(s.profitFactor)) return "∞";
  return s.profitFactor.toFixed(2);
};

const shortDate = (ms: number) =>
  new Date(ms).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });

/**
 * Cumulative realized P&L of one bot since its first close, as an inline
 * sparkline. Zero baseline dashed so a curve that never went positive reads as
 * such at a glance.
 */
export function EquitySparkline({
  points,
  width = 96,
  height = 24,
}: {
  points: { pnl: number }[];
  width?: number;
  height?: number;
}) {
  const path = useMemo(() => {
    if (points.length === 0) return null;
    const values = [0, ...points.map((p) => p.pnl)];
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const y = (v: number) => height - ((v - min) / span) * height;
    const step = values.length > 1 ? width / (values.length - 1) : 0;
    return {
      d: values.map((v, i) => `${i === 0 ? "M" : "L"}${i * step},${y(v)}`).join(" "),
      zeroY: y(0),
      last: points[points.length - 1]!.pnl,
      lastX: (values.length - 1) * step,
      lastY: y(points[points.length - 1]!.pnl),
    };
  }, [points, width, height]);

  if (!path) return <span className="text-muted-foreground">—</span>;
  const stroke = path.last >= 0 ? "var(--kb-green)" : "var(--kb-red)";
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="overflow-visible"
      aria-hidden
    >
      <line
        x1={0}
        x2={width}
        y1={path.zeroY}
        y2={path.zeroY}
        stroke="currentColor"
        strokeOpacity={0.25}
        strokeDasharray="2 2"
      />
      <path d={path.d} fill="none" stroke={stroke} strokeWidth={1.5} />
      <circle cx={path.lastX} cy={path.lastY} r={1.75} fill={stroke} />
    </svg>
  );
}

/**
 * One-line live result of a bot, for the subscription card. Trade count and net
 * result since activation are the two numbers a kill decision starts from.
 */
export function ScorecardLine({ card }: { card: StrategyScorecard | undefined }) {
  if (!card || !card.summary.hasData) {
    return (
      <span className="text-[11px] text-muted-foreground">
        No closed trades yet
      </span>
    );
  }
  const s = card.summary;
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11px] text-muted-foreground">
      <span className="text-foreground">
        {s.totalTrades} {s.totalTrades === 1 ? "trade" : "trades"}
      </span>
      <span>
        {s.winningTrades}W / {s.losingTrades}L
      </span>
      <span>PF {scorecardPf(s)}</span>
      <span className={pnlClass(s.netPnl)}>{money(s.netPnl)}</span>
      {s.maxDrawdownAbs != null && s.maxDrawdownAbs < 0 && (
        <span className="text-[var(--kb-red)]">DD {money(s.maxDrawdownAbs)}</span>
      )}
      <span>since {shortDate(card.firstTradeAt)}</span>
      <EquitySparkline points={card.curve} width={64} height={16} />
    </span>
  );
}

interface AnalyticsShape {
  byStrategy?: StrategyScorecard[];
}

/**
 * Per-bot scorecards from the executor's own fills. Same endpoint the Analytics
 * page uses — one local read, nothing leaves the machine.
 */
export function useStrategyScorecards() {
  const { data, isLoading } = usePolledResource<AnalyticsShape>(
    () =>
      apiFetch("/api/performance/analytics?timeframe=ALL").then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
    { intervalMs: 60_000 },
  );
  const byBotId = useMemo(() => {
    const m = new Map<string, StrategyScorecard>();
    for (const c of data?.byStrategy ?? []) if (c.signalBotId) m.set(c.signalBotId, c);
    return m;
  }, [data]);
  return { byBotId, isLoading };
}

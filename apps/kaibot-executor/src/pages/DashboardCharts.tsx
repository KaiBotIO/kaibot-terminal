import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface AllocationDatum {
  symbol: string;
  notional: number;
}

interface EquityPoint {
  date: string;
  equity: number;
  pnl: number;
  unrealizedPnL: number;
}

export function AllocationDonut({
  allocationData,
  colors,
}: {
  allocationData: AllocationDatum[];
  colors: string[];
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie
          data={allocationData}
          cx="50%"
          cy="50%"
          innerRadius={55}
          outerRadius={80}
          paddingAngle={2}
          dataKey="notional"
          stroke="none"
        >
          {allocationData.map((a, idx) => (
            <Cell key={a.symbol} fill={colors[idx % colors.length]} />
          ))}
        </Pie>
        <Tooltip
          contentStyle={{
            background: "hsl(var(--card))",
            border: "1px solid hsl(var(--border))",
            borderRadius: 0,
            fontSize: 11,
          }}
          formatter={(value: number) => `$${value.toFixed(2)}`}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}

interface CumulativePnlPoint {
  ts: number;
  pnl: number;
}

export function CumulativePnlChart({ data }: { data: CumulativePnlPoint[] }) {
  const last = data.length > 0 ? data[data.length - 1].pnl : 0;
  const color = last >= 0 ? "var(--kb-green)" : "var(--kb-red)";
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
        <defs>
          <linearGradient id="cumPnlGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.35} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis
          dataKey="ts"
          type="number"
          domain={["dataMin", "dataMax"]}
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
          tickFormatter={(t: number) =>
            new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" })
          }
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
          tickFormatter={(v: number) => `$${v.toFixed(0)}`}
        />
        <Tooltip
          contentStyle={{
            background: "hsl(var(--card))",
            border: "1px solid hsl(var(--border))",
            borderRadius: 0,
            fontSize: 11,
          }}
          labelFormatter={(t: number) => new Date(t).toLocaleString()}
          formatter={(value: number) => [`$${value.toFixed(2)}`, "Cumulative P&L"]}
        />
        <Area
          type="monotone"
          dataKey="pnl"
          stroke={color}
          strokeWidth={2}
          fill="url(#cumPnlGradient)"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

interface DistributionDatum {
  market: string;
  trades: number;
  netPnl: number;
}

export function TradeDistributionChart({ data }: { data: DistributionDatum[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
        <XAxis
          dataKey="market"
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
          tickFormatter={(v: number) => `$${v.toFixed(0)}`}
        />
        <Tooltip
          cursor={{ fill: "hsl(var(--muted) / 0.2)" }}
          contentStyle={{
            background: "hsl(var(--card))",
            border: "1px solid hsl(var(--border))",
            borderRadius: 0,
            fontSize: 11,
          }}
          formatter={(value: number, _name, item) => [
            `$${value.toFixed(2)} · ${(item?.payload as DistributionDatum)?.trades ?? 0} trades`,
            "Net P&L",
          ]}
        />
        <Bar dataKey="netPnl" stroke="none">
          {data.map((d) => (
            <Cell
              key={d.market}
              fill={d.netPnl >= 0 ? "var(--kb-green)" : "var(--kb-red)"}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function EquityCurve({ equityData }: { equityData: EquityPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={equityData} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
        <defs>
          <linearGradient id="equityGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(var(--chart-1))" stopOpacity={0.4} />
            <stop offset="100%" stopColor="hsl(var(--chart-1))" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
          tickFormatter={(d: string) =>
            new Date(d).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            })
          }
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
          tickFormatter={(v: number) => `$${v.toFixed(0)}`}
        />
        <Tooltip
          contentStyle={{
            background: "hsl(var(--card))",
            border: "1px solid hsl(var(--border))",
            borderRadius: 0,
            fontSize: 11,
          }}
          labelFormatter={(d: string) => new Date(d).toLocaleString()}
          formatter={(value: number, name: string) => [
            `$${value.toFixed(2)}`,
            name === "equity" ? "Equity" : name,
          ]}
        />
        <Area
          type="monotone"
          dataKey="equity"
          stroke="hsl(var(--chart-1))"
          strokeWidth={2}
          fill="url(#equityGradient)"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

import { Badge, Button, DataFreshness, DataMatrix, EmptyState, PageHeader, Section, StaleDataBanner, StatStrip, fmtDateTime } from "@kaibot/shared";
import { AlertTriangle, Check, RefreshCw, Scale } from "lucide-react";
import { opsApi } from "@/lib/ops-api";
import { usePolledResource } from "@/hooks/usePolledResource";

const fmtTime = (ms: number) => fmtDateTime(ms);

// Human label + tone per reconciler action.
function actionBadge(action: string) {
  const map: Record<string, { label: string; variant: "success" | "warning" | "error" | "neutral" | "secondary" }> = {
    corrected: { label: "corrected", variant: "success" },
    skipped_working: { label: "waiting on order", variant: "warning" },
    skipped_cooldown: { label: "cooldown", variant: "neutral" },
    skipped_closed: { label: "market closed", variant: "neutral" },
    skipped_large: { label: "large mismatch", variant: "error" },
    alert_foreign_order: { label: "foreign order", variant: "error" },
  };
  const m = map[action] ?? { label: action, variant: "secondary" as const };
  return <Badge variant={m.variant}>{m.label}</Badge>;
}

// Leading status-dot colour per reconciler action (recent-runs list).
function actionDot(action: string): string {
  if (action === "corrected") return "var(--kb-green)";
  if (action === "alert_foreign_order" || action === "skipped_large") return "var(--kb-red)";
  if (action === "skipped_working") return "var(--kb-amber)";
  return "hsl(var(--muted-foreground))";
}

export default function Reconciliation() {
  const { data, error, isStale, isLoading: loading, lastUpdated, refresh } =
    usePolledResource(() => opsApi.reconciliations(), { intervalMs: 5000 });

  const recent = data?.recent ?? [];
  const latest = data?.latestPerSymbol ?? [];
  const mismatched = data?.mismatched ?? [];

  const matchedCount = latest.filter((r) => r.delta === 0 || r.action === "corrected").length;
  const corrections24h = recent.filter(
    (r) => r.action === "corrected" && Date.now() - r.ts < 24 * 60 * 60 * 1000,
  ).length;
  const lastRun = recent.length > 0 ? Math.max(...recent.map((r) => r.ts)) : null;

  return (
    <div className="flex flex-col text-foreground">
      <PageHeader
        title="Reconciliation"
        description="How the executor's expected net position lines up with the live broker net, per symbol."
        actions={
          <DataFreshness
            updatedAt={lastUpdated}
            isRefreshing={loading}
            onRefresh={refresh}
          />
        }
      />

      {isStale && <StaleDataBanner updatedAt={lastUpdated} onRetry={refresh} />}

      {loading && !data ? (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : error != null ? (
        <EmptyState
          className="py-10"
          icon={AlertTriangle}
          title="Couldn't load reconciliation status"
          description="The executor backend didn't respond. Position drift can't be checked right now."
          action={<Button onClick={refresh}>Retry</Button>}
        />
      ) : (
        <>
          <StatStrip
            items={[
              { label: "Symbols tracked", value: latest.length, icon: Scale },
              { label: "Matched", value: matchedCount, focal: true, valueClassName: "text-[var(--kb-green)]" },
              { label: "Mismatched", value: mismatched.length, valueClassName: mismatched.length > 0 ? "text-[var(--kb-red)]" : undefined },
              { label: "Corrections 24h", value: corrections24h },
              { label: "Last run", value: lastRun ? fmtTime(lastRun) : "—" },
            ]}
            size="md"
          />

          <Section
            label="Per-symbol status"
            flush
            meta={
              mismatched.length > 0
                ? `${mismatched.length} mismatch${mismatched.length > 1 ? "es" : ""}`
                : "all matched"
            }
          >
            {latest.length === 0 ? (
              <EmptyState
                icon={Scale}
                title="No reconciliation runs yet"
                description="The reconciler checks netted broker positions for the symbols you trade. Status appears once it has run."
              />
            ) : (
              <DataMatrix
                rows={latest}
                rowKey={(r) => `${r.exchange}:${r.symbol}`}
                defaultSort={{ key: "symbol", dir: "asc" }}
                columns={[
                  {
                    key: "exchange",
                    header: "Exchange",
                    sortable: true,
                    sortAccessor: (r) => r.exchange,
                    cell: (r) => (
                      <span className="font-mono text-[10px] uppercase text-muted-foreground">{r.exchange}</span>
                    ),
                  },
                  {
                    key: "symbol",
                    header: "Symbol",
                    sortable: true,
                    sortAccessor: (r) => r.symbol,
                    cell: (r) => (
                      <span className="font-mono font-medium text-[var(--kb-teal)]">{r.symbol}</span>
                    ),
                  },
                  {
                    key: "expected",
                    header: "Expected net",
                    align: "right",
                    cell: (r) => <span className="font-mono">{r.expected_net}</span>,
                  },
                  {
                    key: "broker",
                    header: "Broker net",
                    align: "right",
                    cell: (r) => <span className="font-mono">{r.broker_net}</span>,
                  },
                  {
                    key: "matched",
                    header: "Matched",
                    cell: (r) => {
                      const matched = r.delta === 0 || r.action === "corrected";
                      return matched ? (
                        <span className="inline-flex items-center gap-1 text-[11px] text-[var(--kb-green)]">
                          <Check className="size-3.5" /> ok
                        </span>
                      ) : (
                        <span
                          className="inline-flex items-center gap-1 text-[11px] text-[var(--kb-red)]"
                          title="expected net != broker net"
                        >
                          <AlertTriangle className="size-3.5" /> mismatch
                        </span>
                      );
                    },
                  },
                  {
                    key: "last",
                    header: "Last check",
                    sortable: true,
                    sortAccessor: (r) => r.ts,
                    cell: (r) => (
                      <span className="whitespace-nowrap text-[10px] text-muted-foreground">{fmtTime(r.ts)}</span>
                    ),
                  },
                ]}
              />
            )}
          </Section>

          <Section label="Recent runs" flush noBorder>
            {recent.length === 0 ? (
              <EmptyState icon={Scale} title="No runs recorded" description="Reconciler decisions show here." />
            ) : (
              <DataMatrix
                rows={recent}
                rowKey={(r) => String(r.id)}
                defaultSort={{ key: "time", dir: "desc" }}
                columns={[
                  {
                    key: "time",
                    header: "Time",
                    sortable: true,
                    sortAccessor: (r) => r.ts,
                    cell: (r) => (
                      <span className="inline-flex items-center gap-2 whitespace-nowrap text-[10px] text-muted-foreground">
                        <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: actionDot(r.action) }} />
                        {fmtTime(r.ts)}
                      </span>
                    ),
                  },
                  {
                    key: "exchange",
                    header: "Exchange",
                    sortable: true,
                    sortAccessor: (r) => r.exchange,
                    cell: (r) => (
                      <span className="font-mono text-[10px] uppercase text-muted-foreground">{r.exchange}</span>
                    ),
                  },
                  {
                    key: "symbol",
                    header: "Symbol",
                    sortable: true,
                    sortAccessor: (r) => r.symbol,
                    cell: (r) => <span className="font-mono font-medium text-[var(--kb-teal)]">{r.symbol}</span>,
                  },
                  {
                    key: "expected",
                    header: "Expected",
                    align: "right",
                    cell: (r) => <span className="font-mono">{r.expected_net}</span>,
                  },
                  {
                    key: "broker",
                    header: "Broker",
                    align: "right",
                    cell: (r) => <span className="font-mono">{r.broker_net}</span>,
                  },
                  {
                    key: "delta",
                    header: "Delta",
                    align: "right",
                    sortable: true,
                    sortAccessor: (r) => Math.abs(r.delta),
                    cell: (r) => (
                      <span className={`font-mono ${r.delta !== 0 ? "text-[var(--kb-amber)]" : ""}`}>
                        {r.delta > 0 ? `+${r.delta}` : r.delta}
                      </span>
                    ),
                  },
                  {
                    key: "decision",
                    header: "Decision",
                    cell: (r) => actionBadge(r.action),
                  },
                  {
                    key: "correction",
                    header: "Correction",
                    cell: (r) => (
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {r.side && r.qty ? `${r.side} ${r.qty}${r.status ? ` → ${r.status}` : ""}` : "—"}
                      </span>
                    ),
                  },
                ]}
              />
            )}
          </Section>
        </>
      )}
    </div>
  );
}

import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { Badge, DataFreshness, DataMatrix, EmptyState, PageHeader, QueryStateGate, Section, StatStrip, fmtDateTime } from "@kaibot/shared";
import { opsApi } from "@/lib/ops-api";
import { usePolledResource } from "@/hooks/usePolledResource";

const fmtTime = (ms: number) => fmtDateTime(ms);
const fmtPx = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString(undefined, { maximumFractionDigits: 2 });

function pnl(value: number | null | undefined) {
  if (value == null) return <span className="text-muted-foreground">—</span>;
  const color = value < 0 ? "var(--kb-red)" : "var(--kb-green)";
  return (
    <span className="font-mono" style={{ color }}>
      {value >= 0 ? "+" : "-"}${Math.abs(value).toFixed(2)}
    </span>
  );
}

function statusBadge(status: string) {
  const variant =
    status === "filled" || status === "open"
      ? "success"
      : status === "closed"
        ? "neutral"
        : status === "error" || status === "rejected" || status === "lost"
          ? "error"
          : "warning";
  return <Badge variant={variant}>{status}</Badge>;
}

export default function ExecutionDetail() {
  // Key by signalId so navigating between executions resets the polled state.
  const { signalId = "" } = useParams();
  return <ExecutionDetailInner key={signalId} signalId={signalId} />;
}

function ExecutionDetailInner({ signalId }: { signalId: string }) {
  const navigate = useNavigate();
  const { data, error, isLoading, lastUpdated, refresh } = usePolledResource(
    () => opsApi.execution(signalId),
    { intervalMs: 5000 },
  );
  const notFound =
    error?.message === "HTTP 404" ||
    (data != null && !data.execution && !data.signal);

  const exec = data?.execution;
  const pnlData = data?.pnl;

  const bracketLabel = data?.bracket
    ? [
        data.bracket.sl_order_id ? `SL ${data.bracket.sl_order_id}` : "",
        data.bracket.tp_order_id ? `TP ${data.bracket.tp_order_id}` : "",
      ]
        .filter(Boolean)
        .join(" · ") || "—"
    : "—";

  return (
    <div className="flex flex-col text-foreground">
      <button
        type="button"
        onClick={() => (window.history.length > 1 ? navigate(-1) : navigate("/activity"))}
        className="inline-flex items-center gap-1.5 px-6 pt-4 font-mono text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" /> Back
      </button>

      <PageHeader
        title="Execution detail"
        description="Full fill-level breakdown of how this signal was executed, including settlements and realized P&L."
        meta={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className="font-mono text-[11px] text-muted-foreground">{signalId}</span>
            {exec && <Badge variant="secondary">{exec.exchange}</Badge>}
            {exec && (
              <Badge variant={exec.direction === "long" ? "success" : "error"}>{exec.direction}</Badge>
            )}
            {exec && statusBadge(exec.status)}
          </div>
        }
        actions={
          <DataFreshness
            updatedAt={lastUpdated}
            isRefreshing={isLoading}
            onRefresh={refresh}
          />
        }
      />

      <QueryStateGate
        isLoading={isLoading && !data}
        isError={error != null && !notFound}
        onRetry={refresh}
        errorTitle="Couldn't load execution"
        errorDescription="The executor didn't return this execution. Nothing on your account changed."
        isEmpty={notFound}
        emptyState={
          <EmptyState
            icon={RefreshCw}
            title="Not found"
            description="No execution record exists for this signal id."
          />
        }
      >
        <>
          <StatStrip
            size="sm"
            items={[
              { label: "Qty open / closed", value: exec ? `${exec.qty_opened} / ${exec.qty_closed}` : "—" },
              { label: "Avg entry", value: fmtPx(pnlData?.entryAvg) },
              { label: "Avg exit", value: fmtPx(pnlData?.exitAvg) },
              { label: "Multiplier", value: pnlData?.multiplier ?? "—" },
              {
                label: "Realized net",
                value:
                  exec && exec.qty_closed > 0 && pnlData?.exitAvg == null ? (
                    <span
                      className="font-mono text-[11px] text-[var(--kb-amber)]"
                      title="Closed without an exit fill, so there is no price to realize against"
                    >
                      no exit price
                    </span>
                  ) : (
                    pnl(pnlData?.realizedNet)
                  ),
              },
              { label: "Commission", value: pnlData ? `$${pnlData.commission.toFixed(2)}` : "—" },
              { label: "Unrealized", value: pnl(pnlData?.unrealizedPnl) },
              { label: "Bracket", value: <span className="text-[10px] text-muted-foreground">{bracketLabel}</span> },
            ]}
          />

          {exec?.error_reason && (
            <Section noBorder>
              <p className="font-mono text-[11px] text-[var(--kb-red)]">{exec.error_reason}</p>
            </Section>
          )}

          <Section label="Fills" flush>
            <DataMatrix
              className="text-[13px] tabular-nums"
              rows={data?.fills ?? []}
              rowKey={(f) => String(f.id)}
              empty={<p className="py-6 text-center text-[11px] text-muted-foreground">No fills recorded.</p>}
              columns={[
                {
                  key: "kind",
                  header: "Kind",
                  cell: (f) => <Badge variant={f.kind === "entry" ? "secondary" : "neutral"}>{f.kind}</Badge>,
                },
                {
                  key: "side",
                  header: "Side",
                  cell: (f) => <span className="font-mono text-[10px] uppercase">{f.side}</span>,
                },
                { key: "qty", header: "Qty", align: "right", cell: (f) => <span className="font-mono">{f.qty}</span> },
                { key: "price", header: "Price", align: "right", cell: (f) => <span className="font-mono">{fmtPx(f.price)}</span> },
                {
                  key: "commission",
                  header: "Commission",
                  align: "right",
                  cell: (f) => <span className="font-mono">${f.commission.toFixed(2)}</span>,
                },
                {
                  key: "order",
                  header: "Order ID",
                  cell: (f) => <span className="font-mono text-[10px] text-muted-foreground">{f.order_id ?? "—"}</span>,
                },
                {
                  key: "time",
                  header: "Time",
                  cell: (f) => <span className="text-[10px] text-muted-foreground">{fmtTime(f.created_at)}</span>,
                },
              ]}
            />
          </Section>

          <Section label="Settlements" flush noBorder>
            <DataMatrix
              className="text-[13px] tabular-nums"
              rows={data?.settlements ?? []}
              rowKey={(s) => String(s.id)}
              empty={
                <p className="py-6 text-center text-[11px] text-muted-foreground">
                  No unresolved-order settlements for this signal.
                </p>
              }
              columns={[
                {
                  key: "kind",
                  header: "Kind",
                  cell: (s) => <Badge variant={s.kind === "entry" ? "secondary" : "neutral"}>{s.kind}</Badge>,
                },
                {
                  key: "side",
                  header: "Side",
                  cell: (s) => <span className="font-mono text-[10px] uppercase">{s.side}</span>,
                },
                { key: "qty", header: "Qty", align: "right", cell: (s) => <span className="font-mono">{s.qty}</span> },
                { key: "status", header: "Status", cell: (s) => statusBadge(s.status) },
                {
                  key: "order",
                  header: "Order ID",
                  cell: (s) => <span className="font-mono text-[10px] text-muted-foreground">{s.order_id}</span>,
                },
                {
                  key: "placed",
                  header: "Placed",
                  cell: (s) => <span className="text-[10px] text-muted-foreground">{fmtTime(s.created_at)}</span>,
                },
                {
                  key: "resolved",
                  header: "Resolved",
                  cell: (s) => (
                    <span className="text-[10px] text-muted-foreground">
                      {s.resolved_at ? fmtTime(s.resolved_at) : "—"}
                    </span>
                  ),
                },
              ]}
            />
          </Section>
        </>
      </QueryStateGate>
    </div>
  );
}

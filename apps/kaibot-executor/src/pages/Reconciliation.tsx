import { Badge, Button, DataFreshness, DataMatrix, EmptyState, PageHeader, Section, StaleDataBanner, StatStrip, fmtDateTime, relativeTime } from "@kaibot/shared";
import { AlertTriangle, Archive, Check, RefreshCw, Scale } from "lucide-react";
import { opsApi, type FindingStatus } from "@/lib/ops-api";
import { usePolledResource } from "@/hooks/usePolledResource";

const fmtTime = (ms: number) => fmtDateTime(ms);

// Label, tone and meaning per reconciler action. The `what` line is the
// tooltip: the label alone doesn't say who acted or why nothing happened.
const ACTIONS: Record<
  string,
  {
    label: string;
    variant: "success" | "warning" | "error" | "neutral" | "secondary";
    /** One clause for the column glossary. */
    short: string;
    /** Full sentence on the badge itself. */
    what: string;
  }
> = {
  corrected: {
    label: "corrected",
    variant: "success",
    short: "sent a bounded order to move the broker onto the book",
    what: "The reconciler placed a bounded order to move the broker net onto the expected net.",
  },
  adopted_existing: {
    label: "adopted",
    variant: "success",
    short: "took an unknown broker position onto the books",
    what: "A broker position the executor never opened was taken onto the books as a manual position, so it stops reading as drift.",
  },
  adopted_close: {
    label: "adopted close",
    variant: "success",
    short: "booked a close that happened at the venue",
    what: "The position was closed at the venue (a stop or a manual exit) and the executor booked that close against its own execution.",
  },
  skipped_working: {
    label: "waiting on order",
    variant: "warning",
    short: "a working order may still settle it",
    what: "A working order on this symbol could still fill and settle the delta by itself, so no correction is placed.",
  },
  skipped_cooldown: {
    label: "cooldown",
    variant: "neutral",
    short: "corrected recently, waiting out the cooldown",
    what: "This pair was corrected recently. Corrections wait out a cooldown so a bad read cannot fire twice.",
  },
  skipped_closed: {
    label: "market closed",
    variant: "neutral",
    short: "outside trading hours",
    what: "The market is outside trading hours, so no correction order can go out.",
  },
  skipped_large: {
    label: "large mismatch",
    variant: "error",
    short: "past the safety cap, never automatic",
    what: "The delta is past the safety cap. Corrections that big are never automatic and need a look.",
  },
  skipped_recent_exit: {
    label: "recent exit",
    variant: "neutral",
    short: "an exit just filled, bookkeeping still landing",
    what: "An exit filled moments ago and its bookkeeping may still be landing. Correcting inside that window reopens a position that was just closed.",
  },
  skipped_manual: {
    label: "manual position",
    variant: "neutral",
    short: "your own manual size sits on the pair",
    what: "An open manual position sits on this pair, so the delta cannot be told apart from your own hand-placed size.",
  },
  skipped_unattributed: {
    label: "unattributed",
    variant: "warning",
    short: "executions predate account tracking",
    what: "Executions here predate account tracking, so reconciliation is paused for the pair.",
  },
  alert_observed_mismatch: {
    label: "observed mismatch",
    variant: "error",
    short: "detect-only venue, reported but never corrected",
    what: "Detect-only venue: the drift is reported, never corrected. Crypto positions are per-signal instruments, so an autonomous order would be the executor deciding on its own.",
  },
  alert_foreign_order: {
    label: "foreign order",
    variant: "error",
    short: "an order the executor did not place",
    what: "An order on this symbol was not placed by the executor.",
  },
};

function actionBadge(action: string) {
  const m = ACTIONS[action] ?? { label: action, variant: "secondary" as const, short: "", what: "" };
  return (
    <Badge variant={m.variant} title={m.what || undefined}>
      {m.label}
    </Badge>
  );
}

const EXPECTED_HINT =
  "What the executor's own book says the net position should be: the sum of its open executions on this account and symbol.";
const BROKER_HINT =
  "The net position the broker reports for the same account and symbol, summed over its legs.";
const DELTA_HINT =
  "Expected net minus broker net, in contracts. The signed size a correction would have to trade to line the broker up with the book: positive means buy, negative means sell.";

function OutcomeCell({ finding }: { finding: FindingStatus }) {
  if (finding === "settled") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-[var(--kb-green)]">
        <Check className="size-3.5" /> settled
      </span>
    );
  }
  if (finding === "archived") {
    return (
      <span
        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"
        title="No account on this row, so no pass can match it. It stays as history."
      >
        <Archive className="size-3.5" /> archived
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 text-[11px] text-[var(--kb-red)]"
      title="The expected net still differs from the broker net and the reconciler did not settle it."
    >
      <AlertTriangle className="size-3.5" /> open
    </span>
  );
}

/** Every action the log can hold, as one tooltip on the Decision column. */
const ACTION_GLOSSARY = Object.values(ACTIONS)
  .map((a) => `${a.label}: ${a.short}`)
  .join("\n");

// Leading status-dot colour per reconciler action (recent-runs list).
function actionDot(action: string): string {
  const v = ACTIONS[action]?.variant;
  if (v === "success") return "var(--kb-green)";
  if (v === "error") return "var(--kb-red)";
  if (v === "warning") return "var(--kb-amber)";
  return "hsl(var(--muted-foreground))";
}

export default function Reconciliation() {
  const { data, error, isStale, isLoading: loading, lastUpdated, refresh } =
    usePolledResource(() => opsApi.reconciliations(), { intervalMs: 5000 });

  const recent = data?.recent ?? [];
  const latest = data?.latestPerSymbol ?? [];
  const mismatched = data?.mismatched ?? [];
  const archived = data?.archived ?? [];
  const loop = data?.reconciler ?? null;

  const settledCount = latest.filter((r) => r.finding === "settled").length;
  const corrections24h = recent.filter(
    (r) => r.action === "corrected" && Date.now() - r.ts < 24 * 60 * 60 * 1000,
  ).length;
  // The reconciler only writes a row when it FOUND something, so the newest row
  // is the last incident, never the last pass. It runs every 60s.
  const lastIncident = recent.length > 0 ? Math.max(...recent.map((r) => r.ts)) : null;
  const intervalLabel = loop ? `${Math.round(loop.intervalMs / 1000)}s` : "60s";

  return (
    <div className="flex flex-col text-foreground">
      <PageHeader
        title="Reconciliation"
        description="Every drift the reconciler found between the executor's expected net and the broker net, per account and symbol."
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
              {
                label: "Pairs with findings",
                value: latest.length,
                icon: Scale,
                caption: "clean passes leave no record",
                hint: `Account and symbol pairs the reconciler has ever written a row for. A pass that finds nothing writes nothing, so this counts history, not what it is watching right now (that runs every ${intervalLabel} over every pair with an open execution).`,
              },
              {
                label: "Settled",
                value: settledCount,
                focal: true,
                valueClassName: "text-[var(--kb-green)]",
                hint: "Findings the reconciler resolved: it corrected the net, adopted a broker position onto the books, or booked a close it found at the venue.",
              },
              {
                label: "Open",
                value: mismatched.length,
                valueClassName: mismatched.length > 0 ? "text-[var(--kb-red)]" : undefined,
                hint: "Pairs where the expected net still differs from the broker net and the reconciler did not settle it, usually because a guard held the correction back. These need a look.",
              },
              {
                label: "Archived",
                value: archived.length,
                valueClassName: archived.length > 0 ? "text-muted-foreground" : undefined,
                hint: "Findings from before the reconciler keyed on the broker account. They carry no account, so no later pass can match them and they can never resolve. Kept as history, left out of Open.",
              },
              {
                label: "Corrections 24h",
                value: corrections24h,
                hint: "Correction orders the reconciler actually sent in the last 24 hours. Adoptions and skipped passes are not counted: no order went out for those.",
              },
              {
                label: "Last finding",
                value: lastIncident ? `${relativeTime(lastIncident)} ago` : "—",
                caption: lastIncident ? fmtTime(lastIncident) : undefined,
                hint: "When the reconciler last found drift. Not when it last ran: see the clean pass under Recent runs.",
              },
            ]}
            size="md"
          />

          <Section
            label="Per-position status"
            flush
            meta={
              mismatched.length > 0
                ? `${mismatched.length} open`
                : archived.length > 0
                  ? `all settled · ${archived.length} archived`
                  : "all settled"
            }
          >
            {latest.length === 0 ? (
              <EmptyState
                icon={Scale}
                title="Nothing to reconcile"
                description="The reconciler compares the executor's expected net against the broker every 60s and only records a pass that found drift."
              />
            ) : (
              <DataMatrix
                rows={latest}
                rowKey={(r) => `${r.exchange}:${r.account_id}:${r.symbol}`}
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
                    key: "account",
                    header: "Account",
                    sortable: true,
                    sortAccessor: (r) => r.account_id,
                    cell: (r) => (
                      <span className="font-mono text-[10px] text-muted-foreground">{r.account_id}</span>
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
                    hint: EXPECTED_HINT,
                    cell: (r) => <span className="font-mono">{r.expected_net}</span>,
                  },
                  {
                    key: "broker",
                    header: "Broker net",
                    align: "right",
                    hint: BROKER_HINT,
                    cell: (r) => <span className="font-mono">{r.broker_net}</span>,
                  },
                  {
                    key: "matched",
                    header: "Outcome",
                    hint: "settled: the reconciler resolved the drift. open: it still stands. archived: a pre-account-scoping row that can never resolve.",
                    cell: (r) => <OutcomeCell finding={r.finding} />,
                  },
                  {
                    key: "last",
                    header: "Found at",
                    sortable: true,
                    sortAccessor: (r) => r.ts,
                    hint: "When this finding was written. A settled pair keeps the timestamp of the pass that settled it.",
                    cell: (r) => (
                      <span className="whitespace-nowrap text-[10px] text-muted-foreground">{fmtTime(r.ts)}</span>
                    ),
                  },
                ]}
              />
            )}
          </Section>

          <Section
            label="Recent runs"
            flush
            noBorder
            meta={
              loop?.lastCleanPassAt != null ? (
                <span className="inline-flex items-center gap-1 text-[var(--kb-green)]">
                  <Check className="size-3" /> last clean pass {fmtTime(loop.lastCleanPassAt)}
                </span>
              ) : loop?.lastTickAt != null ? (
                <span>last pass {fmtTime(loop.lastTickAt)}, drift found</span>
              ) : (
                <span className="text-muted-foreground">no pass since restart</span>
              )
            }
          >
            {recent.length === 0 ? (
              <EmptyState
                icon={Scale}
                title="No drift on record"
                description={
                  loop?.lastCleanPassAt != null
                    ? `Every pass so far found the broker net where the book expected it. The last one ran ${fmtTime(loop.lastCleanPassAt)}.`
                    : `The reconciler compares the book against the broker every ${intervalLabel} and records a pass only when it finds drift.`
                }
              />
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
                    hint: EXPECTED_HINT,
                    cell: (r) => <span className="font-mono">{r.expected_net}</span>,
                  },
                  {
                    key: "broker",
                    header: "Broker",
                    align: "right",
                    hint: BROKER_HINT,
                    cell: (r) => <span className="font-mono">{r.broker_net}</span>,
                  },
                  {
                    key: "delta",
                    header: "Delta",
                    align: "right",
                    sortable: true,
                    sortAccessor: (r) => Math.abs(r.delta),
                    hint: DELTA_HINT,
                    cell: (r) => (
                      <span className={`font-mono ${r.delta !== 0 ? "text-[var(--kb-amber)]" : ""}`}>
                        {r.delta > 0 ? `+${r.delta}` : r.delta}
                      </span>
                    ),
                  },
                  {
                    key: "decision",
                    header: "Decision",
                    hint: ACTION_GLOSSARY,
                    cell: (r) => actionBadge(r.action),
                  },
                  {
                    key: "correction",
                    header: "Correction",
                    hint: "The order the reconciler sent, if any: side, size and how it ended. Empty when the pass decided not to trade.",
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

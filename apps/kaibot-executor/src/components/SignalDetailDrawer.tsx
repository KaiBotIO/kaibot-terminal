import {
  Badge,
  DataMatrix,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  fmtDateTime,
  resolvedTimeZone,
} from "@kaibot/shared";
import { AlertTriangle, Check, Clock } from "@/lib/icons";
import { opsApi, type ExecutionDetail } from "@/lib/ops-api";
import { usePolledResource } from "@/hooks/usePolledResource";
import { clipSummary, outcomeAccount, parseAccountOutcomes, signalReason } from "@/lib/signal-reason";

// Clock time in the display zone; the drawer's timeline carries the date.
// Why a signal was parked or dropped before it reached the venue.
const QUEUE_REASON_LABEL: Record<string, string> = {
  bot_phasing_out: "bot phasing out: no new entries, exits still flow",
  bot_detached: "bot detached (take-over)",
  sub_paused: "subscription paused",
  stale_open: "stale entry (replayed too late)",
  close_replay: "close replayed",
  replay_already_terminal: "replayed after a final outcome",
  within_window_replay: "duplicate within the replay window",
  basis_guard: "basis guard",
  duplicate_open: "duplicate open",
  deferred_market_closed: "market closed, waiting for the next session",
  deferred_resumed: "market open, entry resumed",
  deferred_expired: "market stayed closed past the wait limit",
  deferred_cancelled: "cancelled by a later close while waiting for market open",
  deferred_weekend_drop: "market closed for the weekend",
  replay_deferred: "replayed while waiting for market open",
};

const fmtTime = (ms: number) =>
  new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: resolvedTimeZone(),
  }).format(new Date(ms));

const money = (v: number | null | undefined) =>
  v == null ? "—" : `${v >= 0 ? "+" : "-"}$${Math.abs(v).toFixed(2)}`;
const price = (v: number | null | undefined) =>
  v == null ? "—" : v.toLocaleString("en-US", { maximumFractionDigits: 8 });
const qty = (v: number | null | undefined) =>
  v == null ? "—" : v.toLocaleString("en-US", { maximumFractionDigits: 8 });

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="min-w-0 truncate text-right font-mono text-xs">{value}</span>
    </div>
  );
}

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-border px-5 py-3">
      <h3 className="mb-1 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </h3>
      {children}
    </section>
  );
}

function statusBadge(status: string) {
  const variant =
    status === "executed" || status === "closed"
      ? "success"
      : status === "rejected" || status === "error"
        ? "error"
        : status === "expired" || status === "deferred"
          ? "warning"
          : "secondary";
  return <Badge variant={variant}>{status}</Badge>;
}

/**
 * Everything the executor knows about one signal, in the order the question
 * gets asked: what came in, who routed it, what the guardrails did to it, when
 * each step happened, and what it ended up costing.
 */
export function SignalDetailDrawer({
  signalId,
  onClose,
}: {
  signalId: string | null;
  onClose: () => void;
}) {
  const { data, isLoading, error } = usePolledResource<ExecutionDetail>(
    () => opsApi.execution(signalId!),
    { intervalMs: 5000, enabled: signalId != null },
  );

  const signal = data?.signal ?? null;
  const exec = data?.execution ?? null;
  const sub = data?.subscription ?? null;
  const clips = data?.clips ?? [];
  const pnl = data?.pnl ?? null;
  const fills = data?.fills ?? [];
  const account = exec?.account_id ?? sub?.accountId ?? null;
  const accountOutcomes = parseAccountOutcomes(signal?.account_outcomes);
  const reason = signal
    ? signalReason({
        status: signal.status,
        errorMessage: signal.error_message,
        accountId: account,
        accountOutcomes,
        clips,
      })
    : null;

  return (
    <Sheet open={signalId != null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="w-full gap-0 overflow-y-auto p-0 sm:max-w-xl"
      >
        <SheetHeader className="px-5 py-4">
          <SheetTitle className="flex items-center gap-2 font-mono text-sm">
            {signal ? `${signal.action.toUpperCase()} ${signal.symbol}` : "Signal"}
            {signal && statusBadge(signal.status)}
          </SheetTitle>
          <SheetDescription className="font-mono text-[11px]">
            {signalId}
          </SheetDescription>
        </SheetHeader>

        {isLoading && !data ? (
          <div className="px-5 py-8 text-center font-mono text-[11px] text-muted-foreground">
            Loading…
          </div>
        ) : error != null && !data ? (
          <div className="px-5 py-8 text-center font-mono text-[11px] text-[var(--kb-red)]">
            The executor didn't return this signal.
          </div>
        ) : (
          <>
            {reason && (
              <div
                className={`border-t border-border px-5 py-3 font-mono text-[11px] ${
                  signal?.status === "rejected"
                    ? "text-[var(--kb-red)]"
                    : signal?.status === "expired" ||
                        signal?.status === "pending" ||
                        signal?.status === "deferred"
                      ? "text-[var(--kb-amber)]"
                      : "text-muted-foreground"
                }`}
              >
                {reason}
              </div>
            )}

            <Block label="Signal">
              <Field label="Bot" value={sub?.botName ?? signal?.strategy_name ?? "—"} />
              <Field
                label="Subscription"
                value={
                  sub ? (
                    <span>
                      {sub.id} · {sub.factor}× {sub.status !== "active" && `· ${sub.status}`}
                    </span>
                  ) : (
                    "—"
                  )
                }
              />
              <Field
                label="Account"
                value={account ? `${exec?.exchange ?? sub?.exchange ?? ""} ${account}`.trim() : "—"}
              />
              <Field label="Signal price" value={price(signal?.price)} />
              <Field label="Signal qty" value={qty(signal?.quantity)} />
              <Field label="Stop loss" value={price(signal?.stop_loss)} />
              <Field label="Take profit" value={price(signal?.take_profit)} />
            </Block>

            <Block label="Timeline">
              <Field
                label="Received"
                value={signal?.received_at ? fmtDateTime(signal.received_at) : "—"}
              />
              <Field
                label="Processed"
                value={signal?.processed_at ? fmtDateTime(signal.processed_at) : "not processed"}
              />
              <Field
                label="Acked to server"
                value={
                  signal?.acked_at ? (
                    <span
                      className={
                        signal.ack_status === "failed" ? "text-[var(--kb-red)]" : undefined
                      }
                    >
                      {fmtDateTime(signal.acked_at)}
                      {signal.ack_status === "failed" && " · failed"}
                    </span>
                  ) : (
                    "not acked"
                  )
                }
              />
              <p className="pt-1 font-mono text-[10px] text-muted-foreground">
                {resolvedTimeZone()}
              </p>
            </Block>

            {accountOutcomes.length > 1 && (
              <Block label="Accounts">
                {accountOutcomes.map((o) => (
                  <div
                    key={o.signalId}
                    className="flex items-baseline justify-between gap-3 py-1 font-mono text-[11px]"
                  >
                    <span className="min-w-0 truncate">
                      {o.exchange ? `${o.exchange} ` : ""}
                      {outcomeAccount(o)}
                    </span>
                    <span className="flex min-w-0 items-center gap-2">
                      {statusBadge(o.status === "executed" ? "executed" : o.status)}
                      <span className="max-w-[16rem] truncate text-muted-foreground" title={o.reason ?? o.orderId ?? undefined}>
                        {o.status === "executed" ? (o.orderId ?? "") : (o.reason ?? "")}
                      </span>
                    </span>
                  </div>
                ))}
              </Block>
            )}

            {(data?.queue ?? []).filter((q) => q.reason).length > 0 && (
              <Block label="Safety clips">
                {(data?.queue ?? [])
                  .filter((q) => q.reason)
                  .map((q) => (
                    <div key={q.id} className="flex items-center gap-2 py-1 font-mono text-[11px]">
                      <AlertTriangle className="size-3 shrink-0 text-[var(--kb-amber)]" />
                      <span>{QUEUE_REASON_LABEL[q.reason ?? ""] ?? (q.reason ?? "").replace(/_/g, " ")}</span>
                    </div>
                  ))}
              </Block>
            )}

            {clips.length > 0 && (
              <Block label="Guardrail clips">
                {clips.map((c) => (
                  <div
                    key={c.id}
                    className="flex items-center gap-2 py-1 font-mono text-[11px]"
                  >
                    <AlertTriangle className="size-3 shrink-0 text-[var(--kb-amber)]" />
                    <span>{clipSummary(c)}</span>
                  </div>
                ))}
              </Block>
            )}

            {exec && (
              <Block label="Execution">
                <Field label="Direction" value={exec.direction} />
                <Field label="Qty open / closed" value={`${exec.qty_opened} / ${exec.qty_closed}`} />
                <Field label="Avg entry" value={price(pnl?.entryAvg)} />
                <Field label="Avg exit" value={price(pnl?.exitAvg)} />
                <Field
                  label="Realized net"
                  value={
                    exec.qty_closed <= 0 ? (
                      "—"
                    ) : pnl?.exitAvg == null ? (
                      <span
                        className="text-[var(--kb-amber)]"
                        title="Closed without an exit fill, so there is no price to realize against"
                      >
                        no exit price
                      </span>
                    ) : (
                      money(pnl?.realizedNet)
                    )
                  }
                />
                <Field label="Unrealized" value={money(pnl?.unrealizedPnl)} />
                {exec.error_reason && (
                  <p className="pt-1 font-mono text-[11px] text-[var(--kb-red)]">
                    {exec.error_reason}
                  </p>
                )}
              </Block>
            )}

            {data?.bracket && (
              <Block label="Bracket">
                <Field label="Stop order" value={data.bracket.sl_order_id ?? "—"} />
                <Field label="Take-profit order" value={data.bracket.tp_order_id ?? "—"} />
              </Block>
            )}

            {fills.length > 0 && (
              <Block label="Fills">
                <DataMatrix
                  className="text-[11px]"
                  rows={fills}
                  rowKey={(f) => String(f.id)}
                  columns={[
                    { key: "kind", header: "Kind", cell: (f) => f.kind },
                    { key: "side", header: "Side", cell: (f) => f.side },
                    { key: "qty", header: "Qty", align: "right", cell: (f) => qty(f.qty) },
                    { key: "price", header: "Price", align: "right", cell: (f) => price(f.price) },
                    {
                      key: "time",
                      header: "Time",
                      align: "right",
                      cell: (f) => (
                        <span
                          className="whitespace-nowrap text-[10px] text-muted-foreground"
                          title={fmtDateTime(f.created_at)}
                        >
                          {fmtTime(f.created_at)}
                        </span>
                      ),
                    },
                  ]}
                />
              </Block>
            )}

            {(data?.settlements.length ?? 0) > 0 && (
              <Block label="Unresolved orders">
                {data!.settlements.map((s) => (
                  <div key={s.id} className="flex items-center gap-2 py-1 font-mono text-[11px]">
                    {s.resolved_at ? (
                      <Check className="size-3 shrink-0 text-[var(--kb-green)]" />
                    ) : (
                      <Clock className="size-3 shrink-0 text-[var(--kb-amber)]" />
                    )}
                    <span>
                      {s.kind} {s.side} {qty(s.qty)} · {s.order_id} · {s.status}
                    </span>
                  </div>
                ))}
              </Block>
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

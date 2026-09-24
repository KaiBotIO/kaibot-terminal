import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button, Badge, DataFreshness, DataMatrix, EmptyState, PageHeader, Section, StatStrip, Tabs, TabsContent, TabsList, TabsTrigger, downloadCsv, fmtDateTime, parseTimestamp, toCsv } from "@kaibot/shared";
import {
  Bell,
  Activity as ActivityIcon,
  AlertCircle,
  CheckCircle,
  XCircle,
  Info,
  RefreshCw,
  Clock,
  Download,
  Wifi,
  WifiOff,
  Radio,
} from "@/lib/icons";
import { useAtomValue, useSetAtom } from "jotai";
import {
  activityEventsAtom,
  activityLastSeenAtom,
  backendLinkAtom,
  lastSignalAtAtom,
  type ActivityEvent,
  type NotificationEventType,
} from "@/lib/atoms";
import { useConnectionStatus } from "@/hooks/useConnectionStatus";
import { usePolledResource } from "@/hooks/usePolledResource";
import { apiFetch } from "@/lib/api";
import { parseAccountOutcomes, reasonTone, signalReason } from "@/lib/signal-reason";
import { SignalDetailDrawer } from "@/components/SignalDetailDrawer";

type Category = "info" | "success" | "warning" | "error";

interface ActivityItem {
  id: string;
  type: "signal" | "order" | "connection" | "system";
  category: Category;
  title: string;
  description: string;
  timestamp: string;
  symbol?: string;
  error?: string;
  // The signal id this item belongs to, when known — drives the click-through to
  // the per-signal execution detail screen.
  signalId?: string;
  /** One line stating why the signal ended this way; null when it is obvious. */
  reason?: string | null;
  /** Drives the tone of that line. */
  status?: string;
}

interface SignalRow {
  id: string;
  symbol: string;
  action: string;
  status: string;
  error_message?: string | null;
  received_at?: string;
  strategy_name?: string;
  quantity?: number | null;
  price?: number | null;
  /** Account the execution landed on, joined in by /api/signals. */
  account_id?: string | null;
  clip_count?: number | null;
  /** JSON per-account outcomes when the bot ran on several subscriptions. */
  account_outcomes?: string | null;
}

export interface SignalPnlRow {
  signalId: string;
  symbol: string;
  exchange: string;
  direction: "long" | "short";
  status: "open" | "closed" | "error";
  qtyOpened: number;
  qtyClosed: number;
  entryAvg: number | null;
  exitAvg: number | null;
  realizedPnl: number;
  realizedNet: number;
  unrealizedPnl: number | null;
  updatedAt: number;
}

function categoryForEvent(type: NotificationEventType): Category {
  switch (type) {
    case "order_filled":
    case "connection_restored":
    case "entry_resumed":
      return "success";
    case "order_rejected":
    case "connection_lost":
    case "executor_conflict":
    case "error":
    case "entry_deferred":
    case "entry_deferred_dropped":
      return "warning";
    default:
      return "info";
  }
}

function typeForEvent(type: NotificationEventType): ActivityItem["type"] {
  if (
    type === "signal_received" ||
    type === "entry_deferred" ||
    type === "entry_resumed" ||
    type === "entry_deferred_dropped"
  )
    return "signal";
  if (type === "order_filled" || type === "order_rejected") return "order";
  if (type === "connection_lost" || type === "connection_restored" || type === "executor_conflict") return "connection";
  return "system";
}

function eventToItem(e: ActivityEvent): ActivityItem {
  return {
    id: e.id,
    type: typeForEvent(e.type),
    category: categoryForEvent(e.type),
    title: e.title,
    description: e.body,
    timestamp: e.timestamp,
    symbol: typeof e.data?.symbol === "string" ? (e.data.symbol as string) : undefined,
    error: typeof e.data?.error === "string" ? (e.data.error as string) : undefined,
    signalId: typeof e.data?.signalId === "string" ? (e.data.signalId as string) : undefined,
  };
}

function signalToItem(s: SignalRow): ActivityItem {
  const rejected = s.status === "rejected" || s.status === "expired";
  const executed = s.status === "executed" || s.status === "closed";
  const waiting = s.status === "deferred";
  return {
    id: `signal-${s.id}`,
    type: "signal",
    category: rejected ? "error" : executed ? "success" : waiting ? "warning" : "info",
    title: `${s.action?.toUpperCase?.() ?? "SIGNAL"} ${s.symbol}`,
    // The status is the badge; the strategy is what the row is about.
    description: s.strategy_name ?? s.status,
    timestamp: s.received_at ?? "",
    symbol: s.symbol,
    signalId: s.id,
    status: s.status,
    // The clip count says a clipped execution has a story worth a line; the
    // clips themselves live in the drawer.
    reason: signalReason({
      status: s.status,
      errorMessage: s.error_message,
      accountId: s.account_id,
      accountOutcomes: parseAccountOutcomes(s.account_outcomes),
      clipCount: s.clip_count ?? 0,
    }),
  };
}

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const t = parseTimestamp(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diff = Math.max(0, Date.now() - t);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return fmtDateTime(iso);
}

// Timezone-explicit absolute time for tooltips/exports; "—" for blanks.
function absTime(iso: string | null): string {
  if (!iso) return "—";
  const t = parseTimestamp(iso).getTime();
  if (Number.isNaN(t)) return iso;
  return fmtDateTime(t);
}

export default function Activity() {
  const [params, setParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState("all");
  const events = useAtomValue(activityEventsAtom);
  const setActivityLastSeen = useSetAtom(activityLastSeenAtom);
  // Viewing the feed clears the topbar unread badge, also for events arriving
  // while the page is open.
  useEffect(() => {
    setActivityLastSeen(new Date().toISOString());
  }, [events, setActivityLastSeen]);
  const backendLink = useAtomValue(backendLinkAtom);
  const lastSignalAt = useAtomValue(lastSignalAtAtom);
  const signalService = useConnectionStatus();
  const [tick, setTick] = useState(0);

  const { data, error, isLoading, lastUpdated, refresh } = usePolledResource(
    async () => {
      const res = await apiFetch("/api/signals");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const signals: SignalRow[] = await res.json();

      // P&L is best effort — a failure here never blocks the signal feed.
      let pnlRows: SignalPnlRow[] = [];
      let realizedTotal = 0;
      try {
        const pnlRes = await apiFetch("/api/performance/signal-pnl?limit=100");
        if (pnlRes.ok) {
          const json = await pnlRes.json();
          pnlRows = json.rows || [];
          realizedTotal = Number(json.realizedTotal || 0);
        }
      } catch {
        /* ignore */
      }
      return { signals, pnlRows, realizedTotal };
    },
    { intervalMs: 5000 },
  );
  const signalRows = data?.signals ?? [];
  const pnlRows = data?.pnlRows ?? [];
  const realizedTotal = data?.realizedTotal ?? 0;
  const loading = isLoading && !data;

  useEffect(() => {
    // keep relative timestamps fresh
    const clock = setInterval(() => setTick((t) => t + 1), 15000);
    return () => clearInterval(clock);
  }, []);

  // Merge live notification events with persisted signal rows, de-duplicated by
  // id, newest first. Live events win when both exist (they carry richer copy).
  const items = useMemo<ActivityItem[]>(() => {
    void tick;
    const byId = new Map<string, ActivityItem>();
    for (const s of signalRows) {
      const item = signalToItem(s);
      byId.set(item.id, item);
    }
    for (const e of events) byId.set(e.id, eventToItem(e));
    return Array.from(byId.values()).sort(
      (a, b) => parseTimestamp(b.timestamp).getTime() - parseTimestamp(a.timestamp).getTime(),
    );
  }, [events, signalRows, tick]);

  const filtered = items.filter((i) => (activeTab === "all" ? true : i.type === activeTab));
  const errorCount = items.filter((i) => i.category === "error" || i.category === "warning").length;

  // The drawer keeps the feed on screen: reading one signal should not cost you
  // your place in the list. It lives in the query string, so a signal stays
  // linkable and survives a refresh.
  const openSignalId = params.get("signal");
  const openSignal = (signalId: string) =>
    setParams((p) => {
      const next = new URLSearchParams(p);
      next.set("signal", signalId);
      return next;
    });
  const closeSignal = () =>
    setParams((p) => {
      const next = new URLSearchParams(p);
      next.delete("signal");
      return next;
    });

  const exportCsv = () => {
    downloadCsv(
      "activity.csv",
      toCsv(items, [
        { header: "Time", value: (i) => absTime(i.timestamp) },
        { header: "Type", value: (i) => i.type },
        { header: "Category", value: (i) => i.category },
        { header: "Title", value: (i) => i.title },
        { header: "Description", value: (i) => i.description },
        { header: "Symbol", value: (i) => i.symbol ?? "" },
        { header: "Error", value: (i) => i.error ?? "" },
      ]),
    );
  };

  return (
    <div className="flex flex-col text-foreground">
      <PageHeader
        title="Activity"
        description="Connection state, signals, and execution outcomes"
        actions={
          <div className="flex items-center gap-2">
            <DataFreshness
              updatedAt={lastUpdated}
              isRefreshing={isLoading}
              onRefresh={refresh}
            />
            {items.length > 0 && (
              <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={exportCsv}>
                <Download className="size-3 mr-1" />
                Export CSV
              </Button>
            )}
          </div>
        }
      />

      <ConnectionBanner
        backendLink={backendLink}
        signalConnected={signalService.connected}
        signalStatus={signalService.status}
        downSince={signalService.downSince}
        lastSignalAt={lastSignalAt}
      />

      <StatStrip
        items={[
          { label: "Events", value: items.length, icon: ActivityIcon },
          { label: "Errors / Warnings", value: errorCount, icon: AlertCircle },
          { label: "Last Signal", value: relativeTime(lastSignalAt), icon: Bell },
        ]}
      />

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <Section flush noBorder bodyClassName="px-6 pt-3">
          <TabsList variant="line">
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="signal">Signals</TabsTrigger>
            <TabsTrigger value="order">Orders</TabsTrigger>
            <TabsTrigger value="connection">Connection</TabsTrigger>
            <TabsTrigger value="system">System</TabsTrigger>
            <TabsTrigger value="pnl">P&amp;L</TabsTrigger>
          </TabsList>
        </Section>

        {activeTab === "pnl" ? (
          <TabsContent value="pnl">
            <SignalPnlPanel
              rows={pnlRows}
              realizedTotal={realizedTotal}
              loading={loading}
              hasError={error != null}
              onRetry={refresh}
              onOpen={openSignal}
            />
          </TabsContent>
        ) : (
          <TabsContent value={activeTab}>
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <RefreshCw className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : error != null && filtered.length === 0 ? (
              <Section flush noBorder>
                <EmptyState
                  icon={AlertCircle}
                  title="Couldn't load activity"
                  description="The executor backend didn't respond. Recent signals and orders may exist."
                  action={<Button onClick={refresh}>Retry</Button>}
                />
              </Section>
            ) : filtered.length === 0 ? (
              <Section flush noBorder>
                <EmptyState
                  icon={ActivityIcon}
                  title="No activity yet"
                  description="Signals and execution outcomes will appear here."
                />
              </Section>
            ) : (
              <Section flush noBorder>
                <div className="divide-y divide-border">
                  {filtered.map((item) => (
                    <ActivityRow key={item.id} item={item} onOpen={openSignal} />
                  ))}
                </div>
              </Section>
            )}
          </TabsContent>
        )}
      </Tabs>

      <SignalDetailDrawer signalId={openSignalId} onClose={closeSignal} />
    </div>
  );
}

// A close booked without an exit fill has no price to realize against, so its
// realizedNet is a structural 0, never a break-even trade.
export function hasRealized(r: Pick<SignalPnlRow, "qtyClosed" | "exitAvg">): boolean {
  return r.qtyClosed > 0 && r.exitAvg != null;
}

function SignalPnlPanel({
  rows,
  realizedTotal,
  loading,
  hasError,
  onRetry,
  onOpen,
}: {
  rows: SignalPnlRow[];
  realizedTotal: number;
  loading: boolean;
  hasError: boolean;
  onRetry: () => void;
  onOpen: (signalId: string) => void;
}) {
  const fmt = (v: number) => `${v >= 0 ? "+" : "-"}$${Math.abs(v).toFixed(2)}`;
  const pnlClass = (v: number) => (v >= 0 ? "text-[var(--kb-green)]" : "text-[var(--kb-red)]");
  const unpriced = rows.filter((r) => r.status === "closed" && !hasRealized(r)).length;
  return (
    <>
      <StatStrip
        items={[
          {
            label: "Realized P&L (net)",
            value: fmt(realizedTotal),
            focal: realizedTotal >= 0,
            valueClassName: pnlClass(realizedTotal),
            caption: unpriced > 0
              ? `fills-based · ${unpriced} close${unpriced === 1 ? "" : "s"} without an exit price excluded`
              : "fills-based",
          },
        ]}
      />

      {loading ? (
        <div className="flex items-center justify-center py-8">
          <RefreshCw className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : hasError && rows.length === 0 ? (
        <Section flush noBorder>
          <EmptyState
            icon={AlertCircle}
            title="Couldn't load P&L"
            description="The executor backend didn't respond. Executions may exist."
            action={<Button onClick={onRetry}>Retry</Button>}
          />
        </Section>
      ) : rows.length === 0 ? (
        <Section flush noBorder>
          <EmptyState
            icon={ActivityIcon}
            title="No executions yet"
            description="Per-signal P&L appears here once signals execute. Computed from actual fills (per-root futures multipliers)."
          />
        </Section>
      ) : (
        <Section flush noBorder>
          <DataMatrix
            rows={rows}
            rowKey={(r) => r.signalId}
            onRowClick={(r) => onOpen(r.signalId)}
            defaultSort={{ key: "updated", dir: "desc" }}
            columns={[
              {
                key: "symbol",
                header: "Symbol",
                sortable: true,
                sortAccessor: (r) => r.symbol,
                cell: (r) => <span className="font-mono text-[var(--kb-teal)]">{r.symbol}</span>,
              },
              {
                key: "side",
                header: "Side",
                cell: (r) => <Badge variant={r.direction === "long" ? "success" : "error"}>{r.direction}</Badge>,
              },
              {
                key: "status",
                header: "Status",
                cell: (r) => (
                  <Badge variant={r.status === "error" ? "error" : r.status === "open" ? "success" : "neutral"}>
                    {r.status}
                  </Badge>
                ),
              },
              {
                key: "entry",
                header: "Entry",
                align: "right",
                cell: (r) => <span className="font-mono">{r.entryAvg != null ? r.entryAvg.toFixed(2) : "—"}</span>,
              },
              {
                key: "exit",
                header: "Exit",
                align: "right",
                cell: (r) => <span className="font-mono">{r.exitAvg != null ? r.exitAvg.toFixed(2) : "—"}</span>,
              },
              {
                key: "realized",
                header: "Realized",
                align: "right",
                sortable: true,
                sortAccessor: (r) => (hasRealized(r) ? r.realizedNet : null),
                cell: (r) =>
                  hasRealized(r) ? (
                    <span className={`font-mono ${pnlClass(r.realizedNet)}`}>
                      {fmt(r.realizedNet)}
                    </span>
                  ) : r.qtyClosed > 0 ? (
                    <span
                      className="font-mono text-[var(--kb-amber)]"
                      title="Closed without an exit fill, so there is no price to realize against"
                    >
                      no exit price
                    </span>
                  ) : (
                    <span className="font-mono text-muted-foreground">—</span>
                  ),
              },
              {
                key: "unrealized",
                header: "Unrealized",
                align: "right",
                sortable: true,
                sortAccessor: (r) => r.unrealizedPnl,
                cell: (r) => (
                  <span className={`font-mono ${r.unrealizedPnl != null ? pnlClass(r.unrealizedPnl) : ""}`}>
                    {r.unrealizedPnl != null ? fmt(r.unrealizedPnl) : "—"}
                  </span>
                ),
              },
              {
                key: "updated",
                header: "Updated",
                align: "right",
                sortable: true,
                sortAccessor: (r) => r.updatedAt,
                cell: (r) => (
                  <span className="whitespace-nowrap text-[10px] text-muted-foreground">
                    {fmtDateTime(r.updatedAt)}
                  </span>
                ),
              },
            ]}
          />
        </Section>
      )}
    </>
  );
}

function ConnectionBanner({
  backendLink,
  signalConnected,
  signalStatus,
  downSince,
  lastSignalAt,
}: {
  backendLink: "connecting" | "online" | "offline";
  signalConnected: boolean;
  signalStatus: string;
  downSince: string | null;
  lastSignalAt: string | null;
}) {
  const backendOffline = backendLink === "offline";
  const reconnecting = !signalConnected && (signalStatus === "connecting" || signalStatus === "reconnecting");
  const conflicted = !signalConnected && signalStatus === "conflict";

  let tone: "ok" | "warn" | "down";
  let label: string;
  if (backendOffline) {
    tone = "down";
    label = "Executor backend unreachable";
  } else if (signalConnected) {
    tone = "ok";
    label = "Signal service connected";
  } else if (conflicted) {
    tone = "warn";
    label = "Another executor is connected for this account";
  } else if (reconnecting) {
    tone = "warn";
    label = "Signal service reconnecting…";
  } else {
    tone = "down";
    label = downSince ? `Signal service down since ${relativeTime(downSince)}` : "Signal service disconnected";
  }

  const accent = tone === "ok" ? "var(--kb-green)" : tone === "warn" ? "var(--kb-amber)" : "var(--kb-red)";
  const Icon = tone === "ok" ? Wifi : tone === "warn" ? Radio : WifiOff;

  return (
    <Section flush>
      <div className="border-l-2 px-6 py-3" style={{ borderLeftColor: accent }}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="relative flex h-2 w-2">
              <span
                className={`absolute inline-flex h-full w-full rounded-full opacity-75 ${tone !== "ok" ? "animate-ping" : ""}`}
                style={{ backgroundColor: accent }}
              />
              <span className="relative inline-flex h-2 w-2 rounded-full" style={{ backgroundColor: accent }} />
            </span>
            <Icon className="size-4" style={{ color: accent }} />
            <span className="truncate text-sm font-medium">{label}</span>
          </div>
          <div className="flex items-center gap-4 font-mono text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1">
              backend
              <Badge
                variant={
                  backendLink === "online" ? "success" : backendLink === "connecting" ? "warning" : "error"
                }
              >
                {backendLink}
              </Badge>
            </span>
            <span className="flex items-center gap-1">
              <Clock className="size-2.5" />
              last signal {relativeTime(lastSignalAt)}
            </span>
          </div>
        </div>
      </div>
    </Section>
  );
}

function categoryIcon(category: Category) {
  switch (category) {
    case "success":
      return <CheckCircle className="size-3.5 text-[var(--kb-green)]" />;
    case "error":
      return <XCircle className="size-3.5 text-[var(--kb-red)]" />;
    case "warning":
      return <AlertCircle className="size-3.5 text-[var(--kb-amber)]" />;
    default:
      return <Info className="size-3.5 text-[var(--kb-blue)]" />;
  }
}

// Tone of the reason line: a rejection reads red, a delay amber, a clipped
// execution stays quiet.
function reasonClass(status?: string): string {
  const tone = reasonTone(status ?? "");
  if (tone === "error") return "text-[var(--kb-red)]";
  if (tone === "warning") return "text-[var(--kb-amber)]";
  return "text-muted-foreground";
}

function ActivityRow({ item, onOpen }: { item: ActivityItem; onOpen: (signalId: string) => void }) {
  const accent =
    item.category === "error"
      ? "var(--kb-red)"
      : item.category === "warning"
        ? "var(--kb-amber)"
        : item.category === "success"
          ? "var(--kb-green)"
          : "var(--kb-blue)";
  // Signal / order rows link through to the per-signal execution detail.
  const clickable = !!item.signalId && (item.type === "signal" || item.type === "order");
  return (
    <div
      className={`border-l-2 px-6 py-3 ${clickable ? "cursor-pointer transition-colors hover:bg-card" : ""}`}
      style={{ borderColor: accent }}
      onClick={clickable ? () => onOpen(item.signalId!) : undefined}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={
        clickable
          ? (e: React.KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpen(item.signalId!);
              }
            }
          : undefined
      }
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5">{categoryIcon(item.category)}</div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h4 className="truncate font-mono text-xs font-semibold">{item.title}</h4>
              <p className="mt-0.5 break-words text-[11px] text-muted-foreground">{item.description}</p>
              {item.reason && (
                <p
                  className={`mt-1 break-words font-mono text-[11px] ${reasonClass(item.status)}`}
                >
                  {item.reason}
                </p>
              )}
              {item.error && !item.reason && (
                <p className="mt-1 break-words font-mono text-[11px] text-[var(--kb-red)]">{item.error}</p>
              )}
            </div>
            <div
              className="flex items-center gap-1 whitespace-nowrap font-mono text-[10px] text-muted-foreground"
              title={absTime(item.timestamp)}
            >
              <Clock className="size-2.5" />
              {relativeTime(item.timestamp)}
            </div>
          </div>
          {item.symbol && (
            <span className="mt-1.5 inline-block font-mono text-[10px] uppercase text-[var(--kb-teal)]">
              {item.symbol}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

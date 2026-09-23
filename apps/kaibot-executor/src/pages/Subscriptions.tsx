import { useEffect, useState } from "react";
import {
  Button,
  Badge,
  DataFreshness,
  DataMatrix,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Input,
  Label,
  PageHeader,
  Section,
  StatStrip,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  fmtDate,
  fmtDateTime,
  parseTimestamp,
  useConfirm,
} from "@kaibot/shared";
import {
  AlertTriangle,
  Bot,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  Plus,
  Trash2,
  TrendingUp,
  ChevronRight,
  X,
} from "@/lib/icons";
import { toast } from "sonner";
import { NewSubscriptionWizard } from "@/components/NewSubscriptionWizard";
import { apiFetch } from "@/lib/api";
import { usePolledResource } from "@/hooks/usePolledResource";
import {
  ScorecardLine,
  useStrategyScorecards,
  type StrategyScorecard,
} from "@/components/StrategyScorecard";

interface ExecutorSubscription {
  id: string;
  signalBotId: string;
  botName: string | null;
  selectedMarkets: string[];
  factor: number;
  maxPositionSize: number | null;
  maxConcurrentTrades: number | null;
  exchange: string | null;
  accountId: string | null;
  // Connection label the sub routes through (null = default connection).
  accountKey?: string | null;
  status: "active" | "paused" | "cancelled";
  sizeUnit: "native" | "usd";
  createdAt: string;
  updatedAt: string;
}

interface SubscriptionDetail {
  subscription: ExecutorSubscription;
  signalCount24h: number;
  signals: any[];
}

interface SubsSnapshot {
  subscriptions: ExecutorSubscription[];
  signalCounts: Record<string, number>;
}

async function fetchSubscriptions(): Promise<SubsSnapshot> {
  const res = await apiFetch("/api/subscriptions?includeCancelled=true");
  if (!res.ok) throw new Error("Failed to load");
  const subscriptions: ExecutorSubscription[] = await res.json();

  // Fetch 24h counts in parallel (best effort)
  const signalCounts: Record<string, number> = {};
  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        const r = await apiFetch(`/api/subscriptions/${sub.id}`);
        if (r.ok) {
          const d: SubscriptionDetail = await r.json();
          signalCounts[sub.id] = d.signalCount24h;
        }
      } catch { /* ignore */ }
    }),
  );
  return { subscriptions, signalCounts };
}

export default function Subscriptions() {
  const { byBotId: scorecardsByBotId } = useStrategyScorecards();
  const { data, error, isLoading, lastUpdated, refresh: loadSubscriptions } =
    usePolledResource(fetchSubscriptions, { intervalMs: 10_000 });
  const subscriptions = data?.subscriptions ?? [];
  const signalCounts = data?.signalCounts ?? {};
  const [activeTab, setActiveTab] = useState("active");
  const [showWizard, setShowWizard] = useState(false);
  const [detail, setDetail] = useState<SubscriptionDetail | null>(null);
  const [editing, setEditing] = useState<ExecutorSubscription | null>(null);
  const { confirm, dialog: confirmDialog } = useConfirm();

  async function handlePauseResume(sub: ExecutorSubscription) {
    const action = sub.status === "active" ? "pause" : "resume";
    try {
      const res = await apiFetch(`/api/subscriptions/${sub.id}/${action}`, {
        method: "POST",
      });
      if (!res.ok) throw new Error();
      toast.success(`Subscription ${action}d`);
      loadSubscriptions();
    } catch {
      toast.error(`Failed to ${action}`);
    }
  }

  async function handleCancel(sub: ExecutorSubscription) {
    const ok = await confirm({
      title: "Cancel subscription?",
      description: `Stop following "${sub.botName || sub.signalBotId}". Open positions are not closed.`,
      tone: "destructive",
      confirmLabel: "Cancel subscription",
    });
    if (!ok) return;
    try {
      const res = await apiFetch(`/api/subscriptions/${sub.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      toast.success("Subscription cancelled");
      loadSubscriptions();
    } catch {
      toast.error("Failed to cancel");
    }
  }

  async function openDetail(sub: ExecutorSubscription) {
    try {
      const res = await apiFetch(`/api/subscriptions/${sub.id}`);
      if (!res.ok) throw new Error();
      setDetail(await res.json());
    } catch {
      toast.error("Failed to load detail");
    }
  }

  async function handleReactivate(sub: ExecutorSubscription) {
    try {
      const res = await apiFetch(`/api/subscriptions/${sub.id}/resume`, {
        method: "POST",
      });
      if (!res.ok) throw new Error();
      toast.success("Subscription reactivated");
      loadSubscriptions();
    } catch {
      toast.error("Failed to reactivate");
    }
  }

  const byCreatedDesc = (a: ExecutorSubscription, b: ExecutorSubscription) =>
    parseTimestamp(b.createdAt).getTime() - parseTimestamp(a.createdAt).getTime();
  const activeList = subscriptions.filter((s) => s.status !== "cancelled").sort(byCreatedDesc);
  const cancelledList = subscriptions.filter((s) => s.status === "cancelled").sort(byCreatedDesc);

  return (
    <div className="flex flex-col text-foreground">
      <PageHeader
        title="Signal Subscriptions"
        description="Subscribe to signal bots from the marketplace and control factor scaling locally"
        actions={
          <div className="flex items-center gap-2">
            <DataFreshness
              updatedAt={lastUpdated}
              isRefreshing={isLoading}
              onRefresh={loadSubscriptions}
            />
            <Button size="sm" className="h-7 text-[11px]" onClick={() => setShowWizard(true)}>
              <Plus className="size-3 mr-1" />
              New Subscription
            </Button>
          </div>
        }
      />

      {/* Summary */}
      <StatStrip
        items={[
          {
            label: "Active",
            value: subscriptions.filter((s) => s.status === "active").length,
            caption: `${subscriptions.filter((s) => s.status === "paused").length} paused`,
            focal: true,
          },
          {
            label: "Signals (24h)",
            value: Object.values(signalCounts).reduce((a, b) => a + b, 0),
            caption: "across all subs",
          },
          {
            label: "Total subscriptions",
            value: subscriptions.length,
            caption: `${cancelledList.length} cancelled`,
          },
          {
            label: "Avg factor",
            value:
              activeList.length > 0
                ? (activeList.reduce((s, x) => s + x.factor, 0) / activeList.length).toFixed(2) + "×"
                : "—",
            caption: "active only",
          },
        ]}
      />

      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col">
        <div className="border-b border-border px-6">
          <TabsList variant="line">
            <TabsTrigger value="active">
              Active
              {activeList.length > 0 && (
                <Badge variant="secondary" className="ml-2 text-xs">
                  {activeList.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="cancelled">
              Cancelled
              {cancelledList.length > 0 && (
                <Badge variant="secondary" className="ml-2 text-xs">
                  {cancelledList.length}
                </Badge>
              )}
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="active">
          {isLoading && subscriptions.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <RefreshCw className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : error != null ? (
            <Section noBorder>
              <EmptyState
                icon={AlertTriangle}
                title="Couldn't load subscriptions"
                description="The executor backend didn't respond. Your subscriptions are unchanged."
                action={<Button onClick={loadSubscriptions}>Retry</Button>}
              />
            </Section>
          ) : activeList.length === 0 ? (
            <Section noBorder>
              <EmptyState
                icon={Bot}
                title="No active subscriptions"
                description="Browse the marketplace to subscribe to a signal bot."
                action={
                  <Button size="sm" onClick={() => setShowWizard(true)}>
                    <Plus className="size-3 mr-1" />
                    New Subscription
                  </Button>
                }
              />
            </Section>
          ) : (
            <Section label="Active subscriptions" flush noBorder>
              <div className="divide-y divide-border/60">
                {activeList.map((sub) => (
                  <SubscriptionRow
                    key={sub.id}
                    sub={sub}
                    signalCount={signalCounts[sub.id] ?? 0}
                    scorecard={scorecardsByBotId.get(sub.signalBotId)}
                    onOpenDetail={openDetail}
                    onPauseResume={handlePauseResume}
                    onCancel={handleCancel}
                    onEdit={setEditing}
                  />
                ))}
              </div>
            </Section>
          )}
        </TabsContent>

        <TabsContent value="cancelled">
          {error != null ? (
            <Section noBorder>
              <EmptyState
                icon={AlertTriangle}
                title="Couldn't load subscriptions"
                description="The executor backend didn't respond. Your subscriptions are unchanged."
                action={<Button onClick={loadSubscriptions}>Retry</Button>}
              />
            </Section>
          ) : cancelledList.length === 0 ? (
            <Section noBorder>
              <EmptyState
                className="py-8"
                icon={Bot}
                title="No cancelled subscriptions"
                description="Cancelled subscriptions are kept here for reference."
              />
            </Section>
          ) : (
            <Section label="Cancelled" flush noBorder>
              <div className="divide-y divide-border/60">
                {cancelledList.map((sub) => (
                  <div key={sub.id} className="flex items-center justify-between gap-3 px-6 py-3">
                    <span className="text-xs font-semibold opacity-60">
                      {sub.botName || sub.signalBotId}
                    </span>
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-[10px] text-muted-foreground">
                        Cancelled {fmtDate(sub.updatedAt)}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-[11px]"
                        onClick={() => handleReactivate(sub)}
                      >
                        <Play className="size-3 mr-1" />
                        Reactivate
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </Section>
          )}
        </TabsContent>
      </Tabs>

      <NewSubscriptionWizard
        isOpen={showWizard}
        onClose={() => setShowWizard(false)}
        onComplete={() => {
          setShowWizard(false);
          loadSubscriptions();
        }}
      />

      {detail && (
        <SubscriptionDetailModal detail={detail} onClose={() => setDetail(null)} />
      )}
      {editing && (
        <EditSubscriptionDialog
          sub={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            loadSubscriptions();
          }}
        />
      )}
      {confirmDialog}
    </div>
  );
}

function getStatusColor(status: string): string {
  if (status === "active") return "var(--kb-green)";
  if (status === "paused") return "var(--kb-amber)";
  return "hsl(var(--muted-foreground))";
}

function getStatusVariant(status: string): "success" | "warning" | "neutral" {
  if (status === "active") return "success";
  if (status === "paused") return "warning";
  return "neutral";
}

function SubscriptionRow({
  sub,
  signalCount,
  onOpenDetail,
  onPauseResume,
  onCancel,
  onEdit,
  scorecard,
}: {
  sub: ExecutorSubscription;
  signalCount: number;
  scorecard: StrategyScorecard | undefined;
  onOpenDetail: (sub: ExecutorSubscription) => void;
  onPauseResume: (sub: ExecutorSubscription) => void;
  onCancel: (sub: ExecutorSubscription) => void;
  onEdit: (sub: ExecutorSubscription) => void;
}) {
  return (
    <div className="flex items-center gap-4 px-6 py-3">
      {/* Name + status + markets */}
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: getStatusColor(sub.status) }}
        />
        <Bot className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold">
            {sub.botName || sub.signalBotId}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            <Badge variant={getStatusVariant(sub.status)} className="text-[10px] py-0 px-1.5">
              {sub.status}
            </Badge>
            {sub.selectedMarkets.slice(0, 4).map((m) => (
              <Badge key={m} variant="outline" className="text-[10px] py-0 px-1.5 font-mono">
                {m}
              </Badge>
            ))}
            {sub.selectedMarkets.length > 4 && (
              <span className="text-[10px] text-muted-foreground">
                +{sub.selectedMarkets.length - 4}
              </span>
            )}
          </div>
          {/* Live result of this bot, from the local fills only. */}
          <div className="mt-1">
            <ScorecardLine card={scorecard} />
          </div>
        </div>
      </div>

      {/* Inline mono metrics */}
      <div className="hidden shrink-0 items-center gap-5 font-mono text-[11px] md:flex">
        <Metric label="Factor" value={`${sub.factor}×`} />
        <Metric
          label="Max pos"
          value={sub.maxPositionSize != null ? `${sub.maxPositionSize}` : "∞"}
        />
        <Metric
          label="Max conc"
          value={sub.maxConcurrentTrades != null ? `${sub.maxConcurrentTrades}` : "∞"}
        />
        <Metric label="24h" value={`${signalCount}`} icon />
      </div>

      {/* Actions */}
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          variant={sub.status === "active" ? "secondary" : "default"}
          size="sm"
          className="h-7 text-[11px]"
          onClick={() => onPauseResume(sub)}
        >
          {sub.status === "active" ? (
            <><Pause className="size-3 mr-1" />Pause</>
          ) : (
            <><Play className="size-3 mr-1" />Resume</>
          )}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-[11px]"
          onClick={() => onEdit(sub)}
        >
          <Pencil className="size-3 mr-1" />
          Edit
        </Button>
        <Button
          variant="destructive"
          size="sm"
          className="h-7 text-[11px]"
          onClick={() => onCancel(sub)}
        >
          <Trash2 className="size-3 mr-1" />
          Cancel
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-[11px]"
          onClick={() => onOpenDetail(sub)}
        >
          Details
          <ChevronRight className="size-3 ml-1" />
        </Button>
      </div>
    </div>
  );
}

// Edit factor + local limits on an existing subscription (PATCH /api/subscriptions/:id).
// Empty limit = unlimited (null).
function EditSubscriptionDialog({
  sub,
  onClose,
  onSaved,
}: {
  sub: ExecutorSubscription;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [factor, setFactor] = useState(String(sub.factor));
  const [sizeUnit, setSizeUnit] = useState<"native" | "usd">(sub.sizeUnit ?? "native");
  const [maxPositionSize, setMaxPositionSize] = useState(
    sub.maxPositionSize != null ? String(sub.maxPositionSize) : "",
  );
  const [maxConcurrentTrades, setMaxConcurrentTrades] = useState(
    sub.maxConcurrentTrades != null ? String(sub.maxConcurrentTrades) : "",
  );
  const [accountId, setAccountId] = useState(sub.accountId ?? "");
  const [venueAccounts, setVenueAccounts] = useState<
    Array<{ accountId: string; name?: string }>
  >([]);
  const [saving, setSaving] = useState(false);

  // Broker accounts on the subscription's venue — the routing picker's source.
  useEffect(() => {
    if (!sub.exchange) return;
    let cancelled = false;
    const q = `?account=${encodeURIComponent(sub.accountKey ?? "default")}`;
    apiFetch(`/api/exchanges/v2/accounts/${sub.exchange}${q}`, { headers: { "x-user-id": "default" } })
      .then((res) => (res.ok ? res.json() : []))
      .then((accounts: any[]) => {
        if (cancelled) return;
        setVenueAccounts(
          (Array.isArray(accounts) ? accounts : []).filter(
            (a) => typeof a?.accountId === "string" && a.accountId,
          ),
        );
      })
      .catch(() => {
        if (!cancelled) setVenueAccounts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [sub.exchange]);

  const parsedFactor = parseFloat(factor);
  const factorValid = Number.isFinite(parsedFactor) && parsedFactor > 0;

  const toLimit = (s: string): number | null => {
    if (s.trim() === "") return null;
    const n = parseFloat(s);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const save = async () => {
    if (!factorValid || saving) return;
    setSaving(true);
    try {
      const res = await apiFetch(`/api/subscriptions/${sub.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          factor: parsedFactor,
          sizeUnit,
          maxPositionSize: toLimit(maxPositionSize),
          maxConcurrentTrades: toLimit(maxConcurrentTrades),
          // Only patch routing when a choice was made — legacy rows without
          // accounts keep their (null) value untouched.
          ...(accountId ? { accountId } : {}),
        }),
      });
      if (!res.ok) throw new Error();
      toast.success("Subscription updated");
      onSaved();
    } catch {
      toast.error("Failed to update subscription");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Edit {sub.botName || sub.signalBotId}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="edit-factor" className="text-[13px] font-normal">
              Factor
            </Label>
            <Input
              id="edit-factor"
              type="number"
              min="0"
              step="0.1"
              value={factor}
              onChange={(e) => setFactor(e.target.value)}
              className="h-8 font-mono text-xs"
            />
            <p className="text-[10px] text-muted-foreground">
              Scales the size factor of every incoming signal.
            </p>
          </div>
          {sub.accountKey && (
            <div className="space-y-1">
              <Label className="text-[13px] font-normal">Connection</Label>
              <p className="font-mono text-[11px] text-foreground">
                {sub.exchange} · {sub.accountKey}
              </p>
            </div>
          )}
          {venueAccounts.length > 0 && (
            <div className="space-y-1">
              <Label className="text-[13px] font-normal">Broker account</Label>
              <div className="flex flex-wrap gap-1.5">
                {venueAccounts.map((acc) => (
                  <button
                    key={acc.accountId}
                    type="button"
                    onClick={() => setAccountId(acc.accountId)}
                    className={`border border-border px-2 py-1 font-mono text-[11px] ${
                      accountId === acc.accountId
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground"
                    }`}
                  >
                    {acc.accountId}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground">
                The account this bot's orders are routed to.
              </p>
              {venueAccounts.length > 1 && !accountId && (
                <p className="text-[10px] text-[var(--kb-red)]">
                  No account set — signals on multi-account venues are rejected.
                </p>
              )}
            </div>
          )}
          <div className="space-y-1">
            <Label className="text-[13px] font-normal">Size unit</Label>
            <div className="flex w-fit overflow-hidden rounded border border-border text-[11px]">
              {(["native", "usd"] as const).map((u) => (
                <button
                  key={u}
                  type="button"
                  onClick={() => setSizeUnit(u)}
                  className={`px-2 py-1 font-mono uppercase ${
                    sizeUnit === u ? "bg-muted text-foreground" : "text-muted-foreground"
                  }`}
                >
                  {u === "native" ? "Contracts" : "USD"}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-muted-foreground">
              How the sized quantity and max position are denominated. USD converts
              to contracts at the mark price.
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="edit-max-pos" className="text-[13px] font-normal">
              Max position size
            </Label>
            <Input
              id="edit-max-pos"
              type="number"
              min="0"
              step="any"
              placeholder="unlimited"
              value={maxPositionSize}
              onChange={(e) => setMaxPositionSize(e.target.value)}
              className="h-8 font-mono text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="edit-max-conc" className="text-[13px] font-normal">
              Max concurrent trades
            </Label>
            <Input
              id="edit-max-conc"
              type="number"
              min="0"
              step="1"
              placeholder="unlimited"
              value={maxConcurrentTrades}
              onChange={(e) => setMaxConcurrentTrades(e.target.value)}
              className="h-8 font-mono text-xs"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" className="h-8 text-[11px]" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-8 text-[11px]"
            onClick={save}
            disabled={!factorValid || saving}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Metric({ label, value, icon }: { label: string; value: string; icon?: boolean }) {
  return (
    <div className="text-right">
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="tabular-nums">
        {icon && <TrendingUp className="size-3 inline mr-0.5" />}
        {value}
      </div>
    </div>
  );
}

function SubscriptionDetailModal({
  detail,
  onClose,
}: {
  detail: SubscriptionDetail;
  onClose: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="Close detail"
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-6"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div
        className="max-w-2xl w-full max-h-[80vh] overflow-auto border border-border bg-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-border px-6 py-4">
          <PageHeader
            variant="inline"
            title={detail.subscription.botName || detail.subscription.signalBotId}
            description={`${detail.signalCount24h} signals in last 24h`}
            actions={
              <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={onClose}>
                <X className="size-3" />
              </Button>
            }
          />
        </div>

        <StatStrip
          size="sm"
          items={[
            { label: "Factor", value: `${detail.subscription.factor}×` },
            { label: "Status", value: detail.subscription.status },
            {
              label: "Size unit",
              value: detail.subscription.sizeUnit === "usd" ? "USD" : "Contracts",
            },
            {
              label: "Max position",
              value:
                detail.subscription.maxPositionSize != null
                  ? `${detail.subscription.maxPositionSize}`
                  : "∞",
            },
            {
              label: "Max concurrent",
              value:
                detail.subscription.maxConcurrentTrades != null
                  ? `${detail.subscription.maxConcurrentTrades}`
                  : "∞",
            },
          ]}
        />

        <Section label="Recent signals" flush noBorder>
          {detail.signals.length === 0 ? (
            <p className="px-6 py-4 text-[11px] text-muted-foreground">No signals yet</p>
          ) : (
            <DataMatrix
              rows={detail.signals.slice(0, 20)}
              rowKey={(s: any) => s.id}
              columns={[
                {
                  key: "symbol",
                  header: "Symbol",
                  cell: (s: any) => (
                    <span className="font-mono text-xs text-[var(--kb-teal)]">{s.symbol}</span>
                  ),
                },
                {
                  key: "action",
                  header: "Action",
                  cell: (s: any) => (
                    <span
                      className={`font-mono text-xs ${
                        s.action === "buy"
                          ? "text-[var(--kb-green)]"
                          : s.action === "sell"
                            ? "text-[var(--kb-red)]"
                            : ""
                      }`}
                    >
                      {s.action}
                    </span>
                  ),
                },
                {
                  key: "qty",
                  header: "Qty",
                  align: "right",
                  cell: (s: any) => <span className="font-mono text-xs">{s.quantity}</span>,
                },
                {
                  key: "status",
                  header: "Status",
                  cell: (s: any) => (
                    <Badge variant="outline" className="text-[10px] py-0 px-1">
                      {s.status}
                    </Badge>
                  ),
                },
                {
                  key: "time",
                  header: "Time",
                  align: "right",
                  cell: (s: any) => (
                    <span className="font-mono text-xs text-muted-foreground">
                      {fmtDateTime(s.received_at)}
                    </span>
                  ),
                },
              ]}
            />
          )}
        </Section>
      </div>
    </div>
  );
}

import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Badge,
  Button,
  ConfirmDialog,
  DataFreshness,
  DataMatrix,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  PageHeader,
  QueryStateGate,
  Section,
  StaleDataBanner,
  StatStrip,
  TimeframeBadge,
  ladderBadgeLabel,
  downloadCsv,
  toCsv,
  type ConfirmSummaryItem,
  type MatrixColumn,
} from "@kaibot/shared";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Download,
  Layers,
  Loader2,
  Lock,
  Pencil,
  Plus,
  Shield,
  Trash2,
} from "@/lib/icons";
import { toast } from "sonner";
import { useAtom, useAtomValue } from "jotai";
import {
  positionsAtom,
  positionsFlatViewAtom,
  skipOrderConfirmAtom,
  type Position,
} from "@/lib/atoms";
import { notionalOf } from "@/lib/notional";
import { manualTradeApi, positionManageApi, rideApi, type ManagedTrailView } from "@/lib/manual-trade-api";
import { HandOverDialog, type HandOverTarget } from "@/components/HandOverDialog";
import { AdoptDialog, type AdoptTarget } from "@/components/AdoptDialog";
import {
  positionGroupsApi,
  type GroupOverviewEntry,
  type GroupedPosition,
  type PositionGroupSource,
  type PositionGroupSummary,
} from "@/lib/position-groups-api";
import {
  positionManagersApi,
  type AttachedManagerView,
  type GroupRiskGuardParams,
} from "@/lib/position-managers-api";
import { opsApi } from "@/lib/ops-api";
import { useBrokerData } from "@/hooks/useBrokerData";
import { usePolledResource } from "@/hooks/usePolledResource";
import {
  ManagePositionDialog,
  type ManagePositionTarget,
} from "@/components/ManagePositionDialog";
import {
  RollPositionDialog,
  type RollPositionTarget,
} from "@/components/RollPositionDialog";

function pnlPercentOf(p: Position): number {
  const mark = p.markPrice ?? p.entryPrice;
  if (!p.entryPrice) return 0;
  return ((mark - p.entryPrice) / p.entryPrice) * 100 * (p.side === "short" ? -1 : 1);
}

// Group exposure is recomputed client-side: the server aggregate still values a
// futures leg at bare size x mark (positionNotional, position-trail.ts).
function groupExposure(positions: GroupedPosition[]): number {
  return positions.reduce((sum, gp) => sum + notionalOf(gp), 0);
}

const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 8 });
const money = (n: number) => `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`;

// Overview row → the Position shape the shared handlers/columns work on.
function toPosition(gp: GroupedPosition): Position {
  return {
    id: gp.positionKey,
    accountId: gp.accountId,
    symbol: gp.symbol,
    side: gp.side,
    size: gp.size,
    entryPrice: gp.entryPrice,
    markPrice: gp.markPrice,
    unrealizedPnL: gp.unrealizedPnL,
    exchange: gp.exchange,
    group: gp.group,
    expiry: gp.expiry,
    ladder: gp.ladder,
    ride: gp.ride ?? null,
  };
}

// "rolls in Nd" chip on dated-futures positions; amber when the roll is near.
export function ExpiryBadge({ expiry }: { expiry: NonNullable<Position["expiry"]> }) {
  const label =
    expiry.daysLeft <= 0 ? "rolls today" : `rolls in ${expiry.daysLeft}d`;
  return (
    <Badge
      variant={expiry.daysLeft <= 7 ? "warning" : "outline"}
      className="text-[9px]"
      title={`Expires ${new Date(expiry.date).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })}${expiry.source === "calculated" ? " (calculated)" : ""}${
        expiry.nextSymbol ? ` · next: ${expiry.nextSymbol}` : ""
      }`}
    >
      {label}
    </Badge>
  );
}

const sourceBadgeClass: Record<PositionGroupSource, string> = {
  bot: "border-[var(--kb-amber)]/40 text-[var(--kb-amber)]",
  takeover: "border-[var(--kb-teal)]/40 text-[var(--kb-teal)]",
  manual: "border-border text-muted-foreground",
};

function GroupSourceBadge({ source }: { source: PositionGroupSource }) {
  return (
    <Badge
      variant="outline"
      className={`font-mono text-[9px] uppercase tracking-wider ${sourceBadgeClass[source]}`}
    >
      {source === "takeover" ? "take-over" : source}
    </Badge>
  );
}

// Grouped ↔ Flat pill, same visual language as the trade panel toggles.
function ViewToggle({ flat, onChange }: { flat: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex overflow-hidden rounded border border-border text-[10px]">
      {(
        [
          { v: false, label: "Grouped" },
          { v: true, label: "Flat" },
        ] as const
      ).map((o) => (
        <button
          key={o.label}
          type="button"
          onClick={() => onChange(o.v)}
          className={`px-2 py-1 font-mono uppercase ${
            flat === o.v ? "bg-muted text-foreground" : "text-muted-foreground"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// Create / rename / delete groups. Deleting never touches positions — members
// just go back to Unsorted.
function GroupsDialog({
  groups,
  onOpenChange,
  onChanged,
}: {
  groups: PositionGroupSummary[];
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      onChanged();
    } catch (e) {
      toast.error("Group action failed", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Position groups</DialogTitle>
          <DialogDescription>
            Create, rename or delete groups. Deleting a group moves its positions
            to Unsorted. Nothing is closed.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <input
            className="h-8 flex-1 rounded-md border border-border bg-background px-2 font-mono text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            placeholder="New group name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || !name.trim() || busy) return;
              void run(async () => {
                await positionGroupsApi.create(name.trim());
                setName("");
                toast.success("Group created");
              });
            }}
          />
          <Button
            size="sm"
            disabled={!name.trim() || busy}
            onClick={() =>
              run(async () => {
                await positionGroupsApi.create(name.trim());
                setName("");
                toast.success("Group created");
              })
            }
          >
            <Plus className="size-3.5 mr-1" />
            Create
          </Button>
        </div>
        {groups.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">No groups yet.</p>
        ) : (
          <div className="divide-y divide-border">
            {groups.map((g) => (
              <div key={g.id} className="flex items-center gap-2 py-2">
                {editingId === g.id ? (
                  <input
                    autoFocus
                    className="h-7 flex-1 rounded-md border border-border bg-background px-2 font-mono text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setEditingId(null);
                      if (e.key !== "Enter" || !editName.trim() || busy) return;
                      void run(async () => {
                        await positionGroupsApi.rename(g.id, editName.trim());
                        setEditingId(null);
                        toast.success("Group renamed");
                      });
                    }}
                  />
                ) : (
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="truncate font-mono text-xs text-foreground">{g.name}</span>
                    <GroupSourceBadge source={g.source} />
                    <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                      {g.linkedPositions} linked
                    </span>
                  </div>
                )}
                {editingId === g.id ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-[10px]"
                    disabled={!editName.trim() || busy}
                    onClick={() =>
                      run(async () => {
                        await positionGroupsApi.rename(g.id, editName.trim());
                        setEditingId(null);
                        toast.success("Group renamed");
                      })
                    }
                  >
                    Save
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2"
                    title="Rename group"
                    onClick={() => {
                      setEditingId(g.id);
                      setEditName(g.name);
                      setDeleteId(null);
                    }}
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                )}
                {deleteId === g.id ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-[10px] border-[var(--kb-red)]/40 text-[var(--kb-red)] hover:text-[var(--kb-red)]"
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        await positionGroupsApi.remove(g.id);
                        setDeleteId(null);
                        toast.success("Group deleted", {
                          description: "Its positions are now Unsorted.",
                        });
                      })
                    }
                  >
                    Confirm
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-muted-foreground hover:text-[var(--kb-red)]"
                    title="Delete group (positions stay open)"
                    onClick={() => {
                      setDeleteId(g.id);
                      setEditingId(null);
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Per-position outcome of a group action (close / tighten / protect / unprotect).
interface GroupActionResultRow {
  symbol: string;
  exchange: string;
  status: string;
  detail?: string;
}

interface GroupActionReport {
  title: string;
  rows: GroupActionResultRow[];
}

const resultStatusClass = (status: string) =>
  status === "failed"
    ? "text-[var(--kb-red)]"
    : status === "skipped"
      ? "text-[var(--kb-amber)]"
      : "text-[var(--kb-green)]";

// Per-position results after a group action — the toast carries the summary,
// this carries the reasons (skipped/failed members).
function GroupActionReportDialog({
  report,
  onOpenChange,
}: {
  report: GroupActionReport;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">{report.title}</DialogTitle>
          <DialogDescription>Per-position results.</DialogDescription>
        </DialogHeader>
        <div className="max-h-72 divide-y divide-border overflow-y-auto">
          {report.rows.map((r, i) => (
            <div key={`${r.symbol}-${i}`} className="py-1.5">
              <div className="flex items-center gap-2 font-mono text-xs">
                <span className="text-[var(--kb-teal)]">{r.symbol}</span>
                <span className="text-[10px] capitalize text-muted-foreground">{r.exchange}</span>
                <span
                  className={`ml-auto text-[10px] uppercase tracking-wider ${resultStatusClass(r.status)}`}
                >
                  {r.status}
                </span>
              </div>
              {r.detail && (
                <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                  {r.detail}
                </div>
              )}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Group stop-tighten: one target for every member with an armed trail, as an
// absolute price or a distance off each member's mark. Improve-only.
function TightenStopsDialog({
  entry,
  onOpenChange,
  onReport,
  onChanged,
}: {
  entry: GroupOverviewEntry;
  onOpenChange: (open: boolean) => void;
  onReport: (report: GroupActionReport) => void;
  onChanged: () => void;
}) {
  const group = entry.group!;
  const [mode, setMode] = useState<"pct" | "level">("pct");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const n = parseFloat(value);
  const valid = Number.isFinite(n) && n > 0 && (mode === "level" || n < 100);

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      const report = await positionGroupsApi.tightenStops(
        group.id,
        mode === "level" ? { level: n } : { pct: n },
      );
      const summary = `Tightened ${report.tightened}/${report.requested}${
        report.skipped ? `, ${report.skipped} skipped` : ""
      }${report.failed ? `, ${report.failed} failed` : ""}`;
      if (report.failed > 0) toast.error(summary);
      else toast.success(summary);
      onReport({
        title: `Tighten stops: ${group.name}`,
        rows: report.results.map((r) => ({
          symbol: r.symbol,
          exchange: r.exchange,
          status: r.status,
          detail:
            r.status === "tightened"
              ? `${r.previousStop != null ? r.previousStop.toFixed(2) : "—"} → ${
                  r.newStop != null ? r.newStop.toFixed(2) : "—"
                }`
              : r.reason,
        })),
      });
      onChanged();
      onOpenChange(false);
    } catch (e) {
      toast.error("Tighten stops failed", { description: errText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">
            Tighten stops: {group.name}
          </DialogTitle>
          <DialogDescription>
            Raises the stop on every member with an armed trail. Stops only ever
            improve. Members whose stop is already tighter, or without a trail,
            are skipped and reported.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <div className="flex overflow-hidden rounded border border-border text-[10px]">
            {(
              [
                { v: "pct", label: "% off mark" },
                { v: "level", label: "Price" },
              ] as const
            ).map((o) => (
              <button
                key={o.v}
                type="button"
                onClick={() => setMode(o.v)}
                className={`px-2 py-1 font-mono uppercase ${
                  mode === o.v ? "bg-muted text-foreground" : "text-muted-foreground"
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
          <input
            autoFocus
            className="h-8 flex-1 rounded-md border border-border bg-background px-2 font-mono text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            type="number"
            min="0"
            step="any"
            placeholder={mode === "pct" ? "distance, 0–100" : "absolute stop price"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
          />
        </div>
        <p className="text-[10px] leading-snug text-muted-foreground">
          {mode === "pct"
            ? "Each member's stop moves to this distance off its own mark price."
            : "Every member's stop moves to this price. Use for members on the same symbol."}
        </p>
        <Button className="w-full" disabled={!valid || busy} onClick={() => void submit()}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : "Tighten stops"}
        </Button>
      </DialogContent>
    </Dialog>
  );
}

// Attach (or reconfigure) the group-risk-guard on every member. The guard
// watches the group aggregate and closes its own position on breach.
function ProtectGroupDialog({
  entry,
  guardFor,
  onOpenChange,
  onReport,
  onChanged,
}: {
  entry: GroupOverviewEntry;
  guardFor: (gp: GroupedPosition) => AttachedManagerView | undefined;
  onOpenChange: (open: boolean) => void;
  onReport: (report: GroupActionReport) => void;
  onChanged: () => void;
}) {
  const group = entry.group!;
  const existingParams = (entry.positions.map(guardFor).find(Boolean)?.params ??
    {}) as GroupRiskGuardParams;
  const [lossPct, setLossPct] = useState(
    existingParams.maxGroupLossFraction != null
      ? String(existingParams.maxGroupLossFraction * 100)
      : "",
  );
  const [notional, setNotional] = useState(
    existingParams.maxGroupNotional != null ? String(existingParams.maxGroupNotional) : "",
  );
  const [busy, setBusy] = useState(false);

  const loss = parseFloat(lossPct);
  const not = parseFloat(notional);
  const lossOk = lossPct.trim() === "" || (Number.isFinite(loss) && loss > 0 && loss <= 100);
  const notOk = notional.trim() === "" || (Number.isFinite(not) && not > 0);
  const valid = lossOk && notOk && (lossPct.trim() !== "" || notional.trim() !== "");

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    const params: Record<string, unknown> = {
      ...(lossPct.trim() !== "" ? { maxGroupLossFraction: loss / 100 } : {}),
      ...(notional.trim() !== "" ? { maxGroupNotional: not } : {}),
    };
    const rows: GroupActionResultRow[] = [];
    for (const gp of entry.positions) {
      const attached = guardFor(gp);
      try {
        await positionManagersApi.manage({
          action: attached ? "configure" : "attach",
          exchange: gp.exchange,
          symbol: gp.symbol,
          accountId: gp.accountId,
          managerId: "group-risk-guard",
          params,
        });
        rows.push({
          symbol: gp.symbol,
          exchange: gp.exchange,
          status: attached ? "updated" : "attached",
        });
      } catch (e) {
        rows.push({
          symbol: gp.symbol,
          exchange: gp.exchange,
          status: "failed",
          detail: errText(e),
        });
      }
    }
    const failed = rows.filter((r) => r.status === "failed").length;
    const summary = `Protected ${rows.length - failed}/${rows.length} positions`;
    if (failed > 0) toast.error(summary);
    else toast.success(summary);
    onReport({ title: `Protect group: ${group.name}`, rows });
    onChanged();
    setBusy(false);
    onOpenChange(false);
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">
            Protect group: {group.name}
          </DialogTitle>
          <DialogDescription>
            Attaches the group risk guard to every member ({entry.positions.length}
            {" "}position{entry.positions.length === 1 ? "" : "s"}). On breach each
            guard closes its own position at market. At least one threshold.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              Max group loss
            </div>
            <input
              autoFocus
              className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 font-mono text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              type="number"
              min="0"
              max="100"
              step="any"
              placeholder="% of equity"
              value={lossPct}
              onChange={(e) => setLossPct(e.target.value)}
            />
          </div>
          <div>
            <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              Max group notional
            </div>
            <input
              className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 font-mono text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              type="number"
              min="0"
              step="any"
              placeholder="optional $"
              value={notional}
              onChange={(e) => setNotional(e.target.value)}
            />
          </div>
        </div>
        <Button className="w-full" disabled={!valid || busy} onClick={() => void submit()}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : "Protect group"}
        </Button>
      </DialogContent>
    </Dialog>
  );
}

type ConfirmAction =
  | { kind: "close"; position: Position; fraction: number }
  | { kind: "close-all" };

export default function Positions() {
  const navigate = useNavigate();
  const positions = useAtomValue(positionsAtom);
  const { isLoading, isStale, error, lastUpdated, refresh } = useBrokerData();
  const [skipConfirm, setSkipConfirm] = useAtom(skipOrderConfirmAtom);
  const [flatView, setFlatView] = useAtom(positionsFlatViewAtom);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [closingAll, setClosingAll] = useState(false);
  const [manageTarget, setManageTarget] = useState<ManagePositionTarget | null>(null);
  const [rollTarget, setRollTarget] = useState<RollPositionTarget | null>(null);
  const [handOverTarget, setHandOverTarget] = useState<HandOverTarget | null>(null);
  const [adoptTarget, setAdoptTarget] = useState<AdoptTarget | null>(null);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // Group actions (G2): close-group confirm, tighten/protect dialogs, the
  // per-position results dialog, and the busy group while one runs.
  const [groupClose, setGroupClose] = useState<GroupOverviewEntry | null>(null);
  const [tightenEntry, setTightenEntry] = useState<GroupOverviewEntry | null>(null);
  const [protectEntry, setProtectEntry] = useState<GroupOverviewEntry | null>(null);
  const [actionReport, setActionReport] = useState<GroupActionReport | null>(null);
  const [groupBusy, setGroupBusy] = useState<string | null>(null);
  // "New group…" from a row's Move menu: create the group, then assign.
  const [moveTarget, setMoveTarget] = useState<Position | null>(null);
  const [moveName, setMoveName] = useState("");
  const [moveBusy, setMoveBusy] = useState(false);

  // Active edge trails (trail / break-even armed per position) — drives the
  // Stop column and the Manage dialog's initial state.
  const { data: trailsData, refresh: refreshTrails } = usePolledResource(
    () => positionManageApi.list(),
    { intervalMs: 5000 },
  );
  const trailFor = (p: Position): ManagedTrailView | undefined =>
    trailsData?.trails.find(
      (t) =>
        t.active &&
        t.exchange === p.exchange &&
        t.symbol.toUpperCase() === p.symbol.toUpperCase(),
    );

  // Group buckets with aggregates (server-sorted, Unsorted last).
  const { data: overviewData, refresh: refreshOverview } = usePolledResource(
    () => positionGroupsApi.overview(),
    { intervalMs: 5000, enabled: !flatView },
  );
  // Attached edge managers — drives the group-risk-guard state per member
  // (Protect / Unprotect on the group header).
  const { data: managersData, refresh: refreshManagers } = usePolledResource(
    () => positionManagersApi.list(),
    { intervalMs: 5000, enabled: !flatView },
  );
  const groupGuardFor = (gp: GroupedPosition): AttachedManagerView | undefined =>
    managersData?.positions
      .find(
        (m) =>
          m.active &&
          m.exchange === gp.exchange &&
          m.symbol.toUpperCase() === gp.symbol.toUpperCase() &&
          (m.accountId == null || m.accountId === gp.accountId),
      )
      ?.managers.find((m) => m.managerId === "group-risk-guard");
  // All groups (incl. empty ones) for the Move menus + the Groups dialog.
  const { data: groupsData, refresh: refreshGroups } = usePolledResource(
    () => positionGroupsApi.list(),
    { intervalMs: 15000 },
  );
  const groups = groupsData?.groups ?? [];

  const refreshGrouping = () => {
    refreshOverview();
    refreshGroups();
    refresh();
  };

  const assignTo = async (p: Position, groupId: string | null) => {
    if (!p.exchange || !p.accountId) return;
    try {
      await positionGroupsApi.assign({
        exchange: p.exchange,
        accountId: p.accountId,
        symbol: p.symbol,
        groupId,
      });
      const target = groupId ? groups.find((g) => g.id === groupId)?.name : null;
      toast.success(target ? `Moved ${p.symbol} to ${target}` : `Moved ${p.symbol} to Unsorted`);
      refreshGrouping();
    } catch (e) {
      toast.error("Move failed", { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const createGroupAndAssign = async () => {
    if (!moveTarget || !moveName.trim() || moveBusy) return;
    setMoveBusy(true);
    try {
      const created = await positionGroupsApi.create(moveName.trim());
      await positionGroupsApi.assign({
        exchange: moveTarget.exchange!,
        accountId: moveTarget.accountId,
        symbol: moveTarget.symbol,
        groupId: created.id,
      });
      toast.success(`Moved ${moveTarget.symbol} to ${created.name}`);
      setMoveTarget(null);
      setMoveName("");
      refreshGrouping();
    } catch (e) {
      toast.error("Move failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setMoveBusy(false);
    }
  };

  const takeBack = async (p: Position) => {
    if (!p.ride) return;
    setBusyId(p.id ?? p.symbol);
    try {
      await rideApi.takeBack(p.ride.positionId);
      toast.success(`${p.symbol} taken back: the position is manual again`);
      refresh();
      refreshTrails();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Take back failed");
    } finally {
      setBusyId(null);
    }
  };

  const closePosition = async (p: Position, fraction: number) => {
    setBusyId(p.id);
    try {
      const r = await manualTradeApi.close({
        exchange: p.exchange!,
        symbol: p.symbol,
        fraction: fraction < 1 ? fraction : undefined,
        idempotencyKey: crypto.randomUUID(),
      });
      toast.success(
        fraction < 1 ? `Reduced ${p.symbol} by ${fraction * 100}%` : `Closed ${p.symbol}`,
        { description: `${r.closedQuantity} @ market` },
      );
      refresh();
      if (!flatView) refreshOverview();
    } catch (e) {
      toast.error("Close failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusyId(null);
    }
  };

  // Same edge-side flatten as the Panic button in Settings, without the halt.
  const closeAll = async () => {
    setClosingAll(true);
    try {
      const report = await opsApi.panic(false);
      const msg = `Closed ${report.closed}${report.failed ? `, ${report.failed} failed` : ""}`;
      if (report.failed > 0) toast.error(msg);
      else toast.success(msg);
      refresh();
      if (!flatView) refreshOverview();
    } catch (e) {
      toast.error("Close all failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setClosingAll(false);
    }
  };

  // Sequential reduce-only close of every group member; partial failures come
  // back per position and land in the results dialog.
  const closeGroup = async (entry: GroupOverviewEntry) => {
    const group = entry.group;
    if (!group) return;
    setGroupBusy(group.id);
    try {
      const report = await positionGroupsApi.closeGroup(group.id);
      const summary = `Closed ${report.closed}/${report.requested}${
        report.skipped ? `, ${report.skipped} skipped` : ""
      }${report.failed ? `, ${report.failed} failed` : ""}`;
      if (report.failed > 0) toast.error(summary);
      else toast.success(summary);
      if (report.failed > 0 || report.skipped > 0) {
        setActionReport({
          title: `Close group: ${group.name}`,
          rows: report.results.map((r) => ({
            symbol: r.symbol,
            exchange: r.exchange,
            status: r.status,
            detail: r.status === "closed" ? undefined : r.reason,
          })),
        });
      }
      refreshGrouping();
      refreshTrails();
      refreshManagers();
    } catch (e) {
      toast.error("Close group failed", { description: errText(e) });
    } finally {
      setGroupBusy(null);
    }
  };

  // Detach the group-risk-guard from every member that carries it.
  const unprotectGroup = async (entry: GroupOverviewEntry) => {
    const group = entry.group;
    if (!group) return;
    const members = entry.positions.filter((gp) => groupGuardFor(gp));
    if (members.length === 0) return;
    setGroupBusy(group.id);
    const rows: GroupActionResultRow[] = [];
    for (const gp of members) {
      try {
        await positionManagersApi.manage({
          action: "detach",
          exchange: gp.exchange,
          symbol: gp.symbol,
          accountId: gp.accountId,
          managerId: "group-risk-guard",
        });
        rows.push({ symbol: gp.symbol, exchange: gp.exchange, status: "detached" });
      } catch (e) {
        rows.push({ symbol: gp.symbol, exchange: gp.exchange, status: "failed", detail: errText(e) });
      }
    }
    const failed = rows.filter((r) => r.status === "failed").length;
    const summary = `Unprotected ${rows.length - failed}/${rows.length} positions`;
    if (failed > 0) {
      toast.error(summary);
      setActionReport({ title: `Unprotect: ${group.name}`, rows });
    } else {
      toast.success(summary);
    }
    refreshManagers();
    setGroupBusy(null);
  };

  const requestClose = (p: Position, fraction: number) => {
    if (busyId) return;
    if (skipConfirm) return void closePosition(p, fraction);
    setConfirmAction({ kind: "close", position: p, fraction });
  };

  const closeSummary = (p: Position, fraction: number): ConfirmSummaryItem[] => {
    const qty = Math.abs(p.size) * fraction;
    const px = p.markPrice ?? p.entryPrice;
    const items: ConfirmSummaryItem[] = [
      { label: "Side", value: fraction < 1 ? `Reduce ${p.side}` : `Close ${p.side}` },
      { label: "Symbol", value: p.symbol },
      {
        label: "Quantity",
        value: fraction < 1 ? `${fraction * 100}% · ${fmt(qty)}` : fmt(qty),
      },
      { label: "Order type", value: "market" },
    ];
    if (px > 0)
      items.push({
        label: "Notional",
        value: `≈ $${fmt(notionalOf(p) * fraction)}`,
      });
    return items;
  };

  const closeAllSummary = (): ConfirmSummaryItem[] => [
    { label: "Positions", value: positions.length },
    { label: "Order type", value: "market" },
    { label: "Notional", value: `≈ $${totalNotional.toFixed(2)}` },
  ];

  const exportCsv = () => {
    downloadCsv(
      "positions.csv",
      toCsv(positions, [
        { header: "Symbol", value: (p) => p.symbol },
        { header: "Side", value: (p) => p.side },
        { header: "Size", value: (p) => p.size },
        { header: "Entry", value: (p) => p.entryPrice },
        { header: "Mark", value: (p) => p.markPrice ?? p.entryPrice },
        { header: "Notional", value: (p) => notionalOf(p).toFixed(2) },
        { header: "Unrealized PnL", value: (p) => p.unrealizedPnL ?? 0 },
        { header: "PnL %", value: (p) => pnlPercentOf(p).toFixed(2) },
        { header: "Exchange", value: (p) => p.exchange ?? "" },
        { header: "Group", value: (p) => p.group?.name ?? "" },
        { header: "Source", value: (p) => p.botTag || p.botName || "" },
        {
          header: "Ladder",
          value: (p) => p.ladder?.levels.map(ladderBadgeLabel).join(" / ") ?? "",
        },
      ]),
    );
  };

  const { totalNotional, totalPnL } = useMemo(() => {
    let notional = 0;
    let pnl = 0;
    for (const p of positions) {
      notional += notionalOf(p);
      pnl += p.unrealizedPnL || 0;
    }
    return { totalNotional: notional, totalPnL: pnl };
  }, [positions]);

  // Ladder strategies are the only ones whose timeframe moves, so the column
  // only appears when at least one position actually sits on a ladder.
  const hasLadder = useMemo(
    () => positions.some((p) => (p.ladder?.levels.length ?? 0) > 0),
    [positions],
  );

  // One column set for the flat table and every group section; the flat table
  // additionally shows the Group column.
  const makeColumns = (showGroup: boolean): MatrixColumn<Position>[] => {
    const columns: MatrixColumn<Position>[] = [
      {
        key: "symbol",
        header: "Symbol",
        sortable: true,
        sortAccessor: (p) => p.symbol,
        cell: (p) => (
          <span className="inline-flex items-center gap-1.5">
            <span className="font-mono text-[var(--kb-teal)]">{p.symbol}</span>
            {p.expiry && <ExpiryBadge expiry={p.expiry} />}
            {p.ride && (
              <Badge
                variant="outline"
                className="font-mono text-[9px] uppercase tracking-wider border-[var(--kb-teal)]/40 text-[var(--kb-teal)]"
                title="A ride bot manages the exit of this position"
              >
                riding · {p.ride.botName ?? "ride bot"}
              </Badge>
            )}
          </span>
        ),
      },
      {
        key: "side",
        header: "Side",
        cell: (p) => (
          <span
            className={`inline-block w-12 font-mono text-[11px] uppercase ${
              p.side === "long" ? "text-[var(--kb-green)]" : "text-[var(--kb-red)]"
            }`}
          >
            {p.side}
          </span>
        ),
      },
      ...(hasLadder
        ? [
            {
              key: "tf",
              header: "TF",
              cell: (p: Position) =>
                p.ladder ? (
                  <TimeframeBadge
                    timeframe={p.ladder.timeframe}
                    levels={p.ladder.levels}
                  />
                ) : (
                  <span className="text-muted-foreground">—</span>
                ),
            } satisfies MatrixColumn<Position>,
          ]
        : []),
      {
        key: "size",
        header: "Size",
        align: "right",
        sortable: true,
        // size sorts by notional so it ranks positions by real exposure
        sortAccessor: notionalOf,
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
        sortAccessor: (p) => p.markPrice ?? p.entryPrice,
        cell: (p) => (
          <span className="font-mono">${(p.markPrice ?? p.entryPrice).toFixed(2)}</span>
        ),
      },
      {
        key: "pnl",
        header: "Unrealized P&L",
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
        align: "right",
        sortable: true,
        sortAccessor: pnlPercentOf,
        cell: (p) => {
          const pnlPercent = pnlPercentOf(p);
          const isProfit = (p.unrealizedPnL || 0) >= 0;
          return (
            <span
              className={`font-mono ${
                isProfit ? "text-[var(--kb-green)]" : "text-[var(--kb-red)]"
              }`}
            >
              {pnlPercent >= 0 ? "+" : ""}
              {pnlPercent.toFixed(2)}%
            </span>
          );
        },
      },
      {
        key: "stop",
        header: "Stop",
        align: "right",
        cell: (p) => {
          const t = trailFor(p);
          if (!t || t.effectiveStop == null)
            return <span className="text-muted-foreground">—</span>;
          return (
            <span
              className="inline-flex items-center gap-1 font-mono text-[var(--kb-amber)]"
              title={`${t.mode === "drawdown" ? "Drawdown" : "Fixed"} trail${
                t.breakevenFee != null ? " + break-even" : ""
              }${t.trailingLock ? " · locked" : ""}, effective stop`}
            >
              {t.trailingLock ? <Lock className="size-3" /> : <Shield className="size-3" />}
              {t.effectiveStop.toFixed(2)}
            </span>
          );
        },
      },
      {
        key: "exchange",
        header: "Exchange",
        sortable: true,
        sortAccessor: (p) => p.exchange ?? null,
        cell: (p) => (
          <span className="capitalize text-muted-foreground">{p.exchange || "—"}</span>
        ),
      },
    ];
    if (showGroup) {
      columns.push({
        key: "group",
        header: "Group",
        sortable: true,
        sortAccessor: (p) => p.group?.name ?? null,
        cell: (p) =>
          p.group ? (
            <span className="font-mono text-[10px] text-muted-foreground">{p.group.name}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      });
      columns.push({
        key: "source",
        header: "Source",
        cell: (p) => {
          const source = p.botTag || p.botName;
          if (p.ride) {
            return (
              <Badge
                variant="outline"
                className="font-mono text-[9px] uppercase tracking-wider border-[var(--kb-teal)]/40 text-[var(--kb-teal)]"
                title="A ride bot manages the exit of this position"
              >
                riding · {p.ride.botName ?? "ride bot"}
              </Badge>
            );
          }
          return source ? (
            <span className="font-mono text-[9px] uppercase text-muted-foreground">
              {source}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          );
        },
      });
    }
    columns.push({
      key: "actions",
      header: "",
      align: "right",
      cell: (p) => {
        const disabled = !p.exchange || busyId != null;
        const canMove = !!p.exchange && !!p.accountId;
        return (
          <div className="flex items-center justify-end gap-1">
            {p.expiry && (
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-[10px] border-[var(--kb-amber)]/40 text-[var(--kb-amber)] hover:text-[var(--kb-amber)]"
                disabled={disabled}
                title={
                  !p.exchange
                    ? "Exchange unknown for this position"
                    : "Roll this position to the next contract"
                }
                onClick={(e) => {
                  e.stopPropagation();
                  setRollTarget({
                    exchange: p.exchange!,
                    symbol: p.symbol,
                    accountId: p.accountId,
                    expiry: p.expiry,
                  });
                }}
              >
                Roll
              </Button>
            )}
            {p.ride ? (
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-[10px] border-[var(--kb-teal)]/40 text-[var(--kb-teal)] hover:text-[var(--kb-teal)]"
                disabled={busyId != null}
                title="Stop the ride bot's management; the position stays open as manual"
                onClick={(e) => {
                  e.stopPropagation();
                  void takeBack(p);
                }}
              >
                Take back
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-[10px]"
                disabled={!p.exchange || busyId != null}
                title={
                  !p.exchange
                    ? "Exchange unknown for this position"
                    : "Hand the exit of this position to a ride-only bot"
                }
                onClick={(e) => {
                  e.stopPropagation();
                  setHandOverTarget({
                    exchange: p.exchange!,
                    symbol: p.symbol,
                    side: p.side,
                    entryPrice: p.entryPrice,
                    markPrice: p.markPrice,
                    accountId: p.accountId,
                  });
                }}
              >
                Hand over
              </Button>
            )}
            {!p.ride && (
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-[10px]"
                disabled={!p.exchange || busyId != null}
                title={
                  !p.exchange
                    ? "Exchange unknown for this position"
                    : "Give this position to the bot whose entry was refused"
                }
                onClick={(e) => {
                  e.stopPropagation();
                  setAdoptTarget({
                    exchange: p.exchange!,
                    symbol: p.symbol,
                    side: p.side,
                    entryPrice: p.entryPrice,
                    markPrice: p.markPrice,
                    accountId: p.accountId,
                  });
                }}
              >
                Adopt into bot
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[10px]"
              disabled={!p.exchange}
              title={
                !p.exchange
                  ? "Exchange unknown for this position"
                  : "Attach a trailing stop / break-even to this position"
              }
              onClick={(e) => {
                e.stopPropagation();
                setManageTarget({
                  exchange: p.exchange!,
                  symbol: p.symbol,
                  side: p.side,
                  entryPrice: p.entryPrice,
                  markPrice: p.markPrice,
                  accountId: p.accountId,
                  group: p.group ?? null,
                  expiry: p.expiry ?? null,
                });
              }}
            >
              <Shield className="size-3 mr-1" />
              Manage
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-[10px]"
                  disabled={!canMove}
                  title={
                    !canMove
                      ? "Exchange or account unknown for this position"
                      : "Move this position to a group"
                  }
                  onClick={(e) => e.stopPropagation()}
                >
                  <Layers className="size-3 mr-1" />
                  Move
                </Button>
              </DropdownMenuTrigger>
              {/* React events bubble through the portal to the row — stop them
                  so a menu click never triggers the row navigation. */}
              <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                <DropdownMenuItem
                  className="cursor-pointer font-mono text-xs"
                  onClick={() => void assignTo(p, null)}
                >
                  {!p.group && <Check className="size-3 mr-1" />}
                  Unsorted
                </DropdownMenuItem>
                {groups.map((g) => (
                  <DropdownMenuItem
                    key={g.id}
                    className="cursor-pointer font-mono text-xs"
                    onClick={() => void assignTo(p, g.id)}
                  >
                    {p.group?.id === g.id && <Check className="size-3 mr-1" />}
                    {g.name}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="cursor-pointer font-mono text-xs"
                  onClick={() => {
                    setMoveTarget(p);
                    setMoveName("");
                  }}
                >
                  <Plus className="size-3 mr-1" />
                  New group…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-[10px]"
                  disabled={disabled}
                  title={
                    !p.exchange
                      ? "Exchange unknown for this position"
                      : "Close part of the position at market"
                  }
                  onClick={(e) => e.stopPropagation()}
                >
                  Reduce
                  <ChevronDown className="size-3 ml-1" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                {[0.25, 0.5, 0.75].map((f) => (
                  <DropdownMenuItem
                    key={f}
                    className="cursor-pointer font-mono text-xs"
                    onClick={() => requestClose(p, f)}
                  >
                    {f * 100}%
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[10px] border-[var(--kb-red)]/40 text-[var(--kb-red)] hover:text-[var(--kb-red)]"
              disabled={disabled}
              title={
                !p.exchange
                  ? "Exchange unknown for this position"
                  : "Close this position now at market"
              }
              onClick={(e) => {
                e.stopPropagation();
                requestClose(p, 1);
              }}
            >
              {busyId === p.id ? <Loader2 className="size-3 animate-spin" /> : "Close"}
            </Button>
          </div>
        );
      },
    });
    return columns;
  };

  const groupedEntries = overviewData?.entries ?? null;

  return (
    <div className="flex flex-col text-foreground">
      <PageHeader
        title="Positions"
        description="Live open positions across your connected exchanges: actual fills, mark prices and unrealized P&L."
        meta={
          <div className="flex flex-col items-end gap-1">
            <div
              className={`font-mono text-[28px] font-medium leading-none tabular-nums ${
                totalPnL >= 0 ? "text-[var(--kb-green)]" : "text-[var(--kb-red)]"
              }`}
            >
              {totalPnL >= 0 ? "+" : "-"}${Math.abs(totalPnL).toFixed(2)}
            </div>
            <div className="font-mono text-[11px] tabular-nums text-muted-foreground">
              ${totalNotional.toFixed(2)} notional
            </div>
          </div>
        }
        actions={
          <div className="flex items-center gap-2">
            <DataFreshness
              updatedAt={lastUpdated}
              isRefreshing={isLoading}
              onRefresh={refresh}
            />
            <ViewToggle flat={flatView} onChange={setFlatView} />
            <Button size="sm" variant="outline" onClick={() => setGroupsOpen(true)}>
              <Layers className="size-3.5 mr-1" />
              Groups
            </Button>
            {positions.length > 0 && (
              <Button onClick={exportCsv} size="sm" variant="outline">
                <Download className="size-3.5 mr-1" />
                Export CSV
              </Button>
            )}
            {positions.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                className="border-[var(--kb-red)]/40 text-[var(--kb-red)] hover:text-[var(--kb-red)]"
                disabled={closingAll}
                onClick={() => setConfirmAction({ kind: "close-all" })}
              >
                {closingAll ? (
                  <Loader2 className="size-3.5 mr-1 animate-spin" />
                ) : (
                  <AlertTriangle className="size-3.5 mr-1" />
                )}
                Close all
              </Button>
            )}
          </div>
        }
      />

      <StatStrip
        size="md"
        items={[
          { label: "Open Positions", value: positions.length },
          { label: "Total Notional", value: `$${totalNotional.toFixed(2)}` },
          {
            label: "Unrealized P&L",
            value: `${totalPnL >= 0 ? "+" : "-"}$${Math.abs(totalPnL).toFixed(2)}`,
            valueClassName:
              totalPnL >= 0 ? "text-[var(--kb-green)]" : "text-[var(--kb-red)]",
          },
        ]}
      />

      {isStale && <StaleDataBanner updatedAt={lastUpdated} onRetry={refresh} />}

      <Section flush noBorder>
        <QueryStateGate
          isLoading={isLoading && positions.length === 0}
          isError={error != null}
          onRetry={refresh}
          errorTitle="Couldn't load positions"
          errorDescription="The executor backend didn't respond. Open positions may still exist on your exchanges."
          isEmpty={positions.length === 0}
          emptyState={
            <EmptyState
              className="py-12"
              icon={Layers}
              title="No open positions"
              description="Positions opened on your connected exchanges show up here."
            />
          }
        >
          {flatView ? (
            <DataMatrix
              className="text-[13px] tabular-nums"
              rows={positions}
              rowKey={(p) => p.id}
              defaultSort={{ key: "size", dir: "desc" }}
              onRowClick={(p) => {
                if (p.exchange) navigate(`/exchanges/${encodeURIComponent(p.exchange)}`);
              }}
              columns={makeColumns(true)}
            />
          ) : groupedEntries == null ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
            </div>
          ) : (
            <div className="flex flex-col">
              {groupedEntries.map((entry) => {
                const key = entry.group?.id ?? "unsorted";
                const isCollapsed = !!collapsed[key];
                const agg = entry.aggregates;
                const guardedCount = entry.positions.filter((gp) => groupGuardFor(gp)).length;
                const isGroupBusy = !!entry.group && groupBusy === entry.group.id;
                return (
                  <div key={key} className="border-b border-border last:border-b-0">
                    <div className="flex w-full items-center bg-muted/10 transition-colors hover:bg-muted/30">
                      <button
                        type="button"
                        onClick={() =>
                          setCollapsed((c) => ({ ...c, [key]: !c[key] }))
                        }
                        className="flex min-w-0 flex-1 items-center gap-2 px-4 py-2.5 text-left"
                      >
                        <ChevronDown
                          className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${
                            isCollapsed ? "-rotate-90" : ""
                          }`}
                        />
                        <span className="font-mono text-xs font-medium text-foreground">
                          {entry.group?.name ?? "Unsorted"}
                        </span>
                        {entry.group && <GroupSourceBadge source={entry.group.source} />}
                        <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                          {agg.positionCount} position{agg.positionCount === 1 ? "" : "s"}
                        </span>
                        <div className="ml-auto flex items-center gap-4 font-mono text-[11px] tabular-nums">
                          {guardedCount > 0 && (
                            <span
                              className="inline-flex items-center gap-1 text-[var(--kb-teal)]"
                              title="Members carrying the group risk guard"
                            >
                              <Shield className="size-3" />
                              {guardedCount}/{agg.positionCount}
                            </span>
                          )}
                          <span
                            className={
                              agg.netUnrealizedPnl >= 0
                                ? "text-[var(--kb-green)]"
                                : "text-[var(--kb-red)]"
                            }
                          >
                            {money(agg.netUnrealizedPnl)}
                          </span>
                          <span className="text-muted-foreground">
                            ${groupExposure(entry.positions).toFixed(2)} exposure
                          </span>
                          {agg.stopRisk == null ? (
                            <span className="text-muted-foreground" title="No member carries a stop">
                              no stops
                            </span>
                          ) : (
                            <span
                              className={
                                agg.stopRisk > 0
                                  ? "text-[var(--kb-amber)]"
                                  : "text-[var(--kb-green)]"
                              }
                              title={
                                agg.stopRisk > 0
                                  ? "Loss if every armed stop is hit"
                                  : "Profit locked in by the armed stops"
                              }
                            >
                              {agg.stopRisk > 0
                                ? `-$${agg.stopRisk.toFixed(2)} stop risk`
                                : `+$${Math.abs(agg.stopRisk).toFixed(2)} locked in`}
                              {" · "}
                              {agg.stoppedCount}/{agg.positionCount} stopped
                            </span>
                          )}
                        </div>
                      </button>
                      {entry.group && (
                        <div className="shrink-0 pr-3">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-6 px-2 text-[10px]"
                                disabled={isGroupBusy}
                                title="Group actions"
                              >
                                {isGroupBusy ? (
                                  <Loader2 className="size-3 animate-spin" />
                                ) : (
                                  <>
                                    Actions
                                    <ChevronDown className="size-3 ml-1" />
                                  </>
                                )}
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                className="cursor-pointer font-mono text-xs"
                                disabled={agg.positionCount === 0}
                                onClick={() => setTightenEntry(entry)}
                              >
                                <Shield className="size-3 mr-1" />
                                Tighten stops…
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className="cursor-pointer font-mono text-xs"
                                disabled={agg.positionCount === 0}
                                onClick={() => setProtectEntry(entry)}
                              >
                                <Shield className="size-3 mr-1" />
                                {guardedCount > 0 ? "Edit protection…" : "Protect group…"}
                              </DropdownMenuItem>
                              {guardedCount > 0 && (
                                <DropdownMenuItem
                                  className="cursor-pointer font-mono text-xs"
                                  onClick={() => void unprotectGroup(entry)}
                                >
                                  Unprotect
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                className="cursor-pointer font-mono text-xs text-[var(--kb-red)] focus:text-[var(--kb-red)]"
                                disabled={agg.positionCount === 0}
                                onClick={() => setGroupClose(entry)}
                              >
                                <AlertTriangle className="size-3 mr-1" />
                                Close group…
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      )}
                    </div>
                    {!isCollapsed && (
                      <DataMatrix
                        className="text-[13px] tabular-nums"
                        rows={entry.positions.map(toPosition)}
                        rowKey={(p) => p.id}
                        defaultSort={{ key: "size", dir: "desc" }}
                        onRowClick={(p) => {
                          if (p.exchange)
                            navigate(`/exchanges/${encodeURIComponent(p.exchange)}`);
                        }}
                        columns={makeColumns(false)}
                      />
                    )}
                  </div>
                );
              })}
              {groupedEntries.length === 0 && (
                <div className="py-6 text-center text-xs text-muted-foreground">
                  No live positions in any group yet.
                </div>
              )}
            </div>
          )}
        </QueryStateGate>
      </Section>

      {manageTarget && (
        <ManagePositionDialog
          target={manageTarget}
          trail={
            trailsData?.trails.find(
              (t) =>
                t.active &&
                t.exchange === manageTarget.exchange &&
                t.symbol.toUpperCase() === manageTarget.symbol.toUpperCase(),
            ) ?? null
          }
          onOpenChange={(o) => {
            if (!o) setManageTarget(null);
          }}
          onChanged={() => {
            refreshTrails();
            refreshManagers();
          }}
        />
      )}

      {handOverTarget && (
        <HandOverDialog
          target={handOverTarget}
          onOpenChange={(o) => {
            if (!o) setHandOverTarget(null);
          }}
          onDone={() => {
            refresh();
            refreshTrails();
            refreshManagers();
          }}
        />
      )}

      {adoptTarget && (
        <AdoptDialog
          target={adoptTarget}
          onOpenChange={(o) => {
            if (!o) setAdoptTarget(null);
          }}
          onDone={() => {
            refresh();
            refreshTrails();
            refreshManagers();
          }}
        />
      )}

      {rollTarget && (
        <RollPositionDialog
          target={rollTarget}
          onOpenChange={(o) => {
            if (!o) setRollTarget(null);
          }}
          onDone={() => {
            refresh();
            refreshTrails();
            if (!flatView) refreshOverview();
          }}
        />
      )}

      {groupsOpen && (
        <GroupsDialog
          groups={groups}
          onOpenChange={(o) => {
            if (!o) setGroupsOpen(false);
          }}
          onChanged={refreshGrouping}
        />
      )}

      {moveTarget && (
        <Dialog
          open
          onOpenChange={(o) => {
            if (!o) setMoveTarget(null);
          }}
        >
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>New group</DialogTitle>
              <DialogDescription>
                Creates a group and moves {moveTarget.symbol} into it.
              </DialogDescription>
            </DialogHeader>
            <input
              autoFocus
              className="h-8 w-full rounded-md border border-border bg-background px-2 font-mono text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder="Group name"
              value={moveName}
              onChange={(e) => setMoveName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void createGroupAndAssign();
              }}
            />
            <Button
              className="w-full"
              disabled={!moveName.trim() || moveBusy}
              onClick={() => void createGroupAndAssign()}
            >
              {moveBusy ? <Loader2 className="size-4 animate-spin" /> : "Create & move"}
            </Button>
          </DialogContent>
        </Dialog>
      )}

      {groupClose?.group && (
        <ConfirmDialog
          open
          onOpenChange={(o) => {
            if (!o) setGroupClose(null);
          }}
          tone="danger-money"
          title={`Close group ${groupClose.group.name}?`}
          description="Closes every position in this group at market, one by one (reduce-only). Skipped or failed members are reported."
          summary={[
            { label: "Positions", value: groupClose.aggregates.positionCount },
            {
              label: "Net P&L",
              value: (
                <span
                  className={
                    groupClose.aggregates.netUnrealizedPnl >= 0
                      ? "text-[var(--kb-green)]"
                      : "text-[var(--kb-red)]"
                  }
                >
                  {money(groupClose.aggregates.netUnrealizedPnl)}
                </span>
              ),
            },
            { label: "Exposure", value: `$${groupExposure(groupClose.positions).toFixed(2)}` },
            { label: "Order type", value: "market" },
          ]}
          confirmLabel="Close group"
          onConfirm={async () => {
            await closeGroup(groupClose);
          }}
        />
      )}

      {tightenEntry?.group && (
        <TightenStopsDialog
          entry={tightenEntry}
          onOpenChange={(o) => {
            if (!o) setTightenEntry(null);
          }}
          onReport={setActionReport}
          onChanged={() => {
            refreshTrails();
            refreshOverview();
          }}
        />
      )}

      {protectEntry?.group && (
        <ProtectGroupDialog
          entry={protectEntry}
          guardFor={groupGuardFor}
          onOpenChange={(o) => {
            if (!o) setProtectEntry(null);
          }}
          onReport={setActionReport}
          onChanged={refreshManagers}
        />
      )}

      {actionReport && (
        <GroupActionReportDialog
          report={actionReport}
          onOpenChange={(o) => {
            if (!o) setActionReport(null);
          }}
        />
      )}

      {confirmAction && (
        <ConfirmDialog
          open
          onOpenChange={(o) => {
            if (!o) setConfirmAction(null);
          }}
          tone="danger-money"
          title={
            confirmAction.kind === "close-all"
              ? "Close all positions?"
              : confirmAction.fraction < 1
                ? `Reduce ${confirmAction.position.symbol}?`
                : `Close ${confirmAction.position.symbol}?`
          }
          description={
            confirmAction.kind === "close-all"
              ? "Closes every open position across all connected exchanges at market. The executor keeps acting on new signals."
              : confirmAction.fraction < 1
                ? "Closes part of the position at market."
                : "Closes the position at market."
          }
          summary={
            confirmAction.kind === "close-all"
              ? closeAllSummary()
              : closeSummary(confirmAction.position, confirmAction.fraction)
          }
          confirmLabel={
            confirmAction.kind === "close-all"
              ? "Close all positions"
              : confirmAction.fraction < 1
                ? `Reduce ${confirmAction.fraction * 100}%`
                : "Close position"
          }
          onConfirm={async () => {
            if (confirmAction.kind === "close-all") await closeAll();
            else await closePosition(confirmAction.position, confirmAction.fraction);
          }}
          skipPreference={
            confirmAction.kind === "close"
              ? { checked: skipConfirm, onCheckedChange: setSkipConfirm }
              : undefined
          }
        />
      )}
    </div>
  );
}

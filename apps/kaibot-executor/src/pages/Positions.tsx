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
  ChevronDown,
  Download,
  Layers,
  Loader2,
  Pencil,
  Plus,
  Shield,
  Trash2,
} from "@/lib/icons";
import { toast } from "sonner";
import { useAtom, useAtomValue } from "jotai";
import {
  positionsAtom,
  skipOrderConfirmAtom,
  type Position,
} from "@/lib/atoms";
import { notionalOf, pnlUsdOf } from "@/lib/notional";
import { positionPnlPercent } from "@kaibot/types/core";
import {
  fmtPrice,
  fmtQty,
  fmtSignedPct,
  fmtSignedUsd,
  fmtUsd,
  pnlTone,
  PNL_TONE_CLASS,
  sumPnlUsd,
} from "@/lib/portfolio-figures";
import { accountKeyOfId, listedPositions, positionsKpis, toPosition } from "@/lib/positions-figures";
import { PnlCell } from "@/components/PnlCell";
import { ChartLink } from "@/components/ChartLink";
import { chartPathFor } from "@/lib/chart-link";
import {
  manualTradeApi,
  positionManageApi,
  rideApi,
  type StopFloorView,
} from "@/lib/manual-trade-api";
import { HandOverDialog, type HandOverTarget } from "@/components/HandOverDialog";
import { AccumulateDialog, type AccumulateTarget } from "@/components/AccumulateDialog";
import { accumulateApi, PHASE_LABEL, type AccumulatePlan } from "@/lib/accumulate-api";
import { syntheticUsdApi } from "@/lib/synthetic-usd-api";
import { hedgeApi } from "@/lib/hedge-api";
import {
  activeFilter,
  ALL_FILTER,
  deriveProtection,
  filterRows,
  groupFilterChips,
  holdingsFloors,
  managedBy,
  MANUAL_FILTER,
  plansWithoutPosition,
  rowActionIds,
  type PositionProtection,
  type ProtectionSources,
  type RowActionId,
} from "@/lib/position-protection";
import { layerLabel, ProtectionBadges } from "@/components/positions/ProtectionBadges";
import { PositionDetail } from "@/components/positions/PositionDetail";
import { RowActionsMenu } from "@/components/positions/RowActionsMenu";
import { HoldingsBlock } from "@/components/positions/HoldingsBlock";
import { GroupFilterChips } from "@/components/positions/GroupFilterChips";
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
import { useIsViewer } from "@/hooks/useRole";
import {
  ManagePositionDialog,
  type ManagePositionTarget,
} from "@/components/ManagePositionDialog";
import {
  RollPositionDialog,
  type RollPositionTarget,
} from "@/components/RollPositionDialog";

function pnlPercentOf(p: Position): number {
  return positionPnlPercent({ side: p.side, entryPrice: p.entryPrice, markPrice: p.markPrice ?? p.entryPrice }) ?? 0;
}

// Group exposure and P&L come from the same rows (and rules) as the page KPIs.
function groupExposure(positions: GroupedPosition[]): number {
  return positions.reduce((sum, gp) => sum + notionalOf(gp), 0);
}

function GroupPnl({ positions }: { positions: GroupedPosition[] }) {
  const { pnl, complete } = sumPnlUsd(positions.map(toPosition));
  return <span className={PNL_TONE_CLASS[pnlTone(pnl)]}>{fmtSignedUsd(pnl, complete)}</span>;
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

// Create / rename / delete groups. Deleting never touches positions — members
// just go back to Manual.
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
            to Manual. Nothing is closed.
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
                          description: "Its positions are now Manual.",
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
              ? `${r.previousStop != null ? fmtPrice(r.previousStop) : "—"} → ${
                  r.newStop != null ? fmtPrice(r.newStop) : "—"
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

// Net P&L, exposure and stop risk of the group the filter shows, with its actions.
function GroupFilterSummary({
  entry,
  guardedCount,
  busy,
  readOnly,
  onTighten,
  onProtect,
  onUnprotect,
  onClose,
}: {
  entry: GroupOverviewEntry;
  guardedCount: number;
  busy: boolean;
  readOnly: boolean;
  onTighten: () => void;
  onProtect: () => void;
  onUnprotect: () => void;
  onClose: () => void;
}) {
  const agg = entry.aggregates;
  return (
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
      <GroupPnl positions={entry.positions} />
      <span className="text-muted-foreground">{fmtUsd(groupExposure(entry.positions))} exposure</span>
      {agg.stopRisk != null && (
        <span
          className={agg.stopRisk > 0 ? "text-[var(--kb-amber)]" : "text-[var(--kb-green)]"}
          title={agg.stopRisk > 0 ? "Loss if every armed stop is hit" : "Profit locked in by the armed stops"}
        >
          {agg.stopRisk > 0
            ? `-${fmtUsd(agg.stopRisk)} stop risk`
            : `+${fmtUsd(Math.abs(agg.stopRisk))} locked in`}
          {" · "}
          {agg.stoppedCount}/{agg.positionCount} stopped
        </span>
      )}
      {entry.group && !readOnly && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-6 px-2 text-[10px]" disabled={busy}>
              {busy ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <>
                  Group actions
                  <ChevronDown className="size-3 ml-1" />
                </>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem className="cursor-pointer font-mono text-xs" onClick={onTighten}>
              <Shield className="size-3 mr-1" />
              Tighten stops…
            </DropdownMenuItem>
            <DropdownMenuItem className="cursor-pointer font-mono text-xs" onClick={onProtect}>
              <Shield className="size-3 mr-1" />
              {guardedCount > 0 ? "Edit protection…" : "Protect group…"}
            </DropdownMenuItem>
            {guardedCount > 0 && (
              <DropdownMenuItem className="cursor-pointer font-mono text-xs" onClick={onUnprotect}>
                Unprotect
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="cursor-pointer font-mono text-xs text-[var(--kb-red)] focus:text-[var(--kb-red)]"
              onClick={onClose}
            >
              <AlertTriangle className="size-3 mr-1" />
              Close group…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
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
  const isViewer = useIsViewer();
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [closingAll, setClosingAll] = useState(false);
  const [manageTarget, setManageTarget] = useState<ManagePositionTarget | null>(null);
  const [rollTarget, setRollTarget] = useState<RollPositionTarget | null>(null);
  const [handOverTarget, setHandOverTarget] = useState<HandOverTarget | null>(null);
  const [accumulateTarget, setAccumulateTarget] = useState<AccumulateTarget | null>(null);
  const [adoptTarget, setAdoptTarget] = useState<AdoptTarget | null>(null);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [filterKey, setFilterKey] = useState<string>(ALL_FILTER);
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
  // Protection badges and the Manage dialog's initial state.
  const { data: trailsData, refresh: refreshTrails } = usePolledResource(
    () => positionManageApi.list(),
    { intervalMs: 5000 },
  );
  // Stop floor row of a bot-managed position (server exit state), account
  // scoped where the row knows its account.
  const floorFor = (p: {
    exchange?: string;
    symbol: string;
    accountId?: string;
  }): StopFloorView | undefined =>
    trailsData?.floors?.find(
      (f) =>
        f.active &&
        f.exchange === p.exchange &&
        f.symbol.toUpperCase() === p.symbol.toUpperCase() &&
        (f.accountId == null || !p.accountId || f.accountId === p.accountId),
    );

  // Group buckets with aggregates (server-sorted, Unsorted last).
  const { data: overviewData, refresh: refreshOverview } = usePolledResource(
    () => positionGroupsApi.overview(),
    { intervalMs: 5000 },
  );
  // Attached edge managers — drives the group-risk-guard state per member
  // (Protect / Unprotect on the group header).
  const { data: managersData, refresh: refreshManagers } = usePolledResource(
    () => positionManagersApi.list(),
    { intervalMs: 5000 },
  );
  // Remaining protection sources, joined per row by deriveProtection.
  const { data: ridesData, refresh: refreshRides } = usePolledResource(() => rideApi.list(), {
    intervalMs: 10_000,
  });
  const { data: floorsData } = usePolledResource(() => syntheticUsdApi.list(), {
    intervalMs: 60_000,
  });
  const { data: hedgesData } = usePolledResource(() => hedgeApi.list(), { intervalMs: 15_000 });
  const { data: plansData, refresh: refreshPlans } = usePolledResource(
    () => accumulateApi.list(),
    { intervalMs: 10_000 },
  );

  const groupedEntries = overviewData?.entries ?? null;
  const rows = useMemo(() => listedPositions(groupedEntries, positions), [groupedEntries, positions]);
  const sources = useMemo<ProtectionSources>(
    () => ({
      trails: trailsData?.trails ?? [],
      stopFloors: trailsData?.floors ?? [],
      rides: ridesData?.rides ?? [],
      floors: floorsData?.positions ?? [],
      hedges: hedgesData?.hedges ?? [],
      plans: plansData?.plans ?? [],
    }),
    [trailsData, ridesData, floorsData, hedgesData, plansData],
  );
  const protections = useMemo(
    () => new Map(rows.map((p) => [p.id, deriveProtection(p, sources)])),
    [rows, sources],
  );
  const protectionOf = (p: Position): PositionProtection =>
    protections.get(p.id) ?? deriveProtection(p, sources);
  const chips = groupFilterChips(rows);
  const filter = activeFilter(chips, filterKey);
  const visibleRows = filterRows(rows, filter);
  const filterEntry =
    filter === ALL_FILTER
      ? null
      : (groupedEntries?.find((e) => (filter === MANUAL_FILTER ? !e.group : e.group?.id === filter)) ?? null);
  const kpis = positionsKpis(rows);
  const protectedCount = rows.filter((p) => protectionOf(p).primary != null).length;
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
      toast.success(target ? `Moved ${p.symbol} to ${target}` : `Moved ${p.symbol} to Manual`);
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

  const takeBack = async (p: Position, positionId: string | undefined) => {
    if (!positionId) return;
    setBusyId(p.id ?? p.symbol);
    try {
      await rideApi.takeBack(positionId);
      toast.success(`${p.symbol} taken back: the position is manual again`);
      refresh();
      refreshTrails();
      refreshRides();
      refreshOverview();
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
      refreshOverview();
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
      refreshOverview();
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

  const planAction = async (plan: AccumulatePlan, kind: "check" | "stop") => {
    try {
      if (kind === "stop") {
        await accumulateApi.stop(plan.id);
        toast.success(`${plan.symbol}: plan stopped, rungs cancelled`);
      } else {
        const r = await accumulateApi.check(plan.id);
        toast.message(`${plan.symbol}: ${r.plan.lastNote ?? PHASE_LABEL[r.plan.phase]}`);
      }
      refreshPlans();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Request failed");
    }
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
        value: fraction < 1 ? `${fraction * 100}% · ${fmtQty(qty)}` : fmtQty(qty),
      },
      { label: "Order type", value: "market" },
    ];
    if (px > 0)
      items.push({
        label: "Notional",
        value: `≈ ${fmtUsd(notionalOf(p) * fraction)}`,
      });
    return items;
  };

  const closeAllSummary = (): ConfirmSummaryItem[] => [
    { label: "Positions", value: positions.length },
    { label: "Order type", value: "market" },
    { label: "Notional", value: `≈ ${fmtUsd(positions.reduce((sum, p) => sum + notionalOf(p), 0))}` },
  ];

  const exportCsv = () => {
    downloadCsv(
      "positions.csv",
      toCsv(rows, [
        { header: "Symbol", value: (p) => p.symbol },
        { header: "Side", value: (p) => p.side },
        { header: "Size", value: (p) => p.size },
        { header: "Entry", value: (p) => p.entryPrice },
        { header: "Mark", value: (p) => p.markPrice ?? p.entryPrice },
        { header: "Notional", value: (p) => notionalOf(p).toFixed(2) },
        { header: "Unrealized PnL USD", value: (p) => pnlUsdOf(p)?.toFixed(2) ?? "" },
        { header: "Unrealized PnL native", value: (p) => p.unrealizedPnL ?? 0 },
        { header: "PnL currency", value: (p) => p.pnlCurrency ?? "USD" },
        { header: "PnL %", value: (p) => pnlPercentOf(p).toFixed(2) },
        { header: "Exchange", value: (p) => p.exchange ?? "" },
        { header: "Group", value: (p) => p.group?.name ?? "" },
        {
          header: "Protection",
          value: (p) => protectionOf(p).layers.map(layerLabel).join(" / "),
        },
        { header: "Managed by", value: (p) => managedBy(p, protectionOf(p)) },
        {
          header: "Ladder",
          value: (p) => p.ladder?.levels.map(ladderBadgeLabel).join(" / ") ?? "",
        },
      ]),
    );
  };

  // Ladder strategies are the only ones whose timeframe moves, so the column
  // only appears when at least one position actually sits on a ladder.
  const hasLadder = useMemo(
    () => rows.some((p) => (p.ladder?.levels.length ?? 0) > 0),
    [rows],
  );

  const runRowAction = (p: Position, id: Exclude<RowActionId, "move" | "reduce">) => {
    const prot = protectionOf(p);
    const coords = { exchange: p.exchange!, symbol: p.symbol, accountId: p.accountId };
    switch (id) {
      case "manage-stop":
        setManageTarget({
          ...coords,
          side: p.side,
          entryPrice: p.entryPrice,
          markPrice: p.markPrice,
          group: p.group ?? null,
          expiry: p.expiry ?? null,
        });
        return;
      case "hand-over":
        setHandOverTarget({ ...coords, side: p.side, entryPrice: p.entryPrice, markPrice: p.markPrice });
        return;
      case "take-back":
        void takeBack(p, p.ride?.positionId ?? prot.ride?.positionId);
        return;
      case "adopt":
        setAdoptTarget({ ...coords, side: p.side, entryPrice: p.entryPrice, markPrice: p.markPrice });
        return;
      case "accumulate":
        setAccumulateTarget({ ...coords, accountId: p.accountId!, side: p.side, entryPrice: p.entryPrice });
        return;
      case "roll":
        setRollTarget({ ...coords, expiry: p.expiry });
        return;
      case "plan-check":
      case "plan-stop":
        if (prot.plan) void planAction(prot.plan, id === "plan-stop" ? "stop" : "check");
        return;
      case "close":
        requestClose(p, 1);
        return;
    }
  };

  const columns: MatrixColumn<Position>[] = [
    {
      key: "symbol",
      header: "Symbol",
      sortable: true,
      sortAccessor: (p) => p.symbol,
      cell: (p) => {
        const key = accountKeyOfId(p.accountId);
        const chartPath = isViewer ? null : chartPathFor(p.exchange, p.symbol);
        const symbol = <span className="font-mono text-[var(--kb-teal)]">{p.symbol}</span>;
        return (
          <span className="flex flex-col">
            <span className="inline-flex items-center gap-1.5">
              {chartPath ? <ChartLink to={chartPath}>{symbol}</ChartLink> : symbol}
              {p.expiry && <ExpiryBadge expiry={p.expiry} />}
              {chartPath && <ChartLink to={chartPath} />}
            </span>
            <span className="whitespace-nowrap text-[11px] text-muted-foreground">
              <span className="capitalize">{p.exchange || "—"}</span>
              {key && ` · ${key}`}
            </span>
          </span>
        );
      },
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
    ...(hasLadder
      ? [
          {
            key: "tf",
            header: "TF",
            cell: (p: Position) =>
              p.ladder ? (
                <TimeframeBadge timeframe={p.ladder.timeframe} levels={p.ladder.levels} />
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
      cell: (p) => <span className="font-mono">{fmtQty(p.size)}</span>,
    },
    {
      key: "entry",
      header: "Entry",
      align: "right",
      sortable: true,
      sortAccessor: (p) => p.entryPrice,
      cell: (p) => <span className="font-mono">${fmtPrice(p.entryPrice)}</span>,
    },
    {
      key: "mark",
      header: "Mark",
      align: "right",
      sortable: true,
      sortAccessor: (p) => p.markPrice ?? p.entryPrice,
      cell: (p) => <span className="font-mono">${fmtPrice(p.markPrice ?? p.entryPrice)}</span>,
    },
    {
      key: "pnl",
      header: "P&L",
      hint: "Unrealized, since entry, in USD",
      align: "right",
      sortable: true,
      sortAccessor: (p) => pnlUsdOf(p) ?? 0,
      cell: (p) => <PnlCell p={p} />,
    },
    {
      key: "pct",
      header: "%",
      align: "right",
      sortable: true,
      sortAccessor: pnlPercentOf,
      cell: (p) => {
        const pnlPercent = pnlPercentOf(p);
        return (
          <span className={`font-mono ${PNL_TONE_CLASS[pnlTone(pnlPercent)]}`}>
            {fmtSignedPct(pnlPercent)}
          </span>
        );
      },
    },
    {
      key: "protection",
      header: "Protection",
      align: "right",
      cell: (p) => <ProtectionBadges protection={protectionOf(p)} />,
    },
    {
      key: "managed",
      header: "Managed by",
      sortable: true,
      sortAccessor: (p) => managedBy(p, protectionOf(p)),
      cell: (p) => {
        const prot = protectionOf(p);
        const riding = !!(p.ride || prot.ride);
        return (
          <span className="inline-flex max-w-[8rem] items-center gap-1.5 xl:max-w-[16rem]">
            {riding ? (
              <span className="font-mono text-[9px] uppercase text-[var(--kb-teal)]">ride</span>
            ) : (
              p.group && <GroupSourceBadge source={p.group.source} />
            )}
            <span className="truncate text-muted-foreground" title={managedBy(p, prot)}>
              {managedBy(p, prot)}
            </span>
          </span>
        );
      },
    },
  ];
  if (!isViewer) {
    columns.push({
      key: "actions",
      header: "",
      align: "right",
      cell: (p) => {
        const prot = protectionOf(p);
        const ids = p.exchange
          ? rowActionIds(p, {
              isViewer,
              riding: !!(p.ride || prot.ride),
              hasPlan: !!prot.plan,
              canAccount: !!p.accountId,
            })
          : [];
        return (
          <RowActionsMenu
            ids={ids}
            groups={groups}
            currentGroupId={p.group?.id ?? null}
            busy={busyId === p.id}
            disabled={busyId != null}
            handlers={{
              onAction: (id) => runRowAction(p, id),
              onReduce: (f) => requestClose(p, f),
              onMove: (groupId) => void assignTo(p, groupId),
              onNewGroup: () => {
                setMoveTarget(p);
                setMoveName("");
              },
            }}
          />
        );
      },
    });
  }

  return (
    <div className="flex flex-col text-foreground">
      <PageHeader
        title="Positions"
        actions={
          <div className="flex items-center gap-2">
            <DataFreshness
              updatedAt={lastUpdated}
              isRefreshing={isLoading}
              onRefresh={refresh}
            />
            {rows.length > 0 && (
              <Button onClick={exportCsv} size="sm" variant="outline">
                <Download className="size-3.5 mr-1" />
                Export CSV
              </Button>
            )}
            {!isViewer && rows.length > 0 && (
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
          { label: "Open Positions", value: kpis.openPositions },
          { label: "Total Notional", value: fmtUsd(kpis.totalNotional) },
          {
            label: "Unrealized P&L",
            value: fmtSignedUsd(kpis.unrealizedPnL, kpis.pnlComplete),
            valueClassName: PNL_TONE_CLASS[pnlTone(kpis.unrealizedPnL)],
          },
          {
            label: "Protected",
            value: `${protectedCount}/${kpis.openPositions}`,
            valueClassName:
              protectedCount < kpis.openPositions ? "text-[var(--kb-amber)]" : undefined,
          },
        ]}
      />

      {isStale && <StaleDataBanner updatedAt={lastUpdated} onRetry={refresh} />}

      <Section flush noBorder>
        <QueryStateGate
          isLoading={isLoading && rows.length === 0}
          isError={error != null}
          onRetry={refresh}
          errorTitle="Couldn't load positions"
          errorDescription="The executor backend didn't respond. Open positions may still exist on your exchanges."
          isEmpty={rows.length === 0}
          emptyState={
            <EmptyState className="py-12" icon={Layers} title="No open positions" />
          }
        >
          <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-4 py-2">
            <GroupFilterChips chips={chips} active={filter} onChange={setFilterKey} />
            {filterEntry && (
              <GroupFilterSummary
                entry={filterEntry}
                guardedCount={filterEntry.positions.filter((gp) => groupGuardFor(gp)).length}
                busy={!!filterEntry.group && groupBusy === filterEntry.group.id}
                readOnly={isViewer}
                onTighten={() => setTightenEntry(filterEntry)}
                onProtect={() => setProtectEntry(filterEntry)}
                onUnprotect={() => void unprotectGroup(filterEntry)}
                onClose={() => setGroupClose(filterEntry)}
              />
            )}
            {!isViewer && (
              <Button
                size="sm"
                variant="ghost"
                className={`h-6 px-2 text-[11px] ${filterEntry ? "" : "ml-auto"}`}
                onClick={() => setGroupsOpen(true)}
              >
                Groups…
              </Button>
            )}
          </div>
          <DataMatrix
            className="text-[13px] tabular-nums"
            rows={visibleRows}
            rowKey={(p) => p.id}
            defaultSort={{ key: "size", dir: "desc" }}
            persistKey="positions"
            onRowClick={(p) => {
              if (p.exchange) navigate(`/exchanges/${encodeURIComponent(p.exchange)}`);
            }}
            expandable={{
              isExpandable: (p) => {
                const pr = protectionOf(p);
                return pr.layers.length > 0 || pr.holdingsFloor != null;
              },
              render: (p) => <PositionDetail protection={protectionOf(p)} />,
            }}
            columns={columns}
          />
        </QueryStateGate>
      </Section>

      <HoldingsBlock
        floors={holdingsFloors(sources.floors, rows)}
        plans={plansWithoutPosition(sources.plans, rows)}
        readOnly={isViewer}
        onPlan={(plan, kind) => void planAction(plan, kind)}
      />


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
          floor={floorFor(manageTarget) ?? null}
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

      {accumulateTarget && (
        <AccumulateDialog
          target={accumulateTarget}
          onOpenChange={(o) => {
            if (!o) setAccumulateTarget(null);
          }}
          onDone={() => {
            refresh();
            refreshPlans();
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
            refreshOverview();
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
                <GroupPnl positions={groupClose.positions} />
              ),
            },
            { label: "Exposure", value: fmtUsd(groupExposure(groupClose.positions)) },
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

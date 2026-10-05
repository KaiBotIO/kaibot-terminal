import { useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
} from '@kaibot/shared';
import { Loader2, Lock } from '@/lib/icons';
import { toast } from 'sonner';
import {
  positionManageApi,
  type ManagedTrailView,
  type StopFloorView,
  type TrailMode,
} from '@/lib/manual-trade-api';
import {
  positionManagersApi,
  tpFiredCount,
  type AttachedManagerView,
  type ManagedPositionView,
} from '@/lib/position-managers-api';
import type { PositionGroupInfo } from '@/lib/position-groups-api';
import type { PositionExpiryInfo } from '@/lib/atoms';
import {
  defaultHedgeSymbolFor,
  hedgeApi,
  type HedgeGuardView,
  type HedgeOnMainClose,
  type HedgeSizeMode,
} from '@/lib/hedge-api';

const labelClass = 'font-mono text-[10px] uppercase tracking-wider text-muted-foreground';

const num = (s: string): number | undefined => {
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : undefined;
};

const fmtPx = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString(undefined, { maximumFractionDigits: 8 });
// Floor badge: European notation (1 353,75).
const fmtFloor = (n: number) => n.toLocaleString('fr-FR', { maximumFractionDigits: 8 });

// Small pill toggle, same visual language as the panel's Single/Ladder toggle.
function Pill<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex overflow-hidden rounded border border-border text-[10px]">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`px-1.5 py-0.5 font-mono uppercase ${
            value === o.value ? 'bg-muted text-foreground' : 'text-muted-foreground'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function OnOff({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <Pill
      value={on ? 'on' : 'off'}
      options={[
        { value: 'off', label: 'Off' },
        { value: 'on', label: 'On' },
      ]}
      onChange={(v) => onChange(v === 'on')}
    />
  );
}

export interface ManagePositionTarget {
  exchange: string;
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  markPrice?: number;
  accountId?: string;
  // The position's group, when the caller knows it — shows the group
  // risk-guard section (managed at group level, individual attach allowed).
  group?: PositionGroupInfo | null;
  // 'take-over': the "Keep management?" step right after a bot take-over (F3).
  // Same form, different framing; closing it keeps the position fully manual.
  context?: 'take-over';
  // Dated-futures expiry, when the caller knows it — shows the rollover badge.
  expiry?: PositionExpiryInfo | null;
}

// Attach / adjust protection on one open position: trail + break-even (F1
// trail row) and the F2 edge managers (TP ladder, risk guard).
// Reduce/protect-only: everything here moves stops or reduces the position —
// it never places an entry.
export function ManagePositionDialog({
  target,
  trail: existing,
  floor,
  onOpenChange,
  onChanged,
}: {
  target: ManagePositionTarget;
  // The position's active trail, if the caller already has it (list poll).
  trail?: ManagedTrailView | null;
  // The bot's stop-floor row when a bot manages this position (list poll).
  floor?: StopFloorView | null;
  onOpenChange: (open: boolean) => void;
  onChanged?: () => void;
}) {
  const [view, setView] = useState<ManagedTrailView | null>(existing ?? null);
  const [busy, setBusy] = useState(false);

  // Bot position without a trail row: the stop floor is the user's handle on
  // the stop, no take-over needed. The trail form stays for a full take-over.
  const botManaged = !!floor && !existing;
  const [floorView, setFloorView] = useState<StopFloorView | null>(floor ?? null);
  const [floorStop, setFloorStop] = useState(
    floor?.manualStop != null ? String(floor.manualStop) : '',
  );
  const [floorLocked, setFloorLocked] = useState(floor?.trailingLock ?? false);

  const [trailOn, setTrailOn] = useState(!!existing);
  const [mode, setMode] = useState<TrailMode>(existing?.mode ?? 'fixed');
  const [unit, setUnit] = useState<'pct' | 'points'>(
    existing?.trailPoints != null ? 'points' : 'pct',
  );
  const [distance, setDistance] = useState(
    existing ? String(existing.trailPoints ?? existing.trailPercentage ?? '') : '',
  );
  const [freezeExtreme, setFreezeExtreme] = useState(existing?.freezeExtreme ?? false);
  const [reference, setReference] = useState(
    existing?.referencePrice != null ? String(existing.referencePrice) : '',
  );
  const [beOn, setBeOn] = useState(existing?.breakevenFee != null);
  const [beFeePct, setBeFeePct] = useState(
    existing?.breakevenFee != null ? String(existing.breakevenFee * 100) : '0.1',
  );
  const [manualStop, setManualStop] = useState(
    existing?.manualStop != null ? String(existing.manualStop) : '',
  );
  const [locked, setLocked] = useState(existing?.trailingLock ?? false);

  // Edge managers on the position (F2): TP ladder (derived/golden-spaced) +
  // risk guard. Attached state comes from /api/trade/managers on open.
  const [managedView, setManagedView] = useState<ManagedPositionView | null>(null);
  const [tpOn, setTpOn] = useState(false);
  const [tpTarget, setTpTarget] = useState('');
  const [tpLevels, setTpLevels] = useState('3');
  const [tpTranchePct, setTpTranchePct] = useState('25');
  const [tpRunnerPct, setTpRunnerPct] = useState('0');
  const [guardOn, setGuardOn] = useState(false);
  const [guardStop, setGuardStop] = useState('');
  const [guardMaxSize, setGuardMaxSize] = useState('');
  const [grpOn, setGrpOn] = useState(false);
  const [grpLossPct, setGrpLossPct] = useState('');
  const [grpNotional, setGrpNotional] = useState('');

  // Hedge guard (own lifecycle: one-shot armed -> hedged -> closed/orphaned,
  // so it acts immediately instead of joining the reconcile Apply below).
  const [hedgeView, setHedgeView] = useState<HedgeGuardView | null>(null);
  const [hedgeOpen, setHedgeOpen] = useState(false);
  const [hedgeTrigger, setHedgeTrigger] = useState('');
  const [hedgeSymbol, setHedgeSymbol] = useState(
    defaultHedgeSymbolFor(target.exchange, target.symbol) ?? '',
  );
  const [hedgeSizeMode, setHedgeSizeMode] = useState<HedgeSizeMode>('match');
  const [hedgeFixedUsd, setHedgeFixedUsd] = useState('');
  const [hedgeRecovery, setHedgeRecovery] = useState('');
  const [hedgeOnMainClose, setHedgeOnMainClose] = useState<HedgeOnMainClose>('keep');

  const attachedTp = managedView?.managers.find((m) => m.managerId === 'tp-ladder');
  const attachedGuard = managedView?.managers.find((m) => m.managerId === 'risk-guard');
  const attachedGroupGuard = managedView?.managers.find(
    (m) => m.managerId === 'group-risk-guard',
  );

  // Refresh the live trail row + attached managers on open.
  useEffect(() => {
    let cancelled = false;
    positionManageApi
      .list()
      .then(({ trails }) => {
        if (cancelled) return;
        const row = trails.find(
          (t) =>
            t.active &&
            t.exchange === target.exchange &&
            t.symbol.toUpperCase() === target.symbol.toUpperCase(),
        );
        if (row) setView(row);
      })
      .catch(() => {});
    positionManagersApi
      .list()
      .then(({ positions }) => {
        if (cancelled) return;
        const row = positions.find(
          (p) =>
            p.active &&
            p.exchange === target.exchange &&
            p.symbol.toUpperCase() === target.symbol.toUpperCase(),
        );
        if (!row) return;
        setManagedView(row);
        const tp = row.managers.find((m) => m.managerId === 'tp-ladder');
        if (tp) {
          setTpOn(true);
          if (typeof tp.params.target === 'number') setTpTarget(String(tp.params.target));
          if (typeof tp.params.levelCount === 'number') setTpLevels(String(tp.params.levelCount));
          if (typeof tp.params.fractionPerTranche === 'number')
            setTpTranchePct(String(tp.params.fractionPerTranche * 100));
          if (typeof tp.params.runnerFraction === 'number')
            setTpRunnerPct(String(tp.params.runnerFraction * 100));
        }
        const guard = row.managers.find((m) => m.managerId === 'risk-guard');
        if (guard) {
          setGuardOn(true);
          if (typeof guard.params.globalStopPrice === 'number')
            setGuardStop(String(guard.params.globalStopPrice));
          if (typeof guard.params.maxSize === 'number')
            setGuardMaxSize(String(guard.params.maxSize));
        }
        const grp = row.managers.find((m) => m.managerId === 'group-risk-guard');
        if (grp) {
          setGrpOn(true);
          if (typeof grp.params.maxGroupLossFraction === 'number')
            setGrpLossPct(String(grp.params.maxGroupLossFraction * 100));
          if (typeof grp.params.maxGroupNotional === 'number')
            setGrpNotional(String(grp.params.maxGroupNotional));
        }
      })
      .catch(() => {});
    hedgeApi
      .list()
      .then(({ hedges }) => {
        if (cancelled) return;
        const row = hedges.find(
          (h) =>
            h.exchange === target.exchange.toLowerCase() &&
            h.symbol === target.symbol.toUpperCase(),
        );
        if (!row) return;
        setHedgeView(row);
        if (row.status === 'armed' || row.status === 'hedged') {
          setHedgeOpen(true);
          setHedgeTrigger(String(row.triggerPrice));
          setHedgeSymbol(row.hedgeSymbol);
          setHedgeSizeMode(row.sizeMode);
          if (row.fixedUsd != null) setHedgeFixedUsd(String(row.fixedUsd));
          if (row.recoveryPrice != null) setHedgeRecovery(String(row.recoveryPrice));
          setHedgeOnMainClose(row.onMainClose);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [target.exchange, target.symbol]);

  const distanceNum = num(distance);
  const tpValid = tpOn && (num(tpTarget) ?? 0) > 0;
  const guardValid = guardOn && ((num(guardStop) ?? 0) > 0 || (num(guardMaxSize) ?? 0) > 0);
  const grpValid = grpOn && ((num(grpLossPct) ?? 0) > 0 || (num(grpNotional) ?? 0) > 0);
  const armComponents =
    (trailOn &&
      ((distanceNum ?? 0) > 0 || (mode === 'drawdown' && (num(reference) ?? 0) > 0))) ||
    beOn ||
    (!botManaged && (num(manualStop) ?? 0) > 0);
  const managerChanges =
    tpValid ||
    guardValid ||
    grpValid ||
    (!tpOn && !!attachedTp) ||
    (!guardOn && !!attachedGuard) ||
    (!grpOn && !!attachedGroupGuard);
  const canApply = !busy && (armComponents || managerChanges);

  const tpParams = () => ({
    target: num(tpTarget),
    levelCount: Math.max(1, Math.min(6, Math.round(num(tpLevels) ?? 3))),
    fractionPerTranche: (num(tpTranchePct) ?? 25) / 100,
    runnerFraction: (num(tpRunnerPct) ?? 0) / 100,
  });
  const guardParams = () => ({
    ...((num(guardStop) ?? 0) > 0 ? { globalStopPrice: num(guardStop) } : {}),
    ...((num(guardMaxSize) ?? 0) > 0 ? { maxSize: num(guardMaxSize) } : {}),
  });
  const grpParams = () => ({
    ...((num(grpLossPct) ?? 0) > 0 ? { maxGroupLossFraction: num(grpLossPct)! / 100 } : {}),
    ...((num(grpNotional) ?? 0) > 0 ? { maxGroupNotional: num(grpNotional) } : {}),
  });

  const paramsDiffer = (attached: AttachedManagerView | undefined, next: Record<string, unknown>) => {
    if (!attached) return true;
    return Object.entries(next).some(([k, v]) => attached.params[k] !== v);
  };

  // Attach/configure/detach the desired managers. configure RE-ARMS the reducer
  // (a new target re-derives the ladder), so it only runs when params changed.
  const reconcileManagers = async () => {
    const base = {
      exchange: target.exchange,
      symbol: target.symbol,
      accountId: target.accountId,
    } as const;
    if (tpValid && paramsDiffer(attachedTp, tpParams())) {
      await positionManagersApi.manage({
        ...base,
        action: attachedTp ? 'configure' : 'attach',
        managerId: 'tp-ladder',
        params: tpParams(),
      });
    } else if (!tpOn && attachedTp) {
      await positionManagersApi.manage({ ...base, action: 'detach', managerId: 'tp-ladder' });
    }
    if (guardValid && paramsDiffer(attachedGuard, guardParams())) {
      await positionManagersApi.manage({
        ...base,
        action: attachedGuard ? 'configure' : 'attach',
        managerId: 'risk-guard',
        params: guardParams(),
      });
    } else if (!guardOn && attachedGuard) {
      await positionManagersApi.manage({ ...base, action: 'detach', managerId: 'risk-guard' });
    }
    if (grpValid && paramsDiffer(attachedGroupGuard, grpParams())) {
      await positionManagersApi.manage({
        ...base,
        action: attachedGroupGuard ? 'configure' : 'attach',
        managerId: 'group-risk-guard',
        params: grpParams(),
      });
    } else if (!grpOn && attachedGroupGuard) {
      await positionManagersApi.manage({
        ...base,
        action: 'detach',
        managerId: 'group-risk-guard',
      });
    }
  };

  const apply = async () => {
    if (!canApply) return;
    setBusy(true);
    try {
      if (armComponents) {
        const result = (await positionManageApi.manage({
          action: 'arm',
          exchange: target.exchange,
          symbol: target.symbol,
          accountId: target.accountId,
          trail: trailOn
            ? {
                mode,
                trailPercentage: unit === 'pct' ? distanceNum : undefined,
                trailPoints: unit === 'points' ? distanceNum : undefined,
                freezeExtreme: mode === 'drawdown' ? freezeExtreme : undefined,
                referencePrice: mode === 'drawdown' ? num(reference) : undefined,
                usePoints: unit === 'points' && mode === 'drawdown' ? true : undefined,
              }
            : undefined,
          breakevenFee: beOn ? (num(beFeePct) ?? 0) / 100 : undefined,
          manualStop: botManaged ? undefined : num(manualStop),
          trailingLock: botManaged ? undefined : locked,
        })) as ManagedTrailView;
        setView(result);
      }
      await reconcileManagers();
      const parts = [
        ...(armComponents ? ['stop protection'] : []),
        ...(tpValid ? ['TP ladder'] : []),
        ...(guardValid ? ['risk guard'] : []),
        ...(grpValid ? ['group guard'] : []),
      ];
      toast.success(`Managers applied on ${target.symbol}`, {
        description: parts.length > 0 ? parts.join(' · ') : 'Managers detached',
      });
      onChanged?.();
      onOpenChange(false);
    } catch (e) {
      toast.error('Apply failed', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const floorStopNum = num(floorStop);
  const floorDirty =
    !!floorView &&
    ((floorStopNum ?? null) !== floorView.manualStop || floorLocked !== floorView.trailingLock);
  const canApplyFloor = !busy && floorDirty && (floorStopNum == null || floorStopNum > 0);

  // Set / move / lock the floor in one call: the venue stop is amended right
  // away, the bot keeps trailing above it.
  const applyFloor = async () => {
    if (!canApplyFloor) return;
    setBusy(true);
    try {
      const result = (await positionManageApi.manage({
        action: 'update',
        exchange: target.exchange,
        symbol: target.symbol,
        accountId: target.accountId,
        manualStop: floorStopNum ?? null,
        trailingLock: floorLocked,
      })) as StopFloorView;
      setFloorView(result);
      toast.success(`Stop floor set on ${target.symbol}`, {
        description:
          result.effectiveStop != null
            ? `Venue stop ${fmtPx(result.effectiveStop)}${result.trailingLock ? ' · locked' : ''}`
            : undefined,
      });
      onChanged?.();
      onOpenChange(false);
    } catch (e) {
      toast.error('Floor not set', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const removeFloor = async () => {
    setBusy(true);
    try {
      const result = (await positionManageApi.manage({
        action: 'remove',
        exchange: target.exchange,
        symbol: target.symbol,
        accountId: target.accountId,
      })) as StopFloorView;
      setFloorView(result);
      toast.success(`Stop floor removed from ${target.symbol}`, {
        description: result.engineStop != null ? `Bot stop ${fmtPx(result.engineStop)} stays` : undefined,
      });
      onChanged?.();
      onOpenChange(false);
    } catch (e) {
      toast.error('Floor not removed', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await positionManageApi.manage({
        action: 'remove',
        exchange: target.exchange,
        symbol: target.symbol,
        accountId: target.accountId,
      });
      toast.success(`Trail removed from ${target.symbol}`, {
        description: 'The last resting stop stays as static protection.',
      });
      onChanged?.();
      onOpenChange(false);
    } catch (e) {
      toast.error('Remove failed', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  // Hedge guard actions (immediate — one-shot lifecycle, no reconcile diff).
  const hedgeArmed = hedgeView?.status === 'armed';
  const hedgeLive = hedgeView?.status === 'hedged';
  const hedgeAct = async (action: 'arm' | 'update' | 'disarm' | 'close') => {
    setBusy(true);
    try {
      const base = {
        exchange: target.exchange,
        symbol: target.symbol,
        accountId: target.accountId,
      } as const;
      let next: HedgeGuardView;
      if (action === 'arm' || (action === 'update' && hedgeArmed)) {
        next = await hedgeApi.manage({
          ...base,
          action,
          triggerPrice: num(hedgeTrigger),
          hedgeSymbol: hedgeSymbol.trim() || undefined,
          sizeMode: hedgeSizeMode,
          fixedUsd: hedgeSizeMode === 'fixed-usd' ? num(hedgeFixedUsd) : undefined,
          recoveryPrice: num(hedgeRecovery) ?? null,
          onMainClose: hedgeOnMainClose,
        });
      } else if (action === 'update') {
        // Open hedge: only the wind-down knobs may move.
        next = await hedgeApi.manage({
          ...base,
          action,
          recoveryPrice: num(hedgeRecovery) ?? null,
          onMainClose: hedgeOnMainClose,
        });
      } else {
        next = await hedgeApi.manage({ ...base, action });
      }
      setHedgeView(next);
      toast.success(
        action === 'arm'
          ? `Hedge armed on ${target.symbol}`
          : action === 'close'
            ? `Hedge closed for ${target.symbol}`
            : action === 'disarm'
              ? `Hedge disarmed on ${target.symbol}`
              : `Hedge updated on ${target.symbol}`,
        {
          description:
            action === 'arm'
              ? `Opens an opposite ${next.hedgeSymbol} position when ${target.symbol} crosses ${fmtPx(next.triggerPrice)}.`
              : undefined,
        },
      );
      onChanged?.();
    } catch (e) {
      toast.error('Hedge action failed', {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  };

  const mark = target.markPrice ?? target.entryPrice;
  const isTakeOver = target.context === 'take-over';

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-sm overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">
            {isTakeOver ? 'Keep management?' : `Manage ${target.symbol}`}
            <span
              className={`ml-2 text-[10px] uppercase ${
                target.side === 'long' ? 'text-[var(--kb-green)]' : 'text-[var(--kb-red)]'
              }`}
            >
              {isTakeOver ? `${target.symbol} · ${target.side}` : target.side}
            </span>
          </DialogTitle>
          <DialogDescription className="font-mono text-[11px] tabular-nums">
            Entry {fmtPx(target.entryPrice)} · Mark {fmtPx(mark)} · {target.exchange}
          </DialogDescription>
          {target.expiry && (
            <div className="flex items-center gap-2 pt-1">
              <Badge
                variant={target.expiry.daysLeft <= 7 ? 'warning' : 'outline'}
                className="text-[9px]"
              >
                {target.expiry.daysLeft <= 0
                  ? 'rolls today'
                  : `rolls in ${target.expiry.daysLeft}d`}
              </Badge>
              <span className="text-[10px] text-muted-foreground">
                Expires{' '}
                {new Date(target.expiry.date).toLocaleDateString('en-GB', {
                  day: '2-digit',
                  month: 'short',
                  year: 'numeric',
                })}
                {target.expiry.source === 'calculated' ? ' (calculated)' : ''} · roll it
                from the Positions list
              </span>
            </div>
          )}
        </DialogHeader>

        <div className="space-y-4">
          {isTakeOver && (
            <p className="rounded-md border border-[var(--kb-amber)]/30 bg-[var(--kb-amber)]/10 px-3 py-2 text-[11px] leading-snug text-muted-foreground">
              You took this position over. The bot is paused and won't touch it
              again. Take-over is one-way: there is no handing it back. Attach any
              blocks below with your own params, or close this to work it fully by
              hand. A trail adopts the bot's resting stop as its starting point.
            </p>
          )}
          {/* Current state strip */}
          {(() => {
            const strip = botManaged ? floorView : view;
            return (
              <div className="grid grid-cols-3 gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-[11px] tabular-nums">
                <div>
                  <div className={labelClass}>Effective stop</div>
                  <div className="text-foreground">
                    {fmtPx(strip?.effectiveStop)}
                    {strip?.trailingLock && <Lock className="ml-1 inline size-3 text-[var(--kb-amber)]" />}
                  </div>
                </div>
                <div>
                  <div className={labelClass}>Resting</div>
                  <div className="text-muted-foreground">{fmtPx(strip?.currentStop)}</div>
                </div>
                <div>
                  <div className={labelClass}>{botManaged ? 'Bot' : 'Engine'}</div>
                  <div className="text-muted-foreground">{fmtPx(strip?.engineStop)}</div>
                </div>
              </div>
            );
          })()}
          {botManaged && floorView?.manualStop != null && (
            <Badge
              variant="outline"
              className="font-mono text-[10px] border-[var(--kb-amber)]/40 text-[var(--kb-amber)]"
            >
              floor {fmtFloor(floorView.manualStop)} ·{' '}
              {floorView.trailingLock ? 'locked, bot stop paused' : 'bot trails above'}
            </Badge>
          )}

          {/* Trail */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className={labelClass}>Trailing stop</span>
              <div className="flex items-center gap-2">
                {trailOn && (
                  <Pill
                    value={mode}
                    options={[
                      { value: 'fixed', label: 'Fixed' },
                      { value: 'drawdown', label: 'Drawdown' },
                    ]}
                    onChange={setMode}
                  />
                )}
                <OnOff on={trailOn} onChange={setTrailOn} />
              </div>
            </div>
            {trailOn && (
              <>
                <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                  <Input
                    className="h-9 font-mono text-xs"
                    type="number"
                    min="0"
                    step="any"
                    placeholder={mode === 'fixed' ? 'distance' : 'min distance'}
                    value={distance}
                    onChange={(e) => setDistance(e.target.value)}
                  />
                  <Pill
                    value={unit}
                    options={[
                      { value: 'pct', label: '%' },
                      { value: 'points', label: 'PTS' },
                    ]}
                    onChange={setUnit}
                  />
                </div>
                {mode === 'drawdown' && (
                  <>
                    <p className="text-[10px] leading-snug text-muted-foreground">
                      Trails by the drawdown depth the position carried, floored at the
                      distance above.
                    </p>
                    <div className="flex items-center justify-between">
                      <span className={labelClass}>Freeze extreme</span>
                      <OnOff on={freezeExtreme} onChange={setFreezeExtreme} />
                    </div>
                    {freezeExtreme && (
                      <Input
                        className="h-9 font-mono text-xs"
                        type="number"
                        min="0"
                        step="any"
                        placeholder="anchor price (default: current mark)"
                        value={reference}
                        onChange={(e) => setReference(e.target.value)}
                      />
                    )}
                  </>
                )}
              </>
            )}
          </div>

          {/* Break-even */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className={labelClass}>Break-even</span>
              <OnOff on={beOn} onChange={setBeOn} />
            </div>
            {beOn && (
              <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                <Input
                  className="h-9 font-mono text-xs"
                  type="number"
                  min="0"
                  step="any"
                  placeholder="fee buffer"
                  value={beFeePct}
                  onChange={(e) => setBeFeePct(e.target.value)}
                />
                <span className="font-mono text-[10px] text-muted-foreground">% off entry</span>
              </div>
            )}
          </div>

          {/* TP ladder (edge manager, derived/golden-spaced) */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className={labelClass}>TP ladder</span>
              <div className="flex items-center gap-2">
                {attachedTp && (
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {tpFiredCount(attachedTp.state)} fired
                  </span>
                )}
                <OnOff on={tpOn} onChange={setTpOn} />
              </div>
            </div>
            {tpOn && (
              <>
                <Input
                  className="h-9 font-mono text-xs"
                  type="number"
                  min="0"
                  step="any"
                  placeholder="target price"
                  value={tpTarget}
                  onChange={(e) => setTpTarget(e.target.value)}
                />
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <div className={labelClass}>Rungs</div>
                    <Input
                      className="h-9 font-mono text-xs"
                      type="number" min="1" max="6" step="1"
                      value={tpLevels}
                      onChange={(e) => setTpLevels(e.target.value)}
                    />
                  </div>
                  <div>
                    <div className={labelClass}>Tranche %</div>
                    <Input
                      className="h-9 font-mono text-xs"
                      type="number" min="0" max="100" step="any"
                      value={tpTranchePct}
                      onChange={(e) => setTpTranchePct(e.target.value)}
                    />
                  </div>
                  <div>
                    <div className={labelClass}>Runner %</div>
                    <Input
                      className="h-9 font-mono text-xs"
                      type="number" min="0" max="100" step="any"
                      value={tpRunnerPct}
                      onChange={(e) => setTpRunnerPct(e.target.value)}
                    />
                  </div>
                </div>
                <p className="text-[10px] leading-snug text-muted-foreground">
                  Golden-fib rungs from entry toward the target; each skims the
                  tranche off the position. Changing params re-arms the ladder.
                </p>
              </>
            )}
          </div>

          {/* Risk guard (edge manager, always last in composition) */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className={labelClass}>Risk guard</span>
              <OnOff on={guardOn} onChange={setGuardOn} />
            </div>
            {guardOn && (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <div className={labelClass}>Max-loss stop</div>
                    <Input
                      className="h-9 font-mono text-xs"
                      type="number" min="0" step="any"
                      placeholder="hard close price"
                      value={guardStop}
                      onChange={(e) => setGuardStop(e.target.value)}
                    />
                  </div>
                  <div>
                    <div className={labelClass}>Max size</div>
                    <Input
                      className="h-9 font-mono text-xs"
                      type="number" min="0" step="any"
                      placeholder="optional"
                      value={guardMaxSize}
                      onChange={(e) => setGuardMaxSize(e.target.value)}
                    />
                  </div>
                </div>
                <p className="text-[10px] leading-snug text-muted-foreground">
                  Crossing the max-loss level closes the whole position at market,
                  a lock independent of the resting stop order.
                </p>
              </>
            )}
          </div>

          {/* Group risk guard (edge manager, group scope) — shown when the
              position sits in a group or already carries the guard. */}
          {(target.group || attachedGroupGuard) && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className={labelClass}>Group guard</span>
                <div className="flex items-center gap-2">
                  {attachedGroupGuard && (
                    <span className="font-mono text-[10px] text-[var(--kb-teal)]">attached</span>
                  )}
                  <OnOff on={grpOn} onChange={setGrpOn} />
                </div>
              </div>
              {grpOn && (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <div className={labelClass}>Max group loss</div>
                      <Input
                        className="h-9 font-mono text-xs"
                        type="number" min="0" max="100" step="any"
                        placeholder="% of equity"
                        value={grpLossPct}
                        onChange={(e) => setGrpLossPct(e.target.value)}
                      />
                    </div>
                    <div>
                      <div className={labelClass}>Max group notional</div>
                      <Input
                        className="h-9 font-mono text-xs"
                        type="number" min="0" step="any"
                        placeholder="optional $"
                        value={grpNotional}
                        onChange={(e) => setGrpNotional(e.target.value)}
                      />
                    </div>
                  </div>
                  <p className="text-[10px] leading-snug text-muted-foreground">
                    Watches {target.group ? `the ${target.group.name} group's` : "the group's"}{' '}
                    aggregate and closes this position on breach. At least one
                    threshold. Managed at group level, the group's Protect
                    action attaches it on every member.
                  </p>
                </>
              )}
            </div>
          )}

          {/* Hedge guard (edge hedge: opposite leg on the paired instrument,
              opened on an adverse trigger breach; own one-shot lifecycle) */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className={labelClass}>Hedge</span>
              <div className="flex items-center gap-2">
                {hedgeView && (
                  <span
                    className={`font-mono text-[10px] uppercase ${
                      hedgeLive
                        ? 'text-[var(--kb-amber)]'
                        : hedgeArmed
                          ? 'text-[var(--kb-teal)]'
                          : 'text-muted-foreground'
                    }`}
                  >
                    {hedgeView.status}
                  </span>
                )}
                <OnOff on={hedgeOpen} onChange={setHedgeOpen} />
              </div>
            </div>
            {hedgeOpen && (
              <>
                {hedgeLive && (
                  <div className="rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-[11px] tabular-nums">
                    {hedgeView!.hedgeSide} {fmtPx(hedgeView!.hedgeQty)} {hedgeView!.hedgeSymbol} @{' '}
                    {fmtPx(hedgeView!.hedgeEntryPrice)}
                  </div>
                )}
                {hedgeView?.lastError && (
                  <p className="text-[10px] leading-snug text-[var(--kb-red)]">
                    {hedgeView.lastError}
                  </p>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <div className={labelClass}>Trigger price</div>
                    <Input
                      className="h-9 font-mono text-xs"
                      type="number" min="0" step="any"
                      placeholder={target.side === 'long' ? 'below mark' : 'above mark'}
                      value={hedgeTrigger}
                      disabled={hedgeLive}
                      onChange={(e) => setHedgeTrigger(e.target.value)}
                    />
                  </div>
                  <div>
                    <div className={labelClass}>Hedge instrument</div>
                    <Input
                      className="h-9 font-mono text-xs"
                      type="text"
                      placeholder="paired instrument"
                      value={hedgeSymbol}
                      disabled={hedgeLive}
                      onChange={(e) => setHedgeSymbol(e.target.value)}
                    />
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className={labelClass}>Size</span>
                  <div className="flex items-center gap-2">
                    {hedgeSizeMode === 'fixed-usd' && (
                      <Input
                        className="h-7 w-24 font-mono text-xs"
                        type="number" min="0" step="any"
                        placeholder="$ notional"
                        value={hedgeFixedUsd}
                        disabled={hedgeLive}
                        onChange={(e) => setHedgeFixedUsd(e.target.value)}
                      />
                    )}
                    <Pill
                      value={hedgeSizeMode}
                      options={[
                        { value: 'match', label: 'Match' },
                        { value: 'fixed-usd', label: 'Fixed $' },
                      ]}
                      onChange={(v) => !hedgeLive && setHedgeSizeMode(v)}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <div className={labelClass}>Recovery close</div>
                    <Input
                      className="h-9 font-mono text-xs"
                      type="number" min="0" step="any"
                      placeholder="optional price"
                      value={hedgeRecovery}
                      onChange={(e) => setHedgeRecovery(e.target.value)}
                    />
                  </div>
                  <div>
                    <div className={labelClass}>If position closes</div>
                    <div className="pt-1.5">
                      <Pill
                        value={hedgeOnMainClose}
                        options={[
                          { value: 'keep', label: 'Keep' },
                          { value: 'close', label: 'Close' },
                        ]}
                        onChange={setHedgeOnMainClose}
                      />
                    </div>
                  </div>
                </div>
                <p className="text-[10px] leading-snug text-muted-foreground">
                  Crossing the trigger opens the opposite side on the hedge
                  instrument and groups it with this position. A same-symbol
                  hedge would just net the position down, so the leg lives on
                  the paired contract. Fires once; re-arm by hand.
                </p>
                <div className="flex items-center justify-end gap-2">
                  {hedgeArmed && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => hedgeAct('disarm')}
                    >
                      Disarm
                    </Button>
                  )}
                  {hedgeLive && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="border-[var(--kb-red)]/40 text-[var(--kb-red)] hover:text-[var(--kb-red)]"
                      disabled={busy}
                      onClick={() => hedgeAct('close')}
                    >
                      Close hedge
                    </Button>
                  )}
                  <Button
                    size="sm"
                    disabled={busy || (!hedgeArmed && !hedgeLive && !((num(hedgeTrigger) ?? 0) > 0))}
                    onClick={() => hedgeAct(hedgeArmed || hedgeLive ? 'update' : 'arm')}
                  >
                    {hedgeArmed || hedgeLive ? 'Update hedge' : 'Arm hedge'}
                  </Button>
                </div>
              </>
            )}
          </div>

          {/* Stop floor on a bot position: set directly, no take-over */}
          {botManaged && (
            <div className="space-y-2 rounded-md border border-[var(--kb-amber)]/30 px-3 py-2">
              <div className="flex items-center justify-between">
                <span className={labelClass}>Stop floor</span>
                <button
                  type="button"
                  onClick={() => setFloorLocked((v) => !v)}
                  className={`flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase transition-colors ${
                    floorLocked
                      ? 'border-[var(--kb-amber)]/50 bg-[var(--kb-amber)]/15 text-[var(--kb-amber)]'
                      : 'border-border text-muted-foreground hover:text-foreground'
                  }`}
                  title="Locked: the floor is the stop. Bot stop moves are recorded, not placed"
                >
                  <Lock className="size-3" />
                  {floorLocked ? 'Locked' : 'Lock'}
                </button>
              </div>
              <Input
                className="h-9 font-mono text-xs"
                type="number"
                min="0"
                step="any"
                placeholder={target.side === 'long' ? 'below mark' : 'above mark'}
                value={floorStop}
                onChange={(e) => setFloorStop(e.target.value)}
              />
              <p className="text-[10px] leading-snug text-muted-foreground">
                The bot keeps closing and trailing. Its stop never drops below the floor.
              </p>
              <div className="flex items-center gap-2">
                {floorView?.manualStop != null && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-[var(--kb-red)]/40 text-[var(--kb-red)] hover:text-[var(--kb-red)]"
                    disabled={busy}
                    onClick={removeFloor}
                  >
                    Remove floor
                  </Button>
                )}
                <Button size="sm" className="ml-auto" disabled={!canApplyFloor} onClick={applyFloor}>
                  {busy ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : floorView?.manualStop != null ? (
                    'Move floor'
                  ) : (
                    'Set floor'
                  )}
                </Button>
              </div>
            </div>
          )}

          {/* Manual stop + lock */}
          {!botManaged && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className={labelClass}>Manual stop</span>
              <button
                type="button"
                onClick={() => setLocked((v) => !v)}
                className={`flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase transition-colors ${
                  locked
                    ? 'border-[var(--kb-amber)]/50 bg-[var(--kb-amber)]/15 text-[var(--kb-amber)]'
                    : 'border-border text-muted-foreground hover:text-foreground'
                }`}
                title="Locked: your stop is absolute, the engine stops trailing"
              >
                <Lock className="size-3" />
                {locked ? 'Locked' : 'Lock'}
              </button>
            </div>
            <Input
              className="h-9 font-mono text-xs"
              type="number"
              min="0"
              step="any"
              placeholder="optional, always participates"
              value={manualStop}
              onChange={(e) => setManualStop(e.target.value)}
            />
            <p className="text-[10px] leading-snug text-muted-foreground">
              Your stop always counts; the engine only tightens it. Locked, it is
              absolute.
            </p>
          </div>
          )}

          <div className="flex items-center gap-2">
            {view?.active && (
              <Button
                variant="outline"
                size="sm"
                className="border-[var(--kb-red)]/40 text-[var(--kb-red)] hover:text-[var(--kb-red)]"
                disabled={busy}
                onClick={remove}
              >
                Remove
              </Button>
            )}
            <div className="ml-auto flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={busy} onClick={() => onOpenChange(false)}>
                {isTakeOver ? 'Stay manual' : 'Cancel'}
              </Button>
              <Button size="sm" disabled={!canApply} onClick={apply}>
                {busy ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : isTakeOver ? (
                  'Attach'
                ) : view?.active ? (
                  'Update'
                ) : (
                  'Arm'
                )}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

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

const labelClass = 'font-mono text-[10px] uppercase tracking-wider text-muted-foreground';

const num = (s: string): number | undefined => {
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : undefined;
};

const fmtPx = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString(undefined, { maximumFractionDigits: 8 });

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
  onOpenChange,
  onChanged,
}: {
  target: ManagePositionTarget;
  // The position's active trail, if the caller already has it (list poll).
  trail?: ManagedTrailView | null;
  onOpenChange: (open: boolean) => void;
  onChanged?: () => void;
}) {
  const [view, setView] = useState<ManagedTrailView | null>(existing ?? null);
  const [busy, setBusy] = useState(false);

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
    (num(manualStop) ?? 0) > 0;
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
        const result = await positionManageApi.manage({
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
          manualStop: num(manualStop),
          trailingLock: locked,
        });
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
          <div className="grid grid-cols-3 gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-[11px] tabular-nums">
            <div>
              <div className={labelClass}>Effective stop</div>
              <div className="text-foreground">
                {fmtPx(view?.effectiveStop)}
                {view?.trailingLock && <Lock className="ml-1 inline size-3 text-[var(--kb-amber)]" />}
              </div>
            </div>
            <div>
              <div className={labelClass}>Resting</div>
              <div className="text-muted-foreground">{fmtPx(view?.currentStop)}</div>
            </div>
            <div>
              <div className={labelClass}>Engine</div>
              <div className="text-muted-foreground">{fmtPx(view?.engineStop)}</div>
            </div>
          </div>

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

          {/* Manual stop + lock */}
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

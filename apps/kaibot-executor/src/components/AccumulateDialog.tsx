import { useEffect, useState } from 'react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
} from '@kaibot/shared';
import { Loader2 } from '@/lib/icons';
import { toast } from 'sonner';
import { rideApi, type RideBot } from '@/lib/manual-trade-api';
import {
  accumulateApi,
  DEFAULT_ACCUMULATE_PARAMS,
  type AccumulateParams,
  type AccumulatePreview,
} from '@/lib/accumulate-api';

const labelClass = 'font-mono text-[10px] uppercase tracking-wider text-muted-foreground';

export const fmtNum = (n: number | null | undefined, digits = 2) =>
  n == null ? '—' : n.toLocaleString('nl-BE', { maximumFractionDigits: digits });

export interface AccumulateTarget {
  exchange: string;
  symbol: string;
  accountId: string;
  side: 'long' | 'short';
  entryPrice: number;
}

type NumericKey = Exclude<keyof AccumulateParams, 'reanchorOnBreakout'>;

const FIELDS: Array<{ key: NumericKey; label: string; hint?: string }> = [
  { key: 'lookbackBars', label: 'Local high lookback', hint: 'bars before the entry' },
  { key: 'barMinutes', label: 'Bar (minutes)' },
  { key: 'rungCount', label: 'Rungs' },
  { key: 'rungStepPct', label: 'Rung step %' },
  { key: 'rungPct', label: 'Rung size % of basis' },
  { key: 'startPct', label: 'Re-entry size % of basis' },
  { key: 'rideStopExtraSteps', label: 'Ride stop', hint: 'steps past the last rung' },
];

export function AccumulateDialog({
  target,
  onOpenChange,
  onDone,
}: {
  target: AccumulateTarget;
  onOpenChange: (open: boolean) => void;
  onDone?: () => void;
}) {
  const [bots, setBots] = useState<RideBot[] | null>(null);
  const [botsError, setBotsError] = useState<string | null>(null);
  const [botId, setBotId] = useState('');
  const [values, setValues] = useState<Record<NumericKey, string>>(
    () =>
      Object.fromEntries(FIELDS.map((f) => [f.key, String(DEFAULT_ACCUMULATE_PARAMS[f.key])])) as Record<
        NumericKey,
        string
      >,
  );
  const [reanchor, setReanchor] = useState(true);
  const [startTouched, setStartTouched] = useState(false);
  const [preview, setPreview] = useState<AccumulatePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    rideApi
      .bots()
      .then((r) => {
        if (cancelled) return;
        setBots(r.bots);
        if (r.bots.length > 0) setBotId(r.bots[0]!.id);
      })
      .catch((e: Error) => {
        if (!cancelled) setBotsError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const params = (): Partial<AccumulateParams> => {
    const out: Partial<AccumulateParams> = { reanchorOnBreakout: reanchor };
    for (const f of FIELDS) {
      const n = parseFloat(values[f.key].replace(',', '.'));
      if (Number.isFinite(n)) out[f.key] = n;
    }
    return out;
  };
  const input = () => ({
    exchange: target.exchange,
    symbol: target.symbol,
    accountId: target.accountId,
    rideBotId: botId,
    params: params(),
  });

  const runPreview = async () => {
    setPreviewing(true);
    try {
      const p = await accumulateApi.preview(input());
      setPreview(p);
      // The current position's share of the basis is the natural re-entry size.
      if (!startTouched && p.positionPctOfBasis != null && p.positionPctOfBasis > 0) {
        setValues((v) => ({ ...v, startPct: String(Math.round(p.positionPctOfBasis!)) }));
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Preview failed');
    } finally {
      setPreviewing(false);
    }
  };

  useEffect(() => {
    void runPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async () => {
    if (!botId) return;
    setBusy(true);
    try {
      const r = await accumulateApi.create(input());
      toast.success(`${target.symbol}: plan armed (${r.plan.rungs.open} rungs resting)`);
      onDone?.();
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not arm the plan');
    } finally {
      setBusy(false);
    }
  };

  const adopting = preview?.adoptableRungs.length ?? 0;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">
            Accumulate & ride {target.symbol}
            <span
              className={`ml-2 text-[10px] uppercase ${
                target.side === 'long' ? 'text-[var(--kb-green)]' : 'text-[var(--kb-red)]'
              }`}
            >
              {target.side}
            </span>
          </DialogTitle>
          <DialogDescription className="font-mono text-[11px] tabular-nums">
            Entry {fmtNum(target.entryPrice)} · {target.exchange} · {target.accountId}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <p className="text-[11px] leading-snug text-muted-foreground">
            Rungs rest below the reference with no stop of their own. Once a bar closes above the
            local high, the ride bot takes the whole position and the ladder moves up to the
            breakout. When the ride exits, the next breakout buys back in at the re-entry size.
          </p>

          <div className="space-y-1">
            <div className={labelClass}>Ride bot</div>
            {botsError ? (
              <p className="text-[11px] text-[var(--kb-red)]">{botsError}</p>
            ) : bots == null ? (
              <p className="text-[11px] text-muted-foreground">Loading your ride bots…</p>
            ) : bots.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                No ride-only bots yet. Create one in Studio from the "Ride: TF ladder" strategy and
                start it.
              </p>
            ) : (
              <select
                className="h-8 w-full rounded-md border border-border bg-background px-2 font-mono text-xs"
                value={botId}
                onChange={(e) => setBotId(e.target.value)}
              >
                {bots.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name} · {b.timeframe} → {b.ladderMinutes.map((m) => `${m}m`).join(' / ')}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            {FIELDS.map((f) => (
              <div key={f.key} className="space-y-1">
                <div className={labelClass}>{f.label}</div>
                <Input
                  className="h-8 font-mono text-xs"
                  inputMode="decimal"
                  value={values[f.key]}
                  onChange={(e) => {
                    if (f.key === 'startPct') setStartTouched(true);
                    setValues((v) => ({ ...v, [f.key]: e.target.value }));
                  }}
                />
                {f.hint && <p className="text-[10px] text-muted-foreground">{f.hint}</p>}
              </div>
            ))}
            <label className="col-span-2 flex items-center gap-2 text-[11px]">
              <input type="checkbox" checked={reanchor} onChange={(e) => setReanchor(e.target.checked)} />
              Move the ladder up on each new breakout while riding
            </label>
          </div>

          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-[11px] tabular-nums">
            <div className="flex items-center justify-between">
              <span className={labelClass}>Preview</span>
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-[10px]"
                disabled={previewing}
                onClick={() => void runPreview()}
              >
                {previewing && <Loader2 className="mr-1 size-3 animate-spin" />}
                Refresh
              </Button>
            </div>
            {preview ? (
              <div className="space-y-2 pt-1">
                <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                  <div>
                    <div className={labelClass}>Basis</div>
                    <div>${fmtNum(preview.basisUsd, 0)}</div>
                  </div>
                  <div>
                    <div className={labelClass}>Local high</div>
                    <div>{fmtNum(preview.localLevel)}</div>
                  </div>
                  <div>
                    <div className={labelClass}>Reference</div>
                    <div>{fmtNum(preview.reference)}</div>
                  </div>
                  <div>
                    <div className={labelClass}>Ride stop</div>
                    <div>{fmtNum(preview.rideStop)}</div>
                  </div>
                  {preview.floor && (
                    <div className="col-span-2">
                      <div className={labelClass}>Floor (armed synthetic)</div>
                      <div>
                        {preview.floor.triggerPrice != null
                          ? `triggers at ${fmtNum(preview.floor.triggerPrice)}`
                          : preview.floor.status}
                        {preview.floor.holdingsCoin != null ? ` · ${fmtNum(preview.floor.holdingsCoin, 8)} coin` : ''}
                      </div>
                    </div>
                  )}
                </div>
                {adopting > 0 ? (
                  <p className="text-muted-foreground">
                    Adopts the {adopting} rungs already resting. They are replaced at the breakout.
                  </p>
                ) : (
                  <div>
                    <div className={labelClass}>Rungs to place</div>
                    <div className="grid grid-cols-2 gap-x-3">
                      {preview.ladder.map((r) => (
                        <div key={r.idx}>
                          {fmtNum(r.price)} × {fmtNum(r.qty, 4)}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {preview.activeRide && (
                  <p className="text-muted-foreground">
                    Already riding with {preview.activeRide.botName ?? 'a ride bot'}: the plan joins that ride.
                  </p>
                )}
                {!preview.position && !preview.activeRide && (
                  <p className="text-[var(--kb-amber)]">
                    No open position: the plan waits for a breakout and then enters at the re-entry size.
                  </p>
                )}
              </div>
            ) : (
              <p className="pt-1 text-muted-foreground">Loading…</p>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" disabled={!botId || busy || !preview} onClick={() => void submit()}>
              {busy && <Loader2 className="mr-1 size-3 animate-spin" />}
              Arm plan
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

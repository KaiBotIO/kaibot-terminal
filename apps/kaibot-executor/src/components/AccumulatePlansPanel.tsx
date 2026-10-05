import { useState } from 'react';
import { Badge, Button } from '@kaibot/shared';
import { Loader2 } from '@/lib/icons';
import { toast } from 'sonner';
import { usePolledResource } from '@/hooks/usePolledResource';
import { accumulateApi, PHASE_LABEL, type AccumulatePlan } from '@/lib/accumulate-api';
import { fmtNum } from './AccumulateDialog';

const labelClass = 'font-mono text-[10px] uppercase tracking-wider text-muted-foreground';

const PHASE_TONE: Record<AccumulatePlan['phase'], string> = {
  ladder: 'border-[var(--kb-amber)]/40 text-[var(--kb-amber)]',
  riding: 'border-[var(--kb-teal)]/40 text-[var(--kb-teal)]',
  waiting: 'border-border text-muted-foreground',
  stopped: 'border-border text-muted-foreground',
};

function fmtTime(ms: number) {
  return new Date(ms).toLocaleString('nl-BE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// Armed accumulate plans with their live state. Hidden while there are none.
export function AccumulatePlansPanel({ readOnly, refreshKey }: { readOnly: boolean; refreshKey?: number }) {
  const { data, refresh } = usePolledResource(() => accumulateApi.list(), { intervalMs: 10_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [lastKey, setLastKey] = useState(refreshKey);
  if (refreshKey !== lastKey) {
    setLastKey(refreshKey);
    void refresh();
  }
  const plans = data?.plans ?? [];
  if (plans.length === 0) return null;

  const act = async (plan: AccumulatePlan, kind: 'stop' | 'check') => {
    setBusy(`${plan.id}:${kind}`);
    try {
      if (kind === 'stop') {
        await accumulateApi.stop(plan.id);
        toast.success(`${plan.symbol}: plan stopped, rungs cancelled`);
      } else {
        const r = await accumulateApi.check(plan.id);
        toast.message(`${plan.symbol}: ${r.plan.lastNote ?? PHASE_LABEL[r.plan.phase]}`);
      }
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-4 my-3 rounded-md border border-border">
      <div className="border-b border-border px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
        Accumulate & ride
      </div>
      <div className="divide-y divide-border">
        {plans.map((p) => (
          <div key={p.id} className="grid gap-3 px-3 py-2 font-mono text-[11px] tabular-nums md:grid-cols-[1.2fr_repeat(5,1fr)_auto]">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs">{p.symbol}</span>
                <Badge variant="outline" className={`text-[9px] ${PHASE_TONE[p.phase]}`}>
                  {PHASE_LABEL[p.phase]}
                </Badge>
              </div>
              <div className="text-muted-foreground">
                {p.exchange} · {p.accountId} · {p.direction}
              </div>
            </div>
            <div>
              <div className={labelClass}>Reference</div>
              <div>{fmtNum(p.reference)}</div>
            </div>
            <div>
              <div className={labelClass}>{p.direction === 'long' ? 'Breakout above' : 'Breakout below'}</div>
              <div>{fmtNum(p.watchLevel)}</div>
            </div>
            <div>
              <div className={labelClass}>Rungs</div>
              <div>
                {p.rungs.open} open · {p.rungs.filled} filled
              </div>
              {p.basisUsd != null && <div className="text-muted-foreground">basis ${fmtNum(p.basisUsd, 0)}</div>}
            </div>
            <div>
              <div className={labelClass}>Ride</div>
              {p.ride ? (
                <div>
                  {p.ride.botName ?? 'ride bot'}
                  <div className="text-muted-foreground">stop {fmtNum(p.ride.currentStop)}</div>
                </div>
              ) : (
                <div className="text-muted-foreground">—</div>
              )}
            </div>
            <div>
              <div className={labelClass}>Floor</div>
              {p.floor ? (
                <div>
                  {p.floor.triggerPrice != null ? fmtNum(p.floor.triggerPrice) : p.floor.status}
                  {p.floor.shortSize > 0 && <div className="text-[var(--kb-amber)]">hedged</div>}
                </div>
              ) : (
                <div className="text-muted-foreground">none</div>
              )}
            </div>
            <div className="flex items-start gap-1">
              {!readOnly && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-[10px]"
                    disabled={busy != null}
                    title="Evaluate the last closed bar now"
                    onClick={() => void act(p, 'check')}
                  >
                    {busy === `${p.id}:check` && <Loader2 className="mr-1 size-3 animate-spin" />}
                    Check
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-[10px] border-[var(--kb-red)]/40 text-[var(--kb-red)] hover:text-[var(--kb-red)]"
                    disabled={busy != null}
                    title="Cancel the rungs and leave the position as it is"
                    onClick={() => void act(p, 'stop')}
                  >
                    {busy === `${p.id}:stop` && <Loader2 className="mr-1 size-3 animate-spin" />}
                    Stop
                  </Button>
                </>
              )}
            </div>
            <div className="text-muted-foreground md:col-span-7">
              {p.lastError ? (
                <span className="text-[var(--kb-red)]">{p.lastError}</span>
              ) : (
                p.lastNote
              )}
              {p.lastBreakout && (
                <span>
                  {' '}
                  · last breakout {fmtTime(p.lastBreakout.barTime)} close {fmtNum(p.lastBreakout.close)} over{' '}
                  {fmtNum(p.lastBreakout.level)}
                </span>
              )}
              {p.pending && <span className="text-[var(--kb-amber)]"> · last step unfinished, retried every minute</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

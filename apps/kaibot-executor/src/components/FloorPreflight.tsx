import { usePolledResource } from '@/hooks/usePolledResource';
import { syntheticUsdApi, type ArmedPreflight } from '@/lib/synthetic-usd-api';

const usd = (n: number) => `$${Math.round(n).toLocaleString('nl-BE')}`;

function describe(p: ArmedPreflight): { tone: 'ok' | 'bad' | 'muted'; text: string } {
  if (p.status === 'open') {
    const paused = /pause/.test(p.reason ?? '');
    const covered = p.coveredManualUsd > 0 ? ` incl. manual long ${usd(p.coveredManualUsd)}` : '';
    return paused
      ? { tone: 'bad', text: `Fired${covered}. Unwind on hold: ${p.reason}` }
      : { tone: 'muted', text: `Fired${covered}. Short open until recovery.` };
  }
  if (!p.canFire) return { tone: 'bad', text: `Can't fire: ${p.reason ?? 'unknown'}` };
  const parts = [
    p.coveredManualUsd > 0 ? `Armed, covers coins + manual long ${usd(p.coveredManualUsd)}` : 'Armed, covers the coins',
  ];
  if (p.rungsToCancel.length > 0) {
    parts.push(`cancels ${p.rungsToCancel.length} entry rung${p.rungsToCancel.length === 1 ? '' : 's'} on fire`);
  }
  if (p.accumulatePlanId) parts.push('stops the accumulate plan');
  if (p.capped) parts.push('mint capped by the leverage cap');
  return { tone: 'ok', text: parts.join(' · ') };
}

const TONE = {
  ok: 'text-[var(--kb-green)]',
  bad: 'text-[var(--kb-red)]',
  muted: 'text-muted-foreground',
};

export function FloorPreflightLine({ id, prefix }: { id: string; prefix?: string }) {
  const { data, error } = usePolledResource(() => syntheticUsdApi.preflight(id), { intervalMs: 30_000 });
  if (error) return <p className="font-mono text-[11px] text-[var(--kb-red)]">Floor check failed: {error.message}</p>;
  if (!data) return null;
  const { tone, text } = describe(data);
  return (
    <p className={`font-mono text-[11px] ${TONE[tone]}`}>
      {prefix && <span className="text-muted-foreground">{prefix} </span>}
      {text}
    </p>
  );
}

// One line per floor in an arm cycle. Hidden while there are none.
export function FloorPreflightStrip() {
  const { data } = usePolledResource(() => syntheticUsdApi.list(), { intervalMs: 60_000 });
  const rows = (data?.positions ?? []).filter((p) => p.armed.inCycle);
  if (rows.length === 0) return null;
  return (
    <div className="mx-4 my-3 rounded-md border border-border">
      <div className="border-b border-border px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
        Synthetic floors
      </div>
      <div className="divide-y divide-border">
        {rows.map((p) => (
          <div key={p.id} className="px-3 py-2">
            <FloorPreflightLine
              id={p.id}
              prefix={`${p.symbol} · ${p.exchange}${p.accountKey ? ` · ${p.accountKey}` : ''}`}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

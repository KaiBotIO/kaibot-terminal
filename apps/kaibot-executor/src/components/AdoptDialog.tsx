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
import { adoptApi, type AdoptCandidate } from '@/lib/manual-trade-api';

const labelClass = 'font-mono text-[10px] uppercase tracking-wider text-muted-foreground';

const num = (s: string): number | undefined => {
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : undefined;
};

const fmtPx = (n: number | null | undefined) =>
  n == null ? '-' : n.toLocaleString(undefined, { maximumFractionDigits: 8 });

const fmtWhen = (iso: string) => {
  const d = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : `${iso.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};

export interface AdoptTarget {
  exchange: string;
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  markPrice?: number;
  accountId?: string;
}

// Give an open manual position to the bot whose entry this executor refused
// or missed. The bot's close and stop updates then apply to it.
export function AdoptDialog({
  target,
  onOpenChange,
  onDone,
}: {
  target: AdoptTarget;
  onOpenChange: (open: boolean) => void;
  onDone?: () => void;
}) {
  const [candidates, setCandidates] = useState<AdoptCandidate[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [signalId, setSignalId] = useState('');
  const [stop, setStop] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    adoptApi
      .candidates({
        exchange: target.exchange,
        symbol: target.symbol,
        accountId: target.accountId,
        side: target.side,
      })
      .then((r) => {
        if (cancelled) return;
        setCandidates(r.candidates);
        if (r.candidates.length > 0) setSignalId(r.candidates[0]!.signalId);
      })
      .catch((e: Error) => {
        if (!cancelled) setLoadError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [target.exchange, target.symbol, target.accountId, target.side]);

  const picked = candidates?.find((c) => c.signalId === signalId) ?? null;
  const mark = target.markPrice ?? target.entryPrice;
  const signalStopCrossed =
    picked?.stopLoss != null &&
    (target.side === 'long' ? picked.stopLoss >= mark : picked.stopLoss <= mark);
  const stopNum = num(stop);
  const stopOk =
    stopNum == null
      ? picked?.stopLoss != null && !signalStopCrossed
      : target.side === 'long'
        ? stopNum < mark
        : stopNum > mark;
  const canSubmit = !!picked && stopOk && !busy;

  const submit = async () => {
    if (!picked || !canSubmit) return;
    setBusy(true);
    try {
      const r = await adoptApi.adopt({
        exchange: target.exchange,
        symbol: target.symbol,
        accountId: target.accountId,
        signalId: picked.signalId,
        stopPrice: stopNum,
      });
      const stopNote =
        r.stop.source === 'placed'
          ? ` · stop placed at ${fmtPx(r.stop.price)}`
          : r.stop.source === 'manual'
            ? ` · your resting stop kept`
            : '';
      toast.success(
        `${target.symbol} now belongs to ${r.botName ?? r.botId}${stopNote}` +
          (r.serverAck && !r.serverAck.ok ? ' · server not told yet, retry later' : ''),
      );
      onDone?.();
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Adoption failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-sm overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">
            Adopt {target.symbol} into bot
            <span
              className={`ml-2 text-[10px] uppercase ${
                target.side === 'long' ? 'text-[var(--kb-green)]' : 'text-[var(--kb-red)]'
              }`}
            >
              {target.side}
            </span>
          </DialogTitle>
          <DialogDescription className="font-mono text-[11px] tabular-nums">
            Entry {fmtPx(target.entryPrice)} · Mark {fmtPx(target.markPrice)} · {target.exchange}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <p className="text-[11px] leading-snug text-muted-foreground">
            The bot's close and stop updates apply to this position as if the bot had opened it.
            Nothing is bought or sold. One reduce-only stop stays at the venue: yours if one rests,
            else the signal's.
          </p>

          <div className="space-y-1">
            <div className={labelClass}>Refused entry</div>
            {loadError ? (
              <p className="text-[11px] text-[var(--kb-red)]">{loadError}</p>
            ) : candidates == null ? (
              <p className="text-[11px] text-muted-foreground">Looking for refused entries…</p>
            ) : candidates.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                No active bot refused a {target.side} entry on this market in the last 30 days.
              </p>
            ) : (
              <select
                className="h-8 w-full rounded-md border border-border bg-background px-2 font-mono text-xs"
                value={signalId}
                onChange={(e) => setSignalId(e.target.value)}
              >
                {candidates.map((c) => (
                  <option key={c.signalId} value={c.signalId}>
                    {c.botName ?? c.strategyName ?? c.botId} · {fmtWhen(c.receivedAt)} · @{fmtPx(c.price)}
                  </option>
                ))}
              </select>
            )}
            {picked?.reason && (
              <p className="text-[10px] text-muted-foreground">Refused: {picked.reason}</p>
            )}
          </div>

          <div className="space-y-1">
            <div className={labelClass}>Stop</div>
            <Input
              className="h-8 font-mono text-xs"
              inputMode="decimal"
              placeholder={picked?.stopLoss != null ? `signal stop ${fmtPx(picked.stopLoss)}` : 'required'}
              value={stop}
              onChange={(e) => setStop(e.target.value)}
            />
            {stopNum == null && signalStopCrossed && (
              <p className="text-[10px] text-[var(--kb-red)]">
                The signal's stop {fmtPx(picked!.stopLoss)} is past the mark. Enter one.
              </p>
            )}
            {stopNum != null && !stopOk && (
              <p className="text-[10px] text-[var(--kb-red)]">Stop must sit on the losing side of the mark.</p>
            )}
            <p className="text-[10px] text-muted-foreground">
              Ignored when a stop already rests on this position.
            </p>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" disabled={!canSubmit} onClick={() => void submit()}>
              {busy && <Loader2 className="mr-1 size-3 animate-spin" />}
              Adopt
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

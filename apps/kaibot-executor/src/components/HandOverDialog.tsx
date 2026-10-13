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
import { Loader2 } from '@/lib/icons';
import { toast } from 'sonner';
import {
  rideApi,
  type HandOverPreview,
  type RideBot,
} from '@/lib/manual-trade-api';

const labelClass = 'font-mono text-[10px] uppercase tracking-wider text-muted-foreground';

const num = (s: string): number | undefined => {
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : undefined;
};

const fmtPx = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString(undefined, { maximumFractionDigits: 8 });

export interface HandOverTarget {
  exchange: string;
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  markPrice?: number;
  accountId?: string;
}

// Hand an open position to one of the user's ride-only bots. The server
// then rides it with the timeframe ladder and sends the exit back as a
// signal; the resting venue stop stays the backstop.
export function HandOverDialog({
  target,
  onOpenChange,
  onDone,
}: {
  target: HandOverTarget;
  onOpenChange: (open: boolean) => void;
  onDone?: () => void;
}) {
  const [bots, setBots] = useState<RideBot[] | null>(null);
  const [botsError, setBotsError] = useState<string | null>(null);
  const [botId, setBotId] = useState('');
  const [stop, setStop] = useState('');
  const [anchor, setAnchor] = useState(String(target.entryPrice));
  const [ladderFrom, setLadderFrom] = useState<'entry' | 'now'>('entry');
  // Data market the ride evaluates on ("exchange:SYMBOL"); prefilled from the
  // preview (the venue's canonical market) or the bot's declared market.
  const [market, setMarket] = useState('');
  const [openedAt, setOpenedAt] = useState('');
  const [preview, setPreview] = useState<HandOverPreview | null>(null);
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

  const bot = bots?.find((b) => b.id === botId) ?? null;

  const parsedMarket = () => {
    const i = market.indexOf(':');
    if (i <= 0) return {};
    return { marketExchange: market.slice(0, i), canonicalSymbol: market.slice(i + 1) };
  };
  const toLocalInput = (iso: string) => {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const input = () => ({
    exchange: target.exchange,
    symbol: target.symbol,
    accountId: target.accountId,
    botId,
    botName: bot?.name,
    ...parsedMarket(),
    ...(openedAt && !Number.isNaN(Date.parse(openedAt)) ? { openedAt: new Date(openedAt).toISOString() } : {}),
    stopPrice: num(stop),
    anchor: num(anchor),
    ladderFrom,
  });

  const runPreview = async () => {
    if (!botId) return;
    setPreviewing(true);
    try {
      const p = await rideApi.preview(input());
      setPreview(p);
      if (p.stopPrice != null && !stop) setStop(String(p.stopPrice));
      if (!market) {
        const declared = bot?.markets[0];
        setMarket(declared ?? `${p.marketExchange}:${p.canonicalSymbol}`);
      }
      if (!openedAt) setOpenedAt(toLocalInput(p.openedAt));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Preview failed');
    } finally {
      setPreviewing(false);
    }
  };

  // First preview as soon as a bot is picked: shows the adoptable stop and
  // what the ladder would already have done.
  useEffect(() => {
    if (botId) void runPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId]);

  const stopNum = num(stop);
  const stopOnLosingSide =
    stopNum != null &&
    (target.side === 'long' ? stopNum < target.entryPrice : stopNum > target.entryPrice);
  const wouldExit = !!preview?.server?.exit && ladderFrom === 'entry';
  const canSubmit = !!botId && stopOnLosingSide && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      const r = await rideApi.handOver(input());
      toast.success(
        `${target.symbol} handed to ${bot?.name ?? 'the ride bot'} on ${r.timeframe}` +
          (r.stop.placed ? ` · stop placed at ${fmtPx(r.stop.price)}` : ''),
      );
      onDone?.();
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Hand-over failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-sm overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">
            Hand over {target.symbol}
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
            A ride bot takes over the exit: it promotes the ride to coarser timeframes and
            closes on its own rules. Your resting stop stays at the venue as the backstop.
            Take it back any time from the Positions list.
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
                onChange={(e) => {
                  setBotId(e.target.value);
                  setPreview(null);
                }}
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
            <div className="space-y-1">
              <div className={labelClass}>Stop (venue, resting)</div>
              <Input
                className="h-8 font-mono text-xs"
                inputMode="decimal"
                placeholder={preview?.adoptableStop ? 'adopting resting stop' : 'required'}
                value={stop}
                onChange={(e) => setStop(e.target.value)}
              />
              {preview?.adoptableStop && (
                <p className="text-[10px] text-muted-foreground">
                  Adopts resting order {preview.adoptableStop.slOrderId}
                </p>
              )}
              {stopNum != null && !stopOnLosingSide && (
                <p className="text-[10px] text-[var(--kb-red)]">Stop must sit on the losing side.</p>
              )}
            </div>
            <div className="space-y-1">
              <div className={labelClass}>Ladder anchor</div>
              <Input
                className="h-8 font-mono text-xs"
                inputMode="decimal"
                value={anchor}
                onChange={(e) => setAnchor(e.target.value)}
              />
              <p className="text-[10px] text-muted-foreground">Proof, ratchet and floor measure from here.</p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <div className={labelClass}>Data market</div>
              <Input
                className="h-8 font-mono text-xs"
                placeholder="exchange:SYMBOL"
                value={market}
                onChange={(e) => setMarket(e.target.value)}
              />
              <p className="text-[10px] text-muted-foreground">Candles the ladder reads.</p>
            </div>
            <div className="space-y-1">
              <div className={labelClass}>Opened at</div>
              <Input
                className="h-8 font-mono text-xs"
                type="datetime-local"
                value={openedAt}
                onChange={(e) => setOpenedAt(e.target.value)}
              />
              <p className="text-[10px] text-muted-foreground">Replay start for "from entry".</p>
            </div>
          </div>

          <div className="space-y-1">
            <div className={labelClass}>Ladder starts</div>
            <div className="flex overflow-hidden rounded border border-border text-[10px]">
              {(
                [
                  { v: 'entry', label: 'From entry (replay)' },
                  { v: 'now', label: 'From now' },
                ] as const
              ).map((o) => (
                <button
                  key={o.v}
                  type="button"
                  className={`flex-1 px-2 py-1 font-mono ${
                    ladderFrom === o.v ? 'bg-primary/15 text-foreground' : 'text-muted-foreground'
                  }`}
                  onClick={() => {
                    setLadderFrom(o.v);
                    setPreview(null);
                  }}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-[11px] tabular-nums">
            <div className="flex items-center justify-between">
              <span className={labelClass}>Preview</span>
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-[10px]"
                disabled={!botId || previewing}
                onClick={() => void runPreview()}
              >
                {previewing && <Loader2 className="mr-1 size-3 animate-spin" />}
                Refresh
              </Button>
            </div>
            {preview?.server?.error ? (
              <p className="pt-1 text-[var(--kb-red)]">{preview.server.error}</p>
            ) : preview?.server ? (
              <div className="grid grid-cols-3 gap-2 pt-1">
                <div>
                  <div className={labelClass}>Rung</div>
                  <div>
                    <Badge variant="outline" className="text-[9px]">
                      L{preview.server.level ?? 1}
                    </Badge>
                  </div>
                </div>
                <div>
                  <div className={labelClass}>Bars</div>
                  <div>{preview.server.barsReplayed ?? 0}</div>
                </div>
                <div>
                  <div className={labelClass}>Frames</div>
                  <div>{preview.server.framesReady === false ? 'cold' : 'ready'}</div>
                </div>
              </div>
            ) : (
              <p className="pt-1 text-muted-foreground">Pick a bot and a stop.</p>
            )}
            {wouldExit && (
              <p className="pt-2 text-[var(--kb-amber)]">
                Replayed from entry, the ladder already exited: {preview!.server!.exit!.reason}. Start
                from now instead, or hand over anyway and it closes on the next bar.
              </p>
            )}
            {preview && (preview.detaches.managers.length > 0 || preview.detaches.trails > 0) && (
              <p className="pt-2 text-muted-foreground">
                Detaches {preview.detaches.managers.join(', ') || 'no managers'}
                {preview.detaches.trails > 0 ? ` and ${preview.detaches.trails} trail` : ''}: the ride
                becomes the only stop owner.
              </p>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" disabled={!canSubmit} onClick={() => void submit()}>
              {busy && <Loader2 className="mr-1 size-3 animate-spin" />}
              Hand over
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

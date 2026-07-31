import { useEffect, useState } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import {
  Badge,
  Button,
  ConfirmDialog,
  Input,
  StaleDataBanner,
  type ConfirmSummaryItem,
} from '@kaibot/shared';
import { Shield, X, Loader2 } from '@/lib/icons';
import { toast } from 'sonner';
import {
  positionsAtom,
  exchangeSessionsAtom,
  skipOrderConfirmAtom,
  type Position,
} from '@/lib/atoms';
import {
  manualTradeApi,
  botsApi,
  composeApi,
  ComposeError,
  type ExecutorBot,
  type ManualOrderType,
  type SizeUnit,
} from '@/lib/manual-trade-api';
import { positionGroupsApi } from '@/lib/position-groups-api';
import { apiFetch } from '@/lib/api';
import { equalSizes, weightedSizes } from '@/lib/rung-presets';
import { useBrokerData } from '@/hooks/useBrokerData';
import { usePolledResource } from '@/hooks/usePolledResource';
import {
  ManagePositionDialog,
  type ManagePositionTarget,
} from '@/components/ManagePositionDialog';

const selectClass =
  'h-9 w-full rounded-md border border-border bg-background px-2 font-mono text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary';
const labelClass =
  'font-mono text-[10px] uppercase tracking-wider text-muted-foreground';

const num = (s: string): number | undefined => {
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : undefined;
};

const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 8 });

type ConfirmAction = { kind: 'place' } | { kind: 'close'; position: Position };

// Sentinel for the "New group…" option in the group picker.
const NEW_GROUP = '__new__';

// The server calculator gates tradfi separately; everything else is crypto.
const assetClassFor = (exchange: string): 'crypto' | 'tradfi' =>
  exchange === 'tradestation' || exchange === 'interactive-brokers' ? 'tradfi' : 'crypto';

type RungRow = { price: string; size: string };
type TpRow = { price: string; pct: string };

const emptyRungs = (): RungRow[] => [
  { price: '', size: '' },
  { price: '', size: '' },
];
const emptyTpRows = (): TpRow[] => [
  { price: '', pct: '' },
  { price: '', pct: '' },
];

// Single ↔ Ladder pill, same visual language as the contracts/USD unit toggle.
function LadderToggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex overflow-hidden rounded border border-border text-[10px]">
      {([false, true] as const).map((v) => (
        <button
          key={String(v)}
          type="button"
          onClick={() => onChange(v)}
          className={`px-1.5 py-0.5 font-mono uppercase ${
            on === v ? 'bg-muted text-foreground' : 'text-muted-foreground'
          }`}
        >
          {v ? 'Ladder' : 'Single'}
        </button>
      ))}
    </div>
  );
}

// Manual trading on the user's OWN connected exchange — placed edge-side by the
// local executor, no server signal. `quantity` is a real absolute size.
export function ManualTradePanel() {
  const { refresh, isStale, lastUpdated } = useBrokerData(5000);
  const positions = useAtomValue(positionsAtom);
  const sessions = useAtomValue(exchangeSessionsAtom);
  const connected = sessions.filter((s) => s.status === 'connected');

  // A failed poll keeps the last-known bot list.
  const { data: botsData, refresh: reloadBots } = usePolledResource(
    () => botsApi.list(),
    { intervalMs: 8000 },
  );
  const bots: ExecutorBot[] = botsData?.bots ?? [];

  // Groups for the optional picker (default Unsorted).
  const { data: groupsData, refresh: reloadGroups } = usePolledResource(
    () => positionGroupsApi.list(),
    { intervalMs: 15000 },
  );
  const groups = groupsData?.groups ?? [];

  const [exchange, setExchange] = useState('');
  useEffect(() => {
    if (!exchange && connected.length > 0) setExchange(connected[0].exchangeName);
  }, [connected, exchange]);

  const [symbol, setSymbol] = useState('');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [orderType, setOrderType] = useState<ManualOrderType>('market');
  const [quantity, setQuantity] = useState('');
  const [sizeUnit, setSizeUnit] = useState<SizeUnit>('native');
  const [price, setPrice] = useState('');
  const [stopLoss, setStopLoss] = useState('');
  const [takeProfit, setTakeProfit] = useState('');
  // Entry ladder: user-authored resting limit rungs replacing the single entry.
  const [entryLadder, setEntryLadder] = useState(false);
  const [rungs, setRungs] = useState<RungRow[]>(emptyRungs);
  // TP ladder: price + % of the total position per level (sum ≤ 100%).
  const [tpLadderOn, setTpLadderOn] = useState(false);
  const [tpRows, setTpRows] = useState<TpRow[]>(emptyTpRows);
  // Recovery-ladder composer (protected server calculator; F4).
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [recExtreme, setRecExtreme] = useState('');
  const [recEntry, setRecEntry] = useState('');
  const [recQty, setRecQty] = useState('');
  const [recLevels, setRecLevels] = useState('5');
  const [recTail, setRecTail] = useState(true);
  const [recBusy, setRecBusy] = useState(false);
  const [recResult, setRecResult] = useState<{ avg: number; levels: number } | null>(null);
  // Optional group for the new position; '' = Unsorted, NEW_GROUP = create one.
  const [groupChoice, setGroupChoice] = useState('');
  const [newGroupName, setNewGroupName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [busyClose, setBusyClose] = useState<string | null>(null);
  const [skipConfirm, setSkipConfirm] = useAtom(skipOrderConfirmAtom);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [manageTarget, setManageTarget] = useState<ManagePositionTarget | null>(null);

  const openPositions = positions.filter((p) => Math.abs(p.size) > 0);

  // A position is bot-managed only while a RUNNING bot drives its market — a
  // paused config (take-over/detach) is manual (deriveBotManager parity), so
  // the Manage attach surface opens up right after a take-over.
  const botFor = (p: Position): ExecutorBot | undefined =>
    bots.find(
      (b) => b.status === 'running' && b.exchange === p.exchange && b.symbol === p.symbol,
    );

  const needsPrice = orderType !== 'market';

  // Entry-ladder derived state. Every rung is a resting limit → price + size
  // required on each row. The total and size-weighted average feed the preview.
  const rungTotal = rungs.reduce((s, r) => s + (num(r.size) ?? 0), 0);
  const rungNotional = rungs.reduce((s, r) => s + (num(r.size) ?? 0) * (num(r.price) ?? 0), 0);
  const rungAvg = rungTotal > 0 ? rungNotional / rungTotal : 0;
  const rungsValid =
    rungs.length > 0 && rungs.every((r) => (num(r.price) ?? 0) > 0 && (num(r.size) ?? 0) > 0);

  // TP-ladder derived state: every level needs price + %, and the fractions
  // may not close more than 100% of the position.
  const tpPctSum = tpRows.reduce((s, r) => s + (num(r.pct) ?? 0), 0);
  const tpSumOver = tpPctSum > 100 + 1e-9;
  const tpRowsValid =
    tpRows.length > 0 &&
    tpRows.every((r) => (num(r.price) ?? 0) > 0 && (num(r.pct) ?? 0) > 0) &&
    !tpSumOver;

  const canPlace =
    !!exchange &&
    symbol.trim().length > 0 &&
    (entryLadder
      ? rungsValid
      : (num(quantity) ?? 0) > 0 && (!needsPrice || (num(price) ?? 0) > 0)) &&
    (!tpLadderOn || tpRowsValid);

  const setRung = (i: number, patch: Partial<RungRow>) =>
    setRungs((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const setTpRow = (i: number, patch: Partial<TpRow>) =>
    setTpRows((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  // Redistribute the current total across the rungs: equal, or linearly
  // weighted (deeper rungs carry more). Sizes always sum to the exact total.
  const applySizePreset = (kind: 'equal' | 'weighted') => {
    if (!(rungTotal > 0) || rungs.length === 0) return;
    const sizes = (kind === 'equal' ? equalSizes : weightedSizes)(rungTotal, rungs.length);
    if (sizes.length !== rungs.length) return;
    setRungs((rows) => rows.map((r, i) => ({ ...r, size: String(sizes[i]) })));
  };

  // Ask the protected server calculator for a recovery ladder and load the
  // result into the rung rows. The rungs stay user-authored: every price and
  // size is editable before the order is placed.
  const computeRecovery = async () => {
    const extreme = num(recExtreme);
    const entry = num(recEntry);
    const totalQty = num(recQty) ?? (rungTotal > 0 ? rungTotal : undefined);
    const levels = num(recLevels);
    if (!extreme || extreme <= 0 || !entry || entry <= 0) {
      toast.error('Extreme and entry prices are required');
      return;
    }
    if (extreme === entry) {
      toast.error('Entry must differ from the extreme');
      return;
    }
    if (!totalQty || totalQty <= 0) {
      toast.error('Total size is required');
      return;
    }
    setRecBusy(true);
    try {
      const r = await composeApi.recoveryLadder({
        extreme,
        entry,
        totalQty,
        assetClass: assetClassFor(exchange),
        levels: levels && levels >= 1 ? Math.min(Math.floor(levels), 50) : undefined,
        includeRecoveryTail: recTail,
      });
      setRungs(r.rungs.map((rung) => ({ price: String(rung.price), size: String(rung.size) })));
      setRecResult({ avg: r.avgIfAllFilled, levels: r.meta.levelsUsed });
    } catch (e) {
      setRecResult(null);
      const code = e instanceof ComposeError ? e.code : undefined;
      const message = e instanceof Error ? e.message : String(e);
      if (code === 'forbidden') {
        toast.error('Not available on your plan', { description: message });
      } else if (code === 'rate-limited') {
        toast.error('Slow down', { description: message });
      } else if (code === 'no-config') {
        toast.error('Cloud API not configured', {
          description: 'Add your API URL and key in Settings, then retry.',
        });
      } else if (code === 'unauthorized') {
        toast.error('API key rejected', { description: 'Check your API key in Settings.' });
      } else {
        toast.error('Compute failed', { description: message });
      }
    } finally {
      setRecBusy(false);
    }
  };

  const equalSplitTps = () => {
    if (tpRows.length === 0) return;
    const per = Math.round((100 / tpRows.length) * 100) / 100;
    const last = Math.round((100 - per * (tpRows.length - 1)) * 100) / 100;
    setTpRows((rows) => rows.map((r, i) => ({ ...r, pct: String(i === rows.length - 1 ? last : per) })));
  };

  // Resolve the accountId of the freshly opened position (the place result
  // doesn't carry one). Local atom first, then a few short polls — resting
  // ladder entries may not have a position yet.
  const findAccountId = async (exchangeName: string, sym: string): Promise<string | null> => {
    const local = positions.find(
      (p) =>
        p.exchange === exchangeName &&
        p.symbol.toUpperCase() === sym.toUpperCase() &&
        p.accountId,
    );
    if (local?.accountId) return local.accountId;
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const res = await apiFetch(`/api/exchanges/v2/positions/${exchangeName}`, {
          headers: { 'x-user-id': 'default' },
        });
        if (!res.ok) continue;
        const list = (await res.json()) as Position[];
        const match = list.find(
          (p) => p.symbol.toUpperCase() === sym.toUpperCase() && Math.abs(p.size) > 0,
        );
        if (match?.accountId) return match.accountId;
      } catch {
        // retry
      }
    }
    return null;
  };

  // Best-effort after a successful entry — group assignment never blocks or
  // fails the trade flow.
  const assignPlacedToGroup = async (exchangeName: string, sym: string) => {
    try {
      let groupId = groupChoice;
      if (groupChoice === NEW_GROUP) {
        const name = newGroupName.trim();
        if (!name) return;
        groupId = (await positionGroupsApi.create(name)).id;
        setGroupChoice(groupId);
        setNewGroupName('');
        reloadGroups();
      }
      const accountId = await findAccountId(exchangeName, sym);
      if (!accountId) {
        toast.warning('Group not assigned', {
          description: `No live position found yet for ${sym}. Move it from the Positions page.`,
        });
        return;
      }
      await positionGroupsApi.assign({ exchange: exchangeName, accountId, symbol: sym, groupId });
    } catch (e) {
      toast.warning('Group not assigned', {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const place = async () => {
    if (!canPlace || submitting) return;
    setSubmitting(true);
    try {
      const r = await manualTradeApi.place({
        exchange,
        symbol: symbol.trim(),
        side,
        orderType: entryLadder ? undefined : orderType,
        quantity: entryLadder ? rungTotal : num(quantity)!,
        sizeUnit,
        price: entryLadder ? undefined : needsPrice ? num(price) : undefined,
        stopLoss: num(stopLoss),
        takeProfit: tpLadderOn ? undefined : num(takeProfit),
        entries: entryLadder
          ? rungs.map((row) => ({ price: num(row.price)!, size: num(row.size)! }))
          : undefined,
        takeProfits: tpLadderOn
          ? tpRows.map((row) => ({ price: num(row.price)!, fraction: num(row.pct)! / 100 }))
          : undefined,
        idempotencyKey: crypto.randomUUID(),
      });
      if (r.status === 'rejected') {
        toast.error('Order rejected', {
          description: r.warnings?.join(' ') || `The exchange rejected ${symbol.trim()}.`,
        });
      } else {
        toast.success(`${side === 'buy' ? 'Bought' : 'Sold'} ${symbol.trim()}`, {
          description: `Order ${r.orderId.slice(0, 10)} · ${r.status}${
            r.averagePrice ? ` @ ${r.averagePrice}` : ''
          }`,
        });
        // A rejected protective leg means the position is not actually protected —
        // surface it loudly, not as a quiet success detail.
        if (r.warnings && r.warnings.length > 0) {
          toast.error('Protection warning', { description: r.warnings.join(' ') });
        }
        if (groupChoice) void assignPlacedToGroup(exchange, symbol.trim());
        setQuantity('');
        setPrice('');
        setStopLoss('');
        setTakeProfit('');
        setRungs(emptyRungs());
        setTpRows(emptyTpRows());
      }
      refresh();
    } catch (e) {
      toast.error('Order failed', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSubmitting(false);
    }
  };

  const close = async (p: Position) => {
    setBusyClose(p.id);
    try {
      const r = await manualTradeApi.close({
        exchange: p.exchange ?? exchange,
        symbol: p.symbol,
        idempotencyKey: crypto.randomUUID(),
      });
      toast.success(`Closed ${p.symbol}`, { description: `${r.closedQuantity} @ market` });
      refresh();
    } catch (e) {
      toast.error('Close failed', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusyClose(null);
    }
  };

  const requestPlace = () => {
    if (!canPlace || submitting) return;
    if (skipConfirm) return void place();
    setConfirmAction({ kind: 'place' });
  };

  const requestClose = (p: Position) => {
    if (busyClose) return;
    if (skipConfirm) return void close(p);
    setConfirmAction({ kind: 'close', position: p });
  };

  const placeSummary = (): ConfirmSummaryItem[] => {
    const qty = entryLadder ? rungTotal : num(quantity) ?? 0;
    const sym = symbol.trim();
    // Notional off the entered/avg price, else the exchange's live mark.
    const px = entryLadder
      ? rungAvg
      : needsPrice
        ? num(price)
        : connected.find((s) => s.exchangeName === exchange)?.prices?.[sym];
    const items: ConfirmSummaryItem[] = [
      { label: 'Side', value: side === 'buy' ? 'Buy / Long' : 'Sell / Short' },
      { label: 'Symbol', value: sym },
      sizeUnit === 'usd'
        ? { label: 'Size', value: `$${fmt(qty)} notional` }
        : { label: 'Quantity', value: fmt(qty) },
      entryLadder
        ? { label: 'Entry ladder', value: `${rungs.length} resting limit rungs` }
        : { label: 'Order type', value: orderType },
    ];
    if (entryLadder && rungAvg > 0) items.push({ label: 'Avg entry', value: fmt(rungAvg) });
    if (!entryLadder && needsPrice && num(price) != null)
      items.push({
        label: orderType === 'stop' ? 'Stop price' : 'Limit price',
        value: fmt(num(price)!),
      });
    if (num(stopLoss) != null) items.push({ label: 'Stop loss', value: fmt(num(stopLoss)!) });
    if (tpLadderOn)
      items.push({
        label: 'TP ladder',
        value: tpRows.map((r) => `${r.price} (${r.pct}%)`).join(' · '),
      });
    else if (num(takeProfit) != null)
      items.push({ label: 'Take profit', value: fmt(num(takeProfit)!) });
    // USD-mode: the entered size IS the notional. Native-mode: notional ≈ qty × price.
    if (sizeUnit === 'usd') items.push({ label: 'Notional', value: `≈ $${fmt(qty)}` });
    else if (px != null && px > 0) items.push({ label: 'Notional', value: `≈ ${fmt(qty * px)}` });
    return items;
  };

  const closeSummary = (p: Position): ConfirmSummaryItem[] => {
    const qty = Math.abs(p.size);
    const px = p.markPrice ?? p.entryPrice;
    const items: ConfirmSummaryItem[] = [
      { label: 'Side', value: `Close ${p.side}` },
      { label: 'Symbol', value: p.symbol },
      { label: 'Quantity', value: fmt(qty) },
      { label: 'Order type', value: 'market' },
    ];
    if (px > 0) items.push({ label: 'Notional', value: `≈ ${fmt(qty * px)}` });
    return items;
  };

  const takeOver = async (bot: ExecutorBot, p: Position) => {
    try {
      const r = await botsApi.takeOver(bot.id);
      toast.success(r.needed ? `Took over ${bot.symbol}` : `${bot.symbol} is already manual`, {
        description: r.needed ? 'Bot paused, local trails retired. Now manual.' : undefined,
      });
      refresh();
      reloadBots();
      // Take-over 2.0 (F3): offer to re-attach edge blocks with the user's own
      // params. Closing the dialog = current behaviour (fully manual).
      if (r.needed) {
        setManageTarget({
          exchange: p.exchange ?? exchange,
          symbol: p.symbol,
          side: p.side,
          entryPrice: p.entryPrice,
          markPrice: p.markPrice,
          accountId: p.accountId,
          context: 'take-over',
        });
      }
    } catch (e) {
      toast.error('Take-over failed', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-card">
      {isStale && (
        <StaleDataBanner updatedAt={lastUpdated} onRetry={refresh} className="m-2" />
      )}
      {/* Order entry */}
      <div className="border-b border-border px-4 py-3">
        <div className="mb-3 font-mono text-[10px] font-medium uppercase tracking-wider text-foreground">
          Manual order
        </div>

        {connected.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Connect an exchange to trade. Manual orders are placed locally with your own keys.
          </p>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <span className={labelClass}>Exchange</span>
                <select
                  className={selectClass}
                  value={exchange}
                  onChange={(e) => setExchange(e.target.value)}
                >
                  {connected.map((s) => (
                    <option key={s.exchangeName} value={s.exchangeName}>
                      {s.exchangeName}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <span className={labelClass}>Symbol</span>
                <Input
                  className="h-9 font-mono text-xs"
                  placeholder="BTC-PERPETUAL"
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setSide('buy')}
                className={`h-9 rounded-md border font-mono text-xs uppercase tracking-wider transition-colors ${
                  side === 'buy'
                    ? 'border-[var(--kb-green)]/50 bg-[var(--kb-green)]/15 text-[var(--kb-green)]'
                    : 'border-border text-muted-foreground hover:text-foreground'
                }`}
              >
                Buy / Long
              </button>
              <button
                type="button"
                onClick={() => setSide('sell')}
                className={`h-9 rounded-md border font-mono text-xs uppercase tracking-wider transition-colors ${
                  side === 'sell'
                    ? 'border-[var(--kb-red)]/50 bg-[var(--kb-red)]/15 text-[var(--kb-red)]'
                    : 'border-border text-muted-foreground hover:text-foreground'
                }`}
              >
                Sell / Short
              </button>
            </div>

            <div className="flex items-center justify-between">
              <span className={labelClass}>Entry</span>
              <div className="flex items-center gap-2">
                <div className="flex overflow-hidden rounded border border-border text-[10px]">
                  {(['native', 'usd'] as const).map((u) => (
                    <button
                      key={u}
                      type="button"
                      onClick={() => setSizeUnit(u)}
                      className={`px-1.5 py-0.5 font-mono uppercase ${
                        sizeUnit === u ? 'bg-muted text-foreground' : 'text-muted-foreground'
                      }`}
                    >
                      {u === 'native' ? 'Contracts' : 'USD'}
                    </button>
                  ))}
                </div>
                <LadderToggle on={entryLadder} onChange={setEntryLadder} />
              </div>
            </div>

            {!entryLadder ? (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <span className={labelClass}>Order type</span>
                    <select
                      className={selectClass}
                      value={orderType}
                      onChange={(e) => setOrderType(e.target.value as ManualOrderType)}
                    >
                      <option value="market">Market</option>
                      <option value="limit">Limit</option>
                      <option value="stop">Stop</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <span className={labelClass}>Size</span>
                    <Input
                      className="h-9 font-mono text-xs"
                      type="number"
                      min="0"
                      step="any"
                      placeholder={sizeUnit === 'usd' ? 'USD notional' : 'size'}
                      value={quantity}
                      onChange={(e) => setQuantity(e.target.value)}
                    />
                    {sizeUnit === 'usd' && (
                      <span className="text-[10px] text-muted-foreground">
                        Converted to contracts at the mark price (or your limit/stop
                        price), rounded to the contract step.
                      </span>
                    )}
                  </div>
                </div>

                {needsPrice && (
                  <div className="space-y-1">
                    <span className={labelClass}>{orderType === 'stop' ? 'Stop price' : 'Limit price'}</span>
                    <Input
                      className="h-9 font-mono text-xs"
                      type="number"
                      min="0"
                      step="any"
                      placeholder="0.00"
                      value={price}
                      onChange={(e) => setPrice(e.target.value)}
                    />
                  </div>
                )}
              </>
            ) : (
              <div className="space-y-2">
                <span className={labelClass}>
                  Rungs: price · {sizeUnit === 'usd' ? 'USD' : 'size'}
                </span>
                {rungs.map((rung, i) => (
                  <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
                    <Input
                      className="h-9 font-mono text-xs"
                      type="number"
                      min="0"
                      step="any"
                      placeholder={`rung ${i + 1} price`}
                      value={rung.price}
                      onChange={(e) => setRung(i, { price: e.target.value })}
                    />
                    <Input
                      className="h-9 font-mono text-xs"
                      type="number"
                      min="0"
                      step="any"
                      placeholder={sizeUnit === 'usd' ? 'USD' : 'size'}
                      value={rung.size}
                      onChange={(e) => setRung(i, { size: e.target.value })}
                    />
                    <button
                      type="button"
                      onClick={() => setRungs((rows) => rows.filter((_, j) => j !== i))}
                      disabled={rungs.length <= 1}
                      className="text-muted-foreground transition-colors hover:text-[var(--kb-red)] disabled:opacity-30"
                      title="Remove rung"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                ))}
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setRungs((rows) => [...rows, { price: '', size: '' }])}
                    className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
                  >
                    + Add rung
                  </button>
                  <button
                    type="button"
                    onClick={() => applySizePreset('equal')}
                    disabled={!(rungTotal > 0)}
                    className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30"
                    title="Evenly redistribute the current total across all rungs"
                  >
                    Equal split
                  </button>
                  <button
                    type="button"
                    onClick={() => applySizePreset('weighted')}
                    disabled={!(rungTotal > 0)}
                    className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30"
                    title="Redistribute the current total with more size on deeper rungs"
                  >
                    Weighted
                  </button>
                  <button
                    type="button"
                    onClick={() => setRecoveryOpen((v) => !v)}
                    className={`font-mono text-[10px] uppercase tracking-wider transition-colors ${
                      recoveryOpen
                        ? 'text-foreground'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                    title="Compute a recovery ladder from a pre-drop peak (server calculator)"
                  >
                    Recovery…
                  </button>
                </div>

                {recoveryOpen && (
                  <div className="space-y-2 rounded-md border border-border bg-muted/20 p-2">
                    <span className={labelClass}>Recovery ladder</span>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <span className={labelClass}>Pre-drop peak</span>
                        <Input
                          className="h-9 font-mono text-xs"
                          type="number"
                          min="0"
                          step="any"
                          placeholder="extreme"
                          value={recExtreme}
                          onChange={(e) => setRecExtreme(e.target.value)}
                        />
                      </div>
                      <div className="space-y-1">
                        <span className={labelClass}>Entry / reference</span>
                        <Input
                          className="h-9 font-mono text-xs"
                          type="number"
                          min="0"
                          step="any"
                          placeholder="entry"
                          value={recEntry}
                          onChange={(e) => setRecEntry(e.target.value)}
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <span className={labelClass}>
                          Total {sizeUnit === 'usd' ? 'USD' : 'size'}
                        </span>
                        <Input
                          className="h-9 font-mono text-xs"
                          type="number"
                          min="0"
                          step="any"
                          placeholder={rungTotal > 0 ? String(rungTotal) : 'total'}
                          value={recQty}
                          onChange={(e) => setRecQty(e.target.value)}
                        />
                      </div>
                      <div className="space-y-1">
                        <span className={labelClass}>Levels</span>
                        <Input
                          className="h-9 font-mono text-xs"
                          type="number"
                          min="1"
                          max="50"
                          step="1"
                          value={recLevels}
                          onChange={(e) => setRecLevels(e.target.value)}
                        />
                      </div>
                    </div>
                    <label className="flex items-center gap-2 text-[10px] text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={recTail}
                        onChange={(e) => setRecTail(e.target.checked)}
                      />
                      Include recovery tail (deeper rescue rungs)
                    </label>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="w-full"
                      disabled={recBusy}
                      onClick={computeRecovery}
                    >
                      {recBusy ? <Loader2 className="size-3.5 animate-spin" /> : 'Compute'}
                    </Button>
                    {recResult && (
                      <p className="font-mono text-[10px] tabular-nums text-muted-foreground">
                        {recResult.levels} rungs · avg if all filled {fmt(recResult.avg)}
                      </p>
                    )}
                    <p className="text-[10px] leading-snug text-muted-foreground">
                      Computed server-side from your inputs. Review and edit every rung
                      before placing. Nothing is sent to the exchange yet.
                    </p>
                  </div>
                )}
                {rungTotal > 0 && (
                  <p className="font-mono text-[10px] tabular-nums text-muted-foreground">
                    Total {sizeUnit === 'usd' ? `$${fmt(rungTotal)}` : fmt(rungTotal)}
                    {rungAvg > 0 && <> · Avg entry {fmt(rungAvg)}</>}
                  </p>
                )}
                <p className="text-[10px] leading-snug text-muted-foreground">
                  All rungs rest as limit orders at the exchange, pre-authorized here,
                  never added later by the executor.
                </p>
              </div>
            )}

            <div className="space-y-1">
              <span className={labelClass}>Stop loss</span>
              <Input
                className="h-9 font-mono text-xs"
                type="number"
                min="0"
                step="any"
                placeholder="optional"
                value={stopLoss}
                onChange={(e) => setStopLoss(e.target.value)}
              />
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className={labelClass}>Take profit</span>
                <LadderToggle on={tpLadderOn} onChange={setTpLadderOn} />
              </div>
              {!tpLadderOn && (
                <Input
                  className="h-9 font-mono text-xs"
                  type="number"
                  min="0"
                  step="any"
                  placeholder="optional"
                  value={takeProfit}
                  onChange={(e) => setTakeProfit(e.target.value)}
                />
              )}
            </div>

            {tpLadderOn && (
              <div className="space-y-2">
                <span className={labelClass}>TP levels: price · % of position</span>
                {tpRows.map((row, i) => (
                  <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
                    <Input
                      className="h-9 font-mono text-xs"
                      type="number"
                      min="0"
                      step="any"
                      placeholder={`TP ${i + 1} price`}
                      value={row.price}
                      onChange={(e) => setTpRow(i, { price: e.target.value })}
                    />
                    <Input
                      className="h-9 font-mono text-xs"
                      type="number"
                      min="0"
                      max="100"
                      step="any"
                      placeholder="%"
                      value={row.pct}
                      onChange={(e) => setTpRow(i, { pct: e.target.value })}
                    />
                    <button
                      type="button"
                      onClick={() => setTpRows((rows) => rows.filter((_, j) => j !== i))}
                      disabled={tpRows.length <= 1}
                      className="text-muted-foreground transition-colors hover:text-[var(--kb-red)] disabled:opacity-30"
                      title="Remove level"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                ))}
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setTpRows((rows) => [...rows, { price: '', pct: '' }])}
                    className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
                  >
                    + Add level
                  </button>
                  <button
                    type="button"
                    onClick={equalSplitTps}
                    className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
                    title="Split 100% evenly across all levels"
                  >
                    Equal split
                  </button>
                  <span
                    className={`ml-auto font-mono text-[10px] tabular-nums ${
                      tpSumOver ? 'text-[var(--kb-red)]' : 'text-muted-foreground'
                    }`}
                  >
                    Σ {fmt(tpPctSum)}%
                  </span>
                </div>
                {tpSumOver && (
                  <p className="text-[10px] leading-snug text-[var(--kb-red)]">
                    TP fractions close more than 100% of the position.
                  </p>
                )}
              </div>
            )}

            <div className="space-y-1">
              <span className={labelClass}>Group</span>
              <select
                className={selectClass}
                value={groupChoice}
                onChange={(e) => setGroupChoice(e.target.value)}
              >
                <option value="">Unsorted</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
                <option value={NEW_GROUP}>New group…</option>
              </select>
              {groupChoice === NEW_GROUP && (
                <Input
                  className="h-9 font-mono text-xs"
                  placeholder="group name"
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                />
              )}
              {groupChoice !== '' && (
                <span className="text-[10px] text-muted-foreground">
                  Assigned after the entry fills. Never blocks the order.
                </span>
              )}
            </div>

            <Button className="w-full" disabled={!canPlace || submitting} onClick={requestPlace}>
              {submitting ? <Loader2 className="size-4 animate-spin" /> : `Place ${side} order`}
            </Button>
            <p className="text-[10px] leading-snug text-muted-foreground">
              Placed locally with your own keys on {exchange || 'your exchange'}. Software only, not
              investment advice.
            </p>
          </div>
        )}
      </div>

      {/* Open positions */}
      <div className="flex-1 px-4 py-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="font-mono text-[10px] font-medium uppercase tracking-wider text-foreground">
            Open positions
          </span>
          <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
            {openPositions.length}
          </span>
        </div>

        {openPositions.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">No open positions.</p>
        ) : (
          <div className="divide-y divide-border">
            {openPositions.map((p) => {
              const bot = botFor(p);
              const upnl = p.unrealizedPnL;
              return (
                <div key={p.id} className="py-2.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className={`font-mono text-xs font-bold uppercase ${
                          p.side === 'long' ? 'text-[var(--kb-green)]' : 'text-[var(--kb-red)]'
                        }`}
                      >
                        {p.side}
                      </span>
                      <div className="flex flex-col min-w-0">
                        <span className="truncate text-sm font-medium text-[var(--kb-teal)]">
                          {p.symbol}
                        </span>
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {Math.abs(p.size)} @ {p.entryPrice} · {p.exchange}
                        </span>
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      {bot ? (
                        <Badge
                          variant="outline"
                          className="text-[9px] font-mono uppercase tracking-wider border-[var(--kb-amber)]/40 text-[var(--kb-amber)]"
                        >
                          {bot.botName || bot.strategyName || 'Bot'}
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="text-[9px] font-mono uppercase tracking-wider"
                        >
                          Manual
                        </Badge>
                      )}
                      {typeof upnl === 'number' && (
                        <span
                          className={`font-mono text-[10px] tabular-nums ${
                            upnl >= 0 ? 'text-[var(--kb-green)]' : 'text-[var(--kb-red)]'
                          }`}
                        >
                          {upnl >= 0 ? '+' : ''}
                          {upnl.toFixed(2)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="mt-1.5 flex items-center gap-3">
                    {bot && (
                      <button
                        type="button"
                        onClick={() => takeOver(bot, p)}
                        className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-[var(--kb-amber)]/80 hover:text-[var(--kb-amber)] transition-colors"
                        title="Stop the bot from managing this position and take manual control. One-way: the bot won't take it back."
                      >
                        <Shield className="size-3" />
                        Take over
                      </button>
                    )}
                    {!bot && (
                      <button
                        type="button"
                        onClick={() =>
                          setManageTarget({
                            exchange: p.exchange ?? exchange,
                            symbol: p.symbol,
                            side: p.side,
                            entryPrice: p.entryPrice,
                            markPrice: p.markPrice,
                            accountId: p.accountId,
                          })
                        }
                        className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
                        title="Attach a trailing stop / break-even to this position"
                      >
                        <Shield className="size-3" />
                        Manage
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => requestClose(p)}
                      disabled={busyClose === p.id}
                      className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-[var(--kb-red)]/80 hover:text-[var(--kb-red)] transition-colors disabled:opacity-50"
                      title="Close this position now at market"
                    >
                      {busyClose === p.id ? <Loader2 className="size-3 animate-spin" /> : <X className="size-3" />}
                      Close
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {manageTarget && (
        <ManagePositionDialog
          target={manageTarget}
          onOpenChange={(o) => {
            if (!o) setManageTarget(null);
          }}
          onChanged={() => refresh()}
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
            confirmAction.kind === 'place'
              ? `Place ${side} order?`
              : `Close ${confirmAction.position.symbol}?`
          }
          description={
            confirmAction.kind === 'close' ? 'Closes the position at market.' : undefined
          }
          summary={
            confirmAction.kind === 'place'
              ? placeSummary()
              : closeSummary(confirmAction.position)
          }
          confirmLabel={
            confirmAction.kind === 'place' ? `Place ${side} order` : 'Close position'
          }
          onConfirm={async () => {
            if (confirmAction.kind === 'place') await place();
            else await close(confirmAction.position);
          }}
          skipPreference={{ checked: skipConfirm, onCheckedChange: setSkipConfirm }}
        />
      )}
    </div>
  );
}

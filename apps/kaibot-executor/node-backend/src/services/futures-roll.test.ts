import { describe, expect, it } from 'bun:test'
import { PaperExchangeAdapter } from './exchanges/adapters/paper.js'
import { createRollService } from './roll-position.js'
import {
  handleFuturesRollNotice,
  parseRollNotice,
  rolledStopPrice,
  type FuturesRollDeps,
} from './futures-roll.js'
import type { Signal } from '../storage/types.js'

const fastSettle = { attempts: 3, intervalMs: 1, sleep: async () => {} }
const RATIO = 7727.25 / 7659.5 // MES U26 → Z26 seam, 2026-09-10

function notice(overrides: Partial<Signal> = {}): Signal {
  return {
    id: 'roll:tradestation:MES:MESU26:MESZ26:2026-09-13T21:00:00.000Z',
    strategy_id: 'futures-roll',
    strategy_name: 'Contract roll',
    symbol: 'MES',
    action: 'roll' as any,
    metadata: {
      exchange: 'tradestation',
      contract: 'MESZ26',
      roll: { from: 'MESU26', to: 'MESZ26', at: '2026-09-13T21:00:00.000Z', ratio: RATIO, source: 'live' },
    },
    received_at: new Date(),
    status: 'pending',
    created_at: new Date(),
    ...overrides,
  } as Signal
}

// In-memory stand-in for the executor DB surface the roll touches.
function fakeDb() {
  const executions = new Map<string, any>()
  const signals = new Map<string, any>()
  const settlements: any[] = []
  const manual = new Map<string, number>()
  const exitStates: any[] = []
  const brackets = new Map<string, any>()
  const logs: any[] = []
  let seq = 0
  const mkey = (e: string, a: string, s: string) => `${e}|${a}|${s}`
  return {
    executions, signals, settlements, manual, exitStates, brackets, logs,
    log(level: string, category: string, message: string, metadata?: any) {
      logs.push({ level, category, message, metadata })
    },
    listOpenExecutionsForExchange(exchange: string) {
      return [...executions.values()].filter((e) => e.exchange === exchange && (e.status === 'open' || e.status === 'closing'))
    },
    getSignalExecution(id: string) {
      return executions.get(id)
    },
    updateSignalExecutionSymbol(id: string, symbol: string) {
      const row = executions.get(id)
      if (row) row.symbol = symbol
    },
    getOpenEntrySignals(symbol: string) {
      return [...signals.values()].filter((s) => s.symbol === symbol)
    },
    getSignalBracket(id: string) {
      const s = signals.get(id)
      return s ? { symbol: s.symbol, action: s.action, stop_loss_order_id: s.stop_loss_order_id, take_profit_order_id: s.take_profit_order_id } : undefined
    },
    updateSignalOrderIds(id: string, sl?: string, tp?: string) {
      const s = signals.get(id)
      if (s) {
        s.stop_loss_order_id = sl ?? null
        s.take_profit_order_id = tp ?? null
      }
    },
    listBracketPairs() {
      return [...brackets.values()]
    },
    upsertBracketPair(row: any) {
      brackets.set(row.signalId, { signal_id: row.signalId, exchange: row.exchange, account_id: row.accountId ?? null, sl_order_id: row.slOrderId ?? null, tp_order_id: row.tpOrderId ?? null, tp_order_ids: null })
    },
    deleteBracketPair(id: string) {
      brackets.delete(id)
    },
    listActiveServerExitStates(exchange?: string) {
      return exitStates.filter((s) => s.active === 1 && (!exchange || s.exchange === exchange))
    },
    applyServerExitUpdate(positionId: string, patch: any) {
      const s = exitStates.find((x) => x.position_id === positionId)
      if (s) Object.assign(s, { last_exit_seq: patch.exitSeq, current_stop: patch.currentStop ?? null, sl_order_id: patch.slOrderId ?? null })
    },
    updateServerExitStateSymbol(positionId: string, symbol: string) {
      const s = exitStates.find((x) => x.position_id === positionId)
      if (s) s.symbol = symbol
    },
    // roll-position spine
    insertOrderSettlement(row: any) {
      const id = ++seq
      settlements.push({ id, signal_id: row.signalId, kind: row.kind, target_label: row.targetLabel ?? null, status: row.status ?? 'unknown', symbol: row.symbol })
      return id
    },
    resolveOrderSettlement(id: number, status: string) {
      const r = settlements.find((x) => x.id === id)
      if (r) r.status = status
    },
    getExitSettlement(signalId: string, kind: string, label: string) {
      return settlements.find((x) => x.signal_id === signalId && x.kind === kind && x.target_label === label)
    },
    addManualPosition(e: string, a: string, s: string, side: 'buy' | 'sell', qty: number) {
      const k = mkey(e, a, s)
      const net = (manual.get(k) ?? 0) + (side === 'buy' ? qty : -qty)
      if (Math.abs(net) < 1e-9) manual.delete(k)
      else manual.set(k, net)
    },
    reduceManualPosition(e: string, a: string, s: string, qty: number) {
      const k = mkey(e, a, s)
      const cur = manual.get(k)
      if (cur == null) return
      const mag = Math.max(0, Math.abs(cur) - Math.abs(qty))
      if (mag < 1e-9) manual.delete(k)
      else manual.set(k, cur < 0 ? -mag : mag)
    },
    listManualEntrySignalIds() {
      return []
    },
    findActiveTrailsForSymbol() {
      return []
    },
  }
}

function fakeManager(adapter: any, status: 'connected' | 'disconnected' = 'connected') {
  return {
    async getSession() {
      return { userId: 'default', exchangeName: 'tradestation', adapter, status }
    },
  } as any
}

class Bus {
  events: any[] = []
  publish(e: any) {
    this.events.push(e)
  }
}

function seedLineage(db: ReturnType<typeof fakeDb>, opts: { stop?: number | null; armed?: boolean } = {}) {
  db.signals.set('entry-1', { id: 'entry-1', symbol: 'MES', action: 'buy', quantity: 2, stop_loss: opts.stop ?? 7650, stop_loss_order_id: 'sl-old', take_profit_order_id: null, metadata: '{}' })
  db.executions.set('entry-1', { signal_id: 'entry-1', symbol: 'MESU26', exchange: 'tradestation', direction: 'long', status: 'open', qty_opened: 2, qty_closed: 0, account_id: 'SIM1' })
  db.brackets.set('entry-1', { signal_id: 'entry-1', exchange: 'tradestation', account_id: 'SIM1', sl_order_id: 'sl-old', tp_order_id: null, tp_order_ids: null })
  if (opts.armed) {
    db.exitStates.push({ position_id: 'pos-1', entry_signal_id: 'entry-1', exchange: 'tradestation', symbol: 'MESU26', direction: 'long', last_exit_seq: 3, current_stop: 7660, sl_order_id: 'sl-old', active: 1 })
  }
}

async function setup(opts: { autoRoll: boolean; lineage?: boolean; armed?: boolean; position?: boolean }) {
  const db = fakeDb()
  const adapter = new PaperExchangeAdapter('tradestation', { MESU26: 7596.5, MESZ26: 7663.75 })
  if (opts.position !== false) {
    await adapter.placeOrder({ accountId: 'SIM1', symbol: 'MESU26', side: 'buy', orderType: 'market', quantity: 2 } as any)
  }
  if (opts.lineage !== false) seedLineage(db, { armed: opts.armed })
  const bus = new Bus()
  const retired: string[] = []
  const deps: FuturesRollDeps = {
    db: db as any,
    exchangeManager: fakeManager(adapter),
    notifications: bus as any,
    autoRoll: opts.autoRoll,
    retireBracket: async (_ex, id) => {
      retired.push(id)
      db.brackets.delete(id)
    },
    rollService: createRollService(db as any, fakeManager(adapter), {}, fastSettle),
  }
  return { db, adapter, bus, retired, deps }
}

async function positions(adapter: PaperExchangeAdapter) {
  return (await adapter.getPositions()).map((p) => `${p.symbol}:${p.side}:${p.size}`).sort()
}

describe('parseRollNotice', () => {
  it('reads the roll from metadata and validates the contracts against the root', () => {
    const parsed = parseRollNotice(notice())!
    expect(parsed).toMatchObject({ exchange: 'tradestation', root: 'MES', from: 'MESU26', to: 'MESZ26', ratio: RATIO, source: 'live' })
    expect(parsed.at.toISOString()).toBe('2026-09-13T21:00:00.000Z')
  })

  it('rejects notices whose contracts do not belong to the root, or that are not rolls', () => {
    expect(parseRollNotice(notice({ metadata: { exchange: 'tradestation', roll: { from: 'MNQU26', to: 'MESZ26', at: '2026-09-13T21:00:00.000Z' } } }))).toBeNull()
    expect(parseRollNotice(notice({ metadata: { exchange: 'tradestation', roll: { from: 'MESU26', to: 'MESU26', at: '2026-09-13T21:00:00.000Z' } } }))).toBeNull()
    expect(parseRollNotice(notice({ action: 'buy' as any }))).toBeNull()
  })
})

describe('rolledStopPrice', () => {
  it('moves the stop by the seam ratio and rounds to the tick, away from the position', () => {
    // 7650 × 1.008845 = 7717.66 → long rounds down to 7717.50, short up to 7717.75
    expect(rolledStopPrice(7650, RATIO, 'long', 'MESZ26')).toBe(7717.5)
    expect(rolledStopPrice(7650, RATIO, 'short', 'MESZ26')).toBe(7717.75)
    expect(rolledStopPrice(100, 1, 'long', 'BTC-PERPETUAL')).toBe(100)
  })
})

describe('handleFuturesRollNotice', () => {
  it('stays quiet when nothing is held on the outgoing contract', async () => {
    const { deps, bus } = await setup({ autoRoll: false, lineage: false, position: false })
    const out = await handleFuturesRollNotice(notice(), deps)
    expect(out!.skipped).toBe('not_held')
    expect(bus.events).toHaveLength(0)
  })

  it('reports a position left on the outgoing contract and places nothing (default)', async () => {
    const { deps, bus, adapter, db } = await setup({ autoRoll: false })
    const out = await handleFuturesRollNotice(notice(), deps)
    expect(out!.held).toEqual([{ accountId: 'SIM1', side: 'long', size: 2, entrySignalIds: ['entry-1'] }])
    expect(out!.rolled).toHaveLength(0)
    expect(bus.events.map((e) => e.type)).toEqual(['roll_required'])
    expect(bus.events[0].body).toContain('2 MESU26 long')
    expect(bus.events[0].body).toContain('Roll it from Positions')
    expect(await positions(adapter)).toEqual(['MESU26:long:2'])
    expect(db.executions.get('entry-1').symbol).toBe('MESU26')
    expect(db.logs.some((l) => l.level === 'warn' && l.message.includes('outgoing contract'))).toBe(true)
  })

  it('a manual position on the outgoing contract (no lineage) is reported too', async () => {
    const { deps, bus } = await setup({ autoRoll: false, lineage: false })
    const out = await handleFuturesRollNotice(notice(), deps)
    expect(out!.held).toEqual([{ accountId: 'SIM1', side: 'long', size: 2, entrySignalIds: [] }])
    expect(bus.events.map((e) => e.type)).toEqual(['roll_required'])
  })

  it('auto-roll: moves the exposure, re-points the lineage and re-arms the stop one spread higher', async () => {
    const { deps, bus, adapter, db, retired } = await setup({ autoRoll: true, armed: true })
    const out = await handleFuturesRollNotice(notice(), deps)
    expect(out!.rolled).toHaveLength(1)
    expect(out!.rolled[0]!.result.status).toBe('rolled')
    expect(await positions(adapter)).toEqual(['MESZ26:long:2'])
    // Old protections retired before the close leg.
    expect(retired).toEqual(['entry-1'])
    // Lineage now lives on Z26; the roll route's manual marker on Z26 is netted out.
    expect(db.executions.get('entry-1').symbol).toBe('MESZ26')
    expect(db.manual.size).toBe(0)
    // Stop re-armed on Z26 at the armed stop × ratio (7660 × 1.008845 = 7727.75).
    const stops = [...(adapter as any).orders.values()].filter((o: any) => o.order.orderType === 'stop' && o.status === 'working')
    expect(stops).toHaveLength(1)
    expect(stops[0].order.symbol).toBe('MESZ26')
    expect(stops[0].order.stopPrice).toBe(7727.75)
    expect(stops[0].order.side).toBe('sell')
    expect(stops[0].order.quantity).toBe(2)
    expect(db.brackets.get('entry-1').sl_order_id).toBe(stops[0].orderId)
    expect(db.signals.get('entry-1').stop_loss_order_id).toBe(stops[0].orderId)
    const state = db.exitStates[0]
    expect(state.symbol).toBe('MESZ26')
    expect(state.current_stop).toBe(7727.75)
    expect(state.sl_order_id).toBe(stops[0].orderId)
    expect(bus.events.map((e) => e.type)).toEqual(['roll_required', 'position_rolled'])
    expect(bus.events[1].body).toContain('Stop re-armed at 7727.75')
  })

  it('auto-roll: a rejected close leg leaves the position intact and puts its stop back', async () => {
    const { deps, bus, adapter, db } = await setup({ autoRoll: true })
    adapter.rejectNextOrder('venue closed')
    const out = await handleFuturesRollNotice(notice(), deps)
    expect(out!.rolled[0]!.result.status).toBe('aborted')
    expect(await positions(adapter)).toEqual(['MESU26:long:2'])
    expect(db.executions.get('entry-1').symbol).toBe('MESU26')
    const stops = [...(adapter as any).orders.values()].filter((o: any) => o.order.orderType === 'stop' && o.status === 'working')
    expect(stops).toHaveLength(1)
    expect(stops[0].order.symbol).toBe('MESU26')
    expect(stops[0].order.stopPrice).toBe(7650)
    expect(bus.events.map((e) => e.type)).toEqual(['roll_required', 'roll_failed'])
  })

  it('auto-roll: the same notice twice does not roll twice (idempotency key)', async () => {
    const { deps, adapter } = await setup({ autoRoll: true })
    await handleFuturesRollNotice(notice(), deps)
    const again = await handleFuturesRollNotice(notice(), deps)
    // Nothing held on U26 anymore → quiet no-op.
    expect(again!.skipped).toBe('not_held')
    expect(await positions(adapter)).toEqual(['MESZ26:long:2'])
  })
})

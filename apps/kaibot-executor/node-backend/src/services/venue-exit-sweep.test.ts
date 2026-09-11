import { describe, expect, it } from 'bun:test'
import {
  sweepVenueExitOrders,
  adoptVenueClose,
  collectRestingExitCandidates,
  type VenueExitSweepDeps,
  type VenueExitSweepDb,
} from './venue-exit-sweep.js'
import type { OrderStatus } from './exchanges/types.js'

// Regression suite for the 2026-09-01 MGCZ26 incident: a filled GTC stop must
// become a booked exit (fill + closed execution + retired state + server flat
// report), and a vanished broker position must be adopted as a close — never
// left for a correction order to re-open.

interface ExecRow {
  signal_id: string
  symbol: string
  exchange: string
  direction: 'long' | 'short'
  status: string
  qty_opened: number
  qty_closed: number
  account_id: string | null
  created_at: number
}

class FakeSweepDb implements VenueExitSweepDb {
  execs: ExecRow[] = []
  fills: any[] = []
  settlements: any[] = []
  states: Array<{
    position_id: string
    entry_signal_id: string
    exchange: string
    symbol: string
    direction: 'long' | 'short'
    sl_order_id: string | null
    active: number
  }> = []
  brackets: Array<{
    signal_id: string
    exchange: string
    sl_order_id: string | null
    tp_order_id: string | null
    tp_order_ids: string | null
  }> = []
  trails: Array<{ signal_id: string; exchange: string; symbol: string; sl_order_id: string | null; active: number }> = []
  closedSignals: Array<{ signalId: string; reason?: string }> = []
  logs: any[] = []

  listActiveServerExitStates(exchange?: string) {
    return this.states.filter((s) => s.active === 1 && (!exchange || s.exchange === exchange))
  }
  listBracketPairs() {
    return this.brackets
  }
  listActiveLocalTrails() {
    return this.trails.filter((t) => t.active === 1)
  }
  getSignalExecution(signalId: string) {
    return this.execs.find((e) => e.signal_id === signalId)
  }
  targetAlreadyProcessed(signalId: string, kind: string, targetLabel: string) {
    return this.settlements.some(
      (s) => s.signalId === signalId && s.kind === kind && s.targetLabel === targetLabel && s.status !== 'rejected' && s.status !== 'cancelled',
    )
  }
  sumExitFillQtyForOrder(orderId: string) {
    return this.fills
      .filter((f) => f.orderId === orderId && f.kind === 'exit')
      .reduce((sum, f) => sum + f.qty, 0)
  }
  insertOrderSettlement(row: any) {
    this.settlements.push(row)
    return this.settlements.length
  }
  deactivateServerExitState(positionId: string) {
    for (const s of this.states) if (s.position_id === positionId) s.active = 0
  }
  deactivateLocalTrail(signalId: string) {
    for (const t of this.trails) if (t.signal_id === signalId) t.active = 0
  }
  deleteBracketPair(signalId: string) {
    this.brackets = this.brackets.filter((b) => b.signal_id !== signalId)
  }
  listOpenExecutionsForExchange(exchange: string) {
    return this.execs.filter((e) => e.exchange === exchange && (e.status === 'open' || e.status === 'closing'))
  }
  insertSignalFill(fill: any) {
    this.fills.push(fill)
  }
  updateSignalExecution(signalId: string, patch: any) {
    const e = this.execs.find((x) => x.signal_id === signalId)
    if (!e) return
    if (patch.status) e.status = patch.status
    if (patch.qtyClosed != null) e.qty_closed = patch.qtyClosed
  }
  markEntrySignalClosed(signalId: string, reason?: string) {
    this.closedSignals.push({ signalId, reason })
  }
  log(level: string, category: string, message: string, data?: unknown) {
    this.logs.push({ level, message, data })
  }
}

const STOP_FILL_MS = Date.parse('2026-09-01T13:00:05Z')

function mgcScenario() {
  const db = new FakeSweepDb()
  db.execs.push({
    signal_id: 'entry-1',
    symbol: 'MGCZ26',
    exchange: 'tradestation',
    direction: 'long',
    status: 'open',
    qty_opened: 1,
    qty_closed: 0,
    account_id: '21084933',
    created_at: 1,
  })
  db.states.push({
    position_id: 'pos-1',
    entry_signal_id: 'entry-1',
    exchange: 'tradestation',
    symbol: 'MGCZ26',
    direction: 'long',
    sl_order_id: 'stop-64',
    active: 1,
  })
  db.brackets.push({
    signal_id: 'entry-1',
    exchange: 'tradestation',
    sl_order_id: 'stop-64',
    tp_order_id: null,
    tp_order_ids: null,
  })

  const orderStatuses = new Map<string, OrderStatus>()
  const retired: string[] = []
  const reports: any[] = []
  const protectionsRetired: string[] = []
  const deps: VenueExitSweepDeps = {
    db,
    getAdapter: async () => ({
      getOrderStatus: async (orderId: string) =>
        orderStatuses.get(orderId) ?? { orderId, state: 'unknown' },
      getLastPrice: async () => 4390,
    }),
    retireOrderGroup: async (_ex, orderId) => {
      retired.push(orderId)
    },
    retireProtections: async (_ex, signalId) => {
      protectionsRetired.push(signalId)
    },
    reportVenueExit: async (positionId, fill) => {
      reports.push({ positionId, ...fill })
    },
  }
  return { db, deps, orderStatuses, retired, reports, protectionsRetired }
}

describe('sweepVenueExitOrders', () => {
  it('REGRESSION 2026-09-01: a filled GTC stop becomes a booked exit + closed execution + flat report', async () => {
    const { db, deps, orderStatuses, retired, reports } = mgcScenario()
    orderStatuses.set('stop-64', {
      orderId: 'stop-64',
      state: 'filled',
      filledQuantity: 1,
      averagePrice: 4396.8,
      filledAtMs: STOP_FILL_MS,
    })

    const booked = await sweepVenueExitOrders(deps, 'tradestation')

    expect(booked).toBe(1)
    // Exit fill with the REAL broker price and time, on the entry execution.
    expect(db.fills).toHaveLength(1)
    expect(db.fills[0]).toMatchObject({
      signalId: 'entry-1',
      kind: 'exit',
      side: 'sell',
      qty: 1,
      price: 4396.8,
      orderId: 'stop-64',
      createdAtMs: STOP_FILL_MS,
    })
    // Execution closed; settlement persisted (grace window + idempotence key).
    expect(db.execs[0].status).toBe('closed')
    expect(db.execs[0].qty_closed).toBe(1)
    expect(db.settlements).toHaveLength(1)
    expect(db.settlements[0]).toMatchObject({ targetLabel: 'venue-exit:stop-64', status: 'filled' })
    // Protective state retired + OCO group retired + server told flat.
    expect(db.states[0].active).toBe(0)
    expect(retired).toEqual(['stop-64'])
    expect(reports).toEqual([
      { positionId: 'pos-1', price: 4396.8, timeMs: STOP_FILL_MS, orderId: 'stop-64' },
    ])
  })

  it('is idempotent: a second sweep books nothing', async () => {
    const { db, deps, orderStatuses } = mgcScenario()
    orderStatuses.set('stop-64', {
      orderId: 'stop-64',
      state: 'filled',
      filledQuantity: 1,
      averagePrice: 4396.8,
      filledAtMs: STOP_FILL_MS,
    })
    expect(await sweepVenueExitOrders(deps, 'tradestation')).toBe(1)
    expect(await sweepVenueExitOrders(deps, 'tradestation')).toBe(0)
    expect(db.fills).toHaveLength(1)
  })

  it('leaves a still-working stop alone', async () => {
    const { db, deps, orderStatuses } = mgcScenario()
    orderStatuses.set('stop-64', { orderId: 'stop-64', state: 'working' })
    expect(await sweepVenueExitOrders(deps, 'tradestation')).toBe(0)
    expect(db.fills).toHaveLength(0)
    expect(db.execs[0].status).toBe('open')
    expect(db.states[0].active).toBe(1)
  })

  it('books a partial TP fill without closing the execution', async () => {
    const db = new FakeSweepDb()
    db.execs.push({
      signal_id: 'entry-2',
      symbol: 'MNQZ26',
      exchange: 'tradestation',
      direction: 'long',
      status: 'open',
      qty_opened: 2,
      qty_closed: 0,
      account_id: 'ACC1',
      created_at: 1,
    })
    db.brackets.push({
      signal_id: 'entry-2',
      exchange: 'tradestation',
      sl_order_id: 'sl-1',
      tp_order_id: 'tp-1',
      tp_order_ids: null,
    })
    const deps: VenueExitSweepDeps = {
      db,
      getAdapter: async () => ({
        getOrderStatus: async (orderId: string): Promise<OrderStatus> =>
          orderId === 'tp-1'
            ? { orderId, state: 'partially_filled', filledQuantity: 1, averagePrice: 25000 }
            : { orderId, state: 'working' },
      }),
    }
    expect(await sweepVenueExitOrders(deps, 'tradestation')).toBe(1)
    expect(db.execs[0].status).toBe('open')
    expect(db.execs[0].qty_closed).toBe(1)
    expect(db.fills[0]).toMatchObject({ signalId: 'entry-2', qty: 1, price: 25000 })
  })

  // 2026-09-02 (MNQU26): a close path forgot to retire its server exit state;
  // the sweep then polled the cancelled stop order every tick, forever.
  it('retires lingering protective state of a terminal execution instead of polling forever', async () => {
    const { db, deps, protectionsRetired } = mgcScenario()
    db.execs[0]!.status = 'closed'
    db.execs[0]!.qty_closed = 1
    let polled = 0
    ;(deps as any).getAdapter = async () => ({
      getOrderStatus: async (orderId: string): Promise<OrderStatus> => {
        polled++
        return { orderId, state: 'cancelled' }
      },
    })

    expect(await sweepVenueExitOrders(deps, 'tradestation')).toBe(0)
    expect(polled).toBe(0) // no broker call for a terminal execution
    expect(db.states[0]!.active).toBe(0)
    expect(protectionsRetired).toEqual(['entry-1'])
    // Next tick: the pair row is gone via retireProtections, states inactive →
    // no candidates left to iterate.
    db.brackets.length = 0
    expect(await sweepVenueExitOrders(deps, 'tradestation')).toBe(0)
  })

  it('books a growing partial incrementally and finishes on the full fill', async () => {
    const db = new FakeSweepDb()
    db.execs.push({
      signal_id: 'entry-3',
      symbol: 'BTCUSDT',
      exchange: 'bybit',
      direction: 'long',
      status: 'open',
      qty_opened: 2,
      qty_closed: 0,
      account_id: 'unified',
      created_at: 1,
    })
    db.brackets.push({
      signal_id: 'entry-3',
      exchange: 'bybit',
      sl_order_id: 'sl-x',
      tp_order_id: null,
      tp_order_ids: null,
    })
    let state: OrderStatus = { orderId: 'sl-x', state: 'partially_filled', filledQuantity: 1, averagePrice: 100 }
    const retired: string[] = []
    const deps: VenueExitSweepDeps = {
      db,
      getAdapter: async () => ({ getOrderStatus: async () => state }),
      retireOrderGroup: async (_e, orderId) => {
        retired.push(orderId)
      },
    }

    expect(await sweepVenueExitOrders(deps, 'bybit')).toBe(1)
    expect(db.execs[0].qty_closed).toBe(1)
    expect(db.execs[0].status).toBe('open')
    expect(retired).toHaveLength(0) // partial: the order is still live — group stands

    // Same cum on the next tick → no restack.
    expect(await sweepVenueExitOrders(deps, 'bybit')).toBe(0)

    // Full fill → only the remaining 1 books; execution closes; group retires.
    state = { orderId: 'sl-x', state: 'filled', filledQuantity: 2, averagePrice: 101 }
    expect(await sweepVenueExitOrders(deps, 'bybit')).toBe(1)
    expect(db.fills.map((f) => f.qty)).toEqual([1, 1])
    expect(db.execs[0].status).toBe('closed')
    expect(retired).toEqual(['sl-x'])
  })

  it('collects stop, TP and trail order ids, deduped', () => {
    const db = new FakeSweepDb()
    db.brackets.push({
      signal_id: 's1',
      exchange: 'tradestation',
      sl_order_id: 'o-sl',
      tp_order_id: 'o-tp1',
      tp_order_ids: JSON.stringify(['o-tp1', 'o-tp2']),
    })
    db.trails.push({ signal_id: 's1', exchange: 'tradestation', symbol: 'X', sl_order_id: 'o-trail', active: 1 })
    db.states.push({
      position_id: 'p1',
      entry_signal_id: 's1',
      exchange: 'tradestation',
      symbol: 'X',
      direction: 'long',
      sl_order_id: 'o-sl',
      active: 1,
    })
    const c = collectRestingExitCandidates(db, 'tradestation')
    expect(c.map((x) => x.orderId).sort()).toEqual(['o-sl', 'o-tp1', 'o-tp2', 'o-trail'])
    // The server-state entry wins for the shared stop id (carries positionId).
    expect(c.find((x) => x.orderId === 'o-sl')?.positionId).toBe('p1')
  })
})

describe('adoptVenueClose', () => {
  it('books a vanished position as a close and retires its leftover protections', async () => {
    const { db, deps, reports, protectionsRetired } = mgcScenario()
    const plan = await adoptVenueClose(deps, {
      exchange: 'tradestation',
      accountId: '21084933',
      symbol: 'MGCZ26',
      side: 'sell',
      qty: 1,
    })

    expect(plan).toHaveLength(1)
    expect(db.fills[0]).toMatchObject({
      signalId: 'entry-1',
      kind: 'exit',
      side: 'sell',
      qty: 1,
      price: 4390, // last-price estimate
    })
    expect(db.execs[0].status).toBe('closed')
    expect(db.states[0].active).toBe(0)
    expect(protectionsRetired).toEqual(['entry-1'])
    expect(reports).toHaveLength(1)
    expect(reports[0].positionId).toBe('pos-1')
    // The settlement row feeds the reconciler's recent-exit grace window.
    expect(db.settlements[0]).toMatchObject({ targetLabel: 'venue-adopt', status: 'filled' })
  })

  it('books with a null price when no last price is available', async () => {
    const { db, deps } = mgcScenario()
    ;(deps as any).getAdapter = async () => ({})
    await adoptVenueClose(deps, {
      exchange: 'tradestation',
      accountId: '21084933',
      symbol: 'MGCZ26',
      side: 'sell',
      qty: 1,
    })
    expect(db.fills[0].price).toBeNull()
    expect(db.execs[0].status).toBe('closed')
  })
})

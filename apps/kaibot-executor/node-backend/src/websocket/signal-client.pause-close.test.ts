// 15/10/2026, cel 9 + Fault-Line ETH. (A) A paused sub was invisible to the
// signal path (active-only lookups), so its entries and adds ran with
// sub = null: raw units as contracts, no maxConcurrentTrades. (B) A close
// naming its row kept only the row's entry execution: the adds stayed open at
// the venue while the server closed the row, and an aggregate fraction (row
// share of ALL open rows) was applied a second time to that one entry.
// Real SQLite, fake Deribit.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { KaiBotDatabase } from '../storage/database.js'
import { SignalWebSocketClient } from './signal-client.js'
import type { Signal } from '../storage/types.js'
import type { Order, OrderResult, Position } from '../services/exchanges/types.js'

const BOT = 'bot-cel9'
const SYMBOL = 'ETH-PERPETUAL'
const ACCOUNT = 'eth'

let dir: string
let db: KaiBotDatabase
let acks: any[]
const realFetch = globalThis.fetch

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-pause-close-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
  acks = []
  globalThis.fetch = (async (_url: any, init: any) => {
    acks.push(JSON.parse(init.body))
    return new Response(JSON.stringify({ success: true }), { status: 200 })
  }) as any
})
afterEach(() => {
  globalThis.fetch = realFetch
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

class FakeAdapter {
  name = 'deribit'
  placed: Order[] = []
  cancelled: string[] = []
  positions: Position[] = []
  async getPositions() {
    return this.positions
  }
  async getBalances() {
    return []
  }
  async placeOrder(o: Order): Promise<OrderResult> {
    this.placed.push(o)
    const id = `ord-${this.placed.length}`
    if (o.orderType === 'stop') return { orderId: id, status: 'pending', filledQuantity: 0 }
    return { orderId: id, status: 'filled', filledQuantity: o.quantity, averagePrice: 2400 }
  }
  async cancelOrder(id: string) {
    this.cancelled.push(id)
  }
  markets() {
    return this.placed.filter((o) => o.orderType === 'market')
  }
}

class FakeManager {
  constructor(public adapter: FakeAdapter) {}
  async getSession(_u: string, exchangeName: string) {
    if (exchangeName !== 'deribit') return undefined
    return { adapter: this.adapter, status: 'connected', userId: 'default', exchangeName, connectionId: 'default:deribit' }
  }
}

function build() {
  const adapter = new FakeAdapter()
  const client = new SignalWebSocketClient(db as any, new FakeManager(adapter) as any, null)
  ;(client as any).apiUrl = 'http://api.test'
  ;(client as any).apiKey = 'key'
  return { adapter, client }
}

const handle = (client: SignalWebSocketClient, signal: Signal) => (client as any).handleSignalInner(signal)

function seedSub(status: 'active' | 'paused' | 'cancelled') {
  db.upsertSubscription({
    id: 'local-sub-cel9',
    signalBotId: BOT,
    botName: 'cel 9',
    selectedMarkets: [],
    factor: 0.5,
    maxConcurrentTrades: 10,
    status,
    exchange: 'deribit',
    accountId: ACCOUNT,
  })
}

function signal(over: Partial<Signal> & { metadata?: Record<string, unknown> }): Signal {
  return {
    id: 'sig',
    strategy_id: 'strat-cel9',
    strategy_name: 'cel 9',
    symbol: SYMBOL,
    action: 'buy',
    quantity: 8,
    price: 2400,
    type: 'market',
    received_at: new Date(),
    status: 'pending',
    created_at: new Date(),
    ...over,
    metadata: { exchange: 'deribit', signalBotId: BOT, ...(over.metadata ?? {}) },
  } as Signal
}

// An executed entry or add of a server row, with its open execution.
function seedExecuted(id: string, positionId: string, qty: number, extra: Record<string, unknown> = {}) {
  db.recordSignal({
    id,
    strategyId: 'strat-cel9',
    symbol: SYMBOL,
    action: 'buy',
    quantity: 8,
    metadata: { exchange: 'deribit', signalBotId: BOT, positionId, exitAuthority: 'server', ...extra },
  })
  db.updateSignalStatus(id, 'executed')
  db.insertSignalExecution({
    signalId: id,
    symbol: SYMBOL,
    exchange: 'deribit',
    direction: 'long',
    status: 'open',
    qtyOpened: qty,
    accountId: ACCOUNT,
  })
}

function armRow(positionId: string, entryId: string) {
  db.upsertServerExitState({
    positionId,
    entrySignalId: entryId,
    exchange: 'deribit',
    symbol: SYMBOL,
    direction: 'long',
    currentStop: 2000,
    slOrderId: `sl-${entryId}`,
  })
}

function venueLong(adapter: FakeAdapter, size: number) {
  adapter.positions = [
    { id: `deribit:${SYMBOL}`, accountId: ACCOUNT, symbol: SYMBOL, side: 'long', size, entryPrice: 2400, markPrice: 2410 },
  ]
}

function close(id: string, metadata: Record<string, unknown>): Signal {
  const s = signal({ id, action: 'close', metadata })
  db.recordSignal({ id, strategyId: 'strat-cel9', symbol: SYMBOL, action: 'close', metadata: s.metadata })
  return s
}

const statusOf = (id: string) =>
  (db.get('SELECT status, error_message FROM signals WHERE id = ?', [id]) as any) ?? null

describe('paused subscription: no entries, no adds, closes still run', () => {
  it('refuses an entry, places nothing', async () => {
    seedSub('paused')
    const { adapter, client } = build()
    const s = signal({ id: 'entry-1' })
    db.recordSignal({ id: s.id, strategyId: s.strategy_id, symbol: SYMBOL, action: 'buy', metadata: s.metadata })
    await handle(client, s)

    expect(adapter.placed).toHaveLength(0)
    expect(statusOf('entry-1')).toMatchObject({ status: 'rejected', error_message: 'subscription paused' })
    expect(acks.at(-1)).toMatchObject({ signalId: 'entry-1', status: 'rejected' })
  })

  it('refuses an add on an open row', async () => {
    seedSub('paused')
    seedExecuted('e1', 'row-1', 100)
    armRow('row-1', 'e1')
    const { adapter, client } = build()
    venueLong(adapter, 100)
    const s = signal({ id: 'add-1', metadata: { positionId: 'row-1', add: true, addUnits: 20.48 } })
    db.recordSignal({ id: s.id, strategyId: s.strategy_id, symbol: SYMBOL, action: 'buy', metadata: s.metadata })
    await handle(client, s)

    expect(adapter.placed).toHaveLength(0)
    expect(statusOf('add-1')).toMatchObject({ status: 'rejected', error_message: 'subscription paused' })
    expect(db.getSignalExecution('e1')).toMatchObject({ status: 'open', qty_opened: 100 })
  })

  it('closes an open row on its existing lineage', async () => {
    seedSub('paused')
    seedExecuted('e1', 'row-1', 100)
    seedExecuted('a1', 'row-1', 60, { add: true })
    armRow('row-1', 'e1')
    const { adapter, client } = build()
    venueLong(adapter, 160)
    await handle(client, close('close-1', { positionId: 'row-1', fraction: 1, closeKind: 'aggregate' }))

    expect(adapter.markets()).toHaveLength(1)
    expect(adapter.markets()[0]).toMatchObject({ symbol: SYMBOL, side: 'sell', quantity: 160, reduceOnly: true })
    expect(db.getSignalExecution('e1')!.status).toBe('closed')
    expect(db.getSignalExecution('a1')!.status).toBe('closed')
    expect(acks.at(-1)).toMatchObject({ signalId: 'close-1', status: 'executed' })
  })

  it('a bot signal without any subscription is refused, not sized raw', async () => {
    const { adapter, client } = build()
    const s = signal({ id: 'entry-nosub' })
    db.recordSignal({ id: s.id, strategyId: s.strategy_id, symbol: SYMBOL, action: 'buy', metadata: s.metadata })
    await handle(client, s)

    expect(adapter.placed).toHaveLength(0)
    expect(statusOf('entry-nosub')).toMatchObject({ status: 'rejected', error_message: 'no subscription for this bot' })
  })
})

describe('close with positionId closes the whole row lineage', () => {
  it('entry + 2 adds: all three close in one order', async () => {
    seedSub('active')
    seedExecuted('e1', 'row-1', 100)
    seedExecuted('a1', 'row-1', 60, { add: true })
    seedExecuted('a2', 'row-1', 40, { add: true })
    armRow('row-1', 'e1')
    const { adapter, client } = build()
    venueLong(adapter, 200)
    await handle(client, close('close-1', { positionId: 'row-1', fraction: 1, closeKind: 'aggregate' }))

    expect(adapter.markets()).toHaveLength(1)
    expect(adapter.markets()[0]).toMatchObject({ side: 'sell', quantity: 200, reduceOnly: true })
    for (const id of ['e1', 'a1', 'a2']) {
      expect(db.getSignalExecution(id)).toMatchObject({ status: 'closed' })
    }
    expect(db.getSignalExecution('e1')!.qty_closed + db.getSignalExecution('a1')!.qty_closed + db.getSignalExecution('a2')!.qty_closed).toBe(200)
  })

  it('a partial fraction 0.5 closes half of the lineage sum', async () => {
    seedSub('active')
    seedExecuted('e1', 'row-1', 100)
    seedExecuted('a1', 'row-1', 60, { add: true })
    seedExecuted('a2', 'row-1', 40, { add: true })
    armRow('row-1', 'e1')
    const { adapter, client } = build()
    venueLong(adapter, 200)
    await handle(client, close('close-1', { positionId: 'row-1', fraction: 0.5 }))

    expect(adapter.markets()).toHaveLength(1)
    expect(adapter.markets()[0]).toMatchObject({ side: 'sell', quantity: 100, reduceOnly: true })
  })

  it('two rows on the symbol: an aggregate close takes only its own row, whole', async () => {
    seedSub('active')
    // Fault-Line ETH shape: row-1 (entry + add) next to row-2; the server's
    // aggregate fraction is row-1's share of both rows.
    seedExecuted('e1', 'row-1', 100)
    seedExecuted('a1', 'row-1', 50, { add: true })
    seedExecuted('e2', 'row-2', 100)
    armRow('row-1', 'e1')
    armRow('row-2', 'e2')
    const { adapter, client } = build()
    venueLong(adapter, 250)
    await handle(client, close('close-1', { positionId: 'row-1', fraction: 0.6, closeKind: 'aggregate' }))

    expect(adapter.markets()).toHaveLength(1)
    expect(adapter.markets()[0]).toMatchObject({ side: 'sell', quantity: 150, reduceOnly: true })
    expect(db.getSignalExecution('e1')!.status).toBe('closed')
    expect(db.getSignalExecution('a1')!.status).toBe('closed')
    expect(db.getSignalExecution('e2')).toMatchObject({ status: 'open', qty_closed: 0 })
    expect(adapter.cancelled).not.toContain('sl-e2')
  })
})

describe('close of a row the account no longer holds', () => {
  it('never falls back to the sibling row on that account', async () => {
    seedSub('active')
    // acct1 15/10: row-2's stop filled and was booked, row-1 is still open.
    seedExecuted('e1', 'row-1', 601)
    armRow('row-1', 'e1')
    const { adapter, client } = build()
    venueLong(adapter, 601)
    await handle(client, close('close-row2', { positionId: 'row-2', fraction: 1, closeKind: 'aggregate' }))

    expect(adapter.markets()).toHaveLength(0)
    expect(db.getSignalExecution('e1')).toMatchObject({ status: 'open', qty_closed: 0 })
    expect(acks.at(-1)).toMatchObject({ signalId: 'close-row2', status: 'executed' })
  })
})

describe('Fault-Line ETH shape: two rows fanned out over two Deribit accounts', () => {
  // Live 15/10: row-1 (16:04) and row-2 (04:02), 986 on 'eth' and 601 on
  // 'acct1/eth' each. The server closes row-1 with fraction 8/16 aggregate.
  class TwoConnections {
    constructor(public dflt: FakeAdapter, public acct1: FakeAdapter) {}
    async getSession(_u: string, exchangeName: string, accountKey?: string) {
      if (exchangeName !== 'deribit') return undefined
      if (!accountKey) return { adapter: this.dflt, status: 'connected', userId: 'default', exchangeName, label: 'default', connectionId: 'default:deribit' }
      if (accountKey === 'acct1') return { adapter: this.acct1, status: 'connected', userId: 'default', exchangeName, label: 'acct1', accountKey, connectionId: 'default:deribit:acct1' }
      return undefined
    }
  }

  function seedLeg(id: string, positionId: string, qty: number, accountId: string, child?: { of: string; sub: string }) {
    db.recordSignal({
      id,
      strategyId: 'strat-fl',
      symbol: SYMBOL,
      action: 'buy',
      quantity: 8,
      metadata: {
        exchange: 'deribit', signalBotId: BOT, positionId, exitAuthority: 'server',
        ...(child ? { fanoutOf: child.of, fanoutSubscriptionId: child.sub } : {}),
      },
    })
    db.updateSignalStatus(id, 'executed')
    db.insertSignalExecution({ signalId: id, symbol: SYMBOL, exchange: 'deribit', direction: 'long', status: 'open', qtyOpened: qty, accountId })
  }

  it('the row closes whole on both accounts, the sibling row stays', async () => {
    const { deriveFanoutId } = await import('../services/fanout.js')
    db.upsertSubscription({ id: 'sub-eth', signalBotId: BOT, selectedMarkets: [], factor: 1, status: 'active', exchange: 'deribit' })
    db.upsertSubscription({ id: 'sub-acct1', signalBotId: BOT, selectedMarkets: [], factor: 1, status: 'active', exchange: 'deribit', accountKey: 'acct1' })
    for (const [row, entry] of [['row-1', 'e1'], ['row-2', 'e2']] as const) {
      const child = deriveFanoutId(entry, 'sub-acct1')
      seedLeg(entry, row, 986, 'eth')
      seedLeg(child, row, 601, 'acct1/eth', { of: entry, sub: 'sub-acct1' })
      armRow(row, entry)
      db.upsertServerExitState({ positionId: deriveFanoutId(row, 'sub-acct1'), entrySignalId: child, exchange: 'deribit', symbol: SYMBOL, direction: 'long', currentStop: 2000, slOrderId: `sl-${child}` })
    }
    const dflt = new FakeAdapter()
    const acct1 = new FakeAdapter()
    dflt.positions = [{ id: `deribit:${SYMBOL}`, accountId: 'eth', symbol: SYMBOL, side: 'long', size: 1972, entryPrice: 2400, markPrice: 2410 }]
    acct1.positions = [{ id: `deribit:${SYMBOL}@acct1`, accountId: 'acct1/eth', symbol: SYMBOL, side: 'long', size: 1202, entryPrice: 2400, markPrice: 2410 }]
    const client = new SignalWebSocketClient(db as any, new TwoConnections(dflt, acct1) as any, null)
    ;(client as any).apiUrl = 'http://api.test'
    ;(client as any).apiKey = 'key'

    await handle(client, close('close-fl', { positionId: 'row-1', fraction: 0.5, closeKind: 'aggregate' }))

    expect(dflt.markets().map((o) => [o.side, o.quantity])).toEqual([['sell', 986]])
    expect(acct1.markets().map((o) => [o.side, o.quantity])).toEqual([['sell', 601]])
    expect(db.getSignalExecution('e1')!.status).toBe('closed')
    expect(db.getSignalExecution(deriveFanoutId('e1', 'sub-acct1'))!.status).toBe('closed')
    expect(db.getSignalExecution('e2')).toMatchObject({ status: 'open', qty_closed: 0 })
    expect(db.getSignalExecution(deriveFanoutId('e2', 'sub-acct1'))).toMatchObject({ status: 'open', qty_closed: 0 })
  })
})

// Prod 24/09 17:00 UTC: Regime-Slow MES 30m fired buy @7779.25; the executor
// placed ONE order on 21084931 and nothing on 21084933 / 21084936 although both
// had an active subscription on the same bot since 23/09. Entry fan-out: every
// active subscription of the bot runs the entry on its own account, one ack
// per wire signal with the per-account outcomes. Real SQLite, fake broker.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { KaiBotDatabase } from '../storage/database.js'
import { SignalWebSocketClient } from './signal-client.js'
import { deriveFanoutId } from '../services/fanout.js'
import type { Signal } from '../storage/types.js'
import type { Order, OrderResult, Position } from '../services/exchanges/types.js'

const BOT = 'bot-regime-slow-mes'
const ACCOUNTS = ['21084931', '21084933', '21084936'] as const
const SUB = (a: string) => `sub-${a}`
const WIRE = 'e2c1c0de-0000-4000-8000-000000000001'

let dir: string
let db: KaiBotDatabase
let acks: any[]
const realFetch = globalThis.fetch

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-fanout-'))
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

// One TradeStation session, several AccountIDs behind it: the order carries
// the account. `failOn` makes the broker refuse one account.
class FakeAdapter {
  name = 'tradestation'
  alwaysOpen = true
  placed: Order[] = []
  cancelled: string[] = []
  positions: Position[] = []
  failOn: string | null = null
  marketOpen = true
  now = Date.now()
  async getPositions() {
    return this.positions
  }
  async getBalances() {
    return []
  }
  async placeOrder(o: Order): Promise<OrderResult> {
    if (this.failOn && o.accountId === this.failOn) throw new Error('broker down for this account')
    this.placed.push(o)
    const id = `ord-${o.accountId}-${this.placed.length}`
    if (o.orderType === 'stop') return { orderId: id, status: 'pending', filledQuantity: 0 }
    return { orderId: id, status: 'filled', filledQuantity: o.quantity, averagePrice: o.price ?? 7780 }
  }
  async cancelOrder(id: string) {
    this.cancelled.push(id)
  }
  mains() {
    return this.placed.filter((o) => o.orderType !== 'stop' && !o.reduceOnly)
  }
  stops() {
    return this.placed.filter((o) => o.orderType === 'stop')
  }
  closes() {
    return this.placed.filter((o) => o.orderType === 'market' && o.reduceOnly)
  }
}

class FakeManager {
  constructor(public adapter: FakeAdapter) {}
  async getSession(_u: string, exchangeName: string) {
    if (exchangeName !== 'tradestation') return undefined
    return { adapter: this.adapter, status: 'connected', userId: 'default', exchangeName, connectionId: 'default:tradestation' }
  }
}

function seedSubs(accounts: readonly string[], patch: Record<string, Partial<Parameters<KaiBotDatabase['upsertSubscription']>[0]>> = {}) {
  for (const a of accounts) {
    db.upsertSubscription({
      id: SUB(a),
      signalBotId: BOT,
      botName: '[ALLOC] Regime-Slow MES 30m',
      selectedMarkets: [],
      factor: 1,
      status: 'active',
      exchange: 'tradestation',
      accountId: a,
      ...(patch[a] ?? {}),
    })
  }
}

function entry(over: Partial<Signal> = {}): Signal {
  return {
    id: WIRE,
    strategy_id: 'regime-slow',
    strategy_name: 'Regime-Slow MES 30m',
    symbol: 'MES',
    action: 'buy',
    quantity: 1,
    price: 7779.25,
    type: 'market',
    stop_loss: 7770,
    metadata: { exchange: 'tradestation', signalBotId: BOT },
    received_at: new Date(),
    status: 'pending',
    created_at: new Date(),
    ...over,
  } as Signal
}

function build() {
  const adapter = new FakeAdapter()
  const client = new SignalWebSocketClient(db as any, new FakeManager(adapter) as any, null)
  ;(client as any).apiUrl = 'http://api.test'
  ;(client as any).apiKey = 'key'
  return { adapter, client }
}

const handle = (client: SignalWebSocketClient, signal: Signal) => (client as any).handleSignalInner(signal)

const childId = (account: string) => deriveFanoutId(WIRE, SUB(account))
const lineageIds = () => [WIRE, childId('21084933'), childId('21084936')]

function openPositions(adapter: FakeAdapter) {
  adapter.positions = ACCOUNTS.map((a) => ({
    id: `tradestation:${a}:MES`,
    accountId: a,
    symbol: 'MES',
    side: 'long',
    size: 1,
    entryPrice: 7780,
    markPrice: 7790,
  }))
}

describe('entry fan-out over every active subscription of the bot', () => {
  it('three subs: one order, one stop and one execution per account, one ack', async () => {
    seedSubs(ACCOUNTS)
    const { adapter, client } = build()
    await handle(client, entry())

    expect(adapter.mains().map((o) => o.accountId)).toEqual([...ACCOUNTS])
    expect(adapter.stops().map((o) => o.accountId)).toEqual([...ACCOUNTS])
    for (const o of adapter.mains()) expect(o).toMatchObject({ symbol: 'MES', side: 'buy', quantity: 1 })

    // Three lineages: the wire id on the first sub, derived ids on the others.
    const execs = lineageIds().map((id) => db.getSignalExecution(id)!)
    expect(execs.map((e) => e.account_id)).toEqual([...ACCOUNTS])
    expect(execs.every((e) => e.status === 'open' && e.qty_opened === 1)).toBe(true)
    expect(db.listFanoutChildSignalIds(WIRE)).toEqual([childId('21084933'), childId('21084936')])
    expect(db.listBracketPairs().map((b) => b.account_id).sort()).toEqual([...ACCOUNTS])

    // One ack, under the wire id, every account in it.
    expect(acks).toHaveLength(1)
    expect(acks[0]).toMatchObject({ signalId: WIRE, status: 'executed', tradeId: 'ord-21084931-1' })
    expect(acks[0].accounts.map((a: any) => [a.accountId, a.status, a.orderId])).toEqual([
      ['21084931', 'executed', 'ord-21084931-1'],
      ['21084933', 'executed', 'ord-21084933-3'],
      ['21084936', 'executed', 'ord-21084936-5'],
    ])
    expect(acks[0].accounts.every((a: any) => !('size' in a) && !('fillSize' in a))).toBe(true)

    // The wire row carries the outcomes; the feed shows one row.
    const row = db.get('SELECT status, error_message, account_outcomes FROM signals WHERE id = ?', [WIRE]) as any
    expect(row.status).toBe('executed')
    expect(row.error_message).toBe('executed on 3 accounts')
    expect(JSON.parse(row.account_outcomes)).toHaveLength(3)
    expect(db.getRecentSignals(50).map((s: any) => s.id)).toEqual([WIRE])
    expect(db.getSignalsForSubscription(SUB('21084933')).map((s: any) => s.id)).toEqual([WIRE])
  })

  it('one account fails: the other two fill, the ack is executed and names the failure', async () => {
    seedSubs(ACCOUNTS)
    const { adapter, client } = build()
    adapter.failOn = '21084933'
    await handle(client, entry())

    expect(adapter.mains().map((o) => o.accountId)).toEqual(['21084931', '21084936'])
    expect(adapter.stops().map((o) => o.accountId)).toEqual(['21084931', '21084936'])
    expect(db.getSignalExecution(childId('21084933'))).toMatchObject({ status: 'error', qty_opened: 0 })
    expect(db.getSignalExecution(childId('21084936'))).toMatchObject({ status: 'open', account_id: '21084936' })

    expect(acks).toHaveLength(1)
    expect(acks[0]).toMatchObject({ signalId: WIRE, status: 'executed' })
    expect(acks[0].accounts.map((a: any) => [a.accountId, a.status])).toEqual([
      ['21084931', 'executed'],
      ['21084933', 'rejected'],
      ['21084936', 'executed'],
    ])
    expect(acks[0].accounts[1].reason).toBe('broker down for this account')
    expect(db.getSignalStatus(WIRE)).toBe('executed')
    expect((db.get('SELECT error_message FROM signals WHERE id = ?', [WIRE]) as any).error_message).toBe(
      'executed on 2 of 3 accounts',
    )
    expect(db.getSignalStatus(childId('21084933'))).toBe('rejected')
  })

  it('every account refused → one rejected ack with the reason', async () => {
    seedSubs(ACCOUNTS)
    const { adapter, client } = build()
    await handle(client, entry({ quantity: 0 }))
    expect(adapter.placed).toHaveLength(0)
    expect(acks).toHaveLength(1)
    expect(acks[0]).toMatchObject({ signalId: WIRE, status: 'rejected', errorMessage: 'invalid quantity' })
    expect(acks[0].accounts.every((a: any) => a.status === 'rejected')).toBe(true)
    expect(db.getSignalStatus(WIRE)).toBe('rejected')
  })

  it('a single subscription is the plain path: one order, no derived ids, no accounts on the ack', async () => {
    seedSubs(['21084931'])
    const { adapter, client } = build()
    await handle(client, entry())
    expect(adapter.mains()).toHaveLength(1)
    expect(adapter.stops()).toHaveLength(1)
    expect(db.getSignalExecution(WIRE)).toMatchObject({ account_id: '21084931', status: 'open' })
    expect(db.listFanoutChildSignalIds(WIRE)).toEqual([])
    expect(acks).toHaveLength(1)
    expect(acks[0]).toMatchObject({ signalId: WIRE, status: 'executed', tradeId: 'ord-21084931-1' })
    expect('accounts' in acks[0]).toBe(false)
    expect((db.get('SELECT account_outcomes FROM signals WHERE id = ?', [WIRE]) as any).account_outcomes).toBeNull()
  })

  it('the market filter is per subscription', async () => {
    seedSubs(ACCOUNTS, { '21084933': { selectedMarkets: ['MNQ'] } })
    const { adapter, client } = build()
    await handle(client, entry())
    expect(adapter.mains().map((o) => o.accountId)).toEqual(['21084931', '21084936'])
    expect(acks[0].accounts.map((a: any) => [a.accountId, a.status, a.reason])).toEqual([
      ['21084931', 'executed', null],
      ['21084933', 'rejected', 'symbol not in selected markets'],
      ['21084936', 'executed', null],
    ])
    expect(db.getSignalExecution(childId('21084933'))).toBeFalsy()
  })

  it('a redelivered signal opens nothing on any account and acks nothing again', async () => {
    seedSubs(ACCOUNTS)
    const { adapter, client } = build()
    await handle(client, entry())
    await handle(client, entry())
    expect(adapter.mains()).toHaveLength(3)
    expect(adapter.stops()).toHaveLength(3)
    expect(acks).toHaveLength(1)
    for (const id of lineageIds()) {
      expect(db.listSignalQueue(id).map((q: any) => q.reason)).toContain('duplicate_open')
    }
    expect(db.getSignalStatus(WIRE)).toBe('executed')
  })

  it('a bot close flattens every account that holds a lineage, one close per account', async () => {
    seedSubs(ACCOUNTS)
    const { adapter, client } = build()
    await handle(client, entry())
    openPositions(adapter)
    const stopIds = adapter.stops().map((o) => `ord-${o.accountId}-${adapter.placed.indexOf(o) + 1}`)

    await handle(
      client,
      entry({
        id: 'close-1',
        action: 'close',
        quantity: 1,
        stop_loss: undefined,
        metadata: { exchange: 'tradestation', signalBotId: BOT },
      }),
    )

    expect(adapter.closes().map((o) => [o.accountId, o.side, o.quantity])).toEqual([
      ['21084931', 'sell', 1],
      ['21084933', 'sell', 1],
      ['21084936', 'sell', 1],
    ])
    for (const id of stopIds) expect(adapter.cancelled).toContain(id)
    for (const id of lineageIds()) {
      expect(db.getSignalExecution(id)).toMatchObject({ status: 'closed', qty_closed: 1 })
      expect(db.getSignalStatus(id)).toBe('closed')
    }
    expect(acks).toHaveLength(2)
    expect(acks[1]).toMatchObject({ signalId: 'close-1', status: 'executed' })
    expect(acks[1].accounts.map((a: any) => [a.accountId, a.status])).toEqual([
      ['21084931', 'executed'],
      ['21084933', 'executed'],
      ['21084936', 'executed'],
    ])
    expect(db.getSignalStatus('close-1')).toBe('executed')
  })

  it('a server stop update moves the resting stop on every account', async () => {
    seedSubs(ACCOUNTS)
    const { adapter, client } = build()
    await handle(
      client,
      entry({ metadata: { exchange: 'tradestation', signalBotId: BOT, exitAuthority: 'server', positionId: 'pos-1' } }),
    )
    openPositions(adapter)
    const family = db.listServerExitStatesForFamily('pos-1')
    expect(family.map((s) => [s.entry_signal_id, s.current_stop])).toEqual(
      lineageIds().map((id) => [id, 7770]),
    )
    const oldStops = family.map((s) => s.sl_order_id!)

    await handle(
      client,
      entry({
        id: 'upd-1',
        action: 'update' as any,
        price: 7775,
        stop_loss: undefined,
        metadata: { exchange: 'tradestation', signalBotId: BOT, positionId: 'pos-1', exitSeq: 1 },
      }),
    )

    for (const id of oldStops) expect(adapter.cancelled).toContain(id)
    const newStops = adapter.stops().slice(3)
    expect(newStops.map((o) => [o.accountId, o.stopPrice])).toEqual(ACCOUNTS.map((a) => [a, 7775]))
    for (const s of db.listServerExitStatesForFamily('pos-1')) {
      expect(s.current_stop).toBe(7775)
      expect(s.last_exit_seq).toBe(1)
      expect(oldStops).not.toContain(s.sl_order_id)
    }
    expect(acks[1]).toMatchObject({ signalId: 'upd-1', status: 'executed' })
    expect(acks[1].accounts).toHaveLength(3)
  })

  it('a venue exit on one account stays local until the last account is flat', async () => {
    seedSubs(ACCOUNTS)
    const { client } = build()
    await handle(
      client,
      entry({ metadata: { exchange: 'tradestation', signalBotId: BOT, exitAuthority: 'server', positionId: 'pos-1' } }),
    )
    const family = db.listServerExitStatesForFamily('pos-1')
    const fill = { price: 7770, timeMs: Date.now(), orderId: 'x' }
    db.deactivateServerExitState(family[1]!.position_id)
    await client.reportVenueExitToApi(family[1]!.position_id, fill)
    expect(acks).toHaveLength(1)
    db.deactivateServerExitState(family[0]!.position_id)
    await client.reportVenueExitToApi(family[0]!.position_id, fill)
    expect(acks).toHaveLength(1)
    db.deactivateServerExitState(family[2]!.position_id)
    await client.reportVenueExitToApi(family[2]!.position_id, fill)
    expect(acks).toHaveLength(2)
    expect(acks[1]).toMatchObject({ positionId: 'pos-1', fillPrice: 7770 })
  })

  it('a closed venue parks one deferred entry per subscription and resumes each on its own sub', async () => {
    seedSubs(ACCOUNTS)
    const { adapter, client } = build()
    adapter.alwaysOpen = false
    let nowMs = Date.UTC(2026, 8, 23, 21, 30) // Wednesday, Globex pause
    client.setClock(() => nowMs)
    ;(adapter as any).getMarketStatus = async (symbols: string[]) =>
      new Map(symbols.map((s) => [s, { tradeTimeMs: adapter.marketOpen ? nowMs : nowMs - 3_600_000 }]))
    adapter.marketOpen = false

    await handle(client, entry())
    expect(adapter.placed).toHaveLength(0)
    const waiting = db.listWaitingDeferredEntries()
    expect(waiting.map((r) => [r.signal_id, r.subscription_id, r.account_id])).toEqual(
      ACCOUNTS.map((a, i) => [i === 0 ? WIRE : childId(a), SUB(a), a]),
    )
    expect(acks).toHaveLength(1)
    expect(acks[0]).toMatchObject({ signalId: WIRE, status: 'deferred' })
    expect(acks[0].accounts.every((a: any) => a.status === 'deferred')).toBe(true)
    expect(db.getSignalStatus(WIRE)).toBe('deferred')

    adapter.marketOpen = true
    nowMs += 60 * 60_000
    const tick = await client.checkDeferredEntries()
    expect(tick.resumed.sort()).toEqual(lineageIds().sort())
    expect(adapter.mains().map((o) => o.accountId).sort()).toEqual([...ACCOUNTS].sort())
    for (const id of lineageIds()) expect(db.getSignalExecution(id)).toMatchObject({ status: 'open' })
    // Every resumed lineage reports under the wire id; the server no-ops
    // the repeats.
    const later = acks.slice(1)
    expect(later).toHaveLength(3)
    expect(later.every((a) => a.signalId === WIRE && a.status === 'executed')).toBe(true)
    expect(db.listWaitingDeferredEntries()).toHaveLength(0)
  })
})

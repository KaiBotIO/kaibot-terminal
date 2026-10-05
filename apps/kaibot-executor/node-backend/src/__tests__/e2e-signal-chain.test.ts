// End-to-end signal chain: webapp/API signal → executor → paper exchange → ack
// → API marks signal/position. Exercises the REAL pieces on both sides:
//
//   producer:  Postgres `signals` + `positions` rows (mirrors the tRPC
//              createDiscretionary producer) and the wire-format signal object.
//   transport: the signal object is handed to the real SignalWebSocketClient's
//              signal handler directly. The WS frame is the only thing not sent
//              over a socket; the message-flow (recordSignal → execute → ack) is
//              byte-for-byte what handleMessage('signal') dispatches.
//   executor:  real SignalWebSocketClient + real KaiBotDatabase (in-memory
//              SQLite) + the PaperExchangeAdapter. Fills, brackets, settlement,
//              idempotency and the close path all run for real.
//   ack:       the executor POSTs to /api/signals/ack over real HTTP against the
//              real ack route (apps/api/src/routes/signals.ts) mounted on a Bun
//              server, authed via resolveSessionAuth (session-token MVP path).
//   sink:      the ack route updates the Postgres `signals` + `positions` rows;
//              the test asserts the resulting state on BOTH sides.
//
// DB: uses the Postgres dev DB (DATABASE_URL). A dedicated test user is created
// and every row this test writes is removed in afterAll.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { KaiBotDatabase } from '../storage/database.js'
import { SignalWebSocketClient } from '../websocket/signal-client.js'
import { PaperExchangeAdapter } from '../services/exchanges/adapters/paper.js'
import { computeSignalPnl } from '../services/pnl.js'
import type { Signal } from '../storage/types.js'

// ── API side (real ack route + Postgres) ──────────────────────────────────
import { Hono } from 'hono'

// Needs a live Postgres (DATABASE_URL). CI runs without one, so the whole suite
// must SKIP there. The Postgres-touching modules are imported LAZILY inside the
// gated beforeAll: a static import of the API route / pg client opens a
// database connection at module-load time, which hangs or fails the file (and
// exits CI red) even though every test is skipped.
const HAS_DB = !!process.env.DATABASE_URL

let db: any
let signalsTable: any
let positionsTable: any
let positionGroups: any
let users: any
let eq: any
let inArray: any

const SYMBOL = 'BTC-PERPETUAL'
const EXCHANGE = 'deribit'
const SESSION_TOKEN = 'tradestation:e2e-chain@kaibot.test'
const TEST_EMAIL = 'e2e-chain@kaibot.test'

let testUserId: string
let groupId: string
let ackServer: ReturnType<typeof Bun.serve>
let apiBaseUrl: string

const createdSignalIds = new Set<string>()
const createdPositionIds = new Set<string>()

// ── minimal in-process exchange-manager shaped session provider ────────────
class FakeManager {
  adapter: PaperExchangeAdapter
  status: 'connected' | 'disconnected' = 'connected'
  constructor(adapter: PaperExchangeAdapter) {
    this.adapter = adapter
  }
  async getSession() {
    return { adapter: this.adapter, status: this.status, userId: 'default', exchangeName: this.adapter.name }
  }
}

// ── producer: insert a pending signal + pending position, return wire signal ─
async function produceEntrySignal(opts: {
  side: 'buy' | 'sell'
  quantity: number
  price: number
  stopLoss?: number
  takeProfit?: number
}): Promise<{ signalId: string; positionId: string; wire: Signal }> {
  const signalId = crypto.randomUUID()
  const positionId = crypto.randomUUID()
  createdSignalIds.add(signalId)
  createdPositionIds.add(positionId)

  await db.insert(signalsTable).values({
    id: signalId,
    userId: testUserId,
    source: 'discretionary',
    strategyName: 'Discretionary Position',
    exchange: EXCHANGE,
    symbol: SYMBOL,
    action: opts.side,
    quantity: String(opts.quantity),
    price: String(opts.price),
    orderType: 'market',
    stopLoss: opts.stopLoss !== undefined ? String(opts.stopLoss) : null,
    takeProfit: opts.takeProfit !== undefined ? String(opts.takeProfit) : null,
    status: 'pending',
    metadata: { source: 'discretionary', userId: testUserId },
  })

  await db.insert(positionsTable).values({
    id: positionId,
    userId: testUserId,
    signalId,
    positionGroupId: groupId,
    source: 'discretionary',
    currentManager: { kind: 'manual' },
    exchange: EXCHANGE,
    symbol: SYMBOL,
    side: opts.side === 'buy' ? 'long' : 'short',
    status: 'pending',
    avgPrice: null,
    size: String(opts.quantity),
    stopLoss: opts.stopLoss !== undefined ? String(opts.stopLoss) : null,
    takeProfit: opts.takeProfit !== undefined ? String(opts.takeProfit) : null,
    market: true,
  })

  const wire: Signal = {
    id: signalId,
    strategy_id: 'discretionary',
    strategy_name: 'Discretionary Position',
    symbol: SYMBOL,
    action: opts.side,
    quantity: opts.quantity,
    type: 'market',
    price: opts.price,
    stop_loss: opts.stopLoss,
    take_profit: opts.takeProfit,
    metadata: { exchange: EXCHANGE, source: 'discretionary', userId: testUserId },
    received_at: new Date(),
    status: 'pending',
    created_at: new Date(),
  } as Signal

  return { signalId, positionId, wire }
}

// A close signal carries metadata.positionId — this is the field the ack route
// reads to close the linked Postgres position (positions link to their ENTRY
// signal, so the close can't be matched by its own signalId).
async function produceCloseSignal(positionId: string): Promise<{ signalId: string; wire: Signal }> {
  const signalId = crypto.randomUUID()
  createdSignalIds.add(signalId)

  await db.insert(signalsTable).values({
    id: signalId,
    userId: testUserId,
    source: 'discretionary',
    strategyName: 'Discretionary Close',
    exchange: EXCHANGE,
    symbol: SYMBOL,
    action: 'close',
    quantity: String(1),
    price: null,
    orderType: 'market',
    status: 'pending',
    metadata: { source: 'discretionary', userId: testUserId, positionId },
  })

  const wire: Signal = {
    id: signalId,
    strategy_id: 'discretionary',
    strategy_name: 'Discretionary Close',
    symbol: SYMBOL,
    action: 'close',
    quantity: 1,
    type: 'market',
    metadata: { exchange: EXCHANGE, source: 'discretionary', userId: testUserId, positionId },
    received_at: new Date(),
    status: 'pending',
    created_at: new Date(),
  } as Signal

  return { signalId, wire }
}

// Deliver a signal exactly as handleMessage('signal') would, then wait for the
// executor's async ack round-trip (fetch to the ack server) to complete.
async function deliver(client: SignalWebSocketClient, wire: Signal) {
  await (client as any).handleSignal(wire)
}

async function getApiSignal(id: string) {
  const [row] = await db.select().from(signalsTable).where(eq(signalsTable.id, id)).limit(1)
  return row
}
async function getApiPosition(id: string) {
  const [row] = await db.select().from(positionsTable).where(eq(positionsTable.id, id)).limit(1)
  return row
}

// ── lifecycle ──────────────────────────────────────────────────────────────

// Each scenario gets a fresh executor DB + paper adapter so executor-side state
// (signal_executions, fills) never leaks between scenarios.
function freshExecutor(marks: Record<string, number> = { [SYMBOL]: 60000 }) {
  const dir = mkdtempSync(join(tmpdir(), 'kaibot-e2e-'))
  const execDb = new KaiBotDatabase(join(dir, 'exec.db'))
  const adapter = new PaperExchangeAdapter(EXCHANGE, marks)
  const manager = new FakeManager(adapter)
  const client = new SignalWebSocketClient(execDb as any, manager as any, null)
  ;(client as any).apiUrl = apiBaseUrl // enable the ack fetch
  client.setSettleOptions(3, 5) // keep any settle polling fast
  return { dir, execDb, adapter, manager, client }
}

// Skips without a live Postgres — the hooks live INSIDE the gated describe so a
// DB-less run (CI) never opens a Postgres connection or seeds rows.
describe.skipIf(!HAS_DB)('E2E signal chain (API ↔ executor ↔ paper exchange)', () => {
  beforeAll(async () => {
    // Lazy imports — see the note at the top of the file.
    const drizzle = await import('drizzle-orm')
    eq = drizzle.eq
    inArray = drizzle.inArray
    const pg = await import('@kaibot/db-postgres')
    db = pg.db
    signalsTable = pg.signals
    positionsTable = pg.positions
    positionGroups = pg.positionGroups
    users = pg.users
    const { default: signalsRoutes } = await import('../../../../api/src/routes/signals.ts')

    // The ack route + WS auth derive the user from the session token via
    // resolveSessionAuth, which prefers EXECUTOR_USER_EMAIL, else strips the
    // "tradestation:" prefix. Wire both env vars to our test user's email and
    // have the executor send that session token.
    process.env.COUCHDB_TS_SESSION_ID = SESSION_TOKEN
    process.env.EXECUTOR_USER_EMAIL = TEST_EMAIL
    process.env.EXECUTOR_SESSION_TOKEN = SESSION_TOKEN

    // Dedicated test user (id required: it's a text PK with no default).
    testUserId = `e2e-chain-${crypto.randomUUID()}`
    await db.insert(users).values({
      id: testUserId,
      email: TEST_EMAIL,
      normalizedEmail: TEST_EMAIL.toLowerCase(),
    } as any)

    groupId = `e2e-grp-${crypto.randomUUID()}`
    await db.insert(positionGroups).values({
      id: groupId,
      userId: testUserId,
      name: 'E2E Default',
      source: 'discretionary',
      isDefault: true,
    })

    // Mount the real ack route under the same path the app uses (/api/signals)
    // on a Bun server; the executor POSTs to ${apiUrl}/api/signals/ack.
    const ackApp = new Hono()
    ackApp.route('/api/signals', signalsRoutes as any)
    ackServer = Bun.serve({
      port: 3460,
      fetch: (req) => ackApp.fetch(req),
    })
    apiBaseUrl = `http://localhost:${ackServer.port}`
  })

  afterAll(async () => {
    ackServer?.stop(true)
    if (!db) return
    // Clean up every row this test created (positions first → FK to signals/users).
    if (createdPositionIds.size > 0) {
      await db.delete(positionsTable).where(inArray(positionsTable.id, [...createdPositionIds]))
    }
    if (createdSignalIds.size > 0) {
      await db.delete(signalsTable).where(inArray(signalsTable.id, [...createdSignalIds]))
    }
    await db.delete(positionsTable).where(eq(positionsTable.userId, testUserId))
    await db.delete(signalsTable).where(eq(signalsTable.userId, testUserId))
    await db.delete(positionGroups).where(eq(positionGroups.userId, testUserId))
    await db.delete(users).where(eq(users.id, testUserId))
  })

  let env: ReturnType<typeof freshExecutor>
  beforeEach(() => {
    env = freshExecutor()
  })

  it('(a) entry signal → paper fill → ack → signal executed + position open at fill price', async () => {
    const { signalId, positionId, wire } = await produceEntrySignal({ side: 'buy', quantity: 10, price: 60000 })
    await deliver(env.client, wire)

    // Executor side: execution recorded open, entry fill at the mark.
    const exec = env.execDb.getSignalExecution(signalId)
    expect(exec?.status).toBe('open')
    expect(exec?.qty_opened).toBe(10)
    const fills = env.execDb.getSignalFills(signalId)
    expect(fills).toHaveLength(1)
    expect(fills[0]).toMatchObject({ kind: 'entry', qty: 10, price: 60000 })

    // Paper exchange: a long of 10 is live.
    const live = await env.adapter.getPositions()
    expect(live).toHaveLength(1)
    expect(live[0]).toMatchObject({ side: 'long', size: 10 })

    // API side: signal executed, position open with the fill price.
    const apiSignal = await getApiSignal(signalId)
    expect(apiSignal.status).toBe('executed')
    expect(apiSignal.ackedAt).not.toBeNull()
    const apiPosition = await getApiPosition(positionId)
    expect(apiPosition.status).toBe('open')
    expect(Number(apiPosition.avgPrice)).toBe(60000)
    expect(apiPosition.active).toBe(true)
  })

  it('(b) entry with SL/TP → bracket orders placed on the paper adapter', async () => {
    const { signalId, wire } = await produceEntrySignal({
      side: 'buy', quantity: 10, price: 60000, stopLoss: 58000, takeProfit: 65000,
    })
    await deliver(env.client, wire)

    const orders = env.adapter.getOrdersForSignal(signalId)
    // entry (market) + stop-loss + take-profit
    const byType = orders.map((o) => o.order.orderType).sort()
    expect(byType).toEqual(['limit', 'market', 'stop'])

    const sl = orders.find((o) => o.order.orderType === 'stop')!
    expect(sl.order.reduceOnly).toBe(true)
    expect(sl.order.stopPrice).toBe(58000)
    expect(sl.order.side).toBe('sell') // opposite of the long entry
    const tp = orders.find((o) => o.order.orderType === 'limit')!
    expect(tp.order.reduceOnly).toBe(true)
    expect(tp.order.price).toBe(65000)

    // The bracket order ids are acked back to the API signal row.
    const apiSignal = await getApiSignal(signalId)
    expect(apiSignal.stopLossOrderId).toBe(sl.orderId)
    expect(apiSignal.takeProfitOrderId).toBe(tp.orderId)
  })

  it('(c) close signal with metadata.positionId → reduce-only close → ack → position closed', async () => {
    // Open first.
    const { signalId: entryId, positionId, wire: entryWire } =
      await produceEntrySignal({ side: 'buy', quantity: 10, price: 60000 })
    await deliver(env.client, entryWire)
    expect((await getApiPosition(positionId)).status).toBe('open')

    // Close at a higher mark.
    env.adapter.setMarkPrice(SYMBOL, 61000)
    const { signalId: closeId, wire: closeWire } = await produceCloseSignal(positionId)
    await deliver(env.client, closeWire)

    // Executor: a reduce-only sell flattened the position; entry execution closed.
    const closeOrder = env.adapter.getOrders().find((o) => (o.order.label ?? '').includes(`:${closeId}:close`))!
    expect(closeOrder.order.reduceOnly).toBe(true)
    expect(closeOrder.order.side).toBe('sell')
    expect(await env.adapter.getPositions()).toHaveLength(0)
    expect(env.execDb.getSignalExecution(entryId)?.status).toBe('closed')

    // API: close signal executed, the linked position closed + inactive.
    const apiClose = await getApiSignal(closeId)
    expect(apiClose.status).toBe('executed')
    const apiPosition = await getApiPosition(positionId)
    expect(apiPosition.status).toBe('closed')
    expect(apiPosition.active).toBe(false)
    expect(apiPosition.closeDate).not.toBeNull()
  })

  it('(d) rejected path: paper adapter refuses → signal rejected + position rejected', async () => {
    const { signalId, positionId, wire } = await produceEntrySignal({ side: 'buy', quantity: 10, price: 60000 })
    env.adapter.rejectNextOrder('insufficient margin')
    await deliver(env.client, wire)

    // Executor: execution error, no live position.
    expect(env.execDb.getSignalExecution(signalId)?.status).toBe('error')
    expect(await env.adapter.getPositions()).toHaveLength(0)

    // API: signal rejected with the reason, position rejected + inactive.
    const apiSignal = await getApiSignal(signalId)
    expect(apiSignal.status).toBe('rejected')
    expect(apiSignal.errorMessage).toContain('insufficient margin')
    const apiPosition = await getApiPosition(positionId)
    expect(apiPosition.status).toBe('rejected')
    expect(apiPosition.active).toBe(false)
  })

  it('(e) idempotency: same signal delivered twice → exactly one execution + one fill + one fill order', async () => {
    const { signalId, wire } = await produceEntrySignal({ side: 'buy', quantity: 10, price: 60000 })
    await deliver(env.client, wire)
    await deliver(env.client, wire) // duplicate delivery / replay

    // Exactly one open execution and one entry fill.
    const fills = env.execDb.getSignalFills(signalId).filter((f) => f.kind === 'entry')
    expect(fills).toHaveLength(1)
    // The paper book holds a single long of 10 (not 20) — no double open.
    const live = await env.adapter.getPositions()
    expect(live).toHaveLength(1)
    expect(live[0].size).toBe(10)
    // The duplicate was recorded as such on the executor queue.
    expect(env.execDb.getSignalExecution(signalId)?.status).toBe('open')
  })

  it('(f) PnL: entry@60000 then close@61000 → fills-based realized PnL matches the paper fills', async () => {
    const { signalId: entryId, positionId, wire: entryWire } =
      await produceEntrySignal({ side: 'buy', quantity: 10, price: 60000 })
    await deliver(env.client, entryWire)

    env.adapter.setMarkPrice(SYMBOL, 61000)
    const { wire: closeWire } = await produceCloseSignal(positionId)
    await deliver(env.client, closeWire)

    const exec = env.execDb.getSignalExecution(entryId)!
    const fills = env.execDb.getSignalFills(entryId)
    expect(fills.map((f) => f.kind).sort()).toEqual(['entry', 'exit'])

    const pnl = computeSignalPnl(exec, fills)
    expect(pnl.qtyOpened).toBe(10)
    expect(pnl.qtyClosed).toBe(10)
    expect(pnl.entryAvg).toBe(60000)
    expect(pnl.exitAvg).toBe(61000)
    // Long, BTC-PERPETUAL multiplier 1 → (61000-60000)*10 = 10000 gross.
    expect(pnl.realizedPnl).toBe(10000)
    expect(pnl.realizedNet).toBe(10000) // no commissions reported by the paper venue
  })
})

import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KaiBotDatabase } from '../storage/database.js'
import {
  MGC_REPAIR_20260901,
  repairReconcilerRebuy20260901,
  type RepairAdapter,
} from './repair-reconciler-rebuy-20260901.js'
import type { OrderStatus } from './exchanges/types.js'

// The repair runs against a real (temp) executor DB seeded with the incident's
// book state, and a broker stub returning the venue's account of the 5 orders.

const C = MGC_REPAIR_20260901

const T = {
  stop: Date.parse('2026-09-01T13:00:05Z'),
  rebuy1: Date.parse('2026-09-01T13:01:31Z'),
  close1: Date.parse('2026-09-01T18:36:38Z'),
  rebuy2: Date.parse('2026-09-01T18:42:31Z'),
  close2: Date.parse('2026-09-01T19:36:16Z'),
}

function filled(orderId: string, price: number, atMs: number): OrderStatus {
  return { orderId, state: 'filled', filledQuantity: 1, averagePrice: price, filledAtMs: atMs }
}

function brokerStub(): RepairAdapter {
  const orders = new Map<string, OrderStatus>([
    [C.stopOrderId, filled(C.stopOrderId, 4396.8, T.stop)],
    [C.roundTrips[0].entryOrderId, filled(C.roundTrips[0].entryOrderId, 4401.0, T.rebuy1)],
    [C.roundTrips[0].exitOrderId, filled(C.roundTrips[0].exitOrderId, 4382.1, T.close1)],
    [C.roundTrips[1].entryOrderId, filled(C.roundTrips[1].entryOrderId, 4383.4, T.rebuy2)],
    [C.roundTrips[1].exitOrderId, filled(C.roundTrips[1].exitOrderId, 4381.0, T.close2)],
  ])
  return {
    getOrderStatus: async (orderId) => orders.get(orderId) ?? { orderId, state: 'unknown' },
  }
}

let dir: string
let db: KaiBotDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'repair-mgc-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
  db.insertSignalExecution({
    signalId: C.entrySignalId,
    symbol: C.symbol,
    exchange: C.exchange,
    direction: 'long',
    status: 'open',
    qtyOpened: 1,
    accountId: C.accountId,
  })
  db.insertSignalFill({
    signalId: C.entrySignalId,
    kind: 'entry',
    symbol: C.symbol,
    side: 'buy',
    qty: 1,
    price: 4678.8,
    orderId: '1301382063',
  })
  db.upsertServerExitState({
    positionId: C.serverPositionId,
    entrySignalId: C.entrySignalId,
    exchange: C.exchange,
    symbol: C.symbol,
    direction: 'long',
    currentStop: 4396.8,
    slOrderId: C.stopOrderId,
  })
  db.upsertBracketPair({
    signalId: C.entrySignalId,
    exchange: C.exchange,
    slOrderId: C.stopOrderId,
  })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('repairReconcilerRebuy20260901', () => {
  it('closes the bot execution on the real stop fill and records the round-trips as non-bot posts', async () => {
    const reports: any[] = []
    const r = await repairReconcilerRebuy20260901(db, brokerStub(), {
      reportVenueExit: async (positionId, fill) => {
        reports.push({ positionId, ...fill })
      },
    })
    expect(r.ok).toBe(true)

    // 1. Bot execution: closed, exit fill = the stop-out with venue price/time.
    const exec = db.getSignalExecution(C.entrySignalId)!
    expect(exec.status).toBe('closed')
    expect(exec.qty_closed).toBe(1)
    const fills = db.getSignalFills(C.entrySignalId)
    const exit = fills.find((f) => f.kind === 'exit')!
    expect(exit.price).toBe(4396.8)
    expect(exit.order_id).toBe(C.stopOrderId)
    expect(exit.created_at).toBe(T.stop)

    // 2. Two separate non-bot executions, entry+exit fills each, real prices.
    for (const [i, t] of C.roundTrips.entries()) {
      const sid = `reconcile-roundtrip:${t.entryOrderId}`
      const rt = db.getSignalExecution(sid)!
      expect(rt.status).toBe('closed')
      expect(rt.account_id).toBe(C.accountId)
      const rtFills = db.getSignalFills(sid)
      expect(rtFills).toHaveLength(2)
      expect(rtFills[0]!.kind).toBe('entry')
      expect(rtFills[1]!.kind).toBe('exit')
      expect(rtFills[0]!.order_id).toBe(t.entryOrderId)
      expect(rtFills[1]!.order_id).toBe(t.exitOrderId)
      expect(rtFills[0]!.price).toBe(i === 0 ? 4401.0 : 4383.4)
      expect(rtFills[1]!.price).toBe(i === 0 ? 4382.1 : 4381.0)
    }

    // 3. Protective state retired.
    expect(db.getServerExitState(C.serverPositionId)?.active).toBe(0)
    expect(db.listBracketPairs()).toHaveLength(0)

    // 4. Server told the position is flat, with the stop's price/time.
    expect(reports).toEqual([
      { positionId: C.serverPositionId, price: 4396.8, timeMs: T.stop, orderId: C.stopOrderId },
    ])
  })

  it('is idempotent: a second run changes nothing and reports skips', async () => {
    await repairReconcilerRebuy20260901(db, brokerStub(), {})
    const r2 = await repairReconcilerRebuy20260901(db, brokerStub(), {})
    expect(r2.ok).toBe(true)
    expect(r2.steps.find((s) => s.step === 'book-stop-exit')?.status).toBe('skipped')
    expect(r2.steps.find((s) => s.step === 'roundtrip-1')?.status).toBe('skipped')
    expect(r2.steps.find((s) => s.step === 'roundtrip-2')?.status).toBe('skipped')
    expect(db.getSignalFills(C.entrySignalId).filter((f) => f.kind === 'exit')).toHaveLength(1)
  })

  it('refuses to write anything when an order is not venue-confirmed filled', async () => {
    const stub = brokerStub()
    const orig = stub.getOrderStatus!
    stub.getOrderStatus = async (orderId, ctx) =>
      orderId === C.roundTrips[1].exitOrderId
        ? { orderId, state: 'unknown' }
        : orig(orderId, ctx)
    const r = await repairReconcilerRebuy20260901(db, stub, {})
    expect(r.ok).toBe(false)
    expect(r.steps).toHaveLength(1)
    expect(r.steps[0]!.status).toBe('error')
    expect(db.getSignalExecution(C.entrySignalId)?.status).toBe('open')
    expect(db.getSignalFills(C.entrySignalId).filter((f) => f.kind === 'exit')).toHaveLength(0)
  })
})

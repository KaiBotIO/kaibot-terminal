import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KaiBotDatabase } from '../storage/database.js'
import {
  VIRTUALCLOSE_REPAIR_20260903,
  repairVirtualClose20260903,
  type VirtualCloseRepairAdapter,
} from './repair-virtualclose-20260903.js'
import type { OrderStatus } from './exchanges/types.js'

const C = VIRTUALCLOSE_REPAIR_20260903
const EXIT_MS = Date.parse('2026-09-03T12:00:19Z')

function brokerStub(overrides: Partial<Record<string, OrderStatus>> = {}): VirtualCloseRepairAdapter {
  const orders = new Map<string, OrderStatus>([
    [C.exitOrderId, { orderId: C.exitOrderId, state: 'filled', filledQuantity: 1, averagePrice: 29108.5, filledAtMs: EXIT_MS }],
    [C.cancelledStopOrderId, { orderId: C.cancelledStopOrderId, state: 'cancelled' }],
  ])
  for (const [id, st] of Object.entries(overrides)) orders.set(id, st!)
  return { getOrderStatus: async (orderId) => orders.get(orderId) ?? { orderId, state: 'unknown' } }
}

let dir: string
let db: KaiBotDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'repair-vc-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
  // The incident's book, verbatim: open short + phantom long, one venue fill
  // each, active exit state pointing at the (since cancelled) buy-stop.
  db.insertSignalExecution({
    signalId: C.shortEntrySignalId,
    symbol: C.symbol,
    exchange: C.exchange,
    direction: 'short',
    status: 'open',
    qtyOpened: 1,
    accountId: C.accountId,
  })
  db.insertSignalFill({
    signalId: C.shortEntrySignalId,
    kind: 'entry',
    symbol: C.symbol,
    side: 'sell',
    qty: 1,
    price: 29142,
    orderId: '1304545342',
    createdAtMs: Date.parse('2026-09-03T11:42:19Z'),
  })
  db.insertSignalExecution({
    signalId: C.phantomSignalId,
    symbol: C.symbol,
    exchange: C.exchange,
    direction: 'long',
    status: 'open',
    qtyOpened: 1,
    accountId: C.accountId,
  })
  db.insertSignalFill({
    signalId: C.phantomSignalId,
    kind: 'entry',
    symbol: C.symbol,
    side: 'buy',
    qty: 1,
    price: 29108.5,
    orderId: C.exitOrderId,
    createdAtMs: EXIT_MS,
  })
  db.upsertServerExitState({
    positionId: C.serverPositionId,
    entrySignalId: C.shortEntrySignalId,
    exchange: C.exchange,
    symbol: C.symbol,
    direction: 'short',
    currentStop: 30601.5,
    slOrderId: C.cancelledStopOrderId,
  })
  db.upsertBracketPair({
    signalId: C.shortEntrySignalId,
    exchange: C.exchange,
    slOrderId: C.cancelledStopOrderId,
  })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('repairVirtualClose20260903', () => {
  it('re-assigns the venue fill as the short\'s exit, voids the phantom and retires the state', async () => {
    const reports: any[] = []
    const r = await repairVirtualClose20260903(db, brokerStub(), {
      reportVenueExit: async (positionId, fill) => {
        reports.push({ positionId, ...fill })
      },
    })
    expect(r.ok).toBe(true)

    // One ledger row per venue fill: the buy is now the SHORT's exit, with the
    // broker's own price and timestamp preserved.
    const shortFills = db.getSignalFills(C.shortEntrySignalId)
    expect(shortFills.map((f) => f.kind)).toEqual(['entry', 'exit'])
    const exit = shortFills[1]!
    expect(exit.order_id).toBe(C.exitOrderId)
    expect(exit.price).toBe(29108.5)
    expect(exit.created_at).toBe(EXIT_MS)
    expect(db.getSignalFills(C.phantomSignalId)).toHaveLength(0)

    // Short closed; phantom voided (never held a position).
    expect(db.getSignalExecution(C.shortEntrySignalId)).toMatchObject({ status: 'closed', qty_closed: 1 })
    expect(db.getSignalExecution(C.phantomSignalId)).toMatchObject({ status: 'error', qty_opened: 0 })

    // Protective state retired; server told flat with the venue fill.
    expect(db.getServerExitState(C.serverPositionId)?.active).toBe(0)
    expect(db.listBracketPairs()).toHaveLength(0)
    expect(reports).toEqual([
      { positionId: C.serverPositionId, price: 29108.5, timeMs: EXIT_MS, orderId: C.exitOrderId },
    ])
  })

  it('is idempotent: a second run reports skips and changes nothing', async () => {
    await repairVirtualClose20260903(db, brokerStub(), {})
    const r2 = await repairVirtualClose20260903(db, brokerStub(), {})
    expect(r2.ok).toBe(true)
    expect(r2.steps.find((s) => s.step === 'reassign-fill')?.status).toBe('skipped')
    expect(r2.steps.find((s) => s.step === 'close-short')?.status).toBe('skipped')
    expect(r2.steps.find((s) => s.step === 'void-phantom')?.status).toBe('skipped')
    expect(db.getSignalFills(C.shortEntrySignalId).filter((f) => f.kind === 'exit')).toHaveLength(1)
  })

  it('refuses to run while the buy-stop is still working', async () => {
    const r = await repairVirtualClose20260903(
      db,
      brokerStub({ [C.cancelledStopOrderId]: { orderId: C.cancelledStopOrderId, state: 'working' } }),
      {},
    )
    expect(r.ok).toBe(false)
    expect(r.steps[0]!.detail).toContain('cancel it first')
    expect(db.getSignalExecution(C.shortEntrySignalId)?.status).toBe('open')
    expect(db.getSignalFills(C.phantomSignalId)).toHaveLength(1)
  })

  it('refuses when the exit order is not venue-confirmed filled', async () => {
    const r = await repairVirtualClose20260903(
      db,
      brokerStub({ [C.exitOrderId]: { orderId: C.exitOrderId, state: 'unknown' } }),
      {},
    )
    expect(r.ok).toBe(false)
    expect(db.getSignalExecution(C.shortEntrySignalId)?.status).toBe('open')
  })
})

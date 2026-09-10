import { describe, expect, it } from 'bun:test'
import {
  attributeVenueExit,
  planExitAttribution,
  type ExitAttributionDb,
} from './exit-attribution.js'

const ex = (signal_id: string, opened: number, closed = 0, created_at = 1) => ({
  signal_id,
  symbol: 'MESU26',
  account_id: '21084931' as string | null,
  qty_opened: opened,
  qty_closed: closed,
  created_at,
})

describe('planExitAttribution', () => {
  it('allocates newest execution first', () => {
    const plan = planExitAttribution([ex('old', 1, 0, 100), ex('new', 1, 0, 200)], 1)
    expect(plan).toEqual([{ signalId: 'new', qty: 1, fullyClosed: true }])
  })

  it('spreads across executions and flags the partial one', () => {
    const plan = planExitAttribution([ex('a', 2, 0, 100), ex('b', 1, 0, 200)], 2)
    expect(plan).toEqual([
      { signalId: 'b', qty: 1, fullyClosed: true },
      { signalId: 'a', qty: 1, fullyClosed: false },
    ])
  })

  it('counts already-closed quantity as unavailable', () => {
    expect(planExitAttribution([ex('a', 2, 2, 100)], 1)).toEqual([])
    expect(planExitAttribution([ex('a', 2, 1, 100)], 5)).toEqual([
      { signalId: 'a', qty: 1, fullyClosed: true },
    ])
  })

  it('drops quantity beyond the tracked book instead of over-attributing', () => {
    const plan = planExitAttribution([ex('a', 1, 0, 100)], 3)
    expect(plan).toEqual([{ signalId: 'a', qty: 1, fullyClosed: true }])
  })

  it('is a no-op for a zero or negative close', () => {
    expect(planExitAttribution([ex('a', 1)], 0)).toEqual([])
    expect(planExitAttribution([ex('a', 1)], -1)).toEqual([])
  })
})

function fakeDb(rows: ReturnType<typeof ex>[]) {
  const fills: any[] = []
  const patches: any[] = []
  const retired: string[] = []
  const db: ExitAttributionDb = {
    listOpenExecutionsForExchange: () => rows,
    insertSignalFill: (f) => fills.push(f),
    updateSignalExecution: (id, patch) => patches.push({ id, ...patch }),
    markEntrySignalClosed: (id, reason) => retired.push(`${id}:${reason}`),
  }
  return { db, fills, patches, retired }
}

describe('attributeVenueExit', () => {
  // Regression (live ledger 2026-08-28): a manual close and a broker-confirmed
  // close both flattened a bot position without ever writing an exit fill, so
  // the trades were realized at the venue and unpriced in analytics.
  it('books the exit fill and closes the execution', () => {
    const { db, fills, patches, retired } = fakeDb([ex('entry-1', 1, 0, 100)])
    const plan = attributeVenueExit(db, {
      exchange: 'tradestation',
      accountId: '21084931',
      symbol: 'MESU26',
      side: 'sell',
      qty: 1,
      price: 7731,
      orderId: '1302690740',
      reason: 'closed by manual close',
    })
    expect(plan).toEqual([{ signalId: 'entry-1', qty: 1, fullyClosed: true }])
    expect(fills).toEqual([
      {
        signalId: 'entry-1',
        kind: 'exit',
        symbol: 'MESU26',
        side: 'sell',
        qty: 1,
        price: 7731,
        orderId: '1302690740',
      },
    ])
    expect(patches).toEqual([
      { id: 'entry-1', status: 'closed', qtyClosed: 1, qtyPendingClose: null },
    ])
    expect(retired).toEqual(['entry-1:closed by manual close'])
  })

  it('leaves a partially closed execution open with the quantity accounted', () => {
    const { db, fills, patches, retired } = fakeDb([ex('entry-1', 2, 0, 100)])
    attributeVenueExit(db, {
      exchange: 'tradestation',
      accountId: '21084931',
      symbol: 'MESU26',
      side: 'sell',
      qty: 1,
      price: 7731,
      reason: 'partial',
    })
    expect(fills).toHaveLength(1)
    expect(patches).toEqual([{ id: 'entry-1', status: 'open', qtyClosed: 1 }])
    expect(retired).toEqual([])
  })

  it('ignores executions on another symbol or account', () => {
    const other = { ...ex('other', 1, 0, 100), symbol: 'MNQU26' }
    const otherAcct = { ...ex('acct', 1, 0, 100), account_id: '99999999' }
    const { db, fills } = fakeDb([other, otherAcct])
    expect(
      attributeVenueExit(db, {
        exchange: 'tradestation',
        accountId: '21084931',
        symbol: 'MESU26',
        side: 'sell',
        qty: 1,
        price: 1,
        reason: 'x',
      }),
    ).toEqual([])
    expect(fills).toEqual([])
  })

  it('matches an execution whose account is unknown', () => {
    const rows = [{ ...ex('legacy', 1, 0, 100), account_id: null }]
    const { db, fills } = fakeDb(rows)
    expect(
      attributeVenueExit(db, {
        exchange: 'tradestation',
        accountId: '21084931',
        symbol: 'mesu26',
        side: 'sell',
        qty: 1,
        price: 1,
        reason: 'x',
      }),
    ).toHaveLength(1)
    expect(fills).toHaveLength(1)
  })

  it('is a no-op on an untracked (purely manual) position', () => {
    const { db, fills, patches } = fakeDb([])
    expect(
      attributeVenueExit(db, {
        exchange: 'tradestation',
        accountId: '21084931',
        symbol: 'MESU26',
        side: 'sell',
        qty: 1,
        price: 1,
        reason: 'x',
      }),
    ).toEqual([])
    expect(fills).toEqual([])
    expect(patches).toEqual([])
  })
})

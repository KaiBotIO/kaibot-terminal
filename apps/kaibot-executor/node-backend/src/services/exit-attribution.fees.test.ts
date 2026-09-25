import { describe, expect, it } from 'bun:test'
import { attributeVenueExit, splitFee, type ExitAttributionDb } from './exit-attribution.js'

describe('splitFee', () => {
  it('spreads one order fee pro rata by quantity and adds back up', () => {
    const shares = splitFee({ commission: 3, feeNative: 0.0003, feeCurrency: 'BTC' }, [1, 2])
    expect(shares[0]!.commission).toBeCloseTo(1, 10)
    expect(shares[1]!.commission).toBeCloseTo(2, 10)
    expect(shares[0]!.feeNative).toBeCloseTo(0.0001, 12)
    expect(shares.map((s) => s.feeCurrency)).toEqual(['BTC', 'BTC'])
    expect(shares.reduce((s, x) => s + x.commission, 0)).toBeCloseTo(3, 10)
  })

  it('books zero when nothing was charged', () => {
    expect(splitFee({ commission: 0 }, [4, 6])).toEqual([
      { commission: 0, feeNative: null, feeCurrency: null },
      { commission: 0, feeNative: null, feeCurrency: null },
    ])
  })
})

describe('attributeVenueExit fee', () => {
  it('splits the close fee over the holders it lands on', () => {
    const fills: any[] = []
    const db: ExitAttributionDb = {
      listOpenExecutionsForExchange: () => [
        { signal_id: 'old', symbol: 'MESU26', account_id: 'A', qty_opened: 1, qty_closed: 0, created_at: 1 },
        { signal_id: 'new', symbol: 'MESU26', account_id: 'A', qty_opened: 3, qty_closed: 0, created_at: 2 },
      ],
      insertSignalFill: (f) => fills.push(f),
      updateSignalExecution: () => {},
      markEntrySignalClosed: () => {},
    }
    attributeVenueExit(db, {
      exchange: 'tradestation',
      accountId: 'A',
      symbol: 'MESU26',
      side: 'sell',
      qty: 4,
      price: 7700,
      orderId: 'o-1',
      commission: 2.48, // 4 × 0.62
      feeNative: 2.48,
      feeCurrency: 'USD',
      reason: 'venue stop filled',
    })
    // Newest first: 3 lots on 'new', 1 on 'old'.
    expect(fills.map((f) => [f.signalId, f.qty, Number(f.commission.toFixed(4)), f.feeCurrency])).toEqual([
      ['new', 3, 1.86, 'USD'],
      ['old', 1, 0.62, 'USD'],
    ])
  })
})

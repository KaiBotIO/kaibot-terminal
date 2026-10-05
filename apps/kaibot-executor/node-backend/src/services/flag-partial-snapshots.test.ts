import { describe, expect, it } from 'bun:test'
import { findPartialTicks, flagPartialSnapshots } from './flag-partial-snapshots.js'

const H = 3_600_000
const tick = (ts: number, accounts: string[], partial = 0) => ({ ts, accounts: accounts.join(','), partial })
const TS = ['tradestation|1', 'tradestation|2']
const DERIBIT = ['deribit|btc', 'deribit|eth']

describe('findPartialTicks', () => {
  it('flags ticks that lack an account seen shortly before and after', () => {
    const ticks = [
      tick(0, [...TS, ...DERIBIT]),
      tick(1 * H, [...DERIBIT]),
      tick(2 * H, [...DERIBIT]),
      tick(3 * H, [...TS, ...DERIBIT]),
    ]
    const { toFlag } = findPartialTicks(ticks)
    expect(toFlag.map((t) => t.ts)).toEqual([1 * H, 2 * H])
    expect(toFlag[0].missing).toEqual(TS)
  })

  it('leaves the early TradeStation-only history alone (Deribit not yet connected)', () => {
    const ticks = [tick(0, TS), tick(1 * H, TS), tick(2 * H, [...TS, ...DERIBIT]), tick(3 * H, [...TS, ...DERIBIT])]
    expect(findPartialTicks(ticks).toFlag).toEqual([])
  })

  it('treats a long absence as a deliberate disconnect', () => {
    const ticks = [tick(0, [...TS, ...DERIBIT]), tick(1 * H, TS), tick(100 * H, [...TS, ...DERIBIT])]
    expect(findPartialTicks(ticks, 48 * H).toFlag).toEqual([])
    expect(findPartialTicks(ticks, 200 * H).toFlag.map((t) => t.ts)).toEqual([1 * H])
  })

  it('skips ticks already flagged', () => {
    const ticks = [tick(0, [...TS, ...DERIBIT]), tick(1 * H, DERIBIT, 1), tick(2 * H, [...TS, ...DERIBIT])]
    const res = findPartialTicks(ticks)
    expect(res.toFlag).toEqual([])
    expect(res.alreadyFlagged).toBe(1)
  })
})

describe('flagPartialSnapshots', () => {
  function fakeDb(ticks: ReturnType<typeof tick>[]) {
    const marked: number[][] = []
    return {
      marked,
      listSnapshotTicks: () => ticks,
      markSnapshotTicksPartial: (list: number[]) => {
        marked.push(list)
        for (const t of ticks) if (list.includes(t.ts)) t.partial = 1
        return list.length * 2
      },
    }
  }

  it('dry run reports without writing; apply writes once and a rerun is a no-op', () => {
    const db = fakeDb([tick(0, [...TS, ...DERIBIT]), tick(1 * H, DERIBIT), tick(2 * H, [...TS, ...DERIBIT])])
    const dry = flagPartialSnapshots(db)
    expect(dry).toMatchObject({ dryRun: true, ticks: 1, updated: 0, from: new Date(H).toISOString() })
    expect(db.marked).toEqual([])

    const applied = flagPartialSnapshots(db, { dryRun: false })
    expect(applied).toMatchObject({ dryRun: false, ticks: 1, updated: 2 })
    expect(db.marked).toEqual([[H]])

    const again = flagPartialSnapshots(db, { dryRun: false })
    expect(again).toMatchObject({ ticks: 0, updated: 0, alreadyFlagged: 1 })
  })
})

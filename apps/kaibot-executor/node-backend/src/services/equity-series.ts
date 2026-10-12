// Equity-curve series from balance-snapshot ticks.
//
// A tick is a point only when it is a complete USD sample: every connected
// session answered (`partial` = 0) and at least one wallet carries a USD
// figure. Anything else is a gap (`equity: null`), which the chart draws as a
// hole in the line rather than a dive to whatever fraction of the book did
// answer. `pnl` is the change since the first real point in range.

import type { EquitySnapshotPoint } from '../storage/types.js'

export interface EquitySeriesPoint {
  date: string
  equity: number | null
  pnl: number | null
  unrealizedPnL: number | null
  // True when the sample is a floor: some wallet had no USD mark.
  incomplete: boolean
  gap: boolean
}

export function isGapSample(s: Pick<EquitySnapshotPoint, 'partial' | 'priced'>): boolean {
  return s.partial > 0 || s.priced === 0
}

export function equitySeries(snapshots: EquitySnapshotPoint[]): EquitySeriesPoint[] {
  const first = snapshots.find((s) => !isGapSample(s))
  const baseline = first ? first.equity : 0
  return snapshots.map((s) => {
    const gap = isGapSample(s)
    return {
      date: new Date(s.ts).toISOString(),
      equity: gap ? null : s.equity,
      pnl: gap ? null : s.equity - baseline,
      unrealizedPnL: gap ? null : s.unrealizedPnL,
      incomplete: !gap && s.priced < s.wallets,
      gap,
    }
  })
}

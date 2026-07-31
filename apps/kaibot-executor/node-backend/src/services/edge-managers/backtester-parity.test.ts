// Backtest↔edge parity harness (F2, pilot-ladder decomposition): the SAME
// synthetic price path driven through
//   (a) the real backtester pipeline (packages/backtester ManagerPipeline +
//       PositionTracker) running the REAL SDK managers, and
//   (b) the executor's edge runtime (mirror reducers + runManagersTick +
//       foldStopCandidate/foldCloseFraction) over a minimal venue model that
//       replicates the pipeline's resting-stop enforcement,
// must produce the same per-tick stop levels, close events and position sizes.
//
// Frictionless (fee 0, slippage 0) so any divergence is reducer/composition
// drift, not cost modelling.
//
// NOTE: excluded from tsconfig (cross-package imports); bun test runs it.

import { describe, expect, it } from 'bun:test'
import {
  ManagerPipeline,
  buildBarTickPath,
  type ManagerSpec,
} from '../../../../../../packages/backtester/src/managers'
import { PositionTracker } from '../../../../../../packages/backtester/src/position-tracker'
import { breakEvenMoverManager as sdkBreakEven } from '../../../../../../packages/strategy-sdk/src/managers/break-even-mover'
import { tpLadderManager as sdkTpLadder } from '../../../../../../packages/strategy-sdk/src/managers/tp-ladder'
import { riskGuardManager as sdkRiskGuard } from '../../../../../../packages/strategy-sdk/src/managers/risk-guard'
import { drawdownTrailingStopManager as sdkDrawdown } from '../../../../../../packages/strategy-sdk/src/managers/drawdown-trailing-stop'
import { groupRiskGuardManager as sdkGroupRiskGuard } from '../../../../../../packages/strategy-sdk/src/managers/group-risk-guard'
import { breakEvenMoverManager } from './break-even-mover.js'
import { tpLadderManager } from './tp-ladder.js'
import { riskGuardManager } from './risk-guard.js'
import { drawdownTrailingStopManager } from './drawdown-trailing-stop.js'
import { groupRiskGuardManager } from './group-risk-guard.js'
import type { GroupAggregateState } from './contract.js'
import { foldCloseFraction, foldStopCandidate, runManagersTick, type RuntimeManagerEntry } from './runtime.js'
import {
  advanceManagedPosition,
  EMPTY_MANAGER_STATE,
  type EdgeManagerPlugin,
  type ManagedPositionState,
} from './contract.js'
import { EDGE_MANAGER_REGISTRY } from './registry.js'

interface Bar {
  open: number
  high: number
  low: number
  close: number
}

const toCandle = (b: Bar, i: number) => ({
  timestamp: new Date(1_700_000_000_000 + i * 60_000),
  open: b.open,
  high: b.high,
  low: b.low,
  close: b.close,
  volume: 0,
})

interface TickSnapshot {
  stop: number | null
  size: number
}

// (a) Reference run: real SDK managers through the real backtester pipeline.
function runBacktester(bars: Bar[], specs: ManagerSpec[], entryPrice: number): TickSnapshot[] {
  const tracker = new PositionTracker(10_000, 0)
  const pipeline = new ManagerPipeline(specs, undefined, 'primary', undefined, 0)
  const t0 = new Date(1_699_999_999_000)
  tracker.openPosition({ ts: t0, side: 'long', price: entryPrice, sizePct: 1 })
  pipeline.onPositionOpened(tracker, t0)

  const out: TickSnapshot[] = []
  for (let i = 0; i < bars.length; i++) {
    pipeline.runBar(tracker, toCandle(bars[i], i) as any)
    out.push({
      stop: pipeline.currentStopLoss(),
      size: tracker.snapshot()?.size ?? 0,
    })
  }
  return out
}

// (b) Edge run: mirror reducers through the executor runtime + a minimal venue
// model with the pipeline's resting-stop semantics (breach at the tick price
// closes at the stop level; a level outside the visited range fills at the
// tick price — no phantom fills).
function runEdge(
  bars: Bar[],
  managers: Array<{ plugin: EdgeManagerPlugin<unknown>; params: unknown }>,
  entryPrice: number,
): TickSnapshot[] {
  const size0 = 10_000 / entryPrice
  let position: ManagedPositionState = {
    id: 'pos',
    direction: 'long',
    avgEntryPrice: entryPrice,
    size: size0,
    extremePriceAtEntry: entryPrice,
    oppositePrice: entryPrice,
    currentStopLoss: null,
    openedTs: 1_699_999_999_000,
  }
  const entries: RuntimeManagerEntry[] = managers.map((m) => ({
    managerId: m.plugin.id,
    plugin: m.plugin,
    params: m.params,
    state: m.plugin.init
      ? m.plugin.init({ params: m.params, position })
      : EMPTY_MANAGER_STATE,
    execOrder: EDGE_MANAGER_REGISTRY[m.plugin.id]?.execOrder ?? 50,
  }))

  let stop: number | null = null
  let size = size0
  const out: TickSnapshot[] = []

  for (let i = 0; i < bars.length; i++) {
    const path = buildBarTickPath(toCandle(bars[i], i) as any, 'long')
    for (const tick of path) {
      if (size <= 0) break
      position = advanceManagedPosition(
        { ...position, size, currentStopLoss: stop },
        { high: tick.high, low: tick.low },
      )
      // Resting stop enforcement, pipeline semantics.
      if (stop !== null && tick.price <= stop) {
        size = 0
        stop = null
        break
      }
      const res = runManagersTick({
        position: { ...position, size, currentStopLoss: stop },
        managers: entries,
        price: tick.price,
        ts: i,
      })
      for (const e of entries) {
        const next = res.states.get(e.managerId)
        if (next) e.state = next
      }
      const candidate = foldStopCandidate({ direction: 'long', currentStopLoss: stop }, res.actions)
      if (candidate != null) stop = candidate
      const { fraction } = foldCloseFraction(res.actions)
      if (fraction >= 1) {
        size = 0
        stop = null
        break
      } else if (fraction > 0) {
        size -= size * fraction
      }
    }
    out.push({ stop: size > 0 ? stop : null, size })
  }
  return out
}

function compareRuns(a: TickSnapshot[], b: TickSnapshot[]) {
  expect(b.length).toBe(a.length)
  for (let i = 0; i < a.length; i++) {
    if (a[i].stop == null) {
      expect(b[i].stop).toBeNull()
    } else {
      expect(b[i].stop).toBeCloseTo(a[i].stop!, 9)
    }
    expect(b[i].size).toBeCloseTo(a[i].size, 9)
  }
}

describe('edge runtime parity with the backtester pipeline', () => {
  it('break-even + tp-ladder + risk-guard produce identical stop/close sequences', () => {
    // Entry 100. Rally through the TP rungs toward 120 (two rungs fire on ONE
    // tick at bar 2's high), then a crash through the guard's global stop (95)
    // — the hard close fires through the composition. Break-even sits in the
    // composition with a trigger the rally never reaches (25%), so the guard's
    // close is not shielded by a resting BE stop.
    const bars: Bar[] = [
      { open: 100, high: 101.5, low: 99.2, close: 101 },
      { open: 101, high: 103, low: 100.5, close: 102.5 },
      { open: 102.5, high: 109, low: 102, close: 108 },
      { open: 108, high: 114, low: 107, close: 113 },
      { open: 113, high: 121, low: 112, close: 118 },
      { open: 118, high: 119, low: 84, close: 85 },
      { open: 85, high: 90, low: 83, close: 88 },
    ]
    const beParams = { feePercentage: 0.0015, triggerPercentage: 25, useEntryReference: false, referencePrice: 0 }
    const tpParams = { prices: [], target: 120, levelCount: 3, fractionPerTranche: 0.25, runnerFraction: 0.25 }
    const guardParams = { globalStopPrice: 95 }

    const reference = runBacktester(
      bars,
      [
        { plugin: sdkBreakEven as any, params: beParams },
        { plugin: sdkTpLadder as any, params: tpParams },
        { plugin: sdkRiskGuard as any, params: guardParams },
      ],
      100,
    )
    const edge = runEdge(
      bars,
      [
        { plugin: breakEvenMoverManager as any, params: beParams },
        { plugin: tpLadderManager as any, params: tpParams },
        { plugin: riskGuardManager as any, params: guardParams },
      ],
      100,
    )
    compareRuns(reference, edge)
    // Sanity: the scenario actually exercised the ladder + the hard close.
    expect(reference[4].size).toBeLessThan(reference[0].size)
    expect(reference[reference.length - 1].size).toBe(0)
  })

  it('drawdown trail + break-even produce identical trailing stop sequences', () => {
    // Entry 100 with a carried intra-bar dip to 93 (the drawdown depth), then a
    // steady climb without retracing under the trail. Break-even has a late
    // trigger (8%) so it floors the stop mid-run instead of instantly.
    const bars: Bar[] = [
      { open: 100, high: 100.5, low: 93, close: 100.4 },
      { open: 100.4, high: 104, low: 99.5, close: 103.5 },
      { open: 103.5, high: 108.5, low: 103, close: 108 },
      { open: 108, high: 113, low: 107.5, close: 112 },
      { open: 112, high: 118, low: 111, close: 117 },
      { open: 117, high: 117.5, low: 104, close: 105 },
    ]
    const ddParams = {
      maxTrailingPercentage: 40, maxTrailingPoints: 500,
      minTrailingPercentage: 1, minTrailingPoints: 0,
      trailingLock: false, onlyWhenProfit: true, referencePrice: 0, freezeExtreme: false,
    }
    const beParams = { feePercentage: 0.001, triggerPercentage: 8, useEntryReference: false, referencePrice: 0 }

    const reference = runBacktester(
      bars,
      [
        { plugin: sdkDrawdown as any, params: ddParams },
        { plugin: sdkBreakEven as any, params: beParams },
      ],
      100,
    )
    const edge = runEdge(
      bars,
      [
        { plugin: drawdownTrailingStopManager as any, params: ddParams },
        { plugin: breakEvenMoverManager as any, params: beParams },
      ],
      100,
    )
    compareRuns(reference, edge)
    // Sanity: the trail actually engaged and (given the last pullback) either
    // still trails or stopped the position out identically on both sides.
    expect(reference.some((s) => s.stop != null)).toBe(true)
  })

  it('group risk-guard: one group breach closes every member on the same tick on both sides', () => {
    // Three longs of 20 units @100: two share group 'grp', the third is
    // group-less. The flush bar (low 96) pushes the group's frozen aggregate
    // loss past 1% of equity — BOTH members must close at the flush tick (96)
    // on the reference AND the edge; the outsider survives untouched.
    const bars: Bar[] = [
      { open: 100, high: 101, low: 99.5, close: 100.5 },
      { open: 100.5, high: 102, low: 100, close: 101.5 },
      { open: 99, high: 99.5, low: 96, close: 97 }, // breach at the low
      { open: 97, high: 98, low: 96.5, close: 97.5 },
    ]
    const params = { maxGroupLossFraction: 0.01 }
    const groupOf: Record<string, string | undefined> = { p1: 'grp', p2: 'grp', p3: undefined }
    type Member = { side: 'long' | 'short'; entryPrice: number; size: number }
    const frozenCtx =
      (groupId: string, members: Member[], equity: number) =>
      (price: number): GroupAggregateState => ({
        groupId,
        memberCount: members.length,
        unrealizedPnl: members.reduce(
          (acc, m) => acc + (m.side === 'long' ? price - m.entryPrice : m.entryPrice - price) * m.size,
          0,
        ),
        notional: members.reduce((acc, m) => acc + m.size * price, 0),
        equity,
      })

    // (a) Reference: three book positions + one pipeline each, group ctx frozen
    //     per bar exactly like the engine's step 3d.
    const tracker = new PositionTracker(10_000, 0)
    const t0 = new Date(1_699_999_999_000)
    const ids = [
      tracker.openBook({ ts: t0, side: 'long', price: 100, sizePct: 0.2, groupReference: 'grp' })!,
      tracker.openBook({ ts: t0, side: 'long', price: 100, sizePct: 0.2, groupReference: 'grp' })!,
      tracker.openBook({ ts: t0, side: 'long', price: 100, sizePct: 0.2 })!,
    ]
    const pipelines = new Map(
      ids.map((id) => [
        id,
        new ManagerPipeline([{ plugin: sdkGroupRiskGuard as any, params }], undefined, 'book', id, 0),
      ]),
    )
    for (const pl of pipelines.values()) pl.onPositionOpened(tracker, t0)

    const refSizes: number[][] = []
    for (let i = 0; i < bars.length; i++) {
      const candle = toCandle(bars[i], i) as any
      const members = new Map<string, Member[]>()
      for (const p of tracker.bookSnapshots() as Array<Member & { groupId?: string }>) {
        const gid = (p as any).groupId as string | undefined
        if (!gid) continue
        members.set(gid, [
          ...(members.get(gid) ?? []),
          { side: p.side, entryPrice: (p as any).entryPrice, size: p.size },
        ])
      }
      const equity = tracker.equity(bars[i].open)
      for (const id of ids) {
        const snap = tracker.bookSnapshot(id) as (Member & { groupId?: string }) | null
        if (!snap) continue
        const gid = (snap as any).groupId as string | undefined
        const m = gid ? members.get(gid) : undefined
        pipelines.get(id)!.runBar(tracker, candle, gid && m ? (frozenCtx(gid, m, equity) as any) : undefined)
      }
      refSizes.push(ids.map((id) => tracker.bookSnapshot(id)?.size ?? 0))
    }
    const refClosed = tracker.closedTrades()

    // (b) Edge: the mirror reducer per position through runManagersTick, group
    //     aggregates frozen per bar from the edge's own book, equity computed
    //     with the tracker's frictionless formula (cash + Σ uPnL at bar open).
    const edge = ['p1', 'p2', 'p3'].map((key) => ({
      key,
      size: 20,
      entryPrice: 100,
      state: groupRiskGuardManager.init!({ params: params as never, position: {
        id: key, direction: 'long', avgEntryPrice: 100, size: 20,
        extremePriceAtEntry: 100, oppositePrice: 100, currentStopLoss: null, openedTs: 0,
      } as ManagedPositionState }),
      closedAtBar: -1,
      closedAtPrice: 0,
    }))
    const edgeSizes: number[][] = []
    for (let i = 0; i < bars.length; i++) {
      const members = new Map<string, Member[]>()
      for (const e of edge) {
        const gid = groupOf[e.key]
        if (!gid || e.size <= 0) continue
        members.set(gid, [...(members.get(gid) ?? []), { side: 'long', entryPrice: e.entryPrice, size: e.size }])
      }
      const equity =
        10_000 + edge.reduce((acc, e) => acc + (bars[i].open - e.entryPrice) * e.size, 0)
      for (const e of edge) {
        if (e.size <= 0) continue
        const gid = groupOf[e.key]
        const m = gid ? members.get(gid) : undefined
        const path = buildBarTickPath(toCandle(bars[i], i) as any, 'long')
        for (const tick of path) {
          if (e.size <= 0) break
          const position: ManagedPositionState = {
            id: e.key, direction: 'long', avgEntryPrice: e.entryPrice, size: e.size,
            extremePriceAtEntry: 100, oppositePrice: 100, currentStopLoss: null, openedTs: 0,
          }
          const res = runManagersTick({
            position,
            managers: [{
              managerId: 'group-risk-guard', plugin: groupRiskGuardManager as any,
              params, state: e.state, execOrder: 110,
            }],
            price: tick.price,
            ts: i,
            group: gid && m ? frozenCtx(gid, m, equity)(tick.price) : undefined,
          })
          const next = res.states.get('group-risk-guard')
          if (next) e.state = next
          const { fraction } = foldCloseFraction(res.actions)
          if (fraction >= 1) {
            e.size = 0
            e.closedAtBar = i
            e.closedAtPrice = tick.price
            break
          } else if (fraction > 0) {
            e.size -= e.size * fraction
          }
        }
      }
      edgeSizes.push(edge.map((e) => e.size))
    }

    // Identical per-bar sizes on both sides.
    for (let i = 0; i < bars.length; i++) {
      for (let k = 0; k < 3; k++) {
        expect(edgeSizes[i][k]).toBeCloseTo(refSizes[i][k], 9)
      }
    }
    // Both members closed on the flush bar at the flush tick (96), same on the
    // reference (ClosedTrade exit @96, reason group-loss) and the edge.
    expect(refClosed).toHaveLength(2)
    for (const t of refClosed) {
      expect(t.reason).toBe('group-loss')
      expect(t.exitPrice).toBeCloseTo(96, 9)
      expect(t.groupId).toBe('grp')
    }
    for (const e of edge.slice(0, 2)) {
      expect(e.closedAtBar).toBe(2)
      expect(e.closedAtPrice).toBeCloseTo(96, 9)
    }
    // The group-less position survived on both sides.
    expect(refSizes[bars.length - 1][2]).toBeCloseTo(20, 9)
    expect(edge[2].size).toBeCloseTo(20, 9)
  })
})

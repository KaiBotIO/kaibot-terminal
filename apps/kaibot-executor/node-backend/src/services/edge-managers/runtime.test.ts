// Composition rules of the edge manager runtime: execution order, the guard's
// filterActions pass over the COMPOSED list (risk-guard last), the
// protect/reduce-only sanitizer, and the stop/close folds.

import { describe, expect, it } from 'bun:test'
import { foldCloseFraction, foldStopCandidate, runManagersTick, type RuntimeManagerEntry } from './runtime.js'
import { EMPTY_MANAGER_STATE, type EdgeManagerPlugin, type ManagedPositionState, type ManagerAction } from './contract.js'
import { riskGuardManager } from './risk-guard.js'
import { EDGE_MANAGER_REGISTRY } from './registry.js'

const position = (over: Partial<ManagedPositionState> = {}): ManagedPositionState => ({
  id: 'p',
  direction: 'long',
  avgEntryPrice: 100,
  size: 10,
  extremePriceAtEntry: 105,
  oppositePrice: 98,
  currentStopLoss: null,
  openedTs: 0,
  ...over,
})

const emitter = (id: string, actions: ManagerAction[], calls?: string[]): EdgeManagerPlugin<unknown> => ({
  id,
  onTick() {
    calls?.push(id)
    return { actions, state: EMPTY_MANAGER_STATE }
  },
})

const entry = (
  plugin: EdgeManagerPlugin<unknown>,
  execOrder: number,
  params: unknown = {},
): RuntimeManagerEntry => ({
  managerId: plugin.id,
  plugin,
  params,
  state: EMPTY_MANAGER_STATE,
  execOrder,
})

describe('runManagersTick composition', () => {
  it('runs managers in exec_order regardless of input order', () => {
    const calls: string[] = []
    const res = runManagersTick({
      position: position(),
      managers: [
        entry(emitter('c', [], calls), 30),
        entry(emitter('a', [], calls), 10),
        entry(emitter('b', [], calls), 20),
      ],
      price: 100,
      ts: 1,
    })
    expect(calls).toEqual(['a', 'b', 'c'])
    expect(res.actions).toEqual([])
  })

  it('risk-guard (last) filters scale_ins emitted by EARLIER managers while locked', () => {
    // maxSize hit → guard locks → scale_in from the earlier manager is stripped;
    // the protective stop passes through.
    const res = runManagersTick({
      position: position({ size: 6 }),
      managers: [
        entry(
          emitter('ladder', [
            { type: 'scale_in', sizeFraction: 0.1, reason: 'rung' },
            { type: 'set_stop_loss', price: 99, reason: 'trail' },
          ]),
          10,
        ),
        entry(riskGuardManager, EDGE_MANAGER_REGISTRY['risk-guard'].execOrder, { maxSize: 5 }),
      ],
      price: 100,
      ts: 1,
    })
    expect(res.actions).toEqual([{ type: 'set_stop_loss', price: 99, reason: 'trail' }])
    // The scale_in never reaches `dropped` either — the guard already removed it.
    expect(res.dropped).toEqual([])
    // Lock state persisted for the next tick.
    expect(res.states.get('risk-guard')!.scratch.riskLocked).toBe(true)
  })

  it('sanitizer drops entry-side / hedge / tag actions when no guard strips them', () => {
    const res = runManagersTick({
      position: position(),
      managers: [
        entry(
          emitter('rogue', [
            { type: 'scale_in', sizeFraction: 0.5 },
            { type: 'open_hedge', side: 'short' },
            { type: 'close_hedge' },
            { type: 'close_all' },
            { type: 'set_tag', tag: 'x' },
            { type: 'close', fraction: 0.25, reason: 'ok' },
            { type: 'set_stop_loss', price: 99 },
          ]),
          10,
        ),
      ],
      price: 100,
      ts: 1,
    })
    expect(res.actions).toEqual([
      { type: 'close', fraction: 0.25, reason: 'ok' },
      { type: 'set_stop_loss', price: 99 },
    ])
    expect(res.dropped.map((a) => a.type)).toEqual([
      'scale_in', 'open_hedge', 'close_hedge', 'close_all', 'set_tag',
    ])
  })

  it('risk-guard global stop emits a full close once per breach through the composition', () => {
    const managers = [
      entry(riskGuardManager, 100, { globalStopPrice: 95 }),
    ]
    const first = runManagersTick({ position: position(), managers, price: 90, ts: 1 })
    expect(first.actions).toEqual([{ type: 'close', fraction: 1, reason: 'global-stop' }])
    // Same breach on the next tick → no re-emit.
    const second = runManagersTick({
      position: position(),
      managers: [{ ...managers[0], state: first.states.get('risk-guard')! }],
      price: 89,
      ts: 2,
    })
    expect(second.actions).toEqual([])
  })
})

describe('stop/close folds', () => {
  it('foldStopCandidate keeps the most favourable improving stop per direction', () => {
    const acts: Array<Extract<ManagerAction, { type: 'set_stop_loss' } | { type: 'close' }>> = [
      { type: 'set_stop_loss', price: 98 },
      { type: 'set_stop_loss', price: 101 },
      { type: 'set_stop_loss', price: 99 },
    ]
    expect(foldStopCandidate({ direction: 'long', currentStopLoss: 97 }, acts)).toBe(101)
    expect(foldStopCandidate({ direction: 'long', currentStopLoss: 102 }, acts)).toBeNull()
    expect(foldStopCandidate({ direction: 'short', currentStopLoss: 103 }, acts)).toBe(98)
    expect(foldStopCandidate({ direction: 'long', currentStopLoss: null }, [])).toBeNull()
  })

  it('foldCloseFraction composes sequential fractions like the pipeline (1 - Π(1-f))', () => {
    const { fraction, reasons } = foldCloseFraction([
      { type: 'close', fraction: 0.25, reason: 'tp-ladder:0' },
      { type: 'set_stop_loss', price: 99 },
      { type: 'close', fraction: 0.25 / 0.75, reason: 'tp-ladder:1' },
    ])
    // 0.25 of 10, then a third of the remaining 7.5 → 5 of 10 total.
    expect(fraction).toBeCloseTo(0.5, 12)
    expect(reasons).toEqual(['tp-ladder:0', 'tp-ladder:1'])
  })

  it('foldCloseFraction snaps a nominal full close to exactly 1', () => {
    expect(foldCloseFraction([{ type: 'close', fraction: 1, reason: 'global-stop' }]).fraction).toBe(1)
    expect(
      foldCloseFraction([
        { type: 'close', fraction: 0.5 },
        { type: 'close', fraction: 1 },
      ]).fraction,
    ).toBe(1)
    expect(foldCloseFraction([]).fraction).toBe(0)
  })
})

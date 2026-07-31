// Parity lock: the executor's risk-guard mirror must be bit-identical to the
// SDK reference (packages/strategy-sdk/src/managers/risk-guard.ts) — init,
// onTick sequences (lock / global-stop / one-shot cap release) AND the
// filterActions composition hook. If it fails, the SDK moved: re-mirror.
//
// NOTE: excluded from tsconfig (cross-package import); bun test runs it.

import { describe, expect, it } from 'bun:test'
import {
  riskGuardManager as mirror,
  evaluateLock as mirrorEvaluateLock,
  filterRiskGuardActions as mirrorFilter,
} from './risk-guard.js'
import {
  riskGuardManager as sdk,
  evaluateLock as sdkEvaluateLock,
  filterRiskGuardActions as sdkFilter,
} from '../../../../../../packages/strategy-sdk/src/managers/risk-guard'

describe('risk-guard mirror parity with the SDK reference', () => {
  it('matches init + onTick sequences and filterActions across a grid', () => {
    const directions = ['long', 'short'] as const
    const paramSets = [
      {},
      { maxSize: 5 },
      { globalStopPrice: 90 },
      { globalStopPrice: 110 },
      { maxSize: 5, releaseLockAfter: 108 },
      { maxSize: 5, releaseLockAfter: 92 },
      { maxSize: 5, globalStopPrice: 85, releaseLockAfter: 112 },
    ]
    // (price, size) sequences hitting cap / breach / release transitions.
    const seqs: Array<Array<[number, number]>> = [
      [[100, 3], [100, 6], [108, 6], [100, 6], [100, 3], [100, 6]],
      [[95, 6], [88, 6], [88, 6], [95, 6], [84, 6]],
      [[112, 5], [80, 5], [112, 5]],
      [[100, 1], [100, 1]],
    ]
    const composedActions = [
      [],
      [
        { type: 'scale_in' as const, sizeFraction: 0.1 },
        { type: 'set_stop_loss' as const, price: 95 },
        { type: 'close' as const, fraction: 0.5 },
      ],
    ]

    let compared = 0
    for (const direction of directions)
      for (const params of paramSets)
        for (const seq of seqs) {
          let stateA = mirror.init!({ params: params as any, position: null as any })
          let stateB = sdk.init!()
          expect(stateA).toEqual(stateB as any)

          for (const [price, size] of seq) {
            const position = {
              id: 'p',
              direction,
              avgEntryPrice: 100,
              size,
              extremePriceAtEntry: 100,
              oppositePrice: 100,
              currentStopLoss: null,
              openedTs: 0,
            }
            const wasLockedA = stateA.scratch.riskLocked === true
            const wasLockedB = (stateB as any).scratch.riskLocked === true
            const wasCapA = stateA.scratch.riskCapReleased === true
            const wasCapB = (stateB as any).scratch.riskCapReleased === true

            expect(
              mirrorEvaluateLock({ params: params as any, position: position as any, price, wasLocked: wasLockedA, capReleased: wasCapA }),
            ).toBe(
              sdkEvaluateLock({ params: params as any, position: position as any, price, wasLocked: wasLockedB, capReleased: wasCapB }),
            )

            for (const actions of composedActions) {
              expect(
                mirrorFilter({
                  params: params as any, position: position as any, price,
                  wasLocked: wasLockedA, wasCapReleased: wasCapA, actions: actions as any,
                }),
              ).toEqual(
                sdkFilter({
                  params: params as any, position: position as any, price,
                  wasLocked: wasLockedB, wasCapReleased: wasCapB, actions: actions as any,
                }) as any,
              )
            }

            const a = mirror.onTick({
              params: params as any, position: position as any, price, ts: 1, state: stateA,
            })
            const b = sdk.onTick({
              params: params as any, position: position as any, price, ts: 1, candle: undefined, state: stateB as any,
            } as any)
            expect(a.actions).toEqual(b.actions as any)
            expect(a.state).toEqual(b.state as any)
            stateA = a.state
            stateB = b.state as any
            compared++
          }
        }
    expect(compared).toBeGreaterThan(200)
  })
})

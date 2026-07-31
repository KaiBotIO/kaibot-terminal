import { describe, expect, it } from 'bun:test'
import { planTakeOver, deriveBotManager } from './take-over.js'

// Pure edge-side take-over decision — ported from the server position-control
// planTakeOver, so the same cases must hold edge-side.

describe('planTakeOver', () => {
  it('no-op when already manual with no managers', () => {
    const plan = planTakeOver({ currentManager: { kind: 'manual' }, activeManagerCount: 0 })
    expect(plan.needed).toBe(false)
    expect(plan.deactivateStrategyId).toBeNull()
    expect(plan.retireManagers).toBe(false)
  })

  it('strategy-managed → deactivate the strategy run loop', () => {
    const plan = planTakeOver({
      currentManager: { kind: 'strategy', strategyId: 'strat1' },
      activeManagerCount: 0,
    })
    expect(plan.needed).toBe(true)
    expect(plan.deactivateStrategyId).toBe('strat1')
    expect(plan.retireManagers).toBe(false)
  })

  it('manual but with active managers → retire managers only', () => {
    const plan = planTakeOver({ currentManager: { kind: 'manual' }, activeManagerCount: 2 })
    expect(plan.needed).toBe(true)
    expect(plan.deactivateStrategyId).toBeNull()
    expect(plan.retireManagers).toBe(true)
  })

  it('strategy + active managers → both released', () => {
    const plan = planTakeOver({
      currentManager: { kind: 'strategy', strategyId: 'strat1' },
      activeManagerCount: 3,
    })
    expect(plan.needed).toBe(true)
    expect(plan.deactivateStrategyId).toBe('strat1')
    expect(plan.retireManagers).toBe(true)
  })

  it('signal_bot manager → needed even with no local managers', () => {
    const plan = planTakeOver({
      currentManager: { kind: 'signal_bot', botId: 'b1', subscriptionId: 's1' },
      activeManagerCount: 0,
    })
    expect(plan.needed).toBe(true)
    expect(plan.deactivateStrategyId).toBeNull()
    expect(plan.retireManagers).toBe(false)
  })
})

describe('deriveBotManager', () => {
  it('running bot → strategy manager carrying the strategyId', () => {
    expect(deriveBotManager({ status: 'running', strategyId: 'strat1' })).toEqual({
      kind: 'strategy',
      strategyId: 'strat1',
    })
  })

  it('paused / stopped bot → manual', () => {
    expect(deriveBotManager({ status: 'paused', strategyId: 'strat1' })).toEqual({ kind: 'manual' })
    expect(deriveBotManager({ status: 'stopped', strategyId: 'strat1' })).toEqual({ kind: 'manual' })
  })
})

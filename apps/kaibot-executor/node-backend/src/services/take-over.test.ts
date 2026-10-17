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

// Ride-bot phase 2: a phasing-out config is still the bot's (exits flow), but
// fresh entries are clipped on the edge.
import { botConfigsBlockSignal, botConfigsClipEntry } from './take-over.js'

describe('phase-out on the edge', () => {
  const cfg = (status: 'running' | 'paused' | 'stopped' | 'phasing_out', symbol = 'MNQ') => ({ symbol, status })

  it('phasing_out never blocks the bot (closes and updates must pass)', () => {
    expect(botConfigsBlockSignal([cfg('phasing_out')], 'MNQ')).toBe(false)
    expect(botConfigsBlockSignal([cfg('paused')], 'MNQ')).toBe(true)
  })

  it('clips entries only while every live config for the symbol is phasing out', () => {
    expect(botConfigsClipEntry([cfg('phasing_out')], 'MNQ')).toBe(true)
    expect(botConfigsClipEntry([cfg('running')], 'MNQ')).toBe(false)
    expect(botConfigsClipEntry([cfg('phasing_out'), cfg('running')], 'MNQ')).toBe(false)
    // Another symbol's phase-out does not clip this one.
    expect(botConfigsClipEntry([cfg('phasing_out', 'MES'), cfg('running', 'MNQ')], 'MNQ')).toBe(false)
    // No live configs at all → not this gate's call.
    expect(botConfigsClipEntry([cfg('stopped')], 'MNQ')).toBe(false)
    expect(botConfigsClipEntry([], 'MNQ')).toBe(false)
  })

  it('a phasing-out config still derives a strategy manager', () => {
    expect(deriveBotManager({ status: 'phasing_out', strategyId: 's1' })).toEqual({ kind: 'strategy', strategyId: 's1' })
  })
})

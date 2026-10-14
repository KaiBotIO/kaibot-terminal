// The registry's emitsStop flag drives the attach-time stop-owner guard
// (position-managers.ts): a manager that can emit set_stop_loss must have the
// ONE stop owner (F1 trail row) before it attaches. This test derives the
// capability empirically — it runs every registry manager's reducer against a
// scenario built to emit set_stop_loss if the manager is capable — and asserts
// the observed capability matches the declared flag. A future manager shipped
// with a wrong emitsStop turns this red.

import { describe, expect, it } from 'bun:test'
import { EDGE_MANAGER_REGISTRY, STOP_EMITTING_MANAGER_IDS } from './registry.js'
import type { GroupAggregateState, ManagedPositionState } from './contract.js'

interface Scenario {
  params: Record<string, unknown>
  position: ManagedPositionState
  path: number[]
  group?: GroupAggregateState
}

// One scenario per manager, tuned so a stop-capable reducer actually emits and
// a non-capable one fires its own action (close/tp) — proving the reducer ran.
const SCENARIOS: Record<string, Scenario> = {
  'break-even-mover': {
    // trigger 0 arms on any favourable tick → break-even stop.
    params: { feePercentage: 0.0015, triggerPercentage: 0 },
    position: mkPos({ extremePriceAtEntry: 105, oppositePrice: 100 }),
    path: [105],
  },
  'drawdown-trailing-stop': {
    // Profitable long with a drawdown depth → trailing stop below price.
    params: {},
    position: mkPos({ extremePriceAtEntry: 130, oppositePrice: 95 }),
    path: [125],
  },
  'tp-ladder': {
    // Price crosses the target → laddered close, never a stop.
    params: { target: 120, levelCount: 3 },
    position: mkPos({ extremePriceAtEntry: 125, oppositePrice: 100 }),
    path: [130],
  },
  'risk-guard': {
    // Price breaches the global stop → hard close, never a set_stop_loss.
    params: { globalStopPrice: 90 },
    position: mkPos({ extremePriceAtEntry: 100, oppositePrice: 85 }),
    path: [85],
  },
  'group-risk-guard': {
    // Group notional breach → close, never a stop.
    params: { maxGroupNotional: 1000 },
    position: mkPos({ extremePriceAtEntry: 100, oppositePrice: 100 }),
    path: [100],
    group: { groupId: 'g', memberCount: 2, unrealizedPnl: -50, notional: 5000, equity: 10000 },
  },
}

function mkPos(over: Partial<ManagedPositionState>): ManagedPositionState {
  return {
    id: 'p',
    direction: 'long',
    avgEntryPrice: 100,
    size: 2,
    extremePriceAtEntry: 100,
    oppositePrice: 100,
    currentStopLoss: null,
    openedTs: 0,
    exchange: 'bybit',
    ...over,
  }
}

function derivesStop(id: string, scenario: Scenario): boolean {
  const { plugin, normalizeParams } = EDGE_MANAGER_REGISTRY[id]!
  const params = normalizeParams(scenario.params)
  const { position, path, group } = scenario
  let state = plugin.init
    ? plugin.init({ params, position })
    : { lastTs: null, position: 'none' as const, scratch: {} }
  let sawStop = false
  let sawAny = false
  for (const price of path) {
    const { actions, state: next } = plugin.onTick({ params, position, price, ts: 1, group, state })
    for (const a of actions) {
      sawAny = true
      if (a.type === 'set_stop_loss') sawStop = true
    }
    state = next
  }
  // Guard against a scenario that silently emits nothing (would make the
  // negative assertion vacuous).
  expect(sawAny).toBe(true)
  return sawStop
}

describe('edge-manager emitsStop capability', () => {
  it('has a scenario for every registered manager', () => {
    for (const id of Object.keys(EDGE_MANAGER_REGISTRY)) {
      expect(SCENARIOS[id], `missing capability scenario for ${id}`).toBeDefined()
    }
  })

  it('derived stop-emit capability matches the declared emitsStop flag', () => {
    for (const [id, def] of Object.entries(EDGE_MANAGER_REGISTRY)) {
      const scenario = SCENARIOS[id]!
      expect(derivesStop(id, scenario), `emitsStop mismatch for ${id}`).toBe(def.emitsStop)
    }
  })

  it('STOP_EMITTING_MANAGER_IDS is exactly the emitsStop set', () => {
    const derived = new Set(
      Object.entries(EDGE_MANAGER_REGISTRY)
        .filter(([, def]) => def.emitsStop)
        .map(([id]) => id),
    )
    expect(STOP_EMITTING_MANAGER_IDS).toEqual(derived)
  })
})

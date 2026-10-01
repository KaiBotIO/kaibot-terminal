import { describe, expect, it } from 'bun:test'
import { SyntheticRebalancer, planRebalance } from './synthetic-rebalancer.js'
import { createSyntheticUsdService, type BasisRefreshResult } from './synthetic-usd.js'

process.env.SYNTHETIC_REBALANCE_ENABLED = '1'

// BTC-PERPETUAL constraints: min 10 USD, step 10.
const STEP = 10
const MIN = 10

// ─── planRebalance (pure) ───

const basePos = {
  short_size: 10_000,
  leverage_cap: 2,
  rebalance_target_pct: 100,
  rebalance_band_pct: 5,
}

describe('planRebalance', () => {
  it('within band → no action (drift 4.9% vs band 5)', () => {
    const d = planRebalance({ ...basePos, short_size: 10_000 }, 10_490, STEP, MIN)
    expect(d.action).toBe('within_band')
  })

  it('outside band up (basis grew) → rebalance to pct×basis, step-rounded', () => {
    const d = planRebalance(basePos, 11_000, STEP, MIN)
    expect(d.action).toBe('rebalance')
    expect(d.nextTargetUsd).toBe(11_000)
    expect(d.desiredShort).toBe(11_000)
  })

  it('outside band down (basis shrank) → rebalance with lower target', () => {
    const d = planRebalance(basePos, 8_000, STEP, MIN)
    expect(d.action).toBe('rebalance')
    expect(d.nextTargetUsd).toBe(8_000)
  })

  it('cap-clamped: target above leverage_cap×basis clamps and flags', () => {
    const d = planRebalance({ ...basePos, rebalance_target_pct: 300 }, 10_000, STEP, MIN)
    expect(d.capped).toBe(true)
    expect(d.nextTargetUsd).toBe(20_000) // 2x cap
  })

  it('basis 0 → target_below_min, never a close order', () => {
    const d = planRebalance(basePos, 0, STEP, MIN)
    expect(d.action).toBe('target_below_min')
    expect(d.nextTargetUsd).toBe(0)
  })

  it('target rounds below the venue minimum → target_below_min', () => {
    const d = planRebalance({ ...basePos, rebalance_target_pct: 100 }, 9, STEP, MIN)
    expect(d.action).toBe('target_below_min')
  })

  it('delta below one step wins from the band (dust)', () => {
    // Tiny position: desired 20, current 15 → drift 25% > band but delta 5 < step.
    const d = planRebalance({ ...basePos, short_size: 15 }, 20, STEP, MIN)
    expect(d.action).toBe('within_band')
  })

  it('band edge: strictly-below skips, at-or-above acts (post step-rounding)', () => {
    // Desired 10,530 (step-rounded) → drift 530/10530 = 5.03% ≥ band 5 → acts.
    const d = planRebalance(basePos, 10_530, STEP, MIN)
    expect(d.driftPct).toBeGreaterThanOrEqual(5)
    expect(d.action).toBe('rebalance')
    // Desired 10,520 → drift 4.94% < 5 → skips.
    expect(planRebalance(basePos, 10_520, STEP, MIN).action).toBe('within_band')
  })
})

// ─── tick() with fakes ───

interface FakeWorld {
  db: any
  manager: any
  adapter: any
  notifications: any
  events: any[]
}

function makeWorld(opts: {
  holdingsUsd: number
  position?: Partial<Record<string, unknown>>
  halted?: boolean
  connected?: boolean
  livePositions?: Array<{ symbol: string; side: 'long' | 'short'; size: number }>
  staleLines?: boolean
}): FakeWorld {
  const positions = new Map<string, any>()
  const mutations: any[] = []
  if (opts.position !== null) {
    positions.set('pos1', {
      id: 'pos1',
      exchange: 'deribit',
      account_id: 'btc',
      symbol: 'BTC-PERPETUAL',
      target_usd: 10_000,
      holdings_basis_usd: 10_000,
      leverage: 1,
      short_size: 10_000,
      leverage_cap: 2,
      status: 'open',
      is_factor_basis: 0,
      auto_rebalance: 1,
      rebalance_target_pct: 100,
      rebalance_band_pct: 5,
      rebalance_basis: 'holdings',
      last_rebalance_at: null,
      ...opts.position,
    })
  }
  const adapter = {
    name: 'deribit',
    placed: [] as any[],
    async placeOrder(o: any) {
      this.placed.push(o)
      return { orderId: `ord_${this.placed.length}`, status: 'filled', filledQuantity: o.quantity }
    },
    async getOrderStatus(orderId: string) {
      return { orderId, state: 'filled', filledQuantity: 0 }
    },
    async cancelOrder() {},
    async getPositions() {
      return (
        opts.livePositions ?? [
          {
            symbol: 'BTC-PERPETUAL',
            side: 'short',
            size: positions.get('pos1')?.short_size ?? 0,
          },
        ]
      ).map((p, i) => ({ id: String(i), accountId: 'btc', entryPrice: 0, ...p }))
    },
  }
  const db = {
    getHaltState: () => ({ halted: opts.halted ?? false, reason: null, tripped_at: null }),
    listAutoRebalanceSyntheticUsdPositions: () =>
      [...positions.values()].filter((p) => p.status === 'open' && p.auto_rebalance === 1),
    listHoldingsBasis: () => [
      {
        source: 'deribit:btc',
        usd_value: opts.holdingsUsd,
        is_manual: 0,
        updated_at: opts.staleLines ? 0 : Date.now(),
      },
    ],
    getSyntheticUsdPosition: (id: string) => positions.get(id) ?? null,
    updateSyntheticUsdPosition: (id: string, patch: any) =>
      positions.set(id, { ...positions.get(id), ...patch }),
    insertSyntheticUsdMutation: (row: any) => mutations.push(row),
    listSyntheticUsdMutations: () => mutations,
    log: () => {},
    _positions: positions,
    _mutations: mutations,
  } as any
  const manager = {
    async getSession() {
      return { status: opts.connected === false ? 'error' : 'connected', adapter }
    },
    async getAllSessions() {
      return [{ status: 'connected', exchangeName: 'deribit', adapter }]
    },
  } as any
  const events: any[] = []
  const notifications = { publish: (e: any) => events.push(e) } as any
  return { db, manager, adapter, notifications, events }
}

function makeRebalancer(world: FakeWorld, over: Partial<Record<string, unknown>> = {}) {
  const refresh: BasisRefreshResult = {
    totalUsd: world.db.listHoldingsBasis().reduce((s: number, l: any) => s + l.usd_value, 0),
    refreshedSources: ['deribit:btc'],
    failures: [],
  }
  return new SyntheticRebalancer({
    db: world.db,
    exchangeManager: world.manager,
    service: createSyntheticUsdService(world.db, world.manager),
    notifications: world.notifications,
    refreshBasis: async () => (over.refresh as BasisRefreshResult) ?? refresh,
    ...over,
  } as any)
}

describe('SyntheticRebalancer.tick', () => {
  it('halted → returns immediately without refreshing the basis', async () => {
    const world = makeWorld({ holdingsUsd: 12_000, halted: true })
    let refreshed = false
    const reb = makeRebalancer(world, {
      refreshBasis: async () => {
        refreshed = true
        return { totalUsd: 0, refreshedSources: [], failures: [] }
      },
    })
    const s = await reb.tick()
    expect(s.skipped.halted).toBe(1)
    expect(refreshed).toBe(false)
    expect(world.adapter.placed.length).toBe(0)
  })

  it('no opted-in rows → no basis refresh, no venue calls', async () => {
    const world = makeWorld({ holdingsUsd: 12_000, position: { auto_rebalance: 0 } })
    let refreshed = false
    const reb = makeRebalancer(world, {
      refreshBasis: async () => {
        refreshed = true
        return { totalUsd: 0, refreshedSources: [], failures: [] }
      },
    })
    const s = await reb.tick()
    expect(s.candidates).toBe(0)
    expect(refreshed).toBe(false)
  })

  it('happy path outside band → one order, auto_rebalance mutation, last_rebalance_at, notify', async () => {
    const world = makeWorld({ holdingsUsd: 12_000 })
    const reb = makeRebalancer(world)
    const s = await reb.tick()
    expect(s.rebalanced).toBe(1)
    expect(world.adapter.placed.length).toBe(1)
    expect(world.adapter.placed[0].side).toBe('sell') // scale up = grow the short
    expect(world.db._mutations[0].kind).toBe('auto_rebalance')
    expect(world.db._positions.get('pos1').last_rebalance_at).toBeGreaterThan(0)
    const ev = world.events.find((e) => e.type === 'synthetic_rebalanced')
    expect(ev).toBeDefined()
  })

  it('within band → no order', async () => {
    const world = makeWorld({ holdingsUsd: 10_200 }) // 2% drift < 5% band
    const reb = makeRebalancer(world)
    const s = await reb.tick()
    expect(s.skipped.within_band).toBe(1)
    expect(world.adapter.placed.length).toBe(0)
  })

  it('disconnected session → skip + one alert, throttled on the next tick', async () => {
    const world = makeWorld({ holdingsUsd: 12_000, connected: false })
    const reb = makeRebalancer(world)
    await reb.tick()
    await reb.tick()
    const alerts = world.events.filter((e) => e.type === 'error')
    expect(alerts.length).toBe(1)
    expect(world.adapter.placed.length).toBe(0)
  })

  it('basis refresh failure for the exchange → stale_basis skip, no order', async () => {
    const world = makeWorld({ holdingsUsd: 12_000 })
    const reb = makeRebalancer(world, {
      refresh: { totalUsd: 12_000, refreshedSources: [], failures: ['deribit'] },
    })
    const s = await reb.tick()
    expect(s.skipped.stale_basis).toBe(1)
    expect(world.adapter.placed.length).toBe(0)
  })

  it('stale venue lines → stale_basis skip', async () => {
    const world = makeWorld({ holdingsUsd: 12_000, staleLines: true })
    const reb = makeRebalancer(world)
    const s = await reb.tick()
    expect(s.skipped.stale_basis).toBe(1)
  })

  it('drift guard: live net does not match books (panic-flattened) → pause + alert, NO order', async () => {
    const world = makeWorld({ holdingsUsd: 12_000, livePositions: [] }) // broker flat
    const reb = makeRebalancer(world)
    const s = await reb.tick()
    expect(s.skipped.drift).toBe(1)
    expect(world.adapter.placed.length).toBe(0)
    const alert = world.events.find((e) => e.type === 'error')
    expect(alert.title).toContain('books do not match')
  })

  it('cooldown: a second tick inside the window skips; persisted timestamp is restart-proof', async () => {
    const world = makeWorld({ holdingsUsd: 12_000 })
    const reb = makeRebalancer(world)
    await reb.tick()
    // livePositions default mirrors books, which now hold the new short size.
    const s2 = await reb.tick()
    expect(s2.skipped.cooldown).toBe(1)
    // Fresh instance (restart) still respects the persisted last_rebalance_at.
    const reb2 = makeRebalancer(world)
    const s3 = await reb2.tick()
    expect(s3.skipped.cooldown).toBe(1)
  })

  it('target below min (basis collapsed) → skip + alert, never a close', async () => {
    const world = makeWorld({ holdingsUsd: 4 })
    const reb = makeRebalancer(world)
    const s = await reb.tick()
    expect(s.skipped.target_below_min).toBe(1)
    expect(world.adapter.placed.length).toBe(0)
    expect(world.db._positions.get('pos1').status).toBe('open')
  })

  it('unknown basis mode → skip + alert', async () => {
    const world = makeWorld({ holdingsUsd: 12_000, position: { rebalance_basis: 'equity' } })
    const reb = makeRebalancer(world)
    const s = await reb.tick()
    expect(s.skipped.unknown_basis_mode).toBe(1)
  })

  it('scale() failure arms the in-memory cooldown (no retry every tick)', async () => {
    const world = makeWorld({ holdingsUsd: 12_000 })
    world.adapter.placeOrder = async () => {
      throw new Error('venue rejected')
    }
    const reb = makeRebalancer(world)
    const s1 = await reb.tick()
    expect(s1.skipped.error).toBe(1)
    const s2 = await reb.tick()
    expect(s2.skipped.cooldown).toBe(1)
  })

  it('cap-clamped end-to-end: order matches cap×basis', async () => {
    const world = makeWorld({
      holdingsUsd: 12_000,
      position: { rebalance_target_pct: 300, short_size: 10_000 },
    })
    const reb = makeRebalancer(world)
    await reb.tick()
    // cap 2 × basis 12000 = 24000 target; delta = 14000 sell.
    expect(world.adapter.placed[0].quantity).toBe(14_000)
  })
})

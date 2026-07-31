import { describe, expect, it } from 'bun:test'
import {
  computeSizing,
  planMutation,
  holdingsBasisTotal,
  createSyntheticUsdService,
  DEFAULT_SYNTHETIC_USD_LEVERAGE_CAP,
} from './synthetic-usd.js'

// Deribit BTC-PERPETUAL: 10 USD step.
const STEP = 10

describe('computeSizing', () => {
  it('sizes the short to the requested target when within the cap', () => {
    const r = computeSizing(5000, 10000, STEP)
    expect(r.targetUsd).toBe(5000)
    expect(r.shortContracts).toBe(5000)
    expect(r.leverage).toBe(0.5)
    expect(r.capped).toBe(false)
  })

  it('clamps the target to the default cap times the holdings basis', () => {
    const r = computeSizing(200000, 10000, STEP)
    expect(r.targetUsd).toBe(DEFAULT_SYNTHETIC_USD_LEVERAGE_CAP * 10000)
    expect(r.leverage).toBe(DEFAULT_SYNTHETIC_USD_LEVERAGE_CAP)
    expect(r.capped).toBe(true)
  })

  // R4: the seeded default must match the EU retail standard (ESMA 2:1).
  // A user can still raise their own cap explicitly; the DEFAULT may not drift up.
  it('seeds the default leverage cap at the 2x retail standard', () => {
    expect(DEFAULT_SYNTHETIC_USD_LEVERAGE_CAP).toBe(2)
  })

  it('rounds the short notional down to the contract step', () => {
    const r = computeSizing(5005, 10000, STEP)
    expect(r.shortContracts).toBe(5000)
  })

  it('returns zero leverage and zero contracts on a zero basis', () => {
    const r = computeSizing(5000, 0, STEP)
    expect(r.targetUsd).toBe(0)
    expect(r.leverage).toBe(0)
    expect(r.shortContracts).toBe(0)
    expect(r.capped).toBe(true)
  })

  it('never raises the request', () => {
    const r = computeSizing(1000, 10000, STEP)
    expect(r.targetUsd).toBeLessThanOrEqual(1000)
  })
})

describe('planMutation', () => {
  it('plans a sell to grow the short (scale up)', () => {
    const p = planMutation(5000, 8000, STEP)
    expect(p.kind).toBe('scale_up')
    expect(p.side).toBe('sell')
    expect(p.orderQty).toBe(3000)
    expect(p.nextShortSize).toBe(8000)
    expect(p.reduceOnly).toBe(false)
  })

  it('plans a reduce-only buy to shrink the short (scale down)', () => {
    const p = planMutation(8000, 5000, STEP)
    expect(p.kind).toBe('scale_down')
    expect(p.side).toBe('buy')
    expect(p.orderQty).toBe(3000)
    expect(p.nextShortSize).toBe(5000)
    expect(p.reduceOnly).toBe(true)
  })

  it('plans a full close to zero with a reduce-only buy', () => {
    const p = planMutation(8000, 0, STEP)
    expect(p.kind).toBe('close')
    expect(p.side).toBe('buy')
    expect(p.orderQty).toBe(8000)
    expect(p.nextShortSize).toBe(0)
    expect(p.reduceOnly).toBe(true)
  })

  it('is a no-op when already at target within one step', () => {
    const p = planMutation(5000, 5005, STEP)
    expect(p.side).toBeNull()
    expect(p.orderQty).toBe(0)
    expect(p.nextShortSize).toBe(5000)
  })
})

// ─── Service logic with a fake db + fake adapter ───

function fakeAdapter() {
  const placed: any[] = []
  return {
    placed,
    name: 'deribit',
    status: 'connected',
    async placeOrder(o: any) {
      placed.push(o)
      return { orderId: `ord_${placed.length}`, status: 'filled', filledQuantity: o.quantity }
    },
    async getOrderStatus(orderId: string) {
      return { orderId, state: 'filled', filledQuantity: 0 }
    },
    async cancelOrder() {},
  }
}

function fakeDb(holdingsUsd: number) {
  const positions = new Map<string, any>()
  const mutations: any[] = []
  return {
    _positions: positions,
    _mutations: mutations,
    listHoldingsBasis: () => [{ source: 'manual:cold', usd_value: holdingsUsd, is_manual: 1, updated_at: 0 }],
    getOpenSyntheticUsdPosition: (ex: string, acc: string, sym: string) =>
      [...positions.values()].find(
        (p) => p.exchange === ex && p.account_id === acc && p.symbol === sym && p.status === 'open',
      ) ?? null,
    getSyntheticUsdPosition: (id: string) => positions.get(id) ?? null,
    insertSyntheticUsdPosition: (row: any) =>
      positions.set(row.id, { ...row, status: 'open', is_factor_basis: 0 }),
    updateSyntheticUsdPosition: (id: string, patch: any) =>
      positions.set(id, { ...positions.get(id), ...patch }),
    insertSyntheticUsdMutation: (row: any) => mutations.push(row),
    listSyntheticUsdMutations: (id: string) => mutations.filter((m) => m.position_id === id),
    setSyntheticUsdFactorBasis: (id: string, enabled: boolean) => {
      for (const p of positions.values()) p.is_factor_basis = 0
      if (enabled) positions.get(id).is_factor_basis = 1
    },
    log: () => {},
  } as any
}

function fakeManager(adapter: any) {
  return {
    async getSession() {
      return { status: 'connected', adapter }
    },
  } as any
}

describe('holdingsBasisTotal', () => {
  it('sums all holdings basis lines', () => {
    const db = fakeDb(25000)
    expect(holdingsBasisTotal(db)).toBe(25000)
  })
})

describe('SyntheticUsdService', () => {
  it('mints a short sized to the target and records the mutation', async () => {
    const adapter = fakeAdapter()
    const db = fakeDb(20000)
    const svc = createSyntheticUsdService(db, fakeManager(adapter))

    const pos = await svc.mint({
      exchange: 'deribit',
      accountId: 'btc',
      symbol: 'BTC-PERPETUAL',
      targetUsd: 10000,
    })

    expect(adapter.placed).toHaveLength(1)
    expect(adapter.placed[0].side).toBe('sell')
    expect(adapter.placed[0].quantity).toBe(10000)
    expect(pos.short_size).toBe(10000)
    expect(pos.leverage).toBe(0.5)
    expect(db._mutations[0].kind).toBe('mint')
  })

  // Regression (full-review 2026-07-04): mint/scale/close discarded the settlement
  // result and booked the position as if the order filled. A rejected/cancelled/
  // timed-out order then diverged the DB from the venue (phantom short). It must
  // throw and leave the DB untouched instead.
  it('does not book a position when the order does not fill', async () => {
    const adapter = fakeAdapter()
    adapter.getOrderStatus = async (orderId: string) => ({ orderId, state: 'rejected', filledQuantity: 0 })
    const db = fakeDb(20000)
    const svc = createSyntheticUsdService(db, fakeManager(adapter))

    await expect(
      svc.mint({ exchange: 'deribit', accountId: 'btc', symbol: 'BTC-PERPETUAL', targetUsd: 10000 }),
    ).rejects.toThrow(/did not fill/i)
    expect(db._positions.size).toBe(0) // no phantom short persisted
  })

  it('caps the mint at the default cap times the holdings basis', async () => {
    const adapter = fakeAdapter()
    const db = fakeDb(5000)
    const svc = createSyntheticUsdService(db, fakeManager(adapter))

    const pos = await svc.mint({
      exchange: 'deribit',
      accountId: 'btc',
      symbol: 'BTC-PERPETUAL',
      targetUsd: 999999,
    })

    const capped = DEFAULT_SYNTHETIC_USD_LEVERAGE_CAP * 5000
    expect(pos.short_size).toBe(capped)
    expect(adapter.placed[0].quantity).toBe(capped)
  })

  // Regression (delta review 2026-07-08): the mint form now sends a user-chosen
  // leverageCap. The server must ENFORCE the value it accepts — clamp the target
  // to basis × cap — not just the built-in 2x default.
  it('enforces a user-supplied leverage cap above the default', async () => {
    const adapter = fakeAdapter()
    const db = fakeDb(5000)
    const svc = createSyntheticUsdService(db, fakeManager(adapter))
    const pos = await svc.mint({
      exchange: 'deribit',
      accountId: 'btc',
      symbol: 'BTC-PERPETUAL',
      targetUsd: 999999,
      leverageCap: 3,
    })
    // basis 5000 × cap 3 = 15000 (the default 2x would have clamped to 10000).
    expect(pos.short_size).toBe(15000)
    expect(pos.leverage_cap).toBe(3)
    expect(adapter.placed[0].quantity).toBe(15000)
  })

  it('enforces a user-supplied leverage cap below the default', async () => {
    const adapter = fakeAdapter()
    const db = fakeDb(5000)
    const svc = createSyntheticUsdService(db, fakeManager(adapter))
    const pos = await svc.mint({
      exchange: 'deribit',
      accountId: 'btc',
      symbol: 'BTC-PERPETUAL',
      targetUsd: 999999,
      leverageCap: 1,
    })
    expect(pos.short_size).toBe(5000)
    expect(pos.leverage_cap).toBe(1)
  })

  it('rejects a second open position for the same market', async () => {
    const adapter = fakeAdapter()
    const db = fakeDb(20000)
    const svc = createSyntheticUsdService(db, fakeManager(adapter))
    const input = { exchange: 'deribit', accountId: 'btc', symbol: 'BTC-PERPETUAL', targetUsd: 1000 }
    await svc.mint(input)
    await expect(svc.mint(input)).rejects.toThrow(/already exists/)
  })

  it('scales up with an additional sell', async () => {
    const adapter = fakeAdapter()
    const db = fakeDb(20000)
    const svc = createSyntheticUsdService(db, fakeManager(adapter))
    const pos = await svc.mint({
      exchange: 'deribit',
      accountId: 'btc',
      symbol: 'BTC-PERPETUAL',
      targetUsd: 5000,
    })
    const scaled = await svc.scale(pos.id, 8000)
    expect(scaled.short_size).toBe(8000)
    const lastOrder = adapter.placed.at(-1)
    expect(lastOrder.side).toBe('sell')
    expect(lastOrder.quantity).toBe(3000)
  })

  it('scales down with a reduce-only buy', async () => {
    const adapter = fakeAdapter()
    const db = fakeDb(20000)
    const svc = createSyntheticUsdService(db, fakeManager(adapter))
    const pos = await svc.mint({
      exchange: 'deribit',
      accountId: 'btc',
      symbol: 'BTC-PERPETUAL',
      targetUsd: 8000,
    })
    const scaled = await svc.scale(pos.id, 5000)
    expect(scaled.short_size).toBe(5000)
    const lastOrder = adapter.placed.at(-1)
    expect(lastOrder.side).toBe('buy')
    expect(lastOrder.reduceOnly).toBe(true)
    expect(lastOrder.quantity).toBe(3000)
  })

  it('closes by buying back the full short and marks it closed', async () => {
    const adapter = fakeAdapter()
    const db = fakeDb(20000)
    const svc = createSyntheticUsdService(db, fakeManager(adapter))
    const pos = await svc.mint({
      exchange: 'deribit',
      accountId: 'btc',
      symbol: 'BTC-PERPETUAL',
      targetUsd: 7000,
    })
    const closed = await svc.close(pos.id)
    expect(closed.status).toBe('closed')
    expect(closed.short_size).toBe(0)
    const lastOrder = adapter.placed.at(-1)
    expect(lastOrder.side).toBe('buy')
    expect(lastOrder.quantity).toBe(7000)
  })

  it('toggles the factor basis exclusively', async () => {
    const adapter = fakeAdapter()
    const db = fakeDb(20000)
    const svc = createSyntheticUsdService(db, fakeManager(adapter))
    const a = await svc.mint({ exchange: 'deribit', accountId: 'btc', symbol: 'BTC-PERPETUAL', targetUsd: 1000 })
    svc.setFactorBasis(a.id, true)
    expect(db.getSyntheticUsdPosition(a.id).is_factor_basis).toBe(1)
    svc.setFactorBasis(a.id, false)
    expect(db.getSyntheticUsdPosition(a.id).is_factor_basis).toBe(0)
  })
})

import { describe, expect, it } from 'bun:test'
import { aggregateHoldingsBasis, createSyntheticUsdService } from './synthetic-usd.js'

// ─── aggregateHoldingsBasis ───

function basisDb() {
  const lines = new Map<string, { source: string; usd_value: number; is_manual: number; updated_at: number }>()
  lines.set('manual:cold', { source: 'manual:cold', usd_value: 5_000, is_manual: 1, updated_at: 0 })
  return {
    _lines: lines,
    listHoldingsBasis: () => [...lines.values()],
    setHoldingsBasis: (source: string, usd: number, isManual: boolean) =>
      lines.set(source, { source, usd_value: usd, is_manual: isManual ? 1 : 0, updated_at: Date.now() }),
    log: () => {},
  } as any
}

function sessionOf(adapter: any, exchangeName = 'deribit', status = 'connected') {
  return { status, exchangeName, adapter }
}

describe('aggregateHoldingsBasis', () => {
  it('writes a venue line from BTC equity × mark price and sums with manual lines', async () => {
    const db = basisDb()
    const adapter = {
      async getBalances() {
        return [{ accountId: 'btc', equity: 0.5, balance: 0.5, currency: 'BTC' }]
      },
      async getLastPrice(symbol: string) {
        return symbol === 'BTC-PERPETUAL' ? 60_000 : null
      },
    }
    const manager = { async getAllSessions() { return [sessionOf(adapter)] } } as any
    const res = await aggregateHoldingsBasis(db, manager)
    expect(db._lines.get('deribit:btc')?.usd_value).toBe(30_000)
    expect(db._lines.get('deribit:btc')?.is_manual).toBe(0)
    expect(res.totalUsd).toBe(35_000) // 30k venue + 5k manual
    expect(res.refreshedSources).toEqual(['deribit:btc'])
    expect(res.failures).toEqual([])
  })

  it('price unavailable → venue in failures, existing line NOT overwritten', async () => {
    const db = basisDb()
    db.setHoldingsBasis('deribit:btc', 28_000, false)
    const before = db._lines.get('deribit:btc')
    const adapter = {
      async getBalances() {
        return [{ accountId: 'btc', equity: 0.5, currency: 'BTC' }]
      },
      async getLastPrice() {
        return null
      },
    }
    const manager = { async getAllSessions() { return [sessionOf(adapter)] } } as any
    const res = await aggregateHoldingsBasis(db, manager)
    expect(res.failures).toEqual(['deribit'])
    expect(db._lines.get('deribit:btc')).toBe(before)
  })

  it('adapter without getLastPrice → failure for coin balances', async () => {
    const db = basisDb()
    const adapter = {
      async getBalances() {
        return [{ accountId: 'btc', equity: 0.5, currency: 'BTC' }]
      },
    }
    const manager = { async getAllSessions() { return [sessionOf(adapter)] } } as any
    const res = await aggregateHoldingsBasis(db, manager)
    expect(res.failures).toEqual(['deribit'])
  })

  it('getBalances throws → that venue fails, others still refresh', async () => {
    const db = basisDb()
    const broken = { async getBalances() { throw new Error('down') } }
    const ok = {
      async getBalances() {
        return [{ accountId: 'main', equity: 1_500, currency: 'USDT' }]
      },
    }
    const manager = {
      async getAllSessions() {
        return [sessionOf(broken, 'deribit'), sessionOf(ok, 'bybit')]
      },
    } as any
    const res = await aggregateHoldingsBasis(db, manager)
    expect(res.failures).toEqual(['deribit'])
    expect(db._lines.get('bybit:main')?.usd_value).toBe(1_500)
  })

  it('USD-quoted currencies pass 1:1 without a price lookup', async () => {
    const db = basisDb()
    const adapter = {
      async getBalances() {
        return [{ accountId: 'usdc', equity: 2_000, currency: 'USDC' }]
      },
    }
    const manager = { async getAllSessions() { return [sessionOf(adapter)] } } as any
    await aggregateHoldingsBasis(db, manager)
    expect(db._lines.get('deribit:usdc')?.usd_value).toBe(2_000)
  })

  it('disconnected sessions are skipped silently (no failure)', async () => {
    const db = basisDb()
    const adapter = { async getBalances() { return [] } }
    const manager = {
      async getAllSessions() {
        return [sessionOf(adapter, 'deribit', 'error')]
      },
    } as any
    const res = await aggregateHoldingsBasis(db, manager)
    expect(res.failures).toEqual([])
    expect(res.refreshedSources).toEqual([])
  })
})

// ─── scale kindOverride + setAutoRebalance ───

function serviceWorld(holdingsUsd: number) {
  const positions = new Map<string, any>()
  const mutations: any[] = []
  positions.set('pos1', {
    id: 'pos1',
    exchange: 'deribit',
    account_id: 'btc',
    symbol: 'BTC-PERPETUAL',
    target_usd: 10_000,
    holdings_basis_usd: holdingsUsd,
    leverage: 1,
    short_size: 10_000,
    leverage_cap: 2,
    status: 'open',
    is_factor_basis: 0,
    auto_rebalance: 0,
    rebalance_target_pct: 100,
    rebalance_band_pct: 5,
    rebalance_basis: 'holdings',
    last_rebalance_at: null,
  })
  const db = {
    listHoldingsBasis: () => [
      { source: 'manual:cold', usd_value: holdingsUsd, is_manual: 1, updated_at: Date.now() },
    ],
    getSyntheticUsdPosition: (id: string) => positions.get(id) ?? null,
    updateSyntheticUsdPosition: (id: string, patch: any) =>
      positions.set(id, { ...positions.get(id), ...patch }),
    insertSyntheticUsdMutation: (row: any) => mutations.push(row),
    listSyntheticUsdMutations: () => mutations,
    log: () => {},
    _mutations: mutations,
    _positions: positions,
  } as any
  const adapter = {
    async placeOrder(o: any) {
      return { orderId: 'ord1', status: 'filled', filledQuantity: o.quantity }
    },
    async getOrderStatus(orderId: string) {
      return { orderId, state: 'filled', filledQuantity: 0 }
    },
    async cancelOrder() {},
  }
  const manager = { async getSession() { return { status: 'connected', adapter } } } as any
  return { db, service: createSyntheticUsdService(db, manager) }
}

describe('scale kindOverride', () => {
  it("logs 'auto_rebalance' when overridden, plain scale kinds otherwise", async () => {
    const { db, service } = serviceWorld(20_000)
    await service.scale('pos1', 12_000, undefined, { kindOverride: 'auto_rebalance' })
    expect(db._mutations[0].kind).toBe('auto_rebalance')
    await service.scale('pos1', 13_000)
    expect(db._mutations[1].kind).toBe('scale_up')
  })
})

describe('setAutoRebalance', () => {
  it('enables with valid config and persists the numbers', () => {
    const { service } = serviceWorld(20_000)
    const row = service.setAutoRebalance('pos1', { enabled: true, targetPct: 100, bandPct: 5 })
    expect(row.auto_rebalance).toBe(1)
    expect(row.rebalance_target_pct).toBe(100)
    expect(row.rebalance_band_pct).toBe(5)
    // Disable keeps the numbers.
    const off = service.setAutoRebalance('pos1', { enabled: false })
    expect(off.auto_rebalance).toBe(0)
    expect(off.rebalance_target_pct).toBe(100)
  })

  it('rejects invalid configs', () => {
    const { service, db } = serviceWorld(20_000)
    expect(() => service.setAutoRebalance('pos1', { enabled: true })).toThrow(/targetPct/)
    expect(() => service.setAutoRebalance('pos1', { enabled: true, targetPct: -5 })).toThrow(/targetPct/)
    // leverage_cap 2 → max 200%.
    expect(() => service.setAutoRebalance('pos1', { enabled: true, targetPct: 250 })).toThrow(/leverage cap/)
    expect(() => service.setAutoRebalance('pos1', { enabled: true, targetPct: 100, bandPct: 0.5 })).toThrow(/bandPct/)
    expect(() =>
      service.setAutoRebalance('pos1', { enabled: true, targetPct: 100, basis: 'equity' }),
    ).toThrow(/holdings/)
    // Closed position refuses config.
    db.updateSyntheticUsdPosition('pos1', { status: 'closed' })
    expect(() => service.setAutoRebalance('pos1', { enabled: true, targetPct: 100 })).toThrow(/closed/)
  })
})

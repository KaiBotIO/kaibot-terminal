import { describe, expect, it } from 'bun:test'
import { TradeStationOAuthAdapter } from './exchanges/adapters/tradestation-oauth.js'
import {
  isProtectiveStop,
  replaceServerExitStop,
  retireOldStop,
  serverExitEffectiveStop,
  serverExitEngineStop,
  serverExitStopNeedsMove,
} from './server-exit-stop.js'

// The stop floor on a bot position composes exactly like the edge trail rows:
// manual always participates, engine only improves, lock = manual absolute.

function state(over: Record<string, unknown> = {}) {
  return {
    position_id: 'pos-1',
    entry_signal_id: 'entry-1',
    exchange: 'deribit',
    symbol: 'BTC-PERPETUAL',
    direction: 'long' as const,
    last_exit_seq: 2,
    current_stop: 55000,
    sl_order_id: 'sl-0',
    manual_stop: null as number | null,
    trailing_lock: 0,
    engine_stop: 55000 as number | null,
    ...over,
  }
}

describe('serverExitEffectiveStop', () => {
  it('no floor: the bot stop stands', () => {
    expect(serverExitEffectiveStop(state())).toBe(55000)
  })
  it('long: floor above the bot stop lifts it; below it the bot stop stands', () => {
    expect(serverExitEffectiveStop(state({ manual_stop: 58000 }))).toBe(58000)
    expect(serverExitEffectiveStop(state({ manual_stop: 52000 }))).toBe(55000)
  })
  it('short: floor below the bot stop tightens it; above it the bot stop stands', () => {
    expect(serverExitEffectiveStop(state({ direction: 'short', manual_stop: 62000, engine_stop: 65000 }))).toBe(62000)
    expect(serverExitEffectiveStop(state({ direction: 'short', manual_stop: 68000, engine_stop: 65000 }))).toBe(65000)
  })
  it('locked: the floor is absolute, even against the position', () => {
    expect(serverExitEffectiveStop(state({ manual_stop: 52000, trailing_lock: 1 }))).toBe(52000)
    expect(serverExitEffectiveStop(state({ manual_stop: null, trailing_lock: 1 }))).toBe(55000)
  })
  it('a fresh bot candidate composes the same way (unlock resumes from it)', () => {
    expect(serverExitEffectiveStop(state({ manual_stop: 58000 }), 59000)).toBe(59000)
    expect(serverExitEffectiveStop(state({ manual_stop: 58000, trailing_lock: 1 }), 59000)).toBe(58000)
  })
  it('rows from before migration 038 carry the bot stop in current_stop only', () => {
    const legacy = { ...state(), engine_stop: undefined, manual_stop: undefined, trailing_lock: undefined } as any
    expect(serverExitEngineStop(legacy)).toBe(55000)
    expect(serverExitEffectiveStop(legacy)).toBe(55000)
  })
  it('removing the floor falls back to the bot stop', () => {
    expect(serverExitEffectiveStop(state({ manual_stop: null, trailing_lock: 0 }))).toBe(55000)
  })
})

describe('serverExitStopNeedsMove / isProtectiveStop', () => {
  it('no move when the resting stop already sits at the effective level', () => {
    expect(serverExitStopNeedsMove(state(), 55000)).toBe(false)
    expect(serverExitStopNeedsMove(state(), 55000 + 1e-12)).toBe(false)
    expect(serverExitStopNeedsMove(state(), 58000)).toBe(true)
    expect(serverExitStopNeedsMove(state(), null)).toBe(false)
  })
  it('a missing resting order always needs a placement', () => {
    expect(serverExitStopNeedsMove(state({ sl_order_id: null }), 55000)).toBe(true)
  })
  it('a stop protects only on the correct side of the market (EX4)', () => {
    expect(isProtectiveStop('long', 58000, 61000)).toBe(true)
    expect(isProtectiveStop('long', 62000, 61000)).toBe(false)
    expect(isProtectiveStop('short', 63000, 61000)).toBe(true)
    expect(isProtectiveStop('short', 60000, 61000)).toBe(false)
  })
})

describe('replaceServerExitStop', () => {
  function harness() {
    const placed: any[] = []
    const cancelled: string[] = []
    const patches: any[] = []
    const orderIds: any[] = []
    const trailPatches: any[] = []
    const db = {
      getSignalBracket: () => ({ stop_loss_order_id: 'sl-0', take_profit_order_id: 'tp-0' }),
      applyServerExitUpdate: (id: string, patch: any) => patches.push({ id, ...patch }),
      updateSignalOrderIds: (id: string, sl?: string, tp?: string) => orderIds.push({ id, sl, tp }),
      updateLocalTrail: (id: string, patch: any) => trailPatches.push({ id, ...patch }),
      log: () => {},
    }
    const adapter = {
      placeOrder: async (o: any) => {
        placed.push(o)
        if (o.stopPrice === 1) throw new Error('venue said no')
        return { orderId: `new-${placed.length}`, status: 'pending' as const, filledQuantity: 0, averagePrice: 0 }
      },
      cancelOrder: async (id: string) => {
        cancelled.push(id)
      },
    }
    const live = { id: 'p', accountId: 'acct-1', symbol: 'BTC-PERPETUAL', side: 'long' as const, size: 10, entryPrice: 60000, markPrice: 61000 }
    return { db, adapter, live, placed, cancelled, patches, orderIds, trailPatches }
  }

  it('cancels the resting stop, places one reduce-only stop and re-points every record', async () => {
    const h = harness()
    const out = await replaceServerExitStop({
      db: h.db as any, adapter: h.adapter as any, state: state(), live: h.live as any,
      lineageAccount: 'acct-1', stopPrice: 58000, exitSeq: 2, label: 'kaibot:entry-1:stop-floor',
    })
    expect(h.cancelled).toEqual(['sl-0'])
    expect(h.placed).toHaveLength(1)
    expect(h.placed[0]).toMatchObject({ orderType: 'stop', side: 'sell', stopPrice: 58000, reduceOnly: true, quantity: 10 })
    expect(out.orderId).toBe('new-1')
    // Floor-only amend: the bot stop is untouched.
    expect(h.patches).toEqual([{ id: 'pos-1', exitSeq: 2, currentStop: 58000, slOrderId: 'new-1' }])
    expect(h.orderIds).toEqual([{ id: 'entry-1', sl: 'new-1', tp: 'tp-0' }])
    expect(h.trailPatches).toEqual([{ id: 'entry-1', slOrderId: 'new-1', currentStop: 58000 }])
  })

  it('records the bot stop when one is passed (server exit update)', async () => {
    const h = harness()
    await replaceServerExitStop({
      db: h.db as any, adapter: h.adapter as any, state: state({ manual_stop: 58000 }), live: h.live as any,
      lineageAccount: 'acct-1', stopPrice: 59000, exitSeq: 3, engineStop: 59000, label: 'x',
    })
    expect(h.patches[0]).toMatchObject({ exitSeq: 3, currentStop: 59000, engineStop: 59000 })
  })

  it('a failed placement drops the stale id, keeps the seq and rethrows', async () => {
    const h = harness()
    await expect(
      replaceServerExitStop({
        db: h.db as any, adapter: h.adapter as any, state: state(), live: h.live as any,
        lineageAccount: 'acct-1', stopPrice: 1, exitSeq: 3, label: 'x',
      }),
    ).rejects.toThrow('venue said no')
    expect(h.patches).toEqual([{ id: 'pos-1', exitSeq: 2, currentStop: 55000, slOrderId: null }])
    expect(h.orderIds).toEqual([{ id: 'entry-1', sl: undefined, tp: 'tp-0' }])
  })
})

// TradeStation can only look an order up under its account: without it every
// status read is an unconfirmed 'unknown', so a stop that really is gone was
// treated as unresolved and never replaced in the same update.
describe('retireOldStop on TradeStation', () => {
  function tsVenue() {
    const ts = new TradeStationOAuthAdapter()
    const seen: string[] = []
    ;(ts as any).call = async (endpoint: string, method = 'GET') => {
      seen.push(`${method} ${endpoint}`)
      if (method === 'DELETE') throw new Error('404 Order not found')
      return { Orders: [] }
    }
    return { ts, seen }
  }

  it('with the lineage account: the venue confirms the stop is gone', async () => {
    const { ts, seen } = tsVenue()
    const r = await retireOldStop(ts as any, '1324188752', 'MNQZ26', undefined, 'SIM123')
    expect(r.outcome).toBe('gone')
    expect(seen).toContain('GET /v3/brokerage/accounts/SIM123/orders/1324188752')
  })

  it('without an account the lookup cannot run: unresolved', async () => {
    const { ts } = tsVenue()
    expect((await retireOldStop(ts as any, '1324188752', 'MNQZ26')).outcome).toBe('unresolved')
  })

  it('replaceServerExitStop passes the lineage account, so the replacement goes up', async () => {
    const { ts, seen } = tsVenue()
    const placed: any[] = []
    ;(ts as any).placeOrder = async (o: any) => {
      placed.push(o)
      return { orderId: 'new-1', status: 'pending', filledQuantity: 0 }
    }
    const applied: any[] = []
    const db = {
      getSignalBracket: () => ({ stop_loss_order_id: '1324188752', take_profit_order_id: null }),
      applyServerExitUpdate: (_id: string, patch: any) => applied.push(patch),
      updateSignalOrderIds: () => {},
      log: () => {},
    }
    await replaceServerExitStop({
      db,
      adapter: ts as any,
      state: state({ exchange: 'tradestation', symbol: 'MNQZ26', sl_order_id: '1324188752', current_stop: 21000, engine_stop: 21000 }),
      live: { id: 'p', accountId: 'SIM123', symbol: 'MNQZ26', side: 'long', size: 1, entryPrice: 21500 },
      lineageAccount: 'SIM123',
      stopPrice: 21200,
      exitSeq: 3,
      label: 'kaibot:entry-1:exit-update',
    })
    expect(seen).toContain('GET /v3/brokerage/accounts/SIM123/orders/1324188752')
    expect(placed).toHaveLength(1)
    expect(applied.at(-1)).toMatchObject({ exitSeq: 3, slOrderId: 'new-1' })
  })
})

describe('retireOldStop: a refused cancel on a live order is never gone', () => {
  it('TradeStation: DELETE says too late to cancel, the order is still OPN, so no replacement', async () => {
    const ts = new TradeStationOAuthAdapter()
    ;(ts as any).call = async (endpoint: string, method = 'GET') => {
      if (method === 'DELETE') throw new Error('too late to cancel')
      if (endpoint.includes('/orders/1324188752')) return { Orders: [{ OrderID: '1324188752', Status: 'OPN' }] }
      return { Orders: [] }
    }
    const placed: any[] = []
    ;(ts as any).placeOrder = async (o: any) => {
      placed.push(o)
      return { orderId: 'new-1', status: 'pending', filledQuantity: 0 }
    }
    expect((await retireOldStop(ts as any, '1324188752', 'MNQZ26', undefined, 'SIM123')).outcome).toBe('unresolved')

    const applied: any[] = []
    const db = {
      getSignalBracket: () => ({ stop_loss_order_id: '1324188752', take_profit_order_id: null }),
      applyServerExitUpdate: (_id: string, patch: any) => applied.push(patch),
      updateSignalOrderIds: () => {},
      log: () => {},
    }
    await expect(
      replaceServerExitStop({
        db,
        adapter: ts as any,
        state: state({ exchange: 'tradestation', symbol: 'MNQZ26', sl_order_id: '1324188752', current_stop: 21000, engine_stop: 21000 }),
        live: { id: 'p', accountId: 'SIM123', symbol: 'MNQZ26', side: 'long', size: 1, entryPrice: 21500 },
        lineageAccount: 'SIM123',
        stopPrice: 21200,
        exitSeq: 3,
        label: 'kaibot:entry-1:exit-update',
      }),
    ).rejects.toThrow()
    expect(placed).toEqual([])
    expect(applied).toEqual([])
  })
})

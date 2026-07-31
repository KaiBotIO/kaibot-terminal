import { describe, expect, it } from 'bun:test'
import { createManualTradeService } from './manual-trade.js'

// Fake adapter with no getOrderStatus, so settleAdapterOrder returns immediately
// (it treats the placeOrder result as authoritative). Records every placed order.
function fakeAdapter(
  positions: Array<{ symbol: string; side: 'long' | 'short'; size: number }> = [],
  rejectLabels: string[] = [],
  pendingLabels: string[] = [], // orders that REST at the venue (e.g. limit rungs)
) {
  const placed: any[] = []
  const cancelled: string[] = []
  return {
    placed,
    cancelled,
    name: 'deribit',
    async getAccounts() {
      return [{ id: 'acc_1', exchangeName: 'deribit', accountId: 'acc_1', name: 'Main', currency: 'BTC' }]
    },
    async getPositions() {
      return positions.map((p, i) => ({ id: `p_${i}`, accountId: 'acc_1', entryPrice: 100, ...p }))
    },
    async placeOrder(o: any) {
      placed.push(o)
      const rejected = rejectLabels.includes(o.label)
      const pending = pendingLabels.includes(o.label)
      return {
        orderId: `ord_${placed.length}`,
        status: rejected ? 'rejected' : pending ? 'pending' : 'filled',
        filledQuantity: rejected || pending ? 0 : o.quantity,
        averagePrice: 100,
      }
    },
    async cancelOrder(id: string) {
      cancelled.push(id)
    },
  }
}

function fakeManager(adapter: any, status: 'connected' | 'disconnected' = 'connected') {
  return {
    async getSession() {
      return { userId: 'default', exchangeName: 'deribit', adapter, status }
    },
  } as any
}

// In-memory stand-in for the durability spine the service now writes to
// (order_settlements dedup/known-ids + manual_positions marker).
function fakeDb() {
  const settlements: any[] = []
  const manual = new Map<string, { net: number }>()
  const dcaRungs: any[] = []
  const key = (e: string, a: string, s: string) => `${e}|${a}|${s}`
  let seq = 0
  return {
    settlements,
    manual,
    dcaRungs,
    log() {},
    insertDcaRestingRung(row: any) {
      dcaRungs.push({ ...row, filledQty: 0 })
    },
    setDcaRestingRungFilledQty(orderId: string, filledQty: number) {
      const r = dcaRungs.find((x) => x.orderId === orderId)
      if (r) r.filledQty = filledQty
    },
    insertOrderSettlement(row: any) {
      const id = ++seq
      settlements.push({
        id,
        signal_id: row.signalId,
        exchange: row.exchange,
        symbol: row.symbol,
        kind: row.kind,
        side: row.side,
        qty: row.qty,
        order_id: row.orderId,
        target_label: row.targetLabel ?? null,
        status: row.status ?? 'unknown',
      })
      return id
    },
    resolveOrderSettlement(id: number, status: string) {
      const r = settlements.find((x) => x.id === id)
      if (r) r.status = status
    },
    getExitSettlement(signalId: string, kind: string, targetLabel: string) {
      return settlements.find(
        (x) => x.signal_id === signalId && x.kind === kind && x.target_label === targetLabel,
      )
    },
    addManualPosition(e: string, a: string, s: string, side: 'buy' | 'sell', qty: number) {
      const k = key(e, a, s)
      const net = (manual.get(k)?.net ?? 0) + (side === 'buy' ? qty : -qty)
      if (Math.abs(net) < 1e-9) manual.delete(k)
      else manual.set(k, { net })
    },
    reduceManualPosition(e: string, a: string, s: string, qty: number) {
      const k = key(e, a, s)
      const cur = manual.get(k)
      if (!cur) return
      const mag = Math.max(0, Math.abs(cur.net) - Math.abs(qty))
      if (mag < 1e-9) manual.delete(k)
      else manual.set(k, { net: cur.net < 0 ? -mag : mag })
    },
    listManualEntrySignalIds(e: string, s: string) {
      return [
        ...new Set(
          settlements
            .filter(
              (x) =>
                x.exchange === e && x.symbol === s && x.kind === 'entry' && String(x.signal_id).startsWith('manual:'),
            )
            .map((x) => x.signal_id),
        ),
      ]
    },
    findActiveTrailsForSymbol() {
      return []
    },
    deactivateLocalTrail() {},
  } as any
}

describe('manual-trade service — place', () => {
  it('places a market order with the real (absolute) quantity', async () => {
    const adapter = fakeAdapter()
    const svc = createManualTradeService(fakeDb(), fakeManager(adapter))
    const r = await svc.place({ exchange: 'deribit', symbol: 'BTC-PERPETUAL', side: 'buy', quantity: 25 })
    expect(adapter.placed).toHaveLength(1)
    expect(adapter.placed[0]).toMatchObject({ side: 'buy', orderType: 'market', quantity: 25, accountId: 'acc_1' })
    expect(r.orderId).toBe('ord_1')
    expect(r.status).toBe('filled')
  })

  it('USD-mode on an inverse perp: the USD notional IS the order amount (rounded to step)', async () => {
    // deribit BTC-PERPETUAL is inverse (amount in USD, static step 10).
    const adapter = fakeAdapter()
    const svc = createManualTradeService(fakeDb(), fakeManager(adapter))
    const r = await svc.place({
      exchange: 'deribit',
      symbol: 'BTC-PERPETUAL',
      side: 'buy',
      quantity: 255, // USD; rounds down to 250 on the 10-USD step
      sizeUnit: 'usd',
    })
    expect(adapter.placed[0].quantity).toBe(250)
    expect(r.status).toBe('filled')
  })

  it('USD-mode on a linear coin perp converts via the mark price and rounds to step', async () => {
    // deribit SOL_USDC-PERPETUAL is linear (amount in SOL). $500 @ $150 -> 3.3.
    const adapter = { ...fakeAdapter(), async getLastPrice() { return 150 } }
    const svc = createManualTradeService(fakeDb(), fakeManager(adapter))
    // Seed the dynamic constraint so the test doesn't hit the network.
    const { ensureContractConstraints } = await import('./exchanges/contract-constraints.js')
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ result: { min_trade_amount: 0.1, contract_size: 0.1 } }))) as unknown as typeof fetch
    await ensureContractConstraints('deribit', 'SOL_USDC-PERPETUAL')
    globalThis.fetch = realFetch

    const r = await svc.place({
      exchange: 'deribit',
      symbol: 'SOL_USDC-PERPETUAL',
      side: 'buy',
      quantity: 500,
      sizeUnit: 'usd',
    })
    expect(adapter.placed[0].quantity).toBeCloseTo(3.3, 10)
    expect(r.status).toBe('filled')
  })

  it('places a reduce-only SL (opposite side, stop) and TP (opposite side, limit) bracket', async () => {
    const adapter = fakeAdapter()
    const svc = createManualTradeService(fakeDb(), fakeManager(adapter))
    const r = await svc.place({
      exchange: 'deribit',
      symbol: 'BTC-PERPETUAL',
      side: 'buy',
      quantity: 10,
      stopLoss: 90,
      takeProfit: 120,
    })
    expect(adapter.placed).toHaveLength(3)
    expect(adapter.placed[1]).toMatchObject({ side: 'sell', orderType: 'stop', stopPrice: 90, reduceOnly: true, quantity: 10 })
    expect(adapter.placed[2]).toMatchObject({ side: 'sell', orderType: 'limit', price: 120, reduceOnly: true, quantity: 10 })
    expect(r.stopLossOrderId).toBe('ord_2')
    expect(r.takeProfitOrderId).toBe('ord_3')
  })

  it('does NOT place a protective bracket when the entry is rejected', async () => {
    const adapter = fakeAdapter([], ['kaibot-manual']) // entry rejected
    const svc = createManualTradeService(fakeDb(), fakeManager(adapter))
    const r = await svc.place({
      exchange: 'deribit',
      symbol: 'BTC-PERPETUAL',
      side: 'buy',
      quantity: 10,
      stopLoss: 90,
      takeProfit: 120,
    })
    expect(adapter.placed).toHaveLength(1) // only the entry attempt, no SL/TP
    expect(r.status).toBe('rejected')
    expect(r.stopLossOrderId).toBeUndefined()
    expect(r.warnings?.some((w) => /rejected/i.test(w))).toBe(true)
  })

  it('surfaces a rejected stop-loss as a warning but still places the rest', async () => {
    const adapter = fakeAdapter([], ['kaibot-manual-sl']) // only the SL leg rejected
    const svc = createManualTradeService(fakeDb(), fakeManager(adapter))
    const r = await svc.place({
      exchange: 'deribit',
      symbol: 'BTC-PERPETUAL',
      side: 'buy',
      quantity: 10,
      stopLoss: 90,
      takeProfit: 120,
    })
    expect(adapter.placed).toHaveLength(3) // entry + sl + tp all attempted
    expect(r.status).toBe('filled')
    expect(r.warnings?.some((w) => /not protected/i.test(w))).toBe(true)
  })

  it('rejects a limit order without a price', async () => {
    const svc = createManualTradeService(fakeDb(), fakeManager(fakeAdapter()))
    await expect(
      svc.place({ exchange: 'deribit', symbol: 'BTC-PERPETUAL', side: 'buy', orderType: 'limit', quantity: 1 }),
    ).rejects.toThrow(/price/)
  })

  it('rejects a non-positive quantity', async () => {
    const svc = createManualTradeService(fakeDb(), fakeManager(fakeAdapter()))
    await expect(
      svc.place({ exchange: 'deribit', symbol: 'BTC-PERPETUAL', side: 'buy', quantity: 0 }),
    ).rejects.toThrow(/quantity/)
  })

  it('throws when the exchange is not connected', async () => {
    const svc = createManualTradeService(fakeDb(), fakeManager(fakeAdapter(), 'disconnected'))
    await expect(
      svc.place({ exchange: 'deribit', symbol: 'BTC-PERPETUAL', side: 'buy', quantity: 1 }),
    ).rejects.toThrow(/not connected/)
  })
})

describe('manual-trade service — close', () => {
  it('closes a long fully with a reduce-only sell of the position size', async () => {
    const adapter = fakeAdapter([{ symbol: 'BTC-PERPETUAL', side: 'long', size: 40 }])
    const svc = createManualTradeService(fakeDb(), fakeManager(adapter))
    const r = await svc.close({ exchange: 'deribit', symbol: 'BTC-PERPETUAL' })
    expect(adapter.placed[0]).toMatchObject({ side: 'sell', orderType: 'market', quantity: 40, reduceOnly: true })
    expect(r.closedQuantity).toBe(40)
  })

  it('closes a short with a reduce-only buy, scaled by fraction', async () => {
    const adapter = fakeAdapter([{ symbol: 'BTC-PERPETUAL', side: 'short', size: 40 }])
    const svc = createManualTradeService(fakeDb(), fakeManager(adapter))
    const r = await svc.close({ exchange: 'deribit', symbol: 'BTC-PERPETUAL', fraction: 0.5 })
    expect(adapter.placed[0]).toMatchObject({ side: 'buy', quantity: 20, reduceOnly: true })
    expect(r.closedQuantity).toBe(20)
  })

  it('throws when there is no open position for the symbol', async () => {
    const svc = createManualTradeService(fakeDb(), fakeManager(fakeAdapter([])))
    await expect(svc.close({ exchange: 'deribit', symbol: 'BTC-PERPETUAL' })).rejects.toThrow(/no open position/)
  })

  it('rejects a fraction outside (0, 1]', async () => {
    const adapter = fakeAdapter([{ symbol: 'BTC-PERPETUAL', side: 'long', size: 40 }])
    const svc = createManualTradeService(fakeDb(), fakeManager(adapter))
    await expect(
      svc.close({ exchange: 'deribit', symbol: 'BTC-PERPETUAL', fraction: 1.5 }),
    ).rejects.toThrow(/fraction/)
  })

  // F1: a FULL close retires an edge trail on the position — cancels the
  // trail-owned stop (it may not sit in any bracket) and deactivates the row,
  // so no reduce-only stop orphans against a flat position.
  it('a full close cancels the edge-trail stop and deactivates the trail; a partial keeps it', async () => {
    const deactivated: string[] = []
    const trailRow = {
      signal_id: 'pos:deribit:acc_1:BTC-PERPETUAL',
      sl_order_id: 'sl-trail',
      source: 'manual',
    }
    const db = {
      ...fakeDb(),
      findActiveTrailsForSymbol: () => [trailRow],
      deactivateLocalTrail: (key: string) => deactivated.push(key),
    }
    const adapter = fakeAdapter([{ symbol: 'BTC-PERPETUAL', side: 'long', size: 40 }])
    const svc = createManualTradeService(db as any, fakeManager(adapter))

    await svc.close({ exchange: 'deribit', symbol: 'BTC-PERPETUAL', fraction: 0.5 })
    expect(adapter.cancelled).toHaveLength(0)
    expect(deactivated).toHaveLength(0)

    await svc.close({ exchange: 'deribit', symbol: 'BTC-PERPETUAL' })
    expect(adapter.cancelled).toContain('sl-trail')
    expect(deactivated).toEqual(['pos:deribit:acc_1:BTC-PERPETUAL'])
  })
})

// ── Part D: resilience (idempotency, marker, bracket persistence) ──

describe('manual-trade service — idempotency', () => {
  it('dedups a duplicate submit with the same idempotency key (no second order)', async () => {
    const adapter = fakeAdapter()
    const db = fakeDb()
    const svc = createManualTradeService(db, fakeManager(adapter))
    const input = { exchange: 'deribit', symbol: 'BTC-PERPETUAL', side: 'buy' as const, quantity: 5, idempotencyKey: 'abc-123' }
    const r1 = await svc.place(input)
    const r2 = await svc.place(input)
    expect(adapter.placed).toHaveLength(1) // second submit short-circuits
    expect(r2.orderId).toBe(r1.orderId)
    expect(r2.warnings?.some((w) => /duplicate/i.test(w))).toBe(true)
  })

  it('forwards the idempotency key to the broker as a client order id', async () => {
    const adapter = fakeAdapter()
    const svc = createManualTradeService(fakeDb(), fakeManager(adapter))
    await svc.place({ exchange: 'deribit', symbol: 'BTC-PERPETUAL', side: 'buy', quantity: 5, idempotencyKey: 'key-9' })
    expect(adapter.placed[0].clientOrderId).toBe('key-9')
  })

  it('records the entry in order_settlements as a known, filled order', async () => {
    const adapter = fakeAdapter()
    const db = fakeDb()
    const svc = createManualTradeService(db, fakeManager(adapter))
    await svc.place({ exchange: 'deribit', symbol: 'BTC-PERPETUAL', side: 'buy', quantity: 5 })
    const entry = db.settlements.find((s: any) => s.kind === 'entry')
    expect(entry).toBeTruthy()
    expect(entry.order_id).toBe('ord_1')
    expect(entry.status).toBe('filled')
  })
})

describe('manual-trade service — position marker', () => {
  it('records a manual position marker on a successful open', async () => {
    const adapter = fakeAdapter()
    const db = fakeDb()
    const svc = createManualTradeService(db, fakeManager(adapter))
    await svc.place({ exchange: 'deribit', symbol: 'BTC-PERPETUAL', side: 'buy', quantity: 10 })
    expect(db.manual.get('deribit|acc_1|BTC-PERPETUAL')?.net).toBe(10)
  })

  it('does NOT mark a position when the entry is rejected', async () => {
    const adapter = fakeAdapter([], ['kaibot-manual'])
    const db = fakeDb()
    const svc = createManualTradeService(db, fakeManager(adapter))
    await svc.place({ exchange: 'deribit', symbol: 'BTC-PERPETUAL', side: 'buy', quantity: 10 })
    expect(db.manual.size).toBe(0)
  })

  it('reduces the marker toward flat on a full close', async () => {
    const adapter = fakeAdapter([{ symbol: 'BTC-PERPETUAL', side: 'long', size: 40 }])
    const db = fakeDb()
    db.addManualPosition('deribit', 'acc_1', 'BTC-PERPETUAL', 'buy', 40)
    const svc = createManualTradeService(db, fakeManager(adapter))
    await svc.close({ exchange: 'deribit', symbol: 'BTC-PERPETUAL' })
    expect(db.manual.has('deribit|acc_1|BTC-PERPETUAL')).toBe(false)
  })
})

describe('manual-trade service — bracket OCO persistence', () => {
  it('registers the protective bracket with the OCO tracker', async () => {
    const adapter = fakeAdapter()
    const calls: any[] = []
    const svc = createManualTradeService(fakeDb(), fakeManager(adapter), {
      registerBracket: (exchange, signalId, sl, tps) => calls.push({ exchange, signalId, sl, tps }),
    })
    await svc.place({
      exchange: 'deribit',
      symbol: 'BTC-PERPETUAL',
      side: 'buy',
      quantity: 10,
      stopLoss: 90,
      takeProfit: 120,
      idempotencyKey: 'k1',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ exchange: 'deribit', signalId: 'manual:k1', sl: 'ord_2', tps: ['ord_3'] })
  })

  it('does NOT register a bracket when both protective legs are rejected', async () => {
    const adapter = fakeAdapter([], ['kaibot-manual-sl', 'kaibot-manual-tp'])
    const calls: any[] = []
    const svc = createManualTradeService(fakeDb(), fakeManager(adapter), {
      registerBracket: (...a) => calls.push(a),
    })
    await svc.place({
      exchange: 'deribit',
      symbol: 'BTC-PERPETUAL',
      side: 'buy',
      quantity: 10,
      stopLoss: 90,
      takeProfit: 120,
    })
    expect(calls).toHaveLength(0)
  })

  it('retires the resting manual bracket before closing the position', async () => {
    const adapter = fakeAdapter([{ symbol: 'BTC-PERPETUAL', side: 'long', size: 10 }])
    const db = fakeDb()
    const retired: string[] = []
    const svc = createManualTradeService(db, fakeManager(adapter), {
      registerBracket: () => {},
      retireBracket: (_e, sid) => {
        retired.push(sid)
      },
    })
    // Seed a manual entry settlement so the close path can find its bracket.
    await svc.place({
      exchange: 'deribit',
      symbol: 'BTC-PERPETUAL',
      side: 'buy',
      quantity: 10,
      stopLoss: 90,
      idempotencyKey: 'k2',
    })
    await svc.close({ exchange: 'deribit', symbol: 'BTC-PERPETUAL' })
    expect(retired).toContain('manual:k2')
  })
})

// ── F0: order-plan parity — entry ladder + TP ladder ──

describe('manual-trade service — entry ladder', () => {
  const ladderInput = {
    exchange: 'deribit',
    symbol: 'BTC-PERPETUAL',
    side: 'buy' as const,
    quantity: 100,
    entries: [
      { price: 100, size: 50 },
      { price: 95, size: 30 },
      { price: 90, size: 20 },
    ],
    idempotencyKey: 'lad-1',
  }

  it('places the first rung as the main limit order and the rest as resting limit adds', async () => {
    const adapter = fakeAdapter([], [], ['kaibot-manual-dca1', 'kaibot-manual-dca2'])
    const db = fakeDb()
    const svc = createManualTradeService(db, fakeManager(adapter))
    const r = await svc.place(ladderInput)

    expect(adapter.placed).toHaveLength(3)
    expect(adapter.placed[0]).toMatchObject({ side: 'buy', orderType: 'limit', price: 100, quantity: 50 })
    expect(adapter.placed[1]).toMatchObject({
      side: 'buy',
      orderType: 'limit',
      price: 95,
      quantity: 30,
      reduceOnly: false,
      label: 'kaibot-manual-dca1',
    })
    expect(adapter.placed[2]).toMatchObject({ price: 90, quantity: 20, label: 'kaibot-manual-dca2' })
    expect(r.entryRungOrderIds).toEqual(['ord_2', 'ord_3'])
  })

  it('tracks resting rungs in dca_resting_rungs under the manual record id (cancel-on-close, no TTL)', async () => {
    const adapter = fakeAdapter([], [], ['kaibot-manual-dca1', 'kaibot-manual-dca2'])
    const db = fakeDb()
    const svc = createManualTradeService(db, fakeManager(adapter))
    await svc.place(ladderInput)

    expect(db.dcaRungs).toHaveLength(2)
    expect(db.dcaRungs[0]).toMatchObject({
      signalId: 'manual:lad-1',
      exchange: 'deribit',
      symbol: 'BTC-PERPETUAL',
      side: 'buy',
      qty: 30,
      price: 95,
      expiresAt: null,
    })
  })

  it('does NOT track a rung that filled immediately', async () => {
    const adapter = fakeAdapter() // everything fills up front
    const db = fakeDb()
    const svc = createManualTradeService(db, fakeManager(adapter))
    await svc.place(ladderInput)
    expect(db.dcaRungs).toHaveLength(0)
  })

  it('sizes the protective bracket to the FULL intended size (all rungs)', async () => {
    const adapter = fakeAdapter([], [], ['kaibot-manual-dca1', 'kaibot-manual-dca2'])
    const svc = createManualTradeService(fakeDb(), fakeManager(adapter))
    await svc.place({ ...ladderInput, stopLoss: 80 })
    const sl = adapter.placed.find((o) => o.label === 'kaibot-manual-sl')
    expect(sl).toMatchObject({ side: 'sell', orderType: 'stop', stopPrice: 80, reduceOnly: true, quantity: 100 })
  })

  it('surfaces a rejected rung as a warning without failing the order', async () => {
    const adapter = fakeAdapter([], ['kaibot-manual-dca2'], ['kaibot-manual-dca1'])
    const db = fakeDb()
    const svc = createManualTradeService(db, fakeManager(adapter))
    const r = await svc.place(ladderInput)
    expect(r.status).toBe('filled')
    expect(r.warnings?.some((w) => /Entry rung 3 was rejected/.test(w))).toBe(true)
    expect(db.dcaRungs).toHaveLength(1) // only the resting rung is tracked
  })

  it('places no rungs when the main entry is rejected', async () => {
    const adapter = fakeAdapter([], ['kaibot-manual'])
    const db = fakeDb()
    const svc = createManualTradeService(db, fakeManager(adapter))
    const r = await svc.place(ladderInput)
    expect(r.status).toBe('rejected')
    expect(adapter.placed).toHaveLength(1)
    expect(db.dcaRungs).toHaveLength(0)
  })

  it('a market first rung is allowed; later rungs must carry a limit price', async () => {
    const adapter = fakeAdapter([], [], ['kaibot-manual-dca1'])
    const svc = createManualTradeService(fakeDb(), fakeManager(adapter))
    const r = await svc.place({
      ...ladderInput,
      entries: [
        { size: 50 }, // market main entry
        { price: 95, size: 50 },
      ],
    })
    expect(adapter.placed[0]).toMatchObject({ orderType: 'market', quantity: 50 })
    expect(adapter.placed[1]).toMatchObject({ orderType: 'limit', price: 95, quantity: 50 })
    expect(r.status).toBe('filled')

    await expect(
      svc.place({ ...ladderInput, entries: [{ price: 100, size: 50 }, { size: 50 }] }),
    ).rejects.toThrow(/rung 2 needs a positive limit price/)
  })

  it('rejects a rung with a non-positive size', async () => {
    const svc = createManualTradeService(fakeDb(), fakeManager(fakeAdapter()))
    await expect(
      svc.place({ ...ladderInput, entries: [{ price: 100, size: 0 }, { price: 95, size: 50 }] }),
    ).rejects.toThrow(/rung 1 needs a positive size/)
  })

  it('rejects entries combined with a top-level orderType or price', async () => {
    const svc = createManualTradeService(fakeDb(), fakeManager(fakeAdapter()))
    await expect(svc.place({ ...ladderInput, price: 100 })).rejects.toThrow(/omit orderType and price/)
    await expect(svc.place({ ...ladderInput, orderType: 'limit' })).rejects.toThrow(/omit orderType and price/)
  })

  it('single entry without entries[] behaves exactly as before (back-compat)', async () => {
    const adapter = fakeAdapter()
    const svc = createManualTradeService(fakeDb(), fakeManager(adapter))
    const r = await svc.place({ exchange: 'deribit', symbol: 'BTC-PERPETUAL', side: 'buy', quantity: 25 })
    expect(adapter.placed).toHaveLength(1)
    expect(adapter.placed[0]).toMatchObject({ orderType: 'market', quantity: 25 })
    expect(r.entryRungOrderIds).toBeUndefined()
  })
})

describe('manual-trade service — TP ladder', () => {
  const base = {
    exchange: 'deribit',
    symbol: 'BTC-PERPETUAL',
    side: 'buy' as const,
    quantity: 10,
    idempotencyKey: 'tp-1',
  }

  it('places one reduce-only limit per leg, sized as fraction of the TOTAL', async () => {
    const adapter = fakeAdapter()
    const svc = createManualTradeService(fakeDb(), fakeManager(adapter))
    const r = await svc.place({
      ...base,
      takeProfits: [
        { price: 110, fraction: 0.5 },
        { price: 120, fraction: 0.3 },
        { price: 130, fraction: 0.2 },
      ],
    })
    const tps = adapter.placed.filter((o) => /kaibot-manual-tp/.test(o.label))
    expect(tps).toHaveLength(3)
    expect(tps[0]).toMatchObject({ side: 'sell', orderType: 'limit', price: 110, quantity: 5, reduceOnly: true })
    expect(tps[1]).toMatchObject({ price: 120, quantity: 3 })
    expect(tps[2]).toMatchObject({ price: 130, quantity: 2 })
    expect(r.takeProfitOrderIds).toHaveLength(3)
    expect(r.takeProfitOrderId).toBe(r.takeProfitOrderIds![0])
  })

  it('registers ALL live TP legs plus the stop with the OCO tracker', async () => {
    const adapter = fakeAdapter()
    const calls: any[] = []
    const svc = createManualTradeService(fakeDb(), fakeManager(adapter), {
      registerBracket: (exchange, signalId, sl, tps) => calls.push({ exchange, signalId, sl, tps }),
    })
    await svc.place({
      ...base,
      stopLoss: 90,
      takeProfits: [
        { price: 110, fraction: 0.5 },
        { price: 120, fraction: 0.5 },
      ],
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ signalId: 'manual:tp-1', sl: 'ord_2', tps: ['ord_3', 'ord_4'] })
  })

  it('a rejected TP leg is excluded from the OCO group and surfaced as a warning', async () => {
    const adapter = fakeAdapter([], ['kaibot-manual-tp2'])
    const calls: any[] = []
    const svc = createManualTradeService(fakeDb(), fakeManager(adapter), {
      registerBracket: (_e, _s, sl, tps) => calls.push({ sl, tps }),
    })
    const r = await svc.place({
      ...base,
      takeProfits: [
        { price: 110, fraction: 0.5 },
        { price: 120, fraction: 0.5 },
      ],
    })
    expect(r.warnings?.some((w) => /Take-profit leg 2 was rejected/.test(w))).toBe(true)
    expect(calls[0].tps).toEqual(['ord_2'])
  })

  it('rejects fractions summing over 100% and out-of-range fractions', async () => {
    const svc = createManualTradeService(fakeDb(), fakeManager(fakeAdapter()))
    await expect(
      svc.place({ ...base, takeProfits: [{ price: 110, fraction: 0.6 }, { price: 120, fraction: 0.6 }] }),
    ).rejects.toThrow(/more than 100%/)
    await expect(svc.place({ ...base, takeProfits: [{ price: 110, fraction: 0 }] })).rejects.toThrow(/fraction/)
    await expect(svc.place({ ...base, takeProfits: [{ price: 110, fraction: 1.2 }] })).rejects.toThrow(/fraction/)
    await expect(svc.place({ ...base, takeProfits: [{ price: 0, fraction: 0.5 }] })).rejects.toThrow(/price/)
  })

  it('rejects takeProfits combined with the single takeProfit', async () => {
    const svc = createManualTradeService(fakeDb(), fakeManager(fakeAdapter()))
    await expect(
      svc.place({ ...base, takeProfit: 115, takeProfits: [{ price: 110, fraction: 0.5 }] }),
    ).rejects.toThrow(/omit it/)
  })

  it('single takeProfit still works as one full-size leg (back-compat)', async () => {
    const adapter = fakeAdapter()
    const svc = createManualTradeService(fakeDb(), fakeManager(adapter))
    const r = await svc.place({ ...base, takeProfit: 120 })
    const tps = adapter.placed.filter((o) => /kaibot-manual-tp/.test(o.label))
    expect(tps).toHaveLength(1)
    expect(tps[0]).toMatchObject({ price: 120, quantity: 10 })
    expect(r.takeProfitOrderId).toBe(tps.length > 0 ? 'ord_2' : undefined)
  })
})

// FIX 3: the bot-fill auto-link keys the position-group link on the RESOLVED
// contract (MES→MESZ25). A manual entry arriving with the raw root must resolve
// the symbol too, or the stale-link clear keys on 'MES' and never matches.
describe('manual-trade service — auto-link clear resolves the futures contract', () => {
  it('clears a stale AUTO link stored under the resolved contract when a manual entry arrives with the root', async () => {
    const links = new Map<string, { assigned_by: string }>()
    links.set('pos:tradestation:acct:MESZ25', { assigned_by: 'auto' })
    const db = {
      ...fakeDb(),
      getPositionGroupLink: (key: string) => links.get(key),
      deletePositionGroupLink: (key: string) => links.delete(key),
      listOpenExecutionsForExchange: () => [], // no live bot execution → clear proceeds
    }
    const adapter = {
      name: 'tradestation',
      async getAccounts() {
        return [{ id: 'acct', exchangeName: 'tradestation', accountId: 'acct', name: 'Main', currency: 'USD' }]
      },
      async getPositions() {
        return []
      },
      async placeOrder(o: any) {
        return { orderId: 'ord_1', status: 'filled', filledQuantity: o.quantity, averagePrice: 5000 }
      },
      async cancelOrder() {},
      async resolveSymbol(sym: string) {
        return sym === 'MES' ? 'MESZ25' : sym
      },
    }
    const svc = createManualTradeService(db as any, fakeManager(adapter))
    await svc.place({ exchange: 'tradestation', symbol: 'MES', side: 'buy', quantity: 1 })
    expect(links.has('pos:tradestation:acct:MESZ25')).toBe(false)
  })
})

describe('manual-trade service — close cancels resting entry rungs', () => {
  it('cancels the tracked entry rungs (via cancelEntryRungs) before flattening', async () => {
    const adapter = fakeAdapter(
      [{ symbol: 'BTC-PERPETUAL', side: 'long', size: 50 }],
      [],
      ['kaibot-manual-dca1'],
    )
    const db = fakeDb()
    const rungCancels: any[] = []
    const svc = createManualTradeService(db, fakeManager(adapter), {
      registerBracket: () => {},
      retireBracket: () => {},
      cancelEntryRungs: (exchange, signalIds) => rungCancels.push({ exchange, signalIds }),
    })
    await svc.place({
      exchange: 'deribit',
      symbol: 'BTC-PERPETUAL',
      side: 'buy',
      quantity: 100,
      entries: [
        { price: 100, size: 50 },
        { price: 95, size: 50 },
      ],
      idempotencyKey: 'cl-1',
    })
    await svc.close({ exchange: 'deribit', symbol: 'BTC-PERPETUAL' })
    expect(rungCancels).toHaveLength(1)
    expect(rungCancels[0]).toMatchObject({ exchange: 'deribit', signalIds: ['manual:cl-1'] })
  })
})

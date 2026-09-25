import { describe, expect, it } from 'bun:test'
import { createManualTradeService } from './manual-trade.js'

// Fake adapter with no getOrderStatus, so settleAdapterOrder returns immediately
// (it treats the placeOrder result as authoritative). Records every placed order.
function fakeAdapter(
  positions: Array<{ symbol: string; side: 'long' | 'short'; size: number; accountId?: string; markPrice?: number }> = [],
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
  // Bot executions holding a venue position + the exit fills booked onto them
  // (a manual close on a bot position is that bot's exit).
  const executions: any[] = []
  const fills: any[] = []
  const retired: string[] = []
  const key = (e: string, a: string, s: string) => `${e}|${a}|${s}`
  let seq = 0
  // Guard-path state (halt gate, account-size cap, opt-in guardrails / margin
  // guard) — all default to "off", matching a fresh executor, so every
  // existing test keeps passing without opting into any rail.
  let halted = false
  let accountSizeCap: number | null = null
  let marginGuardRow: any = null
  const haltCalls: Array<{ halted: boolean; reason?: string | null }> = []
  return {
    settlements,
    manual,
    dcaRungs,
    executions,
    fills,
    retired,
    haltCalls,
    setHalted(v: boolean) {
      halted = v
    },
    setAccountSizeCap(v: number | null) {
      accountSizeCap = v
    },
    setMarginGuardRow(row: any) {
      marginGuardRow = row
    },
    getHaltState() {
      return { halted, reason: halted ? 'test' : null, tripped_at: null }
    },
    setHaltState(v: boolean, reason?: string | null) {
      halted = v
      haltCalls.push({ halted: v, reason })
    },
    getAccountSize() {
      return accountSizeCap
    },
    getMarginGuard() {
      return marginGuardRow
    },
    log() {},
    listOpenExecutionsForExchange(exchange: string) {
      return executions.filter((e) => e.exchange === exchange && e.status !== 'closed')
    },
    insertSignalFill(f: any) {
      fills.push(f)
    },
    updateSignalExecution(signalId: string, patch: any) {
      const e = executions.find((x) => x.signal_id === signalId)
      if (!e) return
      if (patch.status) e.status = patch.status
      if (patch.qtyClosed != null) e.qty_closed = patch.qtyClosed
    },
    markEntrySignalClosed(signalId: string, reason?: string) {
      retired.push(`${signalId}:${reason ?? ''}`)
    },
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

  // Regression (live ledger 2026-08-28): a manual close on a BOT position
  // flattened it at the venue but wrote no exit fill, so the trade had no price
  // and fell out of analytics entirely.
  it('books the exit fill onto the bot execution holding the position', async () => {
    const adapter = fakeAdapter([{ symbol: 'BTC-PERPETUAL', side: 'long', size: 1 }])
    const db = fakeDb()
    db.executions.push({
      signal_id: 'entry-1',
      exchange: 'deribit',
      symbol: 'BTC-PERPETUAL',
      account_id: 'acc_1',
      status: 'open',
      qty_opened: 1,
      qty_closed: 0,
      created_at: 1,
    })
    const svc = createManualTradeService(db, fakeManager(adapter))
    await svc.close({ exchange: 'deribit', symbol: 'BTC-PERPETUAL' })
    expect(db.fills).toEqual([
      {
        commission: 0,
        feeCurrency: null,
        feeNative: null,
        signalId: 'entry-1',
        kind: 'exit',
        symbol: 'BTC-PERPETUAL',
        side: 'sell',
        qty: 1,
        price: 100,
        orderId: 'ord_1',
      },
    ])
    expect(db.executions[0]).toMatchObject({ status: 'closed', qty_closed: 1 })
    expect(db.retired).toEqual(['entry-1:closed by manual close'])
  })

  // Ride hand-over: a manual close on a server-managed lineage must tell the
  // server the ride ended (the venue-exit sweep only sees stop fills).
  it('calls the post-close hook with the fully closed allocations', async () => {
    const adapter = fakeAdapter([{ symbol: 'BTC-PERPETUAL', side: 'long', size: 1 }])
    const db = fakeDb()
    db.executions.push({
      signal_id: 'handover:srv-1',
      exchange: 'deribit',
      symbol: 'BTC-PERPETUAL',
      account_id: 'acc_1',
      status: 'open',
      qty_opened: 1,
      qty_closed: 0,
      created_at: 1,
    })
    const hooked: any[] = []
    const svc = createManualTradeService(db, fakeManager(adapter), {
      onExitAttributed: async (exchange, allocations, fill) => {
        hooked.push({ exchange, allocations, fill })
      },
    })
    await svc.close({ exchange: 'deribit', symbol: 'BTC-PERPETUAL' })
    expect(hooked).toHaveLength(1)
    expect(hooked[0].exchange).toBe('deribit')
    expect(hooked[0].allocations).toEqual([{ signalId: 'handover:srv-1', qty: 1, fullyClosed: true }])
    expect(hooked[0].fill).toMatchObject({ price: 100, orderId: 'ord_1' })
  })

  it('books nothing when the closed position is not held by a bot execution', async () => {
    const adapter = fakeAdapter([{ symbol: 'BTC-PERPETUAL', side: 'long', size: 1 }])
    const db = fakeDb()
    const svc = createManualTradeService(db, fakeManager(adapter))
    await svc.close({ exchange: 'deribit', symbol: 'BTC-PERPETUAL' })
    expect(db.fills).toEqual([])
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

// TS live blockers 2026-08: the account fallback returned accounts[0].id — the
// PREFIXED adapter id ('tradestation:21084931'), malformed as a broker
// AccountID — and silently picked account #1 even with 3 accounts connected.
describe('manual-trade service — broker account resolution', () => {
  const tsAccounts = [
    { id: 'tradestation:21084931', exchangeName: 'tradestation', accountId: '21084931', name: 'A', currency: 'USD' },
    { id: 'tradestation:21084933', exchangeName: 'tradestation', accountId: '21084933', name: 'B', currency: 'USD' },
  ]

  function tsAdapter(accounts = tsAccounts) {
    const base = fakeAdapter()
    return {
      ...base,
      name: 'tradestation',
      async getAccounts() {
        return accounts
      },
    }
  }

  function tsManager(adapter: any) {
    return {
      async getSession() {
        return { userId: 'default', exchangeName: 'tradestation', adapter, status: 'connected' }
      },
    } as any
  }

  it('refuses to pick silently among multiple tradestation accounts', async () => {
    const svc = createManualTradeService(fakeDb(), tsManager(tsAdapter()))
    await expect(
      svc.place({ exchange: 'tradestation', symbol: 'MESU26', side: 'buy', quantity: 1 }),
    ).rejects.toThrow(/pass accountId.*21084931.*21084933/)
  })

  it('uses the bare AccountID (never the prefixed adapter id) for a single account', async () => {
    const adapter = tsAdapter([tsAccounts[0]])
    const svc = createManualTradeService(fakeDb(), tsManager(adapter))
    await svc.place({ exchange: 'tradestation', symbol: 'MESU26', side: 'buy', quantity: 1 })
    expect(adapter.placed[0].accountId).toBe('21084931')
  })

  it('a provided accountId is used verbatim', async () => {
    const adapter = tsAdapter()
    const svc = createManualTradeService(fakeDb(), tsManager(adapter))
    await svc.place({
      exchange: 'tradestation',
      symbol: 'MESU26',
      side: 'buy',
      quantity: 1,
      accountId: '21084933',
    })
    expect(adapter.placed[0].accountId).toBe('21084933')
  })
})

// Manual-readiness review 2026-08-28, gap #1: a manual close matched the live
// position on SYMBOL ONLY, ignoring accountId — same class as the Volcap
// incident (26/08) the signal path already fixed (0ec3e524). On a multi-
// account venue (TradeStation) a close for account A could read account B's
// position size/side and fire a reduce-only order at A, which — with no
// reduce-only flag at the venue — can OPEN a reverse position on a flat
// account instead of closing anything.
describe('manual-trade service — close is account-scoped', () => {
  it('refuses to close when the position on that symbol belongs to a DIFFERENT account', async () => {
    const adapter = fakeAdapter([{ symbol: 'MESU26', side: 'short', size: 5, accountId: '21084931' }])
    const svc = createManualTradeService(fakeDb(), fakeManager(adapter))
    await expect(
      svc.close({ exchange: 'tradestation', symbol: 'MESU26', accountId: '21084933' }),
    ).rejects.toThrow(/no open position.*21084933/)
    expect(adapter.placed).toHaveLength(0) // never fires a wrong-account order
  })

  it('closes the right account when several accounts hold the same symbol', async () => {
    const adapter = fakeAdapter([
      { symbol: 'MESU26', side: 'short', size: 5, accountId: '21084931' },
      { symbol: 'MESU26', side: 'long', size: 2, accountId: '21084933' },
    ])
    const svc = createManualTradeService(fakeDb(), fakeManager(adapter))
    const r = await svc.close({ exchange: 'tradestation', symbol: 'MESU26', accountId: '21084933' })
    expect(adapter.placed[0]).toMatchObject({ accountId: '21084933', side: 'sell', quantity: 2 })
    expect(r.closedQuantity).toBe(2)
  })

  it('scopes the resting-bracket lookup to the closing account', async () => {
    const adapter = fakeAdapter([{ symbol: 'BTC-PERPETUAL', side: 'long', size: 10, accountId: 'acc_2' }])
    const db = fakeDb()
    const seen: any[] = []
    db.listManualEntrySignalIds = (e: string, s: string, accountId?: string) => {
      seen.push({ e, s, accountId })
      return []
    }
    const svc = createManualTradeService(db, fakeManager(adapter))
    await svc.close({ exchange: 'deribit', symbol: 'BTC-PERPETUAL', accountId: 'acc_2' })
    expect(seen).toEqual([{ e: 'deribit', s: 'BTC-PERPETUAL', accountId: 'acc_2' }])
  })

  it('never cancels or deactivates a same-symbol trail that protects a DIFFERENT account', async () => {
    const deactivated: string[] = []
    const cancelled: string[] = []
    // The real DB query filters by account server-side; the mock mimics that
    // filter so this test actually exercises the account-scoping, not just
    // the call arguments.
    const otherAccountTrail = { signal_id: 'pos:deribit:acc_1:BTC-PERPETUAL', sl_order_id: 'sl-other', account_id: 'acc_1' }
    const db = {
      ...fakeDb(),
      findActiveTrailsForSymbol: (_e: string, _s: string, accountId?: string) =>
        accountId != null && otherAccountTrail.account_id !== accountId ? [] : [otherAccountTrail],
      deactivateLocalTrail: (key: string) => deactivated.push(key),
    }
    const adapter = {
      ...fakeAdapter([{ symbol: 'BTC-PERPETUAL', side: 'long', size: 10, accountId: 'acc_2' }]),
      async cancelOrder(id: string) {
        cancelled.push(id)
      },
    }
    const svc = createManualTradeService(db as any, fakeManager(adapter))
    await svc.close({ exchange: 'deribit', symbol: 'BTC-PERPETUAL', accountId: 'acc_2' })
    expect(cancelled).toHaveLength(0)
    expect(deactivated).toHaveLength(0)
  })

  // Explicit proof that a TradeStation close never touches account B: only ONE
  // order is ever placed, and it carries account A's own size/side, not a
  // mismatched size read off account B's position.
  it('a close on account A places exactly one order, sized off account A, and sends nothing for account B', async () => {
    const adapter = fakeAdapter([
      { symbol: 'MESU26', side: 'short', size: 5, accountId: '21084931' }, // account B
      { symbol: 'MESU26', side: 'long', size: 7, accountId: '21084933' }, // account A (the target)
    ])
    const svc = createManualTradeService(fakeDb(), fakeManager(adapter))
    const r = await svc.close({ exchange: 'tradestation', symbol: 'MESU26', accountId: '21084933' })
    expect(adapter.placed).toHaveLength(1) // nothing at all fired for account B
    expect(adapter.placed[0]).toMatchObject({ accountId: '21084933', side: 'sell', quantity: 7 })
    expect(r.closedQuantity).toBe(7)
  })
})

// Follow-up fix: the accountId === accountId equality above was too strict for
// a non-account-routed venue. Deribit isn't in ACCOUNT_ROUTED_VENUES and
// exposes 3 synthetic per-currency wallets (btc/eth/usdc) as "accounts";
// without an explicit accountId, resolveAccountId arbitrarily picks the FIRST
// one (accounts[0] — always 'btc'), which has nothing to do with which wallet
// actually holds the position being closed (the adapter tags each position by
// the instrument's settlement currency). Requiring p.accountId === accountId
// there broke every manual close on a wallet other than the first one — live
// on the crypto-couple Deribit connections.
describe('manual-trade service — close on a non-account-routed venue ignores the arbitrary resolved accountId', () => {
  function deribitStyleAdapter(positionAccountId: string) {
    return {
      ...fakeAdapter([{ symbol: 'ETH-PERPETUAL', side: 'long', size: 3, accountId: positionAccountId }]),
      async getAccounts() {
        return [
          { id: 'deribit:btc', exchangeName: 'deribit', accountId: 'btc', name: 'BTC wallet', currency: 'BTC' },
          { id: 'deribit:eth', exchangeName: 'deribit', accountId: 'eth', name: 'ETH wallet', currency: 'ETH' },
          { id: 'deribit:usdc', exchangeName: 'deribit', accountId: 'usdc', name: 'USDC wallet', currency: 'USDC' },
        ]
      },
    }
  }

  it('closes a position on a non-first wallet even without an explicit accountId', async () => {
    const adapter = deribitStyleAdapter('eth')
    const svc = createManualTradeService(fakeDb(), fakeManager(adapter))
    // No accountId passed — resolveAccountId picks accounts[0] ('btc'), which
    // must NOT gate finding the ETH-PERPETUAL position (tagged 'eth').
    const r = await svc.close({ exchange: 'deribit', symbol: 'ETH-PERPETUAL' })
    expect(adapter.placed[0]).toMatchObject({ side: 'sell', quantity: 3, reduceOnly: true })
    expect(r.closedQuantity).toBe(3)
  })

  it('still enforces account scoping on Deribit when the caller explicitly passes an accountId', async () => {
    const adapter = deribitStyleAdapter('eth')
    const svc = createManualTradeService(fakeDb(), fakeManager(adapter))
    await expect(
      svc.close({ exchange: 'deribit', symbol: 'ETH-PERPETUAL', accountId: 'usdc' }),
    ).rejects.toThrow(/no open position/)
    expect(adapter.placed).toHaveLength(0)
  })
})

// Manual-readiness review 2026-08-28, gap #2: `services/manual-trade.ts` and
// `routes/manual-trade.ts` had ZERO references to the halt gate, the account
// kill-switch/cap, the market-open guard, the opt-in daily-loss/concurrency/
// notional rails, or the margin breathing-room guard — a manual order went
// straight through every one of them. These tests reproduce that a manual
// ENTRY now runs the same checks, and that a CLOSE never does (closes only
// reduce risk, exactly like the signal path).
describe('manual-trade service — entry guard path', () => {
  it('refuses a manual entry while the executor is halted (panic / daily-loss)', async () => {
    const adapter = fakeAdapter()
    const db = fakeDb()
    db.setHalted(true)
    const svc = createManualTradeService(db, fakeManager(adapter))
    await expect(
      svc.place({ exchange: 'deribit', symbol: 'BTC-PERPETUAL', side: 'buy', quantity: 10 }),
    ).rejects.toThrow(/halted/)
    expect(adapter.placed).toHaveLength(0)
  })

  it('a halt does NOT block a manual close (closing only reduces risk)', async () => {
    const adapter = fakeAdapter([{ symbol: 'BTC-PERPETUAL', side: 'long', size: 10 }])
    const db = fakeDb()
    db.setHalted(true)
    const svc = createManualTradeService(db, fakeManager(adapter))
    const r = await svc.close({ exchange: 'deribit', symbol: 'BTC-PERPETUAL' })
    expect(r.closedQuantity).toBe(10)
  })

  it('refuses a manual entry when the account contract cap is 0 (kill-switch)', async () => {
    const adapter = fakeAdapter()
    const db = fakeDb()
    db.setAccountSizeCap(0)
    const svc = createManualTradeService(db, fakeManager(adapter))
    await expect(
      svc.place({ exchange: 'deribit', symbol: 'BTC-PERPETUAL', side: 'buy', quantity: 10 }),
    ).rejects.toThrow(/kill-switch/)
    expect(adapter.placed).toHaveLength(0)
  })

  it('clips the quantity to the account contract cap and warns, instead of silently placing the full size', async () => {
    const adapter = fakeAdapter()
    const db = fakeDb()
    db.setAccountSizeCap(5)
    const svc = createManualTradeService(db, fakeManager(adapter))
    const r = await svc.place({ exchange: 'deribit', symbol: 'BTC-PERPETUAL', side: 'buy', quantity: 10 })
    expect(adapter.placed[0].quantity).toBe(5)
    expect(r.warnings?.some((w) => /clipped/i.test(w))).toBe(true)
  })

  it('refuses a market order into a closed/stale market', async () => {
    const adapter = {
      ...fakeAdapter(),
      async getMarketStatus() {
        return new Map([['MESU26', { tradeTimeMs: Date.now() - 10 * 60 * 1000 }]]) // 10 min stale
      },
    }
    const svc = createManualTradeService(fakeDb(), fakeManager(adapter))
    await expect(
      svc.place({ exchange: 'tradestation', symbol: 'MESU26', side: 'buy', quantity: 1 }),
    ).rejects.toThrow(/market closed/)
    expect(adapter.placed).toHaveLength(0)
  })

  it('refuses an entry that would breach the daily-loss rail, and halts the executor', async () => {
    const adapter = fakeAdapter()
    const db = {
      ...fakeDb(),
      all: () => [{ signal_id: 'x1', symbol: 'ETHUSDT', direction: 'long', status: 'closed' }],
      getFillsForSignals: () => [
        { signal_id: 'x1', kind: 'entry', price: 1000, qty: 1, commission: 0, created_at: 1 },
        { signal_id: 'x1', kind: 'exit', price: 900, qty: 1, commission: 0, created_at: Date.now() },
      ],
    }
    db.setMarginGuardRow({ max_daily_loss: 50, max_concurrent_positions: 0, max_total_notional: 0 })
    const svc = createManualTradeService(db as any, fakeManager(adapter))
    await expect(
      svc.place({ exchange: 'binance', symbol: 'ETHUSDT', side: 'buy', quantity: 1 }),
    ).rejects.toThrow(/daily-loss/)
    expect(adapter.placed).toHaveLength(0)
    // fakeManager has no getAllSessions, so the flatten-all attempt fails and
    // falls back to a bare halt — same fallback the signal path uses.
    expect(db.haltCalls.length).toBeGreaterThan(0)
  })

  it('refuses a NEW-symbol entry once the concurrency cap is reached', async () => {
    const adapter = fakeAdapter([
      { symbol: 'AAAUSDT', side: 'long', size: 1 },
      { symbol: 'BBBUSDT', side: 'long', size: 1 },
    ])
    const db = fakeDb()
    db.setMarginGuardRow({ max_daily_loss: 0, max_concurrent_positions: 2, max_total_notional: 0 })
    const svc = createManualTradeService(db, fakeManager(adapter))
    await expect(
      svc.place({ exchange: 'binance', symbol: 'CCCUSDT', side: 'buy', quantity: 1 }),
    ).rejects.toThrow(/concurrent positions/)
    expect(adapter.placed).toHaveLength(0)
  })

  it('allows adding to an EXISTING symbol even at the concurrency cap', async () => {
    const adapter = fakeAdapter([
      { symbol: 'AAAUSDT', side: 'long', size: 1 },
      { symbol: 'BBBUSDT', side: 'long', size: 1 },
    ])
    const db = fakeDb()
    db.setMarginGuardRow({ max_daily_loss: 0, max_concurrent_positions: 2, max_total_notional: 0 })
    const svc = createManualTradeService(db, fakeManager(adapter))
    const r = await svc.place({ exchange: 'binance', symbol: 'AAAUSDT', side: 'buy', quantity: 1 })
    expect(r.status).toBe('filled')
  })

  it('refuses an entry that would push total notional over the cap', async () => {
    const adapter = fakeAdapter([{ symbol: 'AAAUSDT', side: 'long', size: 10, markPrice: 100 }])
    const db = fakeDb()
    db.setMarginGuardRow({ max_daily_loss: 0, max_concurrent_positions: 0, max_total_notional: 1200 })
    const svc = createManualTradeService(db, fakeManager(adapter))
    await expect(
      svc.place({ exchange: 'binance', symbol: 'BBBUSDT', side: 'buy', quantity: 5, orderType: 'limit', price: 100 }),
    ).rejects.toThrow(/total notional/)
    expect(adapter.placed).toHaveLength(0)
  })

  it('refuses an entry that would breach the margin breathing-room floor', async () => {
    const adapter = {
      ...fakeAdapter(),
      async getBalances() {
        return [
          {
            accountId: 'acc_1',
            balance: 1000,
            equity: 1000,
            realizedPnL: 0,
            unrealizedPnL: 0,
            initialMargin: 900,
            maintenanceMargin: 800,
            currency: 'USD',
            timestamp: Date.now(),
          },
        ]
      },
    }
    const db = fakeDb()
    db.setMarginGuardRow({
      enabled: true,
      buffer_mult: 1,
      floor_mode: 'maintenance',
      equity_pct: 0.2,
      max_daily_loss: 0,
      max_concurrent_positions: 0,
      max_total_notional: 0,
    })
    const svc = createManualTradeService(db, fakeManager(adapter))
    await expect(
      svc.place({ exchange: 'binance', symbol: 'BTCUSDT', side: 'buy', quantity: 1, orderType: 'limit', price: 50000 }),
    ).rejects.toThrow(/breathing room/)
    expect(adapter.placed).toHaveLength(0)
  })
})

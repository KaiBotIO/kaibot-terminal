import { describe, expect, it } from 'bun:test'
import { computeRollMath, createRollService } from './roll-position.js'
import { PaperExchangeAdapter } from './exchanges/adapters/paper.js'

// Instant settlement for tests: paper answers getOrderStatus synchronously.
const fastSettle = { attempts: 3, intervalMs: 1, sleep: async () => {} }

function fakeManager(adapter: any, status: 'connected' | 'disconnected' = 'connected') {
  return {
    async getSession() {
      return { userId: 'default', exchangeName: 'paper', adapter, status }
    },
  } as any
}

// In-memory stand-in for the durability spine (same idiom as manual-trade.test).
function fakeDb() {
  const settlements: any[] = []
  const manual = new Map<string, { net: number }>()
  const key = (e: string, a: string, s: string) => `${e}|${a}|${s}`
  let seq = 0
  return {
    settlements,
    manual,
    log() {},
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
    listManualEntrySignalIds() {
      return []
    },
    findActiveTrailsForSymbol() {
      return []
    },
    deactivateLocalTrail() {},
  } as any
}

async function paperWithPosition(
  side: 'buy' | 'sell' = 'buy',
  size = 2,
  marks: Record<string, number> = { MNQZ26: 24000, MNQH27: 24120 },
) {
  const adapter = new PaperExchangeAdapter('paper', marks)
  await adapter.placeOrder({
    accountId: 'paper',
    symbol: 'MNQZ26',
    side,
    orderType: 'market',
    quantity: size,
  })
  return adapter
}

function service(adapter: any, db = fakeDb()) {
  return { svc: createRollService(db, fakeManager(adapter), {}, fastSettle), db }
}

describe('computeRollMath', () => {
  it('maps exposure old→new for a long (sell old, buy new, pays contango)', () => {
    const m = computeRollMath({ side: 'long', size: 2, multiplier: 2, fromPrice: 24000, toPrice: 24120 })
    expect(m.closeSide).toBe('sell')
    expect(m.openSide).toBe('buy')
    expect(m.spread).toBe(120)
    expect(m.estCost).toBe(480) // 120 pts × 2 contracts × $2/pt
  })

  it('flips the cost sign for a short (contango pays the short)', () => {
    const m = computeRollMath({ side: 'short', size: 2, multiplier: 2, fromPrice: 24000, toPrice: 24120 })
    expect(m.closeSide).toBe('buy')
    expect(m.openSide).toBe('sell')
    expect(m.estCost).toBe(-480)
  })

  it('degrades to null cost when a price is missing', () => {
    const m = computeRollMath({ side: 'long', size: 2, multiplier: 2, fromPrice: 24000, toPrice: null })
    expect(m.spread).toBeNull()
    expect(m.estCost).toBeNull()
  })
})

describe('roll preview', () => {
  it('derives the target contract and the spread cost', async () => {
    const adapter = await paperWithPosition()
    const { svc } = service(adapter)
    const p = await svc.preview({ exchange: 'paper', symbol: 'MNQZ26' })
    expect(p.fromSymbol).toBe('MNQZ26')
    expect(p.toSymbol).toBe('MNQH27')
    expect(p.side).toBe('long')
    expect(p.size).toBe(2)
    expect(p.multiplier).toBe(2)
    expect(p.fromPrice).toBe(24000)
    expect(p.toPrice).toBe(24120)
    expect(p.estCost).toBe(480)
    expect(p.expiry?.source).toBe('calculated')
  })

  it('rejects a preview without a position', async () => {
    const adapter = new PaperExchangeAdapter('paper')
    const { svc } = service(adapter)
    await expect(svc.preview({ exchange: 'paper', symbol: 'MNQZ26' })).rejects.toThrow(
      'no open position',
    )
  })
})

describe('roll execute — two-leg orchestration', () => {
  it('market roll moves the full exposure to the new contract', async () => {
    const adapter = await paperWithPosition('buy', 2)
    const { svc, db } = service(adapter)
    const r = await svc.execute({
      exchange: 'paper',
      symbol: 'MNQZ26',
      toSymbol: 'MNQH27',
      idempotencyKey: 'k1',
    })
    expect(r.status).toBe('rolled')
    expect(r.rolledQuantity).toBe(2)
    const positions = await adapter.getPositions()
    expect(positions).toHaveLength(1)
    expect(positions[0].symbol).toBe('MNQH27')
    expect(positions[0].side).toBe('long')
    expect(positions[0].size).toBe(2)
    // Rolled position is marked manual so the reconciler leaves it alone.
    expect(db.manual.get('paper|paper|MNQH27')?.net).toBe(2)
  })

  it('rolls a short the same way (buy to close, sell to open)', async () => {
    const adapter = await paperWithPosition('sell', 3)
    const { svc } = service(adapter)
    const r = await svc.execute({ exchange: 'paper', symbol: 'MNQZ26', toSymbol: 'MNQH27' })
    expect(r.status).toBe('rolled')
    const positions = await adapter.getPositions()
    expect(positions[0].symbol).toBe('MNQH27')
    expect(positions[0].side).toBe('short')
    expect(positions[0].size).toBe(3)
  })

  it('aborts with the position intact when the close leg is rejected', async () => {
    const adapter = await paperWithPosition()
    adapter.rejectNextOrder('margin check failed')
    const { svc } = service(adapter)
    const r = await svc.execute({ exchange: 'paper', symbol: 'MNQZ26', toSymbol: 'MNQH27' })
    expect(r.status).toBe('aborted')
    expect(r.rolledQuantity).toBe(0)
    const positions = await adapter.getPositions()
    expect(positions[0].symbol).toBe('MNQZ26')
    expect(positions[0].size).toBe(2)
    // Never a second leg after a failed first one.
    expect(adapter.getOrders().filter((o) => o.order.label === 'kaibot-roll-open')).toHaveLength(0)
  })

  it('aborts when a limit close rests unfilled (cancelled, nothing rolled)', async () => {
    const adapter = await paperWithPosition()
    const { svc } = service(adapter)
    const r = await svc.execute({
      exchange: 'paper',
      symbol: 'MNQZ26',
      toSymbol: 'MNQH27',
      legOrderType: 'limit',
      closeLimitPrice: 25000, // rests: paper never fills reduce-only limits
      openLimitPrice: 24100,
    })
    expect(r.status).toBe('aborted')
    const positions = await adapter.getPositions()
    expect(positions[0].symbol).toBe('MNQZ26')
    expect(positions[0].size).toBe(2)
    // The resting close was cancelled — never left working.
    const close = adapter.getOrders().find((o) => o.order.label === 'kaibot-roll-close')
    expect(close?.status).toBe('cancelled')
  })

  it('restores the old position when the open leg is rejected', async () => {
    const adapter = await paperWithPosition()
    const orig = adapter.placeOrder.bind(adapter)
    adapter.placeOrder = async (o: any) => {
      if (o.label === 'kaibot-roll-open') adapter.rejectNextOrder('new contract not tradable')
      return orig(o)
    }
    const { svc } = service(adapter)
    const r = await svc.execute({ exchange: 'paper', symbol: 'MNQZ26', toSymbol: 'MNQH27' })
    expect(r.status).toBe('restored')
    expect(r.restoreLeg).toBeDefined()
    const positions = await adapter.getPositions()
    expect(positions).toHaveLength(1)
    expect(positions[0].symbol).toBe('MNQZ26')
    expect(positions[0].side).toBe('long')
    expect(positions[0].size).toBe(2)
  })

  it('reports loudly when open AND restore both fail (never silent)', async () => {
    const adapter = await paperWithPosition()
    const orig = adapter.placeOrder.bind(adapter)
    adapter.placeOrder = async (o: any) => {
      // Everything after the close leg is refused by the venue.
      if (o.label === 'kaibot-roll-open') adapter.setRejectAll('venue down')
      return orig(o)
    }
    const { svc } = service(adapter)
    const r = await svc.execute({ exchange: 'paper', symbol: 'MNQZ26', toSymbol: 'MNQH27' })
    expect(r.status).toBe('incomplete')
    expect(r.warnings.join(' ')).toContain('RESTORE FAILED')
    expect(await adapter.getPositions()).toHaveLength(0)
  })

  it('opens the new leg at the venue price of the NEW contract', async () => {
    const adapter = await paperWithPosition()
    const { svc } = service(adapter)
    const r = await svc.execute({ exchange: 'paper', symbol: 'MNQZ26', toSymbol: 'MNQH27' })
    expect(r.status).toBe('rolled')
    expect(r.openLeg?.averagePrice).toBe(24120)
    expect(r.closeLeg?.averagePrice).toBe(24000)
  })

  it('ignores a duplicate submit with the same idempotency key', async () => {
    const adapter = await paperWithPosition('buy', 2, { MNQZ26: 24000, MNQH27: 24120 })
    const { svc } = service(adapter)
    const first = await svc.execute({
      exchange: 'paper',
      symbol: 'MNQZ26',
      toSymbol: 'MNQH27',
      idempotencyKey: 'dup',
    })
    expect(first.status).toBe('rolled')
    // Same key again: the rolled position (now MNQH27) must not roll twice —
    // seed a fresh MNQZ26 position so the dup-check is what stops it.
    await adapter.placeOrder({
      accountId: 'paper',
      symbol: 'MNQZ26',
      side: 'buy',
      orderType: 'market',
      quantity: 1,
    })
    const second = await svc.execute({
      exchange: 'paper',
      symbol: 'MNQZ26',
      toSymbol: 'MNQH27',
      idempotencyKey: 'dup',
    })
    expect(second.status).toBe('aborted')
    expect(second.warnings.join(' ')).toContain('Duplicate roll ignored')
  })

  it('refuses rolling into the same contract', async () => {
    const adapter = await paperWithPosition()
    const { svc } = service(adapter)
    await expect(
      svc.execute({ exchange: 'paper', symbol: 'MNQZ26', toSymbol: 'MNQZ26' }),
    ).rejects.toThrow('different from the current one')
  })
})

import type {
  Account,
  Balance,
  ExchangeAdapter,
  ExchangeCredentials,
  Order,
  OrderQueryContext,
  OrderResult,
  OrderStatus,
  Position,
  UpdateCallback,
} from '../types.js'

// In-memory paper / mock exchange. Fills market orders immediately against a
// configurable mark price, tracks net positions per symbol, and answers
// getOrderStatus so the order-settlement poller has a terminal outcome to read.
//
// It is the executor's stand-in for a real venue in tests and dry-runs: no
// network, no real orders. Reduce-only orders only ever shrink an existing
// position (never flip it), matching a real exchange's reduce-only semantics.
//
// Behaviour knobs:
//  - setMarkPrice(symbol, price): the price market fills print at.
//  - rejectNextOrder(reason) / setRejectAll(reason): force a rejected fill so
//    the rejected path can be exercised.
//  - setPlacePending(true): placeOrder returns 'pending' instead of 'filled',
//    so the settlement poller (getOrderStatus) is exercised. The order still
//    fills synchronously on the books; getOrderStatus reports it filled.
//  - alwaysOpen = true: crypto-style 24/7 venue, so the market-open guard is
//    skipped (no getMarketStatus needed).

export interface PaperOrderRecord {
  orderId: string
  order: Order
  status: OrderStatus['state']
  filledQuantity: number
  averagePrice: number | null
  reduceOnly: boolean
  createdAt: number
}

export interface PaperPosition {
  symbol: string
  side: 'long' | 'short'
  size: number
  entryPrice: number
  accountId: string
}

export class PaperExchangeAdapter implements ExchangeAdapter {
  name: string
  alwaysOpen = true

  private marks = new Map<string, number>()
  private positions = new Map<string, PaperPosition>()
  private orders = new Map<string, PaperOrderRecord>()
  private orderSeq = 0
  private updateCallback: UpdateCallback | null = null

  // Failure injection.
  private rejectAllReason: string | null = null
  private rejectOnceReason: string | null = null
  // When true, placeOrder reports 'pending' (forcing settlement polling) even
  // though the fill is applied to the books synchronously.
  private placePending = false

  // Order-id labels we have already seen, to make placeOrder idempotent against
  // the same client label (used to assert no double-fill on duplicate signals).
  private seenLabels = new Set<string>()

  constructor(name = 'deribit', initialMarks: Record<string, number> = {}) {
    this.name = name
    for (const [sym, price] of Object.entries(initialMarks)) {
      this.marks.set(sym.toLowerCase(), price)
    }
  }

  // ── Test knobs ────────────────────────────────────────────────────────────

  setMarkPrice(symbol: string, price: number) {
    this.marks.set(symbol.toLowerCase(), price)
  }

  setRejectAll(reason: string | null) {
    this.rejectAllReason = reason
  }

  rejectNextOrder(reason: string) {
    this.rejectOnceReason = reason
  }

  setPlacePending(pending: boolean) {
    this.placePending = pending
  }

  getOrders(): PaperOrderRecord[] {
    return [...this.orders.values()]
  }

  getOrdersForSignal(signalId: string): PaperOrderRecord[] {
    return this.getOrders().filter((o) => (o.order.label ?? '').includes(`:${signalId}:`))
  }

  // ── ExchangeAdapter ───────────────────────────────────────────────────────

  async connect(_credentials: ExchangeCredentials): Promise<void> {
    /* no-op: paper venue is always "connected" */
  }

  async disconnect(): Promise<void> {
    /* no-op */
  }

  async refreshSession(): Promise<void> {
    /* no-op */
  }

  async getAccounts(): Promise<Account[]> {
    return [
      { id: 'paper', exchangeName: this.name, accountId: 'paper', name: 'Paper', currency: 'USD' },
    ]
  }

  async getBalances(): Promise<Balance[]> {
    return [
      {
        accountId: 'paper',
        balance: 100_000,
        equity: 100_000,
        realizedPnL: 0,
        unrealizedPnL: 0,
        currency: 'USD',
        timestamp: Date.now(),
      },
    ]
  }

  async getPositions(): Promise<Position[]> {
    return [...this.positions.values()]
      .filter((p) => Math.abs(p.size) > 0)
      .map((p, i) => ({
        id: `${this.name}:${p.symbol}:${i}`,
        accountId: p.accountId,
        symbol: p.symbol,
        side: p.side,
        size: p.size,
        entryPrice: p.entryPrice,
        markPrice: this.markFor(p.symbol),
      }))
  }

  async placeOrder(order: Order): Promise<OrderResult> {
    const orderId = `paper-${++this.orderSeq}`

    const rejectReason = this.rejectAllReason ?? this.rejectOnceReason
    if (rejectReason) {
      this.rejectOnceReason = null
      this.orders.set(orderId, {
        orderId,
        order,
        status: 'rejected',
        filledQuantity: 0,
        averagePrice: null,
        reduceOnly: !!order.reduceOnly,
        createdAt: Date.now(),
      })
      return { orderId, status: 'rejected', filledQuantity: 0, message: rejectReason }
    }

    // Bracket legs (stop / limit reduce-only resting orders) are recorded but do
    // not fill immediately — they sit working until cancelled or triggered.
    const isResting = order.orderType === 'stop' || order.orderType === 'limit'
    const fillPrice = this.fillPriceFor(order)

    if (isResting && order.reduceOnly) {
      this.orders.set(orderId, {
        orderId,
        order,
        status: 'working',
        filledQuantity: 0,
        averagePrice: null,
        reduceOnly: true,
        createdAt: Date.now(),
      })
      return { orderId, status: 'pending', filledQuantity: 0, averagePrice: fillPrice ?? undefined }
    }

    // Market (or non-reduce-only limit): fill synchronously against the mark.
    const filledQty = this.applyFill(order, fillPrice)

    const record: PaperOrderRecord = {
      orderId,
      order,
      status: 'filled',
      filledQuantity: filledQty,
      averagePrice: fillPrice,
      reduceOnly: !!order.reduceOnly,
      createdAt: Date.now(),
    }
    this.orders.set(orderId, record)

    if (order.label) this.seenLabels.add(order.label)

    // When pending mode is on, report 'pending' so the caller settles via
    // getOrderStatus (which sees the already-applied fill).
    if (this.placePending) {
      record.status = 'filled' // status query truth
      return { orderId, status: 'pending', filledQuantity: filledQty, averagePrice: fillPrice ?? undefined, commission: 0 }
    }

    return {
      orderId,
      status: 'filled',
      filledQuantity: filledQty,
      averagePrice: fillPrice ?? undefined,
      commission: 0,
    }
  }

  async cancelOrder(orderId: string): Promise<void> {
    const rec = this.orders.get(orderId)
    if (rec) rec.status = 'cancelled'
  }

  async getOrderStatus(orderId: string, _ctx?: OrderQueryContext): Promise<OrderStatus> {
    const rec = this.orders.get(orderId)
    // The paper book IS the venue: a missing id is a confirmed absence.
    if (!rec) return { orderId, state: 'unknown', absenceConfirmed: true }
    return {
      orderId,
      state: rec.status,
      filledQuantity: rec.filledQuantity,
      averagePrice: rec.averagePrice ?? undefined,
      commission: 0,
    }
  }

  subscribeToUpdates(callback: UpdateCallback): void {
    this.updateCallback = callback
  }

  unsubscribeFromUpdates(): void {
    this.updateCallback = null
  }

  // Basis-guard price check: the paper book's own mark.
  async getLastPrice(symbol: string): Promise<number | null> {
    const mark = this.markFor(symbol)
    return mark > 0 ? mark : null
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private markFor(symbol: string): number {
    return this.marks.get(symbol.toLowerCase()) ?? 0
  }

  private fillPriceFor(order: Order): number {
    // Limit/stop fill at their own price when set, else the mark.
    if (order.orderType === 'limit' && order.price) return order.price
    if (order.orderType === 'stop' && order.stopPrice) return order.stopPrice
    return order.price && order.orderType === 'limit' ? order.price : this.markFor(order.symbol)
  }

  // Apply a fill to the net position book. Reduce-only orders never flip the
  // position past flat. Returns the quantity actually filled.
  private applyFill(order: Order, price: number): number {
    const key = order.symbol.toLowerCase()
    const existing = this.positions.get(key)
    const signedIncoming = order.side === 'buy' ? order.quantity : -order.quantity

    if (!existing || existing.size === 0) {
      if (order.reduceOnly) return 0 // nothing to reduce
      const size = Math.abs(order.quantity)
      this.positions.set(key, {
        symbol: order.symbol,
        side: signedIncoming >= 0 ? 'long' : 'short',
        size,
        entryPrice: price,
        accountId: order.accountId,
      })
      this.emitPosition(key)
      return size
    }

    const currentSigned = existing.side === 'long' ? existing.size : -existing.size
    let applyQty = order.quantity
    // A reduce-only order can only move the position toward flat.
    if (order.reduceOnly) {
      const reduces =
        (currentSigned > 0 && signedIncoming < 0) || (currentSigned < 0 && signedIncoming > 0)
      if (!reduces) return 0
      applyQty = Math.min(order.quantity, Math.abs(currentSigned))
    }

    const delta = order.side === 'buy' ? applyQty : -applyQty
    const newSigned = currentSigned + delta

    if (Math.abs(newSigned) < 1e-9) {
      this.positions.delete(key)
      this.emitPosition(key)
      return applyQty
    }

    // Same direction add → weighted entry; opposite → reduce keeps entry.
    if (Math.sign(newSigned) === Math.sign(currentSigned)) {
      if (Math.abs(newSigned) > Math.abs(currentSigned)) {
        const addedQty = Math.abs(newSigned) - Math.abs(currentSigned)
        existing.entryPrice =
          (existing.entryPrice * Math.abs(currentSigned) + price * addedQty) / Math.abs(newSigned)
      }
      existing.size = Math.abs(newSigned)
      existing.side = newSigned > 0 ? 'long' : 'short'
    } else {
      // Flip (only possible for non-reduce-only): new entry at fill price.
      existing.size = Math.abs(newSigned)
      existing.side = newSigned > 0 ? 'long' : 'short'
      existing.entryPrice = price
    }
    this.emitPosition(key)
    return applyQty
  }

  private emitPosition(key: string) {
    if (!this.updateCallback) return
    const pos = this.positions.get(key)
    this.updateCallback({ type: 'position', data: pos ?? { symbol: key, size: 0 } })
  }
}

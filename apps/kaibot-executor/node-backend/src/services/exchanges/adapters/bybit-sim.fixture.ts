// In-memory Bybit v5 for tests: a real BybitAdapter talks to it through a
// mocked global fetch. Covers what the collateral floor touches: tickers,
// instruments, UTA wallet + collateral tiers, one-way linear positions with
// reduce-only, market fills at the mark, resting spot conditionals (fire on
// setPrice), amend, cancel and order lookup by id or orderLinkId.

import { BybitAdapter } from './bybit.js'

type Side = 'Buy' | 'Sell'

interface SimOrder {
  orderId: string
  orderLinkId: string
  category: 'linear' | 'spot'
  symbol: string
  side: Side
  orderType: 'Market'
  qty: number
  marketUnit: 'baseCoin' | 'quoteCoin' | null
  reduceOnly: boolean
  positionIdx: number | null
  orderFilter: string | null
  triggerPrice: number | null
  orderStatus: 'New' | 'Untriggered' | 'Filled' | 'Cancelled' | 'Rejected'
  cumExecQty: number
  avgPrice: number
  cumExecFee: number
  createdTime: number
  updatedTime: number
}

const INSTRUMENTS: Record<string, { linear: [number, number]; spot: [number, number, number] }> = {
  // linear [qtyStep, minOrderQty]; spot [basePrecision, minOrderQty, quotePrecision]
  BTCUSDT: { linear: [0.001, 0.001], spot: [0.000001, 0.000048, 0.0000001] },
  ETHUSDT: { linear: [0.01, 0.01], spot: [0.00001, 0.0005, 0.0000001] },
  SOLUSDT: { linear: [0.1, 0.1], spot: [0.001, 0.01, 0.0000001] },
  XRPUSDT: { linear: [1, 1], spot: [0.01, 1, 0.0000001] },
}

export class BybitSim {
  prices: Record<string, number> = {}
  wallet: Record<string, number> = {}
  collateralOff = new Set<string>()
  // symbol → signed size (one-way), avg entry
  positions = new Map<string, { size: number; avg: number }>()
  orders = new Map<string, SimOrder>()
  mmRate = 0.05
  imRate = 0.1
  tiers: Record<string, Array<{ minQty: string; maxQty: string; collateralRatio: string }>> = {
    BTC: [{ minQty: '0', maxQty: '', collateralRatio: '0.95' }],
    ETH: [{ minQty: '0', maxQty: '', collateralRatio: '0.95' }],
    SOL: [
      { minQty: '0', maxQty: '50000', collateralRatio: '0.9' },
      { minQty: '50000', maxQty: '', collateralRatio: '0.5' },
    ],
  }
  requests: Array<{ method: string; path: string; params: Record<string, any> }> = []
  failNextCreate: string | null = null
  private seq = 0
  private realFetch = globalThis.fetch

  install(): void {
    globalThis.fetch = (async (input: any, init?: any) => this.handle(String(input), init)) as any
  }

  uninstall(): void {
    globalThis.fetch = this.realFetch
  }

  adapter(): BybitAdapter {
    const a = new BybitAdapter()
    ;(a as any).credentials = { type: 'apiKey', apiKey: 'k', apiSecret: 's' }
    ;(a as any).unifiedAccount = true
    return a
  }

  // Move the market; resting spot conditionals fire on the way.
  setPrice(symbol: string, price: number): void {
    this.prices[symbol] = price
    for (const o of this.orders.values()) {
      if (o.symbol !== symbol || o.orderStatus !== 'Untriggered' || o.triggerPrice == null) continue
      const hit = o.side === 'Sell' ? price <= o.triggerPrice : price >= o.triggerPrice
      if (hit) this.fillSpot(o, price)
    }
  }

  openOrders(): SimOrder[] {
    return [...this.orders.values()].filter((o) => o.orderStatus === 'Untriggered' || o.orderStatus === 'New')
  }

  private ok(result: unknown) {
    return new Response(JSON.stringify({ retCode: 0, retMsg: 'OK', result, time: Date.now() }))
  }

  private err(code: number, msg: string) {
    return new Response(JSON.stringify({ retCode: code, retMsg: msg, result: {} }))
  }

  private handle(url: string, init?: any): Response {
    const u = new URL(url)
    const path = u.pathname
    const method = (init?.method ?? 'GET').toUpperCase()
    const params: Record<string, any> =
      method === 'POST' ? JSON.parse(init.body ?? '{}') : Object.fromEntries(u.searchParams.entries())
    this.requests.push({ method, path, params })
    switch (path) {
      case '/v5/market/time':
        return this.ok({ timeSecond: String(Math.floor(Date.now() / 1000)), timeNano: String(Date.now() * 1e6) })
      case '/v5/account/info':
        return this.ok({ unifiedMarginStatus: 5, marginMode: 'REGULAR_MARGIN' })
      case '/v5/market/tickers': {
        const p = this.prices[params.symbol]
        return this.ok({ list: p ? [{ symbol: params.symbol, markPrice: String(p), lastPrice: String(p), fundingRate: '0.0001' }] : [] })
      }
      case '/v5/market/instruments-info': {
        const spec = INSTRUMENTS[params.symbol]
        if (!spec) return this.ok({ list: [] })
        if (params.category === 'spot') {
          const [base, min, quote] = spec.spot
          return this.ok({ list: [{ symbol: params.symbol, status: 'Trading', lotSizeFilter: { basePrecision: String(base), minOrderQty: String(min), quotePrecision: String(quote) }, priceFilter: { tickSize: '0.01' } }] })
        }
        const [step, min] = spec.linear
        return this.ok({ list: [{ symbol: params.symbol, status: 'Trading', lotSizeFilter: { qtyStep: String(step), minOrderQty: String(min), minNotionalValue: '5' }, priceFilter: { tickSize: '0.1' } }] })
      }
      case '/v5/spot-margin-trade/collateral': {
        const t = this.tiers[params.currency]
        return this.ok({ list: t ? [{ currency: params.currency, collateralRatioList: t }] : [] })
      }
      case '/v5/account/wallet-balance':
        return this.ok({ list: [this.walletEntry()] })
      case '/v5/position/list': {
        const list: any[] = []
        for (const [symbol, p] of this.positions) {
          if (params.symbol && params.symbol !== symbol) continue
          if (params.category && params.category !== 'linear') continue
          if (params.settleCoin && params.settleCoin !== 'USDT') continue
          list.push({
            symbol, positionIdx: 0, side: p.size > 0 ? 'Buy' : p.size < 0 ? 'Sell' : '', size: String(Math.abs(p.size)),
            avgPrice: String(p.avg), markPrice: String(this.prices[symbol] ?? p.avg), unrealisedPnl: '0', tradeMode: 0, leverage: '1',
          })
        }
        return this.ok({ list, nextPageCursor: '' })
      }
      case '/v5/order/create':
        return this.create(params)
      case '/v5/order/amend': {
        const o = this.orders.get(params.orderId)
        if (!o || o.orderStatus !== 'Untriggered') return this.err(110001, 'order not exists or too late to replace')
        if (params.triggerPrice) o.triggerPrice = Number(params.triggerPrice)
        if (params.qty) o.qty = Number(params.qty)
        o.updatedTime = Date.now()
        return this.ok({ orderId: o.orderId, orderLinkId: o.orderLinkId })
      }
      case '/v5/order/cancel': {
        const o = this.orders.get(params.orderId)
        if (!o || (o.orderStatus !== 'Untriggered' && o.orderStatus !== 'New')) {
          return this.err(110001, 'order not exists or too late to cancel')
        }
        if (o.category === 'spot' && o.orderFilter === 'StopOrder' && params.orderFilter !== 'StopOrder') {
          return this.err(110001, 'order not exists or too late to cancel')
        }
        o.orderStatus = 'Cancelled'
        return this.ok({ orderId: o.orderId })
      }
      case '/v5/order/realtime':
      case '/v5/order/history': {
        const list = [...this.orders.values()].filter((o) =>
          params.orderLinkId ? o.orderLinkId === params.orderLinkId : o.orderId === params.orderId,
        )
        return this.ok({ list: list.map((o) => this.row(o)), nextPageCursor: '' })
      }
      default:
        return this.ok({ list: [] })
    }
  }

  private row(o: SimOrder) {
    return {
      orderId: o.orderId, orderLinkId: o.orderLinkId, symbol: o.symbol, side: o.side, orderType: o.orderType,
      qty: String(o.qty), orderStatus: o.orderStatus, cumExecQty: String(o.cumExecQty), avgPrice: String(o.avgPrice),
      cumExecFee: String(o.cumExecFee), triggerPrice: String(o.triggerPrice ?? ''), reduceOnly: o.reduceOnly,
      stopOrderType: o.orderFilter === 'StopOrder' ? 'Stop' : '', category: o.category,
      createdTime: String(o.createdTime), updatedTime: String(o.updatedTime),
    }
  }

  private walletEntry() {
    const coins = Object.entries(this.wallet).map(([coin, bal]) => {
      const px = coin === 'USDT' || coin === 'USDC' ? 1 : this.prices[`${coin}USDT`] ?? 0
      return {
        coin, walletBalance: String(bal), equity: String(bal), usdValue: String(bal * px),
        borrowAmount: String(bal < 0 ? -bal : 0), collateralSwitch: !this.collateralOff.has(coin),
        marginCollateral: true, locked: '0', unrealisedPnl: '0', cumRealisedPnl: '0',
      }
    })
    const equity = coins.reduce((s, c) => s + Number(c.usdValue), 0)
    return {
      accountType: 'UNIFIED', totalEquity: String(equity), totalMarginBalance: String(equity),
      totalAvailableBalance: String(equity * (1 - this.imRate)), totalInitialMargin: String(equity * this.imRate),
      totalMaintenanceMargin: String(equity * this.mmRate), accountIMRate: String(this.imRate),
      accountMMRate: String(this.mmRate), coin: coins,
    }
  }

  private nextId() {
    this.seq += 1
    return `sim-${this.seq}`
  }

  private create(p: Record<string, any>): Response {
    if (this.failNextCreate) {
      const msg = this.failNextCreate
      this.failNextCreate = null
      return this.err(170131, msg)
    }
    if (p.orderLinkId && [...this.orders.values()].some((o) => o.orderLinkId === p.orderLinkId)) {
      return this.err(10001, 'duplicate orderLinkId')
    }
    const o: SimOrder = {
      orderId: this.nextId(), orderLinkId: p.orderLinkId ?? '', category: p.category, symbol: p.symbol, side: p.side,
      orderType: 'Market', qty: Number(p.qty), marketUnit: p.marketUnit ?? null, reduceOnly: p.reduceOnly === true,
      positionIdx: p.positionIdx ?? null, orderFilter: p.orderFilter ?? null,
      triggerPrice: p.triggerPrice != null ? Number(p.triggerPrice) : null, orderStatus: 'New', cumExecQty: 0,
      avgPrice: 0, cumExecFee: 0, createdTime: Date.now(), updatedTime: Date.now(),
    }
    if (o.category === 'spot') {
      if (o.orderFilter === 'StopOrder') {
        o.orderStatus = 'Untriggered'
        this.orders.set(o.orderId, o)
        return this.ok({ orderId: o.orderId, orderLinkId: o.orderLinkId })
      }
      this.orders.set(o.orderId, o)
      this.fillSpot(o, this.prices[o.symbol])
      return this.ok({ orderId: o.orderId, orderLinkId: o.orderLinkId })
    }
    // linear market, one-way
    if (o.positionIdx !== 0) return this.err(10001, 'position idx not match position mode')
    const px = this.prices[o.symbol]
    const cur = this.positions.get(o.symbol) ?? { size: 0, avg: 0 }
    const dir = o.side === 'Buy' ? 1 : -1
    let qty = o.qty
    if (o.reduceOnly) {
      if (cur.size === 0 || Math.sign(cur.size) === dir) {
        o.orderStatus = 'Rejected'
        this.orders.set(o.orderId, o)
        return this.err(110017, 'reduce-only order would increase position')
      }
      qty = Math.min(qty, Math.abs(cur.size))
    }
    const next = cur.size + dir * qty
    // Realized PnL on the reduced part settles in USDT (a loss becomes a loan).
    if (cur.size !== 0 && Math.sign(cur.size) !== dir) {
      const closed = Math.min(qty, Math.abs(cur.size))
      this.wallet.USDT = (this.wallet.USDT ?? 0) + closed * (px - cur.avg) * Math.sign(cur.size)
    }
    const avg =
      next === 0 ? 0 : Math.sign(next) === Math.sign(cur.size) && Math.abs(next) > Math.abs(cur.size)
        ? (Math.abs(cur.size) * cur.avg + qty * px) / Math.abs(next)
        : Math.sign(next) !== Math.sign(cur.size) ? px : cur.avg
    if (next === 0) this.positions.delete(o.symbol)
    else this.positions.set(o.symbol, { size: next, avg })
    o.orderStatus = 'Filled'
    o.cumExecQty = qty
    o.avgPrice = px
    o.updatedTime = Date.now()
    this.orders.set(o.orderId, o)
    return this.ok({ orderId: o.orderId, orderLinkId: o.orderLinkId })
  }

  private fillSpot(o: SimOrder, px: number): void {
    const coin = o.symbol.replace(/USDT$/, '')
    if (o.side === 'Sell') {
      const qty = Math.min(o.qty, Math.max(0, this.wallet[coin] ?? 0))
      this.wallet[coin] = (this.wallet[coin] ?? 0) - qty
      const fee = qty * px * 0.001
      this.wallet.USDT = (this.wallet.USDT ?? 0) + qty * px - fee
      o.cumExecQty = qty
      o.cumExecFee = fee
    } else {
      const spend = o.marketUnit === 'quoteCoin' ? o.qty : o.qty * px
      const coins = (spend / px) * 0.999
      this.wallet.USDT = (this.wallet.USDT ?? 0) - spend
      this.wallet[coin] = (this.wallet[coin] ?? 0) + coins
      o.cumExecQty = coins
      o.cumExecFee = 0
    }
    o.avgPrice = px
    o.orderStatus = 'Filled'
    o.updatedTime = Date.now()
  }
}

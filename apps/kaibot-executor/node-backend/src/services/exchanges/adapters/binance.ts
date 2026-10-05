import crypto from 'node:crypto'
import WebSocket from 'ws'
import { timeoutSignal, type FetchTimeoutKind } from '../fetch-timeout.js'
import { parseClientOrderRef } from '../../client-order-id.js'
import {
  ExchangeAdapter,
  ExchangeCredentials,
  Account,
  Balance,
  Position,
  Order,
  OrderResult,
  OrderStatus,
  OrderQueryContext,
  UpdateCallback,
} from '../types.js'

interface BinanceCredentials extends ExchangeCredentials {
  type: 'apiKey'
  apiKey: string
  apiSecret: string
  testnet?: boolean
  recvWindow?: number
}

const DEFAULT_RECV_WINDOW = 5000
const ACCOUNT_ID = 'usdm-futures'
const LISTEN_KEY_KEEPALIVE_MS = 30 * 60 * 1000

export class BinanceAdapter implements ExchangeAdapter {
  name = 'binance'
  // Mainnet fapi base + user-data stream.
  private baseURL = 'https://fapi.binance.com'
  private wsURL = 'wss://fstream.binance.com'
  private credentials?: BinanceCredentials
  private ws?: WebSocket
  private updateCallback?: UpdateCallback
  private listenKey?: string
  private keepAliveInterval?: NodeJS.Timeout
  private reconnectTimeout?: NodeJS.Timeout

  async connect(credentials: ExchangeCredentials): Promise<void> {
    if (credentials.type !== 'apiKey') {
      throw new Error('Binance requires API key authentication')
    }

    this.credentials = credentials as BinanceCredentials

    if (this.credentials.testnet) {
      // FLAG for Kai: newer Binance docs also list demo-fapi.binance.com as the
      // futures testnet host. Defaulting to testnet.binancefuture.com — the
      // long-standing public USDⓈ-M futures testnet. Switch here if needed.
      this.baseURL = 'https://testnet.binancefuture.com'
      this.wsURL = 'wss://stream.binancefuture.com'
    } else {
      this.baseURL = 'https://fapi.binance.com'
      this.wsURL = 'wss://fstream.binance.com'
    }

    await this.verifyCredentials()
    await this.connectWebSocket().catch((err) => {
      console.warn('Binance WebSocket connect failed (continuing without WS):', err?.message || err)
    })
  }

  async disconnect(): Promise<void> {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval)
      this.keepAliveInterval = undefined
    }
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = undefined
    }
    if (this.ws) {
      try {
        this.ws.removeAllListeners()
        this.ws.close()
      } catch {}
      this.ws = undefined
    }
    this.listenKey = undefined
    this.credentials = undefined
  }

  async refreshSession(): Promise<void> {
    // Binance uses per-request HMAC signatures, no session token to refresh.
    await this.verifyCredentials()
  }

  async getAccounts(): Promise<Account[]> {
    const placeholder: Account = {
      id: 'binance:usdm-futures',
      exchangeName: this.name,
      accountId: ACCOUNT_ID,
      accountType: 'futures',
      name: 'USDⓈ-M Futures',
      currency: 'USDT',
    }
    try {
      // /fapi/v2/account is the canonical signed private check for the futures
      // wallet. Fresh keys still resolve to the single placeholder account below.
      await this.signedRequest<any>('GET', '/fapi/v2/account', {})
      return [placeholder]
    } catch (error: any) {
      console.error('Failed to get Binance accounts:', error)
      return [placeholder]
    }
  }

  async getBalances(): Promise<Balance[]> {
    try {
      const balances: Balance[] = []
      // /fapi/v2/account carries per-asset margin in assets[] (initialMargin /
      // maintMargin); /fapi/v2/balance does not. The pre-open margin guard needs
      // those, so read account here. One row per funded asset (shape unchanged).
      // Note: in single-asset margin mode the collateral asset (USDT) carries the
      // account's margin; multi-asset mode splits it across assets.
      const acct = await this.signedRequest<any>('GET', '/fapi/v2/account', {})
      for (const a of acct?.assets || []) {
        const walletBalance = parseFloat(a.walletBalance || '0')
        const crossUnPnl = parseFloat(a.crossUnPnl || '0')
        const initialMargin = parseFloat(a.initialMargin || '0')
        const maintMargin = parseFloat(a.maintMargin || '0')
        if (walletBalance === 0 && crossUnPnl === 0 && initialMargin === 0 && maintMargin === 0) continue
        balances.push({
          accountId: ACCOUNT_ID,
          balance: walletBalance,
          equity: parseFloat(a.marginBalance || String(walletBalance + crossUnPnl)),
          realizedPnL: 0,
          unrealizedPnL: crossUnPnl,
          initialMargin,
          maintenanceMargin: maintMargin,
          currency: a.asset,
          timestamp: Date.now(),
        })
      }
      return balances
    } catch (error: any) {
      console.error('Failed to get Binance balances:', error)
      throw new Error(`Failed to get balances: ${error.message}`)
    }
  }

  async getPositions(): Promise<Position[]> {
    try {
      const positions: Position[] = []
      const list = await this.signedRequest<any[]>('GET', '/fapi/v2/positionRisk', {})
      for (const p of list || []) {
        const positionAmt = parseFloat(p.positionAmt || '0')
        if (positionAmt === 0) continue
        positions.push({
          id: `binance:${p.symbol}`,
          accountId: ACCOUNT_ID,
          symbol: p.symbol,
          side: positionAmt > 0 ? 'long' : 'short',
          size: Math.abs(positionAmt),
          entryPrice: parseFloat(p.entryPrice || '0'),
          markPrice: parseFloat(p.markPrice || '0'),
          unrealizedPnL: parseFloat(p.unRealizedProfit || '0'),
          marginType: p.marginType,
          leverage: parseFloat(p.leverage || '1'),
        })
      }
      return positions
    } catch (error: any) {
      console.error('Failed to get Binance positions:', error)
      throw new Error(`Failed to get positions: ${error.message}`)
    }
  }

  // Public mark price (no auth) — basis-guard price check.
  async getLastPrice(symbol: string): Promise<number | null> {
    try {
      const res = await fetch(
        `${this.baseURL}/fapi/v1/premiumIndex?symbol=${encodeURIComponent(symbol)}`,
        { signal: timeoutSignal('read') },
      )
      const data = (await res.json()) as { markPrice?: string }
      const price = parseFloat(data?.markPrice || '')
      return Number.isFinite(price) && price > 0 ? price : null
    } catch {
      return null
    }
  }

  async placeOrder(order: Order): Promise<OrderResult> {
    try {
      const side = order.side === 'buy' ? 'BUY' : 'SELL'
      const type = this.mapOrderType(order.orderType)

      const params: Record<string, any> = {
        symbol: order.symbol,
        side,
        type,
        quantity: String(order.quantity),
      }

      if (order.orderType === 'limit') {
        if (order.price === undefined) {
          throw new Error('Limit orders require a price')
        }
        params.price = String(order.price)
        params.timeInForce = order.timeInForce || 'GTC'
      }

      if (order.orderType === 'stop' || order.orderType === 'stopLimit') {
        const stopPrice = order.stopPrice ?? order.price
        if (stopPrice === undefined) {
          throw new Error('Stop orders require a stopPrice')
        }
        params.stopPrice = String(stopPrice)
        params.workingType = this.mapWorkingType(order.triggerType)
        if (order.orderType === 'stopLimit') {
          if (order.price === undefined) {
            throw new Error('Stop-limit orders require a price')
          }
          params.price = String(order.price)
          params.timeInForce = order.timeInForce || 'GTC'
        }
      }

      // Reduce-only protective legs must never flip the position. Binance rejects
      // reduceOnly when closePosition is set, so we never set closePosition —
      // reduceOnly alone keeps a protective leg from over-closing. Binance wants
      // the string 'true' here, not a boolean.
      if (order.reduceOnly) {
        params.reduceOnly = 'true'
      }

      // Broker-side idempotency: Binance rejects a duplicate newClientOrderId
      // (max 36 chars, matches ^[.A-Za-z0-9_-]{1,36}$).
      if (order.clientOrderId) {
        params.newClientOrderId = order.clientOrderId.replace(/[^.A-Za-z0-9_-]/g, '').slice(0, 36)
      }

      const result = await this.signedRequest<any>('POST', '/fapi/v1/order', params, 'order')

      return {
        orderId: String(result.orderId),
        // A plain MARKET order is taken as filled (status query confirms the real
        // outcome); conditional/limit orders rest until they trigger or fill.
        status: type === 'MARKET' ? 'filled' : 'pending',
        filledQuantity: parseFloat(result.executedQty || '0'),
        averagePrice: parseFloat(result.avgPrice || '0'),
      }
    } catch (error: any) {
      console.error('Failed to place Binance order:', error)
      throw new Error(`Failed to place order: ${error.message}`)
    }
  }

  private mapOrderType(orderType: Order['orderType']): string {
    switch (orderType) {
      case 'limit':
        return 'LIMIT'
      case 'stop':
        return 'STOP_MARKET'
      case 'stopLimit':
        return 'STOP'
      default:
        return 'MARKET'
    }
  }

  // workingType selects the price channel the trigger watches.
  private mapWorkingType(triggerType?: Order['triggerType']): string {
    switch (triggerType) {
      case 'mark_price':
        return 'MARK_PRICE'
      // last_price (and index_price, unsupported here) → contract/last price.
      default:
        return 'CONTRACT_PRICE'
    }
  }

  async cancelOrder(orderId: string, ctx: OrderQueryContext = {}): Promise<void> {
    try {
      // Binance requires symbol + orderId. placeOrder returns the bare id, so take
      // symbol from ctx, then a "<symbol>:<orderId>" composite, and finally resolve
      // it from the live open orders — never throw on a bare id.
      const { symbol: parsedSymbol, rawId } = this.parseOrderId(orderId)
      let symbol = ctx.symbol ?? parsedSymbol
      if (!symbol) {
        const open = await this.signedRequest<any[]>('GET', '/fapi/v1/openOrders', {})
        symbol = (open ?? []).find((o) => String(o.orderId) === String(rawId))?.symbol
      }
      if (!symbol) {
        throw new Error('Binance cancelOrder could not resolve a symbol for the order')
      }
      await this.signedRequest('DELETE', '/fapi/v1/order', { symbol, orderId: rawId }, 'order')
    } catch (error: any) {
      console.error('Failed to cancel Binance order:', error)
      throw new Error(`Failed to cancel order: ${error.message}`)
    }
  }

  subscribeToUpdates(callback: UpdateCallback): void {
    this.updateCallback = callback
  }

  unsubscribeFromUpdates(): void {
    this.updateCallback = undefined
  }

  // Binance USDⓈ-M futures trade 24/7 → the market-open guard never blocks it.
  alwaysOpen = true

  /**
   * Query an order's current state by id for the settlement poller. The symbol
   * comes from the query context or the "<symbol>:<orderId>" id form (Binance
   * needs it). Returns 'unknown' when the broker doesn't report the id.
   */
  async getOrderStatus(orderId: string, ctx: OrderQueryContext = {}): Promise<OrderStatus> {
    // A "client:<id>" ref queries by client order id — used to resolve orders
    // whose placeOrder call threw before returning a broker id (EX2).
    const clientId = parseClientOrderRef(orderId)
    const { symbol: parsedSymbol, rawId } = clientId
      ? { symbol: undefined, rawId: clientId }
      : this.parseOrderId(orderId)
    const symbol = ctx.symbol ?? parsedSymbol
    if (!symbol) return { orderId, state: 'unknown' }

    try {
      const query = clientId
        ? { symbol, origClientOrderId: rawId }
        : { symbol, orderId: rawId }
      const order = await this.signedRequest<any>('GET', '/fapi/v1/order', query)
      // A successful query with no order = the venue positively reports it absent.
      if (!order || order.orderId === undefined)
        return { orderId, state: 'unknown', absenceConfirmed: true }
      return {
        orderId,
        state: this.mapToStatusState(order.status),
        filledQuantity: parseFloat(order.executedQty || '0') || 0,
        averagePrice: parseFloat(order.avgPrice || '0') || 0,
        commission: 0,
        raw: order,
      }
    } catch (error: any) {
      // Binance reports a nonexistent order as error -2013 "Order does not
      // exist" — a venue-confirmed absence. Anything else (network/auth/rate
      // limit) is an inconclusive lookup: the order may still exist.
      const msg = String(error?.message ?? '')
      return {
        orderId,
        state: 'unknown',
        absenceConfirmed: /order does not exist/i.test(msg),
      }
    }
  }

  // https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/enums
  private mapToStatusState(status: string): OrderStatus['state'] {
    switch (status) {
      case 'FILLED':
        return 'filled'
      case 'PARTIALLY_FILLED':
        return 'partially_filled'
      case 'CANCELED':
      case 'EXPIRED':
        return 'cancelled'
      case 'REJECTED':
        return 'rejected'
      case 'NEW':
        return 'working'
      default:
        return 'unknown'
    }
  }

  // --- internals ---

  // Split a "<symbol>:<orderId>" id; a bare id leaves symbol undefined.
  private parseOrderId(orderId: string): { symbol?: string; rawId: string } {
    const idx = orderId.indexOf(':')
    if (idx === -1) return { rawId: orderId }
    return { symbol: orderId.slice(0, idx), rawId: orderId.slice(idx + 1) }
  }

  private async verifyCredentials(): Promise<void> {
    // /fapi/v2/balance requires private auth, cheap signed round-trip.
    await this.signedRequest('GET', '/fapi/v2/balance', {})
  }

  private sign(queryString: string): string {
    if (!this.credentials) throw new Error('Not authenticated')
    return crypto
      .createHmac('sha256', this.credentials.apiSecret)
      .update(queryString)
      .digest('hex')
  }

  private buildSignedQuery(params: Record<string, any>): string {
    if (!this.credentials) throw new Error('Not authenticated')
    const recvWindow = this.credentials.recvWindow ?? DEFAULT_RECV_WINDOW
    const full: Record<string, any> = { ...params, recvWindow, timestamp: Date.now() }
    const queryString = Object.entries(full)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join('&')
    const signature = this.sign(queryString)
    return `${queryString}&signature=${signature}`
  }

  private async signedRequest<T = any>(
    method: string,
    path: string,
    params: Record<string, any>,
    timeout: FetchTimeoutKind = 'read',
  ): Promise<T> {
    if (!this.credentials) throw new Error('Not authenticated')
    const query = this.buildSignedQuery(params)
    const url = `${this.baseURL}${path}?${query}`

    const res = await fetch(url, {
      method,
      headers: {
        'X-MBX-APIKEY': this.credentials.apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      signal: timeoutSignal(timeout),
    })

    const data = (await res.json()) as any
    if (!res.ok || (data && typeof data.code === 'number' && data.code < 0)) {
      throw new Error(data?.msg || `Binance ${method} ${path} failed: ${res.status}`)
    }
    return data as T
  }

  // listenKey only needs the X-MBX-APIKEY header, no HMAC signature.
  private async listenKeyRequest(method: string): Promise<any> {
    if (!this.credentials) throw new Error('Not authenticated')
    const res = await fetch(`${this.baseURL}/fapi/v1/listenKey`, {
      method,
      headers: {
        'X-MBX-APIKEY': this.credentials.apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      signal: timeoutSignal('auth'),
    })
    const data = (await res.json().catch(() => ({}))) as any
    if (!res.ok || (data && typeof data.code === 'number' && data.code < 0)) {
      throw new Error(data?.msg || `Binance ${method} listenKey failed: ${res.status}`)
    }
    return data
  }

  private async connectWebSocket(): Promise<void> {
    if (!this.credentials) throw new Error('Not authenticated')

    const created = await this.listenKeyRequest('POST')
    this.listenKey = created?.listenKey
    if (!this.listenKey) throw new Error('Binance listenKey not returned')

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${this.wsURL}/ws/${this.listenKey}`)
      this.ws = ws

      const settleTimer = setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          reject(new Error('Binance WebSocket timeout'))
        }
      }, 10000)

      ws.on('open', () => {
        clearTimeout(settleTimer)
        this.startKeepAlive()
        if (this.updateCallback) {
          this.updateCallback({ type: 'account', data: { connected: true } })
        }
        resolve()
      })

      ws.on('message', (raw) => {
        let msg: any
        try {
          msg = JSON.parse(raw.toString())
        } catch {
          return
        }
        if (!this.updateCallback) return

        switch (msg.e) {
          case 'ACCOUNT_UPDATE':
            // ACCOUNT_UPDATE carries both balances and positions in a.B / a.P.
            this.updateCallback({ type: 'balance', data: msg })
            this.updateCallback({ type: 'position', data: msg })
            break
          case 'ORDER_TRADE_UPDATE':
            this.updateCallback({ type: 'order', data: msg })
            break
        }
      })

      ws.on('error', (err) => {
        console.error('Binance WebSocket error:', err?.message || err)
        if (this.updateCallback) {
          this.updateCallback({
            type: 'account',
            data: { connected: false, error: 'WebSocket error' },
          })
        }
      })

      ws.on('close', () => {
        if (this.keepAliveInterval) {
          clearInterval(this.keepAliveInterval)
          this.keepAliveInterval = undefined
        }
        this.scheduleReconnect()
      })
    })
  }

  private startKeepAlive(): void {
    if (this.keepAliveInterval) clearInterval(this.keepAliveInterval)
    this.keepAliveInterval = setInterval(() => {
      this.listenKeyRequest('PUT').catch((err) => {
        console.error('Binance listenKey keepalive failed:', err?.message || err)
      })
    }, LISTEN_KEY_KEEPALIVE_MS)
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout) return
    this.reconnectTimeout = setTimeout(async () => {
      this.reconnectTimeout = undefined
      if (!this.credentials) return
      try {
        await this.connectWebSocket()
      } catch (err) {
        console.error('Binance WS reconnect failed:', err)
        this.scheduleReconnect()
      }
    }, 5000)
  }
}

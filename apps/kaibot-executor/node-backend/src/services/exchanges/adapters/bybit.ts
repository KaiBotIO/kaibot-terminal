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

interface BybitCredentials extends ExchangeCredentials {
  type: 'apiKey'
  apiKey: string
  apiSecret: string
  testnet?: boolean
  recvWindow?: number
}

type BybitCategory = 'linear' | 'inverse' | 'spot'

interface BybitResponse<T = any> {
  retCode: number
  retMsg: string
  result: T
  time?: number
}

const DEFAULT_RECV_WINDOW = 5000

export class BybitAdapter implements ExchangeAdapter {
  name = 'bybit'
  private baseURL = 'https://api.bybit.com'
  private wsURL = 'wss://stream.bybit.com/v5/private'
  private credentials?: BybitCredentials
  private ws?: WebSocket
  private updateCallback?: UpdateCallback
  private pingInterval?: NodeJS.Timeout
  private reconnectTimeout?: NodeJS.Timeout
  private wsAuthenticated = false

  async connect(credentials: ExchangeCredentials): Promise<void> {
    if (credentials.type !== 'apiKey') {
      throw new Error('Bybit requires API key authentication')
    }

    this.credentials = credentials as BybitCredentials

    if (this.credentials.testnet) {
      this.baseURL = 'https://api-testnet.bybit.com'
      this.wsURL = 'wss://stream-testnet.bybit.com/v5/private'
    } else {
      this.baseURL = 'https://api.bybit.com'
      this.wsURL = 'wss://stream.bybit.com/v5/private'
    }

    await this.verifyCredentials()
    await this.connectWebSocket().catch((err) => {
      console.warn('Bybit WebSocket connect failed (continuing without WS):', err?.message || err)
    })
  }

  async disconnect(): Promise<void> {
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = undefined
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
    this.wsAuthenticated = false
    this.credentials = undefined
  }

  async refreshSession(): Promise<void> {
    // Bybit uses per-request HMAC signatures, no session token to refresh.
    await this.verifyCredentials()
  }

  async getAccounts(): Promise<Account[]> {
    try {
      // UNIFIED account (covers linear + spot). Fallback to CONTRACT for inverse-only.
      const unified = await this.signedGet<any>('/v5/account/wallet-balance', { accountType: 'UNIFIED' })
        .catch(() => null)

      const accounts: Account[] = []

      if (unified?.list?.length) {
        accounts.push({
          id: 'bybit:unified',
          exchangeName: this.name,
          accountId: 'unified',
          accountType: 'unified',
          name: 'Unified Account',
          currency: unified.list[0].accountType === 'UNIFIED' ? 'USD' : 'USDT',
        })
      }

      const contract = await this.signedGet<any>('/v5/account/wallet-balance', { accountType: 'CONTRACT' })
        .catch(() => null)

      if (contract?.list?.length) {
        accounts.push({
          id: 'bybit:contract',
          exchangeName: this.name,
          accountId: 'contract',
          accountType: 'contract',
          name: 'Contract Account',
          currency: 'USDT',
        })
      }

      if (accounts.length === 0) {
        // Return a placeholder account so manager doesn't fail for fresh keys
        accounts.push({
          id: 'bybit:unified',
          exchangeName: this.name,
          accountId: 'unified',
          accountType: 'unified',
          name: 'Unified Account',
          currency: 'USDT',
        })
      }

      return accounts
    } catch (error: any) {
      console.error('Failed to get Bybit accounts:', error)
      throw new Error(`Failed to get accounts: ${error.message}`)
    }
  }

  async getBalances(): Promise<Balance[]> {
    try {
      const balances: Balance[] = []

      const pushFromWallet = (wallet: any, accountId: string) => {
        if (!wallet?.list?.length) return
        for (const entry of wallet.list) {
          const coins = entry.coin || []
          for (const coin of coins) {
            const bal = parseFloat(coin.walletBalance || '0')
            const eq = parseFloat(coin.equity || coin.walletBalance || '0')
            if (bal === 0 && eq === 0) continue
            balances.push({
              accountId,
              balance: bal,
              equity: eq,
              realizedPnL: parseFloat(coin.cumRealisedPnl || '0'),
              unrealizedPnL: parseFloat(coin.unrealisedPnl || '0'),
              initialMargin: parseFloat(entry.totalInitialMargin || '0') || undefined,
              maintenanceMargin: parseFloat(entry.totalMaintenanceMargin || '0') || undefined,
              currency: coin.coin,
              timestamp: Date.now(),
            })
          }
        }
      }

      const unified = await this.signedGet<any>('/v5/account/wallet-balance', { accountType: 'UNIFIED' })
        .catch(() => null)
      pushFromWallet(unified, 'unified')

      const contract = await this.signedGet<any>('/v5/account/wallet-balance', { accountType: 'CONTRACT' })
        .catch(() => null)
      pushFromWallet(contract, 'contract')

      return balances
    } catch (error: any) {
      console.error('Failed to get Bybit balances:', error)
      throw new Error(`Failed to get balances: ${error.message}`)
    }
  }

  async getPositions(): Promise<Position[]> {
    try {
      const positions: Position[] = []

      for (const category of ['linear', 'inverse'] as BybitCategory[]) {
        const settleCoins = category === 'linear' ? ['USDT', 'USDC'] : ['BTC', 'ETH']
        for (const settleCoin of settleCoins) {
          const res = await this.signedGet<any>('/v5/position/list', { category, settleCoin })
            .catch(() => null)
          if (!res?.list?.length) continue

          for (const p of res.list) {
            const size = parseFloat(p.size || '0')
            if (size === 0) continue
            positions.push({
              id: `bybit:${category}:${p.symbol}`,
              accountId: category === 'linear' ? 'unified' : 'contract',
              symbol: p.symbol,
              side: p.side === 'Buy' ? 'long' : 'short',
              size: Math.abs(size),
              entryPrice: parseFloat(p.avgPrice || '0'),
              markPrice: parseFloat(p.markPrice || '0'),
              unrealizedPnL: parseFloat(p.unrealisedPnl || '0'),
              marginType: p.tradeMode === 0 ? 'cross' : 'isolated',
              leverage: parseFloat(p.leverage || '1'),
            })
          }
        }
      }

      return positions
    } catch (error: any) {
      console.error('Failed to get Bybit positions:', error)
      throw new Error(`Failed to get positions: ${error.message}`)
    }
  }

  // Public ticker (no auth) — basis-guard price check.
  async getLastPrice(symbol: string): Promise<number | null> {
    try {
      const category = this.resolveCategory(symbol)
      const res = await fetch(
        `${this.baseURL}/v5/market/tickers?category=${category}&symbol=${encodeURIComponent(symbol)}`,
        { signal: timeoutSignal('read') },
      )
      const data = (await res.json()) as BybitResponse<{
        list?: Array<{ markPrice?: string; lastPrice?: string }>
      }>
      const ticker = data?.result?.list?.[0]
      const price = parseFloat(ticker?.markPrice || ticker?.lastPrice || '')
      return Number.isFinite(price) && price > 0 ? price : null
    } catch {
      return null
    }
  }

  async placeOrder(order: Order): Promise<OrderResult> {
    try {
      const category = this.resolveCategory(order.symbol, (order as any).category)
      const side = order.side === 'buy' ? 'Buy' : 'Sell'
      const isStop = order.orderType === 'stop' || order.orderType === 'stopLimit'
      // A stop is a conditional order: the underlying order is Market (stop) or
      // Limit (stopLimit), gated by a triggerPrice. Bybit v5 has no distinct
      // "stop" orderType — it's an ordinary order with trigger fields.
      const orderType =
        order.orderType === 'limit' || order.orderType === 'stopLimit' ? 'Limit' : 'Market'

      const body: Record<string, any> = {
        category,
        symbol: order.symbol,
        side,
        orderType,
        qty: String(order.quantity),
      }

      if (orderType === 'Limit') {
        if (order.price === undefined) {
          throw new Error('Limit orders require a price')
        }
        body.price = String(order.price)
        body.timeInForce = order.timeInForce || 'GTC'
      }

      if (category === 'spot') {
        body.marketUnit = 'baseCoin'
      }

      // ── Conditional / stop trigger (linear & inverse) ──
      if (isStop) {
        const triggerPrice = order.stopPrice ?? order.price
        if (triggerPrice === undefined) {
          throw new Error('Stop orders require a stopPrice')
        }
        if (category === 'spot') {
          throw new Error('Stop orders are only supported for linear/inverse on Bybit')
        }
        body.triggerPrice = String(triggerPrice)
        // triggerDirection: 1 = trigger when price rises to triggerPrice,
        // 2 = when it falls. For a reduce-only protective stop the side encodes
        // the intent: a Sell stop protects a long (trigger on a fall → 2); a Buy
        // stop protects a short (trigger on a rise → 1). An explicit
        // triggerDirection on the order overrides this default.
        body.triggerDirection =
          (order as any).triggerDirection ?? (side === 'Sell' ? 2 : 1)
        body.triggerBy = this.mapTriggerBy(order.triggerType)
      }

      // Reduce-only protective legs must never flip the position.
      if (order.reduceOnly) {
        body.reduceOnly = true
      }

      // Broker-side idempotency: a duplicate submit with the same orderLinkId is
      // rejected by Bybit (max 45 chars, alnum/-/_ only).
      if (order.clientOrderId) {
        body.orderLinkId = order.clientOrderId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 45)
      }

      const result = await this.signedPost<any>('/v5/order/create', body)

      return {
        orderId: result.orderId,
        // A conditional order is pending until its trigger fires; a plain market
        // order is taken as filled (status query confirms the real outcome).
        status: orderType === 'Market' && !isStop ? 'filled' : 'pending',
        filledQuantity: 0,
        averagePrice: 0,
      }
    } catch (error: any) {
      console.error('Failed to place Bybit order:', error)
      throw new Error(`Failed to place order: ${error.message}`)
    }
  }

  private mapTriggerBy(triggerType?: Order['triggerType']): string {
    switch (triggerType) {
      case 'mark_price':
        return 'MarkPrice'
      case 'index_price':
        return 'IndexPrice'
      default:
        return 'LastPrice'
    }
  }

  async cancelOrder(orderId: string, ctx: OrderQueryContext = {}): Promise<void> {
    try {
      // Bybit v5 /order/cancel REQUIRES symbol. placeOrder returns the bare id, so
      // take symbol/category from ctx, then a "<category>:<symbol>:<orderId>"
      // composite id, and finally resolve it from the live order — never send ''.
      let category: BybitCategory =
        (ctx.category as BybitCategory | undefined) ??
        (ctx.symbol ? this.resolveCategory(ctx.symbol) : 'linear')
      let symbol = ctx.symbol ?? ''
      let rawId = orderId
      const parts = orderId.split(':')
      if (parts.length === 3) {
        category = parts[0] as BybitCategory
        symbol = parts[1]
        rawId = parts[2]
      }
      if (!symbol) {
        const st = await this.getOrderStatus(rawId, { category })
        const resolved = (st.raw as any)?.symbol
        if (resolved) {
          symbol = resolved
          category = this.resolveCategory(resolved, (st.raw as any)?.category)
        }
      }
      await this.signedPost('/v5/order/cancel', { category, symbol, orderId: rawId })
    } catch (error: any) {
      console.error('Failed to cancel Bybit order:', error)
      throw new Error(`Failed to cancel order: ${error.message}`)
    }
  }

  subscribeToUpdates(callback: UpdateCallback): void {
    this.updateCallback = callback
  }

  unsubscribeFromUpdates(): void {
    this.updateCallback = undefined
  }

  // Bybit derivatives trade 24/7 → the market-open guard never blocks it.
  alwaysOpen = true

  /**
   * Query an order's current state by id for the settlement poller. Uses
   * /v5/order/realtime which covers open AND recently-closed orders. The
   * category/symbol come from the query context, falling back to symbol
   * inference. Returns 'unknown' when the broker doesn't report the id.
   */
  async getOrderStatus(orderId: string, ctx: OrderQueryContext = {}): Promise<OrderStatus> {
    const category =
      (ctx.category as BybitCategory | undefined) ??
      (ctx.symbol ? this.resolveCategory(ctx.symbol) : 'linear')

    // A "client:<id>" ref queries by orderLinkId — used to resolve orders whose
    // placeOrder call threw before returning a broker id (EX2).
    const clientId = parseClientOrderRef(orderId)

    // Without a symbol, linear needs a settleCoin filter — try both pools
    // (USDT first, then USDC perps) until the id shows up.
    const settleCoins: (string | undefined)[] =
      ctx.symbol || category !== 'linear' ? [undefined] : ['USDT', 'USDC']

    // Distinguish "the venue answered and reports no such order" from "the
    // lookup itself failed" — a failed lookup must never read as venue-confirmed
    // absence (that's how a live order gets auto-rejected as never-placed).
    let lookupSucceeded = false
    for (const settleCoin of settleCoins) {
      const params: Record<string, any> = clientId
        ? { category, orderLinkId: clientId }
        : { category, orderId }
      if (ctx.symbol) params.symbol = ctx.symbol
      else if (settleCoin) params.settleCoin = settleCoin

      try {
        const res = await this.signedGet<any>('/v5/order/realtime', params)
        lookupSucceeded = true
        const order = clientId
          ? res?.list?.find((o: any) => String(o.orderLinkId) === String(clientId))
          : res?.list?.find((o: any) => String(o.orderId) === String(orderId))
        if (!order) continue
        return {
          orderId,
          state: this.mapToStatusState(order.orderStatus),
          filledQuantity: parseFloat(order.cumExecQty || '0') || 0,
          averagePrice: parseFloat(order.avgPrice || '0') || 0,
          commission: parseFloat(order.cumExecFee || '0') || 0,
          raw: order,
        }
      } catch {
        // fall through to the next settle pool
      }
    }
    return { orderId, state: 'unknown', absenceConfirmed: lookupSucceeded }
  }

  // https://bybit-exchange.github.io/docs/v5/enum#orderstatus
  private mapToStatusState(status: string): OrderStatus['state'] {
    switch (status) {
      case 'Filled':
        return 'filled'
      case 'PartiallyFilled':
        return 'partially_filled'
      case 'Cancelled':
      case 'PartiallyFilledCanceled':
      case 'Deactivated':
        return 'cancelled'
      case 'Rejected':
        return 'rejected'
      // New / Untriggered / Triggered / Created → still live at the broker.
      default:
        return 'working'
    }
  }

  // --- internals ---

  private resolveCategory(symbol: string, hint?: string): BybitCategory {
    if (hint === 'linear' || hint === 'inverse' || hint === 'spot') return hint
    const s = symbol.toUpperCase()
    if (s.endsWith('USDT') || s.endsWith('USDC')) return 'linear'
    // USDC-settled perps use the bare PERP suffix (BTCPERP, SOLPERP).
    if (s.endsWith('PERP')) return 'linear'
    if (s.endsWith('USD')) return 'inverse'
    return 'linear'
  }

  private async verifyCredentials(): Promise<void> {
    // /v5/account/info requires private auth, cheap round-trip
    await this.signedGet('/v5/account/info', {})
  }

  private sign(payload: string): { sign: string; timestamp: string; recvWindow: string } {
    if (!this.credentials) throw new Error('Not authenticated')
    const timestamp = Date.now().toString()
    const recvWindow = String(this.credentials.recvWindow ?? DEFAULT_RECV_WINDOW)
    const preSign = timestamp + this.credentials.apiKey + recvWindow + payload
    const sign = crypto
      .createHmac('sha256', this.credentials.apiSecret)
      .update(preSign)
      .digest('hex')
    return { sign, timestamp, recvWindow }
  }

  private authHeaders(signature: string, timestamp: string, recvWindow: string): Record<string, string> {
    return {
      'X-BAPI-API-KEY': this.credentials!.apiKey,
      'X-BAPI-SIGN': signature,
      'X-BAPI-SIGN-TYPE': '2',
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-RECV-WINDOW': recvWindow,
    }
  }

  private async signedGet<T = any>(path: string, params: Record<string, any>): Promise<T> {
    if (!this.credentials) throw new Error('Not authenticated')
    const queryString = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join('&')

    const { sign, timestamp, recvWindow } = this.sign(queryString)
    const url = `${this.baseURL}${path}${queryString ? `?${queryString}` : ''}`

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        ...this.authHeaders(sign, timestamp, recvWindow),
        'Content-Type': 'application/json',
      },
      signal: timeoutSignal('read'),
    })

    const data = (await res.json()) as BybitResponse<T>
    if (!res.ok || data.retCode !== 0) {
      throw new Error(data.retMsg || `Bybit GET ${path} failed: ${res.status}`)
    }
    return data.result
  }

  private async signedPost<T = any>(
    path: string,
    body: Record<string, any>,
    // POSTs here are order mutations (create/cancel) → order-op timeout.
    timeout: FetchTimeoutKind = 'order',
  ): Promise<T> {
    if (!this.credentials) throw new Error('Not authenticated')
    const payload = JSON.stringify(body)
    const { sign, timestamp, recvWindow } = this.sign(payload)
    const url = `${this.baseURL}${path}`

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...this.authHeaders(sign, timestamp, recvWindow),
        'Content-Type': 'application/json',
      },
      body: payload,
      signal: timeoutSignal(timeout),
    })

    const data = (await res.json()) as BybitResponse<T>
    if (!res.ok || data.retCode !== 0) {
      throw new Error(data.retMsg || `Bybit POST ${path} failed: ${res.status}`)
    }
    return data.result
  }

  private async connectWebSocket(): Promise<void> {
    if (!this.credentials) throw new Error('Not authenticated')

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsURL)
      this.ws = ws

      const settleTimer = setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          reject(new Error('Bybit WebSocket timeout'))
        }
      }, 10000)

      ws.on('open', () => {
        try {
          const expires = Date.now() + 10000
          const signPayload = `GET/realtime${expires}`
          const signature = crypto
            .createHmac('sha256', this.credentials!.apiSecret)
            .update(signPayload)
            .digest('hex')

          ws.send(JSON.stringify({
            op: 'auth',
            args: [this.credentials!.apiKey, expires, signature],
          }))
        } catch (e) {
          reject(e)
        }
      })

      ws.on('message', (raw) => {
        let msg: any
        try {
          msg = JSON.parse(raw.toString())
        } catch {
          return
        }

        if (msg.op === 'auth') {
          clearTimeout(settleTimer)
          if (msg.success) {
            this.wsAuthenticated = true
            ws.send(JSON.stringify({
              op: 'subscribe',
              args: ['wallet', 'position', 'order', 'execution'],
            }))
            this.startPingInterval()
            if (this.updateCallback) {
              this.updateCallback({
                type: 'account',
                data: { connected: true },
              })
            }
            resolve()
          } else {
            reject(new Error(msg.ret_msg || 'Bybit WebSocket auth failed'))
          }
          return
        }

        if (msg.topic && this.updateCallback) {
          if (msg.topic === 'wallet') {
            this.updateCallback({ type: 'balance', data: msg.data })
          } else if (msg.topic === 'position') {
            this.updateCallback({ type: 'position', data: msg.data })
          } else if (msg.topic === 'order' || msg.topic === 'execution') {
            this.updateCallback({ type: 'order', data: msg.data })
          }
        }
      })

      ws.on('error', (err) => {
        console.error('Bybit WebSocket error:', err?.message || err)
        if (this.updateCallback) {
          this.updateCallback({
            type: 'account',
            data: { connected: false, error: 'WebSocket error' },
          })
        }
      })

      ws.on('close', () => {
        this.wsAuthenticated = false
        if (this.pingInterval) {
          clearInterval(this.pingInterval)
          this.pingInterval = undefined
        }
        this.scheduleReconnect()
      })
    })
  }

  private startPingInterval(): void {
    if (this.pingInterval) clearInterval(this.pingInterval)
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ op: 'ping' }))
      }
    }, 20000)
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout) return
    this.reconnectTimeout = setTimeout(async () => {
      this.reconnectTimeout = undefined
      if (!this.credentials) return
      try {
        await this.connectWebSocket()
      } catch (err) {
        console.error('Bybit WS reconnect failed:', err)
        this.scheduleReconnect()
      }
    }, 5000)
  }
}

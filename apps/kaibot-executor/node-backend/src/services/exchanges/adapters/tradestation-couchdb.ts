// TradeStation adapter that reads its session from the legacy KaiBotWeb CouchDB.
// Voorlopig pad: legacy kaibotweb blijft eigenaar van de OAuth flow + token refresh,
// wij consumeren enkel de access_token. CouchDB raakt nooit aan trading endpoints —
// die werken identiek aan tradestation-oauth.ts via Bearer auth.

import { timeoutSignal } from '../fetch-timeout.js'
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
  MarketStatus,
  UpdateCallback,
} from '../types.js'
import { type QuoteLike } from '../futures-contracts.js'
import { TS_TERMINAL, lookupTradeStationOrderStatus, resolveTradeStationTif } from './tradestation-orders.js'
import { TradeStationQuoteService } from './tradestation-quotes.js'

interface TradeStationSession {
  access_token: string
  userid?: string
}

interface CouchConfig {
  url: string
  authHeader: string | null
  sessionDocId: string
}

// TradeStation's REST API is rate-limited (~40 req/min). The ExchangeDetailPage
// polls every 1s and fans out into 3 adapter calls, which cascade into 5 TS
// calls. Short TTL cache keeps us well under the limit while still feeling live.
const CACHE_TTL_MS = 2_500

export class TradeStationCouchDBAdapter implements ExchangeAdapter {
  name = 'tradestation'
  private baseURL: string
  private couch: CouchConfig | null = null
  private session: TradeStationSession | null = null
  private updateCallback?: UpdateCallback
  private cache = new Map<string, { data: any; expires: number }>()
  private pending = new Map<string, Promise<any>>()
  // Throttle-proof quotes/market-status + front-month resolution (TTL +
  // stale-fallback + in-flight dedup + slot-reserved scans).
  private quotes = new TradeStationQuoteService((s) => this.quoteFutures(s))

  constructor() {
    const testnet = process.env.TS_TESTNET === 'true'
    this.baseURL = testnet ? 'https://sim-api.tradestation.com' : 'https://api.tradestation.com'
  }

  // ─── Futures front-month resolution ──────────────────────────────────────────

  private async quoteFutures(symbols: string[]): Promise<QuoteLike[]> {
    const data = await this.call(`/v3/marketdata/quotes/${symbols.join(',')}`)
    return (data.Quotes || []) as QuoteLike[]
  }

  /**
   * Resolve a futures ROOT (MES, MNQ, ...) to the front-month dated contract by
   * volume. A symbol that is already dated, or any non-futures symbol, passes
   * through unchanged. Public so the signal pipeline can resolve the order
   * symbol once and reuse it for the bracket legs and the local record. Routed
   * through the slot-reserved front-month cache so concurrent scans don't burst.
   */
  async resolveSymbol(symbol: string): Promise<string> {
    return this.quotes.resolveSymbol(symbol)
  }

  private async cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key)
    if (hit && hit.expires > Date.now()) return hit.data as T

    const inflight = this.pending.get(key)
    if (inflight) return inflight as Promise<T>

    const p = (async () => {
      try {
        const data = await fn()
        this.cache.set(key, { data, expires: Date.now() + CACHE_TTL_MS })
        return data
      } finally {
        this.pending.delete(key)
      }
    })()
    this.pending.set(key, p)
    return p
  }

  private clearCache(): void {
    this.cache.clear()
    this.pending.clear()
  }

  private async getAccountsRaw(): Promise<any> {
    return this.cached('accounts', () => this.call('/v3/brokerage/accounts'))
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  async connect(_credentials: ExchangeCredentials): Promise<void> {
    // _credentials is intentionally ignored — config comes from env vars so the
    // ExchangeManager can call this without user-supplied secrets.
    this.couch = this.loadCouchConfig()
    await this.fetchSession()
    this.updateCallback?.({
      type: 'account',
      data: { connected: true, source: 'couchdb' },
    })
  }

  async disconnect(): Promise<void> {
    this.session = null
    this.couch = null
    this.clearCache()
    this.quotes.clear()
  }

  async refreshSession(): Promise<void> {
    // Legacy kaibotweb is the authoritative refresher — we just re-read.
    await this.fetchSession()
  }

  // ─── CouchDB session reader ─────────────────────────────────────────────────

  private loadCouchConfig(): CouchConfig {
    const baseUrl = process.env.COUCHDB_URL
    const sessionDocId = process.env.COUCHDB_TS_SESSION_ID
    const dbName = process.env.COUCHDB_SESSION_DB || 'user-sessions'

    if (!baseUrl) throw new Error('COUCHDB_URL not configured')
    if (!sessionDocId) throw new Error('COUCHDB_TS_SESSION_ID not configured')

    // Bun/Node fetch reject URL-embedded basic auth → strip into Authorization header.
    const parsed = new URL(baseUrl)
    let authHeader: string | null = null
    if (parsed.username || parsed.password) {
      const user = decodeURIComponent(parsed.username)
      const pass = decodeURIComponent(parsed.password)
      authHeader = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
      parsed.username = ''
      parsed.password = ''
    }

    const url = `${parsed.toString().replace(/\/$/, '')}/${dbName}`
    return { url, authHeader, sessionDocId }
  }

  private async fetchSession(): Promise<TradeStationSession> {
    if (!this.couch) throw new Error('CouchDB config not loaded')

    const headers: Record<string, string> = {}
    if (this.couch.authHeader) headers.Authorization = this.couch.authHeader

    const res = await fetch(`${this.couch.url}/${this.couch.sessionDocId}`, {
      headers,
      signal: timeoutSignal('auth'),
    })
    if (!res.ok) {
      throw new Error(`TradeStation session not available in CouchDB (${res.status})`)
    }

    const doc = (await res.json()) as any
    if (!doc.access_token) {
      throw new Error('CouchDB session document missing access_token')
    }

    this.session = { access_token: doc.access_token, userid: doc.userid }
    return this.session
  }

  private async ensureSession(): Promise<TradeStationSession> {
    if (this.session) return this.session
    return this.fetchSession()
  }

  // ─── TradeStation REST ──────────────────────────────────────────────────────

  private async call(
    endpoint: string,
    method: 'GET' | 'POST' | 'DELETE' = 'GET',
    body?: any,
    // Whether a 401 may re-send the request after re-reading the token.
    // SAFE for idempotent reads/cancels. NOT safe for an order-placing POST: a
    // blind re-send can double-place the order. Order placement passes false and
    // must instead verify via the broker order history what (if anything) was
    // accepted. Mirrors kaibot-exec ts-session retry401:false on order POSTs.
    retry401Resend: boolean = method !== 'POST',
  ): Promise<any> {
    const session = await this.ensureSession()

    const doFetch = (token: string) => {
      const options: RequestInit = {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        // Mutations (order POST/DELETE) get the longer order budget; reads fail fast.
        signal: timeoutSignal(method === 'GET' ? 'read' : 'order'),
      }
      if (body) options.body = JSON.stringify(body)
      return fetch(`${this.baseURL}${endpoint}`, options)
    }

    let response = await doFetch(session.access_token)

    // On 401, re-read the (possibly rotated) session token from CouchDB. Only
    // re-send the request when it's safe to do so — never for an order POST.
    if (response.status === 401) {
      this.session = null
      const fresh = await this.ensureSession()
      if (retry401Resend) {
        response = await doFetch(fresh.access_token)
      }
    }

    const data = await response.json()
    if (!response.ok) {
      throw new Error((data as any).Message || `API request failed: ${response.status}`)
    }
    return data
  }

  async getAccounts(): Promise<Account[]> {
    try {
      const data = await this.getAccountsRaw()
      const accounts = data.Accounts || []

      return accounts.map((acc: any) => ({
        id: `tradestation:${acc.AccountID}`,
        exchangeName: this.name,
        accountId: acc.AccountID,
        accountType: acc.AccountType,
        name: acc.Name || acc.AccountID,
        currency: acc.Currency || 'USD',
      }))
    } catch (error: any) {
      console.error('Failed to get TradeStation accounts:', error)
      throw new Error(`Failed to get accounts: ${error.message}`)
    }
  }

  async getBalances(): Promise<Balance[]> {
    try {
      const accountsData = await this.getAccountsRaw()
      const accounts = accountsData.Accounts || []
      const accountIds = accounts.map((acc: any) => acc.AccountID).join(',')

      if (!accountIds) return []

      const balancesData = await this.cached(`balances:${accountIds}`, () =>
        this.call(`/v3/brokerage/accounts/${accountIds}/balances`),
      )
      const balances = balancesData.Balances || []

      // TradeStation returns numeric fields as strings. Coerce everything.
      const num = (v: any) => {
        const n = parseFloat(v)
        return Number.isFinite(n) ? n : 0
      }

      return balances.map((bal: any) => ({
        accountId: bal.AccountID,
        balance: num(bal.AccountBalance ?? bal.CashBalance),
        equity: num(bal.Equity),
        realizedPnL: num(bal.BalanceDetail?.RealizedProfitLoss ?? bal.RealizedProfitLoss),
        unrealizedPnL: num(bal.BalanceDetail?.UnrealizedProfitLoss ?? bal.UnrealizedProfitLoss),
        initialMargin: num(bal.InitialMargin ?? bal.InitialMarginRequirement),
        maintenanceMargin: num(bal.MaintenanceMargin ?? bal.MaintenanceMarginRequirement),
        currency: bal.Currency || 'USD',
        timestamp: Date.now(),
      }))
    } catch (error: any) {
      console.error('Failed to get TradeStation balances:', error)
      throw new Error(`Failed to get balances: ${error.message}`)
    }
  }

  async getPositions(): Promise<Position[]> {
    try {
      const accountsData = await this.getAccountsRaw()
      const accounts = accountsData.Accounts || []
      const accountIds = accounts.map((acc: any) => acc.AccountID).join(',')

      if (!accountIds) return []

      const data = await this.cached(`positions:${accountIds}`, () =>
        this.call(`/v3/brokerage/accounts/${accountIds}/positions`),
      )
      const positions = data.Positions || []

      const num = (v: any) => {
        const n = parseFloat(v)
        return Number.isFinite(n) ? n : 0
      }

      return positions.map((pos: any) => {
        const qty = num(pos.Quantity)
        const longShort = (pos.LongShort as string | undefined)?.toLowerCase()
        return {
          id: `tradestation:${pos.PositionID}`,
          accountId: pos.AccountID,
          symbol: pos.Symbol,
          side: longShort === 'long' || qty > 0 ? 'long' : 'short',
          size: Math.abs(qty),
          entryPrice: num(pos.AveragePrice),
          markPrice: num(pos.Last),
          unrealizedPnL: num(pos.UnrealizedProfitLoss),
          marginType: 'cross',
          leverage: 1,
        }
      })
    } catch (error: any) {
      console.error('Failed to get TradeStation positions:', error)
      throw new Error(`Failed to get positions: ${error.message}`)
    }
  }

  async placeOrder(order: Order): Promise<OrderResult> {
    try {
      // Resolve a bare futures root to its front-month dated contract before
      // sending — TradeStation orders require the dated symbol.
      const symbol = await this.resolveSymbol(order.symbol)
      const tradeStationOrder = {
        AccountID: order.accountId,
        Symbol: symbol,
        Quantity: order.quantity.toString(),
        OrderType: this.mapOrderType(order.orderType),
        TradeAction: order.side.toUpperCase(),
        // Protective legs go GTC so they survive session close (see
        // resolveTradeStationTif). NOTE: order.reduceOnly is NOT forwarded —
        // TradeStation futures orders have no native reduce-only flag, so a
        // stop that triggers after the position is already flat would OPEN a
        // reverse position. The executor's exchange-agnostic OCO tracker
        // (signal-client cancel-on-fill) is what guarantees single-close by
        // cancelling the sibling leg on fill. Broker-native OSO/OCO brackets
        // would enforce this at the venue but need a deeper redesign of the
        // entry+bracket submit flow.
        // v3 expects TimeInForce as an object: { Duration: "DAY" | "GTC" }.
        TimeInForce: { Duration: resolveTradeStationTif(order) },
        LimitPrice: order.price?.toString(),
        StopPrice: order.stopPrice?.toString(),
      }

      // retry401Resend = false: a 401 here re-reads the token but must NOT
      // re-send the POST — a blind re-send risks placing the order twice.
      const result = await this.call('/v3/orderexecution/orders', 'POST', tradeStationOrder, false)
      const orderResult = result.Orders?.[0] || result

      return {
        orderId: orderResult.OrderID,
        status: this.mapOrderStatus(orderResult.Status),
        filledQuantity: orderResult.FilledQuantity || 0,
        averagePrice: orderResult.AverageFilledPrice || 0,
        message: orderResult.Message,
      }
    } catch (error: any) {
      console.error('Failed to place TradeStation order:', error)
      throw new Error(`Failed to place order: ${error.message}`)
    }
  }

  async cancelOrder(orderId: string): Promise<void> {
    try {
      await this.call(`/v3/orderexecution/orders/${orderId}`, 'DELETE')
    } catch (error: any) {
      console.error('Failed to cancel TradeStation order:', error)
      throw new Error(`Failed to cancel order: ${error.message}`)
    }
  }

  // Futures sessions are NOT 24/7 — the market-open guard applies here.
  alwaysOpen = false

  /**
   * Look up an order by id for the settlement poller / reconciler. Working
   * /orders endpoint first, /historicalorders as a fallback — see
   * lookupTradeStationOrderStatus.
   */
  async getOrderStatus(orderId: string, ctx: OrderQueryContext = {}): Promise<OrderStatus> {
    const account = ctx.accountId
    if (!account) {
      // Without an account we can't address the orders endpoint.
      return { orderId, state: 'unknown' }
    }
    return lookupTradeStationOrderStatus((endpoint) => this.call(endpoint), account, orderId)
  }

  /**
   * Per-symbol last price + last trade time, for the market-open guard. A
   * front-month future trades every few seconds when open, so a stale TradeTime
   * means the session is closed/halted. Served through the shared cache (TTL +
   * stale-fallback + in-flight dedup); a genuine throttle past the stale window
   * surfaces as a throw so the market-guard fails closed.
   */
  async getMarketStatus(symbols: string[]): Promise<Map<string, MarketStatus>> {
    return this.quotes.getMarketStatus(symbols)
  }

  subscribeToUpdates(callback: UpdateCallback): void {
    this.updateCallback = callback
  }

  unsubscribeFromUpdates(): void {
    this.updateCallback = undefined
  }

  /**
   * Working (non-terminal) orders across all accounts, optionally limited to a
   * set of symbols. Used by the reconciler to block a correction while an order
   * is in flight and to flag working orders it didn't place. Returns the broker
   * order id, its symbol, and the account it belongs to.
   */
  async listWorkingOrders(
    symbols?: string[],
  ): Promise<Array<{ orderId: string; symbol: string; accountId: string }>> {
    const accountsData = await this.getAccountsRaw()
    const accounts = accountsData.Accounts || []
    const accountIds = accounts.map((acc: any) => acc.AccountID).join(',')
    if (!accountIds) return []

    const data = await this.call(`/v3/brokerage/accounts/${accountIds}/orders`)
    const wanted = symbols && symbols.length > 0 ? new Set(symbols) : null
    const out: Array<{ orderId: string; symbol: string; accountId: string }> = []
    for (const o of data.Orders || []) {
      if (TS_TERMINAL.has(o.Status)) continue
      const symbol = o.Legs?.[0]?.Symbol
      if (!symbol) continue
      if (wanted && !wanted.has(symbol)) continue
      out.push({ orderId: String(o.OrderID), symbol, accountId: o.AccountID })
    }
    return out
  }

  // ─── Mappers ────────────────────────────────────────────────────────────────

  private mapOrderType(orderType: Order['orderType']): string {
    const mapping: Record<Order['orderType'], string> = {
      market: 'Market',
      limit: 'Limit',
      stop: 'StopMarket',
      stopLimit: 'StopLimit',
    }
    return mapping[orderType] || 'Market'
  }

  private mapOrderStatus(status: string): OrderResult['status'] {
    const statusMap: Record<string, OrderResult['status']> = {
      ACK: 'pending',
      // DON (done-for-day): killed at session end without filling → cancelled so
      // the order is retried, not booked as a phantom fill (ref kaibot-exec cebd203).
      DON: 'cancelled',
      FLL: 'filled',
      FLP: 'partially_filled',
      FPR: 'partially_filled',
      OUT: 'cancelled',
      REJ: 'rejected',
      CAN: 'cancelled',
      EXP: 'cancelled',
    }
    return statusMap[status] || 'pending'
  }
}

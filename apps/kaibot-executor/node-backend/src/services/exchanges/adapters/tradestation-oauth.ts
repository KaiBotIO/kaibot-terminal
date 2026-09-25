// Using fetch instead of axios for Bun compatibility
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
  FillFee,
} from '../types.js'
import { EXCHANGE_CONSTRAINTS } from '../constraints.js'
import { type QuoteLike } from '../futures-contracts.js'
import {
  TradeStationHistoryCache,
  lookupTradeStationOrderFee,
  lookupTradeStationOrderStatus,
  resolveTradeStationTif,
  tsPriceString,
} from './tradestation-orders.js'
import { TradeStationQuoteService } from './tradestation-quotes.js'
import { EventEmitter } from 'events'

// v3 returns every numeric field as a string.
const tsNum = (v: any): number => {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : 0
}

interface TradeStationOAuthCredentials extends ExchangeCredentials {
  type: 'oauth'
  apiKey: string
  apiSecret: string
  redirectUri?: string
  // Present only on a boot-time RESTORE: a previously obtained offline_access
  // refresh token. When set, connect() re-establishes the session silently
  // instead of starting an interactive authorize redirect.
  refreshToken?: string
}

interface TradeStationSession {
  access_token: string
  refresh_token?: string
  token_type: string
  expires_in: number
  timestamp: number
  userid?: string
}

export class TradeStationOAuthAdapter extends EventEmitter implements ExchangeAdapter {
  name = 'tradestation'
  private baseURL = 'https://api.tradestation.com'
  private session?: TradeStationSession
  private updateCallback?: UpdateCallback
  private credentials?: TradeStationOAuthCredentials
  private refreshTimer?: NodeJS.Timeout
  private authorizationCode?: string
  private authUrl?: string
  private lock = false
  private callbackUrl: string
  // Throttle-proof quotes/market-status + front-month resolution (TTL +
  // stale-fallback + in-flight dedup + slot-reserved scans).
  private quotes = new TradeStationQuoteService((s) => this.quoteFutures(s))

  constructor() {
    super()
    // Use the same port as the backend server
    const isDesktop = process.env.TAURI === '1'
    const port = isDesktop ? 9100 : parseInt(process.env.PORT || '8080')
    this.callbackUrl = `http://localhost:${port}/api/exchanges/v2/callback/tradestation`
  }

  async connect(credentials: ExchangeCredentials, state?: string): Promise<void> {
    if (credentials.type !== 'oauth') {
      throw new Error('TradeStation requires OAuth authentication')
    }
    this.credentials = credentials as TradeStationOAuthCredentials

    // RESTORE path: a stored offline_access refresh token lets us re-establish
    // the session silently (no user redirect). Used by the boot-time restore so
    // the refresh timer takes over from a previous run's authorization.
    if (this.credentials.refreshToken) {
      this.session = {
        access_token: '',
        refresh_token: this.credentials.refreshToken,
        token_type: 'Bearer',
        expires_in: 0,
        timestamp: 0,
      }
      await this.refreshSession()
      return
    }

    // Interactive START: no token yet — produce the authorize URL and signal the
    // exchange manager to keep the adapter as pending_oauth until the callback.
    this.authUrl = this.generateAuthorizationUrl(state)
    this.emit('oauth:redirect', { url: this.authUrl })
    throw new Error('OAUTH_REDIRECT_REQUIRED')
  }

  private generateAuthorizationUrl(state?: string): string {
    if (!this.credentials) {
      throw new Error('No credentials available')
    }

    const params = new URLSearchParams({
      redirect_uri: this.credentials.redirectUri || this.callbackUrl,
      client_id: this.credentials.apiKey,
      response_type: 'code',
      audience: 'https://api.tradestation.com',
      scope: 'openid offline_access profile MarketData ReadAccount Trade',
    })

    if (state) {
      params.set('state', state)
    }

    return `https://signin.tradestation.com/authorize/?${params.toString()}`
  }

  getAuthorizationUrl(): string {
    if (!this.authUrl) {
      throw new Error('Authorization URL not generated yet')
    }
    return this.authUrl
  }

  async handleAuthorizationCallback(code: string): Promise<void> {
    if (!this.credentials) {
      throw new Error('No credentials available')
    }

    this.authorizationCode = code
    await this.exchangeCodeForToken()
  }

  private async exchangeCodeForToken(): Promise<void> {
    if (!this.credentials || !this.authorizationCode) {
      throw new Error('Missing credentials or authorization code')
    }

    try {
      const params = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: this.credentials.apiKey,
        redirect_uri: this.credentials.redirectUri || this.callbackUrl,
        code: this.authorizationCode,
        client_secret: this.credentials.apiSecret,
      })

      const response = await fetch(`${this.baseURL}/v2/Security/Authorize`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
        signal: timeoutSignal('auth'),
      })

      if (!response.ok) {
        const error = await response.json() as any
        throw new Error(error.Message || `Token exchange failed: ${response.status}`)
      }

      const data = await response.json() as any

      this.session = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        token_type: data.token_type,
        expires_in: data.expires_in,
        timestamp: Date.now(),
        userid: data.userid,
      }

      this.scheduleTokenRefresh()

      if (this.updateCallback) {
        this.updateCallback({
          type: 'account',
          data: { connected: true, sessionExpiry: this.getSessionExpiry() }
        })
      }
    } catch (error: any) {
      console.error('TradeStation token exchange failed:', error)
      throw new Error(`Token exchange failed: ${error.message}`)
    }
  }

  async disconnect(): Promise<void> {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = undefined
    }
    this.session = undefined
    this.credentials = undefined
    this.authorizationCode = undefined
    this.quotes.clear()
  }

  // ─── Futures front-month resolution ──────────────────────────────────────────

  private async quoteFutures(symbols: string[]): Promise<QuoteLike[]> {
    const data = await this.call(`/v3/marketdata/quotes/${symbols.join(',')}`)
    return (data.Quotes || []) as QuoteLike[]
  }

  /** Resolve a futures ROOT to its front-month dated contract (see CouchDB adapter). */
  async resolveSymbol(symbol: string): Promise<string> {
    return this.quotes.resolveSymbol(symbol)
  }

  // Futures sessions are NOT 24/7 — the market-open guard applies here.
  alwaysOpen = false

  /**
   * Per-symbol last price + last trade time, for the market-open guard. Served
   * through the shared cache (TTL + stale-fallback + in-flight dedup); a genuine
   * throttle past the stale window throws so the market-guard fails closed.
   */
  async getMarketStatus(symbols: string[]): Promise<Map<string, MarketStatus>> {
    return this.quotes.getMarketStatus(symbols)
  }

  // Credentials persisted (encrypted) after a successful authorization so a
  // restart can restore the session without a new redirect. The refresh_token
  // (offline_access) is the load-bearing field — connect() uses it to refresh.
  getStorableCredentials(): Record<string, any> | undefined {
    if (!this.credentials) return undefined
    return {
      type: 'oauth',
      apiKey: this.credentials.apiKey,
      apiSecret: this.credentials.apiSecret,
      redirectUri: this.credentials.redirectUri,
      refreshToken: this.session?.refresh_token,
    }
  }

  async refreshSession(): Promise<void> {
    if (!this.credentials || !this.session?.refresh_token) {
      throw new Error('No refresh token available')
    }

    try {
      const params = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.credentials.apiKey,
        refresh_token: this.session.refresh_token,
        client_secret: this.credentials.apiSecret,
        response_type: 'token',
      })

      const response = await fetch(`${this.baseURL}/v2/Security/Authorize`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
        signal: timeoutSignal('auth'),
      })

      if (!response.ok) {
        const error = await response.json() as any
        throw new Error(error.Message || `Token refresh failed: ${response.status}`)
      }

      const data = await response.json() as any

      this.session = {
        ...this.session,
        access_token: data.access_token,
        expires_in: data.expires_in,
        timestamp: Date.now(),
      }

      this.scheduleTokenRefresh()

      if (this.updateCallback) {
        this.updateCallback({
          type: 'account',
          data: { connected: true, sessionExpiry: this.getSessionExpiry() }
        })
      }
    } catch (error: any) {
      console.error('TradeStation refresh failed:', error)
      throw new Error(`Token refresh failed: ${error.message}`)
    }
  }

  private scheduleTokenRefresh(): void {
    if (!this.session) return

    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
    }

    const refreshTime = EXCHANGE_CONSTRAINTS.tradestation.sessionRefreshTime
    const timeUntilRefresh = (this.session.expires_in * 1000) - refreshTime

    this.refreshTimer = setTimeout(async () => {
      try {
        await this.refreshSession()
      } catch (error) {
        console.error('Failed to refresh TradeStation session:', error)
        if (this.updateCallback) {
          this.updateCallback({
            type: 'account',
            data: { connected: false, error: 'Session refresh failed' }
          })
        }
      }
    }, timeUntilRefresh)
  }

  private async call(
    endpoint: string,
    method: 'GET' | 'POST' | 'DELETE' = 'GET',
    body?: any,
    // Whether a 401 may re-send the request after refreshing the token. SAFE for
    // idempotent reads/cancels. NOT safe for an order-placing POST: the order may
    // already have been accepted server-side before the auth check, so a blind
    // re-send risks a DUPLICATE order. Order placement passes false — the token
    // is still refreshed (so the NEXT call works) but the POST is discarded and a
    // clear error surfaces. Mirrors kaibot-exec ts-session retry401:false.
    retry401Resend: boolean = method !== 'POST',
  ): Promise<any> {
    const waitForUnlock = async () => {
      while (this.lock) {
        console.log('Waiting for token refresh...', endpoint)
        await new Promise(resolve => setTimeout(resolve, 1500))
      }
    }

    await waitForUnlock()

    if (!this.session) {
      throw new Error('Not authenticated')
    }

    const doFetch = (): Promise<Response> => {
      const options: RequestInit = {
        method,
        headers: {
          'Authorization': `${this.session!.token_type} ${this.session!.access_token}`,
          'Content-Type': 'application/json',
        },
        // Mutations (order POST/DELETE) get the longer order budget; reads fail fast.
        signal: timeoutSignal(method === 'GET' ? 'read' : 'order'),
      }
      if (body) {
        options.body = JSON.stringify(body)
      }
      return fetch(`${this.baseURL}${endpoint}`, options)
    }

    try {
      let response = await doFetch()

      // On 401, refresh the (expired/rotated) token. Only re-send the request
      // when it's safe — never for an order POST (double-place risk).
      if (response.status === 401) {
        await this.refreshSession()
        if (retry401Resend) {
          response = await doFetch()
        } else {
          throw new Error(
            `Order POST returned 401 (auth expired); token refreshed but the request was NOT resent to avoid a duplicate order. Re-check order status before retrying.`,
          )
        }
      }

      const data = await response.json() as any

      if (!response.ok) {
        console.error('TradeStation API error:', data)
        throw new Error(data.Message || `API request failed: ${response.status}`)
      }

      return data
    } catch (error: any) {
      console.error(`Error calling ${endpoint}:`, error)
      throw error
    }
  }

  private getSessionExpiry(): number {
    if (!this.session) return 0
    return this.session.timestamp + (this.session.expires_in * 1000)
  }

  async getAccounts(): Promise<Account[]> {
    try {
      const data = await this.call('/v3/brokerage/accounts')
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
      const accountsData = await this.call('/v3/brokerage/accounts')
      const accounts = accountsData.Accounts || []
      const accountIds = accounts.map((acc: any) => acc.AccountID).join(',')

      if (!accountIds) {
        return []
      }

      const balancesData = await this.call(`/v3/brokerage/accounts/${accountIds}/balances`)
      const balances = balancesData.Balances || []

      // Same v3 payload as the CouchDB adapter: numeric fields arrive as
      // strings and margin/PnL live nested under BalanceDetail.
      return balances.map((bal: any) => ({
        accountId: bal.AccountID,
        balance: tsNum(bal.AccountBalance ?? bal.CashBalance),
        equity: tsNum(bal.Equity),
        realizedPnL: tsNum(bal.BalanceDetail?.RealizedProfitLoss ?? bal.RealizedProfitLoss),
        unrealizedPnL: tsNum(bal.BalanceDetail?.UnrealizedProfitLoss ?? bal.UnrealizedProfitLoss),
        initialMargin: tsNum(bal.BalanceDetail?.InitialMargin ?? bal.InitialMargin ?? bal.InitialMarginRequirement),
        maintenanceMargin: tsNum(bal.BalanceDetail?.MaintenanceMargin ?? bal.MaintenanceMargin ?? bal.MaintenanceMarginRequirement),
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
      const accountsData = await this.call('/v3/brokerage/accounts')
      const accounts = accountsData.Accounts || []
      const accountIds = accounts.map((acc: any) => acc.AccountID).join(',')

      if (!accountIds) return []

      const data = await this.call(`/v3/brokerage/accounts/${accountIds}/positions`)
      const positions = data.Positions || []

      return positions.map((pos: any) => {
        const qty = tsNum(pos.Quantity)
        const longShort = (pos.LongShort as string | undefined)?.toLowerCase()
        // Real futures leverage = notional / initial requirement; a hardcoded 1
        // makes the breathing-room guard read full notional as margin.
        const marketValue = tsNum(pos.MarketValue)
        const initialReq = tsNum(pos.InitialRequirement)
        return {
          id: `tradestation:${pos.PositionID}`,
          accountId: pos.AccountID,
          symbol: pos.Symbol,
          side: longShort === 'long' || qty > 0 ? 'long' : 'short',
          size: Math.abs(qty),
          entryPrice: tsNum(pos.AveragePrice),
          markPrice: tsNum(pos.Last),
          unrealizedPnL: tsNum(pos.UnrealizedProfitLoss),
          marginType: 'cross' as const,
          leverage: initialReq > 0 && marketValue > 0 ? marketValue / initialReq : 1,
        }
      })
    } catch (error: any) {
      console.error('Failed to get TradeStation positions:', error)
      throw new Error(`Failed to get positions: ${error.message}`)
    }
  }

  async placeOrder(order: Order): Promise<OrderResult> {
    try {
      // Resolve a bare futures root to its front-month dated contract before sending.
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
        LimitPrice: tsPriceString(order.price),
        StopPrice: tsPriceString(order.stopPrice),
      }

      // retry401Resend = false: a 401 here refreshes the token but must NOT
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
      await this.call(`/v3/brokerage/orders/${orderId}`, 'DELETE')
    } catch (error: any) {
      console.error('Failed to cancel TradeStation order:', error)
      throw new Error(`Failed to cancel order: ${error.message}`)
    }
  }

  /**
   * Look up an order by id for the settlement poller / reconciler. Working
   * /orders endpoint first, /historicalorders as a fallback — so a timed-out
   * entry that already left the working set (e.g. filled late) is still found
   * and retroactively settled instead of being orphaned. Shared with the
   * CouchDB adapter via lookupTradeStationOrderStatus.
   */
  async getOrderStatus(orderId: string, ctx: OrderQueryContext = {}): Promise<OrderStatus> {
    const account = ctx.accountId
    if (!account) {
      // Without an account we can't address the orders endpoint.
      return { orderId, state: 'unknown' }
    }
    return lookupTradeStationOrderStatus((endpoint) => this.call(endpoint), account, orderId)
  }

  // Fee of one order for the commission backfill: recent orders through the
  // status lookup, older ones from the account's /historicalorders window
  // starting at ctx.sinceMs (venue cap 90 days). One history fetch per
  // account while the cache is fresh.
  private historyCache = new TradeStationHistoryCache()
  async getOrderFee(orderId: string, ctx: OrderQueryContext = {}): Promise<FillFee | null> {
    const account = ctx.accountId
    if (!account) return null
    return lookupTradeStationOrderFee((endpoint) => this.call(endpoint), account, orderId, {
      sinceMs: ctx.sinceMs,
      history: this.historyCache,
    })
  }

  subscribeToUpdates(callback: UpdateCallback): void {
    this.updateCallback = callback
  }

  unsubscribeFromUpdates(): void {
    this.updateCallback = undefined
  }

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
      'ACK': 'pending',
      // DON (done-for-day): killed at session end without filling → cancelled so
      // the order is retried, not booked as a phantom fill (ref kaibot-exec cebd203).
      'DON': 'cancelled',
      'FLL': 'filled',
      'FLP': 'partially_filled',
      'FPR': 'partially_filled',
      'OUT': 'cancelled',
      'REJ': 'rejected',
      'CAN': 'cancelled',
      'EXP': 'cancelled',
    }
    return statusMap[status] || 'pending'
  }
}
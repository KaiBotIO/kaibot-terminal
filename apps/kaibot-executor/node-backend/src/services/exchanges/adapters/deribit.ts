// Using fetch instead of axios for Bun compatibility
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
  MarketTicker,
  UpdateCallback,
  OpenOrder,
  FillFee,
} from '../types.js'
import { EXCHANGE_CONSTRAINTS } from '../constraints.js'
import { deribitFeeCurrency, feeToUsd } from '../fee-usd.js'

interface DeribitCredentials extends ExchangeCredentials {
  type: 'apiKey'
  apiKey: string
  apiSecret: string
  testnet?: boolean
}

interface DeribitAuthResponse {
  access_token: string
  expires_in: number
  refresh_token: string
  scope: string
  token_type: string
}

export class DeribitAdapter implements ExchangeAdapter {
  name = 'deribit'
  private baseURL: string
  private ws?: WebSocket
  private session?: DeribitAuthResponse
  private updateCallback?: UpdateCallback
  private credentials?: DeribitCredentials
  private refreshTimer?: NodeJS.Timeout
  private sessionTimestamp?: number
  private pingInterval?: NodeJS.Timeout
  private reconnectTimeout?: NodeJS.Timeout
  private reauthTimer?: NodeJS.Timeout
  private lock = false
  // In-flight JSON-RPC requests over the WS, keyed by id. Settled by the
  // matching response, by their own timeout, or — on close/error — all at
  // once with a handled rejection. Before this, every pending request kept
  // its own 'message' listener and a bare timer, so a dropped socket produced
  // a storm of unhandled 'WebSocket request timeout' rejections (2026-09-06).
  private pendingWs = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  private nextWsId = 1
  // WS reconnect backoff. The fixed 5 s retry turned a Deribit maintenance
  // window (2026-09-05 09:00 UTC) into a self-sustaining storm: ~1.200
  // reconnects/hour, too_many_requests, and — with a ping interval leaked per
  // attempt — a load that grew for hours until the container was restarted.
  private wsReconnectAttempts = 0

  constructor() {
    // Default to mainnet, will be updated based on credentials
    this.baseURL = 'https://www.deribit.com/api/v2'
  }

  async connect(credentials: ExchangeCredentials): Promise<void> {
    if (credentials.type !== 'apiKey') {
      throw new Error('Deribit requires API key authentication')
    }

    this.credentials = credentials as DeribitCredentials
    
    // Update base URL if testnet
    if (this.credentials.testnet) {
      this.baseURL = 'https://test.deribit.com/api/v2'
    } else {
      this.baseURL = 'https://www.deribit.com/api/v2'
    }

    await this.authenticateSession()
    await this.connectWebSocket()
  }

  async disconnect(): Promise<void> {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = undefined
    }

    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = undefined
    }

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = undefined
    }

    if (this.reauthTimer) {
      clearTimeout(this.reauthTimer)
      this.reauthTimer = undefined
    }

    this.teardownWs('disconnect')

    this.session = undefined
    this.credentials = undefined
  }

  private async call(
    endpoint: string,
    params: Record<string, any> = {},
    timeout: FetchTimeoutKind = 'read',
  ): Promise<any> {
    const waitForUnlock = async () => {
      const deadline = Date.now() + 30_000
      while (this.lock && this.session && !params.refresh_token) {
        if (Date.now() >= deadline) {
          throw new Error(`Deribit token refresh did not complete within 30s (${endpoint})`)
        }
        console.log('Waiting for token refresh...', endpoint)
        await new Promise(resolve => setTimeout(resolve, 1500))
      }
    }

    await waitForUnlock()

    try {
      const queryString = new URLSearchParams(params).toString()
      const url = `${this.baseURL}/${endpoint}?${queryString}`
      
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }

      // Add authorization header if we have a session and this isn't a refresh request
      if (this.session && !params.refresh_token && !endpoint.includes('public/auth')) {
        headers['Authorization'] = `Bearer ${this.session.access_token}`
      }

      // console.log(`Calling ${endpoint} for user ${this.credentials?.apiKey}`)

      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: timeoutSignal(timeout),
      })

      // Read as text first: a gateway 5xx / Cloudflare challenge / empty body is
      // not JSON, and blindly calling response.json() throws an opaque
      // "Failed to parse JSON" that hides the real HTTP status.
      const raw = await response.text()
      let data: any
      try {
        data = raw ? JSON.parse(raw) : {}
      } catch {
        const snippet = raw.slice(0, 200).replace(/\s+/g, ' ').trim()
        throw new Error(`Deribit ${endpoint} HTTP ${response.status}: ${snippet || 'non-JSON response'}`)
      }

      if (!response.ok) {
        console.error('Deribit API error:', data)
        throw new Error(data.error?.message || `Deribit ${endpoint} HTTP ${response.status}`)
      }

      return data.result
    } catch (error: any) {
      console.error(`Error calling ${endpoint}:`, error)
      throw error
    }
  }

  async refreshSession(): Promise<void> {
    if (!this.session?.refresh_token) {
      throw new Error('No refresh token available')
    }

    this.lock = true

    try {
      const result = await this.call('public/auth', {
        grant_type: 'refresh_token',
        refresh_token: this.session.refresh_token
      }, 'auth')

      console.log('Token refreshed successfully')
      this.session = result
      this.sessionTimestamp = Date.now()
      this.scheduleTokenRefresh()

      if (this.updateCallback) {
        this.updateCallback({
          type: 'account',
          data: { connected: true, sessionExpiry: this.getSessionExpiry() }
        })
      }
    } catch (error: any) {
      console.error('Token refresh failed, attempting re-authentication...', error?.message)
      // Keep retrying full re-authentication with capped exponential backoff.
      // The old path rethrew inside a bare setTimeout — an unhandled rejection
      // that crashed the whole executor with live positions unmanaged (EX6).
      this.scheduleReauth(0)
    } finally {
      this.lock = false
    }
  }

  // Retry full re-authentication forever with capped exponential backoff
  // (30s, 60s, 120s, 240s, capped at 300s). Never throws into a timer.
  private scheduleReauth(attempt: number): void {
    if (this.reauthTimer) clearTimeout(this.reauthTimer)
    const delay = Math.min(300_000, 30_000 * 2 ** Math.min(attempt, 4))
    this.reauthTimer = setTimeout(async () => {
      this.reauthTimer = undefined
      if (!this.credentials) return // disconnected in the meantime
      try {
        await this.authenticateSession()
        console.log(`Deribit re-authentication succeeded (attempt ${attempt + 1})`)
      } catch (authError: any) {
        console.error(
          `Deribit re-authentication failed (attempt ${attempt + 1}), retrying:`,
          authError?.message ?? authError,
        )
        this.scheduleReauth(attempt + 1)
      }
    }, delay)
  }

  private async authenticateSession(): Promise<void> {
    if (!this.credentials) {
      throw new Error('No credentials available')
    }

    try {
      const result = await this.call('public/auth', {
        grant_type: 'client_credentials',
        client_id: this.credentials.apiKey,
        client_secret: this.credentials.apiSecret,
        scope: 'account:read wallet:read trade:read trade:read_write',
      }, 'auth')

      console.log('Deribit authenticated:', {
        user: this.credentials.apiKey,
        expires_in: result.expires_in,
        scope: result.scope
      })

      // Check if we have the required scopes
      const grantedScopes = result.scope.split(' ')
      const requiredScopes = ['account:read', 'wallet:read', 'trade:read']
      const missingScopes = requiredScopes.filter(scope => !grantedScopes.includes(scope))
      
      if (missingScopes.length > 0) {
        console.warn('Warning: Missing required scopes:', missingScopes.join(', '))
        console.warn('Please ensure your API key has the following permissions: account:read, wallet:read, trade:read')
      }

      this.session = result
      this.sessionTimestamp = Date.now()
      this.scheduleTokenRefresh()

      if (this.updateCallback) {
        this.updateCallback({
          type: 'account',
          data: { connected: true, sessionExpiry: this.getSessionExpiry() }
        })
      }
    } catch (error: any) {
      console.error('Deribit authentication failed:', error)
      throw new Error(`Authentication failed: ${error.message}`)
    }
  }

  private async connectWebSocket(): Promise<void> {
    if (!this.session) {
      throw new Error('Not authenticated')
    }

    const wsUrl = this.credentials?.testnet 
      ? 'wss://test.deribit.com/ws/api/v2'
      : 'wss://www.deribit.com/ws/api/v2'

    // One socket, one ping interval: a reconnect or session refresh used to
    // open a new socket on top of the old one and stack another interval.
    this.teardownWs('replaced by a new connection')

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl)

      // Settle the connect promise exactly once: the handshake timer and the
      // open handler used to race each other.
      let settled = false
      const settle = (err?: Error) => {
        if (settled) return
        settled = true
        if (err) reject(err)
        else resolve()
      }

      this.ws.on('open', async () => {
        console.log('Deribit WebSocket connected')
        try {
          // Authenticate WebSocket with client credentials
          await this.sendWsRequest('public/auth', {
            grant_type: 'client_credentials',
            client_id: this.credentials!.apiKey,
            client_secret: this.credentials!.apiSecret,
          })
          await this.sendWsRequest('public/set_heartbeat', { interval: 30 })
          await this.subscribeToChannels()
          this.startPingInterval()
          this.wsReconnectAttempts = 0
          settle()
        } catch (error) {
          // An async event handler has no awaiter: without this catch a
          // timed-out auth on a flaky link was an unhandled rejection and the
          // socket stayed half-initialised. Drop it; 'close' reconnects.
          console.error('Deribit WebSocket setup failed:', error)
          try { this.ws?.terminate() } catch { /* already gone */ }
          settle(error instanceof Error ? error : new Error(String(error)))
        }
      })

      this.ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString())
          if (typeof message.id === 'number' && this.pendingWs.has(message.id)) {
            const pending = this.pendingWs.get(message.id)!
            this.pendingWs.delete(message.id)
            clearTimeout(pending.timer)
            if (message.error) pending.reject(new Error(message.error.message))
            else pending.resolve(message.result)
            return
          }
          this.handleWsMessage(message)
        } catch (error) {
          console.error('Failed to parse WebSocket message:', error)
        }
      })

      this.ws.on('error', (error) => {
        console.error('WebSocket error:', error)
        this.rejectPendingWs(new Error(`WebSocket error: ${error.message}`))
        if (this.updateCallback) {
          this.updateCallback({
            type: 'account',
            data: { connected: false, error: 'WebSocket error' }
          })
        }
      })

      this.ws.on('close', (code, reason) => {
        // Who closed and why is the one fact the 2026-09-06 storm never
        // logged; keep it.
        console.log(`Deribit WebSocket closed (code ${code}${reason?.length ? `, ${reason.toString()}` : ''}), attempting reconnect...`)
        this.rejectPendingWs(new Error('WebSocket disconnected'))
        settle(new Error('WebSocket closed before setup completed'))
        this.scheduleReconnect()
      })

      setTimeout(() => {
        if (this.ws?.readyState !== WebSocket.OPEN) {
          settle(new Error('WebSocket connection timeout'))
        }
      }, 10000)
    })
  }

  // Fail every in-flight WS request with ONE handled reason. Each caller
  // awaits its own promise, so nothing is left dangling for the timer to
  // reject later into the void.
  private rejectPendingWs(reason: Error): void {
    for (const [id, pending] of this.pendingWs) {
      clearTimeout(pending.timer)
      this.pendingWs.delete(id)
      pending.reject(reason)
    }
  }

  private async sendWsRequest(method: string, params: any = {}, timeoutMs = 5000): Promise<any> {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected')
    }

    return new Promise((resolve, reject) => {
      const id = this.nextWsId++
      const timer = setTimeout(() => {
        if (this.pendingWs.delete(id)) reject(new Error(`WebSocket request timeout (${method} #${id})`))
      }, timeoutMs)
      this.pendingWs.set(id, { resolve, reject, timer })
      try {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      } catch (error) {
        clearTimeout(timer)
        this.pendingWs.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private async subscribeToChannels(): Promise<void> {
    if (!this.session) return

    try {
      // Subscribe to user portfolio changes
      await this.sendWsRequest('private/subscribe', {
        channels: [
          'user.portfolio.btc',
          'user.portfolio.eth',
          'user.orders.btc-perpetual.raw',
          'user.orders.eth-perpetual.raw',
          'user.trades.btc-perpetual.raw',
          'user.trades.eth-perpetual.raw'
        ]
      })
    } catch (error) {
      console.error('Failed to subscribe to channels:', error)
    }
  }

  private handleWsMessage(message: any): void {
    if (message.method === 'subscription') {
      const channel = message.params.channel
      const data = message.params.data

      if (channel.startsWith('user.portfolio')) {
        if (this.updateCallback) {
          this.updateCallback({
            type: 'balance',
            data: this.mapPortfolioToBalance(data)
          })
        }
      } else if (channel.includes('user.orders')) {
        if (this.updateCallback) {
          this.updateCallback({
            type: 'order',
            data: data
          })
        }
      } else if (channel.includes('user.trades')) {
        if (this.updateCallback) {
          this.updateCallback({
            type: 'position',
            data: data
          })
        }
      }
    } else if (message.params?.type === 'test_request') {
      // Respond to test requests. Fire-and-forget: a timeout here is a lost
      // heartbeat reply, not an error anyone can act on.
      this.sendWsRequest('public/test', {}).catch(() => {})
    }
  }

  private startPingInterval(): void {
    if (this.pingInterval) clearInterval(this.pingInterval)
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          jsonrpc: '2.0',
          method: 'public/test',
          params: {}
        }))
      }
    }, 15000) // Ping every 15 seconds
  }

  // Backoff 5 s → 10 → 20 → … capped at 5 min; reset once a socket completes
  // its setup. Visible for tests.
  wsReconnectDelayMs(): number {
    return Math.min(300_000, 5_000 * 2 ** Math.min(this.wsReconnectAttempts, 6))
  }

  private scheduleReconnect(): void {
    if (!this.credentials) return // disconnected on purpose
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
    }
    const delay = this.wsReconnectDelayMs()
    this.wsReconnectAttempts++

    this.reconnectTimeout = setTimeout(async () => {
      this.reconnectTimeout = undefined
      try {
        await this.connectWebSocket()
      } catch (error) {
        console.error('Reconnection failed:', error instanceof Error ? error.message : error)
        this.scheduleReconnect()
      }
    }, delay)
  }

  // Drop the current socket and its ping interval without scheduling anything.
  private teardownWs(reason: string): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = undefined
    }
    const old = this.ws
    this.ws = undefined
    if (!old) return
    this.rejectPendingWs(new Error(`WebSocket disconnected (${reason})`))
    old.removeAllListeners()
    old.on('error', () => { /* detached */ })
    try { old.terminate() } catch { /* already gone */ }
  }

  private scheduleTokenRefresh(): void {
    if (!this.session) return

    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
    }

    // Refresh at half the expiry time
    const seconds = Math.max(900, this.session.expires_in) / 2
    const timeUntilRefresh = seconds * 1000

    this.refreshTimer = setTimeout(async () => {
      try {
        await this.refreshSession()
      } catch (error) {
        console.error('Failed to refresh Deribit session:', error)
        if (this.updateCallback) {
          this.updateCallback({
            type: 'account',
            data: { connected: false, error: 'Session refresh failed' }
          })
        }
      }
    }, timeUntilRefresh)
  }

  private getSessionExpiry(): number {
    if (!this.session || !this.sessionTimestamp) return 0
    return this.sessionTimestamp + (this.session.expires_in * 1000)
  }

  async getAccounts(): Promise<Account[]> {
    try {
      // USDC funds the linear altcoin perps (SOL_USDC-PERPETUAL etc.).
      const [btcAccount, ethAccount, usdcAccount] = await Promise.all([
        this.call('private/get_account_summary', { currency: 'BTC' }),
        this.call('private/get_account_summary', { currency: 'ETH' }),
        this.call('private/get_account_summary', { currency: 'USDC' }).catch(() => null)
      ])

      const accounts: Account[] = []

      if (btcAccount) {
        accounts.push({
          id: 'deribit:btc',
          exchangeName: this.name,
          accountId: 'btc',
          accountType: 'derivatives',
          name: 'BTC Account',
          currency: 'BTC',
        })
      }

      if (ethAccount) {
        accounts.push({
          id: 'deribit:eth',
          exchangeName: this.name,
          accountId: 'eth',
          accountType: 'derivatives',
          name: 'ETH Account',
          currency: 'ETH',
        })
      }

      if (usdcAccount) {
        accounts.push({
          id: 'deribit:usdc',
          exchangeName: this.name,
          accountId: 'usdc',
          accountType: 'derivatives',
          name: 'USDC Account',
          currency: 'USDC',
        })
      }

      return accounts
    } catch (error: any) {
      console.error('Failed to get Deribit accounts:', error)
      throw new Error(`Failed to get accounts: ${error.message}`)
    }
  }

  async getBalances(): Promise<Balance[]> {
    try {
      const [btcSummary, ethSummary, usdcSummary] = await Promise.all([
        this.call('private/get_account_summary', { currency: 'BTC', extended: true }),
        this.call('private/get_account_summary', { currency: 'ETH', extended: true }),
        this.call('private/get_account_summary', { currency: 'USDC', extended: true }).catch(() => null)
      ])

      const balances: Balance[] = []

      if (btcSummary) {
        balances.push({
          accountId: 'btc',
          balance: btcSummary.balance,
          equity: btcSummary.equity,
          realizedPnL: btcSummary.total_pl || 0,
          unrealizedPnL: btcSummary.session_upl || 0,
          initialMargin: btcSummary.initial_margin,
          maintenanceMargin: btcSummary.maintenance_margin,
          currency: 'BTC',
          timestamp: Date.now(),
        })
      }

      if (ethSummary) {
        balances.push({
          accountId: 'eth',
          balance: ethSummary.balance,
          equity: ethSummary.equity,
          realizedPnL: ethSummary.total_pl || 0,
          unrealizedPnL: ethSummary.session_upl || 0,
          initialMargin: ethSummary.initial_margin,
          maintenanceMargin: ethSummary.maintenance_margin,
          currency: 'ETH',
          timestamp: Date.now(),
        })
      }

      if (usdcSummary) {
        balances.push({
          accountId: 'usdc',
          balance: usdcSummary.balance,
          equity: usdcSummary.equity,
          realizedPnL: usdcSummary.total_pl || 0,
          unrealizedPnL: usdcSummary.session_upl || 0,
          initialMargin: usdcSummary.initial_margin,
          maintenanceMargin: usdcSummary.maintenance_margin,
          currency: 'USDC',
          timestamp: Date.now(),
        })
      }

      return balances
    } catch (error: any) {
      console.error('Failed to get Deribit balances:', error)
      throw new Error(`Failed to get balances: ${error.message}`)
    }
  }

  async getPositions(): Promise<Position[]> {
    try {
      const positions = await this.call('private/get_positions', {})
      
      // console.log('Deribit positions response:', JSON.stringify(positions, null, 2))
      
      // Handle empty positions
      if (!positions || positions.length === 0) {
        return []
      }

      return positions.map((pos: any) => {
        // Skip invalid positions
        if (!pos || !pos.instrument_name) {
          console.warn('Invalid position data:', pos)
          return null
        }
        
        // Determine settle account from instrument name. Linear USDC perps
        // (SOL_USDC-PERPETUAL, BTC_USDC-PERPETUAL) settle in USDC — check
        // before the coin prefixes, BTC_USDC starts with BTC too.
        const currency = pos.instrument_name.includes('_USDC') ? 'usdc' :
                        pos.instrument_name.startsWith('BTC') ? 'btc' :
                        pos.instrument_name.startsWith('ETH') ? 'eth' :
                        pos.currency ? pos.currency.toLowerCase() : 'unknown'
        
        // Deribit reports `size` in the QUOTE currency: USD contracts on
        // inverse perps, USDC notional on linear perps. Orders on linear perps
        // are in base coin, so a linear position's size must be the base
        // amount (`size_currency`) or every reduce-only close sends the USDC
        // notional as a coin amount (0.0001 BTC read as 7.98 BTC → rejected).
        const linear = pos.instrument_name.includes('_USDC')
        const rawSize = linear
          ? (pos.size_currency ?? (pos.mark_price ? (pos.size || 0) / pos.mark_price : 0))
          : pos.size
        return {
          id: `deribit:${pos.instrument_name}`,
          accountId: currency,
          symbol: pos.instrument_name,
          side: pos.direction === 'buy' ? 'long' : 'short',
          size: Math.abs(rawSize || 0),
          entryPrice: pos.average_price || 0,
          markPrice: pos.mark_price || 0,
          unrealizedPnL: pos.floating_profit_loss || 0,
          marginType: 'cross',
          leverage: pos.leverage || 1,
        }
      }).filter(Boolean) as Position[]
    } catch (error: any) {
      console.error('Failed to get Deribit positions:', error)
      throw new Error(`Failed to get positions: ${error.message}`)
    }
  }

  // Public ticker (no auth) — basis-guard price check.
  async getLastPrice(symbol: string): Promise<number | null> {
    try {
      const res = await fetch(
        `${this.baseURL}/public/ticker?instrument_name=${encodeURIComponent(symbol)}`,
        { signal: timeoutSignal('read') },
      )
      const data = (await res.json()) as { result?: { mark_price?: number; last_price?: number } }
      const price = data?.result?.mark_price ?? data?.result?.last_price ?? null
      return typeof price === 'number' && price > 0 ? price : null
    } catch {
      return null
    }
  }

  // Public ticker snapshot: mark, 24h move and the current funding rate.
  // stats.price_change is already a percentage; current_funding is per 8h.
  async getMarketTicker(symbol: string): Promise<MarketTicker | null> {
    try {
      const res = await fetch(
        `${this.baseURL}/public/ticker?instrument_name=${encodeURIComponent(symbol)}`,
        { signal: timeoutSignal('read') },
      )
      const data = (await res.json()) as {
        result?: {
          mark_price?: number
          last_price?: number
          current_funding?: number
          funding_8h?: number
          stats?: { price_change?: number }
        }
      }
      const r = data?.result
      if (!r) return null
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
      return {
        mark: num(r.mark_price) ?? num(r.last_price),
        change24hPct: num(r.stats?.price_change),
        fundingRate: num(r.current_funding) ?? num(r.funding_8h),
      }
    } catch {
      return null
    }
  }

  // Deribit's client-order-id mechanism is the order `label` (it does NOT
  // reject duplicate labels, unlike Binance/Bybit client ids). So idempotency is
  // enforced adapter-side: encode the clientOrderId as the label and, before
  // placing, check whether an order with that label already exists in a
  // non-cancelled/rejected state — a retry after a lost response then returns
  // the existing order instead of doubling it (EX5).
  private sanitizeLabel(id: string): string {
    return id.replace(/[^\w.:-]/g, '').slice(0, 64)
  }

  // Settlement currency for by-label queries, derived from the instrument name
  // (same mapping as getPositions).
  private currencyForSymbol(symbol: string): string {
    const s = symbol.toUpperCase()
    if (s.includes('_USDC')) return 'USDC'
    if (s.startsWith('ETH')) return 'ETH'
    return 'BTC'
  }

  // Any order (open or recently terminal) carrying this label, newest first.
  // Label lookup that reports whether the venue actually ANSWERED: order null +
  // confirmed true = the venue positively has no order under this label; null +
  // confirmed false = the lookup itself failed (inconclusive).
  private async lookupOrderByLabel(
    symbol: string,
    label: string,
  ): Promise<{ order: any | null; confirmed: boolean }> {
    try {
      const orders = await this.call('private/get_order_state_by_label', {
        currency: this.currencyForSymbol(symbol),
        label,
      })
      const list = (Array.isArray(orders) ? orders : []).filter(
        (o: any) => o?.instrument_name === symbol,
      )
      if (list.length === 0) return { order: null, confirmed: true }
      list.sort(
        (a: any, b: any) =>
          (b.last_update_timestamp ?? b.creation_timestamp ?? 0) -
          (a.last_update_timestamp ?? a.creation_timestamp ?? 0),
      )
      return { order: list[0], confirmed: true }
    } catch {
      return { order: null, confirmed: false }
    }
  }

  private async findOrderByLabel(symbol: string, label: string): Promise<any | null> {
    // Inconclusive lookup must not block the order — the caller places as usual.
    return (await this.lookupOrderByLabel(symbol, label)).order
  }

  async placeOrder(order: Order): Promise<OrderResult> {
    try {
      const label = order.clientOrderId
        ? this.sanitizeLabel(order.clientOrderId)
        : order.label
          ? this.sanitizeLabel(order.label)
          : 'kaibot'

      // Broker-side idempotency by label: a retry with the same clientOrderId
      // returns the already-live/filled order instead of placing a duplicate.
      if (order.clientOrderId) {
        const existing = await this.findOrderByLabel(order.symbol, label)
        if (existing && existing.order_state !== 'cancelled' && existing.order_state !== 'rejected') {
          console.log(
            `Deribit placeOrder dedup: label ${label} already exists (state ${existing.order_state}), not re-placing`,
          )
          return {
            orderId: existing.order_id,
            status: this.mapOrderStatus(existing.order_state),
            filledQuantity: existing.filled_amount || 0,
            averagePrice: existing.average_price || 0,
            message: existing.reject_reason,
            ...(await this.orderFee(existing)),
          }
        }
      }

      // Map generic order → Deribit params. Deribit order types:
      //   'market' | 'limit' | 'stop_market' | 'stop_limit' | 'take_market' | 'take_limit'
      // Stop orders require `trigger` + `trigger_price`; stop_limit also needs `price`.
      const deribitOrder: Record<string, any> = {
        instrument_name: order.symbol,
        amount: order.quantity,
        label,
      }

      switch (order.orderType) {
        case 'market':
          deribitOrder.type = 'market'
          break
        case 'limit':
          if (order.price === undefined) {
            throw new Error('limit order requires price')
          }
          deribitOrder.type = 'limit'
          deribitOrder.price = order.price
          break
        case 'stop': {
          const trigger = order.stopPrice ?? order.price
          if (trigger === undefined) {
            throw new Error('stop order requires stopPrice')
          }
          deribitOrder.type = 'stop_market'
          deribitOrder.trigger = order.triggerType ?? 'last_price'
          deribitOrder.trigger_price = trigger
          break
        }
        case 'stopLimit': {
          const trigger = order.stopPrice
          if (trigger === undefined || order.price === undefined) {
            throw new Error('stopLimit order requires both stopPrice and price')
          }
          deribitOrder.type = 'stop_limit'
          deribitOrder.trigger = order.triggerType ?? 'last_price'
          deribitOrder.trigger_price = trigger
          deribitOrder.price = order.price
          break
        }
        default:
          throw new Error(`Unsupported order type: ${order.orderType}`)
      }

      if (order.reduceOnly) {
        deribitOrder.reduce_only = true
      }

      if (order.timeInForce) {
        const tifMap: Record<string, string> = {
          GTC: 'good_til_cancelled',
          IOC: 'immediate_or_cancel',
          FOK: 'fill_or_kill',
          DAY: 'good_til_day',
        }
        const mapped = tifMap[order.timeInForce]
        if (mapped) deribitOrder.time_in_force = mapped
      }

      // Determine endpoint based on side
      const endpoint = order.side === 'buy' ? 'private/buy' : 'private/sell'

      const result = await this.call(endpoint, deribitOrder, 'order')

      return {
        orderId: result.order.order_id,
        status: this.mapOrderStatus(result.order.order_state),
        filledQuantity: result.order.filled_amount || 0,
        averagePrice: result.order.average_price || 0,
        message: result.order.reject_reason,
        ...(await this.orderFee(result.order)),
      }
    } catch (error: any) {
      console.error('Failed to place Deribit order:', error)
      throw new Error(`Failed to place order: ${error.message}`)
    }
  }

  async cancelOrder(orderId: string, _ctx?: OrderQueryContext): Promise<void> {
    try {
      // Deribit cancels by order id alone — ctx (symbol/category) is not needed.
      await this.call('private/cancel', { order_id: orderId }, 'order')
    } catch (error: any) {
      console.error('Failed to cancel Deribit order:', error)
      throw new Error(`Failed to cancel order: ${error.message}`)
    }
  }

  // Deribit trades 24/7 → the market-open guard never blocks it.
  alwaysOpen = true

  // Resting orders incl. trigger (stop) orders. Deribit lists plain and
  // trigger orders under different `type` filters, so both are fetched and
  // merged by order id. One instrument when given, else every currency.
  async getOpenOrders(ctx?: { symbol?: string }): Promise<OpenOrder[]> {
    const byId = new Map<string, OpenOrder>()
    const collect = (rows: any) => {
      for (const o of Array.isArray(rows) ? rows : []) {
        const id = String(o.order_id ?? '')
        if (!id) continue
        byId.set(id, {
          orderId: id,
          symbol: String(o.instrument_name ?? ctx?.symbol ?? ''),
          side: o.direction === 'sell' ? 'sell' : 'buy',
          type: String(o.order_type ?? 'unknown'),
          amount: Number(o.amount ?? 0),
          price: typeof o.price === 'number' ? o.price : null,
          triggerPrice: typeof o.trigger_price === 'number' ? o.trigger_price : null,
          reduceOnly: o.reduce_only === true,
          label: typeof o.label === 'string' && o.label ? o.label : null,
          state: String(o.order_state ?? 'open'),
          createdAtMs: typeof o.creation_timestamp === 'number' ? o.creation_timestamp : null,
          raw: o,
        })
      }
    }
    const types = ['all', 'trigger_all']
    if (ctx?.symbol) {
      for (const type of types) {
        collect(await this.call('private/get_open_orders_by_instrument', { instrument_name: ctx.symbol, type }))
      }
    } else {
      for (const currency of ['BTC', 'ETH', 'USDC']) {
        for (const type of types) {
          collect(await this.call('private/get_open_orders_by_currency', { currency, type }).catch(() => []))
        }
      }
    }
    return [...byId.values()]
  }

  /** Query an order's current state for the settlement poller. */
  async getOrderStatus(orderId: string, ctx?: OrderQueryContext): Promise<OrderStatus> {
    try {
      // A "client:<id>" ref resolves by label — used for orders whose placeOrder
      // call threw before returning a broker id (EX2).
      const clientId = parseClientOrderRef(orderId)
      if (clientId) {
        if (!ctx?.symbol) return { orderId, state: 'unknown' } // can't even query
        const { order, confirmed } = await this.lookupOrderByLabel(
          ctx.symbol,
          this.sanitizeLabel(clientId),
        )
        if (!order) return { orderId, state: 'unknown', absenceConfirmed: confirmed }
        return {
          orderId,
          state: this.mapToStatusState(order.order_state),
          filledQuantity: order.filled_amount ?? 0,
          averagePrice: order.average_price ?? 0,
          ...(await this.orderFee(order)),
          raw: order,
        }
      }
      const order = await this.call('private/get_order_state', { order_id: orderId })
      if (!order) return { orderId, state: 'unknown' }
      return {
        orderId,
        state: this.mapToStatusState(order.order_state),
        filledQuantity: order.filled_amount ?? 0,
        averagePrice: order.average_price ?? 0,
        ...(await this.orderFee(order)),
        raw: order,
      }
    } catch (error: any) {
      // Deribit answers an unknown order id with an order_not_found error — a
      // venue-confirmed absence. Any other failure (network/auth) is an
      // inconclusive lookup: the order may still exist at the broker.
      const msg = String(error?.message ?? '')
      return { orderId, state: 'unknown', absenceConfirmed: /not_found/i.test(msg) }
    }
  }

  // USD fee carried on a Deribit order object (`commission`, in the fee
  // currency of the instrument). Empty when the order reports none.
  private async orderFee(order: any): Promise<{ commission?: number; feeNative?: number; feeCurrency?: string }> {
    const raw = order?.commission
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return {}
    const symbol = String(order.instrument_name ?? '')
    const fee = await feeToUsd({
      fee: raw,
      feeCurrency: deribitFeeCurrency(symbol),
      symbol,
      fillPrice: order.average_price,
      markFor: (coin) => this.getLastPrice(`${coin}-PERPETUAL`),
    })
    return fee ?? {}
  }

  /**
   * Total fee of one order from its trades (private/get_user_trades_by_order).
   * Recent trades first; Deribit moves them to the historical index after a
   * day, so an empty recent page is retried there. Null when the venue has no
   * trades for the id.
   */
  async getOrderFee(orderId: string, ctx?: OrderQueryContext): Promise<FillFee | null> {
    let trades: any[] = []
    for (const historical of [false, true]) {
      const res = await this.call('private/get_user_trades_by_order', {
        order_id: orderId,
        ...(historical ? { historical: true } : {}),
      })
      trades = Array.isArray(res?.trades) ? res.trades : Array.isArray(res) ? res : []
      if (trades.length > 0) break
    }
    if (trades.length === 0) return null
    let fee = 0
    let feeCurrency = ''
    let notional = 0
    let amount = 0
    const symbol = String(trades[0]?.instrument_name ?? ctx?.symbol ?? '')
    for (const t of trades) {
      const f = Number(t.fee)
      if (Number.isFinite(f)) fee += f
      if (t.fee_currency) feeCurrency = String(t.fee_currency)
      const a = Number(t.amount)
      const p = Number(t.price)
      if (Number.isFinite(a) && Number.isFinite(p)) {
        amount += a
        notional += a * p
      }
    }
    return feeToUsd({
      fee,
      feeCurrency: feeCurrency || deribitFeeCurrency(symbol),
      symbol,
      fillPrice: amount > 0 ? notional / amount : null,
      markFor: (coin) => this.getLastPrice(`${coin}-PERPETUAL`),
    })
  }

  private mapToStatusState(state: string): OrderStatus['state'] {
    switch (state) {
      case 'filled':
        return 'filled'
      case 'rejected':
        return 'rejected'
      case 'cancelled':
        return 'cancelled'
      case 'open':
      case 'untriggered':
      case 'triggered':
        return 'working'
      default:
        return 'working'
    }
  }

  subscribeToUpdates(callback: UpdateCallback): void {
    this.updateCallback = callback
  }

  unsubscribeFromUpdates(): void {
    this.updateCallback = undefined
  }

  private mapPortfolioToBalance(portfolio: any): Partial<Balance> {
    return {
      accountId: portfolio.currency.toLowerCase(),
      balance: portfolio.balance,
      equity: portfolio.equity,
      unrealizedPnL: portfolio.session_upl || 0,
      initialMargin: portfolio.initial_margin,
      maintenanceMargin: portfolio.maintenance_margin,
      currency: portfolio.currency,
      timestamp: Date.now(),
    }
  }

  private mapOrderStatus(state: string): OrderResult['status'] {
    const statusMap: Record<string, OrderResult['status']> = {
      'open': 'pending',
      'filled': 'filled',
      'rejected': 'rejected',
      'cancelled': 'cancelled',
      'untriggered': 'pending',
    }
    return statusMap[state] || 'pending'
  }
}
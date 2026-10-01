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
  OpenOrder,
  MarketTicker,
  UpdateCallback,
  AccountMargin,
} from '../types.js'

interface BybitCredentials extends ExchangeCredentials {
  type: 'apiKey'
  apiKey: string
  apiSecret: string
  testnet?: boolean
  recvWindow?: number
}

export type BybitCategory = 'linear' | 'inverse' | 'spot'

interface BybitResponse<T = any> {
  retCode: number
  retMsg: string
  result: T
  retExtInfo?: unknown
  time?: number
}

/** Venue error with the v5 retCode kept, so callers can tell 10006 (rate
 *  limit) from 110017 (reduce-only would open) without parsing prose. */
export class BybitApiError extends Error {
  constructor(
    readonly retCode: number,
    readonly retMsg: string,
    readonly path: string,
  ) {
    super(`Bybit ${path} [${retCode}] ${retMsg}`)
    this.name = 'BybitApiError'
  }
}

/** lotSizeFilter / priceFilter of one instrument (instruments-info). */
export interface BybitInstrument {
  symbol: string
  category: BybitCategory
  qtyStep: number
  minOrderQty: number
  maxOrderQty: number | null
  tickSize: number
  /** USDT/USDC perps refuse orders whose notional is below this (5 USDT). */
  minNotionalValue: number | null
  /** Spot only: step of a quote-denominated (USDT) market buy. */
  quotePrecision?: number | null
  status: string
  raw?: any
}

/** One fill from /v5/execution/list (or the private execution topic). */
export interface BybitExecution {
  execId: string
  orderId: string
  orderLinkId: string | null
  symbol: string
  side: 'buy' | 'sell'
  price: number
  qty: number
  fee: number
  feeCurrency: string | null
  /** Trade | Funding | AdlTrade | BustTrade | Settle | ... */
  execType: string
  isMaker: boolean
  timeMs: number
  raw?: any
}

/** Spot-only fields a caller may add to an Order. */
export interface SpotOrderExtras {
  category?: BybitCategory
  /** 'quoteCoin' = qty is USDT (market buy only). Default baseCoin. */
  marketUnit?: 'baseCoin' | 'quoteCoin'
}

/** One coin of the UTA wallet as the collateral view needs it. */
export interface BybitWalletCoin {
  coin: string
  walletBalance: number
  equity: number
  usdValue: number
  borrowAmount: number
  collateralSwitch: boolean
  marginCollateral: boolean
  locked: number
}

/** UTA account-level margin figures (USD) + per-coin rows. Rates are fractions. */
export interface BybitCollateralWallet {
  accountType: string
  totalEquity: number | null
  totalMarginBalance: number | null
  totalAvailableBalance: number | null
  totalInitialMargin: number | null
  totalMaintenanceMargin: number | null
  accountIMRate: number | null
  accountMMRate: number | null
  coins: BybitWalletCoin[]
}

/** Tiered collateral ratio of one coin: [minQty, maxQty) → ratio. */
export interface CollateralRatioTier {
  minQty: number
  maxQty: number | null
  ratio: number
}

export interface BybitAmendPatch {
  quantity?: number
  price?: number
  triggerPrice?: number
}

// The executor's single name for the Bybit wallet. A UTA pools linear,
// inverse and spot in one unified wallet; a classic (pre-UTA) account keeps
// the same id so lineage rows never depend on the upgrade state.
export const BYBIT_ACCOUNT_ID = 'unified'

const DEFAULT_RECV_WINDOW = 5000
// v5: orderLinkId is at most 36 chars, [A-Za-z0-9_-].
const ORDER_LINK_ID_MAX = 36
const INSTRUMENT_TTL_MS = 6 * 60 * 60 * 1000
const POSITION_MODE_TTL_MS = 10 * 60 * 1000
const WS_PING_MS = 20_000
// Two missed pongs → the socket is dead even if TCP says otherwise.
const WS_PONG_GRACE_MS = 3 * WS_PING_MS
const WS_RECONNECT_BASE_MS = 5_000
const WS_RECONNECT_MAX_MS = 300_000
const RET_TIMESTAMP_OUT_OF_WINDOW = 10002
const RET_RATE_LIMITED = 10006

type PositionMode = 'oneway' | 'hedge'

function decimalsOf(step: string | number): number {
  const s = String(step)
  // 1e-7 (a spot quotePrecision parsed to a number) has no dot.
  const exp = /e-(\d+)$/i.exec(s)
  if (exp) return Number(exp[1]) + decimalsOf(s.slice(0, exp.index))
  const dot = s.indexOf('.')
  return dot === -1 ? 0 : s.length - dot - 1
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : null
}

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
  private wsReconnectAttempts = 0
  private lastPongAt = 0
  // Venue clock minus ours. Bybit rejects a request whose timestamp is outside
  // [server - recvWindow, server + 1000) with retCode 10002; NTP drift on a
  // container is enough to hit that, so the offset is learned at connect.
  private timeOffsetMs = 0
  private unifiedAccount: boolean | null = null
  private marginMode: string | null = null
  private instruments = new Map<string, { at: number; value: BybitInstrument }>()
  private positionModes = new Map<string, { at: number; mode: PositionMode }>()

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

    await this.syncServerTime().catch(() => {})
    await this.verifyCredentials()
    this.wsReconnectAttempts = 0
    await this.connectWebSocket().catch((err) => {
      console.warn('Bybit WebSocket connect failed (continuing without WS):', err?.message || err)
      this.scheduleReconnect()
    })
  }

  async disconnect(): Promise<void> {
    // Credentials go first: a close event arriving during teardown must not
    // schedule a reconnect.
    this.credentials = undefined
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = undefined
    }
    this.teardownWs()
  }

  async refreshSession(): Promise<void> {
    // Per-request HMAC signatures, nothing to refresh; re-verify the key and
    // re-learn the clock offset.
    await this.syncServerTime().catch(() => {})
    await this.verifyCredentials()
  }

  get isUnifiedAccount(): boolean | null {
    return this.unifiedAccount
  }

  get accountMarginMode(): string | null {
    return this.marginMode
  }

  get wsConnected(): boolean {
    return this.wsAuthenticated && !!this.ws && this.ws.readyState === WebSocket.OPEN
  }

  /** Our clock corrected to the venue's. */
  now(): number {
    return Date.now() + this.timeOffsetMs
  }

  /** Learn the venue clock offset from the public time endpoint. */
  async syncServerTime(): Promise<number> {
    const res = await fetch(`${this.baseURL}/v5/market/time`, { signal: timeoutSignal('read') })
    const data = (await res.json()) as BybitResponse<{ timeSecond?: string; timeNano?: string }>
    const nano = num(data?.result?.timeNano)
    const sec = num(data?.result?.timeSecond)
    const serverMs = nano != null ? Math.floor(nano / 1e6) : sec != null ? sec * 1000 : num(data?.time)
    if (serverMs == null) throw new Error('Bybit server time unavailable')
    this.timeOffsetMs = serverMs - Date.now()
    return this.timeOffsetMs
  }

  async getAccounts(): Promise<Account[]> {
    try {
      if (this.unifiedAccount == null) await this.verifyCredentials().catch(() => {})
      const unified = this.unifiedAccount !== false
      return [
        {
          id: `bybit:${BYBIT_ACCOUNT_ID}`,
          exchangeName: this.name,
          accountId: BYBIT_ACCOUNT_ID,
          accountType: unified ? 'unified' : 'contract',
          name: unified ? 'Unified Trading Account' : 'Contract Account (classic)',
          currency: 'USDT',
        },
      ]
    } catch (error: any) {
      console.error('Failed to get Bybit accounts:', error)
      throw new Error(`Failed to get accounts: ${error.message}`)
    }
  }

  async getBalances(): Promise<Balance[]> {
    try {
      const balances: Balance[] = []
      const wallet = await this.walletBalance()
      for (const entry of wallet?.list ?? []) {
        for (const coin of entry.coin ?? []) {
          const bal = num(coin.walletBalance) ?? 0
          const eq = num(coin.equity) ?? bal
          if (bal === 0 && eq === 0) continue
          balances.push({
            accountId: BYBIT_ACCOUNT_ID,
            balance: bal,
            equity: eq,
            realizedPnL: num(coin.cumRealisedPnl) ?? 0,
            unrealizedPnL: num(coin.unrealisedPnl) ?? 0,
            // Account-level margin figures (USD) on every coin row: the guard
            // reads the largest-equity row, which is the collateral coin.
            initialMargin: num(entry.totalInitialMargin) || undefined,
            maintenanceMargin: num(entry.totalMaintenanceMargin) || undefined,
            currency: String(coin.coin),
            timestamp: Date.now(),
          })
        }
      }
      return balances
    } catch (error: any) {
      console.error('Failed to get Bybit balances:', error)
      throw new Error(`Failed to get balances: ${error.message}`)
    }
  }

  // UNIFIED for a UTA, CONTRACT for a classic account. Unknown upgrade state
  // (account/info failed) → UNIFIED first, CONTRACT as fallback.
  private async walletBalance(): Promise<any> {
    if (this.unifiedAccount === false) {
      return this.signedGet<any>('/v5/account/wallet-balance', { accountType: 'CONTRACT' })
    }
    try {
      return await this.signedGet<any>('/v5/account/wallet-balance', { accountType: 'UNIFIED' })
    } catch (e) {
      if (this.unifiedAccount === true) throw e
      return this.signedGet<any>('/v5/account/wallet-balance', { accountType: 'CONTRACT' })
    }
  }

  /**
   * The UTA wallet with its collateral flags and account margin rates
   * (/v5/account/wallet-balance). Negative walletBalance = auto-borrowed
   * (e.g. USDT lent to cover perp losses on a coin-only account).
   */
  async getCollateralWallet(): Promise<BybitCollateralWallet> {
    const wallet = await this.walletBalance()
    const entry = wallet?.list?.[0] ?? {}
    const coins: BybitWalletCoin[] = []
    for (const c of entry.coin ?? []) {
      const walletBalance = num(c.walletBalance) ?? 0
      const equity = num(c.equity) ?? walletBalance
      const borrowAmount = num(c.borrowAmount) ?? 0
      if (walletBalance === 0 && equity === 0 && borrowAmount === 0) continue
      coins.push({
        coin: String(c.coin).toUpperCase(),
        walletBalance,
        equity,
        usdValue: num(c.usdValue) ?? 0,
        borrowAmount,
        collateralSwitch: c.collateralSwitch !== false,
        marginCollateral: c.marginCollateral !== false,
        locked: num(c.locked) ?? 0,
      })
    }
    return {
      accountType: String(entry.accountType ?? (this.unifiedAccount === false ? 'CONTRACT' : 'UNIFIED')),
      totalEquity: num(entry.totalEquity),
      totalMarginBalance: num(entry.totalMarginBalance),
      totalAvailableBalance: num(entry.totalAvailableBalance),
      totalInitialMargin: num(entry.totalInitialMargin),
      totalMaintenanceMargin: num(entry.totalMaintenanceMargin),
      // Empty string on a classic account → null, never 0.
      accountIMRate: entry.accountIMRate === '' ? null : num(entry.accountIMRate),
      accountMMRate: entry.accountMMRate === '' ? null : num(entry.accountMMRate),
      coins,
    }
  }

  /**
   * Tiered collateral ratio per coin (public /v5/spot-margin-trade/collateral).
   * Coins the venue does not list are absent from the map.
   */
  async getCollateralRatioTiers(coins: string[]): Promise<Map<string, CollateralRatioTier[]>> {
    const out = new Map<string, CollateralRatioTier[]>()
    for (const coin of coins) {
      const c = coin.toUpperCase()
      try {
        const res = await fetch(
          `${this.baseURL}/v5/spot-margin-trade/collateral?currency=${encodeURIComponent(c)}`,
          { signal: timeoutSignal('read') },
        )
        const data = (await res.json()) as BybitResponse<{ list?: any[] }>
        const row = data?.result?.list?.find((r: any) => String(r.currency).toUpperCase() === c)
        const tiers: CollateralRatioTier[] = []
        for (const t of row?.collateralRatioList ?? []) {
          const ratio = num(t.collateralRatio)
          if (ratio == null) continue
          tiers.push({ minQty: num(t.minQty) ?? 0, maxQty: t.maxQty === '' ? null : num(t.maxQty), ratio })
        }
        if (tiers.length) out.set(c, tiers.sort((a, b) => a.minQty - b.minQty))
      } catch {
        // No tiers → the caller falls back to its configured ratio.
      }
    }
    return out
  }

  /** Venue-computed account margin in USD (UTA): what orders actually draw on. */
  async getAccountMargin(): Promise<AccountMargin | null> {
    if (this.unifiedAccount === false) return null
    const w = await this.getCollateralWallet()
    if (w.totalEquity == null) return null
    return {
      equityUsd: w.totalEquity,
      initialMarginUsd: w.totalInitialMargin ?? 0,
      maintenanceMarginUsd: w.totalMaintenanceMargin ?? 0,
      availableUsd: w.totalAvailableBalance ?? Math.max(0, (w.totalMarginBalance ?? w.totalEquity) - (w.totalInitialMargin ?? 0)),
      imRate: w.accountIMRate,
      mmRate: w.accountMMRate,
    }
  }

  async getPositions(): Promise<Position[]> {
    try {
      const positions: Position[] = []
      const pools: Array<{ category: BybitCategory; settleCoin?: string }> = [
        { category: 'linear', settleCoin: 'USDT' },
        { category: 'linear', settleCoin: 'USDC' },
        { category: 'inverse' },
      ]
      for (const pool of pools) {
        const rows = await this.paginate<any>('/v5/position/list', {
          category: pool.category,
          settleCoin: pool.settleCoin,
          limit: 200,
        }).catch(() => [])
        for (const p of rows) {
          const size = num(p.size) ?? 0
          const positionIdx = Number(p.positionIdx ?? 0)
          this.positionModes.set(String(p.symbol).toUpperCase(), {
            at: Date.now(),
            mode: positionIdx === 0 ? 'oneway' : 'hedge',
          })
          if (size === 0 || !p.side) continue
          positions.push({
            // Hedge mode holds a Buy (1) and a Sell (2) leg on one symbol;
            // they must not share a row key.
            id: `bybit:${pool.category}:${p.symbol}${positionIdx ? `:${positionIdx}` : ''}`,
            accountId: BYBIT_ACCOUNT_ID,
            symbol: p.symbol,
            side: p.side === 'Buy' ? 'long' : 'short',
            size: Math.abs(size),
            entryPrice: num(p.avgPrice) ?? 0,
            markPrice: num(p.markPrice) ?? 0,
            unrealizedPnL: num(p.unrealisedPnl) ?? 0,
            marginType: Number(p.tradeMode) === 0 ? 'cross' : 'isolated',
            leverage: num(p.leverage) ?? 1,
          })
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
      const ticker = await this.ticker(symbol)
      const price = num(ticker?.markPrice) ?? num(ticker?.lastPrice)
      return price != null && price > 0 ? price : null
    } catch {
      return null
    }
  }

  async getMarketTicker(symbol: string): Promise<MarketTicker | null> {
    try {
      const t = await this.ticker(symbol)
      if (!t) return null
      const pct = num(t.price24hPcnt)
      return {
        mark: num(t.markPrice) ?? num(t.lastPrice),
        // price24hPcnt is a fraction (0.0123 = +1,23 %).
        change24hPct: pct != null ? pct * 100 : null,
        fundingRate: num(t.fundingRate),
      }
    } catch {
      return null
    }
  }

  private async ticker(symbol: string): Promise<any | null> {
    const category = this.resolveCategory(symbol)
    const res = await fetch(
      `${this.baseURL}/v5/market/tickers?category=${category}&symbol=${encodeURIComponent(symbol)}`,
      { signal: timeoutSignal('read') },
    )
    const data = (await res.json()) as BybitResponse<{ list?: any[] }>
    return data?.result?.list?.[0] ?? null
  }

  /** Taker/maker fee rate of this account for a symbol (fractions). */
  async getFeeRate(symbol: string): Promise<{ taker: number; maker: number } | null> {
    const category = this.resolveCategory(symbol)
    const res = await this.signedGet<any>('/v5/account/fee-rate', { category, symbol })
    const row = res?.list?.[0]
    const taker = num(row?.takerFeeRate)
    const maker = num(row?.makerFeeRate)
    return taker != null && maker != null ? { taker, maker } : null
  }

  /**
   * lotSizeFilter / priceFilter for a symbol, cached per process. Public
   * endpoint (no auth). Throws when the venue doesn't list the symbol.
   */
  async getInstrument(symbol: string, categoryHint?: string): Promise<BybitInstrument> {
    const key = symbol.toUpperCase()
    const category = this.resolveCategory(symbol, categoryHint)
    // BTCUSDT is both a spot pair and a linear perp with different filters.
    const cacheKey = `${category}:${key}`
    const cached = this.instruments.get(cacheKey)
    if (cached && Date.now() - cached.at < INSTRUMENT_TTL_MS) return cached.value
    const res = await fetch(
      `${this.baseURL}/v5/market/instruments-info?category=${category}&symbol=${encodeURIComponent(key)}`,
      { signal: timeoutSignal('read') },
    )
    const data = (await res.json()) as BybitResponse<{ list?: any[] }>
    if (data.retCode !== 0) throw new BybitApiError(data.retCode, data.retMsg, '/v5/market/instruments-info')
    const row = data?.result?.list?.[0]
    if (!row) throw new Error(`Bybit does not list ${key} (${category})`)
    const lot = row.lotSizeFilter ?? {}
    const pf = row.priceFilter ?? {}
    const value: BybitInstrument = {
      symbol: String(row.symbol),
      category,
      qtyStep: num(lot.qtyStep) ?? num(lot.basePrecision) ?? 0,
      minOrderQty: num(lot.minOrderQty) ?? 0,
      maxOrderQty: num(lot.maxOrderQty),
      tickSize: num(pf.tickSize) ?? 0,
      minNotionalValue: num(lot.minNotionalValue),
      quotePrecision: num(lot.quotePrecision),
      status: String(row.status ?? ''),
      raw: row,
    }
    this.instruments.set(cacheKey, { at: Date.now(), value })
    return value
  }

  /** Quantity as the venue wants it: floored to qtyStep, no float noise. */
  formatQty(qty: number, instrument?: BybitInstrument | null): string {
    if (instrument && instrument.qtyStep > 0) {
      const step = instrument.qtyStep
      const steps = Math.floor(qty / step + 1e-9)
      return (steps * step).toFixed(decimalsOf(step))
    }
    return this.trimNumber(qty)
  }

  /** Price rounded to tickSize (nearest), no float noise. */
  formatPrice(price: number, instrument?: BybitInstrument | null): string {
    if (instrument && instrument.tickSize > 0) {
      const tick = instrument.tickSize
      const ticks = Math.round(price / tick)
      return (ticks * tick).toFixed(decimalsOf(tick))
    }
    return this.trimNumber(price)
  }

  private trimNumber(n: number): string {
    return n.toFixed(8).replace(/\.?0+$/, '')
  }

  /**
   * One-way vs hedge mode for a symbol. The venue rejects an order whose
   * positionIdx doesn't match the symbol's mode (10001), so it is read from
   * the position list (also filled by getPositions) and cached.
   */
  async getPositionMode(symbol: string, categoryHint?: string): Promise<PositionMode> {
    const key = symbol.toUpperCase()
    const cached = this.positionModes.get(key)
    if (cached && Date.now() - cached.at < POSITION_MODE_TTL_MS) return cached.mode
    const category = this.resolveCategory(symbol, categoryHint)
    const res = await this.signedGet<any>('/v5/position/list', { category, symbol: key })
    const rows: any[] = res?.list ?? []
    const mode: PositionMode = rows.some((r) => Number(r.positionIdx) === 1 || Number(r.positionIdx) === 2)
      ? 'hedge'
      : 'oneway'
    this.positionModes.set(key, { at: Date.now(), mode })
    return mode
  }

  // Hedge mode: an opening Buy sits on leg 1, an opening Sell on leg 2; a
  // reduce-only order targets the leg it reduces (Sell → 1, Buy → 2).
  private positionIdxFor(mode: PositionMode, side: 'Buy' | 'Sell', reduceOnly: boolean): 0 | 1 | 2 {
    if (mode === 'oneway') return 0
    if (reduceOnly) return side === 'Sell' ? 1 : 2
    return side === 'Buy' ? 1 : 2
  }

  async placeOrder(order: Order): Promise<OrderResult> {
    try {
      const category = this.resolveCategory(order.symbol, (order as any).category)
      const side: 'Buy' | 'Sell' = order.side === 'buy' ? 'Buy' : 'Sell'
      const isStop = order.orderType === 'stop' || order.orderType === 'stopLimit'
      // A stop is a conditional order: the underlying order is Market (stop) or
      // Limit (stopLimit), gated by a triggerPrice. Bybit v5 has no distinct
      // "stop" orderType — it's an ordinary order with trigger fields.
      const orderType =
        order.orderType === 'limit' || order.orderType === 'stopLimit' ? 'Limit' : 'Market'
      const symbol = order.symbol.toUpperCase()

      // Precision from the venue; without it (offline metadata) the raw number
      // is sent trimmed and the venue's own validation decides.
      const instrument = await this.getInstrument(symbol, category).catch(() => null)
      // Spot market buy sized in USDT (collateral-floor buy-back spends the
      // sale proceeds): qty is quote currency, stepped on quotePrecision.
      const quoteUnit = category === 'spot' && (order as Order & SpotOrderExtras).marketUnit === 'quoteCoin'
      if (
        !quoteUnit &&
        instrument &&
        instrument.minOrderQty > 0 &&
        order.quantity < instrument.minOrderQty - 1e-12
      ) {
        throw new Error(
          `qty ${order.quantity} below minOrderQty ${instrument.minOrderQty} for ${symbol}`,
        )
      }
      const qty = quoteUnit
        ? this.formatQty(
            order.quantity,
            instrument?.quotePrecision ? { ...instrument, qtyStep: instrument.quotePrecision } : null,
          )
        : this.formatQty(order.quantity, instrument)
      if (!(parseFloat(qty) > 0)) {
        throw new Error(`qty ${order.quantity} rounds to zero at qtyStep ${instrument?.qtyStep ?? '?'}`)
      }

      const body: Record<string, any> = {
        category,
        symbol,
        side,
        orderType,
        qty,
      }

      if (orderType === 'Limit') {
        if (order.price === undefined) {
          throw new Error('Limit orders require a price')
        }
        body.price = this.formatPrice(order.price, instrument)
        // Bybit knows GTC / IOC / FOK / PostOnly; a DAY order is GTC here.
        body.timeInForce = order.timeInForce && order.timeInForce !== 'DAY' ? order.timeInForce : 'GTC'
      }

      if (category === 'spot') {
        body.marketUnit = quoteUnit ? 'quoteCoin' : 'baseCoin'
      } else {
        const explicitIdx = (order as any).positionIdx
        if (explicitIdx === 0 || explicitIdx === 1 || explicitIdx === 2) {
          body.positionIdx = explicitIdx
        } else {
          // A failed mode lookup must not block the order: one-way is the
          // venue default and the mode every runbook asks for.
          const mode = await this.getPositionMode(symbol, category).catch(() => 'oneway' as PositionMode)
          body.positionIdx = this.positionIdxFor(mode, side, !!order.reduceOnly)
        }
      }

      // ── Conditional / stop trigger (linear & inverse) ──
      if (isStop) {
        const triggerPrice = order.stopPrice ?? order.price
        if (triggerPrice === undefined) {
          throw new Error('Stop orders require a stopPrice')
        }
        body.triggerPrice = this.formatPrice(triggerPrice, instrument)
        if (category === 'spot') {
          // Spot conditional (UTA): orderFilter StopOrder, fires on last
          // price; triggerDirection/triggerBy are derivatives-only. The order
          // rests on the venue, so it survives an executor restart.
          if (order.orderType !== 'stop') {
            throw new Error('Bybit spot conditionals are market-on-trigger only')
          }
          body.orderFilter = 'StopOrder'
        }
      }

      if (isStop && category !== 'spot') {
        // triggerDirection: 1 = trigger when price rises to triggerPrice,
        // 2 = when it falls. The side encodes the intent for both a protective
        // stop (Sell stop under a long → 2, Buy stop over a short → 1) and a
        // breakout entry (Buy stop above → 1, Sell stop below → 2). An explicit
        // triggerDirection on the order overrides this default.
        body.triggerDirection =
          (order as any).triggerDirection ?? (side === 'Sell' ? 2 : 1)
        body.triggerBy = this.mapTriggerBy(order.triggerType)
      }

      // Reduce-only protective legs must never flip the position. Spot has no
      // position to reduce.
      if (order.reduceOnly && category !== 'spot') {
        body.reduceOnly = true
      }

      // Broker-side idempotency: a duplicate submit with the same orderLinkId is
      // rejected by Bybit.
      if (order.clientOrderId) {
        body.orderLinkId = this.sanitizeOrderLinkId(order.clientOrderId)
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

  sanitizeOrderLinkId(id: string): string {
    return id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, ORDER_LINK_ID_MAX)
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

  /**
   * Change qty / price / triggerPrice of a resting order in place
   * (/v5/order/amend). The venue requires the symbol; ctx or a
   * "<category>:<symbol>:<id>" composite id supplies it.
   */
  async amendOrder(
    orderId: string,
    ctx: OrderQueryContext,
    patch: BybitAmendPatch,
  ): Promise<{ orderId: string }> {
    const { category, symbol, rawId } = await this.locateOrder(orderId, ctx)
    const instrument = await this.getInstrument(symbol, category).catch(() => null)
    const body: Record<string, any> = { category, symbol, orderId: rawId }
    if (patch.quantity !== undefined) body.qty = this.formatQty(patch.quantity, instrument)
    if (patch.price !== undefined) body.price = this.formatPrice(patch.price, instrument)
    if (patch.triggerPrice !== undefined) body.triggerPrice = this.formatPrice(patch.triggerPrice, instrument)
    if (Object.keys(body).length === 3) throw new Error('amendOrder: nothing to amend')
    const res = await this.signedPost<any>('/v5/order/amend', body)
    return { orderId: String(res?.orderId ?? rawId) }
  }

  async cancelOrder(orderId: string, ctx: OrderQueryContext = {}): Promise<void> {
    try {
      // Bybit v5 /order/cancel REQUIRES symbol. placeOrder returns the bare id, so
      // take symbol/category from ctx, then a "<category>:<symbol>:<orderId>"
      // composite id, and finally resolve it from the live order — never send ''.
      const { category, symbol, rawId } = await this.locateOrder(orderId, ctx)
      const body: Record<string, any> = { category, symbol, orderId: rawId }
      // Spot cancel defaults to plain orders; a resting conditional needs the filter.
      const filter = ctx.orderFilter
      if (category === 'spot' && filter) body.orderFilter = filter
      await this.signedPost('/v5/order/cancel', body)
    } catch (error: any) {
      console.error('Failed to cancel Bybit order:', error)
      throw new Error(`Failed to cancel order: ${error.message}`)
    }
  }

  private async locateOrder(
    orderId: string,
    ctx: OrderQueryContext,
  ): Promise<{ category: BybitCategory; symbol: string; rawId: string }> {
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
    return { category, symbol: symbol.toUpperCase(), rawId }
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
   * Query an order's current state by id for the settlement poller.
   * /v5/order/realtime covers open + the last 500 closed orders; anything
   * older (a stop that filled days before a restart) comes from
   * /v5/order/history. 'unknown' + absenceConfirmed only when both answered.
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
    let lookupSucceeded = true
    for (const path of ['/v5/order/realtime', '/v5/order/history']) {
      for (const settleCoin of settleCoins) {
        const params: Record<string, any> = clientId
          ? { category, orderLinkId: this.sanitizeOrderLinkId(clientId) }
          : { category, orderId }
        if (ctx.symbol) params.symbol = ctx.symbol.toUpperCase()
        else if (settleCoin) params.settleCoin = settleCoin
        const filter = ctx.orderFilter
        if (filter) params.orderFilter = filter

        try {
          const res = await this.signedGet<any>(path, params)
          const order = clientId
            ? res?.list?.find((o: any) => String(o.orderLinkId) === String(params.orderLinkId))
            : res?.list?.find((o: any) => String(o.orderId) === String(orderId))
          if (!order) continue
          return this.orderRowToStatus(orderId, order)
        } catch {
          lookupSucceeded = false
        }
      }
    }
    return { orderId, state: 'unknown', absenceConfirmed: lookupSucceeded }
  }

  private orderRowToStatus(orderId: string, order: any): OrderStatus {
    const state = this.mapToStatusState(order.orderStatus)
    const filledAt = num(order.updatedTime)
    return {
      orderId,
      state,
      filledQuantity: num(order.cumExecQty) ?? 0,
      averagePrice: num(order.avgPrice) ?? 0,
      commission: this.feeOf(order),
      filledAtMs: state === 'filled' && filledAt ? filledAt : undefined,
      raw: order,
    }
  }

  // linear/spot on a UTA report fees in cumFeeDetail ({coin: fee}); the
  // legacy cumExecFee still comes for inverse.
  private feeOf(order: any): number {
    const legacy = num(order.cumExecFee)
    if (legacy != null && legacy !== 0) return legacy
    const detail = order.cumFeeDetail
    if (detail && typeof detail === 'object') {
      let sum = 0
      for (const v of Object.values(detail)) sum += num(v) ?? 0
      return sum
    }
    return legacy ?? 0
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

  /**
   * Every resting order (plain + conditional) of the account. One symbol when
   * given, else the USDT + USDC linear pools and inverse. The ops
   * open-orders view verifies the venue against the local bracket book.
   */
  async getOpenOrders(ctx?: { symbol?: string }): Promise<OpenOrder[]> {
    const pools: Array<Record<string, any>> = ctx?.symbol
      ? [{ category: this.resolveCategory(ctx.symbol), symbol: ctx.symbol.toUpperCase() }]
      : [
          { category: 'linear', settleCoin: 'USDT' },
          { category: 'linear', settleCoin: 'USDC' },
          { category: 'inverse' },
          // Collateral-floor sells rest here as spot conditionals.
          { category: 'spot', orderFilter: 'StopOrder' },
        ]
    const byId = new Map<string, OpenOrder>()
    for (const pool of pools) {
      const rows = await this.paginate<any>('/v5/order/realtime', { ...pool, openOnly: 0, limit: 50 }).catch(
        (e) => {
          if (ctx?.symbol) throw e
          return []
        },
      )
      for (const o of rows) {
        const id = String(o.orderId ?? '')
        if (!id) continue
        const conditional = !!o.stopOrderType && o.stopOrderType !== 'UNKNOWN'
        const base = String(o.orderType ?? '').toLowerCase()
        byId.set(id, {
          orderId: id,
          symbol: String(o.symbol ?? ctx?.symbol ?? ''),
          side: o.side === 'Sell' ? 'sell' : 'buy',
          type: conditional ? (base === 'market' ? 'stop_market' : 'stop_limit') : base || 'unknown',
          amount: num(o.qty) ?? 0,
          price: num(o.price) || null,
          triggerPrice: num(o.triggerPrice) || null,
          reduceOnly: o.reduceOnly === true,
          label: typeof o.orderLinkId === 'string' && o.orderLinkId ? o.orderLinkId : null,
          state: String(o.orderStatus ?? 'New'),
          createdAtMs: num(o.createdTime),
          raw: o,
        })
      }
    }
    return [...byId.values()]
  }

  /** Fills (and funding/ADL rows) from /v5/execution/list, newest first. */
  async getExecutions(opts: {
    symbol?: string
    category?: BybitCategory
    startTimeMs?: number
    endTimeMs?: number
    orderId?: string
    limit?: number
  } = {}): Promise<BybitExecution[]> {
    const category = opts.category ?? (opts.symbol ? this.resolveCategory(opts.symbol) : 'linear')
    const params: Record<string, any> = {
      category,
      symbol: opts.symbol?.toUpperCase(),
      startTime: opts.startTimeMs,
      endTime: opts.endTimeMs,
      orderId: opts.orderId,
      limit: Math.min(opts.limit ?? 50, 100),
    }
    const rows = await this.paginate<any>('/v5/execution/list', params, opts.limit ?? 50)
    return rows.map((r) => ({
      execId: String(r.execId ?? ''),
      orderId: String(r.orderId ?? ''),
      orderLinkId: typeof r.orderLinkId === 'string' && r.orderLinkId ? r.orderLinkId : null,
      symbol: String(r.symbol ?? ''),
      side: r.side === 'Sell' ? 'sell' : 'buy',
      price: num(r.execPrice) ?? 0,
      qty: num(r.execQty) ?? 0,
      fee: num(r.execFee) ?? 0,
      feeCurrency: typeof r.feeCurrency === 'string' && r.feeCurrency ? r.feeCurrency : null,
      execType: String(r.execType ?? ''),
      isMaker: r.isMaker === true,
      timeMs: num(r.execTime) ?? 0,
      raw: r,
    }))
  }

  // Cursor pagination over a list endpoint; a page cap keeps a runaway
  // cursor from looping forever.
  private async paginate<T>(path: string, params: Record<string, any>, max = 1000): Promise<T[]> {
    const out: T[] = []
    let cursor: string | undefined
    for (let page = 0; page < 20; page++) {
      const res = await this.signedGet<any>(path, { ...params, cursor })
      const list: T[] = Array.isArray(res?.list) ? res.list : []
      out.push(...list)
      cursor = typeof res?.nextPageCursor === 'string' && res.nextPageCursor ? res.nextPageCursor : undefined
      if (!cursor || list.length === 0 || out.length >= max) break
    }
    return out.slice(0, max)
  }

  // --- internals ---

  resolveCategory(symbol: string, hint?: string): BybitCategory {
    if (hint === 'linear' || hint === 'inverse' || hint === 'spot') return hint
    const s = symbol.toUpperCase()
    if (s.endsWith('USDT') || s.endsWith('USDC')) return 'linear'
    // USDC-settled perps use the bare PERP suffix (BTCPERP, SOLPERP).
    if (s.endsWith('PERP')) return 'linear'
    // Inverse: BTCUSD perps and dated BTCUSDH25/M25/U25/Z25.
    if (s.endsWith('USD') || /USD[HMUZ]\d{2}$/.test(s)) return 'inverse'
    return 'linear'
  }

  private async verifyCredentials(): Promise<void> {
    // /v5/account/info requires private auth, cheap round-trip; it also says
    // whether this is a UTA (unifiedMarginStatus >= 3) or a classic account.
    const info = await this.signedGet<any>('/v5/account/info', {})
    const status = Number(info?.unifiedMarginStatus)
    if (Number.isFinite(status) && status > 0) this.unifiedAccount = status >= 3
    if (typeof info?.marginMode === 'string') this.marginMode = info.marginMode
  }

  private sign(payload: string): { sign: string; timestamp: string; recvWindow: string } {
    if (!this.credentials) throw new Error('Not authenticated')
    const timestamp = String(this.now())
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

  private async parseResponse<T>(res: Response, path: string): Promise<T> {
    let data: BybitResponse<T> | undefined
    try {
      data = (await res.json()) as BybitResponse<T>
    } catch {
      // A WAF/CDN page instead of JSON: keep the HTTP status, drop the HTML.
      throw new Error(`Bybit ${path} failed: HTTP ${res.status} (non-JSON body)`)
    }
    if (!res.ok || data.retCode !== 0) {
      const code = Number(data?.retCode ?? res.status)
      const msg = data?.retMsg || `HTTP ${res.status}`
      throw new BybitApiError(code, code === RET_RATE_LIMITED ? `rate limited: ${msg}` : msg, path)
    }
    return data.result
  }

  private async signedGet<T = any>(path: string, params: Record<string, any>, retried = false): Promise<T> {
    if (!this.credentials) throw new Error('Not authenticated')
    // The signed string and the URL must be the same bytes.
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

    try {
      return await this.parseResponse<T>(res, path)
    } catch (e) {
      if (!retried && (await this.resyncOnClockError(e))) return this.signedGet<T>(path, params, true)
      throw e
    }
  }

  private async signedPost<T = any>(
    path: string,
    body: Record<string, any>,
    // POSTs here are order mutations (create/cancel) → order-op timeout.
    timeout: FetchTimeoutKind = 'order',
    retried = false,
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

    try {
      return await this.parseResponse<T>(res, path)
    } catch (e) {
      // 10002 is rejected before the venue processes anything, so one retry
      // with a fresh clock offset cannot double-place.
      if (!retried && (await this.resyncOnClockError(e))) return this.signedPost<T>(path, body, timeout, true)
      throw e
    }
  }

  private async resyncOnClockError(e: unknown): Promise<boolean> {
    if (!(e instanceof BybitApiError) || e.retCode !== RET_TIMESTAMP_OUT_OF_WINDOW) return false
    try {
      await this.syncServerTime()
      return true
    } catch {
      return false
    }
  }

  // ── private WebSocket ──

  private connectWebSocket(): Promise<void> {
    if (!this.credentials) return Promise.reject(new Error('Not authenticated'))
    // Never two sockets: a reconnect on top of a half-dead socket is how the
    // Deribit reconnect storm of 2026-09-05 started.
    this.teardownWs()

    return new Promise((resolve, reject) => {
      const ws = this.createSocket(this.wsURL)
      this.ws = ws
      let settled = false
      const fail = (err: Error) => {
        if (settled) return
        settled = true
        clearTimeout(settleTimer)
        reject(err)
      }
      const settleTimer = setTimeout(() => {
        if (!settled) {
          fail(new Error('Bybit WebSocket auth timeout'))
          try {
            ws.terminate()
          } catch {}
        }
      }, 10000)

      ws.on('open', () => {
        try {
          ws.send(JSON.stringify(this.buildAuthMessage()))
        } catch (e) {
          fail(e as Error)
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
          if (msg.success) {
            settled = true
            clearTimeout(settleTimer)
            this.wsAuthenticated = true
            this.wsReconnectAttempts = 0
            this.lastPongAt = Date.now()
            ws.send(JSON.stringify({
              op: 'subscribe',
              args: ['order', 'execution', 'position', 'wallet'],
            }))
            this.startPingInterval()
            this.updateCallback?.({ type: 'account', data: { connected: true } })
            resolve()
          } else {
            fail(new Error(msg.ret_msg || 'Bybit WebSocket auth failed'))
          }
          return
        }

        // Private pong: {"op":"ping","ret_msg":"pong"}; public: {"op":"pong"}.
        if (msg.op === 'pong' || (msg.op === 'ping' && msg.ret_msg === 'pong')) {
          this.lastPongAt = Date.now()
          return
        }

        if (msg.topic) this.handleTopic(String(msg.topic), msg.data)
      })

      ws.on('error', (err) => {
        console.error('Bybit WebSocket error:', err?.message || err)
        this.updateCallback?.({ type: 'account', data: { connected: false, error: 'WebSocket error' } })
        fail(err instanceof Error ? err : new Error(String(err)))
      })

      ws.on('close', () => {
        fail(new Error('Bybit WebSocket closed before auth'))
        if (this.ws !== ws) return
        this.wsAuthenticated = false
        this.ws = undefined
        this.stopPingInterval()
        this.scheduleReconnect()
      })
    })
  }

  // Seam for tests (fake socket); production dials the real thing.
  protected createSocket(url: string): WebSocket {
    return new WebSocket(url)
  }

  buildAuthMessage(): { op: 'auth'; args: [string, number, string] } {
    if (!this.credentials) throw new Error('Not authenticated')
    const expires = this.now() + 10000
    const signature = crypto
      .createHmac('sha256', this.credentials.apiSecret)
      .update(`GET/realtime${expires}`)
      .digest('hex')
    return { op: 'auth', args: [this.credentials.apiKey, expires, signature] }
  }

  // Topic rows reach the executor normalised: the OCO handler in main.ts reads
  // `orderId` + `state` ('filled' | 'cancelled' | ...), never venue enums.
  private handleTopic(topic: string, data: unknown): void {
    if (!this.updateCallback) return
    const rows: any[] = Array.isArray(data) ? data : data ? [data] : []
    if (topic === 'wallet') {
      this.updateCallback({ type: 'balance', data })
    } else if (topic.startsWith('position')) {
      this.updateCallback({ type: 'position', data })
    } else if (topic.startsWith('order')) {
      this.updateCallback({ type: 'order', data: rows.map((o) => this.normaliseOrderRow(o)) })
    } else if (topic.startsWith('execution')) {
      this.updateCallback({
        type: 'execution',
        data: rows.map((r) => ({
          execId: String(r.execId ?? ''),
          orderId: String(r.orderId ?? ''),
          orderLinkId: typeof r.orderLinkId === 'string' && r.orderLinkId ? r.orderLinkId : null,
          symbol: String(r.symbol ?? ''),
          side: r.side === 'Sell' ? 'sell' : 'buy',
          price: num(r.execPrice) ?? 0,
          qty: num(r.execQty) ?? 0,
          fee: num(r.execFee) ?? 0,
          execType: String(r.execType ?? ''),
          timeMs: num(r.execTime) ?? 0,
          raw: r,
        })),
      })
    }
  }

  normaliseOrderRow(o: any): {
    orderId: string
    orderLinkId: string | null
    state: OrderStatus['state']
    orderStatus: string
    symbol: string
    category: string
    side: 'buy' | 'sell'
    filledQuantity: number
    averagePrice: number
    raw: any
  } {
    return {
      orderId: String(o.orderId ?? ''),
      orderLinkId: typeof o.orderLinkId === 'string' && o.orderLinkId ? o.orderLinkId : null,
      state: this.mapToStatusState(String(o.orderStatus ?? '')),
      orderStatus: String(o.orderStatus ?? ''),
      symbol: String(o.symbol ?? ''),
      category: String(o.category ?? ''),
      side: o.side === 'Sell' ? 'sell' : 'buy',
      filledQuantity: num(o.cumExecQty) ?? 0,
      averagePrice: num(o.avgPrice) ?? 0,
      raw: o,
    }
  }

  private startPingInterval(): void {
    this.stopPingInterval()
    this.pingInterval = setInterval(() => {
      const ws = this.ws
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      if (this.lastPongAt && Date.now() - this.lastPongAt > WS_PONG_GRACE_MS) {
        // Silent socket: terminate → 'close' → reconnect with backoff.
        console.warn('Bybit WebSocket: no pong, terminating')
        try {
          ws.terminate()
        } catch {}
        return
      }
      ws.send(JSON.stringify({ op: 'ping' }))
    }, WS_PING_MS)
  }

  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = undefined
    }
  }

  // Detach + terminate the current socket so its late events reach nobody.
  private teardownWs(): void {
    this.stopPingInterval()
    const ws = this.ws
    this.ws = undefined
    this.wsAuthenticated = false
    if (!ws) return
    try {
      ws.removeAllListeners()
      ws.on('error', () => {})
      ws.terminate()
    } catch {}
  }

  wsReconnectDelayMs(): number {
    return Math.min(WS_RECONNECT_BASE_MS * 2 ** this.wsReconnectAttempts, WS_RECONNECT_MAX_MS)
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout || !this.credentials) return
    const delay = this.wsReconnectDelayMs()
    this.wsReconnectAttempts++
    this.reconnectTimeout = setTimeout(async () => {
      this.reconnectTimeout = undefined
      if (!this.credentials) return
      try {
        await this.connectWebSocket()
      } catch (err: any) {
        console.error('Bybit WS reconnect failed:', err?.message || err)
        this.scheduleReconnect()
      }
    }, delay)
  }
}

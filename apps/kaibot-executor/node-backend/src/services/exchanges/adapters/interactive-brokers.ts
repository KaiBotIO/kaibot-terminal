/**
 * Interactive Brokers adapter — @stoqey/ib (TWS API client)
 *
 * SETUP (required):
 * 1. Install and launch Trader Workstation (TWS) OR IB Gateway on the machine running the executor
 *    - Download: https://www.interactivebrokers.com/en/trading/tws.php
 *    - For headless/server use, prefer IB Gateway
 * 2. Enable API access in TWS/Gateway:
 *    - TWS: File → Global Configuration → API → Settings → "Enable ActiveX and Socket Clients"
 *    - Uncheck "Read-Only API" if you want to place orders
 *    - Add 127.0.0.1 to "Trusted IPs"
 * 3. Default ports:
 *    - TWS Live:     7496
 *    - TWS Paper:    7497  ← recommended for MVP
 *    - Gateway Live: 4001
 *    - Gateway Paper:4002
 * 4. MVP scope: STK (stocks) only, SMART routing, USD. Paper account.
 *
 * NOTES:
 * - @stoqey/ib speaks the native TWS binary protocol via TCP sockets. It works under Bun
 *   because it relies on Node's `net` module which Bun implements.
 * - All requests are stateful and keyed by a monotonically increasing `reqId`. We track
 *   pending requests in maps and resolve/reject them from event handlers.
 * - Connection errors surface via the `error` event with (id, code, message). Non-fatal
 *   codes (2104/2106/2158 market data farm status) are informational and ignored.
 */

import {
  IBApi,
  EventName,
  Contract,
  Stock,
  MarketOrder,
  LimitOrder,
  StopOrder,
  StopLimitOrder,
  OrderAction,
  SecType,
  isNonFatalError,
  ErrorCode,
} from '@stoqey/ib'
import {
  ExchangeAdapter,
  ExchangeCredentials,
  Account,
  Balance,
  Position,
  Order,
  OrderResult,
  UpdateCallback,
} from '../types.js'

interface IBCredentials extends ExchangeCredentials {
  type: 'apiKey'
  host?: string
  port?: number
  clientId?: number
  paper?: boolean
}

type Resolver<T> = {
  resolve: (value: T) => void
  reject: (err: Error) => void
  buffer?: any
}

export class InteractiveBrokersAdapter implements ExchangeAdapter {
  name = 'interactive-brokers'

  private ib?: IBApi
  private credentials?: IBCredentials
  private updateCallback?: UpdateCallback
  private connected = false
  private nextReqId = 1000
  private nextOrderId = 1
  private managedAccounts: string[] = []

  private pendingManagedAccts: Resolver<string[]>[] = []
  private pendingAccountSummary = new Map<number, Resolver<Record<string, Record<string, { value: string; currency: string }>>>>()
  private pendingPositions: Resolver<Array<{ account: string; contract: Contract; pos: number; avgCost?: number }>>[] = []
  private pendingOrders = new Map<number, Resolver<OrderResult>>()

  async connect(credentials: ExchangeCredentials): Promise<void> {
    if (credentials.type !== 'apiKey') {
      throw new Error('Interactive Brokers adapter expects type="apiKey" (used as a plain config channel, no actual API key)')
    }

    this.credentials = credentials as IBCredentials

    const host = this.credentials.host || '127.0.0.1'
    const port = this.credentials.port ?? (this.credentials.paper ? 7497 : 7496)
    const clientId = this.credentials.clientId ?? 1

    this.ib = new IBApi({ host, port })

    this.registerEventHandlers()

    return new Promise<void>((resolve, reject) => {
      let settled = false

      const onConnected = () => {
        if (settled) return
        settled = true
        this.connected = true
        console.log(`[IB] Connected to ${host}:${port} (clientId=${clientId})`)
        this.ib!.removeListener(EventName.connected, onConnected)
        this.ib!.removeListener(EventName.error, onConnectError)
        this.updateCallback?.({
          type: 'account',
          data: { connected: true, host, port },
        })
        resolve()
      }

      const onConnectError = (err: Error, code: ErrorCode, _reqId: number) => {
        if (settled) return
        if (isNonFatalError(code, err)) return
        settled = true
        this.ib!.removeListener(EventName.connected, onConnected)
        this.ib!.removeListener(EventName.error, onConnectError)
        reject(new Error(`IB connect failed: ${err.message} (code=${code})`))
      }

      this.ib!.on(EventName.connected, onConnected)
      this.ib!.on(EventName.error, onConnectError)

      setTimeout(() => {
        if (!settled) {
          settled = true
          this.ib!.removeListener(EventName.connected, onConnected)
          this.ib!.removeListener(EventName.error, onConnectError)
          reject(new Error(`IB connect timeout after 10s — is TWS/Gateway running at ${host}:${port}?`))
        }
      }, 10000)

      try {
        this.ib!.connect(clientId)
      } catch (err: any) {
        settled = true
        reject(new Error(`IB connect threw: ${err.message}`))
      }
    })
  }

  async disconnect(): Promise<void> {
    if (this.ib && this.connected) {
      try {
        this.ib.disconnect()
      } catch (err) {
        console.warn('[IB] disconnect error:', err)
      }
    }
    this.connected = false
    this.ib = undefined
    this.managedAccounts = []
    this.pendingManagedAccts = []
    this.pendingAccountSummary.clear()
    this.pendingPositions = []
    this.pendingOrders.clear()
  }

  async refreshSession(): Promise<void> {
    // TWS/Gateway sessions are TCP sockets — no refresh concept. We re-connect if needed.
    if (!this.connected && this.credentials) {
      await this.connect(this.credentials)
    }
  }

  async getAccounts(): Promise<Account[]> {
    this.assertConnected()
    const accounts = await this.requestManagedAccts()
    return accounts.map((accountId) => ({
      id: `ib:${accountId}`,
      exchangeName: this.name,
      accountId,
      accountType: 'brokerage',
      name: `IB ${accountId}`,
      currency: 'USD',
    }))
  }

  async getBalances(): Promise<Balance[]> {
    this.assertConnected()
    const accounts = await this.requestManagedAccts()
    const reqId = this.nextReqId++
    const tags = 'NetLiquidation,TotalCashValue,RealizedPnL,UnrealizedPnL,InitMarginReq,MaintMarginReq'

    const rows = await new Promise<Record<string, Record<string, { value: string; currency: string }>>>((resolve, reject) => {
      this.pendingAccountSummary.set(reqId, { resolve, reject, buffer: {} })

      try {
        this.ib!.reqAccountSummary(reqId, 'All', tags)
      } catch (err: any) {
        this.pendingAccountSummary.delete(reqId)
        reject(new Error(`reqAccountSummary failed: ${err.message}`))
        return
      }

      setTimeout(() => {
        if (this.pendingAccountSummary.has(reqId)) {
          const pending = this.pendingAccountSummary.get(reqId)!
          this.pendingAccountSummary.delete(reqId)
          try {
            this.ib!.cancelAccountSummary(reqId)
          } catch { /* ignore */ }
          pending.resolve(pending.buffer || {})
        }
      }, 5000)
    })

    const balances: Balance[] = []
    for (const accountId of accounts) {
      const row = rows[accountId] || {}
      const parse = (tag: string) => parseFloat(row[tag]?.value || '0')
      balances.push({
        accountId,
        balance: parse('TotalCashValue'),
        equity: parse('NetLiquidation'),
        realizedPnL: parse('RealizedPnL'),
        unrealizedPnL: parse('UnrealizedPnL'),
        initialMargin: parse('InitMarginReq'),
        maintenanceMargin: parse('MaintMarginReq'),
        currency: row['NetLiquidation']?.currency || 'USD',
        timestamp: Date.now(),
      })
    }
    return balances
  }

  async getPositions(): Promise<Position[]> {
    this.assertConnected()
    const rows = await this.requestPositions()
    return rows
      .filter((r) => r.pos !== 0)
      .map((r) => ({
        id: `ib:${r.account}:${r.contract.symbol}`,
        accountId: r.account,
        symbol: r.contract.symbol || 'UNKNOWN',
        side: r.pos > 0 ? 'long' : 'short',
        size: Math.abs(r.pos),
        entryPrice: r.avgCost || 0,
        marginType: 'cash',
        leverage: 1,
      }))
  }

  async placeOrder(order: Order): Promise<OrderResult> {
    this.assertConnected()

    const contract: Contract = new Stock(order.symbol, 'SMART', 'USD')
    contract.secType = SecType.STK

    const action: OrderAction = order.side === 'buy' ? OrderAction.BUY : OrderAction.SELL

    let ibOrder: any
    switch (order.orderType) {
      case 'market':
        ibOrder = new MarketOrder(action, order.quantity)
        break
      case 'limit':
        if (order.price == null) throw new Error('limit order requires price')
        ibOrder = new LimitOrder(action, order.price, order.quantity)
        break
      case 'stop':
        if (order.stopPrice == null) throw new Error('stop order requires stopPrice')
        ibOrder = new StopOrder(action, order.stopPrice, order.quantity)
        break
      case 'stopLimit':
        if (order.price == null || order.stopPrice == null) throw new Error('stopLimit order requires price and stopPrice')
        ibOrder = new StopLimitOrder(action, order.price, order.stopPrice, order.quantity)
        break
      default:
        throw new Error(`Unsupported order type: ${order.orderType}`)
    }

    if (order.accountId) {
      ibOrder.account = order.accountId
    }

    const orderId = this.nextOrderId++

    return new Promise<OrderResult>((resolve, reject) => {
      let settled = false

      const pending: Resolver<OrderResult> = {
        resolve: (v) => {
          if (settled) return
          settled = true
          this.pendingOrders.delete(orderId)
          resolve(v)
        },
        reject: (e) => {
          if (settled) return
          settled = true
          this.pendingOrders.delete(orderId)
          reject(e)
        },
      }
      this.pendingOrders.set(orderId, pending)

      try {
        this.ib!.placeOrder(orderId, contract, ibOrder)
      } catch (err: any) {
        pending.reject(new Error(`placeOrder failed: ${err.message}`))
        return
      }

      setTimeout(() => {
        if (!settled) {
          pending.resolve({
            orderId: String(orderId),
            status: 'pending',
            filledQuantity: 0,
            averagePrice: 0,
            message: 'submitted (no status yet)',
          })
        }
      }, 3000)
    })
  }

  async cancelOrder(orderId: string): Promise<void> {
    this.assertConnected()
    const id = parseInt(orderId, 10)
    if (Number.isNaN(id)) throw new Error(`Invalid IB orderId: ${orderId}`)
    this.ib!.cancelOrder(id)
  }

  subscribeToUpdates(callback: UpdateCallback): void {
    this.updateCallback = callback
  }

  unsubscribeFromUpdates(): void {
    this.updateCallback = undefined
  }

  private assertConnected(): void {
    if (!this.ib || !this.connected) {
      throw new Error('IB adapter not connected — call connect() first')
    }
  }

  private registerEventHandlers(): void {
    if (!this.ib) return

    this.ib.on(EventName.managedAccounts, (accountsList: string) => {
      const accounts = accountsList.split(',').map((a) => a.trim()).filter(Boolean)
      this.managedAccounts = accounts
      const waiters = this.pendingManagedAccts
      this.pendingManagedAccts = []
      for (const w of waiters) w.resolve(accounts)
    })

    this.ib.on(EventName.nextValidId, (orderId: number) => {
      if (orderId > this.nextOrderId) this.nextOrderId = orderId
    })

    this.ib.on(
      EventName.accountSummary,
      (reqId: number, account: string, tag: string, value: string, currency: string) => {
        const pending = this.pendingAccountSummary.get(reqId)
        if (!pending) return
        const buf = pending.buffer as Record<string, Record<string, { value: string; currency: string }>>
        if (!buf[account]) buf[account] = {}
        buf[account][tag] = { value, currency }
      }
    )

    this.ib.on(EventName.accountSummaryEnd, (reqId: number) => {
      const pending = this.pendingAccountSummary.get(reqId)
      if (!pending) return
      this.pendingAccountSummary.delete(reqId)
      try {
        this.ib!.cancelAccountSummary(reqId)
      } catch { /* ignore */ }
      pending.resolve(pending.buffer || {})
    })

    this.ib.on(
      EventName.position,
      (account: string, contract: Contract, pos: number, avgCost?: number) => {
        const waiters = this.pendingPositions
        for (const w of waiters) {
          const buf = (w.buffer ||= [] as any[])
          buf.push({ account, contract, pos, avgCost })
        }
        this.updateCallback?.({
          type: 'position',
          data: {
            account,
            symbol: contract.symbol,
            size: pos,
            avgCost,
          },
        })
      }
    )

    this.ib.on(EventName.positionEnd, () => {
      const waiters = this.pendingPositions
      this.pendingPositions = []
      try {
        this.ib!.cancelPositions()
      } catch { /* ignore */ }
      for (const w of waiters) w.resolve(w.buffer || [])
    })

    this.ib.on(
      EventName.orderStatus,
      (
        id: number,
        status: string,
        filled: number,
        remaining: number,
        avgFillPrice: number,
      ) => {
        const pending = this.pendingOrders.get(id)
        if (pending && (status === 'Filled' || status === 'Cancelled' || status === 'Submitted' || status === 'PreSubmitted')) {
          pending.resolve({
            orderId: String(id),
            status: this.mapOrderStatus(status),
            filledQuantity: filled,
            averagePrice: avgFillPrice || 0,
            message: status,
          })
        }
        this.updateCallback?.({
          type: 'order',
          data: { orderId: id, status, filled, remaining, avgFillPrice },
        })
      }
    )

    this.ib.on(EventName.error, (err: Error, code: ErrorCode, reqId: number) => {
      if (isNonFatalError(code, err)) return
      console.error(`[IB] error (reqId=${reqId}, code=${code}):`, err.message)

      if (reqId > 0) {
        const pendingSummary = this.pendingAccountSummary.get(reqId)
        if (pendingSummary) {
          this.pendingAccountSummary.delete(reqId)
          pendingSummary.reject(new Error(`IB error ${code}: ${err.message}`))
          return
        }
        const pendingOrder = this.pendingOrders.get(reqId)
        if (pendingOrder) {
          pendingOrder.reject(new Error(`IB order error ${code}: ${err.message}`))
          return
        }
      }
    })

    this.ib.on(EventName.disconnected, () => {
      console.log('[IB] disconnected')
      this.connected = false
      this.updateCallback?.({
        type: 'account',
        data: { connected: false },
      })
    })
  }

  private requestManagedAccts(): Promise<string[]> {
    if (this.managedAccounts.length > 0) {
      return Promise.resolve(this.managedAccounts)
    }
    return new Promise<string[]>((resolve, reject) => {
      this.pendingManagedAccts.push({ resolve, reject })
      try {
        this.ib!.reqManagedAccts()
      } catch (err: any) {
        reject(new Error(`reqManagedAccts failed: ${err.message}`))
        return
      }
      setTimeout(() => {
        const idx = this.pendingManagedAccts.findIndex((w) => w.resolve === resolve)
        if (idx >= 0) {
          this.pendingManagedAccts.splice(idx, 1)
          reject(new Error('reqManagedAccts timeout'))
        }
      }, 5000)
    })
  }

  private requestPositions(): Promise<Array<{ account: string; contract: Contract; pos: number; avgCost?: number }>> {
    return new Promise((resolve, reject) => {
      const waiter: Resolver<any[]> = { resolve, reject, buffer: [] }
      this.pendingPositions.push(waiter)
      try {
        this.ib!.reqPositions()
      } catch (err: any) {
        const idx = this.pendingPositions.indexOf(waiter)
        if (idx >= 0) this.pendingPositions.splice(idx, 1)
        reject(new Error(`reqPositions failed: ${err.message}`))
        return
      }
      setTimeout(() => {
        const idx = this.pendingPositions.indexOf(waiter)
        if (idx >= 0) {
          this.pendingPositions.splice(idx, 1)
          try { this.ib!.cancelPositions() } catch { /* ignore */ }
          resolve(waiter.buffer || [])
        }
      }, 5000)
    })
  }

  private mapOrderStatus(state: string): OrderResult['status'] {
    const map: Record<string, OrderResult['status']> = {
      PendingSubmit: 'pending',
      PendingCancel: 'pending',
      PreSubmitted: 'pending',
      Submitted: 'pending',
      ApiCancelled: 'cancelled',
      Cancelled: 'cancelled',
      Filled: 'filled',
      Inactive: 'rejected',
    }
    return map[state] || 'pending'
  }
}

// Viewer account scoping end to end over the real routes and a real DB: a
// viewer sees only the accounts the admin granted (Kai, 05/10/2026: Kay sees
// TradeStation 933/936 and both Deribit connections, never 931 or Bybit).
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Hono } from 'hono'
import { KaiBotDatabase } from '../storage/database.js'
import { createRoleMiddleware } from '../auth/roles.js'
import { canSeeAccount, scopeForUser } from '../auth/account-scope.js'
import { notificationVisible } from '../auth/notification-scope.js'
import { createExchangeRoutes } from './exchanges/index.js'
import { createOperationsRoutes } from './operations.js'
import { createSubscriptionRoutes } from './subscriptions.js'
import { createSyntheticUsdRoutes } from './synthetic-usd.js'
import { createUserRoutes } from './users.js'
import { createBotRoutes } from './bots.js'
import { createManualTradeRoutes } from './manual-trade.js'
import { NotificationBus, type NotificationEvent } from '../services/notifications/notification-bus.js'
import type { ExchangeManager } from '../services/exchanges/exchangeManager.js'
import type { AccountGrant, UserRole } from '../storage/types.js'

const KAY_GRANTS: AccountGrant[] = [
  { exchange: 'tradestation', kind: 'account', ref: '21084933' },
  { exchange: 'tradestation', kind: 'account', ref: '21084936' },
  { exchange: 'deribit', kind: 'connection', ref: 'default' },
  { exchange: 'deribit', kind: 'connection', ref: 'acct1' },
]

function adapter(accounts: string[], positions: Array<{ accountId: string; symbol: string }>) {
  return {
    orders: 0,
    async getAccounts() {
      return accounts.map((accountId) => ({ accountId, name: accountId, currency: 'USD' }))
    },
    async getBalances() {
      return accounts.map((accountId) => ({
        accountId,
        balance: 1000,
        equity: 1000,
        realizedPnL: 0,
        unrealizedPnL: 0,
        currency: 'USD',
        timestamp: 0,
      }))
    },
    async getPositions() {
      return positions.map((p) => ({
        id: `${p.symbol}@${p.accountId}`,
        accountId: p.accountId,
        symbol: p.symbol,
        side: 'long',
        size: 1,
        entryPrice: 100,
        markPrice: 101,
        unrealizedPnL: 1,
      }))
    },
    async placeOrder() {
      this.orders++
      return { orderId: 'x' }
    },
    async getOpenOrders() {
      return []
    },
  }
}

function session(exchangeName: string, label: string, a: ReturnType<typeof adapter>) {
  return {
    userId: 'default',
    exchangeName,
    label,
    accountKey: label === 'default' ? undefined : label,
    connectionId: label === 'default' ? `default:${exchangeName}` : `default:${exchangeName}:${label}`,
    status: 'connected' as const,
    lastRefresh: 0,
    adapter: a as any,
  }
}

const tsAdapter = adapter(['21084931', '21084933', '21084936'], [
  { accountId: '21084931', symbol: 'MNQZ26' },
  { accountId: '21084933', symbol: 'MGCZ26' },
])
const SESSIONS = [
  session('tradestation', 'default', tsAdapter),
  session('deribit', 'default', adapter(['btc'], [{ accountId: 'btc', symbol: 'BTC-PERPETUAL' }])),
  session('deribit', 'acct1', adapter(['acct1/btc'], [{ accountId: 'acct1/btc', symbol: 'BTC-PERPETUAL' }])),
  session('bybit', 'default', adapter(['unified'], [{ accountId: 'unified', symbol: 'SOLUSDT' }])),
]

const manager = {
  getAllSessions: async () => SESSIONS,
  getSessions: async (_u: string, ex: string) => SESSIONS.filter((s) => s.exchangeName === ex),
  getSession: async (_u: string, ex: string, key?: string) =>
    SESSIONS.find((s) => s.exchangeName === ex && s.label === (key || 'default')),
  sessionForAccount: async () => undefined,
} as unknown as ExchangeManager

let dir: string
let db: KaiBotDatabase
let kayId: number
let emptyId: number

function appAs(role: UserRole, userId: number) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('role', role)
    c.set('userId', userId)
    c.set('accountScope', scopeForUser(db, userId, role))
    return next()
  })
  app.use('/api/*', createRoleMiddleware())
  app.route('/api/exchanges/v2', createExchangeRoutes(db, manager))
  app.route('/api/ops', createOperationsRoutes(db, manager))
  app.route('/api/subscriptions', createSubscriptionRoutes(db, undefined, manager))
  app.route('/api/synthetic-usd', createSyntheticUsdRoutes(db, manager))
  app.route('/api/auth/users', createUserRoutes(db))
  app.route('/api/bots', createBotRoutes(db))
  app.route('/api/trade', createManualTradeRoutes(db, manager))
  return app
}

function seedExecution(signalId: string, exchange: string, accountId: string, symbol: string) {
  db.insertSignalExecution({ signalId, symbol, exchange, direction: 'long', status: 'open', qtyOpened: 1, accountId })
  db.insertSignalFill({ signalId, kind: 'entry', symbol, side: 'buy', qty: 1, price: 100 })
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-viewer-scope-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
  await db.createAdminUser('kai', 'admin-password')
  kayId = (await db.createViewerUser('kay', 'viewer-pass-1')).id
  emptyId = (await db.createViewerUser('nobody', 'viewer-pass-2')).id
  db.setAccountGrants(kayId, KAY_GRANTS)

  seedExecution('sig-931', 'tradestation', '21084931', 'MNQZ26')
  seedExecution('sig-933', 'tradestation', '21084933', 'MGCZ26')
  seedExecution('sig-acct1', 'deribit', 'acct1/btc', 'BTC-PERPETUAL')
  seedExecution('sig-bybit', 'bybit', 'unified', 'SOLUSDT')
  db.upsertSubscription({ id: 'sub-931', signalBotId: 'bot-a', factor: 1, exchange: 'tradestation', accountId: '21084931' })
  db.upsertSubscription({ id: 'sub-933', signalBotId: 'bot-b', factor: 1, exchange: 'tradestation', accountId: '21084933' })
  db.upsertSubscription({ id: 'sub-bybit', signalBotId: 'bot-c', factor: 1, exchange: 'bybit', accountId: 'unified' })
  const synth = { target_usd: 1000, holdings_basis_usd: 1000, leverage: 1, short_size: 1000, leverage_cap: 10 }
  db.insertSyntheticUsdPosition({ id: 'syn-deribit', exchange: 'deribit', account_id: 'btc', symbol: 'BTC-PERPETUAL', ...synth })
  db.insertSyntheticUsdPosition({ id: 'syn-bybit', exchange: 'bybit', account_id: 'unified', symbol: 'BTCUSDT', ...synth })
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const getJson = async (app: Hono, path: string, status = 200) => {
  const res = await app.request(path)
  expect(res.status).toBe(status)
  return (await res.json()) as any
}

describe('viewer with a scope', () => {
  it('sees only its connections, accounts, balances and positions', async () => {
    const kay = appAs('viewer', kayId)
    const sessions = await getJson(kay, '/api/exchanges/v2/sessions')
    expect(sessions.map((s: any) => s.connectionId)).toEqual([
      'default:tradestation',
      'default:deribit',
      'default:deribit:acct1',
    ])
    const accounts = await getJson(kay, '/api/exchanges/v2/accounts/tradestation')
    expect(accounts.map((a: any) => a.accountId)).toEqual(['21084933', '21084936'])
    const balances = await getJson(kay, '/api/exchanges/v2/balances/tradestation')
    expect(balances.map((b: any) => b.accountId)).toEqual(['21084933', '21084936'])
    const positions = await getJson(kay, '/api/exchanges/v2/positions/tradestation')
    expect(positions.map((p: any) => p.accountId)).toEqual(['21084933'])
    const deribit = await getJson(kay, '/api/exchanges/v2/positions/deribit')
    expect(deribit.map((p: any) => p.accountId)).toEqual(['btc', 'acct1/btc'])
    await getJson(kay, '/api/exchanges/v2/positions/bybit', 404)
    await getJson(kay, '/api/exchanges/v2/bybit/details', 404)
    const details = await getJson(kay, '/api/exchanges/v2/tradestation/details')
    expect(details.balances.map((b: any) => b.accountId)).toEqual(['21084933', '21084936'])
    expect(details.positions.map((p: any) => p.accountId)).toEqual(['21084933'])
  })

  it('portfolio, fills, executions, subscriptions and synthetic rows stay on its accounts', async () => {
    const kay = appAs('viewer', kayId)
    const portfolio = await getJson(kay, '/api/ops/portfolio')
    expect(portfolio.exchanges.map((e: any) => e.exchange)).toEqual(['tradestation', 'deribit', 'deribit'])
    expect(portfolio.positions.map((p: any) => p.accountId).sort()).toEqual(['21084933', 'acct1/btc', 'btc'])
    expect(portfolio.syntheticUsd.positions.map((p: any) => p.id)).toEqual(['syn-deribit'])

    const fills = await getJson(kay, '/api/ops/fills')
    expect(fills.map((f: any) => f.signalId).sort()).toEqual(['sig-933', 'sig-acct1'])
    await getJson(kay, '/api/ops/executions/sig-931', 404)
    await getJson(kay, '/api/ops/executions/sig-bybit', 404)
    expect((await getJson(kay, '/api/ops/executions/sig-933')).execution.account_id).toBe('21084933')

    const lineage = await getJson(kay, '/api/ops/position-lineage')
    expect(lineage.lineages.map((l: any) => l.accountId).sort()).toEqual(['21084933', 'acct1/btc'])

    const subs = await getJson(kay, '/api/subscriptions')
    expect(subs.map((s: any) => s.id)).toEqual(['sub-933'])
    await getJson(kay, '/api/subscriptions/sub-931', 404)

    const synthetic = await getJson(kay, '/api/synthetic-usd')
    expect(synthetic.positions.map((p: any) => p.id)).toEqual(['syn-deribit'])
    await getJson(kay, '/api/synthetic-usd/syn-bybit', 404)
    await getJson(kay, '/api/synthetic-usd/syn-bybit/preflight', 404)
  })

  it('rides stay on its accounts', async () => {
    const seedRide = (id: string, exchange: string, accountId: string, symbol: string) => {
      db.recordSignal({ id, strategyId: 'discretionary', symbol, action: 'buy', metadata: { rideBotId: 'bot-r' } })
      db.insertSignalExecution({ signalId: id, symbol, exchange, direction: 'long', status: 'open', qtyOpened: 1, accountId })
      db.upsertServerExitState({ positionId: `pos-${id}`, entrySignalId: id, exchange, symbol, direction: 'long', currentStop: 90 })
    }
    seedRide('ride-933', 'tradestation', '21084933', 'MGCZ26')
    seedRide('ride-931', 'tradestation', '21084931', 'MNQZ26')
    seedRide('ride-bybit', 'bybit', 'unified', 'SOLUSDT')
    const kay = await getJson(appAs('viewer', kayId), '/api/trade/handover/list')
    expect(kay.rides.map((r: any) => r.positionId)).toEqual(['pos-ride-933'])
    const nobody = await getJson(appAs('viewer', emptyId), '/api/trade/handover/list')
    expect(nobody.rides).toEqual([])
  })

  it('bots show through a subscription on its accounts, without the webhook URL', async () => {
    const bot = (id: string, signalBotId: string) =>
      db.upsertBotConfig({
        id, signalBotId, strategyId: 's', exchange: 'tradestation', symbol: 'MGC', timeframe: '15m',
        alertWebhookUrl: 'https://hooks.example/secret',
      })
    bot('cfg-a', 'bot-a')
    bot('cfg-b', 'bot-b')
    const kay = appAs('viewer', kayId)
    const { bots } = await getJson(kay, '/api/bots')
    expect(bots.map((b: any) => b.id)).toEqual(['cfg-b'])
    expect(bots[0].alertWebhookUrl).toBeNull()
    await getJson(kay, '/api/bots/cfg-a', 404)
    expect((await getJson(appAs('admin', 1), '/api/bots')).bots).toHaveLength(2)
  })

  it('the equity curve sums only its wallets', () => {
    for (const [exchange, accountId, equity] of [
      ['tradestation', '21084931', 14000],
      ['tradestation', '21084933', 27000],
      ['bybit', 'unified', 5000],
      ['deribit', 'btc', 3000],
    ] as const) {
      db.insertBalanceSnapshot({ exchange, accountId, equity, balance: equity, currency: 'USD', ts: 1000 })
    }
    const scope = scopeForUser(db, kayId, 'viewer')
    const [point] = db.getEquitySnapshots(0, (ex, acc) => canSeeAccount(scope, ex, acc))
    expect(point.equity).toBe(30000)
    expect(point.wallets).toBe(2)
    expect(db.getEquitySnapshots(0)[0].equity).toBe(49000)
  })

  it('never reaches an order method through the scoped view', async () => {
    const kay = appAs('viewer', kayId)
    await kay.request('/api/exchanges/v2/tradestation/details')
    expect(tsAdapter.orders).toBe(0)
  })
})

describe('viewer without a scope', () => {
  it('sees no account data and gets no 500s', async () => {
    const nobody = appAs('viewer', emptyId)
    expect(await getJson(nobody, '/api/exchanges/v2/sessions')).toEqual([])
    await getJson(nobody, '/api/exchanges/v2/positions/tradestation', 404)
    expect(await getJson(nobody, '/api/ops/fills')).toEqual([])
    const portfolio = await getJson(nobody, '/api/ops/portfolio')
    expect(portfolio.exchanges).toEqual([])
    expect(portfolio.positions).toEqual([])
    expect(portfolio.totalEquity).toBe(0)
    expect(await getJson(nobody, '/api/subscriptions')).toEqual([])
    expect((await getJson(nobody, '/api/synthetic-usd')).positions).toEqual([])
    expect((await getJson(nobody, '/api/ops/position-lineage')).lineages).toEqual([])
    expect(await getJson(nobody, '/api/ops/account-sizes')).toEqual([])
    const recon = await getJson(nobody, '/api/ops/reconciliations')
    expect(recon.recent).toEqual([])
  })
})

describe('open orders', () => {
  it('a default-connection grant shows no local rows of another connection', async () => {
    seedExecution('sig-btc', 'deribit', 'btc', 'BTC-PERPETUAL')
    db.upsertBracketPair({ signalId: 'sig-btc', exchange: 'deribit', accountId: 'btc', slOrderId: 'sl-btc' })
    db.upsertBracketPair({ signalId: 'sig-acct1', exchange: 'deribit', accountId: 'acct1/btc', slOrderId: 'sl-acct1' })
    db.upsertServerExitState({
      positionId: 'p-btc', entrySignalId: 'sig-btc', exchange: 'deribit', symbol: 'BTC-PERPETUAL',
      direction: 'long', slOrderId: 'xs-btc',
    })
    db.upsertServerExitState({
      positionId: 'p-acct1', entrySignalId: 'sig-acct1', exchange: 'deribit', symbol: 'BTC-PERPETUAL',
      direction: 'long', slOrderId: 'xs-acct1',
    })
    db.setAccountGrants(emptyId, [{ exchange: 'deribit', kind: 'connection', ref: 'default' }])

    const viewer = await getJson(appAs('viewer', emptyId), '/api/ops/open-orders?exchange=deribit')
    expect(viewer.local.map((l: any) => l.orderId).sort()).toEqual(['sl-btc', 'xs-btc'])
    const admin = await getJson(appAs('admin', 1), '/api/ops/open-orders?exchange=deribit')
    expect(admin.local.map((l: any) => l.orderId).sort()).toEqual(['sl-acct1', 'sl-btc', 'xs-acct1', 'xs-btc'])
  })
})

describe('admin', () => {
  it('sees every connection and account', async () => {
    const admin = appAs('admin', 1)
    expect((await getJson(admin, '/api/exchanges/v2/sessions')).length).toBe(4)
    const positions = await getJson(admin, '/api/exchanges/v2/positions/tradestation')
    expect(positions.map((p: any) => p.accountId)).toEqual(['21084931', '21084933'])
    expect((await getJson(admin, '/api/ops/fills')).length).toBe(4)
    expect((await getJson(admin, '/api/subscriptions')).length).toBe(3)
  })
})

describe('scope endpoint', () => {
  const put = (app: Hono, id: number, body: unknown) =>
    app.request(`/api/auth/users/${id}/scope`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('a viewer cannot change any scope', async () => {
    const kay = appAs('viewer', kayId)
    expect((await put(kay, kayId, { grants: [] })).status).toBe(403)
    expect((await kay.request(`/api/auth/users/${kayId}/scope`)).status).toBe(403)
    expect(db.listAccountGrants(kayId)).toHaveLength(4)
  })

  it('the admin replaces a viewer scope and it applies on the next request', async () => {
    const admin = appAs('admin', 1)
    const res = await put(admin, emptyId, {
      grants: [{ exchange: 'Deribit', kind: 'connection', ref: 'acct1' }],
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).grants).toEqual([{ exchange: 'deribit', kind: 'connection', ref: 'acct1' }])
    const viewer = appAs('viewer', emptyId)
    const sessions = await getJson(viewer, '/api/exchanges/v2/sessions')
    expect(sessions.map((s: any) => s.connectionId)).toEqual(['default:deribit:acct1'])
    const users = await getJson(admin, '/api/auth/users')
    expect(users.users.find((u: any) => u.id === emptyId).grants).toHaveLength(1)
  })

  it('rejects bad grants and the admin row', async () => {
    const admin = appAs('admin', 1)
    expect((await put(admin, emptyId, { grants: [{ exchange: 'deribit', kind: 'all', ref: 'x' }] })).status).toBe(400)
    expect((await put(admin, emptyId, { grants: 'deribit:default' })).status).toBe(400)
    expect((await put(admin, 1, { grants: [] })).status).toBe(400)
    expect((await put(admin, 999, { grants: [] })).status).toBe(404)
  })

  it('deleting a viewer drops its scope', async () => {
    db.deleteUser(kayId)
    expect(db.listAccountGrants(kayId)).toEqual([])
  })
})

describe('notification WebSocket', () => {
  function fakeSocket() {
    const received: NotificationEvent[] = []
    return {
      received,
      readyState: 1,
      OPEN: 1,
      send(raw: string) {
        received.push(JSON.parse(raw).event)
      },
      on() {},
    }
  }

  it('a viewer socket only hears about its accounts and executor-wide events', () => {
    const bus = new NotificationBus()
    const admin = fakeSocket()
    const kay = fakeSocket()
    const nobody = fakeSocket()
    bus.addClient(admin as any, null)
    bus.addClient(kay as any, (e) => notificationVisible(db, scopeForUser(db, kayId, 'viewer'), e))
    bus.addClient(nobody as any, (e) => notificationVisible(db, scopeForUser(db, emptyId, 'viewer'), e))

    const send = (type: NotificationEvent['type'], data?: Record<string, unknown>) =>
      bus.publish({ type, title: type, body: '', data })
    send('order_filled', { signalId: 'sig-931' })
    send('order_filled', { signalId: 'sig-933' })
    send('error', { exchange: 'bybit', accountId: 'unified' })
    send('hedge_opened', { key: 'pos:deribit:acct1/btc:BTC-PERPETUAL' })
    send('synthetic_armed_minted', { positionId: 'syn-bybit' })
    send('synthetic_armed_minted', { positionId: 'syn-deribit' })
    send('roll_failed', { accountId: '21084931' })
    send('position_rolled', { accountId: '21084936' })
    send('signal_received', { signalId: 'not-executed-yet' })
    send('error')
    send('connection_lost', { code: 1006 })

    expect(admin.received).toHaveLength(11)
    const seen = (s: ReturnType<typeof fakeSocket>) =>
      s.received.map(
        (e) => `${e.type}:${String(e.data?.signalId ?? e.data?.key ?? e.data?.positionId ?? e.data?.accountId ?? '')}`,
      )
    expect(seen(kay)).toEqual([
      'order_filled:sig-933',
      'hedge_opened:pos:deribit:acct1/btc:BTC-PERPETUAL',
      'synthetic_armed_minted:syn-deribit',
      'position_rolled:21084936',
      'connection_lost:',
    ])
    expect(seen(nobody)).toEqual(['connection_lost:'])
  })
})

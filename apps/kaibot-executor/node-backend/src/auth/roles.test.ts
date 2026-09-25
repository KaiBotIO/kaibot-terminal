import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { createRoleMiddleware, isViewerAllowed, requireAdmin, VIEWER_FORBIDDEN_BODY } from './roles.js'
import type { UserRole } from './roles.js'

// Every read the viewer UI needs. Kept explicit so widening the allowlist is
// a visible diff.
const VIEWER_READS = [
  '/api/health',
  '/api/config',
  '/api/auth/session',
  '/api/ws/status',
  '/api/positions',
  '/api/signals',
  '/api/logs?level=error&limit=50',
  '/api/exchanges',
  '/api/exchanges/v2/sessions',
  '/api/exchanges/v2/accounts/deribit',
  '/api/exchanges/v2/balances/deribit?account=main',
  '/api/exchanges/v2/positions/tradestation',
  '/api/exchanges/v2/deribit/details',
  '/api/performance/equity-history',
  '/api/performance/signal-pnl',
  '/api/performance/analytics?from=2026-01-01',
  '/api/subscriptions',
  '/api/subscriptions/42',
  '/api/bots',
  '/api/bots/bot1:binance:BTCUSDT:1m',
  '/api/ops/position-lineage',
  '/api/ops/open-orders',
  '/api/ops/portfolio',
  '/api/ops/markets',
  '/api/ops/executions/sig-1',
  '/api/ops/reconciliations?exchange=deribit',
  '/api/ops/fills',
  '/api/ops/halt',
  '/api/ops/account-sizes',
  '/api/trade/manage',
  '/api/trade/managers',
  '/api/trade/hedge',
  '/api/position-groups',
  '/api/position-groups/overview',
  '/api/synthetic-usd',
  '/api/synthetic-usd?includeClosed=1',
  '/api/synthetic-usd/holdings-basis',
  '/api/synthetic-usd/7',
]

// Reads that carry pairing secrets, prepare an action, or mint access.
const VIEWER_DENIED_READS = [
  '/api/user/settings',
  '/api/keys',
  '/api/studio/embed-token',
  '/api/companion/status',
  '/api/companion/pairing-code',
  '/api/ops/alerting/status',
  '/api/ops/margin-guards',
  '/api/subscriptions/marketplace/browse',
  '/api/trade/handover/bots',
  '/api/trade/handover/list',
  '/api/trade/adopt/candidates',
  '/api/exchanges/v2/callback/tradestation',
  '/api/auth/users',
  '/api/auth/me',
  '/api/exchanges/v2/deribit/refresh',
  '/api/exchanges/v2/deribit/details/extra',
  '/api/subscriptions/42/anything',
]

// Every mutating route the executor exposes.
const MUTATIONS: Array<[string, string]> = [
  ['POST', '/api/auth/setup'],
  ['POST', '/api/auth/users'],
  ['DELETE', '/api/auth/users/2'],
  ['POST', '/api/auth/users/2/password'],
  ['POST', '/api/keys'],
  ['PUT', '/api/user/settings'],
  ['POST', '/api/test-connection'],
  ['POST', '/api/ws/connect'],
  ['POST', '/api/ws/disconnect'],
  ['POST', '/api/exchanges'],
  ['POST', '/api/exchanges/v2/connect'],
  ['POST', '/api/exchanges/v2/disconnect'],
  ['POST', '/api/exchanges/v2/deribit/refresh'],
  ['POST', '/api/exchanges/v2/order'],
  ['POST', '/api/exchanges/v2/oauth/start'],
  ['DELETE', '/api/exchanges/v2/order/abc'],
  ['POST', '/api/subscriptions'],
  ['PATCH', '/api/subscriptions/42'],
  ['POST', '/api/subscriptions/42/pause'],
  ['POST', '/api/subscriptions/42/resume'],
  ['DELETE', '/api/subscriptions/42'],
  ['POST', '/api/ops/repair/reconciler-rebuy-20260901'],
  ['POST', '/api/ops/repair/virtualclose-20260903'],
  ['POST', '/api/ops/fills/backfill-commissions'],
  ['PUT', '/api/ops/account-sizes'],
  ['PUT', '/api/ops/guardrails'],
  ['POST', '/api/ops/panic'],
  ['POST', '/api/ops/halt'],
  ['PUT', '/api/ops/margin-guards'],
  ['POST', '/api/synthetic-usd'],
  ['POST', '/api/synthetic-usd/arm'],
  ['POST', '/api/synthetic-usd/7/arm-update'],
  ['POST', '/api/synthetic-usd/7/disarm'],
  ['PUT', '/api/synthetic-usd/holdings-basis'],
  ['POST', '/api/synthetic-usd/7/scale'],
  ['POST', '/api/synthetic-usd/7/close'],
  ['POST', '/api/synthetic-usd/7/auto-rebalance'],
  ['POST', '/api/synthetic-usd/7/factor-basis'],
  ['POST', '/api/trade/handover/preview'],
  ['POST', '/api/trade/handover'],
  ['POST', '/api/trade/adopt'],
  ['POST', '/api/trade/takeback'],
  ['POST', '/api/trade/order'],
  ['POST', '/api/trade/close'],
  ['POST', '/api/trade/roll/preview'],
  ['POST', '/api/trade/roll'],
  ['POST', '/api/trade/manage'],
  ['POST', '/api/trade/managers'],
  ['POST', '/api/trade/hedge'],
  ['POST', '/api/trade/compose-recovery'],
  ['POST', '/api/bots/bot1/start'],
  ['POST', '/api/bots/bot1/stop'],
  ['POST', '/api/bots/bot1/detach'],
  ['POST', '/api/position-groups'],
  ['PATCH', '/api/position-groups/g1'],
  ['DELETE', '/api/position-groups/g1'],
  ['POST', '/api/position-groups/assign'],
  ['POST', '/api/position-groups/g1/close'],
  ['POST', '/api/position-groups/g1/tighten-stops'],
  ['POST', '/api/companion/enable'],
  ['POST', '/api/companion/disable'],
  ['POST', '/api/companion/unpair'],
]

describe('isViewerAllowed', () => {
  it('allows every read the viewer UI needs', () => {
    for (const path of VIEWER_READS) {
      expect({ path, allowed: isViewerAllowed('GET', path) }).toEqual({ path, allowed: true })
    }
  })

  it('refuses reads that carry secrets or prepare an action', () => {
    for (const path of VIEWER_DENIED_READS) {
      expect({ path, allowed: isViewerAllowed('GET', path) }).toEqual({ path, allowed: false })
    }
  })

  it('refuses every mutating method, even on an allowlisted path', () => {
    for (const [method, path] of MUTATIONS) {
      expect({ method, path, allowed: isViewerAllowed(method, path) }).toEqual({ method, path, allowed: false })
    }
    for (const path of VIEWER_READS) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        expect(isViewerAllowed(method, path)).toBe(false)
      }
    }
  })

  it('ignores trailing slashes and query strings, is case-insensitive on the method', () => {
    expect(isViewerAllowed('get', '/api/positions/')).toBe(true)
    expect(isViewerAllowed('HEAD', '/api/positions?x=1')).toBe(true)
  })
})

function appWithRole(role: UserRole | undefined) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    if (role) c.set('role', role)
    return next()
  })
  app.use('/api/*', createRoleMiddleware())
  app.get('/api/positions', (c) => c.json({ ok: 'positions' }))
  app.get('/api/user/settings', (c) => c.json({ ok: 'settings' }))
  app.post('/api/trade/order', (c) => c.json({ ok: 'order' }))
  app.delete('/api/subscriptions/:id', (c) => c.json({ ok: 'delete' }))
  app.get('/api/auth/users', (c) => {
    const refused = requireAdmin(c)
    return refused ?? c.json({ ok: 'users' })
  })
  return app
}

describe('createRoleMiddleware', () => {
  it('admin passes everything unchanged', async () => {
    const app = appWithRole('admin')
    expect((await app.request('/api/positions')).status).toBe(200)
    expect((await app.request('/api/user/settings')).status).toBe(200)
    expect((await app.request('/api/trade/order', { method: 'POST' })).status).toBe(200)
    expect((await app.request('/api/subscriptions/1', { method: 'DELETE' })).status).toBe(200)
    expect((await app.request('/api/auth/users')).status).toBe(200)
  })

  it('viewer reads the allowlist and gets a clear 403 elsewhere', async () => {
    const app = appWithRole('viewer')
    expect((await app.request('/api/positions')).status).toBe(200)

    const settings = await app.request('/api/user/settings')
    expect(settings.status).toBe(403)
    expect(await settings.json()).toEqual(VIEWER_FORBIDDEN_BODY)

    expect((await app.request('/api/trade/order', { method: 'POST' })).status).toBe(403)
    expect((await app.request('/api/subscriptions/1', { method: 'DELETE' })).status).toBe(403)
    expect((await app.request('/api/auth/users')).status).toBe(403)
  })

  it('no role on the context is refused like a viewer', async () => {
    const app = appWithRole(undefined)
    expect((await app.request('/api/positions')).status).toBe(403)
    expect((await app.request('/api/trade/order', { method: 'POST' })).status).toBe(403)
  })
})

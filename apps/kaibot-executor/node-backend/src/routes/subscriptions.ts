import { Hono } from 'hono'
import { KaiBotDatabase } from '../storage/database.js'
import type { ExchangeManager } from '../services/exchanges/exchangeManager.js'

export function createSubscriptionRoutes(
  db: KaiBotDatabase,
  onMutation?: () => void,
  exchangeManager?: ExchangeManager,
) {
  const app = new Hono()

  // ─────────────────────────────────────────────
  // Marketplace browse (proxy to main server)
  // ─────────────────────────────────────────────
  app.get('/marketplace/browse', async (c) => {
    try {
      const user = db.getAdminUser()
      const settings = user?.settings ? JSON.parse(user.settings) : {}
      const apiUrl = settings.apiConfig?.apiUrl || process.env.KAIBOT_API_URL || 'https://app.kaibot.io'
      const apiKey = settings.apiConfig?.apiKey
      const sessionToken = process.env.EXECUTOR_SESSION_TOKEN

      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (apiKey) headers['x-api-key'] = apiKey
      if (sessionToken) headers['x-session-token'] = sessionToken

      // Try tRPC marketplace.browse first
      const res = await fetch(`${apiUrl}/api/trpc/marketplace.browse?batch=1&input=${encodeURIComponent(JSON.stringify({ 0: { json: {} } }))}`, {
        method: 'GET',
        headers,
      })

      if (res.ok) {
        const body: any = await res.json()
        const items = body?.[0]?.result?.data?.json ?? body?.result?.data?.json ?? []
        // The server returns supportedMarkets as objects {exchange, symbol,
        // timeframe}; the wizard renders them as strings. Normalise to
        // "exchange:symbol:timeframe" so it can render and toggle them.
        const bots = (Array.isArray(items) ? items : []).map((b: any) => ({
          ...b,
          supportedMarkets: Array.isArray(b?.supportedMarkets)
            ? b.supportedMarkets.map((m: any) =>
                typeof m === 'string'
                  ? m
                  : [m?.exchange, m?.symbol, m?.timeframe].filter(Boolean).join(':'))
            : [],
        }))
        return c.json({ bots })
      }

      db.log('error', 'marketplace', 'marketplace.browse unavailable', { status: res.status })
      return c.json({ bots: [], error: `marketplace unreachable (${res.status})` }, 502)
    } catch (error: any) {
      db.log('error', 'marketplace', 'Failed to browse marketplace', { error: error.message })
      return c.json({ bots: [], error: error.message }, 500)
    }
  })

  // ─────────────────────────────────────────────
  // Subscription CRUD
  // ─────────────────────────────────────────────
  app.get('/', (c) => {
    const includeCancelled = c.req.query('includeCancelled') === 'true'
    const rows = db.getSubscriptions(includeCancelled) as any[]
    return c.json(
      rows.map((r) => ({
        id: r.id,
        signalBotId: r.signal_bot_id,
        botName: r.bot_name,
        selectedMarkets: r.selected_markets ? JSON.parse(r.selected_markets) : [],
        factor: r.factor,
        maxPositionSize: r.max_position_size,
        maxConcurrentTrades: r.max_concurrent_trades,
        exchange: r.exchange,
        accountId: r.account_id,
        status: r.status,
        // Effective sizing unit ('native' unless explicitly set to 'usd').
        sizeUnit: r.size_unit ?? 'native',
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    )
  })

  app.get('/:id', (c) => {
    const id = c.req.param('id')
    const row = db.getSubscription(id)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const signals = db.getSignalsForSubscription(id, 50)
    const signalCount24h = db.getSignalCountForSubscription(id, 24)

    return c.json({
      subscription: {
        id: row.id,
        signalBotId: row.signal_bot_id,
        botName: row.bot_name,
        selectedMarkets: row.selected_markets ? JSON.parse(row.selected_markets) : [],
        factor: row.factor,
        maxPositionSize: row.max_position_size,
        maxConcurrentTrades: row.max_concurrent_trades,
        exchange: row.exchange,
        accountId: row.account_id,
        status: row.status,
        sizeUnit: row.size_unit ?? 'native',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
      signalCount24h,
      signals,
    })
  })

  app.post('/', async (c) => {
    try {
      const body = await c.req.json()
      const {
        signalBotId,
        botName,
        selectedMarkets,
        factor,
        maxPositionSize,
        maxConcurrentTrades,
        exchange,
        accountId,
        sizeUnit,
      } = body

      if (!signalBotId) return c.json({ error: 'signalBotId required' }, 400)
      if (typeof factor !== 'number' || factor <= 0) return c.json({ error: 'factor must be > 0' }, 400)
      if (sizeUnit != null && sizeUnit !== 'native' && sizeUnit !== 'usd') {
        return c.json({ error: "sizeUnit must be 'native' or 'usd'" }, 400)
      }

      // Execution venue is REQUIRED: composite signals carry no venue, and
      // resolution without one is a loud reject (no deribit default anymore).
      // Must be a venue this executor can actually open a session for.
      const venueNames = exchangeManager
        ? exchangeManager.getRegisteredExchanges()
        : ['deribit', 'bybit', 'binance', 'tradestation', 'paper']
      if (!exchange || typeof exchange !== 'string') {
        return c.json({ error: 'exchange (execution venue) required' }, 400)
      }
      const venue = exchange.toLowerCase()
      if (venue === 'index' || !venueNames.includes(venue)) {
        return c.json({ error: `exchange must be one of: ${venueNames.join(', ')}` }, 400)
      }

      // Wizard sends markets as "exchange:symbol:timeframe" strings. The server
      // expects {exchange, symbol, timeframe} objects; the local market filter
      // matches on bare symbols. Derive both shapes here.
      const marketStrings: any[] = Array.isArray(selectedMarkets) ? selectedMarkets : []
      const marketObjects = marketStrings.map((m: any) => {
        if (m && typeof m === 'object') return m
        const [exchange, symbol, timeframe] = String(m).split(':')
        return { exchange, symbol, timeframe }
      })
      const marketSymbols = marketObjects.map((m: any) => m.symbol).filter(Boolean)

      // 1. Try to create subscription on server
      const user = db.getAdminUser()
      const settings = user?.settings ? JSON.parse(user.settings) : {}
      const apiUrl = settings.apiConfig?.apiUrl || process.env.KAIBOT_API_URL || 'https://app.kaibot.io'
      const apiKey = settings.apiConfig?.apiKey
      const sessionToken = process.env.EXECUTOR_SESSION_TOKEN

      let serverId: string | null = null
      try {
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (apiKey) headers['x-api-key'] = apiKey
        if (sessionToken) headers['x-session-token'] = sessionToken

        const serverRes = await fetch(`${apiUrl}/api/trpc/subscriptions.create`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            json: {
              signalBotId,
              selectedMarkets: marketObjects,
              factor,
              maxPositionSize,
              maxConcurrentTrades,
            },
          }),
        })

        if (serverRes.ok) {
          const data: any = await serverRes.json()
          serverId = data?.result?.data?.json?.id ?? data?.result?.data?.id ?? null
        } else {
          db.log('warn', 'subscription', 'server subscriptions.create failed', { status: serverRes.status })
        }
      } catch (err: any) {
        db.log('warn', 'subscription', 'server subscriptions.create error', { error: err.message })
      }

      // 2. Always create locally (server is optional during MVP)
      const id = serverId || `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

      db.upsertSubscription({
        id,
        signalBotId,
        botName,
        selectedMarkets: marketSymbols,
        factor,
        maxPositionSize,
        maxConcurrentTrades,
        exchange,
        accountId,
        status: 'active',
        sizeUnit,
      })

      db.log('info', 'subscription', 'Subscription created', { id, signalBotId, factor, serverSynced: !!serverId })
      return c.json({ success: true, id, serverSynced: !!serverId })
    } catch (error: any) {
      db.log('error', 'subscription', 'Failed to create subscription', { error: error.message })
      return c.json({ error: error.message }, 500)
    }
  })

  app.patch('/:id', async (c) => {
    try {
      const id = c.req.param('id')
      const existing = db.getSubscription(id)
      if (!existing) return c.json({ error: 'Not found' }, 404)

      const body = await c.req.json()
      db.upsertSubscription({
        id,
        signalBotId: body.signalBotId ?? existing.signal_bot_id,
        botName: body.botName ?? existing.bot_name,
        selectedMarkets:
          body.selectedMarkets ?? (existing.selected_markets ? JSON.parse(existing.selected_markets) : undefined),
        factor: body.factor ?? existing.factor,
        // Explicit null clears a limit (unlimited); absent key keeps the old value.
        maxPositionSize:
          'maxPositionSize' in body ? body.maxPositionSize ?? undefined : existing.max_position_size,
        maxConcurrentTrades:
          'maxConcurrentTrades' in body ? body.maxConcurrentTrades ?? undefined : existing.max_concurrent_trades,
        exchange: body.exchange ?? existing.exchange,
        accountId: body.accountId ?? existing.account_id,
        status: body.status ?? existing.status,
        sizeUnit: 'sizeUnit' in body ? body.sizeUnit ?? undefined : existing.size_unit ?? undefined,
      })

      db.log('info', 'subscription', 'Subscription updated', { id })
      return c.json({ success: true })
    } catch (error: any) {
      return c.json({ error: error.message }, 500)
    }
  })

  app.post('/:id/pause', (c) => {
    const id = c.req.param('id')
    const existing = db.getSubscription(id)
    if (!existing) return c.json({ error: 'Not found' }, 404)
    db.setSubscriptionStatus(id, 'paused')
    db.log('info', 'subscription', 'Subscription paused', { id })
    onMutation?.()
    return c.json({ success: true })
  })

  app.post('/:id/resume', (c) => {
    const id = c.req.param('id')
    const existing = db.getSubscription(id)
    if (!existing) return c.json({ error: 'Not found' }, 404)
    db.setSubscriptionStatus(id, 'active')
    db.log('info', 'subscription', 'Subscription resumed', { id })
    onMutation?.()
    return c.json({ success: true })
  })

  app.delete('/:id', (c) => {
    const id = c.req.param('id')
    const existing = db.getSubscription(id)
    if (!existing) return c.json({ error: 'Not found' }, 404)
    db.setSubscriptionStatus(id, 'cancelled')
    db.log('info', 'subscription', 'Subscription cancelled', { id })
    return c.json({ success: true })
  })

  return app
}

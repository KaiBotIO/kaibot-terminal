import { Hono } from 'hono'
import { ExchangeManager } from '../../services/exchanges/exchangeManager.js'
import { KaiBotDatabase } from '../../storage/database.js'
import { groupInfoForPosition } from '../../services/position-groups.js'
import { expiryInfoForSymbol } from '../../services/exchanges/contract-expiry.js'

export function createExchangeRoutes(db: KaiBotDatabase, exchangeManager: ExchangeManager) {
  const app = new Hono()

  app.post('/connect', async (c) => {
    const { exchangeName, credentials } = await c.req.json()
    const userId = c.req.header('x-user-id') || 'default'

    try {
      await exchangeManager.connectExchange(userId, exchangeName, credentials)
      db.log('info', 'exchange', `Connected to ${exchangeName}`, { userId, exchangeName })
      return c.json({ success: true, message: `Connected to ${exchangeName}` })
    } catch (error: any) {
      console.log('Connect error:', error.message, exchangeName)
      
      // Handle OAuth redirect case
      if (error.message === 'OAUTH_REDIRECT_REQUIRED') {
        // The pending_oauth session holds THIS user's adapter instance (adapters
        // are per-session, not registry-global) — its auth URL carries the state.
        const adapter = (await exchangeManager.getSession(userId, exchangeName))?.adapter
        console.log('Got adapter:', !!adapter, exchangeName)
        
        if (adapter && 'getAuthorizationUrl' in adapter) {
          const authUrl = (adapter as any).getAuthorizationUrl()
          console.log('Got auth URL:', authUrl)
          return c.json({ 
            requiresOAuth: true, 
            authUrl,
            message: 'OAuth authorization required' 
          })
        } else {
          console.log('No getAuthorizationUrl method on adapter')
        }
      }
      
      db.log('error', 'exchange', `Failed to connect to ${exchangeName}`, { 
        userId, 
        exchangeName, 
        error: error.message 
      })
      return c.json({ error: error.message }, 400)
    }
  })

  app.post('/disconnect', async (c) => {
    const { exchangeName } = await c.req.json()
    const userId = c.req.header('x-user-id') || 'default'

    try {
      await exchangeManager.disconnectExchange(userId, exchangeName)
      db.log('info', 'exchange', `Disconnected from ${exchangeName}`, { userId, exchangeName })
      return c.json({ success: true, message: `Disconnected from ${exchangeName}` })
    } catch (error: any) {
      db.log('error', 'exchange', `Failed to disconnect from ${exchangeName}`, { 
        userId, 
        exchangeName, 
        error: error.message 
      })
      return c.json({ error: error.message }, 400)
    }
  })

  app.get('/sessions', async (c) => {
    const userId = c.req.header('x-user-id') || 'default'

    try {
      const sessions = await exchangeManager.getAllSessions(userId)
      
      // Get prices for crypto exchanges
      const sessionsWithPrices = await Promise.all(sessions.map(async (session) => {
        let prices: Record<string, number> = {}
        
        if (session.exchangeName === 'deribit' && session.status === 'connected') {
          try {
            const adapter = session.adapter as any
            if (adapter.call) {
              const [btcIndex, ethIndex] = await Promise.all([
                adapter.call('public/get_index_price', { index_name: 'btc_usd' }).catch(() => null),
                adapter.call('public/get_index_price', { index_name: 'eth_usd' }).catch(() => null)
              ])
              
              if (btcIndex?.index_price) prices.BTC = btcIndex.index_price
              if (ethIndex?.index_price) prices.ETH = ethIndex.index_price
            }
          } catch (error) {
            console.warn('Failed to fetch index prices:', error)
          }
        }
        
        return {
          exchangeName: session.exchangeName,
          status: session.status,
          lastRefresh: session.lastRefresh,
          error: session.error,
          prices
        }
      }))
      
      return c.json(sessionsWithPrices)
    } catch (error: any) {
      db.log('error', 'exchange', 'Failed to get sessions', { userId, error: error.message })
      return c.json({ error: error.message }, 400)
    }
  })

  app.get('/accounts/:exchangeName', async (c) => {
    const exchangeName = c.req.param('exchangeName')
    const userId = c.req.header('x-user-id') || 'default'

    try {
      const session = await exchangeManager.getSession(userId, exchangeName)
      if (!session) {
        return c.json({ error: 'Session not found' }, 404)
      }

      const accounts = await session.adapter.getAccounts()
      return c.json(accounts)
    } catch (error: any) {
      db.log('error', 'exchange', 'Failed to get accounts', { 
        userId, 
        exchangeName, 
        error: error.message 
      })
      return c.json({ error: error.message }, 400)
    }
  })

  app.get('/balances/:exchangeName', async (c) => {
    const exchangeName = c.req.param('exchangeName')
    const userId = c.req.header('x-user-id') || 'default'

    try {
      const session = await exchangeManager.getSession(userId, exchangeName)
      if (!session) {
        return c.json({ error: 'Session not found' }, 404)
      }

      const balances = await session.adapter.getBalances()
      return c.json(balances)
    } catch (error: any) {
      db.log('error', 'exchange', 'Failed to get balances', { 
        userId, 
        exchangeName, 
        error: error.message 
      })
      return c.json({ error: error.message }, 400)
    }
  })

  app.get('/positions/:exchangeName', async (c) => {
    const exchangeName = c.req.param('exchangeName')
    const userId = c.req.header('x-user-id') || 'default'

    try {
      const session = await exchangeManager.getSession(userId, exchangeName)
      if (!session) {
        return c.json({ error: 'Session not found' }, 404)
      }

      const positions = await session.adapter.getPositions()
      // G0: additive group info per position (null = Unsorted).
      // Expiry: dated-futures rollover info derived from the symbol (null for
      // perpetuals/spot).
      const enriched = positions.map((p) => ({
        ...p,
        group: groupInfoForPosition(db, exchangeName, p.accountId, p.symbol),
        expiry: expiryInfoForSymbol(p.symbol),
      }))
      return c.json(enriched)
    } catch (error: any) {
      db.log('error', 'exchange', 'Failed to get positions', {
        userId,
        exchangeName,
        error: error.message
      })
      return c.json({ error: error.message }, 400)
    }
  })

  app.get('/:exchangeName/details', async (c) => {
    const exchangeName = c.req.param('exchangeName')
    const userId = c.req.header('x-user-id') || 'default'

    try {
      const session = await exchangeManager.getSession(userId, exchangeName)
      if (!session) {
        return c.json({ error: 'Session not found' }, 404)
      }

      // Fetch all data in parallel
      const [accounts, balances, positions] = await Promise.all([
        session.adapter.getAccounts(),
        session.adapter.getBalances(),
        session.adapter.getPositions()
      ])

      // Get current prices for crypto exchanges
      let prices: Record<string, number> = {}
      if (session.exchangeName === 'deribit') {
        try {
          // Get BTC and ETH USD prices from Deribit index
          const adapter = session.adapter as any
          if (adapter.call) {
            const [btcIndex, ethIndex] = await Promise.all([
              adapter.call('public/get_index_price', { index_name: 'btc_usd' }).catch(() => null),
              adapter.call('public/get_index_price', { index_name: 'eth_usd' }).catch(() => null)
            ])
            
            if (btcIndex?.index_price) prices.BTC = btcIndex.index_price
            if (ethIndex?.index_price) prices.ETH = ethIndex.index_price
          }
        } catch (error) {
          console.warn('Failed to fetch index prices:', error)
        }
      }

      return c.json({
        exchange: {
          name: session.exchangeName,
          status: session.status,
          lastRefresh: session.lastRefresh || Date.now()
        },
        accounts,
        balances,
        positions,
        prices
      })
    } catch (error: any) {
      db.log('error', 'exchange', 'Failed to get exchange details', { 
        userId, 
        exchangeName, 
        error: error.message 
      })
      return c.json({ error: error.message }, 400)
    }
  })

  app.post('/:exchangeName/refresh', async (c) => {
    const exchangeName = c.req.param('exchangeName')
    const userId = c.req.header('x-user-id') || 'default'

    try {
      const session = await exchangeManager.getSession(userId, exchangeName)
      if (!session) {
        return c.json({ error: 'Session not found' }, 404)
      }

      // Trigger a manual refresh
      await exchangeManager.refreshExchangeData(`${userId}:${exchangeName}`)
      
      return c.json({ success: true })
    } catch (error: any) {
      db.log('error', 'exchange', 'Failed to refresh exchange data', { 
        userId, 
        exchangeName, 
        error: error.message 
      })
      return c.json({ error: error.message }, 400)
    }
  })

  app.post('/order', async (c) => {
    const { exchangeName, order } = await c.req.json()
    const userId = c.req.header('x-user-id') || 'default'

    try {
      const session = await exchangeManager.getSession(userId, exchangeName)
      if (!session) {
        return c.json({ error: 'Session not found' }, 404)
      }

      const result = await session.adapter.placeOrder(order)
      db.log('info', 'trading', 'Order placed', { 
        userId, 
        exchangeName, 
        order, 
        result 
      })
      return c.json(result)
    } catch (error: any) {
      db.log('error', 'trading', 'Failed to place order', { 
        userId, 
        exchangeName, 
        order, 
        error: error.message 
      })
      return c.json({ error: error.message }, 400)
    }
  })

  // ─── TradeStation OAuth flow ──────────────────────────────────────────────
  // START: kick off the authorize flow for an exchange and return its URL. The
  // creds (TS OAuth app key/secret/redirectUri) flow through connectExchange →
  // encryptCredentials like every other exchange; an OAuth adapter responds with
  // OAUTH_REDIRECT_REQUIRED, which we translate into the authorize URL the
  // frontend opens. Identical in shape to /connect, but always returns the URL.
  app.post('/oauth/start', async (c) => {
    const { exchangeName, credentials } = await c.req.json()
    const userId = c.req.header('x-user-id') || 'default'

    try {
      await exchangeManager.connectExchange(userId, exchangeName, credentials)
      // A non-OAuth (or already-restorable) adapter connects directly.
      return c.json({ success: true, requiresOAuth: false })
    } catch (error: any) {
      if (error.message === 'OAUTH_REDIRECT_REQUIRED') {
        // Per-session adapter: the pending_oauth session owns the instance that
        // generated this user's authorize URL.
        const adapter = (await exchangeManager.getSession(userId, exchangeName))?.adapter as any
        if (adapter && typeof adapter.getAuthorizationUrl === 'function') {
          return c.json({ requiresOAuth: true, authUrl: adapter.getAuthorizationUrl() })
        }
      }
      db.log('error', 'exchange', `Failed to start OAuth for ${exchangeName}`, {
        userId,
        exchangeName,
        error: error.message,
      })
      return c.json({ error: error.message }, 400)
    }
  })

  // CALLBACK: TradeStation redirects the browser here (top-level GET) with
  // ?code=...&state=.... We hand the code to the pending adapter's
  // handleAuthorizationCallback (via completeOAuthFlow, which also persists the
  // resulting refresh token), then bounce the browser back to the app shell.
  // The callback URL the adapter builds is /api/exchanges/v2/callback/:exchange.
  app.get('/callback/:exchangeName', async (c) => {
    const exchangeName = c.req.param('exchangeName')
    const code = c.req.query('code')
    const stateUserId = c.req.query('state')
    const userId = stateUserId || c.req.header('x-user-id') || 'default'

    if (!code) {
      return c.json({ error: 'Missing authorization code' }, 400)
    }

    try {
      await exchangeManager.completeOAuthFlow(userId, exchangeName, code)
      db.log('info', 'exchange', `Completed OAuth for ${exchangeName}`, { userId, exchangeName })
      // Bounce the browser back to the app (SPA route handles the rest).
      return c.redirect('/?exchange_connected=' + encodeURIComponent(exchangeName))
    } catch (error: any) {
      db.log('error', 'exchange', `OAuth callback failed for ${exchangeName}`, {
        userId,
        exchangeName,
        error: error.message,
      })
      return c.redirect('/?exchange_error=' + encodeURIComponent(error.message))
    }
  })

  app.delete('/order/:orderId', async (c) => {
    const orderId = c.req.param('orderId')
    const { exchangeName } = await c.req.json()
    const userId = c.req.header('x-user-id') || 'default'

    try {
      const session = await exchangeManager.getSession(userId, exchangeName)
      if (!session) {
        return c.json({ error: 'Session not found' }, 404)
      }

      await session.adapter.cancelOrder(orderId)
      db.log('info', 'trading', 'Order cancelled', { 
        userId, 
        exchangeName, 
        orderId 
      })
      return c.json({ success: true, message: 'Order cancelled' })
    } catch (error: any) {
      db.log('error', 'trading', 'Failed to cancel order', { 
        userId, 
        exchangeName, 
        orderId, 
        error: error.message 
      })
      return c.json({ error: error.message }, 400)
    }
  })

  return app
}
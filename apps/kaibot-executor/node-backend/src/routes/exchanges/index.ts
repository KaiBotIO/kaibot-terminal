import { Hono } from 'hono'
import type { Context } from 'hono'
import { ExchangeManager } from '../../services/exchanges/exchangeManager.js'
import { KaiBotDatabase } from '../../storage/database.js'
import { groupRowForPosition } from '../../services/position-groups.js'
import { expiryInfoForSymbol } from '../../services/exchanges/contract-expiry.js'
import { ladderForPosition, type LadderSnapshot } from '../../services/bot-config-sync.js'
import { contractMultiplier } from '../../services/exchanges/futures-contracts.js'
import { usdRatesFor, withUsdValues } from '../../services/exchanges/balance-usd.js'
import { isOpenPosition } from '../../services/exchanges/open-position.js'
import { normalizeConnectionLabel } from '../../services/exchanges/account-scope.js'
import type { ExchangeSession, Position } from '../../services/exchanges/types.js'

// Connection label from `?account=<label>` (per-exchange routes) or a body
// field. Absent/'default' = the default connection. Throws on a bad label.
function labelFromQuery(c: Context): string | undefined {
  return normalizeConnectionLabel(c.req.query('account') ?? c.req.query('label'))
}

function sessionView(session: ExchangeSession) {
  return {
    exchangeName: session.exchangeName,
    label: session.label,
    accountKey: session.accountKey ?? null,
    connectionId: session.connectionId,
    status: session.status,
    lastRefresh: session.lastRefresh,
    error: session.error,
  }
}

async function deribitIndexPrices(session: ExchangeSession): Promise<Record<string, number>> {
  const prices: Record<string, number> = {}
  if (session.exchangeName !== 'deribit' || session.status !== 'connected') return prices
  try {
    const adapter = session.adapter as any
    if (adapter.call) {
      const [btcIndex, ethIndex] = await Promise.all([
        adapter.call('public/get_index_price', { index_name: 'btc_usd' }).catch(() => null),
        adapter.call('public/get_index_price', { index_name: 'eth_usd' }).catch(() => null),
      ])
      if (btcIndex?.index_price) prices.BTC = btcIndex.index_price
      if (ethIndex?.index_price) prices.ETH = ethIndex.index_price
    }
  } catch (error) {
    console.warn('Failed to fetch index prices:', error)
  }
  return prices
}

export function createExchangeRoutes(
  db: KaiBotDatabase,
  exchangeManager: ExchangeManager,
  ladderLookup?: (signalBotId: string, symbol: string) => LadderSnapshot | null,
) {
  const app = new Hono()

  // One connection: `?account=<label>` picks a labeled connection, otherwise
  // the default one (unchanged behaviour for every pre-label caller).
  async function sessionFor(c: Context, exchangeName: string): Promise<ExchangeSession | undefined> {
    return exchangeManager.getSession(c.req.header('x-user-id') || 'default', exchangeName, labelFromQuery(c))
  }

  // Every connected connection on the exchange when no `?account=` is given
  // (positions carry unique account ids across connections, so the aggregate
  // never merges two accounts into one row); with one, only that connection.
  // `?account=default` narrows to the default connection — the per-row UI
  // fetch must not read the other connections' balances into the default row.
  async function connectedSessionsFor(c: Context, exchangeName: string): Promise<ExchangeSession[]> {
    const userId = c.req.header('x-user-id') || 'default'
    const raw = c.req.query('account') ?? c.req.query('label')
    if (raw != null && raw !== '') {
      const one = await exchangeManager.getSession(userId, exchangeName, labelFromQuery(c))
      return one ? [one] : []
    }
    return exchangeManager.getSessions(userId, exchangeName)
  }

  function enrichPosition(session: ExchangeSession, p: Position) {
    const group = groupRowForPosition(db, session.exchangeName, p.accountId, p.symbol)
    const multiplier = contractMultiplier(session.exchangeName, p.symbol)
    const price = p.markPrice || p.entryPrice || 0
    return {
      ...p,
      accountKey: session.accountKey ?? null,
      group: group ? { id: group.id, name: group.name, source: group.source } : null,
      expiry: expiryInfoForSymbol(p.symbol),
      ladder: ladderForPosition(ladderLookup, group?.signal_bot_id, p),
      multiplier,
      notional: Math.abs(p.size || 0) * price * multiplier,
    }
  }

  app.post('/connect', async (c) => {
    const { exchangeName, credentials, label: rawLabel } = await c.req.json()
    const userId = c.req.header('x-user-id') || 'default'
    let label: string | undefined
    try {
      label = normalizeConnectionLabel(rawLabel)
    } catch (error: any) {
      return c.json({ error: error.message }, 400)
    }

    try {
      await exchangeManager.connectExchange(userId, exchangeName, credentials, label)
      db.log('info', 'exchange', `Connected to ${exchangeName}`, { userId, exchangeName, label: label ?? 'default' })
      return c.json({ success: true, message: `Connected to ${exchangeName}`, label: label ?? 'default' })
    } catch (error: any) {
      console.log('Connect error:', error.message, exchangeName)

      // Handle OAuth redirect case
      if (error.message === 'OAUTH_REDIRECT_REQUIRED') {
        // The pending_oauth session holds THIS user's adapter instance (adapters
        // are per-session, not registry-global) — its auth URL carries the state.
        const adapter = (await exchangeManager.getSession(userId, exchangeName, label))?.adapter
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
        label: label ?? 'default',
        error: error.message
      })
      return c.json({ error: error.message }, 400)
    }
  })

  app.post('/disconnect', async (c) => {
    const { exchangeName, label: rawLabel } = await c.req.json()
    const userId = c.req.header('x-user-id') || 'default'
    let label: string | undefined
    try {
      label = normalizeConnectionLabel(rawLabel)
    } catch (error: any) {
      return c.json({ error: error.message }, 400)
    }

    try {
      await exchangeManager.disconnectExchange(userId, exchangeName, label)
      db.log('info', 'exchange', `Disconnected from ${exchangeName}`, { userId, exchangeName, label: label ?? 'default' })
      return c.json({ success: true, message: `Disconnected from ${exchangeName}` })
    } catch (error: any) {
      db.log('error', 'exchange', `Failed to disconnect from ${exchangeName}`, {
        userId,
        exchangeName,
        label: label ?? 'default',
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
      const sessionsWithPrices = await Promise.all(sessions.map(async (session) => ({
        ...sessionView(session),
        prices: await deribitIndexPrices(session),
      })))

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
      const sessions = await connectedSessionsFor(c, exchangeName)
      if (sessions.length === 0) {
        return c.json({ error: 'Session not found' }, 404)
      }

      const accounts = []
      for (const session of sessions) {
        if (session.status !== 'connected') continue
        for (const a of await session.adapter.getAccounts()) {
          accounts.push({ ...a, accountKey: session.accountKey ?? null })
        }
      }
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
      const sessions = await connectedSessionsFor(c, exchangeName)
      if (sessions.length === 0) {
        return c.json({ error: 'Session not found' }, 404)
      }

      const balances = []
      for (const session of sessions) {
        if (session.status !== 'connected') continue
        const raw = await session.adapter.getBalances()
        // Coin wallets carry their USD value: a strip that adds 0.1 BTC to
        // 5 ETH as if both were dollars reports a fraction of the real book.
        const adapter = session.adapter as { getLastPrice?: (s: string) => Promise<number | null> }
        const rates = await usdRatesFor(raw, adapter.getLastPrice?.bind(session.adapter))
        for (const b of withUsdValues(raw, rates)) {
          balances.push({ ...b, accountKey: session.accountKey ?? null })
        }
      }
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
      const sessions = await connectedSessionsFor(c, exchangeName)
      if (sessions.length === 0) {
        return c.json({ error: 'Session not found' }, 404)
      }

      // G0: additive group info per position (null = Unsorted).
      // Expiry: dated-futures rollover info derived from the symbol (null for
      // perpetuals/spot).
      // Ladder: level of the owning bot (null when the position is not on one).
      // Multiplier/notional: a futures contract is worth price x multiplier, so
      // the UI must never value a position on bare size x price.
      // accountKey: the connection the position lives on (null = default), so
      // two accounts on one symbol never read as one position.
      const enriched = []
      for (const session of sessions) {
        if (session.status !== 'connected') continue
        const positions = await session.adapter.getPositions()
        // Deribit returns a row per instrument the account has ever touched,
        // size 0 when flat. A flat instrument is not a position: counting it
        // put "11 open positions" on a book holding 2.
        for (const p of positions.filter(isOpenPosition)) enriched.push(enrichPosition(session, p))
      }
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
      const session = await sessionFor(c, exchangeName)
      if (!session) {
        return c.json({ error: 'Session not found' }, 404)
      }

      // Fetch all data in parallel
      const [accounts, rawBalances, rawPositions] = await Promise.all([
        session.adapter.getAccounts(),
        session.adapter.getBalances(),
        session.adapter.getPositions()
      ])
      const priceHook = (session.adapter as { getLastPrice?: (s: string) => Promise<number | null> })
        .getLastPrice?.bind(session.adapter)
      const balances = withUsdValues(rawBalances, await usdRatesFor(rawBalances, priceHook))
      const positions = rawPositions.filter(isOpenPosition)

      // Get current prices for crypto exchanges
      const prices = await deribitIndexPrices(session)

      return c.json({
        exchange: {
          name: session.exchangeName,
          label: session.label,
          accountKey: session.accountKey ?? null,
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
      const session = await sessionFor(c, exchangeName)
      if (!session) {
        return c.json({ error: 'Session not found' }, 404)
      }

      // Trigger a manual refresh
      await exchangeManager.refreshExchangeData(session.connectionId)

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
    const { exchangeName, order, label } = await c.req.json()
    const userId = c.req.header('x-user-id') || 'default'

    try {
      // The order's account names its connection; an explicit label wins.
      const session = label
        ? await exchangeManager.getSession(userId, exchangeName, normalizeConnectionLabel(label))
        : await exchangeManager.sessionForAccount(userId, exchangeName, order?.accountId)
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
  // OAuth connections are default-label only: the callback's `state` carries
  // the user id, not a connection label.
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
    const { exchangeName, label, accountId } = await c.req.json()
    const userId = c.req.header('x-user-id') || 'default'

    try {
      const session = label
        ? await exchangeManager.getSession(userId, exchangeName, normalizeConnectionLabel(label))
        : await exchangeManager.sessionForAccount(userId, exchangeName, accountId)
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

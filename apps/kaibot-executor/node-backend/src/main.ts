import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { cors } from 'hono/cors'
import { KaiBotDatabase } from './storage/database.js'
import { Crypto } from './storage/crypto.js'
import { SignalWebSocketClient } from './websocket/signal-client.js'
import { ExchangeManager } from './services/exchanges/exchangeManager.js'
import { createExchangeRoutes } from './routes/exchanges/index.js'
import { createSubscriptionRoutes } from './routes/subscriptions.js'
import { createOperationsRoutes } from './routes/operations.js'
import { createRideHandoverService } from './services/ride-handover.js'
import { createSyntheticUsdRoutes } from './routes/synthetic-usd.js'
import { createManualTradeRoutes } from './routes/manual-trade.js'
import { createPositionGroupRoutes } from './routes/position-groups.js'
import { createComposeRecoveryRoutes } from './routes/compose-recovery.js'
import { createRecoveryComposeService } from './services/recovery-compose.js'
import { createBotRoutes } from './routes/bots.js'
import { createStudioEmbedRoutes } from './routes/studio-embed.js'
import { positionsUnavailableBody } from './services/positions-view.js'
import { createCompanionRoutes } from './routes/companion.js'
import { CompanionService } from './services/companion.js'
import { StatePusher } from './websocket/state-pusher.js'
import { AlertingService } from './services/notifications/alerting.js'
import { TradeStationOAuthAdapter } from './services/exchanges/adapters/tradestation-oauth.js'
import { TradeStationCouchDBAdapter } from './services/exchanges/adapters/tradestation-couchdb.js'
import { DeribitAdapter } from './services/exchanges/adapters/deribit.js'
import { notificationBus } from './services/notifications/notification-bus.js'
import { BalanceSnapshotPoller } from './services/balance-poller.js'
import { LocalPositionManager } from './services/local-position-manager.js'
import { createHedgeGuardService } from './services/hedge-guard.js'
import { isLocalTrailingEnabled } from './services/local-trailing-gate.js'
import { isSyntheticRebalanceEnabled } from './services/synthetic-rebalance-gate.js'
import { SyntheticRebalancer } from './services/synthetic-rebalancer.js'
import { createSyntheticUsdService } from './services/synthetic-usd.js'
import { createSyntheticGuardService } from './services/synthetic-guard.js'
import { PortfolioShipper } from './services/portfolio-shipper.js'
import { BotConfigSync } from './services/bot-config-sync.js'
import { Reconciler } from './services/reconciler.js'
import { computeSignalPnl } from './services/pnl.js'
import {
  buildSummary,
  buildCumulativePnl,
  buildTradeDistribution,
  buildStrategyScorecards,
  closedRowsFromExecutions,
  countUnpricedCloses,
  filterClosedRows,
  filterOptionsFrom,
  type AnalyticsFilter,
} from './services/analytics.js'
import { buildStrategyLabels } from './services/analytics-attribution.js'
import { isOpenPosition } from './services/exchanges/open-position.js'
import type { SignalFillRow } from './storage/types.js'
import { BybitAdapter } from './services/exchanges/adapters/bybit.js'
import { BinanceAdapter } from './services/exchanges/adapters/binance.js'
import { InteractiveBrokersAdapter } from './services/exchanges/adapters/interactive-brokers.js'
import { PaperExchangeAdapter } from './services/exchanges/adapters/paper.js'
import { createAuthMiddleware, issueSession, revokeSession, extractToken, hashToken } from './auth/session.js'
import { checkSetupGate } from './auth/setup-gate.js'
import { registerStaticUi } from './static-ui.js'
import { EXECUTOR_VERSION, getBuildType } from './version.js'
import { logUpdateHintOnStart } from './cli/self-update.js'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const isDesktop = process.env.TAURI === '1'

// TradeStation auth mode, resolved at runtime (see tradestation-auth-flag.ts).
// The UI reads the same value from /api/config, so one build serves both the
// public OAuth flow and Kai's CouchDB box.
import { resolveTradestationAuthMode } from './services/tradestation-auth-flag.js'
const TRADESTATION_AUTH_MODE = resolveTradestationAuthMode()
const TRADESTATION_USE_OAUTH = TRADESTATION_AUTH_MODE === 'oauth'

// CLI subcommands (service install/uninstall, self-update, version, help) run
// and exit before the daemon boots. A bare invocation falls through to the
// server below. Both a compiled binary ([exe, <bunfs-entry>, ...args]) and
// `bun run main.ts ...args` ([bun, main.ts, ...args]) put the user args at
// index 2, so slice(2) is correct for either.
{
  const userArgs = process.argv.slice(2)
  const first = userArgs[0] ?? ''
  const isCommand = first.length > 0 && (!first.startsWith('-') || ['--version', '--help', '-v', '-h'].includes(first))
  if (isCommand) {
    const { runCli } = await import('./cli/index.js')
    if (await runCli(userArgs)) {
      process.exit(process.exitCode ?? 0)
    }
  }
}

const errMsg = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// CLI multi-instance: --profile <name> (or KAIBOT_PROFILE) runs a headless
// instance against an isolated data dir under ~/.kaibot/executor/<name>/.
// --data-dir <path> (or KAIBOT_DATA_DIR) isolates against an explicit dir.
// Neither = legacy behavior (cwd/data, fixed port) — the Tauri path.
function getArg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1]
  return undefined
}

const profile = getArg('profile') || process.env.KAIBOT_PROFILE || undefined
// Isolated data dir resolution. A bare `--data-dir <path>` (or KAIBOT_DATA_DIR)
// isolates the DB + crypto material + .port file without needing a profile name
// — the e2e recipe. A `--profile <name>` maps to ~/.kaibot/executor/<name>/.
const explicitDataDir = getArg('data-dir') || process.env.KAIBOT_DATA_DIR || undefined
const profileDataDir = explicitDataDir
  ? path.resolve(explicitDataDir)
  : profile
    ? path.join(os.homedir(), '.kaibot', 'executor', profile)
    : undefined
// Publish the resolved dir so crypto.ts (salt/secret) and database.ts agree —
// without this the profile DB and crypto material split across two dirs and the
// isolated instance can't decrypt its own keys.
if (profileDataDir) process.env.KAIBOT_DATA_DIR = profileDataDir
// Desktop bundle: Finder launches the sidecar with cwd=/ — the cwd-relative
// default (`./data`) would mkdir /data and crash the first boot. Anchor the
// desktop data dir where desktop.port already lives. Deliberately NOT via
// profileDataDir: that would rename the port file and break shell discovery.
if (!profileDataDir && getBuildType() === 'tauri') {
  process.env.KAIBOT_DATA_DIR = path.join(os.homedir(), '.kaibot', 'executor')
}
const explicitPort = getArg('port') || process.env.PORT || undefined

function findFreePort(start: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (p: number) => {
      const srv = net.createServer()
      srv.once('error', (err: any) => {
        if (err.code === 'EADDRINUSE') tryPort(p + 1)
        else reject(err)
      })
      srv.once('listening', () => srv.close(() => resolve(p)))
      srv.listen(p, '127.0.0.1')
    }
    tryPort(start)
  })
}

// Locate the built web UI (dist). One UI is served by the daemon in every mode
// — desktop (Tauri webview navigates here), CLI and Docker all hit the same
// bundle. The layout differs per packaging, so probe a few well-known spots
// and let an explicit env override win (Tauri sets KAIBOT_STATIC_DIR to the
// bundled resource dir; the Docker image ships dist next to the binary).
function resolveStaticDir(): string | undefined {
  const candidates = [
    process.env.KAIBOT_STATIC_DIR,
    path.join(path.dirname(process.execPath), 'dist'),
    path.join(path.dirname(process.execPath), '..', 'Resources', 'dist'),
    path.join(__dirname, '..', '..', 'dist'),
    path.join(process.cwd(), 'dist'),
  ].filter((p): p is string => Boolean(p))
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'index.html'))) return dir
    } catch {
      /* ignore unreadable candidate */
    }
  }
  return undefined
}

// Resolve the listen port and the discovery file up-front so logs, the health
// endpoint and the static host all agree. Desktop now discovers a free port
// (starting at 9100) instead of assuming a fixed one, and publishes it to a
// `.port` file the Tauri shell reads to know where to navigate the webview.
const portFile = profileDataDir
  ? path.join(profileDataDir, '.port')
  : isDesktop
    ? path.join(os.homedir(), '.kaibot', 'executor', 'desktop.port')
    : undefined

let port: number
if (explicitPort) {
  port = parseInt(explicitPort)
} else if (profile || isDesktop) {
  port = await findFreePort(9100)
} else {
  port = 8080
}
// Make the resolved port visible to everything that reads process.env.PORT
// (tradestation-oauth callback URL, CORS, logs) so it stays consistent.
process.env.PORT = String(port)

const app = new Hono()

// Configure CORS to accept connections from different ports.
const staticCorsOrigins = new Set([
  'tauri://localhost',
  'http://localhost:1420',
  'http://localhost:8080',
  ...(process.env.VITE_PORT ? [`http://localhost:${process.env.VITE_PORT}`] : []),
])
const allowAnyLocalhost = process.env.NODE_ENV !== 'production'
const localhostOriginPattern = /^http:\/\/localhost:\d+$/

app.use('*', cors({
  // Reflect the request origin when it is allowlisted, so credentials work.
  origin: (origin) => {
    if (!origin) return origin
    if (staticCorsOrigins.has(origin)) return origin
    if (allowAnyLocalhost && localhostOriginPattern.test(origin)) return origin
    return null
  },
  credentials: true,
}))

const db = new KaiBotDatabase(profileDataDir ? path.join(profileDataDir, 'kaibot.db') : undefined)
const crypto = new Crypto()
const exchangeManager = new ExchangeManager(db)

// Last-resort safety net: an unhandled rejection anywhere (a timer callback, a
// forgotten await) must never crash the executor while it manages live
// positions. Log it loudly and keep running.
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.stack ?? reason.message : String(reason)
  console.error('Unhandled promise rejection (executor continues):', msg)
  try {
    db.log('error', 'system', 'Unhandled promise rejection', { error: msg })
  } catch {
    /* logging must never throw from the handler */
  }
})

// Auth gate. Desktop is a loopback-only sidecar owned by the local user, so it
// trusts the local caller; web mode requires a valid session token. Routes
// needed before/around login stay public.
const PUBLIC_API_PATHS = new Set([
  '/api/health',
  '/api/auth/login',
  '/api/auth/setup',
  '/api/auth/me',
  '/api/auth/logout',
  // TradeStation redirects the browser here as a top-level navigation after the
  // user authorizes — it carries no session token, so the callback is public.
  // The handler only exchanges an opaque one-time code for tokens.
  '/api/exchanges/v2/callback/tradestation',
])
const requireAuth = createAuthMiddleware(db, { trustLocal: isDesktop })
app.use('/api/*', async (c, next) => {
  if (PUBLIC_API_PATHS.has(c.req.path)) return next()
  return requireAuth(c, next)
})

const signalClient = new SignalWebSocketClient(db, exchangeManager, notificationBus)
// Opt-in: roll a lineage position to the next contract when the engine's root
// switches (services/futures-roll). Default = report only.
signalClient.setAutoRoll(process.env.EXECUTOR_AUTO_ROLL === '1')

// Remote-companion control plane (opt-in, default OFF). The StatePusher pushes
// the executor state snapshot up the WS only while remote management is enabled;
// the command handler dispatches relayed commands to the local services. The
// signal client gets both injected so the executor_command case + on-connect
// push work without coupling the WS client to the companion internals.
const companion = new CompanionService(db, crypto)
const statePusher = new StatePusher({
  db,
  exchangeManager,
  companion,
  send: (msg) => signalClient.sendCompanionMessage(msg),
  isConnected: () => signalClient.isConnected(),
})
signalClient.setCompanion({ db, exchangeManager, companion }, statePusher)
// Pushed after any local mutation (panic/halt/guardrail/bot/subscription) so the
// companion reflects desktop-UI changes too, not only relayed ones.
const pushStateNow = () => statePusher.pushStateNow()

const balancePoller = new BalanceSnapshotPoller(db, exchangeManager)
const LOCAL_TRAILING_ENABLED = isLocalTrailingEnabled()
// The poll loop always runs so trails the user armed EXPLICITLY on a position
// (/api/trade/manage, source='manual') are driven; SIGNAL-armed trails stay
// gated behind EXECUTOR_LOCAL_TRAILING (SPINE: the executor never decides).
// User-armed hedge guards (edge hedge): shared between the tick loop (trigger
// watch + wind-down) and the /api/trade/hedge routes (arm/close).
const hedgeGuardService = createHedgeGuardService(db, exchangeManager, {}, {}, notificationBus)
// Synthetic USD service + the armed-synthetic guard (operator-armed trigger,
// edge mints through the same mint path). Shared by the tick loop and routes.
const syntheticUsdService = createSyntheticUsdService(db, exchangeManager)
const syntheticGuardService = createSyntheticGuardService(
  db, exchangeManager, syntheticUsdService, notificationBus,
)
const localPositionManager = new LocalPositionManager(db, exchangeManager, notificationBus, {
  signalTrailingEnabled: LOCAL_TRAILING_ENABLED,
  hedgeTicker: hedgeGuardService,
  syntheticTicker: syntheticGuardService,
  rebindBracketStop: (exchange, signalId, newSlOrderId) =>
    signalClient.rebindBracketStop(exchange, signalId, newSlOrderId),
  // Manual-close-parity cleanup when an edge manager fully closes a position
  // (risk-guard global stop, TP ladder without runner): retire the OCO bracket
  // legs and any resting pre-authorized entry rungs.
  retireBracket: (exchange, signalId) => signalClient.retireBracket(exchange, signalId),
  cancelEntryRungs: (exchange, signalIds) =>
    signalClient.cancelRestingDcaRungsForSignals(exchange, signalIds),
})
// Ships fills + equity to the server's opt-in analytics ingest (server gates on
// the user's sharePortfolioData flag; this runs unconditionally and is skipped
// server-side when the user keeps their data local).
const portfolioShipper = new PortfolioShipper(db, {
  getApiUrl: () => signalClient.getApiUrl(),
  getApiKey: () => signalClient.getApiKey(),
})

// Bot-config projection sync (identity/routing only, no strategy code): keeps
// the local bot_configs table — the source for the bot control plane,
// take-over/detach and the companion snapshot — populated from the server.
// sync() no-ops (returns null) until the signal client has connected and
// exposes an API URL + key.
const botConfigSync = new BotConfigSync(db, {
  getApiUrl: () => signalClient.getApiUrl(),
  getApiKey: () => signalClient.getApiKey(),
})
const BOT_CONFIG_SYNC_INTERVAL_MS = 5 * 60_000
const botConfigSyncTimer: NodeJS.Timeout = setInterval(() => {
  botConfigSync.sync().catch((err: unknown) => {
    db.log('warn', 'system', 'Bot config sync failed', { error: errMsg(err) })
  })
}, BOT_CONFIG_SYNC_INTERVAL_MS)
// First sync shortly after the delayed WS auto-connect (below) so fresh
// installs see their bots without waiting a full interval.
setTimeout(() => {
  botConfigSync.sync().catch((err: unknown) => {
    db.log('warn', 'system', 'Initial bot config sync failed', { error: errMsg(err) })
  })
}, 5000)

// External alerting: forwards operationally significant notification-bus events
// to a configured webhook (Google Chat / Slack-compatible) and re-alerts while
// the signal service stays down. Config lives in user settings (alerting.*).
const alerting = new AlertingService({
  db,
  bus: notificationBus,
  isSignalServiceConnected: () => signalClient.isConnected(),
})

// Position reconciler (TradeStation-scoped) — drives the broker net toward our
// expected net under tight safeguards. Resolves unknown-outcome orders and
// retries pending closes in the same locked tick before reconciling.
const reconciler = new Reconciler({
  db,
  exchangeManager,
  notifications: notificationBus,
  retryPendingCloses: (exchange) => signalClient.retryPendingCloses(exchange),
  resolveUnknownOrders: (exchange) => signalClient.resolveUnknownOrders(exchange),
  expireDcaRungs: (exchange) => signalClient.expireDcaRungs(exchange),
  sweepRestingExits: (exchange) => signalClient.sweepRestingExitOrders(exchange),
  adoptVenueClose: (input) => signalClient.adoptVenueClose(input),
})

// Synthetic USD auto-rebalancer (doubly opt-in: env gate + per-position flag).
const SYNTHETIC_REBALANCE_ENABLED = isSyntheticRebalanceEnabled()
const syntheticRebalancer = new SyntheticRebalancer({
  db,
  exchangeManager,
  service: syntheticUsdService,
  notifications: notificationBus,
})

// Rehydrate persisted OCO bracket pairs so a restart can still cancel the
// sibling leg when one fills.
signalClient.loadPersistedBrackets()
// Entries parked on a closed market (migration 037) survive a restart: the
// poller resumes them once their venue trades again.
signalClient.startDeferredEntryPoller()

// 'tradestation' adapter selected by TRADESTATION_AUTH_MODE (see top of file).
// OAuth → self-managing adapter (own session + refresh timer). CouchDB → legacy
// KaiBotWeb session: kaibotweb owns the OAuth flow + refresh, the executor reads
// its access_token.
// Factories, not instances: each connected session gets its own adapter so
// sessions can never rebind each other's credentials (EX3).
exchangeManager.registerExchange('tradestation', () =>
  TRADESTATION_USE_OAUTH ? new TradeStationOAuthAdapter() : new TradeStationCouchDBAdapter(),
)
exchangeManager.registerExchange('deribit', () => new DeribitAdapter())
exchangeManager.registerExchange('bybit', () => new BybitAdapter())
exchangeManager.registerExchange('binance', () => new BinanceAdapter())
exchangeManager.registerExchange('interactive-brokers', () => new InteractiveBrokersAdapter())
// Test-only in-memory venue for headless verification runs. Never registered
// unless explicitly opted in; EXECUTOR_PAPER_MARKS seeds mark prices as JSON
// ({"MNQZ26": 24100}).
if (process.env.EXECUTOR_ENABLE_PAPER === '1') {
  exchangeManager.registerExchange('paper', () => {
    let marks: Record<string, number> = {}
    try {
      marks = JSON.parse(process.env.EXECUTOR_PAPER_MARKS ?? '{}')
    } catch {
      /* bad JSON → no seeded marks */
    }
    return new PaperExchangeAdapter('paper', marks)
  })
}

// OCO bracket cancel-on-fill: whenever an exchange reports an order update,
// let the signal client decide whether it's a tracked bracket leg and, if so,
// cancel its sibling to emulate OCO behavior.
exchangeManager.on('exchangeUpdate', (payload: any) => {
  if (payload?.type !== 'order') return
  const order = payload.data
  if (!order) return
  // Deribit user.orders payload is an array of order objects.
  const entries: any[] = Array.isArray(order) ? order : [order]
  for (const entry of entries) {
    const orderId = entry?.order_id ?? entry?.orderId
    const state = entry?.order_state ?? entry?.state
    if (!orderId) continue
    void signalClient.onExchangeOrderUpdate({
      orderId,
      state,
      exchangeName: payload.exchangeName ?? 'deribit',
    })
  }
})

db.log('info', 'system', 'KaiBot Terminal starting...', {
  mode: isDesktop ? 'desktop' : profile ? `profile:${profile}` : 'web',
  port,
  tradestationAuthMode: TRADESTATION_AUTH_MODE,
})

app.get('/api/health', (c) => {
  return c.json({
    status: 'ok',
    mode: isDesktop ? 'desktop' : profile ? 'profile' : 'web',
    port,
    timestamp: new Date().toISOString()
  })
})

// Runtime capabilities the UI has to know before it renders a connect form.
app.get('/api/config', (c) => {
  return c.json({ tradestationAuthMode: TRADESTATION_AUTH_MODE })
})

app.post('/api/auth/login', async (c) => {
  const { username, password } = await c.req.json()
  
  try {
    const isValid = await db.validateUser(username, password)
    if (isValid) {
      const user = db.getAdminUser()
      const token = issueSession(db, user.id)
      db.log('info', 'system', 'User logged in', { username })
      return c.json({ token, username })
    }
    return c.json({ error: 'Invalid credentials' }, 401)
  } catch (error) {
    db.log('error', 'system', 'Login failed', { error: errMsg(error) })
    return c.json({ error: 'Login failed' }, 500)
  }
})

app.post('/api/auth/logout', (c) => {
  const token = extractToken(c)
  if (token) revokeSession(db, token)
  db.log('info', 'system', 'User logged out')
  return c.json({ success: true })
})

app.post('/api/auth/setup', async (c) => {
  const { username, password } = await c.req.json()

  try {
    // First-run landgrab guard (web/Docker mode): setup token when configured,
    // loopback-only otherwise. See auth/setup-gate.ts.
    const gate = checkSetupGate({
      isDesktop,
      setupToken: process.env.EXECUTOR_SETUP_TOKEN,
      providedToken: c.req.header('x-setup-token'),
      remoteAddress: (c.env as any)?.incoming?.socket?.remoteAddress as string | undefined,
    })
    if (!gate.allowed) {
      db.log('warn', 'system', 'Setup refused', { reason: gate.reason })
      return c.json(
        {
          error:
            gate.reason === 'bad_token'
              ? 'Setup token required (x-setup-token header)'
              : 'First-run setup over the network requires EXECUTOR_SETUP_TOKEN',
        },
        403,
      )
    }

    if (await db.hasAdminUser()) {
      return c.json({ error: 'Admin user already exists' }, 400)
    }

    await db.createAdminUser(username, password)
    const user = db.getAdminUser()
    const token = issueSession(db, user.id)
    db.log('info', 'system', 'Admin user created', { username })
    return c.json({ success: true, token, username })
  } catch (error) {
    db.log('error', 'system', 'Setup failed', { error: errMsg(error) })
    return c.json({ error: 'Setup failed' }, 500)
  }
})

app.get('/api/auth/me', async (c) => {
  try {
    const user = db.getAdminUser()
    if (!user) {
      return c.json({ error: 'No user found' }, 404)
    }

    let groups: string[] = []
    try {
      const settings = user.settings ? JSON.parse(user.settings) : {}
      const apiUrl = settings.apiConfig?.apiUrl || process.env.KAIBOT_API_URL
      const apiKey = settings.apiConfig?.apiKey
      if (apiUrl && apiKey) {
        const remote = await fetch(`${apiUrl}/api/trpc/users.me`, {
          headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
        })
        if (remote.ok) {
          const payload = await remote.json() as any
          const remoteGroups = payload?.result?.data?.groups
          if (Array.isArray(remoteGroups)) groups = remoteGroups
        }
      }
    } catch (err) {
      db.log('warn', 'system', 'Failed to fetch remote user groups', { error: err instanceof Error ? err.message : String(err) })
    }

    return c.json({
      username: user.username,
      name: user.username,
      email: `${user.username}@kaibot-executor.local`,
      groups,
    })
  } catch (error) {
    db.log('error', 'system', 'Failed to get current user', { error: errMsg(error) })
    return c.json({ error: 'Failed to get user' }, 500)
  }
})

app.post('/api/keys', async (c) => {
  const { name, apiKey, permissions } = await c.req.json()
  
  try {
    const encryptedKey = crypto.encryptApiKey(apiKey)
    db.storeApiKey(name, encryptedKey, permissions)
    db.log('info', 'system', 'API key stored', { name })
    return c.json({ success: true })
  } catch (error) {
    db.log('error', 'system', 'Failed to store API key', { error: error instanceof Error ? error.message : String(error) })
    return c.json({ error: 'Failed to store API key' }, 500)
  }
})

app.get('/api/keys', (c) => {
  try {
    const keys = db.getActiveApiKeys()
    return c.json(keys.map((k: any) => ({
      id: k.id,
      name: k.name,
      permissions: JSON.parse(k.permissions || '[]'),
      last_validated: k.last_validated,
      created_at: k.created_at
    })))
  } catch (error) {
    db.log('error', 'system', 'Failed to get API keys', { error: error instanceof Error ? error.message : String(error) })
    return c.json({ error: 'Failed to get API keys' }, 500)
  }
})

app.get('/api/user/settings', (c) => {
  try {
    const user = db.getAdminUser()
    if (!user) {
      return c.json({ error: 'User not found' }, 404)
    }
    
    const settings = user.settings ? JSON.parse(user.settings) : {}
    return c.json({ settings })
  } catch (error) {
    db.log('error', 'system', 'Failed to get user settings', { error: errMsg(error) })
    return c.json({ error: 'Failed to get user settings' }, 500)
  }
})

app.put('/api/user/settings', async (c) => {
  try {
    const { settings } = await c.req.json()
    const user = db.getAdminUser()
    if (!user) {
      return c.json({ error: 'User not found' }, 404)
    }
    
    db.updateUserSettings(user.id, JSON.stringify(settings))
    db.log('info', 'system', 'User settings updated')
    return c.json({ success: true })
  } catch (error) {
    db.log('error', 'system', 'Failed to update user settings', { error: errMsg(error) })
    return c.json({ error: 'Failed to update user settings' }, 500)
  }
})

app.post('/api/test-connection', async (c) => {
  try {
    const { apiUrl, apiKey } = await c.req.json()
    
    if (!apiUrl || !apiKey) {
      return c.json({ error: 'API URL and API Key are required' }, 400)
    }
    
    // Test the connection to the API server
    const response = await fetch(`${apiUrl}/api/trpc/users.me`, {
      headers: {
        'X-API-Key': apiKey,
        'Content-Type': 'application/json',
      },
    })
    
    if (response.ok) {
      db.log('info', 'connection', 'API connection test successful', { apiUrl })
      return c.json({ success: true, message: 'Connection successful' })
    } else if (response.status === 401) {
      return c.json({ error: 'Invalid API key' }, 401)
    } else {
      return c.json({ error: 'Failed to connect to API server' }, 500)
    }
  } catch (error) {
    db.log('error', 'connection', 'API connection test failed', { error: errMsg(error) })
    return c.json({ error: `Connection failed: ${errMsg(error)}` }, 500)
  }
})

app.get('/api/ws/status', (c) => {
  return c.json({
    connected: signalClient.isConnected(),
    status: signalClient.getConnectionStatus(),
    ...signalClient.getReconnectInfo(),
    version: EXECUTOR_VERSION,
    buildType: getBuildType(),
    update: signalClient.getUpdateInfo(),
  })
})

app.post('/api/ws/connect', async (c) => {
  try {
    const user = db.getAdminUser()
    if (!user || !user.settings) {
      return c.json({ error: 'No API configuration found' }, 400)
    }
    
    const settings = JSON.parse(user.settings)
    if (!settings.apiConfig?.apiUrl || !settings.apiConfig?.apiKey) {
      return c.json({ error: 'API configuration incomplete' }, 400)
    }
    
    signalClient.connect(settings.apiConfig.apiUrl, settings.apiConfig.apiKey)
    db.log('info', 'connection', 'WebSocket connection initiated')
    
    return c.json({ success: true, message: 'Connecting to signal service' })
  } catch (error) {
    db.log('error', 'connection', 'Failed to connect WebSocket', { error: errMsg(error) })
    return c.json({ error: 'Failed to connect' }, 500)
  }
})

app.post('/api/ws/disconnect', (c) => {
  signalClient.disconnect()
  return c.json({ success: true, message: 'Disconnected from signal service' })
})

app.post('/api/exchanges', async (c) => {
  const { name, type, credentials, isPaper } = await c.req.json()
  
  try {
    const encryptedCreds = crypto.encryptCredentials(credentials)
    db.addExchange(name, type, encryptedCreds, isPaper)
    db.log('info', 'system', 'Exchange added', { name, type, isPaper })
    return c.json({ success: true })
  } catch (error) {
    db.log('error', 'system', 'Failed to add exchange', { error: error instanceof Error ? error.message : String(error) })
    return c.json({ error: 'Failed to add exchange' }, 500)
  }
})

app.get('/api/exchanges', (c) => {
  try {
    const exchanges = db.getExchanges()
    return c.json(exchanges.map((e: any) => ({
      id: e.id,
      name: e.name,
      type: e.type,
      is_active: e.is_active,
      is_paper: e.is_paper,
      last_connected: e.last_connected,
      created_at: e.created_at
    })))
  } catch (error) {
    db.log('error', 'system', 'Failed to get exchanges', { error: error instanceof Error ? error.message : String(error) })
    return c.json({ error: 'Failed to get exchanges' }, 500)
  }
})

app.get('/api/positions', async (c) => {
  // Positions live on the exchange, not in a local table. Aggregate the live
  // open positions across every connected session for the default user.
  try {
    const sessions = await exchangeManager.getAllSessions('default')
    const positions: any[] = []
    const unavailable: string[] = []
    for (const session of sessions) {
      if (session.status !== 'connected') {
        // A venue we have keys for but cannot reach right now. pending_oauth
        // never held positions and is not a reachability failure.
        if (session.status !== 'pending_oauth') unavailable.push(session.exchangeName)
        continue
      }
      try {
        const live = await session.adapter.getPositions()
        for (const p of live.filter(isOpenPosition)) {
          positions.push({ ...p, exchange_name: session.exchangeName, accountKey: session.accountKey ?? null })
        }
      } catch (err) {
        unavailable.push(session.exchangeName)
        db.log('warn', 'trading', 'Failed to fetch positions for exchange', {
          exchange: session.exchangeName,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    // A venue that could not be read is NOT flat (2026-09-06 blip: an empty
    // list here read as "FLAT" to the watchers). Non-2xx + an explicit flag so
    // an array-parsing consumer cannot mistake the partial answer for the book.
    if (unavailable.length > 0) {
      return c.json(positionsUnavailableBody(positions, unavailable), 503)
    }
    return c.json(positions)
  } catch (error) {
    db.log('error', 'trading', 'Failed to get positions', { error: error instanceof Error ? error.message : String(error) })
    return c.json({ error: 'Failed to get positions' }, 500)
  }
})

app.get('/api/signals', (c) => {
  try {
    const signals = db.getRecentSignals(50)
    return c.json(signals)
  } catch (error) {
    db.log('error', 'signal', 'Failed to get signals', { error: error instanceof Error ? error.message : String(error) })
    return c.json({ error: 'Failed to get signals' }, 500)
  }
})

// Equity curve from real balance snapshots (written by the BalanceSnapshotPoller).
// Each point is total equity across all accounts at one snapshot timestamp.
app.get('/api/performance/equity-history', (c) => {
  const range = c.req.query('range') || '1M'
  const daysByRange: Record<string, number> = {
    '1W': 7,
    '1M': 30,
    '3M': 90,
    '1Y': 365,
    'ALL': 3650,
  }
  const days = daysByRange[range] ?? 30
  try {
    const since = Date.now() - days * 86_400_000
    const snapshots = db.getEquitySnapshots(since)
    const baseline = snapshots.length > 0 ? snapshots[0].equity : 0
    const series = snapshots.map((s) => ({
      date: new Date(s.ts).toISOString(),
      equity: s.equity, // absolute total equity
      pnl: s.equity - baseline, // change since the first point in range
      unrealizedPnL: s.unrealizedPnL,
    }))
    return c.json({ range, days, series })
  } catch (error) {
    db.log('error', 'performance', 'Failed to get equity history', { error: error instanceof Error ? error.message : String(error) })
    return c.json({ error: 'Failed to get equity history' }, 500)
  }
})

// Fills-based per-signal PnL for the most recent executed signals. Realized
// (and, for still-open signals, unrealized when a mark price is available)
// computed from the stored fills with per-root futures multipliers.
app.get('/api/performance/signal-pnl', (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200)
  try {
    // Pull recent executions, then their fills in one batched query.
    const execs = db.all(
      `SELECT * FROM signal_executions ORDER BY updated_at DESC LIMIT ?`,
      [limit],
    ) as Array<{
      signal_id: string
      symbol: string
      exchange: string
      direction: 'long' | 'short'
      status: 'open' | 'closed' | 'error'
      qty_opened: number
      qty_closed: number
      updated_at: number
    }>

    const fillsBySignal = new Map<string, any[]>()
    const allFills = db.getFillsForSignals(execs.map((e) => e.signal_id))
    for (const f of allFills) {
      const arr = fillsBySignal.get(f.signal_id) ?? []
      arr.push(f)
      fillsBySignal.set(f.signal_id, arr)
    }

    const rows = execs.map((e) => {
      const pnl = computeSignalPnl(e, fillsBySignal.get(e.signal_id) ?? [])
      return {
        signalId: e.signal_id,
        symbol: e.symbol,
        exchange: e.exchange,
        direction: e.direction,
        status: e.status,
        qtyOpened: e.qty_opened,
        qtyClosed: e.qty_closed,
        entryAvg: pnl.entryAvg,
        exitAvg: pnl.exitAvg,
        realizedPnl: pnl.realizedPnl,
        realizedNet: pnl.realizedNet,
        commission: pnl.commission,
        unrealizedPnl: pnl.unrealizedPnl,
        multiplier: pnl.multiplier,
        basis: pnl.basis,
        updatedAt: e.updated_at,
      }
    })

    const realizedTotal = rows.reduce((s, r) => s + (r.realizedNet || 0), 0)
    return c.json({ basis: 'fills', realizedTotal, rows })
  } catch (error) {
    db.log('error', 'performance', 'Failed to compute signal PnL', { error: error instanceof Error ? error.message : String(error) })
    return c.json({ error: 'Failed to compute signal PnL' }, 500)
  }
})

// Local closed-trade analytics: win rate, profit factor, max drawdown, avg
// duration, cumulative realized P&L and per-market distribution. Computed on the
// executor from its own fills — no portfolio sharing involved. Same metric
// definitions as the web app's shared-portfolio analytics (see services/analytics.ts).
app.get('/api/performance/analytics', (c) => {
  const timeframe = (c.req.query('timeframe') || 'ALL').toUpperCase()
  const daysByTimeframe: Record<string, number> = {
    '1W': 7,
    '1M': 30,
    '3M': 90,
    '1Y': 365,
    'ALL': 0,
  }
  const days = daysByTimeframe[timeframe] ?? 0
  // Filter bar. Lists arrive comma-separated, the free range as ms epochs
  // (the client owns the calendar-day boundaries, in the reader's own zone).
  const list = (name: string): string[] =>
    (c.req.query(name) || '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
  const msParam = (name: string): number | null => {
    const raw = c.req.query(name)
    if (!raw) return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  }
  const rawDirection = (c.req.query('direction') || 'both').toLowerCase()
  const filter: AnalyticsFilter = {
    accounts: list('accounts'),
    strategies: list('strategies'),
    symbols: list('symbols'),
    direction: rawDirection === 'long' || rawDirection === 'short' ? rawDirection : 'both',
    from: msParam('from'),
    to: msParam('to'),
    includeNonBot: c.req.query('nonBot') !== '0',
  }
  try {
    const execs = db.all(
      `SELECT signal_id, symbol, direction, status, qty_opened, qty_closed, exchange, account_id
         FROM signal_executions WHERE status = 'closed'`,
      [],
    ) as Array<{
      signal_id: string
      symbol: string
      direction: 'long' | 'short'
      status: 'open' | 'closed' | 'error'
      qty_opened: number
      qty_closed: number
      exchange: string
      account_id: string | null
    }>

    // Bot attribution per closed execution, resolved LOCALLY and by LINEAGE
    // (see services/analytics-attribution.ts). Nothing here is fetched from or
    // shipped to the server.
    const labelsBySignal = buildStrategyLabels(db, execs)

    const fillsBySignal = new Map<string, SignalFillRow[]>()
    const allFills = db.getFillsForSignals(execs.map((e) => e.signal_id))
    for (const f of allFills) {
      const arr = fillsBySignal.get(f.signal_id) ?? []
      arr.push(f)
      fillsBySignal.set(f.signal_id, arr)
    }

    const allRows = closedRowsFromExecutions(execs, fillsBySignal, labelsBySignal)
    // A free range replaces the preset window; without one the preset applies.
    const rangeFilter: AnalyticsFilter =
      filter.from != null || filter.to != null
        ? filter
        : { ...filter, from: days > 0 ? Date.now() - days * 86_400_000 : null }
    const closed = filterClosedRows(allRows, rangeFilter)

    return c.json({
      timeframe,
      basis: 'fills',
      // Choices for the filter bar, from the WHOLE ledger: narrowing to one
      // account must not make the others disappear from the menu.
      filterOptions: filterOptionsFrom(allRows),
      // What the numbers below actually describe, echoed back.
      appliedFilter: rangeFilter,
      totalClosedTrades: allRows.length,
      // Ledger-wide (not timeframe-scoped): closed executions whose exit fill was
      // never recorded, so no result can be computed for them. Reported so the
      // trade count doesn't read as the whole truth.
      unpricedClosedTrades: countUnpricedCloses(execs, fillsBySignal),
      summary: buildSummary(closed),
      cumulativePnl: buildCumulativePnl(closed),
      distribution: buildTradeDistribution(closed),
      // Per-bot scorecards over the SAME rows and the same conventions.
      byStrategy: buildStrategyScorecards(closed),
      // Per-trade breakdown for the closed-trades table. Same rows the summary
      // and charts are built from, so nothing is computed a second way.
      closedTrades: closed.map((r) => ({
        symbol: r.symbol,
        direction: r.direction,
        entryAvg: r.entryAvg,
        exitAvg: r.exitAvg,
        netPnl: r.realizedPnl,
        durationMs: Math.max(0, r.closedAt - r.openDate),
        closedAt: r.closedAt,
      })),
    })
  } catch (error) {
    db.log('error', 'performance', 'Failed to compute analytics', {
      error: error instanceof Error ? error.message : String(error),
    })
    return c.json({ error: 'Failed to compute analytics' }, 500)
  }
})

app.get('/api/logs', (c) => {
  const level = c.req.query('level')
  const limit = parseInt(c.req.query('limit') || '100')
  
  try {
    const logs = db.getRecentLogs(limit, level)
    return c.json(logs)
  } catch (error) {
    return c.json({ error: 'Failed to get logs' }, 500)
  }
})

const exchangeRoutes = createExchangeRoutes(db, exchangeManager, (botId, symbol) =>
  botConfigSync.getLadder(botId, symbol),
)
app.route('/api/exchanges/v2', exchangeRoutes)

const subscriptionRoutes = createSubscriptionRoutes(db, pushStateNow, exchangeManager)
app.route('/api/subscriptions', subscriptionRoutes)

const operationsRoutes = createOperationsRoutes(
  db,
  exchangeManager,
  alerting,
  pushStateNow,
  (positionId, fill) => signalClient.reportVenueExitToApi(positionId, fill),
  () => reconciler.status(),
)
app.route('/api/ops', operationsRoutes)

const syntheticUsdRoutes = createSyntheticUsdRoutes(db, exchangeManager, {
  service: syntheticUsdService,
  guard: syntheticGuardService,
})
app.route('/api/synthetic-usd', syntheticUsdRoutes)

// Manual (discretionary) trading on the user's own connected exchange. Edge-side
// order placement / close — no server signal. The web terminal never trades. A
// manual bracket joins the signal client's OCO tracker so a leg fill cancels its
// sibling (in-session + across a restart).
// Ride hand-over: the manual-close → server hook needs the service outside
// the routes too (same deps, one instance).
const rideHandoverService = createRideHandoverService(db, exchangeManager, {
  postToServer: (path, body) => signalClient.postToServer(path, body),
  reportVenueExit: (positionId, fill) => signalClient.reportVenueExitToApi(positionId, fill),
})
signalClient.setEntryFilledHook((input) => rideHandoverService.adoptEntry(input))
const manualTradeRoutes = createManualTradeRoutes(
  db,
  exchangeManager,
  {
    registerBracket: (exchange, signalId, slOrderId, tpOrderIds, accountId) =>
      signalClient.registerBracket(exchange, signalId, slOrderId, tpOrderIds, accountId),
    retireBracket: (exchange, signalId) => signalClient.retireBracket(exchange, signalId),
    cancelEntryRungs: (exchange, signalIds) =>
      signalClient.cancelRestingDcaRungsForSignals(exchange, signalIds),
    postToServer: (path, body) => signalClient.postToServer(path, body),
    reportVenueExit: (positionId, fill) => signalClient.reportVenueExitToApi(positionId, fill),
    onExitAttributed: (exchange, allocations, fill) =>
      rideHandoverService.onExitAttributed(exchange, allocations, fill),
    ackAdoptedEntry: (signalId, fill, slOrderId) => signalClient.ackAdoptedEntry(signalId, fill, slOrderId),
    notify: (event) => notificationBus.publish(event),
  },
  hedgeGuardService,
)
app.route('/api/trade', manualTradeRoutes)

// Recovery-ladder composer (pilot-ladder F4): proxies the PROTECTED server
// calculator with the user's own kb_ key. Only rung prices+sizes come back —
// the formula stays server-side. Falls back to the saved apiConfig when the
// signal WS hasn't connected yet (compose needs no live WS).
const cloudApiConfig = (): { apiUrl: string | null; apiKey: string | null } => {
  try {
    const user = db.getAdminUser()
    const settings = user?.settings ? JSON.parse(user.settings) : {}
    return {
      apiUrl: settings.apiConfig?.apiUrl || process.env.KAIBOT_API_URL || null,
      apiKey: settings.apiConfig?.apiKey || null,
    }
  } catch {
    return { apiUrl: null, apiKey: null }
  }
}
const composeRecoveryRoutes = createComposeRecoveryRoutes(
  db,
  createRecoveryComposeService({
    getApiUrl: () => signalClient.getApiUrl() ?? cloudApiConfig().apiUrl,
    getApiKey: () => signalClient.getApiKey() ?? cloudApiConfig().apiKey,
  }),
)
app.route('/api/trade', composeRecoveryRoutes)

// Bot control plane for the embedded terminal: list / start / stop / detach.
const botRoutes = createBotRoutes(db, pushStateNow)
app.route('/api/bots', botRoutes)

// Studio-in-Terminal embed hand-off: API key → short-lived embed token (key
// never reaches the browser). Verify + cookie happen on the API side.
const studioEmbedRoutes = createStudioEmbedRoutes(db, {
  getApiUrl: () => signalClient.getApiUrl(),
  getApiKey: () => signalClient.getApiKey(),
})
app.route('/api/studio', studioEmbedRoutes)

// Position groups: CRUD + assignment + aggregated overview (G0) and the two
// operator actions close-group / tighten-stops (G2, reduce/protect-only) —
// they ride the manual close path, so they share its bracket-cleanup deps.
const positionGroupRoutes = createPositionGroupRoutes(
  db,
  exchangeManager,
  {
    retireBracket: (exchange, signalId) => signalClient.retireBracket(exchange, signalId),
    cancelEntryRungs: (exchange, signalIds) =>
      signalClient.cancelRestingDcaRungsForSignals(exchange, signalIds),
  },
  (botId, symbol) => botConfigSync.getLadder(botId, symbol),
)
app.route('/api/position-groups', positionGroupRoutes)

// Local-only companion routes for the executor's OWN UI (the "Remote management"
// toggle): enable/disable, pairing code, unpair. On change, push a fresh state.
const companionRoutes = createCompanionRoutes(companion, pushStateNow)
app.route('/api/companion', companionRoutes)


// Serve the web UI in every mode. The Tauri webview navigates here just like a
// browser does, so there is one host for one bundle (no native/web fork).
registerStaticUi(app, resolveStaticDir())

console.log(`Starting KaiBot Terminal Backend...`)
console.log(`Mode: ${isDesktop ? 'Desktop' : profile ? `Profile (${profile})` : 'Web'}`)
console.log(`Port: ${port}`)

// Desktop trusts the local caller (auth skipped), so it must bind loopback-only
// to keep other LAN processes from reaching protected endpoints unauthenticated.
const httpServer = serve({
  fetch: app.fetch,
  port,
  ...(isDesktop ? { hostname: '127.0.0.1' } : {}),
})

// Notification WS auth: desktop is a loopback-only sidecar that trusts the
// local caller (same as its REST layer); web/Docker mode requires the same
// valid session token as REST — via header for API clients or ?token= for
// browsers (WebSocket() can't set headers).
notificationBus.attach(httpServer as any, {
  authorize: (req) => {
    if (isDesktop) return true
    const auth = req.headers['authorization']
    const bearer = typeof auth === 'string' ? /^Bearer\s+(.+)$/i.exec(auth.trim())?.[1] : undefined
    const headerToken = req.headers['x-auth-token']
    const queryToken = new URL(req.url ?? '/', 'http://localhost').searchParams.get('token')
    const token =
      bearer?.trim() ||
      (typeof headerToken === 'string' ? headerToken.trim() : undefined) ||
      queryToken?.trim()
    if (!token) return false
    return !!db.getValidAuthSession(hashToken(token))
  },
})

// Publish the bound port so external tooling — and the Tauri shell, which reads
// it to know where to navigate the webview — can discover this instance.
if (portFile) {
  try {
    fs.mkdirSync(path.dirname(portFile), { recursive: true })
    fs.writeFileSync(portFile, String(port))
  } catch (error) {
    console.error('Failed to write .port file:', error)
  }
}

console.log('Backend started successfully')

// Standalone (CLI/Docker) builds nudge when a newer release is out. The desktop
// shell handles updates via tauri-plugin-updater, so skip it there.
if (getBuildType() !== 'tauri') {
  void logUpdateHintOnStart()
}

// Restore every persisted exchange session on boot, then run the TradeStation
// boot path selected by TRADESTATION_AUTH_MODE (see top of file). Deribit /
// Bybit / IB always restore through the shared path here unchanged.
//
// OAuth: the RESTORE path — if a previous run stored encrypted OAuth credentials
// (incl. the offline_access refresh token) in exchange_connections,
// restoreSessions decrypts them and calls connect(), which silently refreshes
// the token and lets the adapter's own refresh timer take over — no CouchDB, no
// re-authorization redirect.
//
// CouchDB: the legacy auto-connect — read the access_token kaibotweb owns from
// CouchDB and connect once. Skipped when restoreSessions already woke a
// tradestation session to avoid duplicate polling intervals.
async function bootExchangeSessions() {
  try {
    await exchangeManager.restoreSessions()
  } catch (error) {
    console.error('Failed to restore exchange sessions:', error)
    db.log('error', 'system', 'Failed to restore exchange sessions', { error: error instanceof Error ? error.message : String(error) })
  }

  if (TRADESTATION_USE_OAUTH) {
    const ts = await exchangeManager.getSession('default', 'tradestation')
    if (ts && ts.status === 'connected') {
      db.log('info', 'exchange', 'TradeStation OAuth session restored on boot')
    } else {
      db.log('info', 'exchange', 'No TradeStation OAuth session to restore — connect via /api/exchanges/v2/oauth/start')
    }
  } else {
    // Web: legacy CouchDB-session auto-connect.
    if (!process.env.COUCHDB_URL || !process.env.COUCHDB_TS_SESSION_ID) return

    const existing = await exchangeManager.getSession('default', 'tradestation')
    if (existing && existing.status === 'connected') {
      db.log('info', 'exchange', 'TradeStation already connected via restored session, skipping auto-connect')
      return
    }

    try {
      await exchangeManager.connectExchange('default', 'tradestation', {
        type: 'apiKey',
        apiKey: 'couchdb-session',
        apiSecret: '',
      })
      db.log('info', 'exchange', 'TradeStation auto-connected from CouchDB session')
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error('TradeStation CouchDB auto-connect failed:', msg)
      db.log('error', 'exchange', 'TradeStation CouchDB auto-connect failed', { error: msg })
    }
  }

  // EXECUTOR_SESSION_TOKEN is an MVP shortcut consumed elsewhere (signal client /
  // subscriptions), independent of exchange auth — boot does not rely on it.
  if (process.env.EXECUTOR_SESSION_TOKEN) {
    db.log('info', 'system', 'EXECUTOR_SESSION_TOKEN present (signal-service MVP shortcut)')
  }
}
// Boot sessions, then start the balance-snapshot poller so the equity curve
// fills in from real exchange balances.
bootExchangeSessions().finally(() => {
  balancePoller.start()
  db.log('info', 'system', 'Balance snapshot poller started')
  // SPINE: the executor never decides. Signal-armed trails stay OFF unless
  // explicitly enabled (the server-side stop_update path owns those stop moves
  // by default). The loop itself always runs for trails the user armed
  // EXPLICITLY on a position via /api/trade/manage — that opt-in is per
  // position, by a human.
  localPositionManager.start()
  if (LOCAL_TRAILING_ENABLED) {
    db.log('warn', 'system', 'Local position manager: signal trails ENABLED (EXECUTOR_LOCAL_TRAILING)')
  }
  portfolioShipper.start()
  db.log('info', 'system', 'Portfolio shipper started')
  reconciler.start()
  db.log('info', 'system', 'Position reconciler started')
  // SPINE: the executor never decides. The synthetic rebalancer autonomously
  // places real orders, so it stays OFF unless explicitly enabled — and each
  // position must also opt in via its auto_rebalance flag.
  if (SYNTHETIC_REBALANCE_ENABLED) {
    syntheticRebalancer.start()
    db.log('warn', 'system', 'Synthetic USD auto-rebalancer started (SYNTHETIC_REBALANCE_ENABLED)')
  }
  alerting.start()
  db.log('info', 'system', 'External alerting started')
  // Companion state-pusher heartbeat. Self-gates on companion-enabled at fire
  // time, so it's a no-op while remote management is off (the default).
  statePusher.start()
  db.log('info', 'system', 'Companion state pusher started')
})

// Auto-connect if configured
async function autoConnectWebSocket() {
  try {
    const user = db.getAdminUser()
    if (user && user.settings) {
      const settings = JSON.parse(user.settings)
      if (settings.apiConfig?.autoConnect && settings.apiConfig?.apiUrl && settings.apiConfig?.apiKey) {
        db.log('info', 'connection', 'Auto-connecting to signal service')
        signalClient.connect(settings.apiConfig.apiUrl, settings.apiConfig.apiKey)
      }
    }
  } catch (error) {
    db.log('error', 'connection', 'Failed to auto-connect', { error: errMsg(error) })
  }
}

// Delay auto-connect to ensure server is fully started
setTimeout(autoConnectWebSocket, 2000)

const shutdown = async () => {
  console.log('Shutting down...')
  if (portFile) {
    try { fs.unlinkSync(portFile) } catch {}
  }
  signalClient.disconnect()
  signalClient.stopDeferredEntryPoller()
  clearInterval(botConfigSyncTimer)
  statePusher.stop()
  balancePoller.stop()
  localPositionManager.stop()
  portfolioShipper.stop()
  reconciler.stop()
  syntheticRebalancer.stop()
  alerting.stop()
  await exchangeManager.shutdown()
  db.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
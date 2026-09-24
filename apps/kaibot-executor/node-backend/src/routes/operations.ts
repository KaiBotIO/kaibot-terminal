import { Hono } from 'hono'
import type { KaiBotDatabase } from '../storage/database.js'
import type { ExchangeManager } from '../services/exchanges/exchangeManager.js'
import type { AlertingService } from '../services/notifications/alerting.js'
import { computeSignalPnl } from '../services/pnl.js'
import {
  KNOWN_FUTURES_ROOTS,
  isFuturesRoot,
} from '../services/exchanges/futures-contracts.js'
import { sizingRoot } from '../services/account-sizing.js'
import { findingStatus } from '../services/reconciliation-status.js'
import {
  buildCryptoMarkets,
  type CryptoConnection,
  type CryptoMarket,
  type PositionInput,
} from '../services/crypto-markets.js'
import { mapToVenueSymbol } from '../services/symbol-map.js'
import { accountKeyOf } from '../services/exchanges/account-scope.js'
import { isOpenPosition } from '../services/exchanges/open-position.js'
import type { MarketTicker } from '../services/exchanges/types.js'
import type { ReconcilerStatus } from '../services/reconciler.js'
import { panicCloseAll } from '../services/panic.js'
import {
  MGC_REPAIR_20260901,
  repairReconcilerRebuy20260901,
} from '../services/repair-reconciler-rebuy-20260901.js'
import {
  VIRTUALCLOSE_REPAIR_20260903,
  repairVirtualClose20260903,
} from '../services/repair-virtualclose-20260903.js'
import { derivePositionLineage } from '../services/position-lineage.js'
import {
  assemblePortfolio,
  assembleAccountSizes,
  assembleMarginGuards,
} from '../services/state-snapshot.js'

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Bot id from a signal's metadata JSON; null when the signal carries none. */
function signalBotIdOf(metadata: unknown): string | null {
  if (typeof metadata !== 'string' || !metadata) return null
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>
    const id = parsed.signalBotId ?? parsed.signal_bot_id
    return typeof id === 'string' && id ? id : null
  } catch {
    return null
  }
}

/** "deribit" or "deribit · acct1". */
function connectionLabelOf(exchange: string, accountKey: string | null): string {
  return accountKey ? `${exchange} · ${accountKey}` : exchange
}

function parseTpIds(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** selected_markets is a JSON array; a broken row must not sink the page. */
function parseMarkets(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((m): m is string => typeof m === 'string')
  if (typeof raw !== 'string' || !raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((m): m is string => typeof m === 'string') : []
  } catch {
    return []
  }
}

/**
 * Fill in mark, 24h move and funding from the venue's public ticker. One call
 * per distinct (venue, symbol) whatever the number of connections watching it;
 * a venue without a ticker hook keeps whatever the position already gave.
 */
async function enrichCryptoTickers(
  markets: CryptoMarket[],
  sessions: Array<{ exchangeName: string; status: string; adapter: unknown }>,
): Promise<void> {
  const hooks = new Map<string, (s: string) => Promise<MarketTicker | null>>()
  for (const session of sessions) {
    if (session.status !== 'connected') continue
    const hook = (session.adapter as { getMarketTicker?: (s: string) => Promise<MarketTicker | null> })
      .getMarketTicker
    const venue = session.exchangeName.toLowerCase()
    if (hook && !hooks.has(venue)) hooks.set(venue, hook.bind(session.adapter))
  }
  const wanted = new Map<string, { venue: string; symbol: string }>()
  for (const m of markets) {
    const venue = m.exchange.toLowerCase()
    if (!hooks.has(venue)) continue
    wanted.set(`${venue}::${m.symbol}`, { venue, symbol: m.symbol })
  }
  const tickers = new Map<string, MarketTicker | null>()
  await Promise.all(
    [...wanted].map(async ([key, { venue, symbol }]) => {
      try {
        tickers.set(key, await hooks.get(venue)!(symbol))
      } catch {
        tickers.set(key, null)
      }
    }),
  )
  for (const m of markets) {
    const t = tickers.get(`${m.exchange.toLowerCase()}::${m.symbol}`)
    if (!t) continue
    m.last = t.mark ?? m.last
    m.change24hPct = t.change24hPct
    m.fundingRate = t.fundingRate
  }
}

// Display labels for the futures roots the executor can size/trade.
const ROOT_LABELS: Record<string, string> = {
  MNQ: 'Micro Nasdaq',
  MES: 'Micro S&P 500',
  MGC: 'Micro Gold',
  SIL: 'Micro Silver',
  NQ: 'Nasdaq',
  ES: 'S&P 500',
  GC: 'Gold',
}

/**
 * Operational views over real broker data (portfolio, markets, per-signal
 * execution detail, reconciliation visibility, account sizing, alerting). All
 * data is live from the connected adapters / local audit tables — no signal
 * framing, no fabricated balances.
 */
export function createOperationsRoutes(
  db: KaiBotDatabase,
  exchangeManager: ExchangeManager,
  alerting?: AlertingService,
  // Called after a panic/halt/guardrail/account-size mutation so the companion
  // state snapshot is re-pushed (no-op while remote management is off).
  onMutation?: () => void,
  // Server flat report for the book-repair route (signal client's venue-exit
  // POST). Optional — without it the repair skips the server step.
  reportVenueExit?: (
    positionId: string,
    fill: { price: number | null; timeMs: number; orderId?: string | null },
  ) => Promise<void>,
  // Reconciler loop liveness for the Reconciliation page.
  reconcilerStatus?: () => ReconcilerStatus,
) {
  const app = new Hono()

  // ── Book repair: 2026-09-01 MGCZ26 reconciler-rebuy incident ──
  // Idempotent, prices/times venue-confirmed, every step reported. See
  // services/repair-reconciler-rebuy-20260901.ts for what and why.
  app.post('/repair/reconciler-rebuy-20260901', async (c) => {
    try {
      const session = await exchangeManager.getSession('default', MGC_REPAIR_20260901.exchange)
      if (!session || session.status !== 'connected') {
        return c.json({ error: `${MGC_REPAIR_20260901.exchange} not connected` }, 503)
      }
      const report = await repairReconcilerRebuy20260901(db, session.adapter, { reportVenueExit })
      return c.json(report, report.ok ? 200 : 500)
    } catch (error) {
      db.log('error', 'trading', 'Book repair failed', { error: errMsg(error) })
      return c.json({ error: errMsg(error) }, 500)
    }
  })

  // ── Book repair: 2026-09-03 MNQU26 virtualClose incident ──
  // Idempotent, venue-verified, refuses to run under a live stop. See
  // services/repair-virtualclose-20260903.ts for what and why.
  app.post('/repair/virtualclose-20260903', async (c) => {
    try {
      const session = await exchangeManager.getSession('default', VIRTUALCLOSE_REPAIR_20260903.exchange)
      if (!session || session.status !== 'connected') {
        return c.json({ error: `${VIRTUALCLOSE_REPAIR_20260903.exchange} not connected` }, 503)
      }
      const report = await repairVirtualClose20260903(db, session.adapter, { reportVenueExit })
      return c.json(report, report.ok ? 200 : 500)
    } catch (error) {
      db.log('error', 'trading', 'Book repair failed', { error: errMsg(error) })
      return c.json({ error: errMsg(error) }, 500)
    }
  })

  // ── Position lineage: which bot (if any) holds each live (exchange, account,
  //    symbol) — the book, not a symbol match against the bot list (a bot's
  //    root 'MES' never equals the position's 'MESU26'). ──
  app.get('/position-lineage', (c) => {
    try {
      const executions = db
        .listExecutionExchanges()
        .flatMap((r) => db.listOpenExecutionsForExchange(r.exchange))
      const lineages = derivePositionLineage(executions, db.listManualPositions(), {
        signalBotIdFor: (signalId) => {
          const row = db.get('SELECT metadata FROM signals WHERE id = ?', [signalId]) as
            | { metadata: string | null }
            | undefined
          if (!row?.metadata) return null
          try {
            const meta = JSON.parse(row.metadata) as Record<string, unknown>
            const id = meta.signalBotId ?? meta.signal_bot_id
            return typeof id === 'string' && id ? id : null
          } catch {
            return null
          }
        },
        botNameFor: (signalBotId) => {
          const sub = db.getSubscriptionForBot(signalBotId) as { bot_name?: string | null } | undefined
          return sub?.bot_name ?? null
        },
      })
      return c.json({ lineages })
    } catch (error) {
      db.log('error', 'trading', 'Failed to build position lineage', { error: errMsg(error) })
      return c.json({ error: 'Failed to build position lineage' }, 500)
    }
  })

  // ── Portfolio: total equity + allocation + open positions with live PnL ──
  // Assembly lives in services/state-snapshot.ts (shared with the companion
  // state snapshot) so the route and the snapshot never drift.
  // Read-only: the resting (incl. trigger/stop) orders of one connection's
  // account straight from the venue, next to what the local bracket book
  // thinks rests there. Verifies a stop really exists or is really gone
  // (2026-09-22, cross-account stop take-over on Deribit).
  app.get('/open-orders', async (c) => {
    const exchange = c.req.query('exchange')
    if (!exchange) return c.json({ error: 'exchange required' }, 400)
    const accountId = c.req.query('accountId') || undefined
    const symbol = c.req.query('symbol') || undefined
    try {
      const session = await exchangeManager.getSession('default', exchange, accountKeyOf(accountId))
      if (!session || session.status !== 'connected') {
        return c.json({ error: `exchange ${exchange}${accountId ? ` (${accountKeyOf(accountId) ?? 'default'})` : ''} not connected` }, 400)
      }
      const adapter = session.adapter
      if (typeof adapter.getOpenOrders !== 'function') {
        return c.json({ error: `${exchange} does not expose open orders` }, 400)
      }
      const venue = await adapter.getOpenOrders(symbol ? { symbol } : undefined)
      const venueIds = new Set(venue.map((o) => o.orderId))
      // Local rows that claim an order on this exchange/account/symbol.
      const local: Array<{ source: string; signalId: string; orderId: string; accountId: string | null; atVenue: boolean }> = []
      for (const p of db.listBracketPairs()) {
        if (p.exchange !== exchange) continue
        if (accountId && p.account_id != null && p.account_id !== accountId) continue
        for (const id of [p.sl_order_id, p.tp_order_id, ...parseTpIds(p.tp_order_ids)]) {
          if (id) local.push({ source: 'bracket_pairs', signalId: p.signal_id, orderId: id, accountId: p.account_id ?? null, atVenue: venueIds.has(id) })
        }
      }
      for (const st of db.listActiveServerExitStates(exchange)) {
        if (!st.sl_order_id) continue
        if (symbol && st.symbol.toUpperCase() !== symbol.toUpperCase()) continue
        const exec = db.getSignalExecution(st.entry_signal_id)
        if (accountId && exec?.account_id && exec.account_id !== accountId) continue
        local.push({ source: 'server_exit_state', signalId: st.entry_signal_id, orderId: st.sl_order_id, accountId: exec?.account_id ?? null, atVenue: venueIds.has(st.sl_order_id) })
      }
      const localIds = new Set(local.map((l) => l.orderId))
      return c.json({
        exchange,
        accountId: accountId ?? null,
        connection: accountKeyOf(accountId) ?? 'default',
        symbol: symbol ?? null,
        venue: venue.map((o) => ({ ...o, raw: undefined, tracked: localIds.has(o.orderId) })),
        local,
      })
    } catch (e) {
      return c.json({ error: errMsg(e) }, 500)
    }
  })

  app.get('/portfolio', async (c) => {
    try {
      return c.json(await assemblePortfolio(db, exchangeManager))
    } catch (error) {
      db.log('error', 'trading', 'Failed to build portfolio', { error: errMsg(error) })
      return c.json({ error: 'Failed to build portfolio' }, 500)
    }
  })

  // ── Markets: front-month contract + last price + open status per root,
  //    plus live crypto markets per connected venue ──
  app.get('/markets', async (c) => {
    try {
      const sessions = await exchangeManager.getAllSessions('default')
      const futures: Array<{
        root: string
        label: string
        symbol: string | null
        last: number | null
        open: boolean
        exchange: string
      }> = []
      const cryptoConnections: CryptoConnection[] = []
      const cryptoPositions: PositionInput[] = []

      for (const session of sessions) {
        if (session.status !== 'connected') continue
        const adapter = session.adapter

        // Futures venues: resolve front-month + market status per known root.
        if (adapter.resolveSymbol && adapter.getMarketStatus) {
          const roots = KNOWN_FUTURES_ROOTS.filter((r) =>
            // Only roots this venue is meant to trade (TradeStation micros + minis).
            ['MES', 'MNQ', 'MGC', 'SIL'].includes(r),
          )
          for (const root of roots) {
            let symbol: string | null = null
            let last: number | null = null
            let open = false
            try {
              symbol = await adapter.resolveSymbol(root)
              const status = await adapter.getMarketStatus([symbol])
              const st = status.get(symbol)
              if (st) {
                last = st.last || null
                open = !!st.tradeTimeMs && Date.now() - st.tradeTimeMs < 3 * 60 * 1000
              }
            } catch {
              // front month not resolvable right now (quote throttle) → leave nulls
            }
            futures.push({
              root,
              label: ROOT_LABELS[root] ?? root,
              symbol,
              last,
              open,
              exchange: session.exchangeName,
            })
          }
          continue
        }

        // Crypto venues are 24/7. Every connected one is a market surface of
        // its own, even while flat: what it watches comes from its
        // subscriptions and synthetic rows, not only from open positions.
        cryptoConnections.push({
          exchangeName: session.exchangeName,
          accountKey: session.accountKey ?? null,
          label: connectionLabelOf(session.exchangeName, session.accountKey ?? null),
        })
        try {
          for (const p of (await adapter.getPositions()).filter(isOpenPosition)) {
            cryptoPositions.push({
              exchange: session.exchangeName,
              accountKey: session.accountKey ?? null,
              symbol: p.symbol,
              size: p.size,
              side: p.side,
              markPrice: p.markPrice ?? p.entryPrice ?? null,
            })
          }
        } catch (err) {
          db.log('warn', 'trading', 'Markets: crypto positions failed', {
            exchange: session.exchangeName,
            error: errMsg(err),
          })
        }
      }

      const crypto = buildCryptoMarkets({
        connections: cryptoConnections,
        subscriptions: db.getSubscriptions(true).map((r: any) => ({
          exchange: r.exchange,
          accountKey: r.account_key ?? accountKeyOf(r.account_id) ?? null,
          status: r.status,
          markets: parseMarkets(r.selected_markets),
        })),
        synthetics: db.listSyntheticUsdPositions().map((r) => ({
          exchange: r.exchange,
          accountKey: accountKeyOf(r.account_id) ?? null,
          symbol: r.symbol,
          status: r.status,
        })),
        positions: cryptoPositions,
        mapSymbol: (exchange, market) => mapToVenueSymbol(exchange, market).venueSymbol,
        labelOf: connectionLabelOf,
      })

      // One public ticker per distinct (venue, symbol), reused across the
      // connections that watch it.
      await enrichCryptoTickers(crypto, sessions)

      return c.json({ futures, crypto })
    } catch (error) {
      db.log('error', 'trading', 'Failed to build markets', { error: errMsg(error) })
      return c.json({ error: 'Failed to build markets' }, 500)
    }
  })

  // ── Per-signal execution detail: signal + execution + fills + settlements +
  //    bracket pair + computed PnL ──
  app.get('/executions/:signalId', (c) => {
    const signalId = c.req.param('signalId')
    try {
      const signal = db.get('SELECT * FROM signals WHERE id = ?', [signalId]) as any
      const execution = db.getSignalExecution(signalId)
      if (!signal && !execution) return c.json({ error: 'not found' }, 404)

      const fills = db.getSignalFills(signalId)
      const settlements = db.all(
        'SELECT * FROM order_settlements WHERE signal_id = ? ORDER BY created_at ASC',
        [signalId],
      )
      const bracket = db.get('SELECT * FROM bracket_pairs WHERE signal_id = ?', [signalId])

      const pnl = execution ? computeSignalPnl(execution, fills) : null

      // Who routed the signal here. The bot id lives in the signal metadata; the
      // subscription it belongs to carries the factor and the target account,
      // which is what makes a rejection like "max concurrent positions" legible.
      const botId = signalBotIdOf(signal?.metadata)
      const subRow = botId ? db.getSubscriptionForBot(botId) : null
      const subscription = subRow
        ? {
            id: subRow.id,
            signalBotId: subRow.signal_bot_id,
            botName: subRow.bot_name ?? null,
            factor: subRow.factor,
            exchange: subRow.exchange,
            accountId: subRow.account_id ?? null,
            accountKey: subRow.account_key ?? null,
            status: subRow.status,
            sizeUnit: subRow.size_unit ?? 'native',
            maxPositionSize: subRow.max_position_size ?? null,
            maxConcurrentTrades: subRow.max_concurrent_trades ?? null,
          }
        : null

      return c.json({
        signal: signal ?? null,
        execution: execution ?? null,
        fills,
        settlements,
        bracket: bracket ?? null,
        pnl,
        subscription,
        // Every quantity the guardrails changed, original to adjusted.
        clips: db.listSafetyClips(signalId),
        // Queue trail: when it arrived, when it was processed, and why it was
        // parked when it was.
        queue: db.listSignalQueue(signalId),
      })
    } catch (error) {
      db.log('error', 'trading', 'Failed to get execution detail', { signalId, error: errMsg(error) })
      return c.json({ error: 'Failed to get execution detail' }, 500)
    }
  })

  // ── Reconciliation visibility: recent runs + latest status per symbol ──
  app.get('/reconciliations', (c) => {
    const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200)
    const exchange = c.req.query('exchange') || undefined
    try {
      const recent = db.listRecentReconciliations(limit)
      // `finding` (not `status`: that column is the correction order's state).
      // settled = the reconciler resolved the drift, adoption included;
      // open = drift it could not settle; archived = pre-account-scoping row.
      const latestPerSymbol = db
        .latestReconciliationPerSymbol(exchange)
        .map((r) => ({ ...r, finding: findingStatus(r) }))
      const mismatched = latestPerSymbol.filter((r) => r.finding === 'open')
      const archived = latestPerSymbol.filter((r) => r.finding === 'archived')
      return c.json({
        recent,
        latestPerSymbol,
        mismatched,
        archived,
        // Liveness of the loop. Clean passes leave no row, so the page needs
        // this to tell "healthy and quiet" from "not running".
        reconciler: reconcilerStatus?.() ?? null,
      })
    } catch (error) {
      db.log('error', 'trading', 'Failed to get reconciliations', { error: errMsg(error) })
      return c.json({ error: 'Failed to get reconciliations' }, 500)
    }
  })

  // ── Account sizing: per (exchange account, root) max contracts / signal ──
  // Assembly is shared with the companion state snapshot (services/state-snapshot.ts).
  app.get('/account-sizes', async (c) => {
    try {
      return c.json(await assembleAccountSizes(db, exchangeManager))
    } catch (error) {
      db.log('error', 'system', 'Failed to get account sizes', { error: errMsg(error) })
      return c.json({ error: 'Failed to get account sizes' }, 500)
    }
  })

  app.put('/account-sizes', async (c) => {
    try {
      const body = (await c.req.json()) as {
        exchange?: string
        account?: string
        root?: string
        maxContracts?: number
      }
      if (
        !body.exchange ||
        !body.account ||
        !body.root ||
        typeof body.maxContracts !== 'number' ||
        body.maxContracts < 0 ||
        !Number.isFinite(body.maxContracts)
      ) {
        return c.json({ error: 'exchange, account, root and non-negative maxContracts required' }, 400)
      }
      const root = isFuturesRoot(body.root) ? body.root.toUpperCase() : sizingRoot(body.root)
      db.setAccountSize(body.exchange, body.account, root, body.maxContracts)
      db.log('info', 'system', 'Account size updated', {
        exchange: body.exchange,
        account: body.account,
        root,
        maxContracts: body.maxContracts,
      })
      onMutation?.()
      return c.json({ exchange: body.exchange, account: body.account, root, maxContracts: body.maxContracts })
    } catch (error) {
      db.log('error', 'system', 'Failed to set account size', { error: errMsg(error) })
      return c.json({ error: 'Failed to set account size' }, 500)
    }
  })

  // ── Breathing-room margin guard + opt-in guardrails: per (exchange account) ──
  // One endpoint surfaces both the pre-open margin buffer (migration 015) and the
  // opt-in safety rails (migration 016) since they share a config row. Assembly
  // is shared with the companion state snapshot (services/state-snapshot.ts).
  app.get('/margin-guards', async (c) => {
    try {
      return c.json(await assembleMarginGuards(db, exchangeManager))
    } catch (error) {
      db.log('error', 'system', 'Failed to get margin guards', { error: errMsg(error) })
      return c.json({ error: 'Failed to get margin guards' }, 500)
    }
  })

  // Set the opt-in guardrail rails for (exchange, account). All three default-off
  // (0 = that rail disabled). Validated like margin-guards: non-negative finite.
  app.put('/guardrails', async (c) => {
    try {
      const body = (await c.req.json()) as {
        exchange?: string
        account?: string
        maxDailyLoss?: number
        maxConcurrentPositions?: number
        maxTotalNotional?: number
      }
      const nonNeg = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0
      if (
        !body.exchange ||
        !body.account ||
        !nonNeg(body.maxDailyLoss) ||
        !nonNeg(body.maxConcurrentPositions) ||
        !Number.isInteger(body.maxConcurrentPositions) ||
        !nonNeg(body.maxTotalNotional)
      ) {
        return c.json(
          {
            error:
              'exchange, account, non-negative maxDailyLoss, non-negative integer maxConcurrentPositions, non-negative maxTotalNotional required',
          },
          400,
        )
      }
      db.setGuardrails(body.exchange, body.account, {
        maxDailyLoss: body.maxDailyLoss!,
        maxConcurrentPositions: body.maxConcurrentPositions!,
        maxTotalNotional: body.maxTotalNotional!,
      })
      db.log('info', 'system', 'Guardrails updated', {
        exchange: body.exchange,
        account: body.account,
        maxDailyLoss: body.maxDailyLoss,
        maxConcurrentPositions: body.maxConcurrentPositions,
        maxTotalNotional: body.maxTotalNotional,
      })
      onMutation?.()
      return c.json({
        exchange: body.exchange,
        account: body.account,
        maxDailyLoss: body.maxDailyLoss,
        maxConcurrentPositions: body.maxConcurrentPositions,
        maxTotalNotional: body.maxTotalNotional,
      })
    } catch (error) {
      db.log('error', 'system', 'Failed to set guardrails', { error: errMsg(error) })
      return c.json({ error: 'Failed to set guardrails' }, 500)
    }
  })

  // ── PANIC: offline-proof close-all (+ optional halt) ──
  // Closes every open position across connected exchanges directly via the
  // adapters (not a cloud signal), so it works with the cloud down. `halt` also
  // stops the executor opening on further inbound signals until re-enabled.
  app.post('/panic', async (c) => {
    let halt = false
    try {
      const body = (await c.req.json().catch(() => ({}))) as { halt?: boolean }
      halt = body?.halt === true
    } catch {
      /* empty body → halt false */
    }
    try {
      const report = await panicCloseAll(db, exchangeManager, { halt, reason: 'manual' })
      onMutation?.()
      return c.json(report)
    } catch (error) {
      db.log('error', 'trading', 'PANIC failed', { error: errMsg(error) })
      return c.json({ error: 'Panic failed', detail: errMsg(error) }, 500)
    }
  })

  // ── Fills ledger, newest first: the Terminal posts these into the embedded
  //    Studio chart (own-trades layer). Local read only; nothing leaves the box. ──
  app.get('/fills', (c) => {
    const raw = Number(c.req.query('limit') ?? 500)
    const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 2000) : 500
    try {
      const rows = db.listRecentFills(limit).map((f) => ({
        id: f.id,
        signalId: f.signal_id,
        exchange: f.exchange,
        accountId: f.account_id,
        symbol: f.symbol,
        direction: f.direction,
        kind: f.kind,
        side: f.side,
        qty: f.qty,
        price: f.price,
        commission: f.commission,
        createdAt: f.created_at,
      }))
      return c.json(rows)
    } catch (error) {
      db.log('error', 'trading', 'Failed to list fills', { error: errMsg(error) })
      return c.json({ error: 'Failed to list fills' }, 500)
    }
  })

  // ── Halt flag: read + clear (re-enable). Setting it on is done via panic. ──
  app.get('/halt', (c) => c.json(db.getHaltState()))

  app.post('/halt', async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as { halted?: boolean; reason?: string }
      const halted = body?.halted === true
      db.setHaltState(halted, halted ? body?.reason ?? 'manual' : null)
      db.log('warn', 'trading', halted ? 'Executor halted (manual)' : 'Executor halt cleared', {})
      onMutation?.()
      return c.json(db.getHaltState())
    } catch (error) {
      db.log('error', 'trading', 'Failed to set halt state', { error: errMsg(error) })
      return c.json({ error: 'Failed to set halt state' }, 500)
    }
  })

  app.put('/margin-guards', async (c) => {
    try {
      const body = (await c.req.json()) as {
        exchange?: string
        account?: string
        enabled?: boolean
        bufferMult?: number
        floorMode?: string
        equityPct?: number
      }
      const FLOOR_MODES = ['maintenance', 'initial', 'equityPct']
      if (
        !body.exchange ||
        !body.account ||
        typeof body.enabled !== 'boolean' ||
        typeof body.bufferMult !== 'number' ||
        !Number.isFinite(body.bufferMult) ||
        body.bufferMult < 0 ||
        !body.floorMode ||
        !FLOOR_MODES.includes(body.floorMode) ||
        typeof body.equityPct !== 'number' ||
        !Number.isFinite(body.equityPct) ||
        body.equityPct < 0 ||
        body.equityPct > 1
      ) {
        return c.json(
          {
            error:
              'exchange, account, enabled, non-negative bufferMult, floorMode (maintenance|initial|equityPct), equityPct 0..1 required',
          },
          400,
        )
      }
      db.setMarginGuard(body.exchange, body.account, {
        enabled: body.enabled,
        bufferMult: body.bufferMult,
        floorMode: body.floorMode,
        equityPct: body.equityPct,
      })
      db.log('info', 'system', 'Margin guard updated', {
        exchange: body.exchange,
        account: body.account,
        enabled: body.enabled,
        bufferMult: body.bufferMult,
        floorMode: body.floorMode,
        equityPct: body.equityPct,
      })
      onMutation?.()
      return c.json({
        exchange: body.exchange,
        account: body.account,
        enabled: body.enabled,
        bufferMult: body.bufferMult,
        floorMode: body.floorMode,
        equityPct: body.equityPct,
      })
    } catch (error) {
      db.log('error', 'system', 'Failed to set margin guard', { error: errMsg(error) })
      return c.json({ error: 'Failed to set margin guard' }, 500)
    }
  })

  // ── Alerting: status + test send (config itself lives in user settings) ──
  app.get('/alerting/status', (c) => {
    return c.json({ active: alerting?.isActive() ?? false })
  })

  app.post('/alerting/test', async (c) => {
    if (!alerting) return c.json({ ok: false, error: 'alerting not available' }, 500)
    try {
      const result = await alerting.sendTest()
      return c.json(result, result.ok ? 200 : 400)
    } catch (error) {
      return c.json({ ok: false, error: errMsg(error) }, 500)
    }
  })

  return app
}

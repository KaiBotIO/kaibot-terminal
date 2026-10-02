// Ride hand-over (edge side): hand an open manual position to a ride-only bot
// on the server, and take it back.
//
// The mirror image of bot-detach: where detach turns a bot position into a
// manual one (pause config, retire trails), hand-over turns a manual position
// into a bot lineage the server may close. Nothing is bought or sold — only
// WHO manages the exit changes.
//
// What a hand-over writes locally, so the server's close/update signals take
// the UNCHANGED R1 path (executeCloseSignal / handleServerExitUpdate):
//   - a synthetic executed entry signal `handover:<positionId>` under the
//     CANONICAL symbol with the bot id in its metadata (the close's lineage
//     lookup), plus its signal_executions row (venue contract, venue qty,
//     account) and an entry fill (so the exit books P&L);
//   - server_exit_state keyed by the server position id, carrying the resting
//     stop order (the venue-exit sweep then reports a stop fill upstream);
//   - the executor subscription + bot_config for the ride bot (sizing base,
//     F3 gate), auto-provisioned like the discretionary bot;
//   - the manual marker reduced by the handed-over qty (the reconciler now
//     expects this qty from the execution, not from the marker).
// Local edge managers and manual trails on the position are detached: one
// stop owner per position, and from now on that is the server ride.
//
// INV11: the server never receives the real size — the request carries side,
// prices and times only.

import { createHash } from 'node:crypto'
import type { KaiBotDatabase } from '../storage/database.js'
import type { ExchangeManager } from './exchanges/exchangeManager.js'
import type { Position } from './exchanges/types.js'
import { withOrderLock } from './order-lock.js'
import { accountKeyOf } from './exchanges/account-scope.js'
import { rootOf } from './exchanges/futures-contracts.js'
import { findAdoptableStopSeed } from './position-manage.js'
import { positionTrailKey } from './position-trail.js'
import type { ExitAllocation } from './exit-attribution.js'
import { listActiveRides } from './ride-state.js'
export { listActiveRides, activeRideFor, type ActiveRide } from './ride-state.js'

import { HANDOVER_SIGNAL_PREFIX } from './ride-state.js'
export { HANDOVER_SIGNAL_PREFIX }

export function handoverSignalId(positionId: string): string {
  return `${HANDOVER_SIGNAL_PREFIX}${positionId}`
}

// Opaque per-account discriminator for the server's idempotency key. Never the
// account id itself (INV12-style: account identities stay on this machine).
export function accountRefFor(exchange: string, accountId: string): string {
  return createHash('sha256').update(`${exchange.toLowerCase()}|${accountId}`).digest('hex').slice(0, 16)
}

// The symbol the server knows this market by. Futures roots for TradeStation
// (candles + bots live on the continuous root), the venue symbol elsewhere.
export function canonicalSymbolFor(exchange: string, venueSymbol: string): string {
  return exchange.toLowerCase() === 'tradestation' ? rootOf(venueSymbol) : venueSymbol
}

export interface ServerResponse {
  ok: boolean
  status: number
  body: any
}

export interface RideHandoverDeps {
  userId?: string
  // Authenticated POST to the server (signal client headers). Absent → the
  // hand-over cannot reach the server and refuses.
  postToServer?: (path: string, body: unknown) => Promise<ServerResponse>
  registerBracket?: (
    exchange: string,
    signalId: string,
    slOrderId?: string,
    tpOrderIds?: string[],
    accountId?: string | null,
  ) => void
  reportVenueExit?: (
    positionId: string,
    fill: { price: number | null; timeMs: number; orderId?: string | null },
  ) => Promise<void>
}

export interface HandoverRequest {
  exchange: string
  // Venue symbol of the open position (the dated contract on futures).
  symbol: string
  accountId?: string
  botId: string
  // Override for the server-side market symbol (defaults to canonicalSymbolFor).
  canonicalSymbol?: string
  // Server-side data market exchange the ride evaluates on (defaults to the
  // venue). A paper venue rides on the real market's candles.
  marketExchange?: string
  // Override for when the position was opened (defaults to the manual
  // marker's first fill, else now). Drives the 'entry' replay start.
  openedAt?: Date
  // Display name of the bot (the picker knows it; falls back to the synced
  // bot config or the id).
  botName?: string
  // Stop level to adopt/place. Required when no resting stop can be adopted.
  stopPrice?: number
  anchor?: number
  ladderFrom?: 'entry' | 'now'
}

export interface HandoverPreview {
  position: { symbol: string; side: 'long' | 'short'; size: number; entryPrice: number; accountId: string }
  canonicalSymbol: string
  marketExchange: string
  openedAt: string
  adoptableStop: { slOrderId: string; currentStop: number | null } | null
  stopPrice: number | null
  // Local managers / trails that a hand-over would detach.
  detaches: { managers: string[]; trails: number }
  server: any
}

export interface HandoverResult {
  positionId: string
  runId: string
  timeframe: string
  entrySignalId: string
  plan: string
  stop: { price: number; slOrderId: string; placed: boolean }
  detached: { managers: string[]; trails: number }
}

export interface TakebackResult {
  positionId: string
  released: boolean
}

const ACCOUNT_ROUTED_VENUES = new Set(['tradestation', 'interactivebrokers', 'interactive-brokers'])

export function createRideHandoverService(
  db: KaiBotDatabase,
  exchangeManager: ExchangeManager,
  deps: RideHandoverDeps = {},
) {
  const userId = deps.userId ?? 'default'

  async function adapterFor(exchange: string, accountId?: string | null) {
    const session = await exchangeManager.getSession(userId, exchange, accountKeyOf(accountId))
    if (!session || session.status !== 'connected') {
      throw new Error(`exchange ${exchange} not connected`)
    }
    return session.adapter
  }

  async function resolveAccountId(
    adapter: Awaited<ReturnType<typeof adapterFor>>,
    exchange: string,
    provided?: string,
  ): Promise<string> {
    if (provided) return provided
    const accounts = await adapter.getAccounts()
    if (accounts.length === 0) throw new Error('no account available on this exchange')
    if (accounts.length > 1 && ACCOUNT_ROUTED_VENUES.has(exchange.toLowerCase())) {
      throw new Error(
        `this exchange has ${accounts.length} broker accounts — pass accountId (one of: ${accounts
          .map((a) => a.accountId)
          .join(', ')})`,
      )
    }
    return accounts[0].accountId
  }

  async function findPosition(req: HandoverRequest) {
    const adapter = await adapterFor(req.exchange, req.accountId)
    const accountId = await resolveAccountId(adapter, req.exchange, req.accountId)
    const enforceAccountScope =
      ACCOUNT_ROUTED_VENUES.has(req.exchange.toLowerCase()) || req.accountId != null
    const positions = await adapter.getPositions()
    const pos = positions.find(
      (p) =>
        p.symbol.toLowerCase() === req.symbol.toLowerCase() &&
        Math.abs(p.size) > 0 &&
        (!enforceAccountScope || !p.accountId || p.accountId === accountId),
    )
    if (!pos) {
      throw new Error(
        `no open position for ${req.symbol}${enforceAccountScope ? ` on account ${accountId}` : ''}`,
      )
    }
    return { adapter, accountId, pos }
  }

  // Open executions on this (exchange, account, symbol): a bot lineage that
  // still runs blocks the hand-over (take it over first); an active hand-over
  // execution makes a repeat idempotent.
  function lineageFor(exchange: string, accountId: string, symbol: string) {
    const rows = db
      .listOpenExecutionsForExchange(exchange)
      .filter(
        (e) =>
          e.symbol.toUpperCase() === symbol.toUpperCase() &&
          (e.account_id == null || e.account_id === accountId),
      )
    const handover = rows.find((e) => e.signal_id.startsWith(HANDOVER_SIGNAL_PREFIX))
    const bot = rows.find((e) => !e.signal_id.startsWith(HANDOVER_SIGNAL_PREFIX) && botIdOfSignal(e.signal_id))
    return { handover, bot }
  }

  function botIdOfSignal(signalId: string): string | null {
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
  }

  function detachTargets(exchange: string, accountId: string, symbol: string) {
    const key = positionTrailKey(exchange, accountId, symbol)
    const managers = db.listActiveManagersForPosition(key).map((m) => m.manager_id)
    const trails = db
      .findActiveTrailsForSymbol(exchange, symbol, accountId)
      .filter((t) => t.source === 'manual')
    return { key, managers, trails }
  }

  function serverBody(req: HandoverRequest, pos: Position, accountId: string, stop: number | null) {
    return {
      botId: req.botId,
      exchange: req.marketExchange ?? req.exchange,
      symbol: req.canonicalSymbol ?? canonicalSymbolFor(req.marketExchange ?? req.exchange, pos.symbol),
      accountRef: accountRefFor(req.exchange, accountId),
      side: pos.side,
      avgEntry: pos.entryPrice,
      openedAt: new Date(req.openedAt?.getTime() ?? openedAtFor(req.exchange, accountId, pos.symbol)).toISOString(),
      stop,
      anchor: req.anchor,
      ladderFrom: req.ladderFrom ?? 'entry',
    }
  }

  // When the position was opened: the manual marker's first fill, else now.
  function openedAtFor(exchange: string, accountId: string, symbol: string): number {
    const marker = db.getManualPosition(exchange, accountId, symbol)
    return marker?.opened_at ?? Date.now()
  }

  async function post(path: string, body: unknown): Promise<ServerResponse> {
    if (!deps.postToServer) throw new Error('not connected to the server')
    return deps.postToServer(path, body)
  }

  async function preview(req: HandoverRequest): Promise<HandoverPreview> {
    const { accountId, pos } = await findPosition(req)
    const lineage = lineageFor(req.exchange, accountId, pos.symbol)
    if (lineage.bot) {
      throw new Error('this position belongs to a running bot — take it over first')
    }
    const seed = findAdoptableStopSeed(
      db,
      req.exchange,
      pos.symbol,
      { direction: pos.side, mark: pos.markPrice ?? pos.entryPrice },
      accountId,
    )
    const stopPrice = req.stopPrice ?? seed?.currentStop ?? null
    const canonicalSymbol = req.canonicalSymbol ?? canonicalSymbolFor(req.marketExchange ?? req.exchange, pos.symbol)
    const { managers, trails } = detachTargets(req.exchange, accountId, pos.symbol)
    let server: any = null
    if (stopPrice != null) {
      const res = await post('/api/ride/preview', serverBody(req, pos, accountId, stopPrice))
      server = res.ok ? res.body : { error: res.body?.error ?? `server ${res.status}` }
    }
    return {
      position: { symbol: pos.symbol, side: pos.side, size: Math.abs(pos.size), entryPrice: pos.entryPrice, accountId },
      canonicalSymbol,
      marketExchange: req.marketExchange ?? req.exchange,
      openedAt: new Date(req.openedAt?.getTime() ?? openedAtFor(req.exchange, accountId, pos.symbol)).toISOString(),
      adoptableStop: seed ? { slOrderId: seed.slOrderId, currentStop: seed.currentStop } : null,
      stopPrice,
      detaches: { managers, trails: trails.length },
      server,
    }
  }

  async function handover(req: HandoverRequest): Promise<HandoverResult> {
    const { adapter, accountId, pos } = await findPosition(req)
    return withOrderLock(req.exchange, async () => {
      const lineage = lineageFor(req.exchange, accountId, pos.symbol)
      if (lineage.bot) {
        throw new Error('this position belongs to a running bot — take it over first')
      }
      const qty = Math.abs(pos.size)
      const direction = pos.side
      const exitSide: 'buy' | 'sell' = direction === 'long' ? 'sell' : 'buy'

      // ── Resting venue stop (C2.5): adopt, else place, else refuse. ──
      const seed = findAdoptableStopSeed(
        db,
        req.exchange,
        pos.symbol,
        { direction, mark: pos.markPrice ?? pos.entryPrice },
        accountId,
      )
      let stopPrice = req.stopPrice ?? seed?.currentStop ?? null
      if (stopPrice == null) {
        throw new Error('a resting stop is required: none could be adopted, pass stopPrice')
      }
      if (direction === 'long' ? stopPrice >= pos.entryPrice : stopPrice <= pos.entryPrice) {
        throw new Error('the stop must sit on the losing side of the entry')
      }
      let slOrderId = seed?.slOrderId ?? null
      let placed = false
      if (!slOrderId) {
        const sl = await adapter.placeOrder({
          accountId,
          symbol: pos.symbol,
          side: exitSide,
          orderType: 'stop',
          quantity: qty,
          stopPrice,
          reduceOnly: true,
          label: 'kaibot-ride-sl',
        })
        if (sl.status === 'rejected') throw new Error('the venue rejected the protective stop')
        slOrderId = sl.orderId
        placed = true
      }

      // ── Server: arm the row (idempotent on its side). ──
      const res = await post('/api/ride/handover', serverBody(req, pos, accountId, stopPrice))
      if (!res.ok) {
        if (placed && slOrderId) {
          try {
            await adapter.cancelOrder(slOrderId, { symbol: pos.symbol })
          } catch {
            /* the stop keeps protecting the manual position; fine either way */
          }
        }
        throw new Error(res.body?.error ?? `server refused the hand-over (${res.status})`)
      }
      const { positionId, runId, timeframe, subscriptionId, plan } = res.body as {
        positionId: string
        runId: string
        timeframe: string
        subscriptionId: string | null
        plan: string
      }
      const entryId = handoverSignalId(positionId)
      const canonicalSymbol = req.canonicalSymbol ?? canonicalSymbolFor(req.marketExchange ?? req.exchange, pos.symbol)
      const openedAtMs = req.openedAt?.getTime() ?? openedAtFor(req.exchange, accountId, pos.symbol)
      const botName =
        req.botName ?? db.getBotConfigs(false).find((c) => c.signalBotId === req.botId)?.botName ?? req.botId

      // ── Local lineage. ──
      const existing = db.getSignalExecution(entryId)
      if (!existing || existing.status === 'closed' || existing.status === 'error') {
        if (!db.get('SELECT id FROM signals WHERE id = ?', [entryId])) {
          db.recordSignal({
            id: entryId,
            strategyId: 'ride',
            strategyName: botName,
            symbol: canonicalSymbol,
            action: direction === 'long' ? 'buy' : 'sell',
            quantity: qty,
            price: pos.entryPrice,
            type: 'market',
            stopLoss: stopPrice,
            metadata: {
              source: 'handover',
              signalBotId: req.botId,
              ...(subscriptionId ? { subscriptionId } : {}),
              positionId,
              exitAuthority: 'server',
              exchange: req.exchange,
              venueSymbol: pos.symbol,
              runId,
              timeframe,
            },
          })
        }
        db.updateSignalStatus(entryId, 'executed')
        if (existing) {
          // Re-arm: the lineage row keeps its id; the bot/run it now belongs to
          // changes (the close's lineage lookup and the ride badge read this).
          db.run('UPDATE signals SET metadata = ?, strategy_name = ?, stop_loss = ? WHERE id = ?', [
            JSON.stringify({
              source: 'handover',
              signalBotId: req.botId,
              ...(subscriptionId ? { subscriptionId } : {}),
              positionId,
              exitAuthority: 'server',
              exchange: req.exchange,
              venueSymbol: pos.symbol,
              runId,
              timeframe,
            }),
            botName,
            stopPrice,
            entryId,
          ])
          db.updateSignalExecution(entryId, { status: 'open', qtyOpened: qty, qtyClosed: 0, errorReason: null })
        } else {
          db.insertSignalExecution({
            signalId: entryId,
            symbol: pos.symbol,
            exchange: req.exchange,
            direction,
            status: 'open',
            qtyOpened: qty,
            accountId,
            createdAtMs: openedAtMs,
          })
          db.insertSignalFill({
            signalId: entryId,
            kind: 'entry',
            symbol: pos.symbol,
            side: direction === 'long' ? 'buy' : 'sell',
            qty,
            price: pos.entryPrice,
            orderId: null,
            createdAtMs: openedAtMs,
          })
        }
        // The marker's qty now lives in the execution (reconciler: expected
        // net comes from executions).
        db.reduceManualPosition(req.exchange, accountId, pos.symbol, qty)
      }
      db.upsertServerExitState({
        positionId,
        entrySignalId: entryId,
        exchange: req.exchange,
        symbol: pos.symbol,
        direction,
        currentStop: stopPrice,
        slOrderId,
      })
      if (placed) deps.registerBracket?.(req.exchange, entryId, slOrderId, [], accountId)

      // Sizing base + F3 gate for the bot's closes.
      if (!db.getSubscription(req.botId)) {
        db.upsertSubscription({
          id: req.botId,
          signalBotId: req.botId,
          botName,
          selectedMarkets: [],
          factor: 1,
          status: 'active',
          exchange: req.exchange,
          accountId,
        })
      }
      const marketExchange = req.marketExchange ?? req.exchange
      const cfgId = `${req.botId}:${marketExchange}:${canonicalSymbol}:${timeframe}`
      const cfg = db.getBotConfig(cfgId)
      if (!cfg) {
        db.upsertBotConfig({
          id: cfgId,
          signalBotId: req.botId,
          botName,
          strategyId: 'ride',
          exchange: marketExchange,
          symbol: canonicalSymbol,
          timeframe,
          status: 'running',
        })
      } else if (cfg.status !== 'running') {
        db.setBotConfigStatus(cfgId, 'running')
      }

      // One stop owner: local managers and manual trails step aside.
      const { key, managers, trails } = detachTargets(req.exchange, accountId, pos.symbol)
      for (const m of managers) db.deactivatePositionManager(key, m)
      if (managers.length > 0) db.deactivateManagedPosition(key)
      for (const t of trails) db.deactivateLocalTrail(t.signal_id)

      db.log('warn', 'trading', 'Position handed over to ride bot', {
        exchange: req.exchange,
        symbol: pos.symbol,
        accountId,
        botId: req.botId,
        positionId,
        runId,
        timeframe,
        plan,
        stop: stopPrice,
        slOrderId,
        placedStop: placed,
        detachedManagers: managers,
        detachedTrails: trails.length,
      })
      return {
        positionId,
        runId,
        timeframe,
        entrySignalId: entryId,
        plan,
        stop: { price: stopPrice, slOrderId: slOrderId!, placed },
        detached: { managers, trails: trails.length },
      }
    })
  }

  async function takeback(positionId: string): Promise<TakebackResult> {
    const state = db.getServerExitState(positionId)
    const entryId = handoverSignalId(positionId)
    const exec = db.getSignalExecution(entryId)
    if (!state && !exec) throw new Error('no handed-over position with that id')
    const res = await post('/api/ride/takeback', { positionId })
    if (!res.ok) throw new Error(res.body?.error ?? `server refused the take-back (${res.status})`)

    let released = false
    if (state?.active) {
      db.deactivateServerExitState(positionId)
      released = true
    }
    if (exec && (exec.status === 'open' || exec.status === 'closing')) {
      const openQty = Math.max(0, exec.qty_opened - exec.qty_closed)
      db.updateSignalExecution(entryId, { status: 'closed' })
      db.markEntrySignalClosed(entryId, 'taken back to manual')
      if (openQty > 0 && exec.account_id) {
        db.addManualPosition(
          exec.exchange,
          exec.account_id,
          exec.symbol,
          exec.direction === 'long' ? 'buy' : 'sell',
          openQty,
        )
      }
      released = true
    }
    db.log('warn', 'trading', 'Position taken back from ride bot', { positionId, released })
    return { positionId, released }
  }

  // A venue exit the executor booked itself (manual close, edge-manager
  // close) on an execution the server still manages: tell the server so its
  // row closes and the ride ends (the sweep only covers stop fills).
  async function onExitAttributed(
    exchange: string,
    allocations: ExitAllocation[],
    fill: { price: number | null; timeMs: number; orderId?: string | null },
  ): Promise<void> {
    const closed = new Set(allocations.filter((a) => a.fullyClosed).map((a) => a.signalId))
    if (closed.size === 0) return
    for (const state of db.listActiveServerExitStates(exchange)) {
      if (!closed.has(state.entry_signal_id)) continue
      db.deactivateServerExitState(state.position_id)
      try {
        await deps.reportVenueExit?.(state.position_id, fill)
      } catch (err: any) {
        db.log('warn', 'trading', 'Venue exit report to server failed after local close', {
          positionId: state.position_id,
          error: err?.message,
        })
      }
    }
  }

  // Adopt an entry this executor just filled (a drawing-trigger signal that
  // carries metadata.handoverTo): the REAL entry lineage becomes the ride —
  // no synthetic entry, no second execution. The server arms its existing
  // row in place (positionId from the wire metadata).
  async function adoptEntry(input: {
    entrySignalId: string
    positionId: string
    exchange: string
    symbol: string
    accountId: string
    direction: 'long' | 'short'
    fillPrice: number
    stopPrice: number | null
    slOrderId: string | null
    botId: string
    botName?: string
    ladderFrom?: 'entry' | 'now'
    marketExchange?: string
    canonicalSymbol?: string
  }): Promise<{ positionId: string; runId: string; timeframe: string }> {
    if (!input.slOrderId || input.stopPrice == null) {
      throw new Error('hand-over after fill needs the resting stop of the entry')
    }
    const marketExchange = input.marketExchange ?? input.exchange
    const canonicalSymbol = input.canonicalSymbol ?? canonicalSymbolFor(marketExchange, input.symbol)
    const res = await post('/api/ride/handover', {
      botId: input.botId,
      exchange: marketExchange,
      symbol: canonicalSymbol,
      accountRef: accountRefFor(input.exchange, input.accountId),
      side: input.direction,
      avgEntry: input.fillPrice,
      openedAt: new Date().toISOString(),
      stop: input.stopPrice,
      anchor: input.fillPrice,
      ladderFrom: input.ladderFrom ?? 'now',
      positionId: input.positionId,
    })
    if (!res.ok) throw new Error(res.body?.error ?? `server refused the hand-over (${res.status})`)
    const { positionId, runId, timeframe, subscriptionId } = res.body as {
      positionId: string
      runId: string
      timeframe: string
      subscriptionId: string | null
    }
    const botName =
      input.botName ?? db.getBotConfigs(false).find((c) => c.signalBotId === input.botId)?.botName ?? input.botId

    // The entry's lineage now also answers to the ride bot (the close's
    // lookup is a metadata LIKE on the bot id).
    const row = db.get('SELECT metadata FROM signals WHERE id = ?', [input.entrySignalId]) as
      | { metadata: string | null }
      | undefined
    let meta: Record<string, unknown> = {}
    try {
      meta = row?.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {}
    } catch {
      meta = {}
    }
    db.run('UPDATE signals SET metadata = ? WHERE id = ?', [
      JSON.stringify({
        ...meta,
        rideBotId: input.botId,
        ...(subscriptionId ? { rideSubscriptionId: subscriptionId } : {}),
        positionId,
        exitAuthority: 'server',
        handover: { from: 'trigger', runId, timeframe },
      }),
      input.entrySignalId,
    ])
    db.upsertServerExitState({
      positionId,
      entrySignalId: input.entrySignalId,
      exchange: input.exchange,
      symbol: input.symbol,
      direction: input.direction,
      currentStop: input.stopPrice,
      slOrderId: input.slOrderId,
    })
    if (!db.getSubscription(input.botId)) {
      db.upsertSubscription({
        id: input.botId,
        signalBotId: input.botId,
        botName,
        selectedMarkets: [],
        factor: 1,
        status: 'active',
        exchange: input.exchange,
        accountId: input.accountId,
      })
    }
    const cfgId = `${input.botId}:${marketExchange}:${canonicalSymbol}:${timeframe}`
    const cfg = db.getBotConfig(cfgId)
    if (!cfg) {
      db.upsertBotConfig({
        id: cfgId,
        signalBotId: input.botId,
        botName,
        strategyId: 'ride',
        exchange: marketExchange,
        symbol: canonicalSymbol,
        timeframe,
        status: 'running',
      })
    } else if (cfg.status !== 'running') {
      db.setBotConfigStatus(cfgId, 'running')
    }
    // One stop owner: a local trail the entry registered steps aside too.
    for (const t of db.findActiveTrailsForSymbol(input.exchange, input.symbol, input.accountId)) {
      if (t.signal_id === input.entrySignalId) db.deactivateLocalTrail(t.signal_id)
    }
    db.log('warn', 'trading', 'Filled entry handed over to ride bot', {
      entrySignalId: input.entrySignalId,
      positionId,
      botId: input.botId,
      runId,
      timeframe,
      stop: input.stopPrice,
      slOrderId: input.slOrderId,
    })
    return { positionId, runId, timeframe }
  }

  async function listBots() {
    const res = await post('/api/ride/bots', {})
    if (!res.ok) throw new Error(res.body?.error ?? `server ${res.status}`)
    return (res.body?.bots ?? []) as Array<{
      id: string
      name: string
      strategyName: string
      rootMinutes: number
      timeframe: string
      ladderMinutes: number[]
      markets: string[]
    }>
  }

  return { preview, handover, takeback, adoptEntry, onExitAttributed, listBots, list: () => listActiveRides(db) }
}

export type RideHandoverService = ReturnType<typeof createRideHandoverService>

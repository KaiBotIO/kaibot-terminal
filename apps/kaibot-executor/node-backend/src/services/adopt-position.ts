// Adopt an open venue position into the lineage of an entry signal this
// executor refused or missed (basis guard, market guard, closed venue, ...).
//
// The bot on the server still thinks it is in the trade (its sim went long
// when the entry fired); the user opened the same position by hand later.
// Without a lineage the bot's close is a no-op (signal-client lineage guard)
// and its stop updates are refused (no server_exit_state). Adoption writes
// exactly what a real fill would have written, keyed by the ORIGINAL signal
// id, so the close, the exit updates, the venue-exit sweep and the analytics
// all take their unchanged paths:
//   - signal row → 'executed' (the close's lineage lookup is status + bot id
//     in metadata);
//   - signal_executions + an entry fill at the venue's average price and size;
//   - one resting reduce-only stop for the lineage: an existing lineage stop
//     is kept, a resting manual stop is taken over, else the signal's stop is
//     placed. Never two stops on one position;
//   - server_exit_state when the entry runs with exitAuthority 'server';
//   - the 'executed' ack to the server with the venue fill, so the position
//     row re-opens and the strategy runner keeps its position;
//   - the manual marker shrinks by the adopted qty (the reconciler now expects
//     it from the execution).
// Nothing is bought or sold. Idempotent per (signalId, account): a repeat
// returns the existing lineage and only re-sends a failed ack.

import type { KaiBotDatabase } from '../storage/database.js'
import type { ExchangeManager } from './exchanges/exchangeManager.js'
import type { Position } from './exchanges/types.js'
import { withOrderLock } from './order-lock.js'
import { accountKeyOf } from './exchanges/account-scope.js'
import { isDatedContractOf, rootOf } from './exchanges/futures-contracts.js'
import { deriveClientOrderId } from './client-order-id.js'
import { resolveVenue } from './venue-resolver.js'
import { mapToVenueSymbol } from './symbol-map.js'
import { findAdoptableStopSeed } from './position-manage.js'
import { positionTrailKey } from './position-trail.js'
import { ensureBotGroup, autoLinkPosition } from './position-groups.js'

export interface AdoptPositionDeps {
  userId?: string
  // The signal client's 'executed' ack (fill price/time + stop order id, never
  // the size). Absent → adoption stays local and the result says so.
  ackAdoptedEntry?: (
    signalId: string,
    fill: { price: number | null; time: number },
    stopLossOrderId?: string | null,
  ) => Promise<{ ok: boolean; positionId: string | null }>
  registerBracket?: (
    exchange: string,
    signalId: string,
    slOrderId?: string,
    tpOrderIds?: string[],
    accountId?: string | null,
  ) => void
  notify?: (event: { type: 'position_adopted'; title: string; body: string; data?: Record<string, unknown> }) => void
}

export interface AdoptRequest {
  exchange: string
  // Venue symbol of the open position (the dated contract on futures).
  symbol: string
  accountId?: string
  signalId: string
  // Stop to place when the signal carries none or its stop is already crossed.
  stopPrice?: number
  // When the position was opened (defaults to the manual marker, else now).
  openedAt?: Date
}

export interface AdoptCandidate {
  signalId: string
  botId: string
  botName: string | null
  subscriptionId: string
  strategyName: string | null
  action: 'buy' | 'sell'
  price: number | null
  stopLoss: number | null
  receivedAt: string
  reason: string | null
  positionId: string | null
  venueSymbol: string
}

export interface AdoptResult {
  signalId: string
  botId: string
  botName: string | null
  exchange: string
  accountId: string
  symbol: string
  canonicalSymbol: string
  direction: 'long' | 'short'
  qty: number
  avgPrice: number
  openedAt: string
  stop: { price: number | null; slOrderId: string | null; source: 'lineage' | 'manual' | 'placed' }
  positionId: string | null
  serverAck: { ok: boolean; positionId: string | null } | null
  alreadyAdopted: boolean
  detached: { managers: string[]; trails: number }
}

const CANDIDATE_WINDOW_DAYS = 30

interface SignalRow {
  id: string
  strategy_name: string | null
  symbol: string
  action: string
  price: number | null
  stop_loss: number | null
  status: string
  error_message: string | null
  metadata: string | null
  received_at: string
  ack_status: string | null
}

function parseMeta(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

function botIdOf(meta: Record<string, unknown>): string | null {
  const id = meta.signalBotId ?? meta.signal_bot_id
  return typeof id === 'string' && id ? id : null
}

export function createAdoptPositionService(
  db: KaiBotDatabase,
  exchangeManager: ExchangeManager,
  deps: AdoptPositionDeps = {},
) {
  const userId = deps.userId ?? 'default'

  function signalRow(signalId: string): SignalRow | undefined {
    return db.get(
      `SELECT id, strategy_name, symbol, action, price, stop_loss, status, error_message, metadata, received_at, ack_status
       FROM signals WHERE id = ?`,
      [signalId],
    ) as SignalRow | undefined
  }

  // Where the signal's bot trades: venue, venue symbol and the account its
  // subscription routes to. Throws when the signal cannot map onto the
  // requested (exchange, account, symbol).
  function resolveLineage(sig: SignalRow, req: { exchange: string; symbol: string; accountId?: string }) {
    const meta = parseMeta(sig.metadata)
    const botId = botIdOf(meta)
    if (!botId) throw new Error('this signal carries no bot id; only bot entries can be adopted')
    const sub = db.getSubscriptionForBot(botId) as
      | { id: string; signal_bot_id: string; bot_name: string | null; exchange: string | null; account_id: string | null; account_key: string | null }
      | undefined
    if (!sub) throw new Error('no active subscription for this bot')
    const venue = resolveVenue({
      subscriptionExchange: sub.exchange,
      signalMetadataExchange: typeof meta.exchange === 'string' ? meta.exchange : undefined,
    })
    if (!venue.exchange) throw new Error(venue.rejectReason ?? 'no execution venue for this signal')
    if (venue.exchange !== req.exchange.toLowerCase()) {
      throw new Error(`this signal trades on ${venue.exchange}, not ${req.exchange}`)
    }
    const mapping = mapToVenueSymbol(
      venue.exchange,
      sig.symbol,
      (meta.venueSymbols as Record<string, string> | undefined) ?? null,
    )
    if (!mapping.venueSymbol) throw new Error(mapping.rejectReason ?? 'signal symbol has no venue mapping')
    const wanted = mapping.venueSymbol.toUpperCase()
    const got = req.symbol.toUpperCase()
    if (got !== wanted && !isDatedContractOf(got, rootOf(wanted))) {
      throw new Error(`this signal is for ${mapping.venueSymbol}, not ${req.symbol}`)
    }
    // The subscription's routing must cover the requested account: an
    // explicit account pin must match, a connection label must match.
    if (req.accountId) {
      if (sub.account_id && sub.account_id !== req.accountId) {
        throw new Error(`this bot's subscription routes to account ${sub.account_id}, not ${req.accountId}`)
      }
      const key = accountKeyOf(req.accountId)
      if ((sub.account_key ?? undefined) !== key) {
        throw new Error(
          `this bot's subscription routes through the ${sub.account_key ?? 'default'} connection, not ${key ?? 'default'}`,
        )
      }
    }
    return { meta, botId, sub, exchange: venue.exchange, venueSymbol: mapping.venueSymbol }
  }

  async function adapterFor(exchange: string, accountId?: string | null) {
    const session = await exchangeManager.getSession(userId, exchange, accountKeyOf(accountId))
    if (!session || session.status !== 'connected') throw new Error(`exchange ${exchange} not connected`)
    return session.adapter
  }

  async function findPosition(req: AdoptRequest) {
    const adapter = await adapterFor(req.exchange, req.accountId)
    let accountId = req.accountId
    if (!accountId) {
      const accounts = await adapter.getAccounts()
      if (accounts.length === 0) throw new Error('no account available on this exchange')
      if (accounts.length > 1) {
        throw new Error(`pass accountId (one of: ${accounts.map((a) => a.accountId).join(', ')})`)
      }
      accountId = accounts[0].accountId
    }
    const positions = await adapter.getPositions()
    const pos = positions.find(
      (p) =>
        p.symbol.toLowerCase() === req.symbol.toLowerCase() &&
        Math.abs(p.size) > 0 &&
        (!p.accountId || p.accountId === accountId),
    )
    if (!pos) throw new Error(`no open position for ${req.symbol} on account ${accountId}`)
    return { adapter, accountId, pos }
  }

  function detachTargets(exchange: string, accountId: string, symbol: string) {
    const key = positionTrailKey(exchange, accountId, symbol)
    const managers = db.listActiveManagersForPosition(key).map((m) => m.manager_id)
    const trails = db.findActiveTrailsForSymbol(exchange, symbol, accountId).filter((t) => t.source === 'manual')
    return { key, managers, trails }
  }

  function lineageStop(signalId: string): string | null {
    const pair = db.listBracketPairs().find((p) => p.signal_id === signalId && p.sl_order_id)
    return pair?.sl_order_id ?? null
  }

  async function ack(sig: SignalRow, fill: { price: number | null; time: number }, slOrderId: string | null) {
    if (!deps.ackAdoptedEntry) return null
    try {
      return await deps.ackAdoptedEntry(sig.id, fill, slOrderId)
    } catch (err: any) {
      db.log('warn', 'signal', 'Adoption ack to server failed', { signalId: sig.id, error: err?.message })
      return { ok: false, positionId: null }
    }
  }

  // Rejected/expired bot entries of the last weeks whose bot trades this
  // (exchange, account, symbol) and whose side matches the open position.
  async function candidates(req: {
    exchange: string
    symbol: string
    accountId?: string
    side?: 'long' | 'short'
  }): Promise<AdoptCandidate[]> {
    const rows = db.all(
      `SELECT id, strategy_name, symbol, action, price, stop_loss, status, error_message, metadata, received_at, ack_status
       FROM signals
       WHERE status IN ('rejected', 'expired') AND action IN ('buy', 'sell')
         AND received_at >= datetime('now', ?)
       ORDER BY received_at DESC LIMIT 200`,
      [`-${CANDIDATE_WINDOW_DAYS} days`],
    ) as SignalRow[]
    const out: AdoptCandidate[] = []
    for (const sig of rows) {
      if (req.side && (sig.action === 'buy' ? 'long' : 'short') !== req.side) continue
      if (db.getSignalExecution(sig.id)) continue
      let lineage: ReturnType<typeof resolveLineage>
      try {
        lineage = resolveLineage(sig, req)
      } catch {
        continue
      }
      out.push({
        signalId: sig.id,
        botId: lineage.botId,
        botName: lineage.sub.bot_name ?? null,
        subscriptionId: lineage.sub.id,
        strategyName: sig.strategy_name,
        action: sig.action as 'buy' | 'sell',
        price: sig.price,
        stopLoss: sig.stop_loss,
        receivedAt: sig.received_at,
        reason: sig.error_message,
        positionId: typeof lineage.meta.positionId === 'string' ? (lineage.meta.positionId as string) : null,
        venueSymbol: lineage.venueSymbol,
      })
    }
    return out
  }

  async function adopt(req: AdoptRequest): Promise<AdoptResult> {
    const sig = signalRow(req.signalId)
    if (!sig) throw new Error('signal not found')
    if (sig.action !== 'buy' && sig.action !== 'sell') throw new Error('only entry signals can be adopted')
    const direction: 'long' | 'short' = sig.action === 'buy' ? 'long' : 'short'
    const lineage = resolveLineage(sig, req)
    const { adapter, accountId, pos } = await findPosition(req)
    if (pos.side !== direction) {
      throw new Error(`the position is ${pos.side}, the signal is a ${direction} entry`)
    }
    const canonicalSymbol = sig.symbol
    const botName = lineage.sub.bot_name ?? null
    const positionId = typeof lineage.meta.positionId === 'string' ? (lineage.meta.positionId as string) : null

    return withOrderLock(req.exchange, async () => {
      const existing = db.getSignalExecution(sig.id)
      if (existing && (existing.status === 'open' || existing.status === 'closing')) {
        if (existing.account_id && existing.account_id !== accountId) {
          throw new Error(`this signal is already held on account ${existing.account_id}`)
        }
        // Repeat: nothing to write, only a failed ack is worth retrying.
        const slOrderId = lineageStop(sig.id)
        const entryFill = db.getSignalFills(sig.id).find((f) => f.kind === 'entry')
        const state = positionId ? db.getServerExitState(positionId) : null
        const serverAck =
          sig.ack_status === 'ok'
            ? { ok: true, positionId }
            : await ack(sig, { price: entryFill?.price ?? pos.entryPrice, time: existing.created_at }, slOrderId)
        return {
          signalId: sig.id,
          botId: lineage.botId,
          botName,
          exchange: req.exchange,
          accountId,
          symbol: pos.symbol,
          canonicalSymbol,
          direction,
          qty: Math.max(0, existing.qty_opened - existing.qty_closed),
          avgPrice: entryFill?.price ?? pos.entryPrice,
          openedAt: new Date(existing.created_at).toISOString(),
          stop: { price: state?.current_stop ?? sig.stop_loss, slOrderId, source: 'lineage' },
          positionId,
          serverAck,
          alreadyAdopted: true,
          detached: { managers: [], trails: 0 },
        }
      }
      if (existing && existing.status === 'closed') {
        throw new Error("this signal's lineage already closed; nothing to adopt into")
      }
      if (sig.status === 'executed' || sig.status === 'closed') {
        throw new Error(`signal is already ${sig.status}`)
      }
      if (sig.status === 'deferred') {
        throw new Error('this entry is deferred and will run by itself; drop it first')
      }

      const qty = Math.abs(pos.size)
      const avgPrice = pos.entryPrice
      const mark = pos.markPrice ?? pos.entryPrice
      const marker = db.getManualPosition(req.exchange, accountId, pos.symbol)
      const openedAtMs = req.openedAt?.getTime() ?? marker?.opened_at ?? Date.now()
      const exitSide: 'buy' | 'sell' = direction === 'long' ? 'sell' : 'buy'

      // ── One stop per position: lineage stop, else the manual one, else place. ──
      let slOrderId = lineageStop(sig.id)
      let stopPrice: number | null = null
      let stopSource: AdoptResult['stop']['source'] = 'lineage'
      if (slOrderId) {
        stopPrice = req.stopPrice ?? sig.stop_loss
      } else {
        const seed = findAdoptableStopSeed(db, req.exchange, pos.symbol, { direction, mark })
        if (seed) {
          slOrderId = seed.slOrderId
          stopPrice = seed.currentStop ?? req.stopPrice ?? sig.stop_loss
          stopSource = 'manual'
          if (seed.bracketSignalId && seed.bracketSignalId !== sig.id) db.deleteBracketPair(seed.bracketSignalId)
          db.log('info', 'trading', 'Adoption takes over the resting manual stop', {
            signalId: sig.id,
            slOrderId,
            fromSignalId: seed.bracketSignalId,
            stop: stopPrice,
          })
        } else {
          stopPrice = req.stopPrice ?? sig.stop_loss
          if (stopPrice == null) throw new Error('the signal carries no stop; pass stopPrice')
          if (direction === 'long' ? stopPrice >= mark : stopPrice <= mark) {
            throw new Error(`stop ${stopPrice} is already crossed at the venue (mark ${mark}); pass stopPrice`)
          }
          const sl = await adapter.placeOrder({
            accountId,
            symbol: pos.symbol,
            side: exitSide,
            orderType: 'stop',
            quantity: qty,
            stopPrice,
            reduceOnly: true,
            label: `kaibot:${sig.id}:sl`,
            clientOrderId: deriveClientOrderId(sig.id, 'sl'),
          })
          if (sl.status === 'rejected') throw new Error('the venue rejected the protective stop')
          slOrderId = sl.orderId
          stopSource = 'placed'
          db.log('info', 'trading', 'Stop-loss placed for adopted position', {
            signalId: sig.id,
            orderId: slOrderId,
            triggerPrice: stopPrice,
          })
        }
      }

      // ── Local lineage, exactly what a fill writes. ──
      if (existing) {
        // A failed open ('error') re-arms in place.
        db.updateSignalExecution(sig.id, { status: 'open', qtyOpened: qty, qtyClosed: 0, errorReason: null })
        db.run('UPDATE signal_executions SET symbol = ?, account_id = ?, created_at = ? WHERE signal_id = ?', [
          pos.symbol,
          accountId,
          openedAtMs,
          sig.id,
        ])
      } else {
        db.insertSignalExecution({
          signalId: sig.id,
          symbol: pos.symbol,
          exchange: req.exchange,
          direction,
          status: 'open',
          qtyOpened: qty,
          accountId,
          createdAtMs: openedAtMs,
        })
      }
      db.insertSignalFill({
        signalId: sig.id,
        kind: 'entry',
        symbol: pos.symbol,
        side: sig.action as 'buy' | 'sell',
        qty,
        price: avgPrice,
        orderId: null,
        createdAtMs: openedAtMs,
      })
      db.updateSignalStatus(sig.id, 'executed', undefined, 'adopted manual position')
      db.run('UPDATE signals SET metadata = ? WHERE id = ?', [
        JSON.stringify({
          ...lineage.meta,
          adopted: { at: new Date().toISOString(), avgPrice, openedAt: new Date(openedAtMs).toISOString() },
        }),
        sig.id,
      ])
      db.updateSignalOrderIds(sig.id, slOrderId ?? undefined, undefined)
      if (slOrderId) deps.registerBracket?.(req.exchange, sig.id, slOrderId, [], accountId)
      if (lineage.meta.exitAuthority === 'server' && positionId && slOrderId) {
        db.upsertServerExitState({
          positionId,
          entrySignalId: sig.id,
          exchange: req.exchange,
          symbol: pos.symbol,
          direction,
          currentStop: stopPrice,
          slOrderId,
        })
      }
      db.reduceManualPosition(req.exchange, accountId, pos.symbol, qty)

      try {
        const cfg = db.getBotConfigBySignalBotId(lineage.botId, canonicalSymbol)
        const group = ensureBotGroup(db, {
          signalBotId: lineage.botId,
          botConfigId: cfg?.id ?? null,
          name: cfg?.botName ?? cfg?.strategyName ?? botName,
        })
        autoLinkPosition(db, { exchange: req.exchange, accountId, symbol: pos.symbol, groupId: group.id })
      } catch (err: any) {
        db.log('warn', 'trading', 'Position group auto-link failed', { signalId: sig.id, error: err?.message })
      }

      // One stop owner: local managers and manual trails step aside.
      const { key, managers, trails } = detachTargets(req.exchange, accountId, pos.symbol)
      for (const m of managers) db.deactivatePositionManager(key, m)
      if (managers.length > 0) db.deactivateManagedPosition(key)
      for (const t of trails) db.deactivateLocalTrail(t.signal_id)

      const serverAck = await ack(sig, { price: avgPrice, time: openedAtMs }, slOrderId)

      db.log('warn', 'trading', 'Manual position adopted into bot lineage', {
        signalId: sig.id,
        botId: lineage.botId,
        exchange: req.exchange,
        symbol: pos.symbol,
        accountId,
        direction,
        qty,
        avgPrice,
        stop: stopPrice,
        slOrderId,
        stopSource,
        positionId,
        serverAck,
        detachedManagers: managers,
        detachedTrails: trails.length,
      })
      deps.notify?.({
        type: 'position_adopted',
        title: 'Position adopted by bot',
        body: `${pos.symbol} ${direction} on ${req.exchange} now belongs to ${botName ?? lineage.botId}${
          serverAck && !serverAck.ok ? ' (server not told yet)' : ''
        }.`,
        data: { signalId: sig.id, botId: lineage.botId, symbol: pos.symbol, accountId, positionId },
      })

      return {
        signalId: sig.id,
        botId: lineage.botId,
        botName,
        exchange: req.exchange,
        accountId,
        symbol: pos.symbol,
        canonicalSymbol,
        direction,
        qty,
        avgPrice,
        openedAt: new Date(openedAtMs).toISOString(),
        stop: { price: stopPrice, slOrderId, source: stopSource },
        positionId,
        serverAck,
        alreadyAdopted: false,
        detached: { managers, trails: trails.length },
      }
    })
  }

  return { candidates, adopt }
}

export type AdoptPositionService = ReturnType<typeof createAdoptPositionService>

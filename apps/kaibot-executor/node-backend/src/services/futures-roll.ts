// Engine roll notice → what this executor still holds on the outgoing contract.
//
// The engine's root series switches contract on a volume crossover
// (FuturesContinuousManager); from that bar on every signal price, stop and
// mark for the root is a NEXT-contract price. A position left on the old
// contract then trades against a series that is one calendar spread away
// (MES U26 vs Z26, 2026-09: 65 pt) until it expires. The notice arrives as
// `action: 'roll'` with `metadata.roll = { from, to, at, ratio }`.
//
// Always: report loudly (notification + log) when a position is held on
// `from`. Opt-in (EXECUTOR_AUTO_ROLL=1): roll it through the existing
// roll-position route (close old leg, reopen same exposure on `to`) and
// carry the lineage over — executions re-pointed to `to`, the protective stop
// re-armed on `to` at stop × ratio. Default off: the user rolls from Positions.
import type { KaiBotDatabase } from '../storage/database.js'
import type { Signal } from '../storage/types.js'
import type { ExchangeManager } from './exchanges/exchangeManager.js'
import type { ExchangeAdapter, Position } from './exchanges/types.js'
import type { NotificationBus } from './notifications/notification-bus.js'
import { createRollService, type RollResult, type RollService } from './roll-position.js'
import { expiryInfoForSymbol } from './exchanges/contract-expiry.js'
import { isDatedContractOf, rootOf } from './exchanges/futures-contracts.js'
import { accountKeyOf, scopeAccountId } from './exchanges/account-scope.js'
import { composeEffectiveStop } from './position-trail.js'
import { serverExitEffectiveStop, serverExitEngineStop } from './server-exit-stop.js'

export interface RollNotice {
  id: string
  exchange: string
  root: string
  from: string
  to: string
  at: Date
  ratio: number
  source: string
}

export function parseRollNotice(signal: Signal): RollNotice | null {
  if ((signal.action as string) !== 'roll') return null
  const roll = signal.metadata?.roll as
    | { from?: unknown; to?: unknown; at?: unknown; ratio?: unknown; source?: unknown }
    | undefined
  const exchange = signal.metadata?.exchange as string | undefined
  if (!roll || !exchange || typeof signal.symbol !== 'string') return null
  const root = rootOf(signal.symbol).toUpperCase()
  const from = typeof roll.from === 'string' ? roll.from.toUpperCase() : ''
  const to = typeof roll.to === 'string' ? roll.to.toUpperCase() : ''
  if (!isDatedContractOf(from, root) || !isDatedContractOf(to, root) || from === to) return null
  const at = typeof roll.at === 'string' ? new Date(roll.at) : new Date(NaN)
  if (Number.isNaN(at.getTime())) return null
  const ratio = typeof roll.ratio === 'number' && roll.ratio > 0 ? roll.ratio : 1
  return {
    id: signal.id,
    exchange,
    root,
    from,
    to,
    at,
    ratio,
    source: typeof roll.source === 'string' ? roll.source : 'live',
  }
}

// Exchange tick per root, for the re-armed stop. Conservative rounding: a
// long's stop rounds down, a short's up (never tighter than the strategy's).
const TICK_BY_ROOT: Record<string, number> = {
  ES: 0.25, MES: 0.25, NQ: 0.25, MNQ: 0.25, GC: 0.1, MGC: 0.1, SI: 0.005, SIL: 0.005,
}

export function rolledStopPrice(stop: number, ratio: number, direction: 'long' | 'short', symbol: string): number {
  const tick = TICK_BY_ROOT[rootOf(symbol).toUpperCase()] ?? 0
  const raw = stop * ratio
  if (!(tick > 0)) return raw
  const ticks = raw / tick
  const rounded = direction === 'long' ? Math.floor(ticks + 1e-9) : Math.ceil(ticks - 1e-9)
  return Number((rounded * tick).toFixed(8))
}

export interface HeldContract {
  accountId: string
  side: 'long' | 'short'
  size: number
  /** Lineage entry signal ids on this contract for this account (empty = manual / untracked). */
  entrySignalIds: string[]
}

export interface FuturesRollDeps {
  db: KaiBotDatabase
  exchangeManager: ExchangeManager | null
  notifications: NotificationBus | null
  /** EXECUTOR_AUTO_ROLL=1 */
  autoRoll: boolean
  /** Cancel + forget an entry's SL/TP legs (signal client's bracket registry). */
  retireBracket: (exchange: string, signalId: string) => Promise<void>
  rollService?: RollService
  userId?: string
}

export interface FuturesRollOutcome {
  notice: RollNotice
  held: HeldContract[]
  rolled: Array<{ accountId: string; result: RollResult }>
  skipped: 'not_held' | 'no_exchange' | null
}

/** Positions on `from` per broker account: the venue's book per connection, joined with this executor's lineages. */
export async function findHeldContracts(
  deps: FuturesRollDeps,
  notice: RollNotice,
): Promise<HeldContract[]> {
  const userId = deps.userId ?? 'default'
  // Lineage entries per stored account id (scoped 'label/venue' or bare venue id).
  const lineagesByAccount = new Map<string, string[]>()
  for (const exec of deps.db.listOpenExecutionsForExchange(notice.exchange)) {
    if (exec.symbol.toUpperCase() !== notice.from) continue
    const key = exec.account_id ?? ''
    const list = lineagesByAccount.get(key) ?? []
    list.push(exec.signal_id)
    lineagesByAccount.set(key, list)
  }
  const connectionKeys = new Set<string | undefined>([undefined])
  for (const accountId of lineagesByAccount.keys()) connectionKeys.add(accountKeyOf(accountId || null))

  const held: HeldContract[] = []
  const seen = new Set<string>()
  for (const connectionKey of connectionKeys) {
    const session = await deps.exchangeManager?.getSession(userId, notice.exchange, connectionKey)
    if (!session || session.status !== 'connected') continue
    let positions: Position[]
    try {
      positions = await session.adapter.getPositions()
    } catch {
      continue
    }
    for (const p of positions) {
      if (p.symbol.toUpperCase() !== notice.from || Math.abs(p.size) === 0) continue
      const scoped = scopeAccountId(connectionKey, p.accountId)
      if (seen.has(scoped)) continue
      seen.add(scoped)
      held.push({
        accountId: scoped,
        side: p.side,
        size: Math.abs(p.size),
        entrySignalIds:
          lineagesByAccount.get(scoped) ??
          lineagesByAccount.get(p.accountId) ??
          (connectionKey === undefined ? lineagesByAccount.get('') : undefined) ??
          [],
      })
    }
  }
  return held
}

function expiryText(symbol: string): string {
  const info = expiryInfoForSymbol(symbol)
  if (!info) return ''
  const day = new Date(info.date)
  const label = day.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
  return info.daysLeft === 0 ? ` It expires today (${label}).` : ` It expires ${label} (${info.daysLeft}d).`
}

export async function handleFuturesRollNotice(
  signal: Signal,
  deps: FuturesRollDeps,
): Promise<FuturesRollOutcome | null> {
  const notice = parseRollNotice(signal)
  if (!notice) {
    deps.db.log('warn', 'signal', 'Roll notice ignored: malformed', { signalId: signal.id, symbol: signal.symbol })
    return null
  }
  const outcome: FuturesRollOutcome = { notice, held: [], rolled: [], skipped: null }
  if (!deps.exchangeManager) {
    outcome.skipped = 'no_exchange'
    return outcome
  }

  outcome.held = await findHeldContracts(deps, notice)
  if (outcome.held.length === 0) {
    outcome.skipped = 'not_held'
    deps.db.log('info', 'trading', 'Contract roll: nothing held on the outgoing contract', {
      root: notice.root, from: notice.from, to: notice.to, at: notice.at.toISOString(),
    })
    return outcome
  }

  const summary = outcome.held
    .map((h) => `${h.size} ${notice.from} ${h.side} (account ${h.accountId})`)
    .join(', ')
  deps.db.log('warn', 'trading', 'Contract roll: position still on the outgoing contract', {
    root: notice.root, from: notice.from, to: notice.to, at: notice.at.toISOString(),
    ratio: notice.ratio, held: outcome.held, autoRoll: deps.autoRoll,
  })
  deps.notifications?.publish({
    type: 'roll_required',
    title: `${notice.root} rolled to ${notice.to}`,
    body:
      `Signals for ${notice.root} now price ${notice.to}. You still hold ${summary}.` +
      expiryText(notice.from) +
      (deps.autoRoll ? ' Rolling it now.' : ' Roll it from Positions.'),
    data: { root: notice.root, from: notice.from, to: notice.to, held: outcome.held },
  })

  if (!deps.autoRoll) return outcome

  const rollService =
    deps.rollService ??
    createRollService(deps.db, deps.exchangeManager, {
      userId: deps.userId,
      retireBracket: deps.retireBracket,
    })
  for (const h of outcome.held) {
    try {
      const result = await rollHeld(deps, rollService, notice, h)
      outcome.rolled.push({ accountId: h.accountId, result })
    } catch (err: any) {
      deps.db.log('error', 'trading', 'Auto-roll failed', {
        root: notice.root, from: notice.from, to: notice.to, accountId: h.accountId, error: err?.message,
      })
      deps.notifications?.publish({
        type: 'roll_failed',
        title: `${notice.from} roll failed`,
        body: `${notice.from} → ${notice.to} on account ${h.accountId} failed: ${err?.message ?? 'unknown error'}. Check the position.`,
        data: { root: notice.root, from: notice.from, to: notice.to, accountId: h.accountId },
      })
    }
  }
  return outcome
}

interface LineageProtection {
  signalId: string
  direction: 'long' | 'short'
  openQty: number
  // The stop resting at the venue (the composed effective stop).
  stop: number | null
  serverExit: { positionId: string; exitSeq: number } | null
  // Stop floor (migration 038) carried across the seam: the bot's own stop and
  // the user's floor both live in the root's price space, so both rescale.
  engineStop: number | null
  manualStop: number | null
  trailingLock: boolean
  restingIds: string[]
}

function lineageProtections(db: KaiBotDatabase, exchange: string, ids: string[]): LineageProtection[] {
  const exitStates = db.listActiveServerExitStates(exchange)
  const pairs = db.listBracketPairs()
  const out: LineageProtection[] = []
  for (const id of ids) {
    const exec = db.getSignalExecution(id)
    if (!exec) continue
    const bracket = db.getSignalBracket(id)
    const state = exitStates.find((s) => s.entry_signal_id === id) ?? null
    const pair = pairs.find((p) => p.signal_id === id)
    const restingIds = [
      bracket?.stop_loss_order_id, bracket?.take_profit_order_id, state?.sl_order_id, pair?.sl_order_id, pair?.tp_order_id,
    ].filter((v, i, a): v is string => typeof v === 'string' && v.length > 0 && a.indexOf(v) === i)
    const entryRow = db.getOpenEntrySignals(rootOf(exec.symbol)).find((e) => e.id === id)
    out.push({
      signalId: id,
      direction: exec.direction,
      openQty: Math.max(0, Number(exec.qty_opened) - Number(exec.qty_closed)),
      stop: state ? (serverExitEffectiveStop(state) ?? state.current_stop) : (entryRow?.stop_loss ?? null),
      serverExit: state ? { positionId: state.position_id, exitSeq: state.last_exit_seq } : null,
      engineStop: state ? serverExitEngineStop(state) : (entryRow?.stop_loss ?? null),
      manualStop: state?.manual_stop ?? null,
      trailingLock: !!state?.trailing_lock,
      restingIds,
    })
  }
  return out
}

async function cancelQuietly(adapter: ExchangeAdapter, orderId: string, symbol: string) {
  try {
    await adapter.cancelOrder(orderId, { symbol })
  } catch {
    // Already gone.
  }
}

async function rearmStop(
  deps: FuturesRollDeps,
  adapter: ExchangeAdapter,
  p: LineageProtection,
  exchange: string,
  symbol: string,
  accountId: string,
  stop: number,
  qty: number,
  // Rescaled bot stop for the exit state; omitted = unchanged.
  engineStop?: number | null,
): Promise<string | null> {
  if (!(stop > 0) || !(qty > 0)) return null
  const placed = await adapter.placeOrder({
    accountId,
    symbol,
    side: p.direction === 'long' ? 'sell' : 'buy',
    orderType: 'stop',
    quantity: qty,
    stopPrice: stop,
    reduceOnly: true,
    label: `kaibot:${p.signalId}:roll-stop`,
  })
  if (placed.status === 'rejected') return null
  deps.db.updateSignalOrderIds(p.signalId, placed.orderId, undefined)
  deps.db.upsertBracketPair({ signalId: p.signalId, exchange, accountId, slOrderId: placed.orderId })
  if (p.serverExit) {
    deps.db.applyServerExitUpdate(p.serverExit.positionId, {
      exitSeq: p.serverExit.exitSeq, currentStop: stop, slOrderId: placed.orderId,
      ...(engineStop !== undefined ? { engineStop } : {}),
    })
  }
  return placed.orderId
}

async function rollHeld(
  deps: FuturesRollDeps,
  rollService: RollService,
  notice: RollNotice,
  held: HeldContract,
): Promise<RollResult> {
  const userId = deps.userId ?? 'default'
  const session = await deps.exchangeManager!.getSession(userId, notice.exchange, accountKeyOf(held.accountId))
  if (!session || session.status !== 'connected') throw new Error(`${notice.exchange} not connected`)
  const adapter = session.adapter

  // 1. Retire the lineage's protections on the OLD contract. TradeStation has
  //    no reduce-only: a stop left resting on a flat contract opens a naked
  //    position when it triggers.
  const protections = lineageProtections(deps.db, notice.exchange, held.entrySignalIds)
  for (const p of protections) {
    await deps.retireBracket(notice.exchange, p.signalId)
    for (const id of p.restingIds) await cancelQuietly(adapter, id, notice.from)
  }

  // 2. Both legs through the existing roll route (all-or-nothing).
  const result = await rollService.execute({
    exchange: notice.exchange,
    symbol: notice.from,
    toSymbol: notice.to,
    accountId: held.accountId,
    legOrderType: 'market',
    idempotencyKey: `${notice.id}:${held.accountId}`,
  })

  if (result.status !== 'rolled') {
    // Position (or its remainder) is still on the old contract: put its
    // stop back where it was.
    if (result.status === 'aborted' || result.status === 'restored') {
      for (const p of protections) {
        if (p.stop != null) {
          await rearmStop(deps, adapter, p, notice.exchange, notice.from, held.accountId, p.stop, p.openQty)
        }
      }
    }
    deps.db.log('error', 'trading', 'Auto-roll did not complete', {
      root: notice.root, from: notice.from, to: notice.to, accountId: held.accountId,
      status: result.status, warnings: result.warnings,
    })
    deps.notifications?.publish({
      type: 'roll_failed',
      title: `${notice.from} roll ${result.status}`,
      body: result.warnings.join(' ') || `Roll ${notice.from} → ${notice.to} ended ${result.status}. Check the position.`,
      data: { root: notice.root, from: notice.from, to: notice.to, accountId: held.accountId, status: result.status },
    })
    return result
  }

  // 3. Carry the lineage over: executions now live on `to`; the roll route
  //    marked the new leg manual (so the reconciler leaves it alone) — undo
  //    that for a lineage-owned position, it is not manual.
  for (const p of protections) deps.db.updateSignalExecutionSymbol(p.signalId, notice.to)
  if (held.entrySignalIds.length > 0) {
    deps.db.reduceManualPosition(notice.exchange, held.accountId, notice.to, result.rolledQuantity)
  }

  // 4. Stops back on, one spread higher: the strategy's stop lives in the
  //    root's price space, which is `to` from the seam on.
  const rearmed: Array<{ signalId: string; stop: number; orderId: string | null }> = []
  for (const p of protections) {
    if (p.serverExit) deps.db.updateServerExitStateSymbol(p.serverExit.positionId, notice.to)
    // The floor rides along in the same price space; the venue stop on the
    // new contract is the composition of the rescaled parts.
    const engineStop = p.engineStop != null ? rolledStopPrice(p.engineStop, notice.ratio, p.direction, notice.to) : null
    const manualStop = p.manualStop != null ? rolledStopPrice(p.manualStop, notice.ratio, p.direction, notice.to) : null
    if (p.serverExit && manualStop != null && typeof deps.db.updateServerExitStopFloor === 'function') {
      deps.db.updateServerExitStopFloor(p.serverExit.positionId, { manualStop })
    }
    const stop = composeEffectiveStop({ direction: p.direction, manualStop, engineStop, trailingLock: p.trailingLock })
    if (stop == null) continue
    let orderId: string | null = null
    try {
      orderId = await rearmStop(deps, adapter, p, notice.exchange, notice.to, held.accountId, stop, p.openQty, engineStop)
    } catch (err: any) {
      deps.db.log('error', 'trading', 'Roll: re-arming the stop on the new contract failed', {
        signalId: p.signalId, symbol: notice.to, stop, error: err?.message,
      })
    }
    rearmed.push({ signalId: p.signalId, stop, orderId })
  }
  const naked = rearmed.filter((r) => r.orderId === null)

  deps.db.log('info', 'trading', 'Position rolled by the executor', {
    root: notice.root, from: notice.from, to: notice.to, accountId: held.accountId,
    quantity: result.rolledQuantity, ratio: notice.ratio, rearmed,
  })
  deps.notifications?.publish({
    type: naked.length > 0 ? 'roll_failed' : 'position_rolled',
    title: `${notice.from} → ${notice.to} rolled`,
    body:
      `${result.rolledQuantity} ${held.side} moved to ${notice.to} on account ${held.accountId}.` +
      (rearmed.length > 0 && naked.length === 0
        ? ` Stop re-armed at ${rearmed.map((r) => r.stop).join(', ')}.`
        : naked.length > 0
          ? ` Stop could NOT be re-armed for ${naked.map((r) => r.signalId).join(', ')} — set one now.`
          : ''),
    data: { root: notice.root, from: notice.from, to: notice.to, accountId: held.accountId, rearmed },
  })
  return result
}

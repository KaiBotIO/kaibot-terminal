// User-initiated contract roll: close a position on an expiring dated futures
// contract and reopen the SAME exposure (side + size) on the next contract, as
// one explicit action. Executed ENTIRELY edge-side on the user's connected
// exchange — no server signal, no auto-roll (the user previews and confirms
// every roll). Reuses the manual-trade spine: order lock, durable settlement
// rows, manual-position markers, bracket/rung/trail cleanup on the old leg.
//
// All-or-nothing contract ("never leave one leg"):
//  - The close leg goes first. If it rejects, doesn't fill in the window, or
//    its outcome stays unknown, the roll ABORTS with the position intact.
//  - Once (part of) the old leg is closed, the open leg MUST end in exposure:
//    a limit open that doesn't fill in the window is cancelled and completed
//    at market; a rejected open triggers a compensating market re-open of the
//    old contract. Only when even that restore fails does the user end up
//    one-legged — reported loudly, never silently.

import type { KaiBotDatabase } from '../storage/database.js'
import type { ExchangeManager } from './exchanges/exchangeManager.js'
import type { ExchangeAdapter, OrderResult } from './exchanges/types.js'
import type { ManualTradeDeps } from './manual-trade.js'
import { withOrderLock } from './order-lock.js'
import { settleAdapterOrder, type SettleOptions, type SettlementResult } from './order-settlement.js'
import { expiryInfoForSymbol, type PositionExpiryInfo } from './exchanges/contract-expiry.js'
import { multiplierFor } from './exchanges/futures-contracts.js'

export type RollLegOrderType = 'market' | 'limit'

export interface RollPreviewInput {
  exchange: string
  symbol: string
  accountId?: string
  toSymbol?: string // override; default = the symbol's derived next contract
}

export interface RollPreview {
  exchange: string
  accountId: string
  fromSymbol: string
  toSymbol: string
  side: 'long' | 'short'
  size: number
  closeSide: 'buy' | 'sell'
  openSide: 'buy' | 'sell'
  /** Per-1.0-price-move USD value (futures multiplier; 1 for crypto). */
  multiplier: number
  fromPrice: number | null
  toPrice: number | null
  /** toPrice - fromPrice; null when either price is unavailable. */
  spread: number | null
  /** Signed cost of the roll excl. fees (positive = costs money). */
  estCost: number | null
  expiry: PositionExpiryInfo | null
}

export interface RollExecuteInput {
  exchange: string
  symbol: string
  toSymbol: string
  accountId?: string
  legOrderType?: RollLegOrderType // default market
  closeLimitPrice?: number // required for limit legs
  openLimitPrice?: number // required for limit legs
  idempotencyKey?: string
}

export interface RollLegReport {
  symbol: string
  orderId: string
  status: OrderResult['status']
  filledQuantity?: number
  averagePrice?: number
}

export type RollStatus =
  // Both legs done: old exposure is now on the new contract.
  | 'rolled'
  // Nothing (or only a cancelled unfilled close) happened: position intact.
  | 'aborted'
  // Open leg failed; the closed quantity was re-opened on the OLD contract.
  | 'restored'
  // Open leg AND the compensating restore failed: the user is flat on the
  // closed quantity with no new leg. Loud — requires manual attention.
  | 'incomplete'

export interface RollResult {
  status: RollStatus
  requestedQuantity: number
  rolledQuantity: number
  closeLeg?: RollLegReport
  openLeg?: RollLegReport
  restoreLeg?: RollLegReport
  warnings: string[]
}

export interface RollService {
  preview(input: RollPreviewInput): Promise<RollPreview>
  execute(input: RollExecuteInput): Promise<RollResult>
}

/**
 * Pure roll math: leg sides + estimated spread cost for rolling `size`
 * contracts. Exported for unit tests. Cost sign is from the trader's
 * perspective: positive = the roll costs money (e.g. a long rolling into
 * contango pays the spread), negative = the roll pays out.
 */
export function computeRollMath(input: {
  side: 'long' | 'short'
  size: number
  multiplier: number
  fromPrice: number | null
  toPrice: number | null
}): {
  closeSide: 'buy' | 'sell'
  openSide: 'buy' | 'sell'
  spread: number | null
  estCost: number | null
} {
  const closeSide = input.side === 'long' ? 'sell' : 'buy'
  const openSide = input.side === 'long' ? 'buy' : 'sell'
  const havePrices =
    input.fromPrice != null && input.fromPrice > 0 && input.toPrice != null && input.toPrice > 0
  const spread = havePrices ? (input.toPrice as number) - (input.fromPrice as number) : null
  const estCost =
    spread == null
      ? null
      : (input.side === 'long' ? spread : -spread) * Math.abs(input.size) * input.multiplier
  return { closeSide, openSide, spread, estCost }
}

interface LegOutcome {
  status: 'filled' | 'partially_filled' | 'rejected' | 'cancelled' | 'unknown'
  filledQuantity: number
  averagePrice?: number
}

// Effective terminal outcome of a placed leg. With a broker status endpoint the
// settlement poll is authoritative; without one the placeOrder result is.
function legOutcome(
  adapter: ExchangeAdapter,
  placed: OrderResult,
  settled: SettlementResult,
): LegOutcome {
  const src = adapter.getOrderStatus ? settled.status : placed.status
  const filledQuantity = settled.filledQuantity ?? placed.filledQuantity ?? 0
  const averagePrice = settled.averagePrice ?? placed.averagePrice
  switch (src) {
    case 'filled':
      return { status: 'filled', filledQuantity, averagePrice }
    case 'partially_filled':
      return { status: 'partially_filled', filledQuantity, averagePrice }
    case 'rejected':
      return { status: 'rejected', filledQuantity: 0, averagePrice }
    case 'cancelled':
      // A cancel can race a partial fill — trust the reported filled quantity.
      return filledQuantity > 0
        ? { status: 'partially_filled', filledQuantity, averagePrice }
        : { status: 'cancelled', filledQuantity: 0, averagePrice }
    default:
      return { status: 'unknown', filledQuantity, averagePrice }
  }
}

export function createRollService(
  db: KaiBotDatabase,
  exchangeManager: ExchangeManager,
  deps: ManualTradeDeps = {},
  settleOptions: SettleOptions = {},
): RollService {
  const userId = deps.userId ?? 'default'

  async function adapterFor(exchange: string): Promise<ExchangeAdapter> {
    const session = await exchangeManager.getSession(userId, exchange)
    if (!session || session.status !== 'connected') {
      throw new Error(`exchange ${exchange} not connected`)
    }
    return session.adapter
  }

  async function findPosition(adapter: ExchangeAdapter, symbol: string) {
    const positions = await adapter.getPositions()
    const pos = positions.find((p) => p.symbol.toUpperCase() === symbol.toUpperCase() && Math.abs(p.size) > 0)
    if (!pos) throw new Error(`no open position for ${symbol}`)
    return pos
  }

  async function priceOf(adapter: ExchangeAdapter, symbol: string): Promise<number | null> {
    try {
      const p = await adapter.getLastPrice?.(symbol)
      return p != null && p > 0 ? p : null
    } catch {
      return null
    }
  }

  async function preview(input: RollPreviewInput): Promise<RollPreview> {
    const adapter = await adapterFor(input.exchange)
    const pos = await findPosition(adapter, input.symbol)
    const expiry = expiryInfoForSymbol(pos.symbol)
    const toSymbol = input.toSymbol ?? expiry?.nextSymbol ?? null
    if (!toSymbol) {
      throw new Error(`no target contract known for ${pos.symbol} — pass toSymbol explicitly`)
    }
    if (toSymbol.toUpperCase() === pos.symbol.toUpperCase()) {
      throw new Error('target contract equals the current contract')
    }

    const size = Math.abs(pos.size)
    const multiplier = multiplierFor(pos.symbol)
    const fromPrice = (await priceOf(adapter, pos.symbol)) ?? pos.markPrice ?? null
    const toPrice = await priceOf(adapter, toSymbol)
    const math = computeRollMath({ side: pos.side, size, multiplier, fromPrice, toPrice })

    return {
      exchange: input.exchange,
      accountId: input.accountId ?? pos.accountId,
      fromSymbol: pos.symbol,
      toSymbol,
      side: pos.side,
      size,
      multiplier,
      fromPrice,
      toPrice,
      expiry,
      ...math,
    }
  }

  async function execute(input: RollExecuteInput): Promise<RollResult> {
    const legOrderType: RollLegOrderType = input.legOrderType ?? 'market'
    if (legOrderType === 'limit') {
      if (!(Number.isFinite(input.closeLimitPrice) && (input.closeLimitPrice as number) > 0)) {
        throw new Error('limit legs need a positive closeLimitPrice')
      }
      if (!(Number.isFinite(input.openLimitPrice) && (input.openLimitPrice as number) > 0)) {
        throw new Error('limit legs need a positive openLimitPrice')
      }
    }
    if (!input.toSymbol || input.toSymbol.toUpperCase() === input.symbol.toUpperCase()) {
      throw new Error('roll needs a target contract different from the current one')
    }

    const adapter = await adapterFor(input.exchange)
    const pos = await findPosition(adapter, input.symbol)
    const accountId = input.accountId ?? pos.accountId
    const quantity = Math.abs(pos.size)
    const closeSide: 'buy' | 'sell' = pos.side === 'long' ? 'sell' : 'buy'
    const openSide: 'buy' | 'sell' = pos.side === 'long' ? 'buy' : 'sell'
    const idemId = input.idempotencyKey ? `roll:${input.idempotencyKey}` : undefined
    const warnings: string[] = []

    return withOrderLock(input.exchange, async () => {
      // Idempotency: a duplicate submit whose close leg was already placed
      // must not roll twice.
      if (idemId) {
        const prior = db.getExitSettlement(idemId, 'exit', 'roll-close')
        if (prior) {
          return {
            status: 'aborted' as RollStatus,
            requestedQuantity: quantity,
            rolledQuantity: 0,
            warnings: ['Duplicate roll ignored (idempotency key already used).'],
          }
        }
      }

      // Retire resting brackets, pre-authorized entry rungs and edge trails on
      // the OLD contract before flattening it — same hygiene as a manual close:
      // a stop/TP must not fire against a position we are rolling away, and an
      // add must not fill into a contract we just left.
      const manualIds = db.listManualEntrySignalIds(input.exchange, pos.symbol)
      for (const sid of manualIds) {
        await deps.retireBracket?.(input.exchange, sid)
      }
      if (manualIds.length > 0) {
        await deps.cancelEntryRungs?.(input.exchange, manualIds)
      }
      for (const trail of db.findActiveTrailsForSymbol(input.exchange, pos.symbol)) {
        if (trail.sl_order_id) {
          try {
            await adapter.cancelOrder(trail.sl_order_id, { symbol: pos.symbol })
          } catch {
            // Already gone.
          }
        }
        db.deactivateLocalTrail(trail.signal_id)
      }

      // ── Leg 1: close the expiring contract (reduce-only) ────────────────
      const closePlaced = await adapter.placeOrder({
        accountId,
        symbol: pos.symbol,
        side: closeSide,
        orderType: legOrderType,
        quantity,
        price: legOrderType === 'limit' ? input.closeLimitPrice : undefined,
        reduceOnly: true,
        label: 'kaibot-roll-close',
        clientOrderId: input.idempotencyKey ? `${input.idempotencyKey}:close` : undefined,
      })
      const closeRecordId = idemId ?? `roll:${closePlaced.orderId}`
      const closeSettlementId = db.insertOrderSettlement({
        signalId: closeRecordId,
        exchange: input.exchange,
        accountId,
        symbol: pos.symbol,
        kind: 'exit',
        side: closeSide,
        qty: quantity,
        orderId: closePlaced.orderId,
        targetLabel: 'roll-close',
        status: 'unknown',
      })
      // settleAdapterOrder's cancel-on-timeout is exactly the abort we want for
      // an unfilled limit close: cancel it and keep the position intact.
      const closeSettled = await settleAdapterOrder(
        adapter,
        closePlaced.orderId,
        { symbol: pos.symbol, accountId },
        settleOptions,
      )
      const close = legOutcome(adapter, closePlaced, closeSettled)
      if (close.status === 'filled' || close.status === 'partially_filled') {
        db.resolveOrderSettlement(closeSettlementId, 'filled')
      } else if (close.status === 'rejected') {
        db.resolveOrderSettlement(closeSettlementId, 'rejected')
      } else if (close.status === 'cancelled') {
        db.resolveOrderSettlement(closeSettlementId, 'cancelled')
      } // unknown → leave for resolveUnknownOrders

      const closeLeg: RollLegReport = {
        symbol: pos.symbol,
        orderId: closePlaced.orderId,
        status: closePlaced.status,
        filledQuantity: close.filledQuantity,
        averagePrice: close.averagePrice,
      }

      if (close.status === 'rejected' || close.status === 'cancelled') {
        warnings.push(
          close.status === 'rejected'
            ? 'Close leg was rejected — nothing was rolled, the position is intact.'
            : 'Close leg did not fill within the window and was cancelled — nothing was rolled.',
        )
        db.log('warn', 'trading', 'Roll aborted on close leg', {
          exchange: input.exchange,
          symbol: pos.symbol,
          toSymbol: input.toSymbol,
          reason: close.status,
        })
        return { status: 'aborted', requestedQuantity: quantity, rolledQuantity: 0, closeLeg, warnings }
      }
      if (close.status === 'unknown') {
        warnings.push(
          'Close leg outcome is unknown — the roll was stopped before opening the new leg. ' +
            'The order will be reconciled; check the position before retrying.',
        )
        db.log('error', 'trading', 'Roll stopped: close leg unresolved', {
          exchange: input.exchange,
          symbol: pos.symbol,
          orderId: closePlaced.orderId,
        })
        return { status: 'aborted', requestedQuantity: quantity, rolledQuantity: 0, closeLeg, warnings }
      }

      const closedQty = close.filledQuantity > 0 ? close.filledQuantity : quantity
      if (close.status === 'partially_filled' && closedQty < quantity) {
        warnings.push(
          `Only ${closedQty} of ${quantity} closed within the window — rolling the closed part.`,
        )
      }
      db.reduceManualPosition(input.exchange, accountId, pos.symbol, closedQty)

      // ── Leg 2: open the same exposure on the next contract ──────────────
      const openLegReport = async (placed: OrderResult, outcome: LegOutcome): Promise<RollLegReport> => ({
        symbol: input.toSymbol,
        orderId: placed.orderId,
        status: placed.status,
        filledQuantity: outcome.filledQuantity,
        averagePrice: outcome.averagePrice,
      })

      const placeOpen = async (orderType: RollLegOrderType, qty: number) => {
        const placed = await adapter.placeOrder({
          accountId,
          symbol: input.toSymbol,
          side: openSide,
          orderType,
          quantity: qty,
          price: orderType === 'limit' ? input.openLimitPrice : undefined,
          reduceOnly: false,
          label: 'kaibot-roll-open',
          clientOrderId: input.idempotencyKey
            ? `${input.idempotencyKey}:open${orderType === 'market' ? '' : '-limit'}`
            : undefined,
        })
        const settlementId = db.insertOrderSettlement({
          signalId: idemId ? `${idemId}:open` : `roll-open:${placed.orderId}`,
          exchange: input.exchange,
          accountId,
          symbol: input.toSymbol,
          kind: 'entry',
          side: openSide,
          qty,
          orderId: placed.orderId,
          targetLabel: 'roll-open',
          status: 'unknown',
        })
        const settled = await settleAdapterOrder(
          adapter,
          placed.orderId,
          { symbol: input.toSymbol, accountId },
          settleOptions,
        )
        const outcome = legOutcome(adapter, placed, settled)
        if (outcome.status === 'filled' || outcome.status === 'partially_filled') {
          db.resolveOrderSettlement(settlementId, 'filled')
        } else if (outcome.status === 'rejected') {
          db.resolveOrderSettlement(settlementId, 'rejected')
        } else if (outcome.status === 'cancelled') {
          db.resolveOrderSettlement(settlementId, 'cancelled')
        }
        return { placed, outcome }
      }

      let open = await placeOpen(legOrderType, closedQty)
      let openLeg = await openLegReport(open.placed, open.outcome)
      let openedQty = open.outcome.filledQuantity

      // A limit open that didn't (fully) fill is completed at market: the
      // all-or-nothing promise outranks the limit price on the second leg.
      if (
        legOrderType === 'limit' &&
        (open.outcome.status === 'cancelled' || open.outcome.status === 'partially_filled') &&
        openedQty < closedQty
      ) {
        warnings.push('Open leg limit did not fill in time — completing the roll at market.')
        const remainder = closedQty - openedQty
        const marketOpen = await placeOpen('market', remainder)
        openedQty += marketOpen.outcome.filledQuantity
        openLeg = await openLegReport(marketOpen.placed, marketOpen.outcome)
        open = marketOpen
      }

      if (open.outcome.status === 'rejected' && openedQty <= 0) {
        // Compensate: re-open the OLD contract at market so the user keeps the
        // exposure they had. Rolling can be retried; silent flatness cannot.
        warnings.push('Open leg was rejected — restoring the original position at market.')
        const restorePlaced = await adapter.placeOrder({
          accountId,
          symbol: pos.symbol,
          side: openSide,
          orderType: 'market',
          quantity: closedQty,
          reduceOnly: false,
          label: 'kaibot-roll-restore',
          clientOrderId: input.idempotencyKey ? `${input.idempotencyKey}:restore` : undefined,
        })
        const restoreSettled = await settleAdapterOrder(
          adapter,
          restorePlaced.orderId,
          { symbol: pos.symbol, accountId },
          settleOptions,
        )
        const restore = legOutcome(adapter, restorePlaced, restoreSettled)
        const restoreLeg: RollLegReport = {
          symbol: pos.symbol,
          orderId: restorePlaced.orderId,
          status: restorePlaced.status,
          filledQuantity: restore.filledQuantity,
          averagePrice: restore.averagePrice,
        }
        if (restore.status === 'filled' || restore.status === 'partially_filled') {
          db.addManualPosition(input.exchange, accountId, pos.symbol, openSide, restore.filledQuantity || closedQty)
          db.log('warn', 'trading', 'Roll failed, position restored on old contract', {
            exchange: input.exchange,
            symbol: pos.symbol,
            toSymbol: input.toSymbol,
          })
          return {
            status: 'restored',
            requestedQuantity: quantity,
            rolledQuantity: 0,
            closeLeg,
            openLeg,
            restoreLeg,
            warnings,
          }
        }
        warnings.push(
          'RESTORE FAILED: the old contract was closed and neither the new leg nor the ' +
            'restore filled. You are flat on the closed quantity — re-enter manually.',
        )
        db.log('error', 'trading', 'Roll incomplete: open and restore both failed', {
          exchange: input.exchange,
          symbol: pos.symbol,
          toSymbol: input.toSymbol,
          closedQty,
        })
        return {
          status: 'incomplete',
          requestedQuantity: quantity,
          rolledQuantity: 0,
          closeLeg,
          openLeg,
          restoreLeg,
          warnings,
        }
      }

      if (open.outcome.status === 'unknown') {
        warnings.push(
          'Open leg outcome is unknown — it will be reconciled. Verify the new position before acting.',
        )
      }

      // Track the rolled position like a manual entry so the reconciler never
      // "corrects" it away.
      db.addManualPosition(input.exchange, accountId, input.toSymbol, openSide, openedQty || closedQty)

      db.log('info', 'trading', 'Position rolled', {
        exchange: input.exchange,
        fromSymbol: pos.symbol,
        toSymbol: input.toSymbol,
        side: pos.side,
        quantity: closedQty,
        legOrderType,
        warnings: warnings.length > 0 ? warnings : undefined,
      })

      return {
        status: 'rolled',
        requestedQuantity: quantity,
        rolledQuantity: openedQty || closedQty,
        closeLeg,
        openLeg,
        warnings,
      }
    })
  }

  return { preview, execute }
}

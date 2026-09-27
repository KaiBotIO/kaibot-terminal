// Manual (discretionary) trading, executed ENTIRELY edge-side. The user places
// the order by hand on their own connected exchange — no server signal, no
// server round-trip. `quantity` is a REAL local size (absolute contracts/coins),
// not a server-side factor: the real size never leaves this machine. Reuses the
// same broker-mutating path as the signal pipeline (order lock + settlement) so
// a manual order can't race a signal/reconciler op.
//
// Resilience parity with the signal path (Part D): every manual order is recorded
// in order_settlements (crash recovery via resolveUnknownOrders + reconciler
// known-order-ids), deduped by a caller idempotency key, its position tracked in
// manual_positions (so the reconciler doesn't undo it), and its protective bracket
// persisted for OCO sibling-cancel across a restart.
//
// Order-plan parity with the signal path: an authored entry ladder (resting
// limit rungs, composed by computeDcaEntryLegs) and a reduce-only TP ladder.
// Every add is pre-authorized by the user and rests at the venue — the executor
// never originates an entry on its own.

import type { KaiBotDatabase } from '../storage/database.js'
import type { OrderSettlementRow } from '../storage/types.js'
import type { ExchangeManager } from './exchanges/exchangeManager.js'
import type { OrderResult } from './exchanges/types.js'
import { withOrderLock } from './order-lock.js'
import { computeDcaEntryLegs, computeTotalFractionTpLegs } from './order-ladder.js'
import { settleAdapterOrder, type SettlementResult } from './order-settlement.js'
import { clearStaleAutoLinkOnManualEntry } from './position-groups.js'
import { attributeVenueExit } from './exit-attribution.js'
import {
  ensureContractConstraints,
  getContractConstraints,
} from './exchanges/contract-constraints.js'
import { contractMultiplier } from './exchanges/futures-contracts.js'
import { usdToNativeSize, isInverseContract, type SizeUnit } from '@kaibot/types/core'
import { accountKeyOf } from './exchanges/account-scope.js'
import { checkManualEntryGuards } from './manual-trade-guards.js'

export type ManualOrderType = 'market' | 'limit' | 'stop'

// One authored entry rung. `size` is a weight in the same unit family as
// `quantity` (the legs are normalized so they sum to the resolved total), so a
// UI sending absolute per-rung sizes with quantity = their sum gets exactly
// those sizes back. Only the FIRST rung may omit `price` (market entry); every
// later rung is a resting limit — the user authorizes all adds up front, the
// executor never originates one.
export interface ManualEntryRung {
  price?: number
  size: number
}

// One TP ladder leg: close `fraction` of the TOTAL position at `price`.
// Fractions sum to ≤ 1; a sum < 1 leaves a runner managed by the stop.
export interface ManualTakeProfitLeg {
  price: number
  fraction: number
}

export interface ManualOrderInput {
  exchange: string
  symbol: string
  side: 'buy' | 'sell'
  orderType?: ManualOrderType
  quantity: number // TOTAL size in `sizeUnit` — 'native' = contracts/coin, 'usd' = USD notional
  sizeUnit?: SizeUnit // default 'native'; 'usd' converts to venue-native here
  price?: number // required for limit/stop; also the conversion price for USD-mode limit/stop
  stopLoss?: number // optional protective stop (reduce-only, opposite side)
  takeProfit?: number // optional take-profit (reduce-only, opposite side)
  // Entry ladder — replaces the single entry (omit orderType/price when set).
  // The first rung is the main order; the rest rest as limit adds.
  entries?: ManualEntryRung[]
  // TP ladder — replaces the single takeProfit when set.
  takeProfits?: ManualTakeProfitLeg[]
  accountId?: string // defaults to the first account on the venue
  idempotencyKey?: string // per-submit UUID → dedup a duplicate/retried POST
}

export interface ManualCloseInput {
  exchange: string
  symbol: string
  fraction?: number // 0..1 of the live position; default 1 (full close)
  accountId?: string
  idempotencyKey?: string
}

export interface ManualOrderResult {
  orderId: string
  status: OrderResult['status']
  filledQuantity?: number
  averagePrice?: number
  stopLossOrderId?: string
  takeProfitOrderId?: string // first TP leg (back-compat)
  takeProfitOrderIds?: string[] // full TP ladder
  entryRungOrderIds?: string[] // resting entry rungs after the main order
  // Non-fatal problems the caller must surface (e.g. a protective leg the broker
  // rejected, so the position is NOT actually protected; or a deduped resubmit).
  warnings?: string[]
}

export interface ManualCloseResult {
  orderId: string
  status: OrderResult['status']
  filledQuantity?: number
  averagePrice?: number
  closedQuantity: number
  warnings?: string[]
}

export interface ManualTradeService {
  place(input: ManualOrderInput): Promise<ManualOrderResult>
  close(input: ManualCloseInput): Promise<ManualCloseResult>
}

// Hooks the local executor wires in from the running signal client so a manual
// bracket joins the same OCO tracker as signal brackets. Optional → unit tests
// and headless runs work without them.
export interface ManualTradeDeps {
  userId?: string
  registerBracket?: (
    exchange: string,
    signalId: string,
    slOrderId?: string,
    tpOrderIds?: string[],
    accountId?: string | null,
  ) => void
  retireBracket?: (exchange: string, signalId: string) => Promise<void> | void
  // Cancel + forget resting entry rungs tracked for these ids (signal client's
  // dca_resting_rungs machinery) — called on manual close so a pre-authorized
  // add can't fill into a position that no longer exists.
  cancelEntryRungs?: (exchange: string, signalIds: string[]) => Promise<void> | void
  // Ride hand-over plumbing (services/ride-handover): authenticated server
  // POST, venue-exit report, and the local-close → server hook.
  postToServer?: (path: string, body: unknown) => Promise<{ ok: boolean; status: number; body: any }>
  reportVenueExit?: (
    positionId: string,
    fill: { price: number | null; timeMs: number; orderId?: string | null },
  ) => Promise<void>
  // A venue exit this executor booked itself onto executions (manual close):
  // lets server-managed lineages (ride hand-over) tell the server the ride ended.
  onExitAttributed?: (
    exchange: string,
    allocations: Array<{ signalId: string; qty: number; fullyClosed: boolean }>,
    fill: { price: number | null; timeMs: number; orderId?: string | null },
  ) => Promise<void> | void
  // Adoption of a manual position into a refused entry's lineage
  // (services/adopt-position): the signal client's 'executed' ack and the
  // notification bus.
  ackAdoptedEntry?: (
    signalId: string,
    fill: { price: number | null; time: number },
    stopLossOrderId?: string | null,
  ) => Promise<{ ok: boolean; positionId: string | null }>
  notify?: (event: { type: 'position_adopted'; title: string; body: string; data?: Record<string, unknown> }) => void
}

// Which durable outcome to persist for a placed order. With a broker status
// endpoint the settlement is authoritative; without one the placeOrder result is
// (settleAdapterOrder returns 'timeout' there). 'timeout'/'pending' → leave the
// row 'unknown' so resolveUnknownOrders finishes it on the next reconciler tick.
function terminalSettlementStatus(
  hasStatusEndpoint: boolean,
  settledStatus: SettlementResult['status'],
  placedStatus: OrderResult['status'],
): OrderSettlementRow['status'] | null {
  const src = hasStatusEndpoint ? settledStatus : placedStatus
  if (src === 'filled' || src === 'partially_filled') return 'filled'
  if (src === 'rejected') return 'rejected'
  if (src === 'cancelled') return 'cancelled'
  return null
}

// Validate an authored entry ladder. Exported pure so the rules are unit-
// testable without an adapter.
export function validateManualEntries(input: ManualOrderInput): void {
  const entries = input.entries
  if (!entries || entries.length === 0) return
  if (input.orderType != null || input.price != null) {
    throw new Error('entries replaces the single entry — omit orderType and price')
  }
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (!(Number.isFinite(e.size) && e.size > 0)) {
      throw new Error(`entry rung ${i + 1} needs a positive size`)
    }
    if (e.price == null) {
      // Only the first rung may be a market order; every add rests at the venue.
      if (i > 0) throw new Error(`entry rung ${i + 1} needs a positive limit price`)
    } else if (!(Number.isFinite(e.price) && e.price > 0)) {
      throw new Error(`entry rung ${i + 1} needs a positive limit price`)
    }
  }
}

// Validate an authored TP ladder: positive prices, fractions in (0, 1], and a
// total of at most 100% of the position.
export function validateManualTakeProfits(input: ManualOrderInput): void {
  const tps = input.takeProfits
  if (!tps || tps.length === 0) return
  if (input.takeProfit != null) {
    throw new Error('takeProfits replaces the single takeProfit — omit it')
  }
  let sum = 0
  for (let i = 0; i < tps.length; i++) {
    const tp = tps[i]
    if (!(Number.isFinite(tp.price) && tp.price > 0)) {
      throw new Error(`take-profit leg ${i + 1} needs a positive price`)
    }
    if (!(Number.isFinite(tp.fraction) && tp.fraction > 0 && tp.fraction <= 1)) {
      throw new Error(`take-profit leg ${i + 1} needs a fraction in (0, 1]`)
    }
    sum += tp.fraction
  }
  if (sum > 1 + 1e-9) {
    throw new Error('take-profit fractions sum to more than 100% of the position')
  }
}

// Size-weighted average of the priced rungs — the USD→native conversion anchor
// for a laddered entry (no single order price exists).
function ladderReferencePrice(entries: ManualEntryRung[]): number | undefined {
  let notional = 0
  let size = 0
  for (const e of entries) {
    if (e.price != null && e.price > 0 && e.size > 0) {
      notional += e.price * e.size
      size += e.size
    }
  }
  return size > 0 ? notional / size : undefined
}

function settlementToOrderStatus(s: OrderSettlementRow['status']): OrderResult['status'] {
  switch (s) {
    case 'filled':
      return 'filled'
    case 'rejected':
      return 'rejected'
    case 'cancelled':
    case 'lost':
      return 'cancelled'
    default:
      return 'pending'
  }
}

export function createManualTradeService(
  db: KaiBotDatabase,
  exchangeManager: ExchangeManager,
  deps: ManualTradeDeps = {},
): ManualTradeService {
  const userId = deps.userId ?? 'default'

  async function adapterFor(exchange: string, accountId?: string | null) {
    const session = await exchangeManager.getSession(userId, exchange, accountKeyOf(accountId))
    if (!session || session.status !== 'connected') {
      throw new Error(`exchange ${exchange} not connected`)
    }
    return session.adapter
  }

  // Venues where the broker routes orders by AccountID: picking one silently is
  // wrong when several exist. Crypto adapters ignore order.accountId (the
  // instrument implies the account), so the first-account default stays fine.
  const ACCOUNT_ROUTED_VENUES = new Set(['tradestation', 'interactivebrokers', 'interactive-brokers'])

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
    // The bare broker AccountID — Account.id is the prefixed adapter id
    // ('tradestation:123'), which the broker rejects on an order.
    return accounts[0].accountId
  }

  // Resolve the input size into a venue-native order quantity. 'native' mode
  // passes the size straight through (unchanged legacy behaviour — the user
  // typed a real contract count). 'usd' mode converts a USD notional to native
  // via a price (last/mark for market, the order price for limit/stop), rounds
  // to the contract step and floors at min size so the conversion can't produce
  // an unfillable order.
  async function resolveOrderQuantity(
    adapter: Awaited<ReturnType<typeof adapterFor>>,
    input: ManualOrderInput,
    orderType: ManualOrderType,
    refPrice?: number, // ladder anchor: size-weighted avg of the rung prices
  ): Promise<number> {
    if (input.sizeUnit !== 'usd') return input.quantity

    await ensureContractConstraints(input.exchange, input.symbol)
    const { stepSize, minSize } = getContractConstraints(input.exchange, input.symbol)

    let price: number | undefined =
      orderType === 'market' ? refPrice : input.price ?? refPrice
    if (!isInverseContract(input.exchange, input.symbol) && !(price && price > 0)) {
      price = (await adapter.getLastPrice?.(input.symbol)) ?? undefined
    }
    const r = usdToNativeSize({
      exchange: input.exchange,
      symbol: input.symbol,
      usdNotional: input.quantity,
      // Futures: one contract's notional is price × multiplier (1 outside
      // tradestation) — divide by the per-contract notional, not the price.
      price: price != null ? price * contractMultiplier(input.exchange, input.symbol) : price,
      stepSize,
      minSize,
    })
    if (r.priceMissing) {
      throw new Error('no price available to convert the USD size to contracts')
    }
    if (!(r.size > 0)) {
      throw new Error('resolved order size rounds to zero contracts')
    }
    if (minSize > 0 && r.size < minSize) {
      throw new Error(`resolved order size ${r.size} is below the ${minSize} minimum`)
    }
    return r.size
  }

  async function place(input: ManualOrderInput): Promise<ManualOrderResult> {
    const hasLadder = input.entries != null && input.entries.length > 0
    if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
      throw new Error('quantity must be a positive number')
    }
    validateManualEntries(input)
    validateManualTakeProfits(input)
    const orderType: ManualOrderType = hasLadder
      ? input.entries![0].price != null
        ? 'limit'
        : 'market'
      : input.orderType ?? 'market'
    if (!hasLadder && orderType !== 'market' && !(Number.isFinite(input.price) && (input.price as number) > 0)) {
      throw new Error(`a ${orderType} order needs a positive price`)
    }

    const adapter = await adapterFor(input.exchange, input.accountId)
    const accountId = await resolveAccountId(adapter, input.exchange, input.accountId)
    // Effective venue-native TOTAL size (converts USD-mode, rounds to step,
    // floors at min). Every downstream step — entry legs, brackets, records —
    // is derived from this.
    let quantity = await resolveOrderQuantity(
      adapter,
      input,
      orderType,
      hasLadder ? ladderReferencePrice(input.entries!) : undefined,
    )

    // Same guard path the signal pipeline runs before an open: halt gate,
    // account kill-switch/cap, market-open guard, opt-in daily-loss/
    // concurrency/notional rails and the margin breathing-room guard. A manual
    // order used to skip all of this (readiness review 2026-08-28, gap #2).
    let guardClipNote: string | undefined
    const guard = await checkManualEntryGuards(db, adapter, {
      exchange: input.exchange,
      accountId,
      symbol: input.symbol,
      orderType,
      quantity,
      price: hasLadder ? ladderReferencePrice(input.entries!) : input.price,
    })
    if (!guard.ok) {
      if (guard.dailyLossBreached) {
        // Flatten all + set the halt flag — same enforcement as the signal
        // path's daily-loss trip (imported lazily to avoid a module cycle).
        try {
          const { panicCloseAll } = await import('./panic.js')
          await panicCloseAll(db, exchangeManager, { halt: true, reason: 'daily_loss', userId })
        } catch (flattenErr) {
          db.setHaltState(true, 'daily_loss')
          db.log('error', 'trading', 'Daily-loss flatten failed (manual order trigger), halted anyway', {
            error: flattenErr instanceof Error ? flattenErr.message : String(flattenErr),
          })
        }
      }
      db.log('warn', 'trading', 'Manual order rejected by guard', {
        exchange: input.exchange,
        symbol: input.symbol,
        guard: guard.guard,
        reason: guard.reason,
      })
      throw new Error(`${guard.guard}: ${guard.reason}`)
    }
    if (guard.clipped && guard.quantity !== quantity) {
      guardClipNote = `Quantity clipped to the account-size cap (${guard.quantity}).`
      quantity = guard.quantity
    }

    // Ladder → the signal path's leg composer splits the total across the
    // authored rungs (first leg = the main order, rest = resting limit adds).
    const entryLegs = hasLadder ? computeDcaEntryLegs(quantity, input.entries) : []
    if (hasLadder && entryLegs.length === 0) {
      throw new Error('entry ladder resolves to zero-size legs')
    }
    const mainLeg = entryLegs[0]
    const restingRungs = entryLegs.slice(1)
    const exitSide: 'buy' | 'sell' = input.side === 'buy' ? 'sell' : 'buy'
    const idemId = input.idempotencyKey ? `manual:${input.idempotencyKey}` : undefined

    return withOrderLock(input.exchange, async () => {
      // Idempotency: a duplicate submit with the same key already placed an entry
      // → return the prior outcome instead of a second order. The order lock
      // serializes concurrent submits, so the first writes its settlement row
      // before the second reaches this check.
      if (idemId) {
        const prior = db.getExitSettlement(idemId, 'entry', 'entry')
        if (prior) {
          return {
            orderId: prior.order_id,
            status: settlementToOrderStatus(prior.status),
            warnings: ['Duplicate submit ignored (idempotency key already used).'],
          }
        }
      }

      const entry = await adapter.placeOrder({
        accountId,
        symbol: input.symbol,
        side: input.side,
        orderType,
        quantity: mainLeg ? mainLeg.qty : quantity,
        price: mainLeg ? mainLeg.price : input.price,
        clientOrderId: input.idempotencyKey,
        label: 'kaibot-manual',
      })

      // Durable record keyed on the idempotency key (or the broker order id when
      // none was supplied). Written BEFORE settling: if we crash mid-settle,
      // resolveUnknownOrders re-queries the broker and applies the real outcome
      // (it skips signal bookkeeping — a manual order has no signal_executions
      // row). This id also feeds the reconciler's known-order-ids set.
      const recordId = idemId ?? `manual:${entry.orderId}`
      const settlementId = db.insertOrderSettlement({
        signalId: recordId,
        exchange: input.exchange,
        accountId,
        symbol: input.symbol,
        kind: 'entry',
        side: input.side,
        qty: mainLeg ? mainLeg.qty : quantity,
        orderId: entry.orderId,
        targetLabel: 'entry',
        status: 'unknown',
      })

      const settled = await settleAdapterOrder(adapter, entry.orderId, { symbol: input.symbol, accountId })
      const term = terminalSettlementStatus(!!adapter.getOrderStatus, settled.status, entry.status)
      if (term) db.resolveOrderSettlement(settlementId, term)

      // If the broker rejected the entry, never place protective legs against a
      // position that doesn't exist — return the rejection straight back.
      if (entry.status === 'rejected') {
        if (!term) db.resolveOrderSettlement(settlementId, 'rejected')
        db.log('warn', 'trading', 'Manual entry rejected — no bracket placed', {
          exchange: input.exchange,
          symbol: input.symbol,
          side: input.side,
          orderType,
        })
        return {
          orderId: entry.orderId,
          status: entry.status,
          filledQuantity: entry.filledQuantity,
          averagePrice: entry.averagePrice,
          warnings: ['Order was rejected by the exchange.'],
        }
      }

      // Track the manual position so the reconciler (TS/IB) never mistakes it for
      // netting drift and undoes it. Presence-only marker — cleared on manual
      // close or reconciler auto-heal.
      db.addManualPosition(input.exchange, accountId, input.symbol, input.side, quantity)

      // G0: a manual entry with no live bot execution on the symbol starts
      // Unsorted — clear a leftover AUTO group link from a closed position
      // (an add to a live bot position keeps its group; user picks always stay).
      // Resolve the symbol first so the clear keys on the same resolved contract
      // (e.g. MES→MESZ25) the bot-fill auto-link stored — identity for non-futures.
      // Best-effort: grouping is visibility only and never blocks an order.
      try {
        const linkSymbol = adapter.resolveSymbol
          ? await adapter.resolveSymbol(input.symbol)
          : input.symbol
        clearStaleAutoLinkOnManualEntry(db, { exchange: input.exchange, accountId, symbol: linkSymbol })
      } catch {
        /* ignore */
      }

      // Optional protective bracket: a reduce-only stop and/or take-profit
      // ladder on the opposite side. With an entry ladder the bracket covers
      // the FULL intended size (all rungs); reduce-only clamps each leg to
      // whatever is actually filled, so an unfilled rung never over-closes —
      // same rule as the signal path. These are RESTING orders, so they are
      // NOT run through settleAdapterOrder (its cancel-on-timeout would kill a
      // working order). We only catch an immediate rejection from placeOrder
      // and surface it — a silently-rejected stop leaves the user unprotected.
      const warnings: string[] = guardClipNote ? [guardClipNote] : []
      let stopLossOrderId: string | undefined
      let stopLossLive = false
      if (Number.isFinite(input.stopLoss) && (input.stopLoss as number) > 0) {
        const sl = await adapter.placeOrder({
          accountId,
          symbol: input.symbol,
          side: exitSide,
          orderType: 'stop',
          quantity,
          stopPrice: input.stopLoss,
          reduceOnly: true,
          label: 'kaibot-manual-sl',
        })
        stopLossOrderId = sl.orderId
        stopLossLive = sl.status !== 'rejected'
        if (!stopLossLive) {
          warnings.push('Stop-loss was rejected — the position is NOT protected.')
        }
      }

      // TP legs: the ladder (fraction-of-total) wins; the flat takeProfit stays
      // as a single full-size leg (back-compat).
      const tpLegs =
        input.takeProfits && input.takeProfits.length > 0
          ? computeTotalFractionTpLegs(quantity, input.takeProfits)
          : Number.isFinite(input.takeProfit) && (input.takeProfit as number) > 0
            ? [{ price: input.takeProfit as number, qty: quantity }]
            : []
      const takeProfitOrderIds: string[] = []
      const liveTpOrderIds: string[] = []
      for (let i = 0; i < tpLegs.length; i++) {
        const leg = tpLegs[i]
        const tp = await adapter.placeOrder({
          accountId,
          symbol: input.symbol,
          side: exitSide,
          orderType: 'limit',
          quantity: leg.qty,
          price: leg.price,
          reduceOnly: true,
          label: i === 0 ? 'kaibot-manual-tp' : `kaibot-manual-tp${i + 1}`,
        })
        takeProfitOrderIds.push(tp.orderId)
        if (tp.status === 'rejected') {
          warnings.push(tpLegs.length > 1 ? `Take-profit leg ${i + 1} was rejected.` : 'Take-profit was rejected.')
        } else {
          liveTpOrderIds.push(tp.orderId)
        }
      }

      // Persist + register the bracket so a fill on one leg cancels the sibling
      // (in-session and after a restart), and the reconciler treats the resting
      // legs as known — not as foreign orders.
      if ((stopLossLive && stopLossOrderId) || liveTpOrderIds.length > 0) {
        deps.registerBracket?.(
          input.exchange,
          recordId,
          stopLossLive ? stopLossOrderId : undefined,
          liveTpOrderIds,
          accountId,
        )
      }

      // Place the remaining entry rungs as resting limit adds — pre-authorized
      // by the user, executed by the venue. Placed after the brackets (a failed
      // protective leg never blocks the adds — signal-path ordering). A rung
      // that rests is tracked in dca_resting_rungs so the reconciler sweep
      // settles a fill / drops a terminal order, and cancel-on-close kills it
      // with the position (no ttlBars for manual → cancel-on-close only).
      const entryRungOrderIds: string[] = []
      for (let i = 0; i < restingRungs.length; i++) {
        const rung = restingRungs[i]
        try {
          const rungResult = await adapter.placeOrder({
            accountId,
            symbol: input.symbol,
            side: input.side,
            orderType: 'limit',
            quantity: rung.qty,
            price: rung.price,
            reduceOnly: false,
            label: `kaibot-manual-dca${i + 1}`,
            clientOrderId: input.idempotencyKey ? `${input.idempotencyKey}:dca${i + 1}` : undefined,
          })
          entryRungOrderIds.push(rungResult.orderId)
          if (rungResult.status === 'rejected') {
            warnings.push(`Entry rung ${i + 2} was rejected.`)
          } else if (rungResult.status !== 'filled') {
            db.insertDcaRestingRung({
              orderId: rungResult.orderId,
              signalId: recordId,
              exchange: input.exchange,
              accountId,
              symbol: input.symbol,
              side: input.side,
              qty: rung.qty,
              price: rung.price ?? null,
              expiresAt: null,
            })
            // A partial at placement: pre-book the filled part so the sweep
            // only tracks the resting residual.
            if (rungResult.status === 'partially_filled' && (rungResult.filledQuantity ?? 0) > 0) {
              db.setDcaRestingRungFilledQty(rungResult.orderId, rungResult.filledQuantity as number)
            }
          }
        } catch (err) {
          warnings.push(
            `Entry rung ${i + 2} placement failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }

      db.log('info', 'trading', 'Manual order placed', {
        exchange: input.exchange,
        symbol: input.symbol,
        side: input.side,
        orderType,
        quantity,
        entryRungs: restingRungs.length > 0 ? restingRungs.length : undefined,
        hasStopLoss: stopLossOrderId != null,
        takeProfitLegs: takeProfitOrderIds.length > 0 ? takeProfitOrderIds.length : undefined,
        warnings: warnings.length > 0 ? warnings : undefined,
      })

      return {
        orderId: entry.orderId,
        status: entry.status,
        filledQuantity: entry.filledQuantity,
        averagePrice: entry.averagePrice,
        stopLossOrderId,
        takeProfitOrderId: takeProfitOrderIds[0],
        takeProfitOrderIds: takeProfitOrderIds.length > 0 ? takeProfitOrderIds : undefined,
        entryRungOrderIds: entryRungOrderIds.length > 0 ? entryRungOrderIds : undefined,
        warnings: warnings.length > 0 ? warnings : undefined,
      }
    })
  }

  async function close(input: ManualCloseInput): Promise<ManualCloseResult> {
    const fraction = input.fraction == null ? 1 : input.fraction
    if (!(Number.isFinite(fraction) && fraction > 0 && fraction <= 1)) {
      throw new Error('fraction must be in (0, 1]')
    }

    const adapter = await adapterFor(input.exchange, input.accountId)
    const accountId = await resolveAccountId(adapter, input.exchange, input.accountId)
    const positions = await adapter.getPositions()
    // Account-scoping is only meaningful when it reflects a REAL distinct
    // account: an account-routed venue (TradeStation/IBKR — one session can
    // see multiple real broker sub-accounts in a single getPositions() call,
    // and closing the wrong one can OPEN a reverse position — no reduce-only
    // flag at the venue; vangnet class, cf. the Volcap incident) or the caller
    // explicitly asked for one account. Crypto venues route by SYMBOL, not
    // accountId (the adapter ignores order.accountId — the instrument implies
    // the wallet/session), and resolveAccountId's arbitrary accounts[0] pick
    // (Deribit: always its first synthetic currency wallet, e.g. 'btc') must
    // never gate which position a close finds there — that broke every
    // non-first-wallet manual close on a live multi-wallet Deribit connection.
    const enforceAccountScope =
      ACCOUNT_ROUTED_VENUES.has(input.exchange.toLowerCase()) || input.accountId != null
    const pos = positions.find(
      (p) =>
        p.symbol === input.symbol &&
        Math.abs(p.size) > 0 &&
        (!enforceAccountScope || !p.accountId || p.accountId === accountId),
    )
    if (!pos) {
      throw new Error(
        `no open position for ${input.symbol}${enforceAccountScope ? ` on account ${accountId}` : ''}`,
      )
    }
    // Same gating for the bracket/trail lookups below: pass the resolved
    // accountId only when it's a real, meaningful account — otherwise stay
    // unscoped (symbol-only), matching the pre-existing (safe, single-session)
    // crypto behaviour instead of filtering on an arbitrary guess.
    const scopedAccountId = enforceAccountScope ? accountId : undefined

    const qty = Math.abs(pos.size) * fraction
    const closeSide: 'buy' | 'sell' = pos.side === 'long' ? 'sell' : 'buy'
    const idemId = input.idempotencyKey ? `manual-close:${input.idempotencyKey}` : undefined

    return withOrderLock(input.exchange, async () => {
      if (idemId) {
        const prior = db.getExitSettlement(idemId, 'exit', 'close')
        if (prior) {
          return {
            orderId: prior.order_id,
            status: settlementToOrderStatus(prior.status),
            closedQuantity: qty,
            warnings: ['Duplicate close ignored (idempotency key already used).'],
          }
        }
      }

      // Cancel any resting manual bracket legs AND entry rungs on this symbol
      // before flattening, so a stop/TP can't fire against a position we're
      // closing (double exit) and a pre-authorized add can't fill into a
      // position that no longer exists.
      const manualIds = db.listManualEntrySignalIds(input.exchange, input.symbol, scopedAccountId)
      for (const sid of manualIds) {
        await deps.retireBracket?.(input.exchange, sid)
      }
      if (manualIds.length > 0) {
        await deps.cancelEntryRungs?.(input.exchange, manualIds)
      }

      // A FULL close also retires any edge trail on the position: cancel the
      // trail-owned stop (it may live outside the brackets retired above) and
      // deactivate the row, so a resting stop can't orphan/double-exit. Scoped
      // to this account — a same-symbol trail on another account protects a
      // DIFFERENT position and must be left alone.
      if (fraction === 1) {
        for (const trail of db.findActiveTrailsForSymbol(input.exchange, input.symbol, scopedAccountId)) {
          if (trail.sl_order_id) {
            try {
              await adapter.cancelOrder(trail.sl_order_id, { symbol: input.symbol })
            } catch {
              // Already cancelled via the bracket retire above, or already gone.
            }
          }
          db.deactivateLocalTrail(trail.signal_id)
        }
      }

      const result = await adapter.placeOrder({
        accountId,
        symbol: input.symbol,
        side: closeSide,
        orderType: 'market',
        quantity: qty,
        reduceOnly: true,
        clientOrderId: input.idempotencyKey,
        label: 'kaibot-manual-close',
      })

      const recordId = idemId ?? `manual-close:${result.orderId}`
      const settlementId = db.insertOrderSettlement({
        signalId: recordId,
        exchange: input.exchange,
        accountId,
        symbol: input.symbol,
        kind: 'exit',
        side: closeSide,
        qty,
        orderId: result.orderId,
        targetLabel: 'close',
        status: 'unknown',
      })

      const settled = await settleAdapterOrder(adapter, result.orderId, { symbol: input.symbol, accountId })
      const term = terminalSettlementStatus(!!adapter.getOrderStatus, settled.status, result.status)
      if (term) db.resolveOrderSettlement(settlementId, term)

      // A manual close on a BOT position is still that bot's exit: book it onto
      // the executions holding the position, or their trade is realized at the
      // venue and unpriced in the ledger forever (no exit fill = no P&L).
      // No-op on a purely manual position — nothing tracks it.
      if (term === 'filled') {
        // An adapter without getOrderStatus settles as 'timeout' and the
        // placeOrder result is the authoritative outcome (same rule
        // terminalSettlementStatus applies) — read price/qty from whichever
        // actually carries them.
        const filledQty =
          settled.filledQuantity && settled.filledQuantity > 0
            ? settled.filledQuantity
            : result.filledQuantity && result.filledQuantity > 0
              ? result.filledQuantity
              : qty
        const booked = attributeVenueExit(db, {
          exchange: input.exchange,
          accountId,
          symbol: input.symbol,
          side: closeSide,
          qty: filledQty,
          price: settled.averagePrice ?? result.averagePrice ?? null,
          orderId: result.orderId,
          reason: 'closed by manual close',
        })
        if (booked.length > 0) {
          db.log('info', 'trading', 'Manual close booked against bot executions', {
            exchange: input.exchange,
            symbol: input.symbol,
            orderId: result.orderId,
            attributed: booked.map((b) => ({ signalId: b.signalId, qty: b.qty })),
          })
          try {
            await deps.onExitAttributed?.(input.exchange, booked, {
              price: settled.averagePrice ?? result.averagePrice ?? null,
              timeMs: Date.now(),
              orderId: result.orderId,
            })
          } catch (err: any) {
            db.log('warn', 'trading', 'Post-close hook failed', { error: err?.message })
          }
        }
      }

      // Move the manual marker toward flat by the closed qty (no-op if this was a
      // signal/taken-over position with no manual marker).
      db.reduceManualPosition(input.exchange, accountId, input.symbol, qty)

      db.log('info', 'trading', 'Manual close', {
        exchange: input.exchange,
        symbol: input.symbol,
        fraction,
        quantity: qty,
      })

      return {
        orderId: result.orderId,
        status: result.status,
        filledQuantity: result.filledQuantity,
        averagePrice: result.averagePrice,
        closedQuantity: qty,
      }
    })
  }

  return { place, close }
}

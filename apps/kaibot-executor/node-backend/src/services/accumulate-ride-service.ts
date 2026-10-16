// Accumulate & ride: the executor side of the plan (see accumulate-ride.ts
// for the phase machine).
//
// Why here and not as a server strategy: the rung and start sizes are a
// percentage of the coins the user holds (the armed synthetic's holdings at
// the venue mark), and real sizes never leave this machine (INV11). The exit
// stays server-side: the plan hands the position to a tf-ride bot through the
// existing hand-over, so the ride's trailing/L1/disaster rules decide the
// exit exactly as for any other handed-over position.
//
// Rungs reuse the dca_resting_rungs machinery: its sweep books a fill into the
// execution named by the row's signal id (the ride's entry once handed over),
// and cancel-on-close retires the rungs with the position. The plan only
// records which rungs it owns and resizes the ride's venue stop when a fill
// grows the position.
//
// Restart safety: every decision is persisted as `pending` before its first
// action and every action is idempotent (deterministic order labels, ride
// lookup before a hand-over), so an interrupted decision simply replays.

import { createHash, randomUUID } from 'node:crypto'
import type { KaiBotDatabase } from '../storage/database.js'
import type { ExchangeManager } from './exchanges/exchangeManager.js'
import type { ExchangeAdapter, Position } from './exchanges/types.js'
import { accountKeyOf } from './exchanges/account-scope.js'
import { ensureContractConstraints, getContractConstraints } from './exchanges/contract-constraints.js'
import { isInverseContract } from '@kaibot/types/core'
import {
  DEFAULT_ACCUMULATE_PARAMS,
  barStart,
  closedBars,
  computeLadder,
  decide,
  localExtreme,
  rearmBlock,
  rideStopFor,
  sizeForUsd,
  validateAccumulateParams,
  type AccumulateAction,
  type AccumulateParams,
  type Bar,
  type Direction,
  type InstrumentSpec,
  type PlanCore,
} from './accumulate-ride.js'
import {
  createAccumulateStore,
  pendingOf,
  planCore,
  planParams,
  type AccumulatePlanRow,
  type AccumulateRungRow,
  type PendingDecision,
} from './accumulate-ride-store.js'
import { activeRideFor, listActiveRides } from './ride-state.js'
import { OldStopKeptError, isProtectiveStop, replaceServerExitStop, serverExitEffectiveStop } from './server-exit-stop.js'
import { withOrderLock } from './order-lock.js'
import { TrancheStopFilledError, TrancheUnsupportedError, type HandoverRequest, type HandoverResult } from './ride-handover.js'
import type { NotificationEvent } from './notifications/notification-bus.js'

// Deribit price ticks; other instruments ask the adapter.
const STATIC_TICKS: Record<string, number> = {
  'deribit:btc-perpetual': 0.5,
  'deribit:eth-perpetual': 0.05,
}

export const ACCUMULATE_LABEL_PREFIX = 'acr'
// Rungs placed before a hand-over belong to no execution: the manual prefix
// keeps the sweep from writing their real size into signal_fills.
const PRE_RIDE_SIGNAL_PREFIX = 'manual:accum:'

export type RearmParamsPatch = Partial<Pick<AccumulateParams, 'rearm' | 'maxTranches' | 'rearmCooldownBars'>>

export interface AccumulateDeps {
  userId?: string
  handover: (req: HandoverRequest) => Promise<HandoverResult>
  // Manual market entry (manual-trade place): books the marker + settlement.
  placeMarket: (input: {
    exchange: string
    symbol: string
    side: 'buy' | 'sell'
    quantity: number
    accountId: string
    idempotencyKey: string
  }) => Promise<{ status: string; filledQuantity?: number; averagePrice?: number; warnings?: string[] }>
  // Signal client: cancel + forget resting rungs for these signal ids, booking
  // any partial fill first (verify-before-drop).
  cancelEntryRungs: (exchange: string, signalIds: string[]) => Promise<void> | void
  now?: () => number
  notify?: (event: NotificationEvent) => void
}

export interface CreatePlanInput {
  exchange: string
  symbol: string
  accountId: string
  rideBotId: string
  params?: Partial<AccumulateParams>
  // Long when there is no position to read it from.
  direction?: Direction
  // Ladder reference; defaults to the position's average entry.
  reference?: number
  // When the position was opened (drives the entry bar); defaults to the
  // manual marker's first fill, else now.
  openedAt?: number
  // Take ownership of the rungs already resting on this market (default on).
  adoptRungs?: boolean
}

export interface PlanStatus {
  id: string
  exchange: string
  accountId: string
  symbol: string
  direction: Direction
  rideBotId: string
  params: AccumulateParams
  phase: AccumulatePlanRow['phase']
  reference: number
  entryBarTime: number
  localLevel: number | null
  // The level the next root close has to beat.
  watchLevel: number | null
  basisUsd: number | null
  position: { qty: number; entryPrice: number | null; mark: number | null } | null
  ride: { positionId: string; currentStop: number | null; botId: string | null; botName: string | null } | null
  rungs: {
    open: number
    filled: number
    openQty: number
    filledQty: number
    list: Array<Pick<AccumulateRungRow, 'order_id' | 'idx' | 'price' | 'qty' | 'state' | 'filled_qty' | 'ladder_seq' | 'adopted'>>
  }
  // The armed synthetic on this instrument: the floor under the plan.
  floor: { status: string; triggerPrice: number | null; holdingsCoin: number | null; shortSize: number } | null
  pending: boolean
  // Reduce-only stop the floor settle placed for fills nobody rides.
  floorStopOrderId: string | null
  lastNote: string | null
  lastError: string | null
  lastBreakout: { barTime: number; close: number; level: number } | null
  parentPlanId: string | null
  trancheIndex: number
  // Rides open on this market (all tranches).
  openTranches: number
  // This plan's own ride position, from its execution (null before a hand-over).
  tranche: { qty: number; entryPrice: number | null; stop: number | null; pnlUsd: number | null } | null
  createdAt: number
  updatedAt: number
}

export function createAccumulateService(db: KaiBotDatabase, exchangeManager: ExchangeManager, deps: AccumulateDeps) {
  const store = createAccumulateStore(db)
  const userId = deps.userId ?? 'default'
  const now = () => (deps.now ? deps.now() : Date.now())
  // Last level each plan watched (status only, not persisted).
  const watchLevels = new Map<string, number | null>()
  // Last closed bar per market (status P&L only, not persisted).
  const lastCloses = new Map<string, number>()
  const marketKey = (exchange: string, accountId: string, symbol: string) =>
    `${exchange}|${accountId}|${symbol.toUpperCase()}`
  const running = new Set<string>()

  async function adapterFor(exchange: string, accountId: string): Promise<ExchangeAdapter> {
    const session = await exchangeManager.getSession(userId, exchange, accountKeyOf(accountId))
    if (!session || session.status !== 'connected') throw new Error(`exchange ${exchange} not connected`)
    return session.adapter
  }

  async function specFor(adapter: ExchangeAdapter, exchange: string, symbol: string): Promise<InstrumentSpec> {
    await ensureContractConstraints(exchange, symbol)
    const c = getContractConstraints(exchange, symbol)
    const key = `${exchange.toLowerCase()}:${symbol.toLowerCase()}`
    const tick = STATIC_TICKS[key] ?? (adapter.getTickSize ? await adapter.getTickSize(symbol) : null)
    if (!(c.stepSize > 0) || !(tick && tick > 0)) throw new Error(`no contract step or tick size for ${symbol}`)
    return { stepSize: c.stepSize, minSize: c.minSize, tickSize: tick, inverse: isInverseContract(exchange, symbol) }
  }

  function syntheticRow(exchange: string, accountId: string, symbol: string) {
    return (
      db
        .listSyntheticUsdPositions(true)
        .find(
          (r) =>
            r.exchange === exchange &&
            r.account_id === accountId &&
            r.symbol.toUpperCase() === symbol.toUpperCase() &&
            r.status !== 'closed',
        ) ?? null
    )
  }

  // The synthetic short on the same instrument nets the venue position.
  function syntheticShort(exchange: string, accountId: string, symbol: string): number {
    const row = syntheticRow(exchange, accountId, symbol)
    return row && row.status !== 'armed' ? Math.max(0, row.short_size || 0) : 0
  }

  // Basis = the coins the armed synthetic protects, at the venue mark. Falls
  // back to the account's coin equity for accounts without a synthetic row.
  async function basisUsd(adapter: ExchangeAdapter, exchange: string, accountId: string, symbol: string, mark: number) {
    const row = syntheticRow(exchange, accountId, symbol)
    const coins = row?.arm_holdings_coin
    if (coins && coins > 0) return coins * mark
    const balances = await adapter.getBalances()
    const bal = balances.find((b) => b.accountId === accountId)
    if (!bal) throw new Error(`no balance for account ${accountId}`)
    const cur = (bal.currency ?? '').toUpperCase()
    const usdLike = cur === 'USD' || cur === 'USDC' || cur === 'USDT'
    const equity = bal.equity ?? 0
    if (!(equity > 0)) throw new Error(`account ${accountId} has no equity to size from`)
    return usdLike ? equity : equity * mark
  }

  async function markOf(adapter: ExchangeAdapter, symbol: string, fallback?: number | null): Promise<number> {
    const p = adapter.getLastPrice ? await adapter.getLastPrice(symbol) : null
    const mark = p && p > 0 ? p : fallback ?? null
    if (!(mark && mark > 0)) throw new Error(`no price for ${symbol}`)
    return mark
  }

  async function livePosition(adapter: ExchangeAdapter, accountId: string, symbol: string): Promise<Position | null> {
    const positions = await adapter.getPositions()
    return (
      positions.find(
        (p) =>
          p.symbol.toUpperCase() === symbol.toUpperCase() &&
          Math.abs(p.size) > 0 &&
          (!p.accountId || p.accountId === accountId),
      ) ?? null
    )
  }

  // Directional size of the plan's side, with a synthetic short added back.
  function directionalQty(pos: Position | null, direction: Direction, synthShort: number): number {
    const signed = pos ? (pos.side === 'long' ? Math.abs(pos.size) : -Math.abs(pos.size)) : 0
    const directional = direction === 'long' ? signed + synthShort : -signed
    return Math.max(0, directional)
  }

  async function fetchBars(adapter: ExchangeAdapter, symbol: string, params: AccumulateParams, fromMs: number): Promise<Bar[]> {
    if (!adapter.getCandles) throw new Error('this venue has no candle feed for breakout detection')
    return adapter.getCandles(symbol, params.barMinutes, fromMs, now())
  }

  function label(plan: AccumulatePlanRow, seq: number, part: string | number): string {
    return `${ACCUMULATE_LABEL_PREFIX}-${plan.id.slice(0, 8)}-${seq}-${part}`
  }

  function rungSignalId(plan: AccumulatePlanRow): string {
    return plan.ride_entry_signal_id ?? `${PRE_RIDE_SIGNAL_PREFIX}${plan.id}`
  }

  function logEvent(level: 'info' | 'warn' | 'error', message: string, plan: AccumulatePlanRow, extra: Record<string, unknown> = {}) {
    db.log(level, 'trading', message, {
      planId: plan.id,
      exchange: plan.exchange,
      accountId: plan.account_id,
      symbol: plan.symbol,
      phase: plan.phase,
      ...extra,
    })
  }

  // ── rung bookkeeping ──────────────────────────────────────────────────

  // Settle the plan's open rungs against the resting-rung table: a row that is
  // gone was filled or cancelled; ask the venue which.
  async function syncRungs(plan: AccumulatePlanRow, adapter: ExchangeAdapter): Promise<void> {
    for (const r of store.rungs(plan.id, 'open')) {
      const resting = db.get('SELECT filled_qty FROM dca_resting_rungs WHERE order_id = ?', [r.order_id]) as
        | { filled_qty: number | null }
        | undefined
      if (resting) {
        if ((resting.filled_qty ?? 0) !== r.filled_qty) store.setRungState(r.order_id, 'open', resting.filled_qty ?? 0)
        continue
      }
      if (!adapter.getOrderStatus) continue
      try {
        const st = await adapter.getOrderStatus(r.order_id, { accountId: plan.account_id, symbol: plan.symbol })
        const filled = st.filledQuantity && st.filledQuantity > 0 ? st.filledQuantity : 0
        if (st.state === 'filled') store.setRungState(r.order_id, 'filled', filled || r.qty)
        else if (st.state === 'cancelled' || st.state === 'rejected') {
          store.setRungState(r.order_id, filled > 0 ? 'filled' : 'cancelled', filled)
        }
      } catch {
        /* next tick */
      }
    }
  }

  async function cancelRungs(plan: AccumulatePlanRow, adapter: ExchangeAdapter): Promise<void> {
    const open = store.rungs(plan.id, 'open')
    if (open.length === 0) return
    const signalIds = new Set<string>()
    for (const r of open) {
      const row = db.get('SELECT signal_id FROM dca_resting_rungs WHERE order_id = ?', [r.order_id]) as
        | { signal_id: string }
        | undefined
      if (row) signalIds.add(row.signal_id)
    }
    if (signalIds.size > 0) await deps.cancelEntryRungs(plan.exchange, [...signalIds])
    await syncRungs(plan, adapter)
    const left = open.filter((r) => db.get('SELECT 1 AS x FROM dca_resting_rungs WHERE order_id = ?', [r.order_id]))
    if (left.length > 0) throw new Error(`${left.length} rung(s) could not be cancelled yet`)
    const unsure = await confirmGoneRungs(plan, adapter, store.rungs(plan.id, 'open'))
    if (unsure > 0) throw new Error(`${unsure} rung(s) not confirmed cancelled or filled yet`)
  }

  type VenueOrderState = Awaited<ReturnType<NonNullable<ExchangeAdapter['getOrderStatus']>>>

  // Deribit's order lookup forgets an order 30 min after it closed and then
  // answers a confirmed absence: its trades say whether it filled before
  // anyone reads it as never filled. A failed trade lookup proves nothing.
  async function resolveAbsent(adapter: ExchangeAdapter, plan: AccumulatePlanRow, st: VenueOrderState): Promise<VenueOrderState> {
    if (st.state !== 'unknown' || !st.absenceConfirmed || !adapter.getOrderFills) return st
    try {
      const { filledQuantity } = await adapter.getOrderFills(st.orderId, { accountId: plan.account_id, symbol: plan.symbol })
      return filledQuantity > 0 ? { orderId: st.orderId, state: 'filled', filledQuantity } : st
    } catch {
      return { orderId: st.orderId, state: 'unknown', absenceConfirmed: false }
    }
  }

  async function orderOutcome(adapter: ExchangeAdapter, plan: AccumulatePlanRow, orderId: string): Promise<VenueOrderState> {
    const st = await adapter.getOrderStatus!(orderId, { accountId: plan.account_id, symbol: plan.symbol })
    return resolveAbsent(adapter, plan, st)
  }

  // Rungs gone from the tracked book: the venue says whether each one filled.
  // A fill that landed in the race with its cancel must never read as open or
  // cancelled. Returns how many are still live or unanswered (retry).
  async function confirmGoneRungs(plan: AccumulatePlanRow, adapter: ExchangeAdapter, rows: AccumulateRungRow[]): Promise<number> {
    let unsure = 0
    for (const r of rows) {
      if (db.get('SELECT 1 AS x FROM dca_resting_rungs WHERE order_id = ?', [r.order_id])) {
        unsure++
        continue
      }
      if (!adapter.getOrderStatus) {
        if (r.state === 'open') store.setRungState(r.order_id, 'cancelled', r.filled_qty)
        continue
      }
      let st: VenueOrderState
      try {
        st = await orderOutcome(adapter, plan, r.order_id)
      } catch {
        unsure++
        continue
      }
      const filled = Math.max(r.filled_qty, st.filledQuantity && st.filledQuantity > 0 ? st.filledQuantity : 0)
      if (st.state === 'filled') store.setRungState(r.order_id, 'filled', filled || r.qty)
      else if (st.state === 'working' || st.state === 'partially_filled') {
        // Still resting untracked: pull it, the next pass reads the outcome.
        try {
          await adapter.cancelOrder(r.order_id, { accountId: plan.account_id, symbol: plan.symbol })
        } catch {
          /* next pass */
        }
        unsure++
      }
      // A failed lookup says nothing, not even that a booked partial is all of
      // it: only a confirmed absence settles the rung.
      else if (st.state === 'unknown' && !st.absenceConfirmed) unsure++
      else if (filled > 0) store.setRungState(r.order_id, 'filled', filled)
      else store.setRungState(r.order_id, 'cancelled', 0)
    }
    return unsure
  }

  async function placeLadder(plan: AccumulatePlanRow, adapter: ExchangeAdapter, reference: number): Promise<void> {
    const params = planParams(plan)
    const spec = await specFor(adapter, plan.exchange, plan.symbol)
    const mark = await markOf(adapter, plan.symbol, reference)
    const basis = await basisUsd(adapter, plan.exchange, plan.account_id, plan.symbol, mark)
    store.update(plan.id, { basis_usd: basis })
    const ladder = computeLadder({ reference, basisUsd: basis, direction: plan.direction, params, spec })
    const side: 'buy' | 'sell' = plan.direction === 'long' ? 'buy' : 'sell'
    const signalId = rungSignalId(plan)
    for (const rung of ladder) {
      const res = await adapter.placeOrder({
        accountId: plan.account_id,
        symbol: plan.symbol,
        side,
        orderType: 'limit',
        quantity: rung.qty,
        price: rung.price,
        reduceOnly: false,
        clientOrderId: label(plan, plan.ladder_seq, rung.idx),
      })
      if (res.status === 'rejected') {
        logEvent('warn', 'Accumulate rung rejected', plan, { idx: rung.idx, price: rung.price, reason: res.message })
        continue
      }
      const filledNow = res.status === 'filled' ? res.filledQuantity || rung.qty : 0
      if (filledNow > 0) {
        // Filled at placement (the market gapped through the level): book it
        // straight into the ride, like the signal path's DCA adds.
        if (plan.ride_entry_signal_id) {
          db.insertSignalFill({
            signalId,
            kind: 'entry',
            symbol: plan.symbol,
            side,
            qty: filledNow,
            price: res.averagePrice ?? rung.price,
            orderId: res.orderId,
          })
          const exec = db.getSignalExecution(signalId)
          if (exec) db.updateSignalExecution(signalId, { qtyOpened: exec.qty_opened + filledNow })
        }
        store.upsertRung({
          order_id: res.orderId, plan_id: plan.id, ladder_seq: plan.ladder_seq, idx: rung.idx,
          price: rung.price, qty: rung.qty, state: 'filled', filled_qty: filledNow, adopted: 0,
        })
        continue
      }
      // A replay returns the same order: keep the sweep's booked partials.
      if (!db.get('SELECT 1 AS x FROM dca_resting_rungs WHERE order_id = ?', [res.orderId])) {
        db.insertDcaRestingRung({
          orderId: res.orderId,
          signalId,
          exchange: plan.exchange,
          accountId: plan.account_id,
          symbol: plan.symbol,
          side,
          qty: rung.qty,
          price: rung.price,
          expiresAt: null,
        })
        if (res.status === 'partially_filled' && (res.filledQuantity ?? 0) > 0) {
          db.setDcaRestingRungFilledQty(res.orderId, res.filledQuantity as number)
        }
      }
      store.upsertRung({
        order_id: res.orderId, plan_id: plan.id, ladder_seq: plan.ladder_seq, idx: rung.idx,
        price: rung.price, qty: rung.qty, state: 'open', filled_qty: res.filledQuantity ?? 0, adopted: 0,
      })
    }
    logEvent('info', 'Accumulate ladder placed', plan, { reference, rungs: ladder.length, basisUsd: basis, seq: plan.ladder_seq })
  }

  async function marketEntry(plan: AccumulatePlanRow, adapter: ExchangeAdapter): Promise<void> {
    const params = planParams(plan)
    const spec = await specFor(adapter, plan.exchange, plan.symbol)
    const mark = await markOf(adapter, plan.symbol)
    const basis = await basisUsd(adapter, plan.exchange, plan.account_id, plan.symbol, mark)
    const qty = sizeForUsd((basis * params.startPct) / 100, mark, spec)
    if (!(qty > 0)) throw new Error('the start size rounds to zero contracts')
    const res = await deps.placeMarket({
      exchange: plan.exchange,
      symbol: plan.symbol,
      side: plan.direction === 'long' ? 'buy' : 'sell',
      quantity: qty,
      accountId: plan.account_id,
      idempotencyKey: label(plan, plan.ladder_seq, 'entry'),
    })
    if (res.status === 'rejected') throw new Error('the venue rejected the re-entry')
    store.update(plan.id, {
      basis_usd: basis,
      entry_fill_qty: res.filledQuantity && res.filledQuantity > 0 ? res.filledQuantity : qty,
      entry_fill_price: res.averagePrice && res.averagePrice > 0 ? res.averagePrice : mark,
    })
    logEvent('warn', 'Accumulate re-entry placed', plan, { qty, mark, basisUsd: basis, status: res.status })
  }

  // Rides on the market that belong to another plan (or to no plan at all).
  // Rides other plans on this market own (tranches). A ride no plan owns is not
  // foreign: an interrupted hand-over of this plan finds its own ride there.
  function foreignRides(plan: AccumulatePlanRow) {
    const owned = new Set(
      store
        .forMarket(plan.exchange, plan.account_id, plan.symbol)
        .filter((p) => p.id !== plan.id && p.ride_position_id)
        .map((p) => p.ride_position_id!),
    )
    return listActiveRides(db).filter(
      (r) =>
        r.exchange === plan.exchange &&
        r.symbol.toUpperCase() === plan.symbol.toUpperCase() &&
        (r.accountId == null || r.accountId === plan.account_id) &&
        r.positionId !== plan.ride_position_id &&
        owned.has(r.positionId),
    )
  }

  // What this plan bought itself since its last ride: the rungs it filled
  // before ever riding plus its market entry. Average in the contract's terms
  // (inverse: harmonic).
  function ownTranche(plan: AccumulatePlanRow, inverse: boolean): { qty: number; price: number } | null {
    const parts: Array<{ qty: number; price: number }> = []
    if (plan.ride_ended_at == null) {
      for (const r of store.rungs(plan.id, 'filled')) if (r.filled_qty > 0) parts.push({ qty: r.filled_qty, price: r.price })
    }
    if (plan.entry_fill_qty && plan.entry_fill_qty > 0 && plan.entry_fill_price) {
      parts.push({ qty: plan.entry_fill_qty, price: plan.entry_fill_price })
    }
    const qty = parts.reduce((a, p) => a + p.qty, 0)
    if (!(qty > 0)) return null
    const price = inverse
      ? qty / parts.reduce((a, p) => a + p.qty / p.price, 0)
      : parts.reduce((a, p) => a + p.qty * p.price, 0) / qty
    return { qty, price }
  }

  // A tranche's ride stop sits under its own average, at least one step.
  function trancheStopPrice(direction: Direction, avg: number, anchor: number, params: AccumulateParams, spec: InstrumentSpec): number {
    const step = (avg * params.rungStepPct) / 100
    const ruleStop = rideStopFor(anchor, direction, params, spec)
    const floor = direction === 'long' ? avg - step : avg + step
    const raw = direction === 'long' ? Math.min(ruleStop, floor) : Math.max(ruleStop, floor)
    return direction === 'long'
      ? Math.floor(raw / spec.tickSize + 1e-9) * spec.tickSize
      : Math.ceil(raw / spec.tickSize - 1e-9) * spec.tickSize
  }

  function trancheKey(plan: AccumulatePlanRow): string {
    return createHash('sha256').update(`accumulate|${plan.id}|${plan.ladder_seq}`).digest('hex').slice(0, 24)
  }

  async function handOver(plan: AccumulatePlanRow, adapter: ExchangeAdapter, anchor: number): Promise<void> {
    const params = planParams(plan)
    // Tranche mode follows the market, never the flag: with another plan's
    // ride open, adopting "the" ride would take over that tranche.
    const others = foreignRides(plan)
    if (others.length > 0) return handOverTranche(plan, adapter, anchor, params)
    const existing = activeRideFor(db, plan.exchange, plan.account_id, plan.symbol)
    if (existing) {
      store.update(plan.id, { ride_position_id: existing.positionId, ride_entry_signal_id: existing.entrySignalId })
      return
    }
    const spec = await specFor(adapter, plan.exchange, plan.symbol)
    const result = await deps.handover({
      exchange: plan.exchange,
      symbol: plan.symbol,
      accountId: plan.account_id,
      botId: plan.ride_bot_id,
      stopPrice: rideStopFor(anchor, plan.direction, params, spec),
      anchor,
      ladderFrom: 'now',
      openedAt: new Date(now()),
    })
    const exec = db.getSignalExecution(result.entrySignalId)
    store.update(plan.id, {
      ride_position_id: result.positionId,
      ride_entry_signal_id: result.entrySignalId,
      stop_sized_qty: exec ? exec.qty_opened - exec.qty_closed : null,
    })
    logEvent('warn', 'Accumulate position handed over to the ride', plan, {
      positionId: result.positionId,
      stop: result.stop.price,
      anchor,
    })
  }

  // Another ride already holds part of the venue position: only what this plan
  // bought becomes its ride, with its own stop and server row.
  async function handOverTranche(
    plan: AccumulatePlanRow,
    adapter: ExchangeAdapter,
    anchor: number,
    params: AccumulateParams,
  ): Promise<void> {
    const spec = await specFor(adapter, plan.exchange, plan.symbol)
    const own = ownTranche(plan, spec.inverse)
    if (!own) throw new Error('this tranche holds nothing to hand over')
    const stopPrice = trancheStopPrice(plan.direction, own.price, anchor, params, spec)
    let result: HandoverResult
    try {
      result = await deps.handover({
        exchange: plan.exchange,
        symbol: plan.symbol,
        accountId: plan.account_id,
        botId: plan.ride_bot_id,
        stopPrice: Number(stopPrice.toFixed(10)),
        anchor,
        ladderFrom: 'now',
        openedAt: new Date(now()),
        tranche: {
          key: trancheKey(plan),
          quantity: own.qty,
          entryPrice: own.price,
          stopClientOrderId: label(plan, plan.ladder_seq, 'sl'),
          keepStopOrderId: plan.tranche_stop_order_id,
          foreignPositionIds: foreignRides(plan).map((r) => r.positionId),
        },
      })
    } catch (err) {
      if (err instanceof TrancheStopFilledError && !stopAlerted.has(`filled:${plan.id}`)) {
        stopAlerted.add(`filled:${plan.id}`)
        deps.notify?.({
          type: 'error',
          title: 'Accumulate tranche stop filled before its hand-over',
          body: `${plan.symbol} tranche ${plan.tranche_index}: its kept stop ${err.slOrderId} filled while the server had not taken the hand-over. Not handed over; check the position and stop the plan.`,
          timestamp: new Date(now()).toISOString(),
          data: { planId: plan.id, slOrderId: err.slOrderId },
        })
      }
      if (err instanceof TrancheUnsupportedError && err.slOrderId && err.slOrderId !== plan.tranche_stop_order_id) {
        store.update(plan.id, { tranche_stop_order_id: err.slOrderId })
        deps.notify?.({
          type: 'error',
          title: 'Accumulate tranche not handed over',
          body:
            err.kind === 'server'
              ? `${plan.symbol} tranche ${plan.tranche_index}: the server did not take the hand-over (${err.message}). Its entry holds its own stop at the venue; retried every minute.`
              : `${plan.symbol} tranche ${plan.tranche_index}: the server does not know tranches yet. Its entry holds its own stop at the venue until the API is updated.`,
          timestamp: new Date(now()).toISOString(),
          data: { planId: plan.id, slOrderId: err.slOrderId },
        })
      }
      throw err
    }
    const exec = db.getSignalExecution(result.entrySignalId)
    store.update(plan.id, {
      ride_position_id: result.positionId,
      ride_entry_signal_id: result.entrySignalId,
      stop_sized_qty: exec ? exec.qty_opened - exec.qty_closed : null,
      tranche_stop_order_id: null,
    })
    logEvent('warn', 'Accumulate tranche handed over to its own ride', plan, {
      positionId: result.positionId,
      stop: result.stop.price,
      qty: own.qty,
      avg: own.price,
      anchor,
      tranche: plan.tranche_index,
    })
    // While this tranche was armed its rung fills sat on the venue without an
    // execution, so a sibling's trail update may have sized its stop to them.
    for (const sibling of store.forMarket(plan.exchange, plan.account_id, plan.symbol)) {
      if (sibling.id === plan.id || sibling.phase !== 'riding') continue
      if (hasOrphanStops(plan.exchange, plan.account_id, plan.symbol)) break
      await fitSiblingStop(sibling, adapter)
    }
  }

  // Plans whose stop needs another try next tick (sibling fit failed).
  const stopRetry = new Set<string>()
  const stopAlerted = new Set<string>()

  function stopTrouble(plan: AccumulatePlanRow, message: string, err: unknown): void {
    stopRetry.add(plan.id)
    logEvent('error', message, plan, { error: (err as Error)?.message ?? String(err) })
    if (stopAlerted.has(plan.id)) return
    stopAlerted.add(plan.id)
    deps.notify?.({
      type: 'error',
      title: 'Accumulate ride stop not resized',
      body: `${plan.symbol} tranche ${plan.tranche_index}: ${message.toLowerCase()}. Retried every minute.`,
      timestamp: new Date(now()).toISOString(),
      data: { planId: plan.id },
    })
  }

  function stopFine(plan: AccumulatePlanRow): void {
    stopRetry.delete(plan.id)
    stopAlerted.delete(plan.id)
  }

  // A withdrawn floor stop rides the orphan sweep tagged, so its fill is booked
  // off the manual marker instead of alarming as an untracked stop.
  const FLOOR_ORPHAN = 'floor:'

  // A floor stop fill takes the floor fills off the manual marker, never more
  // than the share of them the marker held when the stop was placed.
  function bookFloorStopFill(plan: AccumulatePlanRow, orderId: string, qty: number): void {
    if (!(qty > 0)) return
    const share = store.get(plan.id)?.floor_stop_marker_qty ?? qty
    const cut = Math.min(qty, share)
    if (cut > 0) db.reduceManualPosition(plan.exchange, plan.account_id, plan.symbol, cut)
    store.update(plan.id, { floor_stop_marker_qty: Math.max(0, share - cut) })
    logEvent('warn', 'Accumulate floor stop filled', plan, { orderId, qty, markerCut: cut })
  }

  const orphansOf = (plan: AccumulatePlanRow): string[] => {
    try {
      const ids = plan.orphan_stop_ids ? (JSON.parse(plan.orphan_stop_ids) as unknown) : []
      return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  }

  // Stops a failed swap left resting untracked: cancelled before anything else
  // is placed on the market. True while one is still there.
  async function sweepOrphanStops(market: AccumulatePlanRow, adapter: ExchangeAdapter): Promise<boolean> {
    let left = false
    for (const plan of store.forMarket(market.exchange, market.account_id, market.symbol)) {
      const ids = orphansOf(plan)
      if (ids.length === 0) continue
      const gone = new Set<string>()
      for (const raw of ids) {
        const floor = raw.startsWith(FLOOR_ORPHAN)
        const id = floor ? raw.slice(FLOOR_ORPHAN.length) : raw
        let st: Awaited<ReturnType<NonNullable<ExchangeAdapter['getOrderStatus']>>> | null = null
        try {
          st = adapter.getOrderStatus ? await adapter.getOrderStatus(id, { symbol: plan.symbol }) : null
        } catch {
          st = null // unknown: the cancel below decides
        }
        st = st && (await resolveAbsent(adapter, plan, st))
        if (floor) {
          if (await sweepFloorOrphan(plan, adapter, id, st)) gone.add(raw)
          continue
        }
        try {
          if (st && (st.state === 'filled' || st.state === 'partially_filled')) {
            logEvent('error', 'Accumulate untracked stop filled, its fill is not booked', plan, { orderId: id })
            deps.notify?.({
              type: 'error',
              title: 'Untracked stop filled',
              body: `${plan.symbol}: stop ${id} rested untracked after a failed stop swap and filled. Its fill is not booked; check the position.`,
              timestamp: new Date(now()).toISOString(),
              data: { planId: plan.id, orderId: id },
            })
            gone.add(id)
            continue
          }
          if (
            st &&
            (st.state === 'cancelled' || st.state === 'rejected' || (st.state === 'unknown' && st.absenceConfirmed))
          ) {
            gone.add(id)
            continue
          }
          await adapter.cancelOrder(id, { symbol: plan.symbol })
          gone.add(id)
          logEvent('warn', 'Accumulate untracked stop cancelled', plan, { orderId: id })
        } catch (err: any) {
          if (/not.?found/i.test(err?.message ?? '')) {
            gone.add(id)
            continue
          }
          logEvent('error', 'Accumulate untracked stop cancel failed', plan, { orderId: id, error: err?.message })
        }
      }
      // Re-read: another tick may have added an orphan meanwhile.
      const rest = orphansOf(store.get(plan.id) ?? plan).filter((id) => !gone.has(id))
      store.update(plan.id, { orphan_stop_ids: rest.length > 0 ? JSON.stringify(rest) : null })
      if (rest.length > 0) left = true
    }
    return left
  }

  // A withdrawn floor stop: gone once the venue reports it ended, its fill
  // booked then. A live one is cancelled and read back.
  async function sweepFloorOrphan(
    plan: AccumulatePlanRow,
    adapter: ExchangeAdapter,
    id: string,
    st: Awaited<ReturnType<NonNullable<ExchangeAdapter['getOrderStatus']>>> | null,
  ): Promise<boolean> {
    const ended = (s: typeof st): boolean => {
      if (s && (s.state === 'filled' || s.state === 'cancelled' || s.state === 'rejected')) {
        bookFloorStopFill(plan, id, s.filledQuantity ?? 0)
        return true
      }
      return !!s && s.state === 'unknown' && !!s.absenceConfirmed
    }
    if (ended(st)) return true
    try {
      await adapter.cancelOrder(id, { symbol: plan.symbol })
      logEvent('warn', 'Accumulate floor stop cancelled', plan, { orderId: id })
      return adapter.getOrderStatus ? ended(await orderOutcome(adapter, plan, id)) : false
    } catch (err: any) {
      if (!/not.?found/i.test(err?.message ?? '')) {
        logEvent('error', 'Accumulate floor stop cancel failed', plan, { orderId: id, error: err?.message })
        return false
      }
    }
    // Not found at the cancel: closed, maybe filled. Read it before letting go.
    if (!adapter.getOrderStatus) return true
    try {
      return ended(await orderOutcome(adapter, plan, id))
    } catch {
      return false
    }
  }

  function hasOrphanStops(exchange: string, accountId: string, symbol: string): boolean {
    return store.forMarket(exchange, accountId, symbol).some((p) => orphansOf(p).length > 0)
  }

  // A sibling's resting stop sized beyond its own execution goes back to it:
  // only when the venue order really differs, new stop first, old one after.
  async function fitSiblingStop(plan: AccumulatePlanRow, adapter: ExchangeAdapter): Promise<void> {
    if (!plan.ride_position_id || !plan.ride_entry_signal_id) return
    const positionId = plan.ride_position_id
    const seen = db.getServerExitState(positionId)
    const exec = db.getSignalExecution(plan.ride_entry_signal_id)
    if (!seen || !seen.active || !exec) return
    const openQty = Math.max(0, exec.qty_opened - exec.qty_closed)
    const stop = serverExitEffectiveStop(seen) ?? seen.current_stop
    if (!(openQty > 0) || stop == null) return
    try {
      if (seen.sl_order_id) {
        if (!adapter.getOpenOrders) return
        const order = (await adapter.getOpenOrders({ symbol: plan.symbol })).find((o) => o.orderId === seen.sl_order_id)
        if (!order || Math.abs(order.amount - openQty) < 1e-9) {
          stopFine(plan)
          return
        }
      }
      // Past the stop level a resting stop would fill at once: leave it to the ride.
      if (!isProtectiveStop(plan.direction, stop, await markOf(adapter, plan.symbol))) return
      const done = await withOrderLock(plan.exchange, async () => {
        // A server exit update may have moved the stop while we waited.
        const state = db.getServerExitState(positionId)
        if (!state || !state.active || state.sl_order_id !== seen.sl_order_id) return false
        const e = db.getSignalExecution(plan.ride_entry_signal_id!)
        if (!e || Math.abs(Math.max(0, e.qty_opened - e.qty_closed) - openQty) > 1e-9) return false
        await replaceServerExitStop({
          db,
          adapter,
          state,
          live: { id: plan.symbol, accountId: plan.account_id, symbol: plan.symbol, side: plan.direction, size: openQty, entryPrice: 0 },
          lineageAccount: plan.account_id,
          stopPrice: stop,
          exitSeq: state.last_exit_seq,
          label: 'kaibot-ride-sl',
          placeFirst: true,
          venueRead: false,
          context: { planId: plan.id, reason: 'accumulate sibling stop fit' },
        })
        return true
      })
      if (!done) {
        stopRetry.add(plan.id)
        return
      }
      store.update(plan.id, { stop_sized_qty: openQty })
      stopFine(plan)
      logEvent('info', 'Accumulate sibling stop fitted to its own tranche', plan, { qty: openQty, stop })
    } catch (err) {
      if (err instanceof OldStopKeptError && err.orphanId) {
        const row = store.get(plan.id)
        const ids = row ? orphansOf(row) : []
        store.update(plan.id, { orphan_stop_ids: JSON.stringify([...ids, err.orphanId]) })
        stopRetry.add(plan.id)
        logEvent('error', 'Accumulate stop swap left an untracked stop', plan, { orphanId: err.orphanId })
        deps.notify?.({
          type: 'error',
          title: 'Untracked stop at the venue',
          body: `${plan.symbol} tranche ${plan.tranche_index}: stop ${err.orphanId} could not be withdrawn after a failed stop swap. Nothing new is placed on this market until it is cancelled (retried every minute).`,
          timestamp: new Date(now()).toISOString(),
          data: { planId: plan.id, orphanId: err.orphanId },
        })
        return
      }
      stopTrouble(plan, 'Sibling stop resize failed', err)
    }
  }

  function hasRidingSiblings(plan: AccumulatePlanRow): boolean {
    return store
      .forMarket(plan.exchange, plan.account_id, plan.symbol)
      .some((p) => p.id !== plan.id && p.phase === 'riding' && p.ride_position_id)
  }

  // A rung fill grew the ridden position: the ride's venue stop follows the
  // execution's open size (never the net venue size, which a synthetic short
  // on the same instrument would distort).
  async function resizeRideStop(plan: AccumulatePlanRow, adapter: ExchangeAdapter): Promise<void> {
    if (!plan.ride_position_id || !plan.ride_entry_signal_id) return
    const state = db.getServerExitState(plan.ride_position_id)
    const exec = db.getSignalExecution(plan.ride_entry_signal_id)
    if (!state || !state.active || !exec) return
    // A failed fit is retried here; a bare ride only when tranches share the
    // market (a single ride keeps the server's own stop handling).
    if (stopRetry.has(plan.id) || (!state.sl_order_id && hasRidingSiblings(plan))) return fitSiblingStop(plan, adapter)
    if (!state.sl_order_id) return
    const positionId = plan.ride_position_id
    const signalId = plan.ride_entry_signal_id
    // Re-read under the lock: a sibling fit or a server exit update may have
    // swapped the stop or moved the qty while we waited.
    await withOrderLock(plan.exchange, async () => {
      const cur = db.getServerExitState(positionId)
      const e = db.getSignalExecution(signalId)
      const row = store.get(plan.id)
      if (!cur || !cur.active || !cur.sl_order_id || !e || !row) return
      const openQty = Math.max(0, e.qty_opened - e.qty_closed)
      if (!(openQty > 0) || Math.abs(openQty - (row.stop_sized_qty ?? 0)) < 1e-9) return
      const stop = serverExitEffectiveStop(cur) ?? cur.current_stop
      if (stop == null) return
      await replaceServerExitStop({
        db,
        adapter,
        state: cur,
        live: {
          id: plan.symbol,
          accountId: plan.account_id,
          symbol: plan.symbol,
          side: plan.direction,
          size: openQty,
          entryPrice: 0,
        },
        lineageAccount: plan.account_id,
        stopPrice: stop,
        exitSeq: cur.last_exit_seq,
        label: 'kaibot-ride-sl',
        venueRead: false,
        context: { planId: plan.id, reason: 'accumulate rung fill' },
      })
      store.update(plan.id, { stop_sized_qty: openQty })
      logEvent('info', 'Accumulate ride stop resized', plan, { qty: openQty, stop })
    })
  }

  function openQtyOf(plan: AccumulatePlanRow): number {
    const exec = plan.ride_entry_signal_id ? db.getSignalExecution(plan.ride_entry_signal_id) : null
    return exec ? Math.max(0, exec.qty_opened - exec.qty_closed) : 0
  }

  // ── floor stop settle ─────────────────────────────────────────────────
  // The floor stopped this plan with rungs filled (some in the race with the
  // cancel). Their qty must not sit at the venue without a stop: a riding
  // parent takes it over under its one ride stop; with no ride on the market
  // it gets its own reduce-only stop at the tranche stop level.

  async function settleFloorStop(planId: string): Promise<void> {
    if (running.has(planId)) return
    running.add(planId)
    try {
      await settleFloor(planId)
    } catch (err: any) {
      const plan = store.get(planId)
      if (plan) {
        store.update(planId, { last_error: err?.message ?? String(err) })
        logEvent('error', 'Accumulate floor settle failed', plan, { error: err?.message })
      }
    } finally {
      running.delete(planId)
    }
  }

  // A settle the venue never confirms (persistent unknown, a rung row without
  // a session) retries every tick; the user hears about it once.
  const FLOOR_SETTLE_ALERT_AFTER = 10
  const settleMisses = new Map<string, number>()

  async function settleFloor(planId: string): Promise<void> {
    try {
      await settleFloorOnce(planId)
    } finally {
      const plan = store.get(planId)
      if (plan?.floor_settle !== 'pending') settleMisses.delete(planId)
      else {
        const n = (settleMisses.get(planId) ?? 0) + 1
        settleMisses.set(planId, n)
        if (n === FLOOR_SETTLE_ALERT_AFTER) {
          logEvent('error', 'Accumulate floor settle keeps failing', plan, { attempts: n, error: plan.last_error })
          deps.notify?.({
            type: 'error',
            title: 'Accumulate floor fills not settled',
            body: `${plan.symbol} tranche ${plan.tranche_index}: the floor stopped the plan and its filled rungs are still not under a stop after ${n} tries (${plan.last_error ?? 'no answer from the venue'}). Retried every minute; check the position.`,
            timestamp: new Date(now()).toISOString(),
            data: { planId, attempts: n },
          })
        }
      }
    }
  }

  async function settleFloorOnce(planId: string): Promise<void> {
    let plan = store.get(planId)
    if (!plan || plan.phase !== 'stopped' || plan.floor_settle !== 'pending') return
    const adapter = await adapterFor(plan.exchange, plan.account_id)

    const current = () =>
      store.rungs(planId).filter((r) => r.ladder_seq === plan!.ladder_seq && (r.state === 'open' || r.state === 'cancelled'))
    const resting = new Set<string>()
    for (const r of current()) {
      const row = db.get('SELECT signal_id FROM dca_resting_rungs WHERE order_id = ?', [r.order_id]) as
        | { signal_id: string }
        | undefined
      if (row) resting.add(row.signal_id)
    }
    if (resting.size > 0) await deps.cancelEntryRungs(plan.exchange, [...resting])
    const unsure = await confirmGoneRungs(plan, adapter, current())
    if (unsure > 0) {
      store.update(planId, { last_error: `floor stop: ${unsure} rung(s) not confirmed cancelled or filled yet` })
      return
    }
    plan = store.get(planId)!

    // Fills of a plan that had a ride were booked into that ride's execution.
    const spec = await specFor(adapter, plan.exchange, plan.symbol)
    const own = plan.ride_entry_signal_id ? null : ownTranche(plan, spec.inverse)
    if (!own) {
      store.update(planId, { floor_settle: 'done', last_error: null })
      return
    }

    // Only what the venue holds beyond the riding tranches is unprotected.
    const pos = await livePosition(adapter, plan.account_id, plan.symbol)
    const venueQty = directionalQty(pos, plan.direction, syntheticShort(plan.exchange, plan.account_id, plan.symbol))
    const rides = ridingTranches(plan.exchange, plan.account_id, plan.symbol)
    const ridden = rides.reduce((a, p) => a + openQtyOf(p), 0)
    const qty = Math.floor(Math.min(own.qty, venueQty - ridden) / spec.stepSize + 1e-9) * spec.stepSize
    if (!(qty > 0)) {
      store.update(planId, { floor_settle: 'done', last_error: null })
      logEvent('warn', 'Accumulate floor stop: filled rungs no longer at the venue', plan, {
        filled: own.qty, venueQty, ridden,
      })
      return
    }

    // The marker holds only the fills the rung sweep booked on it (not a fill
    // at placement or one the guard's cancel swallowed): with these fills taken
    // out the venue must equal ridden + marker, the excess is what they added.
    const marker = db.getManualPosition(plan.exchange, plan.account_id, plan.symbol)
    const markerQty = marker ? Math.max(0, plan.direction === 'long' ? marker.net : -marker.net) : 0
    const markerCut = Math.min(qty, Math.max(0, markerQty + ridden + qty - venueQty))
    const parent = rides.find((p) => p.id === plan!.parent_plan_id) ?? rides[rides.length - 1] ?? null
    const parentExec = parent?.ride_entry_signal_id ? db.getSignalExecution(parent.ride_entry_signal_id) : null
    if (parent && parentExec) return handFloorFillsToParent(plan, parent, adapter, qty, own.price, markerCut)
    return protectFloorFills(plan, adapter, qty, own.price, spec, markerCut)
  }

  async function handFloorFillsToParent(
    plan: AccumulatePlanRow,
    parent: AccumulatePlanRow,
    adapter: ExchangeAdapter,
    qty: number,
    avg: number,
    markerCut: number,
  ): Promise<void> {
    const signalId = parent.ride_entry_signal_id!
    const note = `floor fired: ${qty} filled on this tranche handed to tranche ${parent.tranche_index}'s ride stop`
    db.transaction(() => {
      const exec = db.getSignalExecution(signalId)!
      db.insertSignalFill({
        signalId,
        kind: 'entry',
        symbol: plan.symbol,
        side: plan.direction === 'long' ? 'buy' : 'sell',
        qty,
        price: avg,
      })
      db.updateSignalExecution(signalId, { qtyOpened: exec.qty_opened + qty })
      if (markerCut > 0) db.reduceManualPosition(plan.exchange, plan.account_id, plan.symbol, markerCut)
      store.update(plan.id, { floor_settle: 'done', last_note: note, last_error: null })
    })
    logEvent('warn', 'Accumulate floor stop: filled rungs handed to the parent ride', plan, {
      parentPlanId: parent.id, qty, avg, markerCut, parentOpenQty: openQtyOf(parent),
    })
    // The guard runs this outside the tick loop: a parent mid-tick owns its
    // stop, so its next pass fits the stop under the order lock instead.
    if (running.has(parent.id)) {
      stopRetry.add(parent.id)
      return
    }
    running.add(parent.id)
    try {
      await resizeRideStop(store.get(parent.id)!, adapter)
    } catch (err) {
      stopTrouble(parent, 'Ride stop resize after a floor hand-over failed', err)
    } finally {
      running.delete(parent.id)
    }
  }

  // A thrown error (no mark, network) keeps the settle pending for the next
  // tick; the deterministic client order id dedups a stop that did land.
  async function protectFloorFills(
    plan: AccumulatePlanRow,
    adapter: ExchangeAdapter,
    qty: number,
    avg: number,
    spec: InstrumentSpec,
    markerCut: number,
  ): Promise<void> {
    const params = planParams(plan)
    const stopPrice = Number(trancheStopPrice(plan.direction, avg, avg, params, spec).toFixed(10))
    let reason: string | null = null
    const mark = await markOf(adapter, plan.symbol)
    if (!isProtectiveStop(plan.direction, stopPrice, mark)) {
      reason = `the stop level ${stopPrice} is already through the mark ${mark}`
    } else {
      const res = await adapter.placeOrder({
        accountId: plan.account_id,
        symbol: plan.symbol,
        side: plan.direction === 'long' ? 'sell' : 'buy',
        orderType: 'stop',
        quantity: qty,
        stopPrice,
        reduceOnly: true,
        label: 'kaibot-accum-floor-sl',
        clientOrderId: label(plan, plan.ladder_seq, 'floor-sl'),
      })
      if (res.status === 'rejected') reason = `the venue rejected the stop${res.message ? ` (${res.message})` : ''}`
      else {
        const note = `floor fired: ${qty} filled without a ride, own stop at ${stopPrice}`
        store.update(plan.id, {
          floor_settle: 'done',
          floor_stop_order_id: res.orderId,
          floor_stop_marker_qty: markerCut,
          last_note: note,
          last_error: null,
        })
        logEvent('warn', 'Accumulate floor stop: own stop placed for the filled rungs', plan, {
          qty, avg, stopPrice, orderId: res.orderId,
        })
        return
      }
    }
    const message = `Accumulate floor stop left ${qty} filled without a stop`
    store.update(plan.id, { floor_settle: 'done', last_note: `${message}: ${reason}`, last_error: null })
    logEvent('warn', message, plan, { qty, avg, stopPrice, reason })
    deps.notify?.({
      type: 'error',
      title: 'Accumulate fills without a stop',
      body: `${plan.symbol} tranche ${plan.tranche_index}: the floor stopped the plan with ${qty} filled and no stop could be placed (${reason}). Protect the position by hand.`,
      timestamp: new Date(now()).toISOString(),
      data: { planId: plan.id, qty },
    })
  }

  // A floor stop guards fills nobody rides. Once the market gets a new plan or
  // ride it could close part of that ride: it goes to the orphan sweep, which
  // cancels it before anything else is placed.
  function retireFloorStops(exchange: string, accountId: string, symbol: string, reason: string): void {
    for (const p of store.forMarket(exchange, accountId, symbol)) {
      const id = p.floor_stop_order_id
      if (!id) continue
      store.update(p.id, {
        floor_stop_order_id: null,
        orphan_stop_ids: JSON.stringify([...orphansOf(p).filter((x) => x !== FLOOR_ORPHAN + id), FLOOR_ORPHAN + id]),
        last_note: `floor stop ${id} withdrawn: ${reason}`,
      })
      logEvent('warn', 'Accumulate floor stop withdrawn', p, { orderId: id, reason })
    }
  }

  // The floor stop of a stopped plan: forgotten once the venue no longer holds
  // it, withdrawn once nothing beyond the rides is left to guard (closed by hand).
  // A floor stop the venue keeps failing to answer for is retried every tick;
  // the user hears about it once.
  const floorStopMisses = new Map<string, number>()

  function floorStopMiss(plan: AccumulatePlanRow, id: string, error: string | null): void {
    const n = (floorStopMisses.get(plan.id) ?? 0) + 1
    floorStopMisses.set(plan.id, n)
    if (n !== FLOOR_SETTLE_ALERT_AFTER) return
    logEvent('error', 'Accumulate floor stop lookup keeps failing', plan, { orderId: id, attempts: n, error })
    deps.notify?.({
      type: 'error',
      title: 'Accumulate floor stop not confirmed',
      body: `${plan.symbol} tranche ${plan.tranche_index}: the venue has not said whether floor stop ${id} filled after ${n} tries (${error ?? 'no answer from the venue'}). Retried every minute; check the position.`,
      timestamp: new Date(now()).toISOString(),
      data: { planId: plan.id, orderId: id, attempts: n },
    })
  }

  async function watchFloorStop(plan: AccumulatePlanRow, adapter: ExchangeAdapter): Promise<void> {
    const id = plan.floor_stop_order_id
    if (!id || !adapter.getOrderStatus) return
    let st: VenueOrderState
    try {
      st = await orderOutcome(adapter, plan, id)
    } catch (err: any) {
      floorStopMiss(plan, id, err?.message ?? String(err))
      throw err
    }
    if (st.state === 'unknown' && !st.absenceConfirmed) return floorStopMiss(plan, id, null)
    floorStopMisses.delete(plan.id)
    if (st.state === 'filled' || st.state === 'cancelled' || st.state === 'rejected' || (st.state === 'unknown' && st.absenceConfirmed)) {
      store.update(plan.id, { floor_stop_order_id: null, last_note: `floor stop ${id} ${st.state === 'unknown' ? 'gone' : st.state}` })
      if (st.state !== 'unknown') bookFloorStopFill(plan, id, st.filledQuantity ?? 0)
      logEvent('info', 'Accumulate floor stop ended', plan, { orderId: id, state: st.state })
      return
    }
    // A partial fill is booked once the stop ends, whole.
    if (st.state !== 'working') return
    const pos = await livePosition(adapter, plan.account_id, plan.symbol)
    const venueQty = directionalQty(pos, plan.direction, syntheticShort(plan.exchange, plan.account_id, plan.symbol))
    const ridden = ridingTranches(plan.exchange, plan.account_id, plan.symbol).reduce((a, p) => a + openQtyOf(p), 0)
    if (venueQty - ridden <= 1e-9) retireFloorStops(plan.exchange, plan.account_id, plan.symbol, 'the position it guarded is closed')
  }

  async function runAction(plan: AccumulatePlanRow, adapter: ExchangeAdapter, action: AccumulateAction): Promise<void> {
    switch (action.kind) {
      case 'cancel-rungs':
        return cancelRungs(plan, adapter)
      case 'market-entry':
        return marketEntry(plan, adapter)
      case 'handover':
        await handOver(plan, adapter, action.anchor)
        return retireFloorStops(plan.exchange, plan.account_id, plan.symbol, 'a tranche rides this market')
      case 'place-ladder':
        return placeLadder(plan, adapter, action.reference)
    }
  }

  // Run (or resume) a pending decision. Commits the next state only when every
  // action succeeded; a failure leaves the rest pending for the next tick.
  const PLACING = new Set<AccumulateAction['kind']>(['place-ladder', 'market-entry', 'handover'])

  async function runPending(planId: string, adapter: ExchangeAdapter): Promise<void> {
    let plan = store.get(planId)
    const pending = plan ? pendingOf(plan) : null
    if (!plan || !pending) return
    for (let i = pending.done; i < pending.actions.length; i++) {
      // An untracked stop on the market (possibly left by the previous action's
      // stop swap) holds every further placement; the sweep retries first.
      if (PLACING.has(pending.actions[i].kind) && hasOrphanStops(plan.exchange, plan.account_id, plan.symbol)) {
        store.update(plan.id, { last_error: 'an untracked stop still rests on this market: nothing is placed until it is cancelled' })
        return
      }
      await runAction(plan, adapter, pending.actions[i])
      pending.done = i + 1
      store.setPending(plan.id, pending)
      plan = store.get(planId)!
    }
    const n = pending.next
    const leavingRide = plan.phase === 'riding' && n.phase !== 'riding'
    // One plan per market waits for the breakout: a tranche whose ride ended
    // retires when another plan already waits.
    const entryPlan = store.activeFor(plan.exchange, plan.account_id, plan.symbol)
    const phase = n.phase === 'waiting' && entryPlan && entryPlan.id !== plan.id ? 'closed' : n.phase
    const note = phase === 'closed' ? 'ride ended: tranche closed, rungs cancelled' : pending.note
    store.update(plan.id, {
      phase,
      reference: n.reference,
      entry_bar_time: n.entryBarTime,
      local_level: n.localLevel,
      last_evaluated_bar: n.lastEvaluatedBar,
      pending: null,
      last_note: note,
      last_error: null,
      ...(pending.breakout ? { last_breakout: JSON.stringify(pending.breakout) } : {}),
      ...(leavingRide ? { ride_ended_at: now() } : {}),
      ...(n.phase === 'riding' && plan.phase !== 'riding' ? { entry_fill_qty: null, entry_fill_price: null } : {}),
      ...(leavingRide || n.phase === 'waiting'
        ? { ride_position_id: null, ride_entry_signal_id: null, stop_sized_qty: null }
        : {}),
    })
    logEvent('warn', `Accumulate: ${note}`, { ...plan, phase }, { breakout: pending.breakout })
  }

  async function begin(plan: AccumulatePlanRow, next: PlanCore, actions: AccumulateAction[], note: string, breakout?: PendingDecision['breakout']) {
    // A new ladder gets a fresh label sequence (a cancelled label must never
    // dedup a new rung).
    const needsSeq = actions.some((a) => a.kind === 'place-ladder' || a.kind === 'market-entry')
    if (needsSeq) store.update(plan.id, { ladder_seq: plan.ladder_seq + 1 })
    store.setPending(plan.id, { actions, done: 0, next, note, ...(breakout ? { breakout } : {}) })
  }

  async function tickPlan(planId: string): Promise<void> {
    if (running.has(planId)) return
    running.add(planId)
    try {
      let plan = store.get(planId)
      if (!plan) return
      if (plan.phase === 'stopped' || plan.phase === 'closed') {
        if (orphansOf(plan).length > 0) await sweepOrphanStops(plan, await adapterFor(plan.exchange, plan.account_id))
        if (plan.floor_settle === 'pending') await settleFloor(plan.id)
        else if (plan.floor_stop_order_id) await watchFloorStop(plan, await adapterFor(plan.exchange, plan.account_id))
        return
      }
      const adapter = await adapterFor(plan.exchange, plan.account_id)
      if (await sweepOrphanStops(plan, adapter)) {
        store.update(plan.id, { last_error: 'an untracked stop still rests on this market: nothing is placed until it is cancelled' })
        return
      }
      await syncRungs(plan, adapter)

      if (!pendingOf(plan)) {
        const params = planParams(plan)
        const pos = await livePosition(adapter, plan.account_id, plan.symbol)
        const synth = syntheticShort(plan.exchange, plan.account_id, plan.symbol)
        const bars = await fetchBars(
          adapter,
          plan.symbol,
          params,
          now() - (params.lookbackBars + 4) * params.barMinutes * 60_000,
        )
        const core = planCore(plan)
        const obs = {
          now: now(),
          bars,
          positionQty: directionalQty(pos, plan.direction, synth),
          rideActive: rideActiveFor(plan),
          syntheticHedgeActive: synth > 0,
        }
        const closed = closedBars(bars, params.barMinutes, obs.now)
        const lastBar = closed[closed.length - 1]
        if (lastBar) lastCloses.set(marketKey(plan.exchange, plan.account_id, plan.symbol), lastBar.close)
        watchLevels.set(
          plan.id,
          plan.phase === 'ladder' || plan.phase === 'armed'
            ? plan.local_level
            : lastBar
              ? localExtreme(closed, lastBar.time + 1, params.lookbackBars, plan.direction)
              : null,
        )
        const d = decide(core, obs, params)
        if (d.actions.length > 0) {
          await begin(plan, d.next, d.actions, d.note, d.breakout)
        } else {
          store.update(plan.id, { last_evaluated_bar: d.next.lastEvaluatedBar, last_note: d.note, last_error: null })
        }
      }
      await runPending(planId, adapter)
      plan = store.get(planId)
      if (plan && plan.phase === 'riding') await resizeRideStop(plan, adapter)
    } catch (err: any) {
      const plan = store.get(planId)
      if (plan) {
        store.update(planId, { last_error: err?.message ?? String(err) })
        logEvent('error', 'Accumulate tick failed', plan, { error: err?.message })
      }
    } finally {
      running.delete(planId)
    }
  }

  // A plan follows its OWN ride once it has one (other tranches may ride on
  // the same market, whatever its re-arm flag); before that, the market.
  function rideActiveFor(plan: AccumulatePlanRow): boolean {
    if (plan.ride_position_id) {
      const state = db.getServerExitState(plan.ride_position_id)
      const exec = plan.ride_entry_signal_id ? db.getSignalExecution(plan.ride_entry_signal_id) : null
      return !!state?.active && !!exec && (exec.status === 'open' || exec.status === 'closing')
    }
    return activeRideFor(db, plan.exchange, plan.account_id, plan.symbol) != null
  }

  async function tick(): Promise<void> {
    for (const plan of store.list(true)) {
      if (plan.phase !== 'stopped' || plan.floor_settle === 'pending' || plan.floor_stop_order_id || orphansOf(plan).length > 0) await tickPlan(plan.id)
    }
    const markets = new Map<string, AccumulatePlanRow>()
    for (const plan of store.list()) markets.set(marketKey(plan.exchange, plan.account_id, plan.symbol), plan)
    for (const plan of markets.values()) {
      try {
        await maybeRearm(plan.exchange, plan.account_id, plan.symbol)
      } catch (err: any) {
        logEvent('error', 'Accumulate re-arm failed', plan, { error: err?.message })
      }
    }
  }

  function ridingTranches(exchange: string, accountId: string, symbol: string): AccumulatePlanRow[] {
    return store
      .forMarket(exchange, accountId, symbol)
      .filter((p) => p.phase === 'riding' && p.ride_position_id && rideActiveFor(p))
  }

  function floorFired(exchange: string, accountId: string): boolean {
    return db
      .listSyntheticUsdPositions(true)
      .some((r) => r.exchange === exchange && r.account_id === accountId && r.status === 'open' && (r.short_size || 0) > 0)
  }

  // The stop of every open ride rests at the venue: the order id is known and
  // the venue reports it working. The server's own stop level alone is not a stop.
  async function stopsConfirmed(adapter: ExchangeAdapter, rides: AccumulatePlanRow[]): Promise<boolean> {
    if (!adapter.getOrderStatus) return false
    for (const p of rides) {
      const state = db.getServerExitState(p.ride_position_id!)
      if (!state?.active || !state.sl_order_id) return false
      try {
        const st = await adapter.getOrderStatus(state.sl_order_id, { accountId: p.account_id, symbol: p.symbol })
        if (st.state !== 'working') return false
      } catch {
        return false
      }
    }
    return true
  }

  function rearmStateOf(exchange: string, accountId: string, symbol: string, rides: AccumulatePlanRow[]) {
    const plans = store.forMarket(exchange, accountId, symbol)
    const ended = plans.map((p) => p.ride_ended_at).filter((t): t is number => t != null)
    const rearmed = plans.filter((p) => p.parent_plan_id != null).map((p) => p.entry_bar_time)
    const halt = db.getHaltState().halted || db.getAccountHalt(exchange, accountId) != null
    return {
      now: now(),
      openTranches: rides.length,
      stopsConfirmed: true,
      entryPlanActive: store.activeFor(exchange, accountId, symbol) != null,
      lastRideEndedAt: ended.length > 0 ? Math.max(...ended) : null,
      lastRearmBar: rearmed.length > 0 ? Math.max(...rearmed) : null,
      accountHalted: halt,
      floorFired: floorFired(exchange, accountId),
    }
  }

  // Kai 12/10: once the previous position is safe and has a stop, the plan
  // arms again: a new ladder and breakout entry on the same market, ridden as
  // its own tranche.
  async function maybeRearm(exchange: string, accountId: string, symbol: string): Promise<string | null> {
    const rides = ridingTranches(exchange, accountId, symbol)
    const parent = rides[rides.length - 1]
    if (!parent || hasOrphanStops(exchange, accountId, symbol)) return null
    const params = planParams(parent)
    const state = rearmStateOf(exchange, accountId, symbol, rides)
    if (rearmBlock(params, state)) return null
    const adapter = await adapterFor(exchange, accountId)
    if (rearmBlock(params, { ...state, stopsConfirmed: await stopsConfirmed(adapter, rides) })) return null

    const mark = await markOf(adapter, symbol)
    const entryBarTime = barStart(now(), params.barMinutes)
    const bars = await fetchBars(adapter, symbol, params, entryBarTime - (params.lookbackBars + 2) * params.barMinutes * 60_000)
    const localLevel = localExtreme(closedBars(bars, params.barMinutes, now()), entryBarTime, params.lookbackBars, parent.direction)
    if (localLevel == null) return null
    const plans = store.forMarket(exchange, accountId, symbol)
    const trancheIndex = Math.max(...plans.map((p) => p.tranche_index)) + 1
    const hex = createHash('sha256').update(`accumulate-rearm|${parent.id}|${trancheIndex}`).digest('hex')
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
    const inserted = store.insert({
      id,
      exchange,
      account_id: accountId,
      symbol: parent.symbol,
      direction: parent.direction,
      ride_bot_id: parent.ride_bot_id,
      params: JSON.stringify(params),
      phase: 'armed',
      reference: mark,
      entry_bar_time: entryBarTime,
      local_level: localLevel,
      last_evaluated_bar: null,
      ladder_seq: 0,
      basis_usd: null,
      ride_position_id: null,
      ride_entry_signal_id: null,
      stop_sized_qty: null,
      pending: null,
      last_note: null,
      last_error: null,
      last_breakout: null,
      parent_plan_id: parent.id,
      tranche_index: trancheIndex,
    })
    if (!inserted) return null
    let plan = store.get(id)!
    if (params.rungCount > 0) {
      await begin(plan, planCore(plan), [{ kind: 'place-ladder', reference: mark }], `re-armed as tranche ${trancheIndex}`)
      try {
        await runPending(id, adapter)
      } catch (err: any) {
        store.update(id, { last_error: err?.message ?? String(err) })
      }
    } else {
      store.update(id, { last_note: `re-armed as tranche ${trancheIndex}` })
    }
    plan = store.get(id)!
    logEvent('warn', 'Accumulate re-armed', plan, { parentPlanId: parent.id, tranche: trancheIndex, reference: mark, localLevel })
    return id
  }

  // ── operator API ──────────────────────────────────────────────────────

  function resolveParams(input?: Partial<AccumulateParams>): AccumulateParams {
    const params = { ...DEFAULT_ACCUMULATE_PARAMS, ...(input ?? {}) }
    const errors = validateAccumulateParams(params)
    if (errors.length > 0) throw new Error(errors.join('; '))
    return params
  }

  async function preview(input: CreatePlanInput) {
    const params = resolveParams(input.params)
    const adapter = await adapterFor(input.exchange, input.accountId)
    const spec = await specFor(adapter, input.exchange, input.symbol)
    const pos = await livePosition(adapter, input.accountId, input.symbol)
    const direction: Direction = pos?.side ?? input.direction ?? 'long'
    const mark = await markOf(adapter, input.symbol, pos?.markPrice ?? pos?.entryPrice)
    const basis = await basisUsd(adapter, input.exchange, input.accountId, input.symbol, mark)
    const reference = input.reference ?? pos?.entryPrice ?? mark
    const marker = db.getManualPosition(input.exchange, input.accountId, input.symbol)
    const openedAt = input.openedAt ?? marker?.opened_at ?? now()
    const entryBarTime = barStart(openedAt, params.barMinutes)
    const bars = await fetchBars(
      adapter,
      input.symbol,
      params,
      entryBarTime - (params.lookbackBars + 2) * params.barMinutes * 60_000,
    )
    const localLevel = localExtreme(closedBars(bars, params.barMinutes, now()), entryBarTime, params.lookbackBars, direction)
    const resting = adoptableRungs(input.exchange, input.accountId, input.symbol, direction)
    const positionUsd = pos ? (spec.inverse ? Math.abs(pos.size) : Math.abs(pos.size) * mark) : 0
    return {
      direction,
      mark,
      basisUsd: basis,
      reference,
      entryBarTime,
      localLevel,
      position: pos ? { qty: Math.abs(pos.size), entryPrice: pos.entryPrice, usd: positionUsd } : null,
      // What the current position is as a share of the basis (the start size
      // the UI suggests).
      positionPctOfBasis: basis > 0 ? (positionUsd / basis) * 100 : null,
      ladder: computeLadder({ reference, basisUsd: basis, direction, params, spec }),
      rideStop: rideStopFor(reference, direction, params, spec),
      adoptableRungs: resting.map((r) => ({ orderId: r.order_id, price: r.price, qty: r.qty })),
      activeRide: activeRideFor(db, input.exchange, input.accountId, input.symbol),
      floor: floorOf(input.exchange, input.accountId, input.symbol),
      params,
    }
  }

  function adoptableRungs(exchange: string, accountId: string, symbol: string, direction: Direction) {
    const side = direction === 'long' ? 'buy' : 'sell'
    return (
      db.all(
        'SELECT * FROM dca_resting_rungs WHERE exchange = ? AND account_id = ? AND UPPER(symbol) = UPPER(?) AND side = ?',
        [exchange, accountId, symbol, side],
      ) as Array<{ order_id: string; signal_id: string; price: number | null; qty: number; filled_qty: number | null }>
    ).filter((r) => !db.get('SELECT 1 AS x FROM accumulate_rungs WHERE order_id = ? AND state = ?', [r.order_id, 'open']))
  }

  async function create(input: CreatePlanInput): Promise<PlanStatus> {
    if (!input.rideBotId) throw new Error('pick the ride bot that takes over at the breakout')
    if (store.activeFor(input.exchange, input.accountId, input.symbol)) {
      throw new Error('this market already runs an accumulate plan')
    }
    const pv = await preview(input)
    const params = pv.params
    const id = randomUUID()
    const market = store.forMarket(input.exchange, input.accountId, input.symbol)
    const owned = (positionId: string) =>
      market.some((p) => p.ride_position_id === positionId && p.phase !== 'stopped' && p.phase !== 'closed')
    const unowned = listActiveRides(db).filter(
      (r) =>
        r.exchange === input.exchange &&
        r.symbol.toUpperCase() === input.symbol.toUpperCase() &&
        (r.accountId == null || r.accountId === input.accountId) &&
        !owned(r.positionId),
    )
    // Rides already owned by plans here: the new plan is one more tranche.
    const tranche = pv.activeRide != null && unowned.length === 0
    if (tranche && !params.rearm) {
      throw new Error('a plan already rides this market: a new plan here is a tranche, so re-arm must stay on')
    }
    const ride = tranche ? null : unowned[0] ?? null
    const phase: AccumulatePlanRow['phase'] = tranche ? 'armed' : ride ? 'riding' : pv.position ? 'ladder' : 'waiting'
    if ((phase === 'ladder' || phase === 'armed') && pv.localLevel == null) {
      throw new Error('not enough candles before the entry to measure the local level')
    }
    const latest = market.filter((p) => p.phase !== 'stopped').at(-1)
    store.insert({
      id,
      exchange: input.exchange,
      account_id: input.accountId,
      symbol: input.symbol,
      direction: pv.direction,
      ride_bot_id: input.rideBotId,
      params: JSON.stringify(params),
      phase,
      reference: tranche ? pv.mark : pv.reference,
      entry_bar_time: tranche ? barStart(now(), params.barMinutes) : pv.entryBarTime,
      local_level: phase === 'ladder' || phase === 'armed' ? pv.localLevel : null,
      last_evaluated_bar: null,
      ladder_seq: 0,
      basis_usd: pv.basisUsd,
      ride_position_id: ride?.positionId ?? null,
      ride_entry_signal_id: ride?.entrySignalId ?? null,
      stop_sized_qty: null,
      pending: null,
      last_note: null,
      last_error: null,
      last_breakout: null,
      ...(tranche && latest
        ? { parent_plan_id: latest.id, tranche_index: Math.max(...market.map((p) => p.tranche_index)) + 1 }
        : {}),
    })
    let plan = store.get(id)!
    // A ladder leaves the floor stop guarding its fills until the hand-over. An
    // adopted ride already ran beside it: the stop goes only when the rides
    // hold the whole venue position.
    if (phase === 'riding') {
      try {
        const adapter = await adapterFor(input.exchange, input.accountId)
        const pos = await livePosition(adapter, input.accountId, input.symbol)
        const venueQty = directionalQty(pos, pv.direction, syntheticShort(input.exchange, input.accountId, input.symbol))
        const ridden = ridingTranches(input.exchange, input.accountId, input.symbol).reduce((a, p) => a + openQtyOf(p), 0)
        if (venueQty - ridden <= 1e-9) retireFloorStops(input.exchange, input.accountId, input.symbol, 'a ride was adopted on this market')
      } catch (err: any) {
        logEvent('warn', 'Accumulate floor stop kept: venue position unknown at create', plan, { error: err?.message })
      }
    }
    const adopt = input.adoptRungs !== false && phase !== 'waiting' && phase !== 'armed'
    const adopted = adopt ? pv.adoptableRungs : []
    const sorted = [...adopted].sort((a, b) =>
      pv.direction === 'long' ? (b.price ?? 0) - (a.price ?? 0) : (a.price ?? 0) - (b.price ?? 0),
    )
    sorted.forEach((r, i) =>
      store.upsertRung({
        order_id: r.orderId, plan_id: id, ladder_seq: 0, idx: i + 1, price: r.price ?? 0, qty: r.qty,
        state: 'open', filled_qty: 0, adopted: 1,
      }),
    )
    if (phase !== 'waiting' && adopted.length === 0 && params.rungCount > 0) {
      await begin(plan, planCore(plan), [{ kind: 'place-ladder', reference: plan.reference }], 'ladder placed')
      plan = store.get(id)!
      const adapter = await adapterFor(plan.exchange, plan.account_id)
      try {
        await runPending(id, adapter)
      } catch (err: any) {
        store.update(id, { last_error: err?.message ?? String(err) })
      }
    } else {
      store.update(id, {
        last_note:
          phase === 'waiting'
            ? 'armed: waiting for a breakout to enter'
            : `armed: ${adopted.length} resting rung(s) adopted`,
      })
    }
    logEvent('warn', 'Accumulate plan armed', store.get(id)!, { adopted: adopted.length, rideBotId: input.rideBotId })
    return status(id)!
  }

  async function stop(id: string): Promise<PlanStatus> {
    const plan = store.get(id)
    if (!plan) throw new Error('no such plan')
    if (plan.phase !== 'stopped') {
      const adapter = await adapterFor(plan.exchange, plan.account_id)
      await cancelRungs(plan, adapter)
      store.update(id, { phase: 'stopped', pending: null, last_note: 'stopped: rungs cancelled, position left as is' })
      logEvent('warn', 'Accumulate plan stopped', plan)
    }
    return status(id)!
  }

  // Re-arm settings on a live plan (e.g. switch re-arm off before the first
  // tick after a deploy). Takes effect on the next tick; nothing is placed here.
  function updateParams(id: string, patch: RearmParamsPatch): PlanStatus {
    const plan = store.get(id)
    if (!plan) throw new Error('no such plan')
    if (plan.phase === 'stopped' || plan.phase === 'closed') throw new Error(`this plan is ${plan.phase}`)
    const params = { ...planParams(plan) }
    if (patch.rearm !== undefined) params.rearm = patch.rearm
    if (patch.maxTranches !== undefined) params.maxTranches = patch.maxTranches
    if (patch.rearmCooldownBars !== undefined) params.rearmCooldownBars = patch.rearmCooldownBars
    const errors = validateAccumulateParams(params)
    if (errors.length > 0) throw new Error(errors.join('; '))
    store.update(id, { params: JSON.stringify(params) })
    logEvent('warn', 'Accumulate re-arm settings changed', plan, { ...patch })
    return status(id)!
  }

  function floorOf(exchange: string, accountId: string, symbol: string): PlanStatus['floor'] {
    const row = syntheticRow(exchange, accountId, symbol)
    if (!row) return null
    return {
      status: row.status,
      triggerPrice: row.arm_trigger_price ?? null,
      holdingsCoin: row.arm_holdings_coin ?? null,
      shortSize: row.short_size || 0,
    }
  }

  function status(id: string): PlanStatus | null {
    const plan = store.get(id)
    if (!plan) return null
    const rows = store.rungs(id)
    const current = rows.filter((r) => r.state === 'open' || r.state === 'filled')
    const ride = plan.ride_position_id ? db.getServerExitState(plan.ride_position_id) : null
    const rideInfo = plan.ride_position_id
      ? activeRideFor(db, plan.exchange, plan.account_id, plan.symbol)
      : null
    const exec = plan.ride_entry_signal_id ? db.getSignalExecution(plan.ride_entry_signal_id) : null
    let breakout: PlanStatus['lastBreakout'] = null
    try {
      breakout = plan.last_breakout ? JSON.parse(plan.last_breakout) : null
    } catch {
      breakout = null
    }
    const mark = lastCloses.get(marketKey(plan.exchange, plan.account_id, plan.symbol)) ?? null
    return {
      id: plan.id,
      exchange: plan.exchange,
      accountId: plan.account_id,
      symbol: plan.symbol,
      direction: plan.direction,
      rideBotId: plan.ride_bot_id,
      params: planParams(plan),
      phase: plan.phase,
      reference: plan.reference,
      entryBarTime: plan.entry_bar_time,
      localLevel: plan.local_level,
      watchLevel: watchLevels.get(plan.id) ?? plan.local_level,
      basisUsd: plan.basis_usd,
      position: exec ? { qty: Math.max(0, exec.qty_opened - exec.qty_closed), entryPrice: null, mark: null } : null,
      ride:
        ride && ride.active
          ? {
              positionId: ride.position_id,
              currentStop: ride.current_stop,
              botId: rideInfo?.botId ?? plan.ride_bot_id,
              botName: rideInfo?.botName ?? null,
            }
          : null,
      rungs: {
        open: rows.filter((r) => r.state === 'open').length,
        filled: rows.filter((r) => r.state === 'filled').length,
        openQty: rows.filter((r) => r.state === 'open').reduce((s, r) => s + (r.qty - r.filled_qty), 0),
        filledQty: rows.reduce((s, r) => s + r.filled_qty, 0),
        list: current.map((r) => ({
          order_id: r.order_id, idx: r.idx, price: r.price, qty: r.qty, state: r.state,
          filled_qty: r.filled_qty, ladder_seq: r.ladder_seq, adopted: r.adopted,
        })),
      },
      floor: floorOf(plan.exchange, plan.account_id, plan.symbol),
      pending: plan.pending != null,
      floorStopOrderId: plan.floor_stop_order_id,
      lastNote: plan.last_note,
      lastError: plan.last_error,
      lastBreakout: breakout,
      parentPlanId: plan.parent_plan_id,
      trancheIndex: plan.tranche_index,
      openTranches: ridingTranches(plan.exchange, plan.account_id, plan.symbol).length,
      tranche: trancheOf(plan, ride ? ride.current_stop : null, mark),
      createdAt: plan.created_at,
      updatedAt: plan.updated_at,
    }
  }

  // Entry average, open size and P&L (realized + open at the last close) of
  // the plan's own ride execution.
  function trancheOf(plan: AccumulatePlanRow, stop: number | null, mark: number | null): PlanStatus['tranche'] {
    if (!plan.ride_entry_signal_id) return null
    const exec = db.getSignalExecution(plan.ride_entry_signal_id)
    if (!exec) return null
    const inverse = isInverseContract(plan.exchange, plan.symbol)
    const fills = db.getSignalFills(plan.ride_entry_signal_id)
    const sign = plan.direction === 'long' ? 1 : -1
    // USD value of qty at price, per contract kind.
    const pnl = (qty: number, entry: number, exit: number) =>
      inverse ? sign * qty * (1 - entry / exit) : sign * qty * (exit - entry)
    const entries = fills.filter((f) => f.kind === 'entry' && f.qty > 0 && f.price)
    const inQty = entries.reduce((a, f) => a + f.qty, 0)
    const entryPrice =
      inQty > 0
        ? inverse
          ? inQty / entries.reduce((a, f) => a + f.qty / (f.price as number), 0)
          : entries.reduce((a, f) => a + f.qty * (f.price as number), 0) / inQty
        : null
    const openQty = Math.max(0, exec.qty_opened - exec.qty_closed)
    let pnlUsd: number | null = null
    if (entryPrice) {
      const realized = fills
        .filter((f) => f.kind !== 'entry' && f.qty > 0 && f.price)
        .reduce((a, f) => a + pnl(f.qty, entryPrice, f.price as number), 0)
      pnlUsd = openQty > 0 ? (mark ? realized + pnl(openQty, entryPrice, mark) : null) : realized
    }
    return { qty: openQty, entryPrice, stop, pnlUsd }
  }

  function list(includeStopped = false): PlanStatus[] {
    return store.list(includeStopped).map((p) => status(p.id)!).filter(Boolean)
  }

  return { preview, create, stop, updateParams, status, list, tick, tickPlan, maybeRearm, settleFloorStop }
}

export type AccumulateService = ReturnType<typeof createAccumulateService>

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

import { randomUUID } from 'node:crypto'
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
import { activeRideFor } from './ride-state.js'
import { replaceServerExitStop, serverExitEffectiveStop } from './server-exit-stop.js'
import type { HandoverRequest, HandoverResult } from './ride-handover.js'

// Deribit price ticks; other instruments ask the adapter.
const STATIC_TICKS: Record<string, number> = {
  'deribit:btc-perpetual': 0.5,
  'deribit:eth-perpetual': 0.05,
}

export const ACCUMULATE_LABEL_PREFIX = 'acr'
// Rungs placed before a hand-over belong to no execution: the manual prefix
// keeps the sweep from writing their real size into signal_fills.
const PRE_RIDE_SIGNAL_PREFIX = 'manual:accum:'

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
  lastNote: string | null
  lastError: string | null
  lastBreakout: { barTime: number; close: number; level: number } | null
  createdAt: number
  updatedAt: number
}

export function createAccumulateService(db: KaiBotDatabase, exchangeManager: ExchangeManager, deps: AccumulateDeps) {
  const store = createAccumulateStore(db)
  const userId = deps.userId ?? 'default'
  const now = () => (deps.now ? deps.now() : Date.now())
  // Last level each plan watched (status only, not persisted).
  const watchLevels = new Map<string, number | null>()
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
    // Rows the venue never answered for are gone from the book: settle as cancelled.
    for (const r of store.rungs(plan.id, 'open')) store.setRungState(r.order_id, 'cancelled', r.filled_qty)
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
    store.update(plan.id, { basis_usd: basis })
    logEvent('warn', 'Accumulate re-entry placed', plan, { qty, mark, basisUsd: basis, status: res.status })
  }

  async function handOver(plan: AccumulatePlanRow, adapter: ExchangeAdapter, anchor: number): Promise<void> {
    const existing = activeRideFor(db, plan.exchange, plan.account_id, plan.symbol)
    if (existing) {
      store.update(plan.id, { ride_position_id: existing.positionId, ride_entry_signal_id: existing.entrySignalId })
      return
    }
    const params = planParams(plan)
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

  // A rung fill grew the ridden position: the ride's venue stop follows the
  // execution's open size (never the net venue size, which a synthetic short
  // on the same instrument would distort).
  async function resizeRideStop(plan: AccumulatePlanRow, adapter: ExchangeAdapter): Promise<void> {
    if (!plan.ride_position_id || !plan.ride_entry_signal_id) return
    const state = db.getServerExitState(plan.ride_position_id)
    const exec = db.getSignalExecution(plan.ride_entry_signal_id)
    if (!state || !state.active || !exec || !state.sl_order_id) return
    const openQty = Math.max(0, exec.qty_opened - exec.qty_closed)
    if (!(openQty > 0) || Math.abs(openQty - (plan.stop_sized_qty ?? 0)) < 1e-9) return
    const stop = serverExitEffectiveStop(state) ?? state.current_stop
    if (stop == null) return
    await replaceServerExitStop({
      db,
      adapter,
      state,
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
      exitSeq: state.last_exit_seq,
      label: 'kaibot-ride-sl',
      context: { planId: plan.id, reason: 'accumulate rung fill' },
    })
    store.update(plan.id, { stop_sized_qty: openQty })
    logEvent('info', 'Accumulate ride stop resized', plan, { qty: openQty, stop })
  }

  async function runAction(plan: AccumulatePlanRow, adapter: ExchangeAdapter, action: AccumulateAction): Promise<void> {
    switch (action.kind) {
      case 'cancel-rungs':
        return cancelRungs(plan, adapter)
      case 'market-entry':
        return marketEntry(plan, adapter)
      case 'handover':
        return handOver(plan, adapter, action.anchor)
      case 'place-ladder':
        return placeLadder(plan, adapter, action.reference)
    }
  }

  // Run (or resume) a pending decision. Commits the next state only when every
  // action succeeded; a failure leaves the rest pending for the next tick.
  async function runPending(planId: string, adapter: ExchangeAdapter): Promise<void> {
    let plan = store.get(planId)
    const pending = plan ? pendingOf(plan) : null
    if (!plan || !pending) return
    for (let i = pending.done; i < pending.actions.length; i++) {
      await runAction(plan, adapter, pending.actions[i])
      pending.done = i + 1
      store.setPending(plan.id, pending)
      plan = store.get(planId)!
    }
    const n = pending.next
    const leavingRide = plan.phase === 'riding' && n.phase !== 'riding'
    store.update(plan.id, {
      phase: n.phase,
      reference: n.reference,
      entry_bar_time: n.entryBarTime,
      local_level: n.localLevel,
      last_evaluated_bar: n.lastEvaluatedBar,
      pending: null,
      last_note: pending.note,
      last_error: null,
      ...(pending.breakout ? { last_breakout: JSON.stringify(pending.breakout) } : {}),
      ...(leavingRide || n.phase === 'waiting'
        ? { ride_position_id: null, ride_entry_signal_id: null, stop_sized_qty: null }
        : {}),
    })
    logEvent('warn', `Accumulate: ${pending.note}`, { ...plan, phase: n.phase }, { breakout: pending.breakout })
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
      if (!plan || plan.phase === 'stopped') return
      const adapter = await adapterFor(plan.exchange, plan.account_id)
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
          rideActive: activeRideFor(db, plan.exchange, plan.account_id, plan.symbol) != null,
          syntheticHedgeActive: synth > 0,
        }
        const closed = closedBars(bars, params.barMinutes, obs.now)
        const lastBar = closed[closed.length - 1]
        watchLevels.set(
          plan.id,
          plan.phase === 'ladder'
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

  async function tick(): Promise<void> {
    for (const plan of store.list()) await tickPlan(plan.id)
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
    const ride = pv.activeRide
    const phase: AccumulatePlanRow['phase'] = ride ? 'riding' : pv.position ? 'ladder' : 'waiting'
    if (phase === 'ladder' && pv.localLevel == null) throw new Error('not enough candles before the entry to measure the local level')
    store.insert({
      id,
      exchange: input.exchange,
      account_id: input.accountId,
      symbol: input.symbol,
      direction: pv.direction,
      ride_bot_id: input.rideBotId,
      params: JSON.stringify(params),
      phase,
      reference: pv.reference,
      entry_bar_time: pv.entryBarTime,
      local_level: phase === 'ladder' ? pv.localLevel : null,
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
    })
    let plan = store.get(id)!
    const adopt = input.adoptRungs !== false && phase !== 'waiting'
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
      await begin(plan, planCore(plan), [{ kind: 'place-ladder', reference: pv.reference }], 'ladder placed')
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
      lastNote: plan.last_note,
      lastError: plan.last_error,
      lastBreakout: breakout,
      createdAt: plan.created_at,
      updatedAt: plan.updated_at,
    }
  }

  function list(includeStopped = false): PlanStatus[] {
    return store.list(includeStopped).map((p) => status(p.id)!).filter(Boolean)
  }

  return { preview, create, stop, status, list, tick, tickPlan }
}

export type AccumulateService = ReturnType<typeof createAccumulateService>

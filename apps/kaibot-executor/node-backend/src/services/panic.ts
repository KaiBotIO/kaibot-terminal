// PANIC — offline-proof close-all.
//
// Reads every connected adapter's OPEN positions directly and closes each at
// market with a reduce-only order, straight through the exchange adapter — NOT
// via a cloud signal. The executor holds the keys and talks to the venue itself,
// so this still flattens when the cloud / WS is down (the whole reason it lives
// here and not server-side). Every action is audit-logged.
//
// Side / quantity come from the LIVE position (the exchange is the source of
// truth), mirroring executeCloseSignal: close side is opposite the position side,
// reduce-only so it can only ever shrink the position, market so it fills now.
//
// After the flatten, each filled close is booked like any other venue exit
// (exit fill, execution closed, protective state retired, server told): an
// unbooked PANIC leaves the book expecting a position the broker no longer
// holds (06/10 incident: Deribit rides open locally, three server rows open).
//
// panicCloseAccount is the daily-loss trip's variant: the same close path, but
// only one exchange+account's positions and an account halt instead of the
// global one (06/10: a Deribit loss flattened TradeStation too).

import type { KaiBotDatabase } from '../storage/database.js'
import type { ExchangeManager } from './exchanges/exchangeManager.js'
import type { ExchangeAdapter, Order, OrderResult, OrderStatus, Position } from './exchanges/types.js'
import { accountKeyOf, adapterAccountKey, rowOnAccount } from './exchanges/account-scope.js'
import { rootOf } from './exchanges/futures-contracts.js'
import { attributeVenueExit } from './exit-attribution.js'
import { notificationBus } from './notifications/notification-bus.js'

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export interface PanicCloseResult {
  exchange: string
  symbol: string
  accountId: string
  side: 'buy' | 'sell' // the flattening side (opposite the position)
  size: number
  ok: boolean
  orderId?: string
  error?: string
}

export interface PanicReport {
  closed: number // positions where the close order was accepted
  failed: number // positions where the close order errored
  results: PanicCloseResult[]
  halted: boolean // whether the local halt flag was set ('panic & halt')
  scope?: PanicScope // set when only one account was flattened (and halted)
}

/** One exchange+account, as the daily-loss limit is configured. */
export interface PanicScope {
  exchange: string
  accountId: string
}

type ExitFill = { price: number | null; timeMs: number; orderId?: string | null }

/** sent=false: not confirmed by the server. kept: deliberately local (fan-out still held), done. */
export type VenueExitReportResult = { sent: boolean; kept?: boolean; reason?: string }

export interface PanicHooks {
  reportVenueExit?: (positionId: string, fill: ExitFill) => Promise<VenueExitReportResult | void>
  /** Cancel + drop a signal's bracket legs (signal client's retireBracket). */
  retireProtections?: (exchange: string, signalId: string) => Promise<void>
}

// Wired once at boot (signal client), so every PANIC caller books the same way.
let defaultHooks: PanicHooks = {}
export function registerPanicHooks(hooks: PanicHooks): void {
  defaultHooks = hooks
}

export interface PanicOptions extends PanicHooks {
  halt: boolean
  userId?: string
  reason?: string
  /** Per server report; a slow API must not hold up the rest. */
  reportTimeoutMs?: number
  /** Fill polling for closes the ack didn't fill (no cancel: a PANIC close must stand). */
  settle?: { attempts?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> }
}

interface PlacedClose {
  exchange: string
  adapter: ExchangeAdapter
  position: Position
  side: 'buy' | 'sell'
  size: number
  result: OrderResult
}

interface CloseFill {
  qty: number
  price: number | null
  commission?: number
  feeNative?: number
  feeCurrency?: string
  filledAtMs?: number
}

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// The fill of a PANIC close: the ack when it already carries a price (Deribit
// market orders fill inside the place call), else the order status, polled.
async function closeFillOf(c: PlacedClose, settle: PanicOptions['settle']): Promise<CloseFill | null> {
  const r = c.result
  const qtyOf = (q?: number) => (q && q > 0 ? q : c.size)
  if (r.status === 'filled' && r.averagePrice && r.averagePrice > 0) {
    return {
      qty: qtyOf(r.filledQuantity),
      price: r.averagePrice,
      commission: r.commission,
      feeNative: r.feeNative,
      feeCurrency: r.feeCurrency,
    }
  }
  if (!c.adapter.getOrderStatus) {
    return r.status === 'filled' ? { qty: qtyOf(r.filledQuantity), price: null } : null
  }
  const attempts = settle?.attempts ?? 20
  const intervalMs = settle?.intervalMs ?? 500
  const sleep = settle?.sleep ?? sleepMs
  const ctx = { accountId: c.position.accountId, symbol: c.position.symbol }
  for (let i = 0; i < attempts; i++) {
    let st: OrderStatus | null = null
    try {
      st = await c.adapter.getOrderStatus(r.orderId, ctx)
    } catch {
      st = null
    }
    if (st?.state === 'filled') {
      return {
        qty: qtyOf(st.filledQuantity),
        price: st.averagePrice && st.averagePrice > 0 ? st.averagePrice : null,
        commission: st.commission,
        feeNative: st.feeNative,
        feeCurrency: st.feeCurrency,
        filledAtMs: st.filledAtMs,
      }
    }
    if (st?.state === 'cancelled' || st?.state === 'rejected') return null
    await sleep(intervalMs)
  }
  return null
}

// Server-managed positions (server exits, rides) riding on this venue position.
// Read BEFORE booking: booking closes the executions this matches on.
function serverStatesOn(db: KaiBotDatabase, exchange: string, p: Position) {
  return db.listActiveServerExitStates(exchange).filter((state) => {
    const exec = db.getSignalExecution(state.entry_signal_id)
    if (!exec || (exec.status !== 'open' && exec.status !== 'closing')) return false
    if (!rowOnAccount(exec.account_id, p.accountId)) return false
    return exec.symbol === p.symbol || rootOf(exec.symbol) === rootOf(p.symbol)
  })
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

async function bookClose(db: KaiBotDatabase, hooks: PanicHooks, c: PlacedClose, opts: PanicOptions) {
  const settle = opts.settle
  const { exchange, position: p } = c
  const states = serverStatesOn(db, exchange, p)

  let fill: CloseFill | null = null
  try {
    fill = await closeFillOf(c, settle)
  } catch (err) {
    db.log('error', 'trading', 'PANIC: close fill lookup failed', { exchange, symbol: p.symbol, error: errMsg(err) })
  }

  const closedSignals = new Set<string>()
  if (fill) {
    const booked = attributeVenueExit(db, {
      exchange,
      accountId: p.accountId,
      symbol: p.symbol,
      side: c.side,
      qty: fill.qty,
      price: fill.price,
      orderId: c.result.orderId,
      commission: fill.commission ?? null,
      feeNative: fill.feeNative ?? null,
      feeCurrency: fill.feeCurrency ?? null,
      filledAtMs: fill.filledAtMs ?? null,
      reason: 'closed by PANIC',
    })
    for (const a of booked) if (a.fullyClosed) closedSignals.add(a.signalId)
    db.log('warn', 'trading', 'PANIC: close booked', {
      exchange,
      symbol: p.symbol,
      orderId: c.result.orderId,
      qty: fill.qty,
      price: fill.price,
      attributed: booked.map((b) => ({ signalId: b.signalId, qty: b.qty })),
    })
  } else {
    // Unconfirmed close (rejected, cancelled, still working): the position may
    // still be open, so its stops stay and the server is not told it's flat.
    db.log('error', 'trading', 'PANIC: close not confirmed filled, left to the reconciler', {
      exchange,
      symbol: p.symbol,
      orderId: c.result.orderId,
    })
    return
  }

  // Protective state of every execution the close ended. Venue legs may already
  // be gone; the cancel failing is fine, the rows must not linger.
  for (const state of states) closedSignals.add(state.entry_signal_id)
  for (const signalId of closedSignals) {
    db.deactivateLocalTrail(signalId)
    try {
      await hooks.retireProtections?.(exchange, signalId)
    } catch (err) {
      db.log('warn', 'trading', 'PANIC: protection retire failed', { exchange, signalId, error: errMsg(err) })
    }
  }

  const exitFill: ExitFill = {
    price: fill.price,
    timeMs: fill.filledAtMs ?? Date.now(),
    orderId: c.result.orderId,
  }
  // The exit state stays active until the server confirmed: a failed report
  // must stay visible (error + notification), not vanish with the row.
  await Promise.allSettled(
    states.map(async (state) => {
      const fail = (reason: string) => {
        db.log('error', 'trading', 'PANIC: venue exit not reported to server', {
          positionId: state.position_id,
          exchange,
          symbol: p.symbol,
          reason,
        })
        notificationBus.publish({
          type: 'error',
          title: 'PANIC: server position still open',
          body: `${p.symbol} (${exchange}): exit not reported (${reason}). Run the repair or close it on the server.`,
          data: { positionId: state.position_id, exchange, symbol: p.symbol },
        })
      }
      if (!hooks.reportVenueExit) return fail('no reporter wired')
      try {
        const res = await withTimeout(hooks.reportVenueExit(state.position_id, exitFill), opts.reportTimeoutMs ?? 10_000)
        if (res && !res.sent && !res.kept) return fail(res.reason ?? 'not sent')
        db.deactivateServerExitState(state.position_id)
        db.log('warn', 'trading', 'PANIC: venue exit reported to server', {
          positionId: state.position_id,
          exchange,
          symbol: p.symbol,
          price: exitFill.price,
          orderId: exitFill.orderId,
        })
      } catch (err) {
        fail(errMsg(err))
      }
    }),
  )
}

/**
 * Close every open position across all connected exchanges at market via the
 * adapters directly. `halt` also sets the local halt flag so the signal-client
 * stops acting on further inbound signals until it's cleared.
 *
 * Per-position failures are isolated (one venue erroring doesn't abort the rest)
 * and every attempt is audit-logged. All closes are placed first; booking them
 * (which may wait on a fill) comes after, so it never delays the flatten.
 */
export function panicCloseAll(
  db: KaiBotDatabase,
  exchangeManager: ExchangeManager,
  opts: PanicOptions = { halt: false },
): Promise<PanicReport> {
  return flatten(db, exchangeManager, opts)
}

/**
 * panicCloseAll for one exchange+account: only its open positions close, and
 * `halt` halts that account (account_halts), never the whole executor.
 */
export function panicCloseAccount(
  db: KaiBotDatabase,
  exchangeManager: ExchangeManager,
  scope: PanicScope,
  opts: PanicOptions = { halt: false },
): Promise<PanicReport> {
  return flatten(db, exchangeManager, opts, scope)
}

async function flatten(
  db: KaiBotDatabase,
  exchangeManager: ExchangeManager,
  opts: PanicOptions,
  scope?: PanicScope,
): Promise<PanicReport> {
  const userId = opts.userId ?? 'default'
  const hooks: PanicHooks = {
    reportVenueExit: opts.reportVenueExit ?? defaultHooks.reportVenueExit,
    retireProtections: opts.retireProtections ?? defaultHooks.retireProtections,
  }
  db.log('warn', 'trading', scope ? 'PANIC invoked: closing one account' : 'PANIC invoked: closing all positions', {
    halt: opts.halt,
    reason: opts.reason ?? 'manual',
    ...(scope ?? {}),
  })

  const results: PanicCloseResult[] = []
  const placed: PlacedClose[] = []

  // Halt FIRST when requested, so any signal racing in while we flatten is
  // already gated. Clearing is a deliberate separate user action.
  if (opts.halt && scope) {
    db.setAccountHalt(scope.exchange, scope.accountId, true, opts.reason ?? 'panic')
    db.log('warn', 'trading', 'PANIC: account halted (no new opens on it until re-enabled)', { ...scope })
  } else if (opts.halt) {
    db.setHaltState(true, opts.reason ?? 'panic')
    db.log('warn', 'trading', 'PANIC: executor halted (will ignore inbound signals until re-enabled)', {})
  }

  const sessions = await exchangeManager.getAllSessions(userId)
  for (const session of sessions) {
    if (session.status !== 'connected') continue
    const exchange = session.exchangeName
    if (scope && (exchange !== scope.exchange || adapterAccountKey(session.adapter) !== accountKeyOf(scope.accountId))) continue
    let positions: Position[] = []
    try {
      positions = await session.adapter.getPositions()
    } catch (err) {
      db.log('error', 'trading', 'PANIC: getPositions failed', { exchange, error: errMsg(err) })
      continue
    }

    for (const p of positions) {
      const size = Math.abs(p.size)
      if (size <= 0) continue
      if (scope && !rowOnAccount(p.accountId || null, scope.accountId)) continue
      const side: 'buy' | 'sell' = p.side === 'long' ? 'sell' : 'buy'
      const order: Order = {
        accountId: p.accountId,
        symbol: p.symbol,
        side,
        orderType: 'market',
        quantity: size,
        reduceOnly: true,
        label: `kaibot:panic:close`,
      }
      try {
        const result = await session.adapter.placeOrder(order)
        results.push({ exchange, symbol: p.symbol, accountId: p.accountId, side, size, ok: true, orderId: result.orderId })
        placed.push({ exchange, adapter: session.adapter, position: p, side, size, result })
        db.log('warn', 'trading', 'PANIC: close order placed', {
          exchange,
          symbol: p.symbol,
          accountId: p.accountId,
          side,
          size,
          orderId: result.orderId,
          status: result.status,
        })
      } catch (err) {
        results.push({ exchange, symbol: p.symbol, accountId: p.accountId, side, size, ok: false, error: errMsg(err) })
        db.log('error', 'trading', 'PANIC: close order failed', {
          exchange,
          symbol: p.symbol,
          accountId: p.accountId,
          side,
          size,
          error: errMsg(err),
        })
      }
    }
  }

  await Promise.allSettled(
    placed.map(async (c) => {
      try {
        await bookClose(db, hooks, c, opts)
      } catch (err) {
        db.log('error', 'trading', 'PANIC: booking the close failed', {
          exchange: c.exchange,
          symbol: c.position.symbol,
          orderId: c.result.orderId,
          error: errMsg(err),
        })
      }
    }),
  )

  const closed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok).length
  db.log('warn', 'trading', 'PANIC complete', { closed, failed, halted: opts.halt, ...(scope ?? {}) })
  return scope ? { closed, failed, results, halted: opts.halt, scope } : { closed, failed, results, halted: opts.halt }
}

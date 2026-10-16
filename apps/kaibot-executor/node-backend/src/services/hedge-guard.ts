// Edge hedge guard: the user arms a protective hedge on an open position the
// way they arm a stop — trigger level, sizing and wind-down policy are authored
// up front, the edge only executes. On an adverse breach of the trigger the
// executor opens an OPPOSITE position on a DIFFERENT (paired) instrument
// (BTC-PERPETUAL ↔ BTC_USDC-PERPETUAL): one venue instrument holds one net
// position, so a same-symbol hedge would net the main position away — the
// synthetic-mint conflict. The hedge leg gets its own position key and is
// auto-linked into the main position's group.
//
// Legacy parity (kaibotautomationaddon handleHedging, decisionFlow.ts:218-342):
//  - trigger = adverse breach of referencePrice/startHedgingAfter (long: price
//    below, short: price above); firing is one-shot, re-arming is manual;
//  - sizing = the automation's configured quantity (flat hedge) or the live
//    underwater size (dynamic hedge) — here 'fixed-usd' / 'match';
//  - wind-down when the main closes = the hedge stays standing, frozen
//    ('keep', legacy Block A) — 'close' is the opt-in safer deviation;
//  - recoveryPrice is the edge analog of the legacy fullRecovery unwind
//    (legacy used size-equality on the DCA pair; a flat edge hedge has no
//    growing leg, so a price level replaces it — documented deviation);
//  - the main position's resting entry rungs are NOT cancelled at hedge time
//    (legacy leaves the ladder standing).
//
// Same carve-out as exits/rollover: this is edge execution of a pre-authorized
// protective instruction, no server signal, no autonomous decision. The edge
// manager runtime's protect/reduce-only sanitizer is untouched — the hedge is
// a dedicated service, not a widened manager action channel.

import type { KaiBotDatabase } from '../storage/database.js'
import type { HedgeGuardRow } from '../storage/types.js'
import type { ExchangeManager } from './exchanges/exchangeManager.js'
import type { ExchangeAdapter, OrderResult, Position } from './exchanges/types.js'
import type { ManualTradeDeps } from './manual-trade.js'
import type { NotificationBus } from './notifications/notification-bus.js'
import { withOrderLock } from './order-lock.js'
import { settleAdapterOrder, type SettleOptions } from './order-settlement.js'
import {
  ensureContractConstraints,
  getContractConstraints,
  type ContractConstraints,
} from './exchanges/contract-constraints.js'
import { positionTrailKey } from './position-trail.js'
import { autoLinkPosition } from './position-groups.js'
import { usdToNativeSize, nativeToUsdNotional } from '@kaibot/types/core'
import { randomUUID } from 'crypto'
import { accountKeyOf, adapterAccountKey } from './exchanges/account-scope.js'

export type HedgeSizeMode = 'match' | 'fixed-usd'
export type HedgeOnMainClose = 'keep' | 'close'

export interface HedgeArmInput {
  exchange: string
  symbol: string
  accountId?: string
  triggerPrice: number
  hedgeSymbol?: string
  hedgeAccountId?: string
  sizeMode?: HedgeSizeMode
  fixedUsd?: number
  recoveryPrice?: number | null
  onMainClose?: HedgeOnMainClose
}

export interface HedgeUpdateInput {
  exchange: string
  symbol: string
  accountId?: string
  triggerPrice?: number
  hedgeSymbol?: string
  hedgeAccountId?: string
  sizeMode?: HedgeSizeMode
  fixedUsd?: number | null
  recoveryPrice?: number | null
  onMainClose?: HedgeOnMainClose
}

export interface HedgeKeyInput {
  exchange: string
  symbol: string
  accountId?: string
}

export interface HedgeGuardView {
  positionKey: string
  exchange: string
  accountId: string
  symbol: string
  direction: 'long' | 'short'
  hedgeSymbol: string
  hedgeAccountId: string
  triggerPrice: number
  sizeMode: HedgeSizeMode
  fixedUsd: number | null
  recoveryPrice: number | null
  onMainClose: HedgeOnMainClose
  status: HedgeGuardRow['status']
  hedgeSide: 'buy' | 'sell' | null
  hedgeQty: number | null
  hedgeEntryPrice: number | null
  hedgeOpenedTs: number | null
  closeReason: string | null
  lastError: string | null
}

export interface HedgeGuardService {
  arm(input: HedgeArmInput): Promise<HedgeGuardView>
  update(input: HedgeUpdateInput): Promise<HedgeGuardView>
  disarm(input: HedgeKeyInput): Promise<HedgeGuardView>
  close(input: HedgeKeyInput): Promise<HedgeGuardView>
  list(): HedgeGuardView[]
  /** Exchanges with at least one active guard (for the tick loop's fetch set). */
  activeExchanges(): string[]
  /** Drive every active guard on one exchange with this cycle's positions. */
  tickExchange(exchange: string, adapter: ExchangeAdapter, positions: Position[]): Promise<void>
}

// ── Pure rules (unit-testable, DB/adapter-free) ─────────────────────────────

// Adverse breach of the trigger level (legacy compare(price,'<',ref,positive)):
// long main → price below the trigger; short main → price above it.
export function hedgeTriggerBreached(
  direction: 'long' | 'short',
  price: number,
  triggerPrice: number,
): boolean {
  return direction === 'long' ? price < triggerPrice : price > triggerPrice
}

// Recovery past the level in the MAIN's favourable direction closes the hedge.
export function hedgeRecoveryReached(
  direction: 'long' | 'short',
  price: number,
  recoveryPrice: number,
): boolean {
  return direction === 'long' ? price > recoveryPrice : price < recoveryPrice
}

// Default paired instrument: the same underlying on the opposite Deribit
// contract family (inverse coin-margined ↔ linear USDC). Other venues have no
// canonical pair — the user passes hedgeSymbol explicitly.
export function defaultHedgeSymbolFor(exchange: string, symbol: string): string | null {
  if (exchange.toLowerCase() !== 'deribit') return null
  const s = symbol.toUpperCase()
  let m = s.match(/^([A-Z]+)_USDC-PERPETUAL$/)
  if (m) return `${m[1]}-PERPETUAL`
  m = s.match(/^([A-Z]+)-PERPETUAL$/)
  if (m) return `${m[1]}_USDC-PERPETUAL`
  return null
}

// Deribit account = settle currency, derived the same way the adapter does.
export function deribitAccountIdFor(symbol: string): string | null {
  const s = symbol.toUpperCase()
  if (s.includes('_USDC')) return 'usdc'
  if (s.startsWith('BTC')) return 'btc'
  if (s.startsWith('ETH')) return 'eth'
  return null
}

export interface HedgeOpenPlan {
  side: 'buy' | 'sell'
  qty: number
  usdNotional: number
}

// Size the hedge leg. 'match' = the main position's USD notional at trigger
// time (legacy dynamic hedge: |underwater size|; on Deribit inverse the size
// IS the USD notional); 'fixed-usd' = the authored notional (legacy flat hedge
// quantity). Converted to the hedge instrument's native quantity via the shared
// coin/USD sizing — fail closed when a linear leg has no price.
export function computeHedgeOpenPlan(input: {
  exchange: string
  mainSymbol: string
  mainSide: 'long' | 'short'
  mainSize: number
  mainPrice: number | null
  hedgeSymbol: string
  hedgePrice: number | null
  sizeMode: HedgeSizeMode
  fixedUsd: number | null
  constraints: ContractConstraints
}): HedgeOpenPlan | { error: string } {
  let usdNotional: number | null
  if (input.sizeMode === 'fixed-usd') {
    usdNotional = input.fixedUsd
    if (usdNotional == null || !(usdNotional > 0)) return { error: 'fixed-usd sizing needs a positive fixedUsd' }
  } else {
    usdNotional = nativeToUsdNotional({
      exchange: input.exchange,
      symbol: input.mainSymbol,
      size: input.mainSize,
      price: input.mainPrice ?? undefined,
    })
    if (usdNotional == null || !(usdNotional > 0)) {
      return { error: `cannot value the main position in USD (no price for ${input.mainSymbol})` }
    }
  }
  const r = usdToNativeSize({
    exchange: input.exchange,
    symbol: input.hedgeSymbol,
    usdNotional,
    price: input.hedgePrice ?? undefined,
    stepSize: input.constraints.stepSize,
    minSize: input.constraints.minSize,
  })
  if (r.priceMissing) return { error: `no price for ${input.hedgeSymbol} — cannot size the hedge` }
  if (!(r.size > 0) || r.belowMin) {
    return { error: `hedge size ${r.size} below the ${input.hedgeSymbol} minimum` }
  }
  return {
    side: input.mainSide === 'long' ? 'sell' : 'buy',
    qty: r.size,
    usdNotional,
  }
}

// ── Service ─────────────────────────────────────────────────────────────────

export function createHedgeGuardService(
  db: KaiBotDatabase,
  exchangeManager: ExchangeManager,
  deps: ManualTradeDeps = {},
  settleOptions: SettleOptions = {},
  notifications: NotificationBus | null = null,
): HedgeGuardService {
  const userId = deps.userId ?? 'default'

  async function adapterFor(exchange: string, accountId?: string | null): Promise<ExchangeAdapter> {
    const session = await exchangeManager.getSession(userId, exchange, accountKeyOf(accountId))
    if (!session || session.status !== 'connected') {
      throw new Error(`exchange ${exchange} not connected`)
    }
    return session.adapter
  }

  function toView(row: HedgeGuardRow): HedgeGuardView {
    return {
      positionKey: row.position_key,
      exchange: row.exchange,
      accountId: row.account_id,
      symbol: row.symbol,
      direction: row.direction,
      hedgeSymbol: row.hedge_symbol,
      hedgeAccountId: row.hedge_account_id,
      triggerPrice: row.trigger_price,
      sizeMode: row.size_mode,
      fixedUsd: row.fixed_usd,
      recoveryPrice: row.recovery_price,
      onMainClose: row.on_main_close,
      status: row.status,
      hedgeSide: row.hedge_side,
      hedgeQty: row.hedge_qty,
      hedgeEntryPrice: row.hedge_entry_price,
      hedgeOpenedTs: row.hedge_opened_ts,
      closeReason: row.close_reason,
      lastError: row.last_error,
    }
  }

  function findLive(positions: Position[], symbol: string, accountId?: string | null) {
    return positions.find(
      (p) =>
        p.symbol.toLowerCase() === symbol.toLowerCase() &&
        Math.abs(p.size) > 0 &&
        (accountId == null || p.accountId === accountId),
    )
  }

  function requireRow(input: HedgeKeyInput): { key: string; row: HedgeGuardRow } {
    // The stored account may differ from the caller's (arm resolved it from the
    // live position) — fall back to the symbol match on this exchange.
    if (input.accountId) {
      const key = positionTrailKey(input.exchange, input.accountId, input.symbol)
      const row = db.getHedgeGuard(key)
      if (row && row.active === 1) return { key, row }
    }
    const match = db
      .listActiveHedgeGuards()
      .find(
        (r) =>
          r.exchange === input.exchange.toLowerCase() &&
          r.symbol === input.symbol.toUpperCase() &&
          (input.accountId == null || r.account_id === input.accountId),
      )
    if (!match) throw new Error(`no active hedge guard for ${input.symbol}`)
    return { key: match.position_key, row: match }
  }

  function notifyOnce(row: HedgeGuardRow, error: string, title: string) {
    // One notification per distinct failure — the tick retries every cycle.
    if (row.last_error !== error) {
      notifications?.publish({
        type: 'hedge_failed',
        title,
        body: `${row.symbol}: ${error}`,
        data: { key: row.position_key, symbol: row.symbol, hedgeSymbol: row.hedge_symbol, error },
      })
    }
    db.updateHedgeGuard(row.position_key, { lastError: error })
  }

  // Link the hedge leg into the main position's group; without one, create a
  // manual group holding both so the pair is visible as one unit.
  function linkHedgeIntoGroup(row: HedgeGuardRow) {
    const mainKey = row.position_key
    const mainLink = db.getPositionGroupLink(mainKey)
    let groupId = mainLink?.group_id ?? null
    if (!groupId) {
      groupId = randomUUID()
      db.createPositionGroup({ id: groupId, name: `${row.symbol} + hedge`, source: 'manual' })
      autoLinkPosition(db, {
        exchange: row.exchange,
        accountId: row.account_id,
        symbol: row.symbol,
        groupId,
      })
    }
    autoLinkPosition(db, {
      exchange: row.exchange,
      accountId: row.hedge_account_id,
      symbol: row.hedge_symbol,
      groupId,
    })
  }

  async function arm(input: HedgeArmInput): Promise<HedgeGuardView> {
    if (!(Number.isFinite(input.triggerPrice) && input.triggerPrice > 0)) {
      throw new Error('triggerPrice must be a positive number')
    }
    const sizeMode: HedgeSizeMode = input.sizeMode ?? 'match'
    if (sizeMode === 'fixed-usd' && !(input.fixedUsd != null && input.fixedUsd > 0)) {
      throw new Error('fixed-usd sizing needs a positive fixedUsd')
    }
    if (input.recoveryPrice != null && !(Number.isFinite(input.recoveryPrice) && input.recoveryPrice > 0)) {
      throw new Error('recoveryPrice must be a positive number')
    }

    const adapter = await adapterFor(input.exchange, input.accountId)
    const positions = await adapter.getPositions()
    const main = findLive(positions, input.symbol, input.accountId)
    if (!main) throw new Error(`no open position for ${input.symbol}`)
    const accountId = input.accountId ?? main.accountId

    const hedgeSymbol = (input.hedgeSymbol ?? defaultHedgeSymbolFor(input.exchange, main.symbol))?.toUpperCase()
    if (!hedgeSymbol) {
      throw new Error(`no default hedge instrument for ${main.symbol} — pass hedgeSymbol explicitly`)
    }
    if (hedgeSymbol === main.symbol.toUpperCase()) {
      throw new Error(
        'hedge instrument must differ from the position instrument (one instrument holds one net position — a same-symbol hedge would net the position away)',
      )
    }
    const hedgeAccountId =
      input.hedgeAccountId ??
      (input.exchange.toLowerCase() === 'deribit' ? deribitAccountIdFor(hedgeSymbol) : null) ??
      accountId

    const key = positionTrailKey(input.exchange, accountId, main.symbol)
    const existing = db.getHedgeGuard(key)
    if (existing && existing.active === 1) {
      throw new Error('a hedge guard is already active for this position — update or disarm it first')
    }

    db.insertHedgeGuard({
      positionKey: key,
      exchange: input.exchange,
      accountId,
      symbol: main.symbol,
      direction: main.side,
      hedgeSymbol,
      hedgeAccountId,
      triggerPrice: input.triggerPrice,
      sizeMode,
      fixedUsd: input.fixedUsd ?? null,
      recoveryPrice: input.recoveryPrice ?? null,
      onMainClose: input.onMainClose ?? 'keep',
    })
    db.log('info', 'trading', 'Hedge guard armed', {
      key, symbol: main.symbol, hedgeSymbol, triggerPrice: input.triggerPrice, sizeMode,
    })
    return toView(db.getHedgeGuard(key)!)
  }

  async function update(input: HedgeUpdateInput): Promise<HedgeGuardView> {
    const { key, row } = requireRow(input)
    if (row.status === 'hedged') {
      // The leg is live: only the wind-down knobs may move.
      if (
        input.triggerPrice != null || input.sizeMode != null || input.fixedUsd !== undefined ||
        input.hedgeSymbol != null || input.hedgeAccountId != null
      ) {
        throw new Error('hedge is open — only recoveryPrice and onMainClose can be updated')
      }
    }
    if (input.triggerPrice != null && !(Number.isFinite(input.triggerPrice) && input.triggerPrice > 0)) {
      throw new Error('triggerPrice must be a positive number')
    }
    if (input.recoveryPrice != null && !(Number.isFinite(input.recoveryPrice) && input.recoveryPrice > 0)) {
      throw new Error('recoveryPrice must be a positive number')
    }
    const sizeMode = input.sizeMode ?? row.size_mode
    const fixedUsd = input.fixedUsd !== undefined ? input.fixedUsd : row.fixed_usd
    if (sizeMode === 'fixed-usd' && !(fixedUsd != null && fixedUsd > 0)) {
      throw new Error('fixed-usd sizing needs a positive fixedUsd')
    }
    if (input.hedgeSymbol != null && input.hedgeSymbol.toUpperCase() === row.symbol) {
      throw new Error('hedge instrument must differ from the position instrument')
    }
    db.updateHedgeGuard(key, {
      triggerPrice: input.triggerPrice,
      sizeMode: input.sizeMode,
      fixedUsd: input.fixedUsd,
      recoveryPrice: input.recoveryPrice,
      onMainClose: input.onMainClose,
      hedgeSymbol: input.hedgeSymbol,
      hedgeAccountId:
        input.hedgeAccountId ??
        (input.hedgeSymbol != null && row.exchange === 'deribit'
          ? deribitAccountIdFor(input.hedgeSymbol) ?? undefined
          : undefined),
    })
    return toView(db.getHedgeGuard(key)!)
  }

  async function disarm(input: HedgeKeyInput): Promise<HedgeGuardView> {
    const { key, row } = requireRow(input)
    if (row.status === 'hedged') {
      throw new Error('hedge is open — close it instead of disarming')
    }
    db.updateHedgeGuard(key, { status: 'closed', closeReason: 'disarmed', active: 0 })
    db.log('info', 'trading', 'Hedge guard disarmed', { key, symbol: row.symbol })
    return toView(db.getHedgeGuard(key)!)
  }

  async function close(input: HedgeKeyInput): Promise<HedgeGuardView> {
    const { key, row } = requireRow(input)
    if (row.status !== 'hedged') throw new Error('no open hedge to close')
    const adapter = await adapterFor(row.exchange, row.hedge_account_id)
    await executeHedgeClose(adapter, row, 'manual')
    return toView(db.getHedgeGuard(key)!)
  }

  function list(): HedgeGuardView[] {
    return db.listHedgeGuards().map(toView)
  }

  function activeExchanges(): string[] {
    return [...new Set(db.listActiveHedgeGuards().map((r) => r.exchange))]
  }

  async function tickExchange(
    exchange: string,
    adapter: ExchangeAdapter,
    positions: Position[],
  ): Promise<void> {
    // Only this connection's guards: the adapter/positions passed in belong to
    // one connection, and a guard on another connection would read a flat
    // main here and wind itself down.
    const connectionKey = adapterAccountKey(adapter)
    const rows = db
      .listActiveHedgeGuards()
      .filter((r) => r.exchange === exchange.toLowerCase() && accountKeyOf(r.account_id) === connectionKey)
    for (const row of rows) {
      try {
        if (row.status === 'armed') {
          await tickArmed(adapter, row, positions)
        } else if (row.status === 'hedged') {
          await tickHedged(adapter, row, positions)
        }
      } catch (err: any) {
        db.log('error', 'trading', 'Hedge guard tick failed', {
          key: row.position_key, error: err?.message,
        })
      }
    }
  }

  async function tickArmed(adapter: ExchangeAdapter, row: HedgeGuardRow, positions: Position[]) {
    const main = findLive(positions, row.symbol, row.account_id)
    if (!main) {
      // The position closed before the trigger ever fired — the guard retires
      // with it (legacy: an automation without its position stops mattering).
      db.updateHedgeGuard(row.position_key, {
        status: 'closed', closeReason: 'main-flat-before-trigger', active: 0,
      })
      db.log('info', 'trading', 'Hedge guard retired (position flat)', {
        key: row.position_key, symbol: row.symbol,
      })
      return
    }
    const price = main.markPrice
    if (price == null || !(price > 0)) return
    if (!hedgeTriggerBreached(row.direction, price, row.trigger_price)) return
    await executeHedgeOpen(adapter, row)
  }

  async function tickHedged(adapter: ExchangeAdapter, row: HedgeGuardRow, positions: Position[]) {
    const hedge = findLive(positions, row.hedge_symbol, row.hedge_account_id)
    if (!hedge) {
      // Closed outside the guard (manual close, its own stop) — record and stop.
      db.updateHedgeGuard(row.position_key, {
        status: 'closed', closeReason: 'hedge-closed-externally', active: 0,
      })
      db.log('info', 'trading', 'Hedge guard closed (hedge leg flat)', {
        key: row.position_key, hedgeSymbol: row.hedge_symbol,
      })
      return
    }
    const main = findLive(positions, row.symbol, row.account_id)
    if (!main) {
      if (row.on_main_close === 'close') {
        await executeHedgeClose(adapter, row, 'main-closed')
      } else {
        // Legacy wind-down: the hedge stays standing, frozen — the guard is
        // done, the leg is now a plain position (attach a stop/trail to it).
        db.updateHedgeGuard(row.position_key, { status: 'orphaned', active: 0 })
        db.log('warn', 'trading', 'Hedge kept standing (main position closed)', {
          key: row.position_key, hedgeSymbol: row.hedge_symbol, hedgeQty: row.hedge_qty,
        })
        notifications?.publish({
          type: 'hedge_orphaned',
          title: 'Hedge kept standing',
          body: `${row.symbol} closed; its hedge on ${row.hedge_symbol} is still open and now unmanaged — close it or protect it.`,
          data: { key: row.position_key, hedgeSymbol: row.hedge_symbol },
        })
      }
      return
    }
    if (row.recovery_price != null) {
      const price = main.markPrice
      if (price != null && price > 0 && hedgeRecoveryReached(row.direction, price, row.recovery_price)) {
        await executeHedgeClose(adapter, row, 'recovery')
      }
    }
  }

  async function executeHedgeOpen(adapter: ExchangeAdapter, row: HedgeGuardRow): Promise<void> {
    await withOrderLock(row.exchange, async () => {
      // Re-read state inside the lock: the trigger tick's numbers may be stale.
      const fresh = db.getHedgeGuard(row.position_key)
      if (!fresh || fresh.active !== 1 || fresh.status !== 'armed') return
      let positions: Position[]
      try {
        positions = await adapter.getPositions()
      } catch {
        return
      }
      const main = findLive(positions, row.symbol, row.account_id)
      if (!main) return // retires on the next tick

      await ensureContractConstraints(row.exchange, row.hedge_symbol)
      const constraints = getContractConstraints(row.exchange, row.hedge_symbol)
      let hedgePrice: number | null = null
      try {
        hedgePrice = (await adapter.getLastPrice?.(row.hedge_symbol)) ?? null
      } catch {
        hedgePrice = null
      }
      const plan = computeHedgeOpenPlan({
        exchange: row.exchange,
        mainSymbol: row.symbol,
        mainSide: main.side,
        mainSize: main.size,
        mainPrice: main.markPrice ?? main.entryPrice ?? null,
        hedgeSymbol: row.hedge_symbol,
        hedgePrice,
        sizeMode: row.size_mode,
        fixedUsd: row.fixed_usd,
        constraints,
      })
      if ('error' in plan) {
        db.log('warn', 'trading', 'Hedge open blocked', { key: row.position_key, error: plan.error })
        notifyOnce(fresh, plan.error, 'Hedge not opened')
        return
      }

      const placed = await adapter.placeOrder({
        accountId: row.hedge_account_id,
        symbol: row.hedge_symbol,
        side: plan.side,
        orderType: 'market',
        quantity: plan.qty,
        reduceOnly: false,
        label: `kaibot:${row.position_key}:hedge-open`,
      })
      const settlementId = db.insertOrderSettlement({
        signalId: `hedge:${row.position_key}:open`,
        exchange: row.exchange,
        accountId: row.hedge_account_id,
        symbol: row.hedge_symbol,
        kind: 'entry',
        side: plan.side,
        qty: plan.qty,
        orderId: placed.orderId,
        targetLabel: 'hedge-open',
        status: 'unknown',
      })
      const settled = await settleAdapterOrder(
        adapter,
        placed.orderId,
        { symbol: row.hedge_symbol, accountId: row.hedge_account_id },
        settleOptions,
      )
      const src = adapter.getOrderStatus ? settled.status : placed.status
      const filledQty = settled.filledQuantity ?? placed.filledQuantity ?? 0
      const avgPrice = settled.averagePrice ?? placed.averagePrice ?? null

      if (src === 'rejected' || src === 'cancelled') {
        db.resolveOrderSettlement(settlementId, src)
        const reason = placed.message ?? src
        db.log('warn', 'trading', 'Hedge open order failed — guard stays armed', {
          key: row.position_key, hedgeSymbol: row.hedge_symbol, reason,
        })
        notifyOnce(fresh, `hedge order ${src}: ${reason}`, 'Hedge not opened')
        return
      }
      if (src === 'filled' || src === 'partially_filled') {
        db.resolveOrderSettlement(settlementId, 'filled')
      }
      // 'unknown' proceeds like the roll's open leg: the settlement row is
      // reconciled later; better a tracked maybe-hedge than a silent retry loop.
      const qty = filledQty > 0 ? filledQty : plan.qty
      db.addManualPosition(row.exchange, row.hedge_account_id, row.hedge_symbol, plan.side, qty)
      db.updateHedgeGuard(row.position_key, {
        status: 'hedged',
        hedgeSide: plan.side,
        hedgeQty: qty,
        hedgeEntryPrice: avgPrice,
        hedgeOpenedTs: Date.now(),
        lastError: null,
      })
      linkHedgeIntoGroup(row)
      db.log('info', 'trading', 'Hedge opened', {
        key: row.position_key, symbol: row.symbol, hedgeSymbol: row.hedge_symbol,
        side: plan.side, qty, usdNotional: plan.usdNotional, outcome: src,
      })
      notifications?.publish({
        type: 'hedge_opened',
        title: 'Hedge opened',
        body: `${row.symbol} breached ${row.trigger_price} — opened ${plan.side} ${qty} ${row.hedge_symbol} (reduces net delta).`,
        data: { key: row.position_key, symbol: row.symbol, hedgeSymbol: row.hedge_symbol, qty, side: plan.side },
      })
    })
  }

  async function executeHedgeClose(
    adapter: ExchangeAdapter,
    row: HedgeGuardRow,
    reason: string,
  ): Promise<void> {
    await withOrderLock(row.exchange, async () => {
      const fresh = db.getHedgeGuard(row.position_key)
      if (!fresh || fresh.active !== 1 || fresh.status !== 'hedged') return
      let positions: Position[]
      try {
        positions = await adapter.getPositions()
      } catch {
        return
      }
      const hedge = findLive(positions, row.hedge_symbol, row.hedge_account_id)
      if (!hedge) {
        db.updateHedgeGuard(row.position_key, {
          status: 'closed', closeReason: 'hedge-closed-externally', active: 0,
        })
        return
      }
      const qty = Math.abs(hedge.size)
      const closeSide: 'buy' | 'sell' = hedge.side === 'long' ? 'sell' : 'buy'
      const placed = await adapter.placeOrder({
        accountId: row.hedge_account_id,
        symbol: row.hedge_symbol,
        side: closeSide,
        orderType: 'market',
        quantity: qty,
        reduceOnly: true,
        label: `kaibot:${row.position_key}:hedge-close`,
      })
      const settlementId = db.insertOrderSettlement({
        signalId: `hedge:${row.position_key}:close`,
        exchange: row.exchange,
        accountId: row.hedge_account_id,
        symbol: row.hedge_symbol,
        kind: 'exit',
        side: closeSide,
        qty,
        orderId: placed.orderId,
        targetLabel: `hedge-close:${reason}`,
        status: 'unknown',
      })
      const settled = await settleAdapterOrder(
        adapter,
        placed.orderId,
        { symbol: row.hedge_symbol, accountId: row.hedge_account_id },
        settleOptions,
      )
      const src = adapter.getOrderStatus ? settled.status : placed.status
      if (src === 'rejected') {
        db.resolveOrderSettlement(settlementId, 'rejected')
        db.log('warn', 'trading', 'Hedge close order rejected — hedge stays open', {
          key: row.position_key, hedgeSymbol: row.hedge_symbol, reason: placed.message,
        })
        notifyOnce(fresh, `hedge close rejected: ${placed.message ?? 'rejected'}`, 'Hedge close failed')
        // A service-initiated close must surface the failure to the caller.
        if (reason === 'manual') throw new Error(`hedge close rejected: ${placed.message ?? 'rejected'}`)
        return
      }
      if (src === 'filled' || src === 'partially_filled') {
        db.resolveOrderSettlement(settlementId, 'filled')
      } else if (src === 'cancelled') {
        db.resolveOrderSettlement(settlementId, 'cancelled')
      }
      const filledQty = settled.filledQuantity ?? placed.filledQuantity ?? qty
      db.reduceManualPosition(row.exchange, row.hedge_account_id, row.hedge_symbol, filledQty)
      db.updateHedgeGuard(row.position_key, {
        status: 'closed', closeReason: reason, active: 0, lastError: null,
      })
      db.log('info', 'trading', 'Hedge closed', {
        key: row.position_key, hedgeSymbol: row.hedge_symbol, qty: filledQty, reason, outcome: src,
      })
      notifications?.publish({
        type: 'hedge_closed',
        title: 'Hedge closed',
        body: `Closed the ${row.hedge_symbol} hedge for ${row.symbol} (${reason}).`,
        data: { key: row.position_key, hedgeSymbol: row.hedge_symbol, qty: filledQty, reason },
      })
    })
  }

  return { arm, update, disarm, close, list, activeExchanges, tickExchange }
}

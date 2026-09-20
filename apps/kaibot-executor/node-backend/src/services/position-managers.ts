// Attach/detach/configure allowlisted edge managers on ANY open position —
// manual positions included (F2, pilot-ladder decomposition). Protect/reduce-
// only by design: the attached reducers move protective stops and reduce/close;
// they can never place an entry (§3 design rule — entries are authored, never
// edge-decided). Manual-first: params here are the user's OWN attach input, so
// the IP-transmission question for bot positions stays untouched.
//
// State model: one managed_positions row per position (the locally persisted
// ManagedPositionState the reducers read) + one position_managers row per
// attachment (params + threaded RunnerState + composition order). Stop-emitting
// managers require a stop OWNER: if the position has no active trail row yet, a
// shell local_trail_state row is created (adopting the manual bracket stop as
// seed) so manager stop candidates dispatch through the ONE existing
// cancel/replace channel — never a second stop dispatcher.

import type { KaiBotDatabase } from '../storage/database.js'
import type { ManagedPositionRow, PositionManagerRow } from '../storage/types.js'
import type { ExchangeManager } from './exchanges/exchangeManager.js'
import { withOrderLock } from './order-lock.js'
import { positionTrailKey } from './position-trail.js'
import { findAdoptableStopSeed } from './position-manage.js'
import {
  ATTACHABLE_MANAGER_IDS,
  EDGE_MANAGER_REGISTRY,
  STOP_EMITTING_MANAGER_IDS,
} from './edge-managers/registry.js'
import {
  EMPTY_MANAGER_STATE,
  type ManagedPositionState,
  type ManagerRunnerState,
} from './edge-managers/contract.js'
import { accountKeyOf } from './exchanges/account-scope.js'

export type ManagersAction = 'attach' | 'configure' | 'detach'

export interface ManagersInput {
  action: ManagersAction
  exchange: string
  symbol: string
  accountId?: string
  managerId: string
  params?: Record<string, unknown>
}

export interface AttachedManagerView {
  managerId: string
  execOrder: number
  params: Record<string, unknown>
  state: ManagerRunnerState
  active: boolean
  updatedAt: number
}

export interface ManagedPositionView {
  key: string
  exchange: string
  accountId: string | null
  symbol: string
  direction: 'long' | 'short'
  avgEntryPrice: number
  size: number
  extremePrice: number
  oppositePrice: number
  currentStopLoss: number | null
  referencePrice: number | null
  openedTs: number
  active: boolean
  updatedAt: number
  managers: AttachedManagerView[]
}

export interface PositionManagersService {
  manage(input: ManagersInput): Promise<ManagedPositionView>
  list(): ManagedPositionView[]
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function managerView(row: PositionManagerRow): AttachedManagerView {
  return {
    managerId: row.manager_id,
    execOrder: row.exec_order,
    params: parseJson<Record<string, unknown>>(row.params, {}),
    state: parseJson<ManagerRunnerState>(row.state, EMPTY_MANAGER_STATE),
    active: row.active === 1,
    updatedAt: row.updated_at,
  }
}

function positionView(row: ManagedPositionRow, managers: PositionManagerRow[]): ManagedPositionView {
  return {
    key: row.position_key,
    exchange: row.exchange,
    accountId: row.account_id,
    symbol: row.symbol,
    direction: row.direction,
    avgEntryPrice: row.avg_entry_price,
    size: row.size,
    extremePrice: row.extreme_price,
    oppositePrice: row.opposite_price,
    currentStopLoss: row.current_stop_loss,
    referencePrice: row.reference_price,
    openedTs: row.opened_ts,
    active: row.active === 1,
    updatedAt: row.updated_at,
    managers: managers.map(managerView),
  }
}

// Manager-specific protective-direction checks the schema mirror can't do
// (they need the live position). Exported pure for unit tests.
export function validateManagerAgainstPosition(input: {
  managerId: string
  params: Record<string, unknown>
  direction: 'long' | 'short'
  avgEntryPrice: number
  markPrice: number
}): void {
  const { managerId, params, direction, avgEntryPrice, markPrice } = input
  if (managerId === 'risk-guard') {
    const stop = params.globalStopPrice as number | undefined
    if (stop != null) {
      const protective = direction === 'long' ? stop < markPrice : stop > markPrice
      if (!protective) {
        throw new Error(
          `globalStopPrice must be ${direction === 'long' ? 'below' : 'above'} the current price (${markPrice})`,
        )
      }
    }
  }
  if (managerId === 'tp-ladder') {
    const target = params.target as number | undefined
    if (target != null) {
      const winning = direction === 'long' ? target > avgEntryPrice : target < avgEntryPrice
      if (!winning) {
        throw new Error(
          `target must be ${direction === 'long' ? 'above' : 'below'} the average entry (${avgEntryPrice})`,
        )
      }
    }
    const prices = (params.prices as number[] | undefined) ?? []
    if (prices.length > 0) {
      const profitable = prices.some((p) =>
        direction === 'long' ? p > avgEntryPrice : p < avgEntryPrice,
      )
      if (!profitable) {
        throw new Error('every take-profit price is on the losing side of the average entry')
      }
    }
  }
}

export function createPositionManagersService(
  db: KaiBotDatabase,
  exchangeManager: ExchangeManager,
  deps: { userId?: string } = {},
): PositionManagersService {
  const userId = deps.userId ?? 'default'

  async function adapterFor(exchange: string, accountId?: string | null) {
    const session = await exchangeManager.getSession(userId, exchange, accountKeyOf(accountId))
    if (!session || session.status !== 'connected') {
      throw new Error(`exchange ${exchange} not connected`)
    }
    return session.adapter
  }

  function definitionFor(managerId: string) {
    const def = EDGE_MANAGER_REGISTRY[managerId]
    if (!def || !def.attachable) {
      throw new Error(
        `unknown or non-attachable manager '${managerId}' (allowed: ${ATTACHABLE_MANAGER_IDS.join(', ')})`,
      )
    }
    return def
  }

  async function attach(input: ManagersInput): Promise<ManagedPositionView> {
    const def = definitionFor(input.managerId)
    const params = def.normalizeParams(input.params ?? {}) as Record<string, unknown>

    const adapter = await adapterFor(input.exchange, input.accountId)
    const positions = await adapter.getPositions()
    const live = positions.find(
      (p) =>
        p.symbol.toLowerCase() === input.symbol.toLowerCase() &&
        Math.abs(p.size) > 0 &&
        (input.accountId == null || p.accountId === input.accountId),
    )
    if (!live) throw new Error(`no open position for ${input.symbol} on ${input.exchange}`)

    const direction = live.side
    const mark = live.markPrice != null && live.markPrice > 0 ? live.markPrice : live.entryPrice
    const accountId = input.accountId ?? live.accountId
    const key = positionTrailKey(input.exchange, accountId, input.symbol)

    validateManagerAgainstPosition({
      managerId: input.managerId,
      params,
      direction,
      avgEntryPrice: live.entryPrice,
      markPrice: mark,
    })

    // Attach may create the stop-owner shell (mutates who owns the protective
    // stop) — take the order lock like arm() so it can't race the tick loop.
    return withOrderLock(input.exchange, async () => {
      // Shared ManagedPositionState row: create on first attach (marks start at
      // the attach-time mark — managed from NOW), keep on later attaches. The
      // avg entry is the venue's REAL fill average.
      const existing = db.getManagedPosition(key)
      const trailRow = db
        .findActiveTrailsForSymbol(input.exchange, input.symbol)
        .find((r) => r.account_id == null || r.account_id === accountId)
      if (!existing || existing.active !== 1) {
        db.upsertManagedPosition({
          positionKey: key,
          exchange: input.exchange,
          accountId,
          symbol: input.symbol,
          direction,
          avgEntryPrice: live.entryPrice,
          size: Math.abs(live.size),
          extremePrice: mark,
          oppositePrice: mark,
          currentStopLoss: trailRow?.current_stop ?? null,
          referencePrice: null,
        })
      }

      // Stop-emitting managers need the ONE stop owner: without an active trail
      // row, create a shell that adopts the position's resting stop as seed
      // (source-agnostic: manual bracket, bot bracket after take-over, or the
      // retired bot trail). The shell computes no stop of its own (no distance,
      // no BE fee); manager candidates flow into its engine ratchet and
      // dispatch through the existing cancel/replace machinery.
      if (STOP_EMITTING_MANAGER_IDS.has(input.managerId) && !trailRow) {
        const seed = findAdoptableStopSeed(db, input.exchange, input.symbol, {
          direction,
          mark,
        })
        db.upsertLocalTrailState({
          signalId: key,
          exchange: input.exchange,
          symbol: input.symbol,
          direction,
          entryPrice: live.entryPrice,
          slOrderId: seed?.slOrderId ?? null,
          extremePrice: mark,
          oppositePrice: mark,
          currentStop: seed?.currentStop ?? null,
          source: 'manual',
          accountId,
          mode: 'fixed',
          bracketSignalId: seed?.bracketSignalId ?? null,
        })
        db.log('info', 'trading', 'Stop-owner shell created for edge manager', {
          key, managerId: input.managerId, seedSlOrderId: seed?.slOrderId,
        })
      }

      // Seed the reducer state via init() — same as the backtester pipeline at
      // position open. The init position reads the CURRENT venue truth.
      const row = db.getManagedPosition(key)!
      const initPosition: ManagedPositionState = {
        id: key,
        direction,
        avgEntryPrice: live.entryPrice,
        size: Math.abs(live.size),
        extremePriceAtEntry: row.extreme_price,
        oppositePrice: row.opposite_price,
        currentStopLoss: row.current_stop_loss,
        openedTs: row.opened_ts,
        exchange: input.exchange,
      }
      const state = def.plugin.init
        ? def.plugin.init({ params, position: initPosition })
        : EMPTY_MANAGER_STATE

      db.upsertPositionManager({
        positionKey: key,
        managerId: input.managerId,
        execOrder: def.execOrder,
        params: JSON.stringify(params),
        state: JSON.stringify(state),
      })
      db.log('info', 'trading', 'Edge manager attached to position', {
        key, managerId: input.managerId, exchange: input.exchange, symbol: input.symbol, params,
      })
      return positionView(db.getManagedPosition(key)!, db.listActiveManagersForPosition(key))
    })
  }

  function resolveManagedKey(input: ManagersInput): string {
    if (input.accountId) return positionTrailKey(input.exchange, input.accountId, input.symbol)
    // Without an account, match the single active managed position on the symbol.
    const rows = db
      .listActiveManagedPositions()
      .filter(
        (r) =>
          r.exchange === input.exchange &&
          r.symbol.toLowerCase() === input.symbol.toLowerCase(),
      )
    if (rows.length === 0) {
      throw new Error(`no managed position for ${input.symbol} (${input.exchange})`)
    }
    return rows[0].position_key
  }

  async function configure(input: ManagersInput): Promise<ManagedPositionView> {
    const def = definitionFor(input.managerId)
    const key = resolveManagedKey(input)
    const row = db.getPositionManager(key, input.managerId)
    if (!row || row.active !== 1) {
      throw new Error(`manager '${input.managerId}' is not attached to ${input.symbol}`)
    }
    const params = def.normalizeParams(input.params ?? {}) as Record<string, unknown>
    const posRow = db.getManagedPosition(key)!
    validateManagerAgainstPosition({
      managerId: input.managerId,
      params,
      direction: posRow.direction,
      avgEntryPrice: posRow.avg_entry_price,
      markPrice: posRow.extreme_price, // best local proxy; live check happens at attach
    })
    // Reconfigure RE-ARMS the reducer: state is re-initialized so e.g. a new TP
    // target re-derives (and un-freezes) the rung ladder. Fired history resets —
    // predictable "re-arm" semantics, documented on the route.
    const initPosition: ManagedPositionState = {
      id: key,
      direction: posRow.direction,
      avgEntryPrice: posRow.avg_entry_price,
      size: posRow.size,
      extremePriceAtEntry: posRow.extreme_price,
      oppositePrice: posRow.opposite_price,
      currentStopLoss: posRow.current_stop_loss,
      openedTs: posRow.opened_ts,
      exchange: posRow.exchange,
    }
    const state = def.plugin.init
      ? def.plugin.init({ params, position: initPosition })
      : EMPTY_MANAGER_STATE
    db.upsertPositionManager({
      positionKey: key,
      managerId: input.managerId,
      execOrder: def.execOrder,
      params: JSON.stringify(params),
      state: JSON.stringify(state),
    })
    db.log('info', 'trading', 'Edge manager reconfigured (state re-armed)', {
      key, managerId: input.managerId, params,
    })
    return positionView(db.getManagedPosition(key)!, db.listActiveManagersForPosition(key))
  }

  async function detach(input: ManagersInput): Promise<ManagedPositionView> {
    // Detach accepts any registry id (incl. a non-attachable one, defensively).
    if (!EDGE_MANAGER_REGISTRY[input.managerId]) {
      throw new Error(`unknown manager '${input.managerId}'`)
    }
    const key = resolveManagedKey(input)
    const row = db.getPositionManager(key, input.managerId)
    if (!row || row.active !== 1) {
      throw new Error(`manager '${input.managerId}' is not attached to ${input.symbol}`)
    }
    db.deactivatePositionManager(key, input.managerId)
    // Last manager gone → retire the position row. The trail row (stop owner)
    // stays: detaching a manager never strips protection.
    const remaining = db.listActiveManagersForPosition(key)
    if (remaining.length === 0) {
      db.deactivateManagedPosition(key)
    }
    db.log('info', 'trading', 'Edge manager detached from position', {
      key, managerId: input.managerId, remaining: remaining.length,
    })
    return positionView(db.getManagedPosition(key)!, remaining)
  }

  async function manage(input: ManagersInput): Promise<ManagedPositionView> {
    switch (input.action) {
      case 'attach':
        return attach(input)
      case 'configure':
        return configure(input)
      case 'detach':
        return detach(input)
      default:
        throw new Error(`unknown action: ${String((input as { action?: unknown }).action)}`)
    }
  }

  function list(): ManagedPositionView[] {
    return db
      .listActiveManagedPositions()
      .map((row) => positionView(row, db.listActiveManagersForPosition(row.position_key)))
  }

  return { manage, list }
}

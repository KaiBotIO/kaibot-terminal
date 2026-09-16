import { Hono } from 'hono'
import type { KaiBotDatabase } from '../storage/database.js'
import type { ExchangeManager } from '../services/exchanges/exchangeManager.js'
import { createManualTradeService, type ManualOrderType, type ManualTradeDeps } from '../services/manual-trade.js'
import {
  createPositionManageService,
  type ManageAction,
  type ManageTrailParams,
} from '../services/position-manage.js'
import {
  createPositionManagersService,
  type ManagersAction,
} from '../services/position-managers.js'
import { ATTACHABLE_MANAGER_IDS } from '../services/edge-managers/registry.js'
import { createRollService, type RollLegOrderType } from '../services/roll-position.js'
import {
  createHedgeGuardService,
  type HedgeGuardService,
  type HedgeOnMainClose,
  type HedgeSizeMode,
} from '../services/hedge-guard.js'
import type { SizeUnit } from '@kaibot/types/core'
import { createRideHandoverService } from '../services/ride-handover.js'

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

// Manual (discretionary) trading on the user's OWN connected exchange — placed
// edge-side, no server signal. Auth is enforced by the /api/* requireAuth gate.
export function createManualTradeRoutes(
  db: KaiBotDatabase,
  exchangeManager: ExchangeManager,
  deps: ManualTradeDeps = {},
  // Shared with the tick loop in main.ts (one instance watches the triggers);
  // created locally when absent (tests).
  hedgeService?: HedgeGuardService,
) {
  const app = new Hono()
  const service = createManualTradeService(db, exchangeManager, deps)
  const manageService = createPositionManageService(db, exchangeManager, { userId: deps.userId })
  const managersService = createPositionManagersService(db, exchangeManager, { userId: deps.userId })
  const rollService = createRollService(db, exchangeManager, deps)
  const hedge = hedgeService ?? createHedgeGuardService(db, exchangeManager, deps)
  const ride = createRideHandoverService(db, exchangeManager, deps)

  // Ride hand-over: give an open manual position to a ride-only bot on the
  // server (dry run first), or take it back.
  const parseHandover = (body: any) => {
    if (typeof body?.exchange !== 'string' || !body.exchange) throw new Error('exchange required')
    if (typeof body?.symbol !== 'string' || !body.symbol) throw new Error('symbol required')
    if (typeof body?.botId !== 'string' || !body.botId) throw new Error('botId required')
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined)
    return {
      exchange: body.exchange as string,
      symbol: body.symbol as string,
      botId: body.botId as string,
      botName: typeof body.botName === 'string' && body.botName ? (body.botName as string) : undefined,
      accountId: typeof body.accountId === 'string' ? (body.accountId as string) : undefined,
      canonicalSymbol: typeof body.canonicalSymbol === 'string' ? (body.canonicalSymbol as string) : undefined,
      marketExchange: typeof body.marketExchange === 'string' && body.marketExchange ? (body.marketExchange as string) : undefined,
      openedAt:
        typeof body.openedAt === 'string' && !Number.isNaN(Date.parse(body.openedAt))
          ? new Date(body.openedAt)
          : undefined,
      stopPrice: num(body.stopPrice),
      anchor: num(body.anchor),
      ladderFrom: body.ladderFrom === 'now' ? ('now' as const) : ('entry' as const),
    }
  }
  app.post('/handover/preview', async (c) => {
    try {
      return c.json(await ride.preview(parseHandover(await c.req.json())))
    } catch (e) {
      return c.json({ error: errMsg(e) }, 400)
    }
  })
  app.post('/handover', async (c) => {
    try {
      return c.json(await ride.handover(parseHandover(await c.req.json())))
    } catch (e) {
      return c.json({ error: errMsg(e) }, 400)
    }
  })
  app.get('/handover/bots', async (c) => {
    try {
      return c.json({ bots: await ride.listBots() })
    } catch (e) {
      return c.json({ error: errMsg(e) }, 400)
    }
  })
  app.get('/handover/list', (c) => c.json({ rides: ride.list() }))
  app.post('/takeback', async (c) => {
    try {
      const body = (await c.req.json()) as { positionId?: string }
      if (typeof body?.positionId !== 'string' || !body.positionId) {
        return c.json({ error: 'positionId required' }, 400)
      }
      return c.json(await ride.takeback(body.positionId))
    } catch (e) {
      return c.json({ error: errMsg(e) }, 400)
    }
  })

  // Place a manual order (market/limit/stop) with an optional protective bracket.
  app.post('/order', async (c) => {
    try {
      const body = (await c.req.json()) as {
        exchange?: string
        symbol?: string
        side?: 'buy' | 'sell'
        orderType?: ManualOrderType
        quantity?: number
        sizeUnit?: SizeUnit
        price?: number
        stopLoss?: number
        takeProfit?: number
        entries?: Array<{ price?: number; size?: number }>
        takeProfits?: Array<{ price?: number; fraction?: number }>
        accountId?: string
        idempotencyKey?: string
      }
      if (
        !body.exchange ||
        !body.symbol ||
        (body.side !== 'buy' && body.side !== 'sell') ||
        typeof body.quantity !== 'number' ||
        body.quantity <= 0
      ) {
        return c.json({ error: 'exchange, symbol, side (buy|sell) and positive quantity required' }, 400)
      }
      if (body.sizeUnit != null && body.sizeUnit !== 'native' && body.sizeUnit !== 'usd') {
        return c.json({ error: "sizeUnit must be 'native' or 'usd'" }, 400)
      }
      // Shape checks only — the service validates ladder rules (rung prices,
      // fraction sums) and reports them as 400s through the catch below.
      if (body.entries != null && !Array.isArray(body.entries)) {
        return c.json({ error: 'entries must be an array of { price, size }' }, 400)
      }
      if (body.takeProfits != null && !Array.isArray(body.takeProfits)) {
        return c.json({ error: 'takeProfits must be an array of { price, fraction }' }, 400)
      }
      const result = await service.place({
        exchange: body.exchange,
        symbol: body.symbol,
        side: body.side,
        orderType: body.orderType,
        quantity: body.quantity,
        sizeUnit: body.sizeUnit,
        price: body.price,
        stopLoss: body.stopLoss,
        takeProfit: body.takeProfit,
        entries: body.entries?.map((e) => ({ price: e.price, size: e.size as number })),
        takeProfits: body.takeProfits?.map((tp) => ({
          price: tp.price as number,
          fraction: tp.fraction as number,
        })),
        accountId: body.accountId,
        idempotencyKey: body.idempotencyKey,
      })
      return c.json(result)
    } catch (error) {
      db.log('error', 'trading', 'Manual order failed', { error: errMsg(error) })
      return c.json({ error: errMsg(error) }, 400)
    }
  })

  // Close (or partially close) a live position at market, reduce-only.
  app.post('/close', async (c) => {
    try {
      const body = (await c.req.json()) as {
        exchange?: string
        symbol?: string
        fraction?: number
        accountId?: string
        idempotencyKey?: string
      }
      if (!body.exchange || !body.symbol) {
        return c.json({ error: 'exchange and symbol required' }, 400)
      }
      const result = await service.close({
        exchange: body.exchange,
        symbol: body.symbol,
        fraction: body.fraction,
        accountId: body.accountId,
        idempotencyKey: body.idempotencyKey,
      })
      return c.json(result)
    } catch (error) {
      db.log('error', 'trading', 'Manual close failed', { error: errMsg(error) })
      return c.json({ error: errMsg(error) }, 400)
    }
  })

  // Preview a contract roll: leg sides, target contract, prices and estimated
  // spread cost. Read-only — nothing is placed.
  app.post('/roll/preview', async (c) => {
    try {
      const body = (await c.req.json()) as {
        exchange?: string
        symbol?: string
        accountId?: string
        toSymbol?: string
      }
      if (!body.exchange || !body.symbol) {
        return c.json({ error: 'exchange and symbol required' }, 400)
      }
      const result = await rollService.preview({
        exchange: body.exchange,
        symbol: body.symbol,
        accountId: body.accountId,
        toSymbol: body.toSymbol,
      })
      return c.json(result)
    } catch (error) {
      return c.json({ error: errMsg(error) }, 400)
    }
  })

  // Execute a previewed roll: close the expiring contract, reopen the same
  // exposure on the target contract. Two legs, all-or-nothing (see the roll
  // service header for the guarantee).
  app.post('/roll', async (c) => {
    try {
      const body = (await c.req.json()) as {
        exchange?: string
        symbol?: string
        toSymbol?: string
        accountId?: string
        legOrderType?: RollLegOrderType
        closeLimitPrice?: number
        openLimitPrice?: number
        idempotencyKey?: string
      }
      if (!body.exchange || !body.symbol || !body.toSymbol) {
        return c.json({ error: 'exchange, symbol and toSymbol required' }, 400)
      }
      if (body.legOrderType != null && body.legOrderType !== 'market' && body.legOrderType !== 'limit') {
        return c.json({ error: "legOrderType must be 'market' or 'limit'" }, 400)
      }
      const result = await rollService.execute({
        exchange: body.exchange,
        symbol: body.symbol,
        toSymbol: body.toSymbol,
        accountId: body.accountId,
        legOrderType: body.legOrderType,
        closeLimitPrice: body.closeLimitPrice,
        openLimitPrice: body.openLimitPrice,
        idempotencyKey: body.idempotencyKey,
      })
      return c.json(result)
    } catch (error) {
      db.log('error', 'trading', 'Roll failed', { error: errMsg(error) })
      return c.json({ error: errMsg(error) }, 400)
    }
  })

  // Manage a protective trail / break-even on any open position (manual
  // included). Reduce/protect-only: arm/adjust/lock/remove a STOP — this route
  // can never place an entry.
  const MANAGE_ACTIONS: ManageAction[] = ['arm', 'update', 'lock', 'unlock', 'remove']
  app.post('/manage', async (c) => {
    try {
      const body = (await c.req.json()) as {
        action?: ManageAction
        exchange?: string
        symbol?: string
        accountId?: string
        trail?: (Partial<ManageTrailParams> & { mode?: string }) | null
        breakevenFee?: number | null
        manualStop?: number | null
        trailingLock?: boolean
      }
      if (!body.action || !MANAGE_ACTIONS.includes(body.action)) {
        return c.json({ error: `action must be one of ${MANAGE_ACTIONS.join(', ')}` }, 400)
      }
      if (!body.exchange || !body.symbol) {
        return c.json({ error: 'exchange and symbol required' }, 400)
      }
      if (body.trail != null && (body.trail.mode !== 'fixed' && body.trail.mode !== 'drawdown')) {
        return c.json({ error: "trail.mode must be 'fixed' or 'drawdown'" }, 400)
      }
      const numeric: Array<[string, unknown]> = [
        ['trail.trailPercentage', body.trail?.trailPercentage],
        ['trail.trailPoints', body.trail?.trailPoints],
        ['trail.maxPercentage', body.trail?.maxPercentage],
        ['trail.maxPoints', body.trail?.maxPoints],
        ['trail.referencePrice', body.trail?.referencePrice],
        ['breakevenFee', body.breakevenFee],
        ['manualStop', body.manualStop],
      ]
      for (const [name, v] of numeric) {
        if (v != null && (typeof v !== 'number' || !Number.isFinite(v))) {
          return c.json({ error: `${name} must be a finite number` }, 400)
        }
      }
      const result = await manageService.manage({
        action: body.action,
        exchange: body.exchange,
        symbol: body.symbol,
        accountId: body.accountId,
        trail:
          body.trail == null
            ? body.trail
            : {
                mode: body.trail.mode as 'fixed' | 'drawdown',
                trailPercentage: body.trail.trailPercentage,
                trailPoints: body.trail.trailPoints,
                maxPercentage: body.trail.maxPercentage,
                maxPoints: body.trail.maxPoints,
                freezeExtreme: body.trail.freezeExtreme === true,
                referencePrice: body.trail.referencePrice,
                usePoints: body.trail.usePoints === true,
              },
        breakevenFee: body.breakevenFee,
        manualStop: body.manualStop,
        trailingLock: body.trailingLock,
      })
      return c.json(result)
    } catch (error) {
      db.log('error', 'trading', 'Position manage failed', { error: errMsg(error) })
      return c.json({ error: errMsg(error) }, 400)
    }
  })

  // Active edge trails (with the composed effective stop) for the UI.
  app.get('/manage', (c) => {
    try {
      return c.json({ trails: manageService.list() })
    } catch (error) {
      return c.json({ error: errMsg(error) }, 500)
    }
  })

  // Generic edge managers on any open position (manual included). Allowlisted
  // IP-free reducers only (break-even-mover, tp-ladder, risk-guard); a
  // drawdown trail is armed via /manage (the trail row owns the venue stop).
  // Protect/reduce-only: an attached manager can move a stop or reduce/close —
  // never place an entry. `configure` RE-ARMS the reducer state (a new TP
  // target re-derives the rung ladder; fired history resets).
  const MANAGERS_ACTIONS: ManagersAction[] = ['attach', 'configure', 'detach']
  app.post('/managers', async (c) => {
    try {
      const body = (await c.req.json()) as {
        action?: ManagersAction
        exchange?: string
        symbol?: string
        accountId?: string
        managerId?: string
        params?: Record<string, unknown>
      }
      if (!body.action || !MANAGERS_ACTIONS.includes(body.action)) {
        return c.json({ error: `action must be one of ${MANAGERS_ACTIONS.join(', ')}` }, 400)
      }
      if (!body.exchange || !body.symbol) {
        return c.json({ error: 'exchange and symbol required' }, 400)
      }
      if (!body.managerId || typeof body.managerId !== 'string') {
        return c.json({ error: `managerId required (one of ${ATTACHABLE_MANAGER_IDS.join(', ')})` }, 400)
      }
      if (body.params != null && (typeof body.params !== 'object' || Array.isArray(body.params))) {
        return c.json({ error: 'params must be an object' }, 400)
      }
      const result = await managersService.manage({
        action: body.action,
        exchange: body.exchange,
        symbol: body.symbol,
        accountId: body.accountId,
        managerId: body.managerId,
        params: body.params,
      })
      return c.json(result)
    } catch (error) {
      db.log('error', 'trading', 'Position managers request failed', { error: errMsg(error) })
      return c.json({ error: errMsg(error) }, 400)
    }
  })

  // Hedge guard on an open position: arm a pre-authorized protective hedge
  // (opposite position on a PAIRED instrument, opened on an adverse trigger
  // breach), adjust it, disarm it, or close an open hedge leg. Edge execution
  // of an operator-authored instruction — same carve-out as stops/roll.
  const HEDGE_ACTIONS = ['arm', 'update', 'disarm', 'close'] as const
  type HedgeAction = (typeof HEDGE_ACTIONS)[number]
  app.post('/hedge', async (c) => {
    try {
      const body = (await c.req.json()) as {
        action?: HedgeAction
        exchange?: string
        symbol?: string
        accountId?: string
        triggerPrice?: number
        hedgeSymbol?: string
        hedgeAccountId?: string
        sizeMode?: HedgeSizeMode
        fixedUsd?: number | null
        recoveryPrice?: number | null
        onMainClose?: HedgeOnMainClose
      }
      if (!body.action || !HEDGE_ACTIONS.includes(body.action)) {
        return c.json({ error: `action must be one of ${HEDGE_ACTIONS.join(', ')}` }, 400)
      }
      if (!body.exchange || !body.symbol) {
        return c.json({ error: 'exchange and symbol required' }, 400)
      }
      if (body.sizeMode != null && body.sizeMode !== 'match' && body.sizeMode !== 'fixed-usd') {
        return c.json({ error: "sizeMode must be 'match' or 'fixed-usd'" }, 400)
      }
      if (body.onMainClose != null && body.onMainClose !== 'keep' && body.onMainClose !== 'close') {
        return c.json({ error: "onMainClose must be 'keep' or 'close'" }, 400)
      }
      for (const [name, v] of [
        ['triggerPrice', body.triggerPrice],
        ['fixedUsd', body.fixedUsd],
        ['recoveryPrice', body.recoveryPrice],
      ] as Array<[string, unknown]>) {
        if (v != null && (typeof v !== 'number' || !Number.isFinite(v))) {
          return c.json({ error: `${name} must be a finite number` }, 400)
        }
      }
      const key = { exchange: body.exchange, symbol: body.symbol, accountId: body.accountId }
      let result
      if (body.action === 'arm') {
        if (body.triggerPrice == null) return c.json({ error: 'triggerPrice required to arm' }, 400)
        result = await hedge.arm({
          ...key,
          triggerPrice: body.triggerPrice,
          hedgeSymbol: body.hedgeSymbol,
          hedgeAccountId: body.hedgeAccountId,
          sizeMode: body.sizeMode,
          fixedUsd: body.fixedUsd ?? undefined,
          recoveryPrice: body.recoveryPrice,
          onMainClose: body.onMainClose,
        })
      } else if (body.action === 'update') {
        result = await hedge.update({
          ...key,
          triggerPrice: body.triggerPrice,
          hedgeSymbol: body.hedgeSymbol,
          hedgeAccountId: body.hedgeAccountId,
          sizeMode: body.sizeMode,
          fixedUsd: body.fixedUsd,
          recoveryPrice: body.recoveryPrice,
          onMainClose: body.onMainClose,
        })
      } else if (body.action === 'disarm') {
        result = await hedge.disarm(key)
      } else {
        result = await hedge.close(key)
      }
      return c.json(result)
    } catch (error) {
      db.log('error', 'trading', 'Hedge request failed', { error: errMsg(error) })
      return c.json({ error: errMsg(error) }, 400)
    }
  })

  // Hedge guards (armed + open + recent terminal) for the UI.
  app.get('/hedge', (c) => {
    try {
      return c.json({ hedges: hedge.list() })
    } catch (error) {
      return c.json({ error: errMsg(error) }, 500)
    }
  })

  // Managed positions + their attached managers (params, threaded state).
  app.get('/managers', (c) => {
    try {
      return c.json({ positions: managersService.list() })
    } catch (error) {
      return c.json({ error: errMsg(error) }, 500)
    }
  })

  return app
}

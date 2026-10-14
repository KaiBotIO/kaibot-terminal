import { Hono, type Context } from 'hono'
import { canSeeAccount, filterByAccount, scopeOf } from '../auth/account-scope.js'
import type { KaiBotDatabase } from '../storage/database.js'
import type { CollateralService } from '../services/collateral.js'
import { getCollateralFloor, listCollateralFloorEvents } from '../storage/collateral-store.js'

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))
// A floor that already exists is a conflict, everything else a bad request.
const statusOf = (msg: string) => (/already has a floor|already armed|already in an arm cycle/.test(msg) ? 409 : 400)

// Collateral floor (Bybit UTA): coins as margin, a floor per coin, the pot
// sizing basis and the margin-ratio guard. Contract mirrored in the UI at
// apps/kaibot-executor/src/lib/collateral-api.ts.
export function createCollateralRoutes(db: KaiBotDatabase, service: CollateralService) {
  const app = new Hono()

  app.get('/accounts', async (c) => {
    const accounts = filterByAccount(scopeOf(c), await service.listAccounts(), (a) => a)
    return c.json({ accounts })
  })

  app.get('/', async (c) => {
    const exchange = c.req.query('exchange') ?? 'bybit'
    const accountId = c.req.query('accountId') ?? 'unified'
    if (!canSeeAccount(scopeOf(c), exchange, accountId)) return c.json({ error: 'not found' }, 404)
    return c.json(await service.overview(exchange, accountId))
  })

  // Alert banner (Dashboard + Collateral): active hedge traps, per visible account.
  app.get('/alerts', (c) => c.json({ alerts: filterByAccount(scopeOf(c), service.activeAlerts(), (a) => a) }))

  app.get('/floors/:id', (c) => {
    const row = getCollateralFloor(db, c.req.param('id'))
    if (!row || !canSeeAccount(scopeOf(c), row.exchange, row.account_id)) return c.json({ error: 'not found' }, 404)
    return c.json({ floor: row, events: listCollateralFloorEvents(db, row.id) })
  })

  app.post('/floors', async (c) => {
    try {
      const body = await c.req.json()
      const floor = await service.armFloor({
        exchange: String(body.exchange ?? 'bybit'),
        accountId: String(body.accountId ?? 'unified'),
        accountKey: body.accountKey ?? null,
        coin: String(body.coin ?? ''),
        mode: body.mode,
        triggerPrice: Number(body.triggerPrice),
        holdingsCoin: body.holdingsCoin != null ? Number(body.holdingsCoin) : undefined,
        trailPct: body.trailPct != null ? Number(body.trailPct) : null,
        recoveryPct: body.recoveryPct != null ? Number(body.recoveryPct) : null,
        tolerancePct: body.tolerancePct != null ? Number(body.tolerancePct) : 0,
        buyBack: body.buyBack === true,
      })
      return c.json({ floor })
    } catch (e) {
      const msg = errMsg(e)
      return c.json({ error: msg }, statusOf(msg))
    }
  })

  app.post('/floors/:id/update', async (c) => {
    try {
      const body = await c.req.json()
      const num = (v: unknown) => (v === undefined ? undefined : v === null ? null : Number(v))
      const floor = await service.updateFloor(c.req.param('id'), {
        triggerPrice: body.triggerPrice != null ? Number(body.triggerPrice) : undefined,
        holdingsCoin: body.holdingsCoin != null ? Number(body.holdingsCoin) : undefined,
        trailPct: num(body.trailPct),
        recoveryPct: num(body.recoveryPct),
        tolerancePct: body.tolerancePct != null ? Number(body.tolerancePct) : undefined,
        buyBack: typeof body.buyBack === 'boolean' ? body.buyBack : undefined,
        virtualHedge: typeof body.virtualHedge === 'boolean' ? body.virtualHedge : undefined,
      })
      return c.json({ floor })
    } catch (e) {
      return c.json({ error: errMsg(e) }, 400)
    }
  })

  app.post('/floors/:id/disarm', async (c) => {
    try {
      return c.json({ floor: await service.disarmFloor(c.req.param('id')) })
    } catch (e) {
      return c.json({ error: errMsg(e) }, 400)
    }
  })

  app.put('/settings', async (c) => {
    try {
      const body = await c.req.json()
      if (!body.exchange || !body.accountId) return c.json({ error: 'exchange and accountId are required' }, 400)
      const settings = service.updateSettings({
        exchange: String(body.exchange),
        accountId: String(body.accountId),
        sizingBasis: body.sizingBasis,
        unfloored: body.unfloored,
        blockMmrPct: body.blockMmrPct != null ? Number(body.blockMmrPct) : undefined,
        warnMmrPct: body.warnMmrPct != null ? Number(body.warnMmrPct) : undefined,
        autoReduce: typeof body.autoReduce === 'boolean' ? body.autoReduce : undefined,
        autoReducePct: body.autoReducePct != null ? Number(body.autoReducePct) : undefined,
        ratioOverrides: body.ratioOverrides && typeof body.ratioOverrides === 'object' ? body.ratioOverrides : undefined,
        virtualCoverage: body.virtualCoverage,
      })
      // Coverage takes effect now: legs arm (or are refused) or retire.
      const hedges = await service.syncHedges(settings.exchange, settings.accountId).catch(() => [])
      return c.json({ settings, hedges })
    } catch (e) {
      return c.json({ error: errMsg(e) }, 400)
    }
  })

  // Off-exchange coins counted in the pot (never margin). quantity 0 or
  // DELETE removes the line.
  const setVirtual = async (c: Context, remove: boolean) => {
    try {
      const body = await c.req.json().catch(() => ({}))
      const lines = service.setVirtualLine({
        exchange: c.req.param('exchange'),
        accountId: c.req.param('accountId'),
        coin: String(body.coin ?? ''),
        label: String(body.label ?? ''),
        quantity: remove ? 0 : Number(body.quantity),
      })
      // A changed virtual qty resizes (or refuses) the hedge leg now.
      await service.syncHedges(c.req.param('exchange'), c.req.param('accountId')).catch(() => [])
      return c.json({ lines })
    } catch (e) {
      return c.json({ error: errMsg(e) }, 400)
    }
  }
  app.put('/:exchange/:accountId/virtual', (c) => setVirtual(c, false))
  app.delete('/:exchange/:accountId/virtual', (c) => setVirtual(c, true))

  return app
}

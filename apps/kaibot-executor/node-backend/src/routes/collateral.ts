import { Hono } from 'hono'
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

  app.get('/accounts', async (c) => c.json({ accounts: await service.listAccounts() }))

  app.get('/', async (c) => {
    const exchange = c.req.query('exchange') ?? 'bybit'
    const accountId = c.req.query('accountId') ?? 'unified'
    return c.json(await service.overview(exchange, accountId))
  })

  app.get('/floors/:id', (c) => {
    const row = getCollateralFloor(db, c.req.param('id'))
    if (!row) return c.json({ error: 'not found' }, 404)
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
      })
      return c.json({ settings })
    } catch (e) {
      return c.json({ error: errMsg(e) }, 400)
    }
  })

  return app
}

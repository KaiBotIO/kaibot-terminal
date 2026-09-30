import { Hono } from 'hono'
import type { AccumulateService, CreatePlanInput } from '../services/accumulate-ride-service.js'
import type { AccumulateParams } from '../services/accumulate-ride.js'

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

const PARAM_KEYS: Array<keyof AccumulateParams> = [
  'lookbackBars',
  'barMinutes',
  'rungStepPct',
  'rungPct',
  'rungCount',
  'startPct',
  'rideStopExtraSteps',
  'reanchorOnBreakout',
]

function parseInput(body: any): CreatePlanInput {
  const str = (v: unknown, name: string) => {
    if (typeof v !== 'string' || !v.trim()) throw new Error(`${name} required`)
    return v.trim()
  }
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  const params: Partial<AccumulateParams> = {}
  const raw = body?.params ?? {}
  for (const k of PARAM_KEYS) {
    const v = raw[k]
    if (k === 'reanchorOnBreakout') {
      if (typeof v === 'boolean') params.reanchorOnBreakout = v
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      ;(params as Record<string, number>)[k] = v
    }
  }
  return {
    exchange: str(body?.exchange, 'exchange'),
    symbol: str(body?.symbol, 'symbol'),
    accountId: str(body?.accountId, 'accountId'),
    rideBotId: typeof body?.rideBotId === 'string' ? body.rideBotId : '',
    params,
    direction: body?.direction === 'short' ? 'short' : body?.direction === 'long' ? 'long' : undefined,
    reference: num(body?.reference),
    openedAt: num(body?.openedAt),
    adoptRungs: body?.adoptRungs !== false,
  }
}

// Accumulate & ride plans (operator-armed ladder + breakout hand-over).
export function createAccumulateRoutes(service: AccumulateService) {
  const app = new Hono()

  app.get('/', (c) => c.json({ plans: service.list(c.req.query('all') === '1') }))

  app.post('/preview', async (c) => {
    try {
      return c.json(await service.preview(parseInput(await c.req.json())))
    } catch (e) {
      return c.json({ error: errMsg(e) }, 400)
    }
  })

  app.post('/', async (c) => {
    try {
      return c.json({ plan: await service.create(parseInput(await c.req.json())) })
    } catch (e) {
      return c.json({ error: errMsg(e) }, 400)
    }
  })

  app.get('/:id', (c) => {
    const plan = service.status(c.req.param('id'))
    return plan ? c.json({ plan }) : c.json({ error: 'not found' }, 404)
  })

  app.post('/:id/stop', async (c) => {
    try {
      return c.json({ plan: await service.stop(c.req.param('id')) })
    } catch (e) {
      return c.json({ error: errMsg(e) }, 400)
    }
  })

  // Evaluate now instead of on the next minute tick.
  app.post('/:id/check', async (c) => {
    await service.tickPlan(c.req.param('id'))
    const plan = service.status(c.req.param('id'))
    return plan ? c.json({ plan }) : c.json({ error: 'not found' }, 404)
  })

  return app
}

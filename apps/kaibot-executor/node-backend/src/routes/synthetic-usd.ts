import { Hono } from 'hono'
import type { KaiBotDatabase } from '../storage/database.js'
import type { ExchangeManager } from '../services/exchanges/exchangeManager.js'
import {
  createSyntheticUsdService,
  holdingsBasisTotal,
  DEFAULT_SYNTHETIC_USD_LEVERAGE_CAP,
  type SyntheticUsdService,
} from '../services/synthetic-usd.js'
import { isSyntheticRebalanceEnabled } from '../services/synthetic-rebalance-gate.js'
import { isInverseContract } from '@kaibot/types/core'
import { accountKeyOf } from '../services/exchanges/account-scope.js'
import { syntheticBasisUsd } from '../services/synthetic-sizing.js'
import {
  armedView,
  createSyntheticGuardService,
  type SyntheticGuardService,
} from '../services/synthetic-guard.js'

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

// Synthetic USD: mint/scale/close a delta-neutral short that locks the USD value
// of crypto holdings, plus the configurable holdings basis and the factor-basis
// toggle. A separate entity from the normal positions — never in /portfolio.
// Armed (dynamic) rows ride the same routes with an `armed` view attached.
export function createSyntheticUsdRoutes(
  db: KaiBotDatabase,
  exchangeManager: ExchangeManager,
  deps: { service?: SyntheticUsdService; guard?: SyntheticGuardService } = {},
) {
  const app = new Hono()
  const service = deps.service ?? createSyntheticUsdService(db, exchangeManager)
  const guard = deps.guard ?? createSyntheticGuardService(db, exchangeManager, service)

  // shortUnit: inverse contracts hold the short as a USD notional, linear
  // (USDC) ones as a coin quantity — the UI formats short_size accordingly.
  const withArmed = (row: ReturnType<KaiBotDatabase['getSyntheticUsdPosition']>) =>
    row
      ? {
          ...row,
          armed: armedView(row),
          shortUnit: isInverseContract(row.exchange, row.symbol) ? 'usd' : 'coin',
          // Connection label carried by the account id (null = default).
          accountKey: accountKeyOf(row.account_id) ?? null,
          // What this row lends to signal sizing when flagged as the basis.
          sizingBasis: row.is_factor_basis === 1 ? syntheticBasisUsd(row) : null,
        }
      : row
  const withMutations = (id: string) => ({
    position: withArmed(db.getSyntheticUsdPosition(id)),
    mutations: db.listSyntheticUsdMutations(id),
  })

  // List positions (open + armed by default; ?includeClosed=true for history).
  app.get('/', (c) => {
    const includeClosed = c.req.query('includeClosed') === 'true'
    const positions = db.listSyntheticUsdPositions(includeClosed).map((r) => withArmed(r)!)
    return c.json({
      positions,
      holdingsBasisUsd: holdingsBasisTotal(db),
      // Default for the user's protective ceiling on a NEW position. The
      // effective ceiling of each open position lives on its own leverage_cap
      // field — this value only seeds the mint form.
      leverageCap: DEFAULT_SYNTHETIC_USD_LEVERAGE_CAP,
      // Global loop gate (SYNTHETIC_REBALANCE_ENABLED) — the UI shows a
      // "disabled on this executor" note when off.
      rebalanceEnabled: isSyntheticRebalanceEnabled(),
    })
  })

  // Holdings basis: live exchange lines + manual off-exchange lines + total.
  // Registered before '/:id' so the literal path isn't captured as an id param.
  app.get('/holdings-basis', (c) => {
    return c.json({ lines: db.listHoldingsBasis(), total: holdingsBasisTotal(db) })
  })

  app.get('/:id', (c) => {
    const id = c.req.param('id')
    const position = db.getSyntheticUsdPosition(id)
    if (!position) return c.json({ error: 'not found' }, 404)
    return c.json(withMutations(id))
  })

  // Arm: a trigger-only row (or attach a cycle to an existing open position).
  // The short is minted by the edge on an adverse breach; planned floor =
  // holdingsCoin × triggerPrice.
  app.post('/arm', async (c) => {
    try {
      const body = (await c.req.json()) as {
        exchange?: string
        accountId?: string
        accountKey?: string | null
        symbol?: string
        triggerPrice?: number
        holdingsCoin?: number
        trailPct?: number | null
        trailAbs?: number | null
        recoveryPrice?: number | null
        recoveryPct?: number | null
        tolerancePct?: number
        leverageCap?: number
      }
      if (
        !body.exchange || !body.accountId || !body.symbol ||
        typeof body.triggerPrice !== 'number' || body.triggerPrice <= 0
      ) {
        return c.json({ error: 'exchange, accountId, symbol and positive triggerPrice required' }, 400)
      }
      const position = await guard.arm({
        exchange: body.exchange,
        accountId: body.accountId,
        accountKey: body.accountKey,
        symbol: body.symbol,
        triggerPrice: body.triggerPrice,
        holdingsCoin: body.holdingsCoin,
        trailPct: body.trailPct,
        trailAbs: body.trailAbs,
        recoveryPrice: body.recoveryPrice,
        recoveryPct: body.recoveryPct,
        tolerancePct: body.tolerancePct,
        leverageCap: body.leverageCap,
      })
      return c.json(withMutations(position.id))
    } catch (error) {
      db.log('error', 'trading', 'Synthetic USD arm failed', { error: errMsg(error) })
      return c.json({ error: errMsg(error) }, 400)
    }
  })

  app.post('/:id/arm-update', async (c) => {
    try {
      const id = c.req.param('id')
      const body = (await c.req.json()) as {
        triggerPrice?: number
        holdingsCoin?: number
        trailPct?: number | null
        trailAbs?: number | null
        recoveryPrice?: number | null
        recoveryPct?: number | null
        tolerancePct?: number
      }
      guard.updateArm(id, body)
      return c.json(withMutations(id))
    } catch (error) {
      db.log('error', 'trading', 'Synthetic USD arm update failed', { error: errMsg(error) })
      return c.json({ error: errMsg(error) }, 400)
    }
  })

  // Disarm: an armed row retires (nothing was minted); an open arm-cycle row
  // keeps its short and becomes a plain synthetic position.
  app.post('/:id/disarm', async (c) => {
    try {
      const id = c.req.param('id')
      guard.disarm(id)
      return c.json(withMutations(id))
    } catch (error) {
      db.log('error', 'trading', 'Synthetic USD disarm failed', { error: errMsg(error) })
      return c.json({ error: errMsg(error) }, 400)
    }
  })

  // Set or remove a manual off-exchange holdings line.
  app.put('/holdings-basis', async (c) => {
    try {
      const body = (await c.req.json()) as { label?: string; usdValue?: number }
      if (!body.label || typeof body.usdValue !== 'number' || body.usdValue < 0) {
        return c.json({ error: 'label and non-negative usdValue required' }, 400)
      }
      const source = `manual:${body.label}`
      if (body.usdValue === 0) {
        db.deleteHoldingsBasis(source)
      } else {
        db.setHoldingsBasis(source, body.usdValue, true)
      }
      return c.json({ lines: db.listHoldingsBasis(), total: holdingsBasisTotal(db) })
    } catch (error) {
      db.log('error', 'trading', 'Failed to set holdings basis', { error: errMsg(error) })
      return c.json({ error: errMsg(error) }, 500)
    }
  })

  // Mint: open a synthetic USD position for a target USD value.
  app.post('/', async (c) => {
    try {
      const body = (await c.req.json()) as {
        exchange?: string
        accountId?: string
        symbol?: string
        targetUsd?: number
        leverageCap?: number
      }
      if (
        !body.exchange ||
        !body.accountId ||
        !body.symbol ||
        typeof body.targetUsd !== 'number' ||
        body.targetUsd <= 0
      ) {
        return c.json({ error: 'exchange, accountId, symbol and positive targetUsd required' }, 400)
      }
      if (
        body.leverageCap !== undefined &&
        (typeof body.leverageCap !== 'number' || body.leverageCap <= 0)
      ) {
        return c.json({ error: 'leverageCap must be a positive number' }, 400)
      }
      const position = await service.mint({
        exchange: body.exchange,
        accountId: body.accountId,
        symbol: body.symbol,
        targetUsd: body.targetUsd,
        leverageCap: body.leverageCap,
      })
      return c.json(withMutations(position.id))
    } catch (error) {
      db.log('error', 'trading', 'Synthetic USD mint failed', { error: errMsg(error) })
      return c.json({ error: errMsg(error) }, 400)
    }
  })

  // Scale up or down to a new target USD value.
  app.post('/:id/scale', async (c) => {
    try {
      const id = c.req.param('id')
      const body = (await c.req.json()) as { targetUsd?: number; leverageCap?: number }
      if (typeof body.targetUsd !== 'number' || body.targetUsd < 0) {
        return c.json({ error: 'non-negative targetUsd required' }, 400)
      }
      if (
        body.leverageCap !== undefined &&
        (typeof body.leverageCap !== 'number' || body.leverageCap <= 0)
      ) {
        return c.json({ error: 'leverageCap must be a positive number' }, 400)
      }
      const position = await service.scale(id, body.targetUsd, body.leverageCap)
      return c.json(withMutations(position.id))
    } catch (error) {
      db.log('error', 'trading', 'Synthetic USD scale failed', { error: errMsg(error) })
      return c.json({ error: errMsg(error) }, 400)
    }
  })

  // Close: buy back the full short.
  app.post('/:id/close', async (c) => {
    try {
      const id = c.req.param('id')
      const position = await service.close(id)
      return c.json(withMutations(position.id))
    } catch (error) {
      db.log('error', 'trading', 'Synthetic USD close failed', { error: errMsg(error) })
      return c.json({ error: errMsg(error) }, 400)
    }
  })

  // Configure auto-rebalance (per-position opt-in; the loop itself is
  // additionally gated by SYNTHETIC_REBALANCE_ENABLED).
  app.post('/:id/auto-rebalance', async (c) => {
    try {
      const id = c.req.param('id')
      const body = (await c.req.json()) as {
        enabled?: boolean
        targetPct?: number
        bandPct?: number
        basis?: string
      }
      if (typeof body.enabled !== 'boolean') {
        return c.json({ error: 'enabled (boolean) required' }, 400)
      }
      service.setAutoRebalance(id, {
        enabled: body.enabled,
        targetPct: body.targetPct,
        bandPct: body.bandPct,
        basis: body.basis as 'holdings' | undefined,
      })
      return c.json(withMutations(id))
    } catch (error) {
      db.log('error', 'trading', 'Synthetic USD auto-rebalance config failed', {
        error: errMsg(error),
      })
      return c.json({ error: errMsg(error) }, 400)
    }
  })

  // Toggle "use as factor basis".
  app.post('/:id/factor-basis', async (c) => {
    try {
      const id = c.req.param('id')
      const body = (await c.req.json().catch(() => ({}))) as { enabled?: boolean }
      const enabled = body.enabled !== false
      service.setFactorBasis(id, enabled)
      return c.json(withMutations(id))
    } catch (error) {
      db.log('error', 'trading', 'Synthetic USD factor-basis toggle failed', { error: errMsg(error) })
      return c.json({ error: errMsg(error) }, 400)
    }
  })

  return app
}

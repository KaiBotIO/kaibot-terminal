import { Hono } from 'hono'
import { randomUUID } from 'crypto'
import type { KaiBotDatabase } from '../storage/database.js'
import type { ExchangeManager } from '../services/exchanges/exchangeManager.js'
import {
  buildGroupOverview,
  type LadderLookup,
  type LivePositionRef,
} from '../services/position-groups.js'
import { composeEffectiveStop, positionTrailKey } from '../services/position-trail.js'
import { createManualTradeService, type ManualTradeDeps } from '../services/manual-trade.js'
import { createPositionManageService } from '../services/position-manage.js'
import type { PositionGroupLinkRow } from '../storage/types.js'
import { positionsAcrossConnections } from '../services/exchanges/account-scope.js'

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

// Position-group CRUD + assignment + the aggregated overview (G0), plus the two
// documented operator-convenience actions (G2, live-only): close-group and
// tighten-stops. Both are reduce/protect-only and ride the existing per-position
// close / manage paths. Auth via the /api/* gate.
export function createPositionGroupRoutes(
  db: KaiBotDatabase,
  exchangeManager: ExchangeManager,
  deps: ManualTradeDeps = {},
  ladderLookup?: LadderLookup,
) {
  const app = new Hono()
  const tradeService = createManualTradeService(db, exchangeManager, deps)
  const manageService = createPositionManageService(db, exchangeManager, { userId: deps.userId })

  // Live positions for one group's links, keyed by position key. Fetches each
  // involved exchange once; disconnected sessions simply yield no matches.
  async function livePositionsForLinks(
    userId: string,
    links: PositionGroupLinkRow[],
  ): Promise<Map<string, LivePositionRef>> {
    const byExchange = new Map<string, PositionGroupLinkRow[]>()
    for (const l of links) byExchange.set(l.exchange, [...(byExchange.get(l.exchange) ?? []), l])
    const out = new Map<string, LivePositionRef>()
    for (const [exchange] of byExchange) {
      let positions
      try {
        // Every connection on the exchange; account ids are unique across them.
        positions = await positionsAcrossConnections(exchangeManager, userId, exchange)
        if (!positions) continue
      } catch (err) {
        db.log('warn', 'trading', 'Group action: positions fetch failed', {
          exchange,
          error: errMsg(err),
        })
        continue
      }
      for (const p of positions) {
        if (!p.size || Math.abs(p.size) === 0) continue
        out.set(positionTrailKey(exchange, p.accountId, p.symbol), {
          exchange,
          accountId: p.accountId,
          symbol: p.symbol,
          side: p.side,
          size: p.size,
          entryPrice: p.entryPrice,
          markPrice: p.markPrice,
          unrealizedPnL: p.unrealizedPnL,
        })
      }
    }
    return out
  }

  app.get('/', (c) => {
    const links = db.listPositionGroupLinks()
    const groups = db.listPositionGroups().map((g) => ({
      id: g.id,
      name: g.name,
      source: g.source,
      botConfigId: g.bot_config_id,
      signalBotId: g.signal_bot_id,
      linkedPositions: links.filter((l) => l.group_id === g.id).length,
      createdAt: g.created_at,
    }))
    return c.json({ groups })
  })

  app.post('/', async (c) => {
    try {
      const body = (await c.req.json()) as { name?: string }
      const name = body.name?.trim()
      if (!name) return c.json({ error: 'name required' }, 400)
      const id = randomUUID()
      db.createPositionGroup({ id, name, source: 'manual' })
      return c.json({ id, name, source: 'manual' })
    } catch (e) {
      return c.json({ error: errMsg(e) }, 400)
    }
  })

  app.patch('/:id', async (c) => {
    try {
      const id = c.req.param('id')
      if (!db.getPositionGroup(id)) return c.json({ error: 'group not found' }, 404)
      const body = (await c.req.json()) as { name?: string }
      const name = body.name?.trim()
      if (!name) return c.json({ error: 'name required' }, 400)
      db.renamePositionGroup(id, name)
      return c.json({ id, name })
    } catch (e) {
      return c.json({ error: errMsg(e) }, 400)
    }
  })

  // Members revert to Unsorted — deleting a group never touches positions.
  app.delete('/:id', (c) => {
    const id = c.req.param('id')
    if (!db.getPositionGroup(id)) return c.json({ error: 'group not found' }, 404)
    db.deletePositionGroup(id)
    return c.json({ success: true })
  })

  // Assign (groupId) / unassign (groupId null) a position. A user assignment
  // pins the link — auto rules never overwrite it.
  app.post('/assign', async (c) => {
    try {
      const body = (await c.req.json()) as {
        exchange?: string
        accountId?: string
        symbol?: string
        groupId?: string | null
      }
      if (!body.exchange || !body.accountId || !body.symbol) {
        return c.json({ error: 'exchange, accountId and symbol required' }, 400)
      }
      if (body.groupId != null && !db.getPositionGroup(body.groupId)) {
        return c.json({ error: 'group not found' }, 404)
      }
      db.upsertPositionGroupLink({
        positionKey: positionTrailKey(body.exchange, body.accountId, body.symbol),
        exchange: body.exchange.toLowerCase(),
        accountId: body.accountId,
        symbol: body.symbol.toUpperCase(),
        groupId: body.groupId ?? null,
        assignedBy: 'user',
      })
      return c.json({ success: true })
    } catch (e) {
      return c.json({ error: errMsg(e) }, 400)
    }
  })

  // Live positions across every connected session, bucketed per group with
  // aggregates (net uPnL, exposure, count, combined stop risk). Unsorted last.
  app.get('/overview', async (c) => {
    const userId = c.req.header('x-user-id') || 'default'
    try {
      const sessions = await exchangeManager.getAllSessions(userId)
      const live: LivePositionRef[] = []
      await Promise.all(
        sessions
          .filter((s) => s.status === 'connected')
          .map(async (session) => {
            try {
              const positions = await session.adapter.getPositions()
              for (const p of positions) {
                if (!p.size) continue
                live.push({
                  exchange: session.exchangeName,
                  accountId: p.accountId,
                  symbol: p.symbol,
                  side: p.side,
                  size: p.size,
                  entryPrice: p.entryPrice,
                  markPrice: p.markPrice,
                  unrealizedPnL: p.unrealizedPnL,
                })
              }
            } catch (err) {
              db.log('warn', 'trading', 'Group overview: positions fetch failed', {
                exchange: session.exchangeName,
                error: errMsg(err),
              })
            }
          }),
      )
      const entries = buildGroupOverview(db, live, db.listActiveLocalTrails(), ladderLookup)
      return c.json({ entries })
    } catch (e) {
      return c.json({ error: errMsg(e) }, 400)
    }
  })

  // Close every live position in the group: SEQUENTIAL reduce-only market
  // closes through the existing manual-close path (bracket/rung/trail cleanup
  // included). Partial failures are reported per position, never rethrown —
  // one refused close must not strand the rest of the group.
  // Operator-convenience exception to the sim/live invariant (live-only; the
  // sim's group closes are the group-risk-guard's breach path).
  app.post('/:id/close', async (c) => {
    const id = c.req.param('id')
    if (!db.getPositionGroup(id)) return c.json({ error: 'group not found' }, 404)
    const userId = c.req.header('x-user-id') || 'default'
    const links = db.listPositionGroupLinks().filter((l) => l.group_id === id)
    const liveByKey = await livePositionsForLinks(userId, links)

    const results: Array<{
      positionKey: string
      exchange: string
      accountId: string
      symbol: string
      status: 'closed' | 'skipped' | 'failed'
      orderId?: string
      reason?: string
    }> = []
    for (const link of links) {
      const base = {
        positionKey: link.position_key,
        exchange: link.exchange,
        accountId: link.account_id,
        symbol: link.symbol,
      }
      const live = liveByKey.get(link.position_key)
      if (!live) {
        results.push({ ...base, status: 'skipped', reason: 'no live position' })
        continue
      }
      try {
        // The adapter matches symbols exactly — use the live position's casing.
        const res = await tradeService.close({
          exchange: link.exchange,
          symbol: live.symbol,
          accountId: live.accountId,
          fraction: 1,
        })
        results.push({ ...base, status: 'closed', orderId: res.orderId })
      } catch (e) {
        results.push({ ...base, status: 'failed', reason: errMsg(e) })
      }
    }
    const count = (s: string) => results.filter((r) => r.status === s).length
    return c.json({
      groupId: id,
      requested: links.length,
      closed: count('closed'),
      skipped: count('skipped'),
      failed: count('failed'),
      results,
    })
  })

  // Tighten the stops of every group member with an ARMED trail by raising the
  // trail's manual floor through the existing /manage update path. Body:
  // { level } (absolute stop price) or { pct } (distance in percent off the
  // current mark) — exactly one. Stops only ever IMPROVE: a target that is not
  // protective vs the mark, or not tighter than the current effective stop, is
  // skipped and reported. Positions without an armed trail are skipped too.
  // Operator-convenience exception to the sim/live invariant (live-only).
  app.post('/:id/tighten-stops', async (c) => {
    const id = c.req.param('id')
    if (!db.getPositionGroup(id)) return c.json({ error: 'group not found' }, 404)
    let body: { level?: number; pct?: number }
    try {
      body = (await c.req.json()) as { level?: number; pct?: number }
    } catch {
      return c.json({ error: 'JSON body required: { level } or { pct }' }, 400)
    }
    const hasLevel = body.level != null
    const hasPct = body.pct != null
    if (hasLevel === hasPct) {
      return c.json({ error: 'provide exactly one of level, pct' }, 400)
    }
    if (hasLevel && !(typeof body.level === 'number' && Number.isFinite(body.level) && body.level > 0)) {
      return c.json({ error: 'level must be a positive price' }, 400)
    }
    if (hasPct && !(typeof body.pct === 'number' && Number.isFinite(body.pct) && body.pct > 0 && body.pct < 100)) {
      return c.json({ error: 'pct must be a percentage in (0, 100)' }, 400)
    }

    const userId = c.req.header('x-user-id') || 'default'
    const links = db.listPositionGroupLinks().filter((l) => l.group_id === id)
    const liveByKey = await livePositionsForLinks(userId, links)

    const results: Array<{
      positionKey: string
      exchange: string
      accountId: string
      symbol: string
      status: 'tightened' | 'skipped' | 'failed'
      previousStop?: number | null
      newStop?: number
      reason?: string
    }> = []
    for (const link of links) {
      const base = {
        positionKey: link.position_key,
        exchange: link.exchange,
        accountId: link.account_id,
        symbol: link.symbol,
      }
      const live = liveByKey.get(link.position_key)
      if (!live) {
        results.push({ ...base, status: 'skipped', reason: 'no live position' })
        continue
      }
      const trail = db
        .findActiveTrailsForSymbol(link.exchange, link.symbol)
        .find((t) => t.account_id == null || t.account_id === live.accountId)
      if (!trail) {
        results.push({ ...base, status: 'skipped', reason: 'no armed trail' })
        continue
      }
      const mark = live.markPrice && live.markPrice > 0 ? live.markPrice : live.entryPrice
      const dir = trail.direction
      const target =
        body.level != null
          ? body.level
          : dir === 'long'
            ? mark * (1 - body.pct! / 100)
            : mark * (1 + body.pct! / 100)
      const protective = dir === 'long' ? target < mark : target > mark
      if (!protective) {
        results.push({ ...base, status: 'skipped', reason: 'target not protective vs mark' })
        continue
      }
      const current = composeEffectiveStop({
        direction: dir,
        manualStop: trail.manual_stop,
        engineStop: trail.engine_stop ?? trail.current_stop,
        trailingLock: !!trail.trailing_lock,
      })
      const improves = current == null || (dir === 'long' ? target > current : target < current)
      if (!improves) {
        results.push({ ...base, status: 'skipped', previousStop: current, reason: 'current stop already tighter' })
        continue
      }
      try {
        await manageService.manage({
          action: 'update',
          exchange: link.exchange,
          symbol: live.symbol,
          accountId: live.accountId,
          manualStop: target,
        })
        results.push({ ...base, status: 'tightened', previousStop: current, newStop: target })
      } catch (e) {
        results.push({ ...base, status: 'failed', reason: errMsg(e) })
      }
    }
    const count = (s: string) => results.filter((r) => r.status === s).length
    return c.json({
      groupId: id,
      requested: links.length,
      tightened: count('tightened'),
      skipped: count('skipped'),
      failed: count('failed'),
      results,
    })
  })

  return app
}

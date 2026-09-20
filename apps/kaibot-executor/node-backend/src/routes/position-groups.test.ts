import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Hono } from 'hono'
import { KaiBotDatabase } from '../storage/database.js'
import { createPositionGroupRoutes } from './position-groups.js'
import { positionTrailKey } from '../services/position-trail.js'
import { ensureBotGroup, autoLinkPosition } from '../services/position-groups.js'

let dir: string
let db: KaiBotDatabase
let app: Hono

// Overview fan-out uses the exchange manager; one fake connected session with
// two live positions is enough to exercise the join + aggregates.
const fakeExchangeManager = {
  getAllSessions: async () => [
    {
      exchangeName: 'deribit',
      status: 'connected',
      adapter: {
        getPositions: async () => [
          {
            id: '1',
            accountId: 'acc',
            symbol: 'BTC-PERPETUAL',
            side: 'long',
            size: 2,
            entryPrice: 100,
            markPrice: 110,
            unrealizedPnL: 20,
          },
          {
            id: '2',
            accountId: 'acc',
            symbol: 'ETH-PERPETUAL',
            side: 'short',
            size: 3,
            entryPrice: 50,
            markPrice: 40,
            unrealizedPnL: 30,
          },
        ],
      },
    },
  ],
} as any

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-groups-route-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
  app = new Hono()
  app.route('/api/position-groups', createPositionGroupRoutes(db, fakeExchangeManager))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('position-group CRUD routes', () => {
  it('creates, lists, renames and deletes groups', async () => {
    const created = await app.request('/api/position-groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Swing Book' }),
    })
    expect(created.status).toBe(200)
    const { id } = (await created.json()) as { id: string }

    let list = (await (await app.request('/api/position-groups')).json()) as { groups: any[] }
    expect(list.groups).toHaveLength(1)
    expect(list.groups[0].name).toBe('Swing Book')
    expect(list.groups[0].source).toBe('manual')
    expect(list.groups[0].linkedPositions).toBe(0)

    const renamed = await app.request(`/api/position-groups/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Macro Book' }),
    })
    expect(renamed.status).toBe(200)
    expect(db.getPositionGroup(id)?.name).toBe('Macro Book')

    const deleted = await app.request(`/api/position-groups/${id}`, { method: 'DELETE' })
    expect(deleted.status).toBe(200)
    expect(db.listPositionGroups()).toHaveLength(0)
  })

  it('rejects a blank name and a rename of a missing group', async () => {
    const blank = await app.request('/api/position-groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '  ' }),
    })
    expect(blank.status).toBe(400)

    const missing = await app.request('/api/position-groups/nope', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'X' }),
    })
    expect(missing.status).toBe(404)
  })
})

describe('POST /assign', () => {
  it('assigns and unassigns with user precedence', async () => {
    db.createPositionGroup({ id: 'g1', name: 'Mine', source: 'manual' })
    const assign = await app.request('/api/position-groups/assign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ exchange: 'deribit', accountId: 'acc', symbol: 'BTC-PERPETUAL', groupId: 'g1' }),
    })
    expect(assign.status).toBe(200)
    const key = positionTrailKey('deribit', 'acc', 'BTC-PERPETUAL')
    expect(db.getPositionGroupLink(key)?.group_id).toBe('g1')
    expect(db.getPositionGroupLink(key)?.assigned_by).toBe('user')

    const unassign = await app.request('/api/position-groups/assign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ exchange: 'deribit', accountId: 'acc', symbol: 'BTC-PERPETUAL', groupId: null }),
    })
    expect(unassign.status).toBe(200)
    expect(db.getPositionGroupLink(key)?.group_id).toBeNull()
  })

  it('404s on an unknown group and 400s on missing coordinates', async () => {
    const unknown = await app.request('/api/position-groups/assign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ exchange: 'deribit', accountId: 'acc', symbol: 'X', groupId: 'nope' }),
    })
    expect(unknown.status).toBe(404)

    const missing = await app.request('/api/position-groups/assign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ exchange: 'deribit', symbol: 'X' }),
    })
    expect(missing.status).toBe(400)
  })
})

// ── G2 operator actions ──

// Stateful fake for the action endpoints: getSession + getAllSessions over the
// same adapter; records placed orders; rejects ETH orders to exercise the
// partial-failure report.
function actionFakes() {
  const placed: any[] = []
  const adapter = {
    getPositions: async () => [
      {
        id: '1', accountId: 'acc', symbol: 'BTC-PERPETUAL', side: 'long',
        size: 2, entryPrice: 100, markPrice: 90, unrealizedPnL: -20,
      },
      {
        id: '2', accountId: 'acc', symbol: 'ETH-PERPETUAL', side: 'short',
        size: 3, entryPrice: 50, markPrice: 40, unrealizedPnL: 30,
      },
    ],
    getAccounts: async () => [{ id: 'acc' }],
    placeOrder: async (o: any) => {
      if (o.symbol === 'ETH-PERPETUAL') throw new Error('venue rejected')
      placed.push(o)
      return { orderId: `o${placed.length}`, status: 'filled' }
    },
    cancelOrder: async () => {},
  }
  const session = { exchangeName: 'deribit', status: 'connected', adapter }
  const exchangeManager = {
    getSession: async () => session,
    getAllSessions: async () => [session],
  } as any
  return { placed, exchangeManager }
}

describe('POST /:id/close', () => {
  it('closes every live member sequentially, reports skips and failures per position', async () => {
    const { placed, exchangeManager } = actionFakes()
    const actionApp = new Hono()
    actionApp.route('/api/position-groups', createPositionGroupRoutes(db, exchangeManager))

    db.createPositionGroup({ id: 'g1', name: 'Book', source: 'manual' })
    for (const symbol of ['BTC-PERPETUAL', 'ETH-PERPETUAL', 'XRP-PERPETUAL']) {
      db.upsertPositionGroupLink({
        positionKey: positionTrailKey('deribit', 'acc', symbol),
        exchange: 'deribit', accountId: 'acc', symbol,
        groupId: 'g1', assignedBy: 'user',
      })
    }

    const res = await actionApp.request('/api/position-groups/g1/close', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.requested).toBe(3)
    expect(body.closed).toBe(1)
    expect(body.failed).toBe(1)
    expect(body.skipped).toBe(1) // XRP has no live position

    const bySymbol = new Map(body.results.map((r: any) => [r.symbol, r]))
    expect((bySymbol.get('BTC-PERPETUAL') as any).status).toBe('closed')
    expect((bySymbol.get('ETH-PERPETUAL') as any).status).toBe('failed')
    expect((bySymbol.get('XRP-PERPETUAL') as any).status).toBe('skipped')

    // The one executed close is a reduce-only market flatten of the live size.
    expect(placed).toHaveLength(1)
    expect(placed[0].symbol).toBe('BTC-PERPETUAL')
    expect(placed[0].side).toBe('sell')
    expect(placed[0].quantity).toBe(2)
    expect(placed[0].reduceOnly).toBe(true)
  })

  it('404s on an unknown group', async () => {
    const { exchangeManager } = actionFakes()
    const actionApp = new Hono()
    actionApp.route('/api/position-groups', createPositionGroupRoutes(db, exchangeManager))
    const res = await actionApp.request('/api/position-groups/nope/close', { method: 'POST' })
    expect(res.status).toBe(404)
  })
})

describe('POST /:id/tighten-stops', () => {
  const arm = (symbol: string, over: Record<string, unknown> = {}) =>
    db.upsertLocalTrailState({
      signalId: positionTrailKey('deribit', 'acc', symbol),
      exchange: 'deribit',
      symbol,
      direction: 'long',
      entryPrice: 100,
      extremePrice: 100,
      source: 'manual',
      accountId: 'acc',
      mode: 'fixed',
      trailPercentage: 5,
      engineStop: 80,
      currentStop: 80,
      ...over,
    })

  function setup() {
    const fakes = actionFakes()
    const actionApp = new Hono()
    actionApp.route('/api/position-groups', createPositionGroupRoutes(db, fakes.exchangeManager))
    db.createPositionGroup({ id: 'g1', name: 'Book', source: 'manual' })
    for (const symbol of ['BTC-PERPETUAL', 'ETH-PERPETUAL']) {
      db.upsertPositionGroupLink({
        positionKey: positionTrailKey('deribit', 'acc', symbol),
        exchange: 'deribit', accountId: 'acc', symbol,
        groupId: 'g1', assignedBy: 'user',
      })
    }
    return actionApp
  }

  it('raises armed trails’ manual floors (improve-only) and skips members without a trail', async () => {
    const actionApp = setup()
    arm('BTC-PERPETUAL') // ETH stays trail-less

    const res = await actionApp.request('/api/position-groups/g1/tighten-stops', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pct: 2 }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.tightened).toBe(1)
    expect(body.skipped).toBe(1)

    const bySymbol = new Map(body.results.map((r: any) => [r.symbol, r]))
    const btc = bySymbol.get('BTC-PERPETUAL') as any
    expect(btc.status).toBe('tightened')
    // long @ mark 90, pct 2 → 88.2; previous effective stop was 80.
    expect(btc.newStop).toBeCloseTo(90 * 0.98, 9)
    expect(btc.previousStop).toBe(80)
    expect((bySymbol.get('ETH-PERPETUAL') as any).status).toBe('skipped')
    expect((bySymbol.get('ETH-PERPETUAL') as any).reason).toBe('no armed trail')

    const row = db.getLocalTrail(positionTrailKey('deribit', 'acc', 'BTC-PERPETUAL'))!
    expect(row.manual_stop).toBeCloseTo(90 * 0.98, 9)
  })

  it('never loosens: a wider target is skipped, an absolute level only applies when tighter', async () => {
    const actionApp = setup()
    arm('BTC-PERPETUAL', { engineStop: 88.5, currentStop: 88.5 })

    // pct 10 → target 81, current effective 88.5 → skipped.
    const wider = await actionApp.request('/api/position-groups/g1/tighten-stops', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pct: 10 }),
    })
    const widerBody = (await wider.json()) as any
    expect(widerBody.tightened).toBe(0)
    const btcWider = widerBody.results.find((r: any) => r.symbol === 'BTC-PERPETUAL')
    expect(btcWider.status).toBe('skipped')
    expect(btcWider.reason).toBe('current stop already tighter')

    // Absolute level 89 beats 88.5 and is protective vs mark 90 → tightened.
    const level = await actionApp.request('/api/position-groups/g1/tighten-stops', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level: 89 }),
    })
    const levelBody = (await level.json()) as any
    expect(levelBody.tightened).toBe(1)

    // Level 95 would sit above the mark (90) — not protective → skipped.
    const wrongSide = await actionApp.request('/api/position-groups/g1/tighten-stops', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level: 95 }),
    })
    const wrongSideBody = (await wrongSide.json()) as any
    expect(wrongSideBody.tightened).toBe(0)
    expect(wrongSideBody.results.find((r: any) => r.symbol === 'BTC-PERPETUAL').reason).toBe(
      'target not protective vs mark',
    )
  })

  it('validates the body: exactly one of level / pct', async () => {
    const actionApp = setup()
    for (const body of [{}, { level: 1, pct: 1 }, { pct: 0 }, { pct: 100 }, { level: -5 }]) {
      const res = await actionApp.request('/api/position-groups/g1/tighten-stops', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(res.status).toBe(400)
    }
  })
})

describe('GET /overview', () => {
  it('buckets live positions per group with aggregates, Unsorted last', async () => {
    const g = ensureBotGroup(db, { signalBotId: 'bot-1', name: 'Bot One' })
    autoLinkPosition(db, { exchange: 'deribit', accountId: 'acc', symbol: 'BTC-PERPETUAL', groupId: g.id })

    const res = await app.request('/api/position-groups/overview')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { entries: any[] }
    expect(body.entries).toHaveLength(2)

    const bot = body.entries[0]
    expect(bot.group.id).toBe(g.id)
    expect(bot.aggregates.positionCount).toBe(1)
    expect(bot.aggregates.netUnrealizedPnl).toBe(20)
    expect(bot.aggregates.exposure).toBe(220)
    expect(bot.aggregates.stopRisk).toBeNull()
    expect(bot.positions[0].positionKey).toBe(positionTrailKey('deribit', 'acc', 'BTC-PERPETUAL'))

    const unsorted = body.entries[1]
    expect(unsorted.group).toBeNull()
    expect(unsorted.positions[0].symbol).toBe('ETH-PERPETUAL')
  })
})

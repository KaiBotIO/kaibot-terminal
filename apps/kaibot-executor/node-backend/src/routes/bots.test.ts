import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Hono } from 'hono'
import { KaiBotDatabase } from '../storage/database.js'
import { createBotRoutes } from './bots.js'

let dir: string
let db: KaiBotDatabase
let app: Hono

function seedBot(over: Partial<Parameters<KaiBotDatabase['upsertBotConfig']>[0]> = {}) {
  db.upsertBotConfig({
    id: 'bot1:binance:BTCUSDT:1m',
    signalBotId: 'bot1',
    botName: 'EMA bot',
    strategyId: 'strat1',
    strategyName: 'EMA Cross',
    strategyType: 'ema_cross',
    strategyConfig: { type: 'ema_cross', fastPeriod: 3, slowPeriod: 5, source: 'close' },
    exchange: 'binance',
    symbol: 'BTCUSDT',
    timeframe: '1m',
    status: 'running',
    executionTarget: 'kaibot',
    ...over,
  } as any)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-bots-route-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
  app = new Hono()
  app.route('/api/bots', createBotRoutes(db))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('GET /api/bots', () => {
  it('lists all bots projected to the DTO', async () => {
    seedBot()
    const res = await app.request('/api/bots')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { bots: any[] }
    expect(body.bots).toHaveLength(1)
    const b = body.bots[0]
    expect(b.id).toBe('bot1:binance:BTCUSDT:1m')
    expect(b.signalBotId).toBe('bot1')
    expect(b.status).toBe('running')
    expect(b.symbol).toBe('BTCUSDT')
    expect(b.executionTarget).toBe('kaibot')
    // Internal frozen config must NOT leak onto the control plane DTO.
    expect('strategyConfig' in b).toBe(false)
    expect('indicatorSources' in b).toBe(false)
  })

  it('returns an empty list with no bots', async () => {
    const res = await app.request('/api/bots')
    expect(((await res.json()) as { bots: any[] }).bots).toEqual([])
  })
})

describe('GET /api/bots/:id', () => {
  it('returns one bot', async () => {
    seedBot()
    const res = await app.request('/api/bots/bot1:binance:BTCUSDT:1m')
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).strategyName).toBe('EMA Cross')
  })

  it('404 for an unknown id', async () => {
    const res = await app.request('/api/bots/nope')
    expect(res.status).toBe(404)
  })
})

describe('POST /api/bots/:id/start | /stop', () => {
  it('start flips status to running and persists it', async () => {
    seedBot({ status: 'stopped' })
    const res = await app.request('/api/bots/bot1:binance:BTCUSDT:1m/start', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).status).toBe('running')
    expect(db.getBotConfig('bot1:binance:BTCUSDT:1m')!.status).toBe('running')
  })

  it('stop flips status to stopped and persists it', async () => {
    seedBot({ status: 'running' })
    const res = await app.request('/api/bots/bot1:binance:BTCUSDT:1m/stop', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).status).toBe('stopped')
    expect(db.getBotConfig('bot1:binance:BTCUSDT:1m')!.status).toBe('stopped')
  })

  it('start 404 for unknown bot', async () => {
    const res = await app.request('/api/bots/nope/start', { method: 'POST' })
    expect(res.status).toBe(404)
  })
})

describe('POST /api/bots/:id/detach (take-over)', () => {
  it('pauses a running bot and retires its active local trails', async () => {
    seedBot({ status: 'running' })

    // A position opened by this bot: signal carries botConfigId in metadata, and a
    // live local trail (the edge-side position manager) steers its exit.
    const signalId = 'sig-1'
    db.recordSignal({
      id: signalId,
      strategyId: 'strat1',
      symbol: 'BTCUSDT',
      action: 'buy',
      metadata: { source: 'systematic', signalBotId: 'bot1', botConfigId: 'bot1:binance:BTCUSDT:1m' },
    })
    db.updateSignalStatus(signalId, 'executed')
    db.upsertLocalTrailState({
      signalId,
      exchange: 'binance',
      symbol: 'BTCUSDT',
      direction: 'long',
      entryPrice: 100,
      extremePrice: 100,
      trailPercentage: 1,
    })

    const res = await app.request('/api/bots/bot1:binance:BTCUSDT:1m/detach', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.needed).toBe(true)
    expect(body.paused).toBe(true)
    expect(body.retiredManagers).toBe(1)
    expect(body.manager).toBe('manual')

    // Bot paused, trail retired → position reverts to manual on the edge.
    expect(db.getBotConfig('bot1:binance:BTCUSDT:1m')!.status).toBe('paused')
    expect(db.activeLocalTrailsForSignals([signalId])).toHaveLength(0)
  })

  it('pauses a running bot even with no active trails', async () => {
    seedBot({ status: 'running' })
    const res = await app.request('/api/bots/bot1:binance:BTCUSDT:1m/detach', { method: 'POST' })
    const body = (await res.json()) as any
    expect(body.needed).toBe(true)
    expect(body.paused).toBe(true)
    expect(body.retiredManagers).toBe(0)
    expect(db.getBotConfig('bot1:binance:BTCUSDT:1m')!.status).toBe('paused')
  })

  it('no-op for an already-stopped bot with no managers', async () => {
    seedBot({ status: 'stopped' })
    const res = await app.request('/api/bots/bot1:binance:BTCUSDT:1m/detach', { method: 'POST' })
    const body = (await res.json()) as any
    expect(body.needed).toBe(false)
    expect(body.paused).toBe(false)
    expect(body.retiredManagers).toBe(0)
    expect(db.getBotConfig('bot1:binance:BTCUSDT:1m')!.status).toBe('stopped')
  })

  it('detach 404 for unknown bot', async () => {
    const res = await app.request('/api/bots/nope/detach', { method: 'POST' })
    expect(res.status).toBe(404)
  })
})

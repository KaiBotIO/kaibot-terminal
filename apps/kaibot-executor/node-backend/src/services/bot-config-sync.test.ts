import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { KaiBotDatabase } from '../storage/database.js'
import { BotConfigSync, botConfigId } from './bot-config-sync.js'

// HY1 regression: BotConfigSync is now wired into startup (main.ts) — without a
// writer, bot_configs stayed empty while routes/bots.ts, take-over and
// bot-detach all read from it. These tests pin the projection behavior the
// wiring relies on: populate from the server list, prune removed bots, resolve
// executionTarget, and never clobber a locally-set status on re-sync.

let dir: string
let db: KaiBotDatabase
let serverBots: any[] | null = []
const realFetch = globalThis.fetch

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-botsync-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
  serverBots = []
  // Fake the tRPC myList endpoint the sync pulls from.
  globalThis.fetch = (async (url: any) => {
    if (String(url).includes('signalBots.myList')) {
      if (serverBots === null) return new Response('nope', { status: 500 })
      return Response.json({ result: { data: { json: serverBots } } })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function makeSync() {
  return new BotConfigSync(db, {
    getApiUrl: () => 'http://api.test',
    getApiKey: () => 'key-1',
  })
}

const market = { exchange: 'bybit', symbol: 'BTCUSDT', timeframe: '1h' }

describe('BotConfigSync', () => {
  it('projects server bots into bot_configs (one row per bot+market)', async () => {
    serverBots = [
      {
        id: 'bot-1',
        name: 'Alpha',
        strategyId: 'strat-1',
        supportedMarkets: [market, { exchange: 'bybit', symbol: 'ETHUSDT', timeframe: '4h' }],
      },
    ]
    const synced = await makeSync().sync()
    expect(synced).toBe(2)

    const rows = db.getBotConfigs(false)
    expect(rows).toHaveLength(2)
    const btc = db.getBotConfig(botConfigId('bot-1', market))
    expect(btc?.signalBotId).toBe('bot-1')
    expect(btc?.strategyId).toBe('strat-1')
    expect(btc?.status).toBe('running')
    expect(btc?.executionTarget).toBe('kaibot')
  })

  it('prunes configs whose bot/market disappeared server-side', async () => {
    serverBots = [
      { id: 'bot-1', strategyId: 'strat-1', supportedMarkets: [market] },
      { id: 'bot-2', strategyId: 'strat-2', supportedMarkets: [market] },
    ]
    await makeSync().sync()
    expect(db.getBotConfigs(false)).toHaveLength(2)

    serverBots = [{ id: 'bot-1', strategyId: 'strat-1', supportedMarkets: [market] }]
    await makeSync().sync()
    const rows = db.getBotConfigs(false)
    expect(rows).toHaveLength(1)
    expect(rows[0].signalBotId).toBe('bot-1')
  })

  it('preserves a locally-set status across re-syncs (stop must stick)', async () => {
    serverBots = [{ id: 'bot-1', strategyId: 'strat-1', supportedMarkets: [market] }]
    const sync = makeSync()
    await sync.sync()

    const id = botConfigId('bot-1', market)
    db.setBotConfigStatus(id, 'stopped')

    await sync.sync()
    expect(db.getBotConfig(id)?.status).toBe('stopped')
  })

  it('resolves webhook execution routing only when a URL is present', async () => {
    serverBots = [
      {
        id: 'bot-1',
        strategyId: 'strat-1',
        supportedMarkets: [market],
        executionTarget: 'webhook',
        alertWebhookUrl: 'https://hooks.test/x',
      },
      {
        id: 'bot-2',
        strategyId: 'strat-2',
        supportedMarkets: [market],
        executionTarget: 'webhook', // no URL → falls back to kaibot
      },
    ]
    await makeSync().sync()
    expect(db.getBotConfig(botConfigId('bot-1', market))?.executionTarget).toBe('webhook')
    expect(db.getBotConfig(botConfigId('bot-2', market))?.executionTarget).toBe('kaibot')
  })

  it('returns null (keeps last projection) when the server is unavailable', async () => {
    serverBots = [{ id: 'bot-1', strategyId: 'strat-1', supportedMarkets: [market] }]
    const sync = makeSync()
    await sync.sync()

    serverBots = null // server 500s
    const out = await sync.sync()
    expect(out).toBeNull()
    expect(db.getBotConfigs(false)).toHaveLength(1) // nothing pruned
  })

  it('skips discretionary bots (no strategyId) and bots without markets', async () => {
    serverBots = [
      { id: 'disc-1', supportedMarkets: [market] },
      { id: 'bot-1', strategyId: 'strat-1', supportedMarkets: [] },
    ]
    const synced = await makeSync().sync()
    expect(synced).toBe(0)
    expect(db.getBotConfigs(false)).toHaveLength(0)
  })
})

// Ride-bot phase 2: the server's per-market run status projects a phase-out
// onto the local config (and its resume back), never touching a local stop.
import { projectConfigStatus } from './bot-config-sync.js'

describe('projectConfigStatus (phase-out projection)', () => {
  it('new rows follow the server, local stops always win', () => {
    expect(projectConfigStatus(undefined, undefined)).toBe('running')
    expect(projectConfigStatus(undefined, 'phasing_out')).toBe('phasing_out')
    expect(projectConfigStatus('running', 'phasing_out')).toBe('phasing_out')
    expect(projectConfigStatus('phasing_out', 'running')).toBe('running')
    expect(projectConfigStatus('paused', 'running')).toBe('paused')
    expect(projectConfigStatus('stopped', 'phasing_out')).toBe('stopped')
    expect(projectConfigStatus('running', 'stopped')).toBe('running')
  })

  it('sync projects phasing_out from runStatusByMarket and resumes it', async () => {
    serverBots = [{ id: 'bot-1', name: 'Alpha', strategyId: 'strat-1', supportedMarkets: [market], runStatusByMarket: { 'bybit|BTCUSDT|1h': 'phasing_out' } }]
    await makeSync().sync()
    expect(db.getBotConfig(botConfigId('bot-1', market))?.status).toBe('phasing_out')
    serverBots = [{ id: 'bot-1', name: 'Alpha', strategyId: 'strat-1', supportedMarkets: [market], runStatusByMarket: { 'bybit|BTCUSDT|1h': 'running' } }]
    await makeSync().sync()
    expect(db.getBotConfig(botConfigId('bot-1', market))?.status).toBe('running')
  })
})

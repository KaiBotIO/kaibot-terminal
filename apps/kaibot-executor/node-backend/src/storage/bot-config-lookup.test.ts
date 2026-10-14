import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { KaiBotDatabase } from './database.js'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let dir: string
let db: KaiBotDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-bot-config-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const base = { strategyId: 's1', timeframe: '1h', status: 'running' as const }

describe('getBotConfigBySignalBotId', () => {
  it('returns undefined when no config carries the signal-bot id', () => {
    expect(db.getBotConfigBySignalBotId('missing')).toBeUndefined()
  })

  it('point-looks up a config by its signal-bot id', () => {
    db.upsertBotConfig({ ...base, id: 'bot-1:tradestation:MES:1h', signalBotId: 'bot-1', exchange: 'tradestation', symbol: 'MES', botName: 'Ladder' })
    const cfg = db.getBotConfigBySignalBotId('bot-1')
    expect(cfg?.id).toBe('bot-1:tradestation:MES:1h')
    expect(cfg?.botName).toBe('Ladder')
  })

  it('returns the most recently updated row when a bot has one config per market', () => {
    db.upsertBotConfig({ ...base, id: 'bot-1:tradestation:MES:1h', signalBotId: 'bot-1', exchange: 'tradestation', symbol: 'MES' })
    db.upsertBotConfig({ ...base, id: 'bot-1:tradestation:MNQ:1h', signalBotId: 'bot-1', exchange: 'tradestation', symbol: 'MNQ' })
    expect(db.getBotConfigBySignalBotId('bot-1')?.signalBotId).toBe('bot-1')
  })

  it('prefers the row matching the signal symbol over more recent rows', () => {
    db.upsertBotConfig({ ...base, id: 'bot-1:tradestation:MES:1h', signalBotId: 'bot-1', exchange: 'tradestation', symbol: 'MES' })
    db.upsertBotConfig({ ...base, id: 'bot-1:tradestation:MNQ:1h', signalBotId: 'bot-1', exchange: 'tradestation', symbol: 'MNQ' })
    expect(db.getBotConfigBySignalBotId('bot-1', 'MES')?.id).toBe('bot-1:tradestation:MES:1h')
    expect(db.getBotConfigBySignalBotId('bot-1', 'UNKNOWN')?.signalBotId).toBe('bot-1')
  })
})

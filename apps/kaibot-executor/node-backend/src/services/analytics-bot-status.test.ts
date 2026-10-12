import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { KaiBotDatabase } from '../storage/database.js'
import { ALL_ACCOUNTS, type AccountScope } from '../auth/account-scope.js'
import { buildStrategyScorecards, type ClosedRow } from './analytics.js'
import {
  deriveStrategyStatus,
  loadStatusInputs,
  parseDbTimestamp,
  withStrategyStatus,
  type StatusConfig,
  type StatusSubscription,
} from './analytics-bot-status.js'

const T1 = Date.parse('2026-10-10T08:00:00Z')
const T2 = Date.parse('2026-10-11T09:30:00Z')

const cfg = (status: StatusConfig['status'], updatedAt = T1, signalBotId = 'bot-a'): StatusConfig => ({
  signalBotId,
  status,
  updatedAt,
})
const sub = (status: StatusSubscription['status'], updatedAt = T2, signalBotId = 'bot-a'): StatusSubscription => ({
  signalBotId,
  status,
  updatedAt,
})

describe('deriveStrategyStatus', () => {
  it('running: live config and an active sub', () => {
    expect(deriveStrategyStatus('bot-a', [cfg('running')], [sub('active')])).toEqual({
      status: 'running',
      statusSince: T2,
    })
  })

  it('running: server-side bot with an active sub and no local config', () => {
    expect(deriveStrategyStatus('bot-a', [], [sub('active')]).status).toBe('running')
  })

  it('running: a phasing-out config still counts as live', () => {
    expect(deriveStrategyStatus('bot-a', [cfg('phasing_out')], [sub('active')]).status).toBe('running')
  })

  it('paused: all subs paused', () => {
    expect(deriveStrategyStatus('bot-a', [cfg('running')], [sub('paused'), sub('cancelled')])).toEqual({
      status: 'paused',
      statusSince: T2,
    })
  })

  it('paused: active sub but every local config paused (detached)', () => {
    expect(deriveStrategyStatus('bot-a', [cfg('paused', T1)], [sub('active', T2)])).toEqual({
      status: 'paused',
      statusSince: T1,
    })
  })

  it('stopped: subs cancelled and configs stopped', () => {
    expect(deriveStrategyStatus('bot-a', [cfg('stopped', T1)], [sub('cancelled', T2)])).toEqual({
      status: 'stopped',
      statusSince: T2,
    })
  })

  it('unknown: bot id no longer known locally', () => {
    expect(deriveStrategyStatus('bot-gone', [cfg('running')], [sub('active')])).toEqual({
      status: 'unknown',
      statusSince: null,
    })
  })

  it('unknown: unattributed row without bot id', () => {
    expect(deriveStrategyStatus(null, [cfg('running')], [sub('active')]).status).toBe('unknown')
  })

  it('ignores other bots', () => {
    const r = deriveStrategyStatus('bot-a', [cfg('running')], [sub('active', T2, 'bot-b'), sub('paused')])
    expect(r.status).toBe('paused')
  })
})

const closedFor = (signalBotId: string, pnl: number): ClosedRow => ({
  symbol: 'MGCZ26',
  direction: 'long',
  accountId: '21084933',
  exchange: 'tradestation',
  realizedPnl: pnl,
  entryAvg: null,
  exitAvg: null,
  closedAt: T1,
  openDate: T1,
  strategy: signalBotId,
  signalBotId,
})

describe('withStrategyStatus', () => {
  it('keeps the row and adds status fields', () => {
    const rows = withStrategyStatus(buildStrategyScorecards([closedFor('bot-a', 5)]), [], [sub('active')])
    expect(rows[0]).toMatchObject({ key: 'bot-a', status: 'running', statusSince: T2, openExecutions: 0 })
  })

  it('counts open executions per bot', () => {
    const open = [
      { strategy: 'bot-a', signalBotId: 'bot-a' },
      { strategy: 'bot-a', signalBotId: 'bot-a' },
    ]
    const rows = withStrategyStatus(buildStrategyScorecards([closedFor('bot-a', 5)]), [cfg('stopped')], [], open)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ key: 'bot-a', status: 'stopped', openExecutions: 2 })
  })

  it('gives a stopped bot with only an open position its own row, empty metrics', () => {
    const rows = withStrategyStatus(
      buildStrategyScorecards([closedFor('bot-a', 5)]),
      [cfg('stopped', T1, 'bot-x')],
      [sub('cancelled', T2, 'bot-x')],
      [{ strategy: 'X ride', signalBotId: 'bot-x' }],
    )
    const x = rows.find((r) => r.key === 'bot-x')
    expect(x).toMatchObject({ strategy: 'X ride', status: 'stopped', openExecutions: 1, curve: [] })
    expect(x?.summary.hasData).toBe(false)
    expect(x?.summary.totalTrades).toBe(0)
  })
})

describe('parseDbTimestamp', () => {
  it('reads SQLite CURRENT_TIMESTAMP as UTC', () => {
    expect(parseDbTimestamp('2026-10-11 09:30:00')).toBe(T2)
  })
  it('reads ISO strings and rejects junk', () => {
    expect(parseDbTimestamp('2026-10-11T09:30:00.000Z')).toBe(T2)
    expect(parseDbTimestamp('nope')).toBeNull()
    expect(parseDbTimestamp(null)).toBeNull()
  })
})

describe('loadStatusInputs', () => {
  let dir: string
  let db: KaiBotDatabase

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kaibot-botstatus-test-'))
    db = new KaiBotDatabase(join(dir, 'test.db'))
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('maps a detached bot (config paused by take-over) to paused, a bot without rows to unknown', () => {
    db.upsertBotConfig({
      id: 'bot-a:bybit:BTCUSDT:1h',
      signalBotId: 'bot-a',
      strategyId: 's1',
      exchange: 'bybit',
      symbol: 'BTCUSDT',
      timeframe: '1h',
      status: 'running',
    })
    db.upsertSubscription({ id: 'sub-a', signalBotId: 'bot-a', factor: 1, status: 'active' })
    db.setBotConfigStatus('bot-a:bybit:BTCUSDT:1h', 'paused')

    const { configs, subs } = loadStatusInputs(db, ALL_ACCOUNTS)
    expect(configs[0]?.updatedAt).toBeNumber()
    expect(deriveStrategyStatus('bot-a', configs, subs).status).toBe('paused')
    expect(deriveStrategyStatus('bot-b', configs, subs).status).toBe('unknown')
  })

  it("a viewer only sees the subscriptions on the accounts they were granted", () => {
    // Kay holds a cancelled sub on 933; Kai runs the same bot on 931.
    db.upsertSubscription({
      id: 'sub-kay',
      signalBotId: 'bot-x',
      factor: 1,
      exchange: 'tradestation',
      accountId: '21084933',
      status: 'cancelled',
    })
    db.upsertSubscription({
      id: 'sub-kai',
      signalBotId: 'bot-x',
      factor: 1,
      exchange: 'tradestation',
      accountId: '21084931',
      status: 'active',
    })
    const kay: AccountScope = {
      all: false,
      grants: [
        { exchange: 'tradestation', kind: 'account', ref: '21084933' },
        { exchange: 'tradestation', kind: 'account', ref: '21084936' },
      ],
    }

    const forKay = loadStatusInputs(db, kay)
    expect(forKay.subs.map((s) => s.status)).toEqual(['cancelled'])
    expect(deriveStrategyStatus('bot-x', forKay.configs, forKay.subs).status).toBe('stopped')

    const forAdmin = loadStatusInputs(db, ALL_ACCOUNTS)
    expect(deriveStrategyStatus('bot-x', forAdmin.configs, forAdmin.subs).status).toBe('running')
  })
})

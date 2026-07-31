import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { KaiBotDatabase } from '../storage/database.js'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  ensureBotGroup,
  autoLinkPosition,
  clearStaleAutoLinkOnManualEntry,
  groupInfoForPosition,
  computeGroupAggregates,
  buildGroupOverview,
  type GroupedPosition,
} from './position-groups.js'
import { positionTrailKey } from './position-trail.js'
import { detachBot } from './bot-detach.js'

let dir: string
let db: KaiBotDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-groups-svc-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const gp = (over: Partial<GroupedPosition>): GroupedPosition => ({
  exchange: 'deribit',
  accountId: 'acc',
  symbol: 'BTC-PERPETUAL',
  side: 'long',
  size: 1,
  entryPrice: 100,
  markPrice: 110,
  unrealizedPnL: 10,
  positionKey: 'pos:deribit:acc:BTC-PERPETUAL',
  group: null,
  effectiveStop: null,
  expiry: null,
  ...over,
})

describe('ensureBotGroup', () => {
  it('lazily creates one group per bot and is idempotent', () => {
    const g1 = ensureBotGroup(db, { signalBotId: 'bot-1', botConfigId: 'cfg-1', name: 'Crashbot BTC' })
    const g2 = ensureBotGroup(db, { signalBotId: 'bot-1', name: 'other name ignored' })
    expect(g1.id).toBe(g2.id)
    expect(g1.name).toBe('Crashbot BTC')
    expect(g1.source).toBe('bot')
    expect(db.listPositionGroups()).toHaveLength(1)
  })

  it('falls back to a bot-id name when none is known', () => {
    const g = ensureBotGroup(db, { signalBotId: 'abcdef1234567890' })
    expect(g.name).toBe('Bot abcdef12')
  })
})

describe('auto-group on bot fill', () => {
  it('links the position to the bot group; user pin survives later fills', () => {
    const g = ensureBotGroup(db, { signalBotId: 'bot-1', name: 'Bot One' })
    autoLinkPosition(db, { exchange: 'Deribit', accountId: 'acc', symbol: 'btc-perpetual', groupId: g.id })

    // Key derivation is case-normalized like positionTrailKey.
    const info = groupInfoForPosition(db, 'deribit', 'acc', 'BTC-PERPETUAL')
    expect(info?.id).toBe(g.id)
    expect(info?.name).toBe('Bot One')
    expect(info?.source).toBe('bot')

    // User moves it → later auto fill does not steal it back.
    db.createPositionGroup({ id: 'mine', name: 'Mine', source: 'manual' })
    db.upsertPositionGroupLink({
      positionKey: positionTrailKey('deribit', 'acc', 'BTC-PERPETUAL'),
      exchange: 'deribit',
      accountId: 'acc',
      symbol: 'BTC-PERPETUAL',
      groupId: 'mine',
      assignedBy: 'user',
    })
    autoLinkPosition(db, { exchange: 'deribit', accountId: 'acc', symbol: 'BTC-PERPETUAL', groupId: g.id })
    expect(groupInfoForPosition(db, 'deribit', 'acc', 'BTC-PERPETUAL')?.id).toBe('mine')
  })
})

describe('manual entry clears stale auto links', () => {
  it('clears an auto link when no live bot execution remains on the symbol', () => {
    const g = ensureBotGroup(db, { signalBotId: 'bot-1', name: 'Bot One' })
    autoLinkPosition(db, { exchange: 'deribit', accountId: 'acc', symbol: 'BTC-PERPETUAL', groupId: g.id })

    clearStaleAutoLinkOnManualEntry(db, { exchange: 'deribit', accountId: 'acc', symbol: 'BTC-PERPETUAL' })
    expect(groupInfoForPosition(db, 'deribit', 'acc', 'BTC-PERPETUAL')).toBeNull()
  })

  it('keeps the link while a bot execution is live (manual add to bot position)', () => {
    const g = ensureBotGroup(db, { signalBotId: 'bot-1', name: 'Bot One' })
    autoLinkPosition(db, { exchange: 'deribit', accountId: 'acc', symbol: 'BTC-PERPETUAL', groupId: g.id })
    db.insertSignalExecution({
      signalId: 's1',
      symbol: 'BTC-PERPETUAL',
      exchange: 'deribit',
      direction: 'long',
      status: 'open',
      qtyOpened: 5,
    })

    clearStaleAutoLinkOnManualEntry(db, { exchange: 'deribit', accountId: 'acc', symbol: 'BTC-PERPETUAL' })
    expect(groupInfoForPosition(db, 'deribit', 'acc', 'BTC-PERPETUAL')?.id).toBe(g.id)
  })

  it('never clears a user assignment', () => {
    db.createPositionGroup({ id: 'mine', name: 'Mine', source: 'manual' })
    db.upsertPositionGroupLink({
      positionKey: positionTrailKey('deribit', 'acc', 'ETH-PERPETUAL'),
      exchange: 'deribit',
      accountId: 'acc',
      symbol: 'ETH-PERPETUAL',
      groupId: 'mine',
      assignedBy: 'user',
    })
    clearStaleAutoLinkOnManualEntry(db, { exchange: 'deribit', accountId: 'acc', symbol: 'ETH-PERPETUAL' })
    expect(groupInfoForPosition(db, 'deribit', 'acc', 'ETH-PERPETUAL')?.id).toBe('mine')
  })
})

describe('take-over keeps lineage', () => {
  it('detachBot links pre-grouping positions into a takeover-sourced group', () => {
    db.upsertBotConfig({
      id: 'bot-1:deribit:BTC-PERPETUAL:1h',
      signalBotId: 'bot-1',
      botName: 'Crashbot BTC',
      strategyId: 'strat-1',
      exchange: 'deribit',
      symbol: 'BTC-PERPETUAL',
      timeframe: '1h',
      status: 'running',
    })
    // The bot's open signal + its active trail (the edge record carrying the account).
    db.recordSignal({
      id: 'sig-1',
      strategyId: 'strat-1',
      symbol: 'BTC-PERPETUAL',
      action: 'buy',
      price: 100,
      metadata: { botConfigId: 'bot-1:deribit:BTC-PERPETUAL:1h' },
    })
    db.updateSignalStatus('sig-1', 'executed')
    db.upsertLocalTrailState({
      signalId: 'sig-1',
      exchange: 'deribit',
      symbol: 'BTC-PERPETUAL',
      direction: 'long',
      entryPrice: 100,
      extremePrice: 110,
      accountId: 'acc',
      source: 'signal',
    })

    const res = detachBot(db, 'bot-1:deribit:BTC-PERPETUAL:1h')
    expect(res.needed).toBe(true)

    const info = groupInfoForPosition(db, 'deribit', 'acc', 'BTC-PERPETUAL')
    expect(info?.name).toBe('Crashbot BTC')
    // Link persists after detach → lineage kept.
    expect(db.getPositionGroupLink(positionTrailKey('deribit', 'acc', 'BTC-PERPETUAL'))?.group_id).toBe(info?.id ?? '')
  })
})

describe('computeGroupAggregates', () => {
  it('sums pnl, exposure and signed stop risk over members with a stop', () => {
    const agg = computeGroupAggregates([
      gp({ size: 2, markPrice: 110, unrealizedPnL: 20, effectiveStop: 100 }), // long risk (110-100)*2 = 20
      gp({
        symbol: 'ETH-PERPETUAL',
        side: 'short',
        size: 3,
        entryPrice: 50,
        markPrice: 40,
        unrealizedPnL: 30,
        effectiveStop: 45, // short risk (45-40)*3 = 15
      }),
      gp({ symbol: 'SOL_USDC', size: 10, markPrice: 5, entryPrice: 4, unrealizedPnL: undefined }), // no stop
    ])
    expect(agg.positionCount).toBe(3)
    expect(agg.netUnrealizedPnl).toBe(50)
    expect(agg.exposure).toBe(2 * 110 + 3 * 40 + 10 * 5)
    expect(agg.stopRisk).toBe(35)
    expect(agg.stoppedCount).toBe(2)
  })

  it('reports null stop risk when no member has a stop, and locked profit as negative', () => {
    expect(computeGroupAggregates([gp({})]).stopRisk).toBeNull()
    const locked = computeGroupAggregates([gp({ markPrice: 110, effectiveStop: 120, size: 1 })])
    expect(locked.stopRisk).toBe(-10)
  })
})

describe('buildGroupOverview', () => {
  it('buckets live positions per group with Unsorted last and derives effective stops', () => {
    const g = ensureBotGroup(db, { signalBotId: 'bot-1', name: 'Bot One' })
    autoLinkPosition(db, { exchange: 'deribit', accountId: 'acc', symbol: 'BTC-PERPETUAL', groupId: g.id })
    db.upsertLocalTrailState({
      signalId: positionTrailKey('deribit', 'acc', 'BTC-PERPETUAL'),
      exchange: 'deribit',
      symbol: 'BTC-PERPETUAL',
      direction: 'long',
      entryPrice: 100,
      extremePrice: 115,
      accountId: 'acc',
      source: 'manual',
      manualStop: 105,
    })

    const entries = buildGroupOverview(
      db,
      [
        {
          exchange: 'deribit',
          accountId: 'acc',
          symbol: 'BTC-PERPETUAL',
          side: 'long',
          size: 2,
          entryPrice: 100,
          markPrice: 110,
          unrealizedPnL: 20,
        },
        {
          exchange: 'bybit',
          accountId: 'main',
          symbol: 'SOLUSDT',
          side: 'short',
          size: 5,
          entryPrice: 10,
          markPrice: 9,
          unrealizedPnL: 5,
        },
      ],
      db.listActiveLocalTrails(),
    )

    expect(entries).toHaveLength(2)
    expect(entries[0].group?.id).toBe(g.id)
    expect(entries[0].aggregates.positionCount).toBe(1)
    expect(entries[0].positions[0].effectiveStop).toBe(105)
    expect(entries[0].aggregates.stopRisk).toBe((110 - 105) * 2)
    // Unsorted bucket last.
    expect(entries[1].group).toBeNull()
    expect(entries[1].positions[0].symbol).toBe('SOLUSDT')
    expect(entries[1].aggregates.stopRisk).toBeNull()
  })
})

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
  ladder: null,
  ride: null,
  synthetic: null,
  leg: null,
  closeBlockedReason: null,
  unrealizedPnLUsd: null,
  pnlCurrency: 'BTC',
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
  it('sums P&L since entry in USD, exposure and stop risk per contract kind', () => {
    const agg = computeGroupAggregates([
      // TS futures: 1 MES 7773.50 -> 7830.25 = +283.75; stop 7800 risks 30.25 x 5.
      gp({ exchange: 'tradestation', symbol: 'MESZ26', size: 1, entryPrice: 7773.5, markPrice: 7830.25, unrealizedPnL: 283.75, effectiveStop: 7800 }),
      // Deribit inverse short: 1000 USD 2000 -> 1900 = +1000 x 100/2000 = +50; stop 2090
      // risks 1000 x 190/1900 = 100.
      gp({ symbol: 'ETH-PERPETUAL', side: 'short', size: 1000, entryPrice: 2000, markPrice: 1900, unrealizedPnL: 0.0004, effectiveStop: 2090 }),
      // Deribit USDC linear, no stop: 10 x (5 - 4) = +10.
      gp({ symbol: 'SOL_USDC-PERPETUAL', size: 10, markPrice: 5, entryPrice: 4, unrealizedPnL: undefined }),
    ])
    expect(agg.positionCount).toBe(3)
    expect(agg.netUnrealizedPnl).toBeCloseTo(283.75 + 50 + 10, 9)
    expect(agg.netUnrealizedPnlComplete).toBe(true)
    expect(agg.exposure).toBeCloseTo(7830.25 * 5 + 1000 + 10 * 5, 9)
    expect(agg.stopRisk).toBeCloseTo(30.25 * 5 + 100, 9)
    expect(agg.stoppedCount).toBe(2)
  })

  // Regression (positions review 05/10): the group header summed Deribit coin
  // P&L as dollars, so -0.0018 ETH read "-$0.00" next to a winning position.
  it('never adds coin P&L as dollars', () => {
    const agg = computeGroupAggregates([
      gp({ symbol: 'ETH-PERPETUAL', size: 981, entryPrice: 2629.65, markPrice: 2712.41, unrealizedPnL: -0.00184 }),
    ])
    expect(agg.netUnrealizedPnl).toBeCloseTo(30.87, 2)
  })

  it('flags an incomplete sum when a coin P&L has no mark', () => {
    const agg = computeGroupAggregates([
      gp({ symbol: 'ETH-PERPETUAL', size: 981, entryPrice: 0, markPrice: 0, unrealizedPnL: 0.01 }),
      gp({ exchange: 'bybit', symbol: 'ETHUSDT', size: 1, entryPrice: 2500, markPrice: 2510 }),
    ])
    expect(agg.netUnrealizedPnl).toBeCloseTo(10, 9)
    expect(agg.netUnrealizedPnlComplete).toBe(false)
  })

  it('reports null stop risk when no member has a stop, and locked profit as negative', () => {
    expect(computeGroupAggregates([gp({})]).stopRisk).toBeNull()
    const locked = computeGroupAggregates([
      gp({ exchange: 'bybit', symbol: 'BTCUSDT', markPrice: 110, effectiveStop: 120, size: 1 }),
    ])
    expect(locked.stopRisk).toBe(-10)
  })
})

describe('buildGroupOverview', () => {
  it('tags a synthetic USD short with its row; the long next to it stays untagged', () => {
    db.insertSyntheticUsdPosition({
      id: 'syn-eth', exchange: 'deribit', account_id: 'eth', symbol: 'ETH-PERPETUAL',
      target_usd: 12_356, holdings_basis_usd: 12_297.65, leverage: 1, short_size: 12_356, leverage_cap: 2,
    })
    db.updateSyntheticUsdPosition('syn-eth', { arm_trigger_price: 2_471.24, arm_fired_trigger_price: 2_471.24, arm_holdings_coin: 5 })
    const live = (side: 'long' | 'short', accountId: string) => ({
      exchange: 'deribit', accountId, symbol: 'ETH-PERPETUAL', side, size: 12_356, entryPrice: 2_460.79, markPrice: 2_455, unrealizedPnL: 0,
    })
    const [entry] = buildGroupOverview(db, [live('short', 'eth'), live('long', 'acct1/eth')], [])
    const [eth, acct1] = entry.positions
    expect(eth.synthetic).toMatchObject({ id: 'syn-eth', triggerPrice: 2_471.24, shortUsd: 12_356, holdingsCoin: 5 })
    expect(acct1.synthetic).toBeNull()
  })

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
    // Inverse: 2 USD contracts, mark 110 -> stop 105.
    expect(entries[0].aggregates.stopRisk).toBeCloseTo((2 * 5) / 110, 9)
    // Unsorted bucket last.
    expect(entries[1].group).toBeNull()
    expect(entries[1].positions[0].symbol).toBe('SOLUSDT')
    expect(entries[1].aggregates.stopRisk).toBeNull()
  })
})

// 2026-10-14: the eth account's floor hedge (-12.356) and Fault Line's long
// (+1.972) net to one Deribit position of -10.384, listed as Fault Line's.
describe('buildGroupOverview splits a venue position netted with a floor hedge', () => {
  const venue = (size: number, side: 'long' | 'short' = 'short') => ({
    exchange: 'deribit', accountId: 'eth', symbol: 'ETH-PERPETUAL', side, size, entryPrice: 2_455.1, markPrice: 2_450, unrealizedPnL: -0.01,
  })

  function seed(): string {
    db.insertSyntheticUsdPosition({
      id: 'syn-eth', exchange: 'deribit', account_id: 'eth', symbol: 'ETH-PERPETUAL',
      target_usd: 12_356, holdings_basis_usd: 12_297.65, leverage: 1, short_size: 12_356, leverage_cap: 2,
    })
    db.updateSyntheticUsdPosition('syn-eth', { arm_trigger_price: 2_471.24, arm_fired_price: 2_468.5 })
    db.insertSignalExecution({ signalId: 'fl-1', symbol: 'ETH-PERPETUAL', exchange: 'deribit', direction: 'long', status: 'open', qtyOpened: 1_972, accountId: 'eth' })
    db.insertSignalFill({ signalId: 'fl-1', kind: 'entry', symbol: 'ETH-PERPETUAL', side: 'buy', qty: 1_972, price: 2_410 })
    const g = ensureBotGroup(db, { signalBotId: 'fault-line', name: 'Fault Line ETH' })
    autoLinkPosition(db, { exchange: 'deribit', accountId: 'eth', symbol: 'ETH-PERPETUAL', groupId: g.id })
    return g.id
  }

  it('hedge as its own unsorted row, the remainder as the bot long, both carrying the venue net', () => {
    const groupId = seed()
    const entries = buildGroupOverview(db, [venue(10_384)], [])
    const rows = entries.flatMap((e) => e.positions)
    const key = positionTrailKey('deribit', 'eth', 'ETH-PERPETUAL')

    const bot = rows.find((r) => r.leg?.kind === 'bots')!
    expect(bot).toMatchObject({ positionKey: key, side: 'long', size: 1_972, entryPrice: 2_410, synthetic: null })
    expect(bot.group?.id).toBe(groupId)
    expect(bot.leg?.venueNet).toBe(-10_384)
    expect(bot.unrealizedPnL).toBeUndefined()

    const hedge = rows.find((r) => r.leg?.kind === 'floor-hedge')!
    expect(hedge).toMatchObject({ positionKey: `${key}#hedge:syn-eth`, side: 'short', size: 12_356, entryPrice: 2_468.5, group: null })
    expect(hedge.synthetic?.id).toBe('syn-eth')
    expect(hedge.leg?.venueNet).toBe(-10_384)
    expect(rows).toHaveLength(2)
  })

  it('a venue position that is only the hedge stays one row, out of the bot group', () => {
    seed()
    const rows = buildGroupOverview(db, [venue(12_356)], []).flatMap((e) => e.positions)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ size: 12_356, side: 'short', group: null, leg: null, unrealizedPnL: -0.01 })
    expect(rows[0].synthetic?.id).toBe('syn-eth')
  })

  it('a closed hedge leaves the venue position untouched', () => {
    seed()
    db.updateSyntheticUsdPosition('syn-eth', { status: 'closed', short_size: 0 })
    const rows = buildGroupOverview(db, [venue(1_972, 'long')], []).flatMap((e) => e.positions)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ size: 1_972, side: 'long', leg: null, entryPrice: 2_455.1 })
    expect(rows[0].group?.name).toBe('Fault Line ETH')
  })
})

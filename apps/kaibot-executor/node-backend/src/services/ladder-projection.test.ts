import { describe, expect, it } from 'bun:test'
import {
  collectLadders,
  ladderForPosition,
  ladderKey,
  ladderSymbolCandidates,
  type LadderLevel,
} from './bot-config-sync.js'

const long: LadderLevel = {
  side: 'long',
  level: 3,
  tfLabel: '60m',
  entryBar: 10,
  entryPrice: 100,
  lastUpgradeBar: 42,
}
const short: LadderLevel = { ...long, side: 'short', level: 1, tfLabel: '6m' }

describe('collectLadders', () => {
  it('keys the market ladder by (bot, symbol)', () => {
    const map = collectLadders({ id: 'bot-1', ladderByMarket: { 'index|MGC|15m': [long] } })
    expect(map.get(ladderKey('bot-1', 'mgc'))).toEqual({ timeframe: '15m', levels: [long] })
  })

  it('skips markets without levels and bots without a ladder', () => {
    expect(collectLadders({ id: 'b', ladderByMarket: { 'a|B|1h': [] } }).size).toBe(0)
    expect(collectLadders({ id: 'b', ladderByMarket: null }).size).toBe(0)
    expect(collectLadders({ id: 'b' }).size).toBe(0)
  })

  it('ignores a malformed market key', () => {
    expect(collectLadders({ id: 'b', ladderByMarket: { MGC: [long] } }).size).toBe(0)
  })
})

describe('ladderSymbolCandidates', () => {
  it('falls back from a dated contract to its root', () => {
    expect(ladderSymbolCandidates('MGCZ26')).toEqual(['MGCZ26', 'MGC'])
    expect(ladderSymbolCandidates('MNQU26')).toEqual(['MNQU26', 'MNQ'])
  })

  it('falls back from a venue instrument to its base asset', () => {
    expect(ladderSymbolCandidates('BTC-PERPETUAL')).toEqual(['BTC-PERPETUAL', 'BTC'])
    expect(ladderSymbolCandidates('BTC_USDC-PERPETUAL')).toEqual([
      'BTC_USDC-PERPETUAL',
      'BTC',
    ])
  })

  it('leaves a plain symbol alone', () => {
    expect(ladderSymbolCandidates('mgc')).toEqual(['MGC'])
  })
})

describe('ladderForPosition', () => {
  const lookup = (_botId: string, symbol: string) =>
    symbol.toUpperCase() === 'MGC' ? { timeframe: '15m', levels: [long, short] } : null

  it('narrows the ladder to the position side', () => {
    expect(ladderForPosition(lookup, 'bot-1', { symbol: 'MGC', side: 'short' })).toEqual({
      timeframe: '15m',
      levels: [short],
    })
  })

  it('matches a dated contract against the bot root symbol', () => {
    expect(
      ladderForPosition(lookup, 'bot-1', { symbol: 'MGCZ26', side: 'long' }),
    ).toEqual({ timeframe: '15m', levels: [long] })
  })

  it('is null without a lookup, a bot, a symbol match or a side match', () => {
    expect(ladderForPosition(undefined, 'bot-1', { symbol: 'MGC', side: 'long' })).toBeNull()
    expect(ladderForPosition(lookup, null, { symbol: 'MGC', side: 'long' })).toBeNull()
    expect(ladderForPosition(lookup, 'bot-1', { symbol: 'MES', side: 'long' })).toBeNull()
    expect(
      ladderForPosition(() => ({ timeframe: '15m', levels: [short] }), 'bot-1', {
        symbol: 'MGC',
        side: 'long',
      }),
    ).toBeNull()
  })
})

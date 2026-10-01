import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { KaiBotDatabase } from '../storage/database.js'
import { buildStrategyLabels } from './analytics-attribution.js'

let dir: string
let db: KaiBotDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-attribution-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const EXCHANGE = 'tradestation'
const ACCOUNT = '21084933'
const SYMBOL = 'MGCZ26'

// The live 2026-09-01 shape: the Ascender MGC bot holds MGCZ26 on 21084933, and
// the two reconciler round-trips were booked on the SAME account and symbol
// under synthetic non-signal ids.
function seedMgcBook() {
  db.createPositionGroup({
    id: 'g-mgc',
    name: 'Ascender MGC 15m',
    source: 'bot',
    signalBotId: 'bot-mgc',
  })
  db.upsertPositionGroupLink({
    positionKey: `pos:${EXCHANGE}:${ACCOUNT}:${SYMBOL}`,
    exchange: EXCHANGE,
    accountId: ACCOUNT,
    symbol: SYMBOL,
    groupId: 'g-mgc',
    assignedBy: 'auto',
  })
}

const execOf = (signalId: string) => ({
  signal_id: signalId,
  symbol: SYMBOL,
  exchange: EXCHANGE,
  account_id: ACCOUNT,
})

// Regression (Kai, 2026-09-02): attribution resolved on the position group
// alone, which is keyed on (exchange, account, symbol). The two round-trips
// therefore showed up inside the bot's scorecard: 3 trades / -3.001 where the
// bot had done 1 trade / -2.820.
describe('buildStrategyLabels', () => {
  it('labels the bot trade and leaves the reconciler round-trips unattributed', async () => {
    seedMgcBook()
    await db.recordSignal({
      id: '4c82168b',
      strategyId: 'strat',
      strategyName: 'Ascender MGC 15m',
      symbol: SYMBOL,
      action: 'buy',
      metadata: { signalBotId: 'bot-mgc' },
    })

    const labels = buildStrategyLabels(db, [
      execOf('4c82168b'),
      execOf('reconcile-roundtrip:1303499149'),
      execOf('reconcile-roundtrip:1303896425'),
    ])

    expect(labels.get('4c82168b')).toEqual({
      strategy: 'Ascender MGC 15m',
      signalBotId: 'bot-mgc',
    })
    expect(labels.has('reconcile-roundtrip:1303499149')).toBe(false)
    expect(labels.has('reconcile-roundtrip:1303896425')).toBe(false)
  })

  it('leaves a manual order on a bot symbol unattributed', () => {
    seedMgcBook()
    const labels = buildStrategyLabels(db, [execOf('manual:abc123')])
    expect(labels.size).toBe(0)
  })

  it('does not let a signal claim another bot group', async () => {
    seedMgcBook()
    await db.recordSignal({
      id: 'sig-mnq',
      strategyId: 'strat',
      strategyName: 'Ascender MNQ 6m',
      symbol: SYMBOL,
      action: 'buy',
      metadata: { signalBotId: 'bot-mnq' },
    })

    const labels = buildStrategyLabels(db, [execOf('sig-mnq')])
    expect(labels.get('sig-mnq')?.signalBotId).toBe('bot-mnq')
    expect(labels.get('sig-mnq')?.strategy).not.toBe('Ascender MGC 15m')
  })

  it('still resolves a legacy signal without bot metadata by its position', async () => {
    seedMgcBook()
    await db.recordSignal({
      id: 'sig-legacy',
      strategyId: 'strat',
      symbol: SYMBOL,
      action: 'buy',
      metadata: {},
    })

    expect(buildStrategyLabels(db, [execOf('sig-legacy')]).get('sig-legacy')).toEqual({
      strategy: 'Ascender MGC 15m',
      signalBotId: 'bot-mgc',
    })
  })
})

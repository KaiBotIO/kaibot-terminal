import { describe, expect, it } from 'bun:test'
import { derivePositionLineage, type LineageExecution } from './position-lineage.js'

// Chart page (2026-09-05): MES Regime-Slow and MNQ Struct-Entry showed MANUAL
// because the badge matched the bot list on the root symbol while the position
// carries the dated contract. The lineage is the book, not a symbol match.

const exec = (over: Partial<LineageExecution>): LineageExecution => ({
  signal_id: 'sig',
  exchange: 'tradestation',
  symbol: 'MESU26',
  account_id: '21084933',
  direction: 'long',
  status: 'open',
  qty_opened: 1,
  qty_closed: 0,
  ...over,
})

const lookups = {
  signalBotIdFor: (id: string) =>
    ({ 'sig-regime': 'bot-regime-slow', 'sig-struct': 'bot-struct-entry' })[id] ?? null,
  botNameFor: (botId: string) =>
    ({ 'bot-regime-slow': 'Regime-Slow MES 30m', 'bot-struct-entry': 'Struct-Entry MNQ' })[botId] ?? null,
}

describe('derivePositionLineage', () => {
  it('REGRESSION: a bot execution on the dated contract is a BOT position, not manual', () => {
    const rows = derivePositionLineage(
      [
        exec({ signal_id: 'sig-regime', symbol: 'MESU26' }),
        exec({ signal_id: 'sig-struct', symbol: 'MNQU26' }),
      ],
      [],
      lookups,
    )
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.symbol === 'MESU26')).toMatchObject({
      source: 'bot',
      botName: 'Regime-Slow MES 30m',
      signalBotId: 'bot-regime-slow',
      botQty: 1,
    })
    expect(rows.find((r) => r.symbol === 'MNQU26')).toMatchObject({
      source: 'bot',
      botName: 'Struct-Entry MNQ',
    })
  })

  it('an execution without a bot in its entry metadata is manual', () => {
    const rows = derivePositionLineage([exec({ signal_id: 'manual:abc' })], [], lookups)
    expect(rows[0]).toMatchObject({ source: 'manual', botName: null })
  })

  it('a manual marker without executions is listed as manual', () => {
    const rows = derivePositionLineage(
      [],
      [{ exchange: 'tradestation', account_id: '21084933', symbol: 'MGCZ26' }],
      lookups,
    )
    expect(rows).toEqual([
      expect.objectContaining({ symbol: 'MGCZ26', source: 'manual', botQty: 0 }),
    ])
  })

  it('closed executions never count', () => {
    expect(
      derivePositionLineage([exec({ signal_id: 'sig-regime', status: 'closed', qty_closed: 1 })], [], lookups),
    ).toHaveLength(0)
  })

  it('keys on account too: the same contract on two accounts is two lineages', () => {
    const rows = derivePositionLineage(
      [
        exec({ signal_id: 'sig-regime', account_id: 'A' }),
        exec({ signal_id: 'manual:x', account_id: 'B' }),
      ],
      [],
      lookups,
    )
    expect(rows.map((r) => [r.accountId, r.source])).toEqual([
      ['A', 'bot'],
      ['B', 'manual'],
    ])
  })
})

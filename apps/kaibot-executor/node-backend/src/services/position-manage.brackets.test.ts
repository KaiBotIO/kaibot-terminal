// listBrackets: the entry-bracket stop of an open execution, for the
// Positions page. A trail or server exit state on the entry owns the stop, so
// those entries are left out.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { KaiBotDatabase } from '../storage/database.js'
import { createPositionManageService } from './position-manage.js'

let dir: string
let db: KaiBotDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-brackets-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const SYMBOL = 'BTC-PERPETUAL'

function seedEntry(id: string, opts: { stop?: number | null; accountId?: string; slOrderId?: string | null; status?: 'open' | 'closed' } = {}) {
  db.recordSignal({
    id, strategyId: 'strat', symbol: 'BTC', action: 'buy', quantity: 10, price: 83_000,
    stopLoss: opts.stop === undefined ? 75_956.83 : (opts.stop ?? undefined),
    metadata: { exchange: 'deribit' },
  })
  db.insertSignalExecution({
    signalId: id, symbol: SYMBOL, exchange: 'deribit', direction: 'long', status: opts.status ?? 'open',
    qtyOpened: 10, accountId: opts.accountId ?? 'btc',
  })
  if (opts.slOrderId !== null) {
    db.upsertBracketPair({ signalId: id, exchange: 'deribit', accountId: opts.accountId ?? 'btc', slOrderId: opts.slOrderId ?? `SLTS-${id}` })
  }
}

const svc = () => createPositionManageService(db, { getSession: async () => null } as any)

describe('listBrackets', () => {
  it('lists the bracket stop of an open bot entry per account, with its venue order', () => {
    seedEntry('e1')
    seedEntry('e1~child', { accountId: 'acct1/btc' })
    expect(svc().listBrackets()).toEqual([
      { kind: 'bracket', signalId: 'e1', source: 'signal', exchange: 'deribit', accountId: 'btc', symbol: SYMBOL, direction: 'long', stop: 75_956.83, slOrderId: 'SLTS-e1' },
      { kind: 'bracket', signalId: 'e1~child', source: 'signal', exchange: 'deribit', accountId: 'acct1/btc', symbol: SYMBOL, direction: 'long', stop: 75_956.83, slOrderId: 'SLTS-e1~child' },
    ])
  })

  it('keeps a stop without a venue order, marks manual entries and skips stopless or closed ones', () => {
    seedEntry('local', { slOrderId: null })
    seedEntry('manual:abc')
    seedEntry('nostop', { stop: null })
    seedEntry('done', { status: 'closed' })
    const rows = svc().listBrackets()
    expect(rows.map((r) => [r.signalId, r.source, r.slOrderId])).toEqual([
      ['local', 'signal', null],
      ['manual:abc', 'manual', 'SLTS-manual:abc'],
    ])
  })

  it('leaves out entries whose stop a server exit state or an active trail owns', () => {
    seedEntry('server')
    db.upsertServerExitState({
      positionId: 'pos-1', entrySignalId: 'server', exchange: 'deribit', symbol: SYMBOL, direction: 'long',
      currentStop: 76_000, slOrderId: 'sl-x',
    })
    seedEntry('trailed')
    db.upsertLocalTrailState({
      signalId: 'trailed', exchange: 'deribit', symbol: SYMBOL, direction: 'long', entryPrice: 83_000,
      extremePrice: 84_000, currentStop: 77_000, accountId: 'btc',
    })
    seedEntry('plain')
    expect(svc().listBrackets().map((r) => r.signalId)).toEqual(['plain'])
  })
})

// Review r1: "on venue" follows the stop order, not current_stop, which a
// failed replace leaves behind.
describe('venue order on the trail and floor views', () => {
  it('a failed replace keeps the level but drops the order id', () => {
    seedEntry('server')
    db.upsertServerExitState({
      positionId: 'pos-1', entrySignalId: 'server', exchange: 'deribit', symbol: SYMBOL, direction: 'long',
      currentStop: 76_000, slOrderId: 'sl-x',
    })
    db.upsertLocalTrailState({
      signalId: 't1', exchange: 'deribit', symbol: SYMBOL, direction: 'long', entryPrice: 83_000,
      extremePrice: 84_000, currentStop: 77_000, slOrderId: 'sl-t', accountId: 'btc',
    })
    expect(svc().listFloors()[0]).toMatchObject({ currentStop: 76_000, slOrderId: 'sl-x' })
    expect(svc().list()[0]).toMatchObject({ currentStop: 77_000, slOrderId: 'sl-t' })
    db.applyServerExitUpdate('pos-1', { exitSeq: 0, currentStop: 76_000, slOrderId: null })
    expect(svc().listFloors()[0]).toMatchObject({ currentStop: 76_000, slOrderId: null })
  })
})

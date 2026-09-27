import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { KaiBotDatabase } from './database.js'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Exercises the migration-008 storage helpers (order_settlements, bracket_pairs,
// reconciliations) and the 'closing' execution status against a real on-disk DB.

let dir: string
let db: KaiBotDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-recon-test-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('order_settlements', () => {
  it('inserts an unknown settlement and lists it as unresolved', () => {
    const id = db.insertOrderSettlement({
      signalId: 'sig-1',
      exchange: 'tradestation',
      accountId: 'ACC1',
      symbol: 'MESM26',
      kind: 'entry',
      side: 'buy',
      qty: 4,
      orderId: 'ord-1',
    })
    expect(id).toBeGreaterThan(0)
    const unresolved = db.listUnresolvedSettlements()
    expect(unresolved).toHaveLength(1)
    expect(unresolved[0].order_id).toBe('ord-1')
    expect(unresolved[0].status).toBe('unknown')
    expect(db.hasUnresolvedSettlement('sig-1', 'entry')).toBe(true)
    expect(db.hasUnresolvedSettlement('sig-1', 'exit')).toBe(false)
  })

  it('resolving a settlement removes it from the unresolved list', () => {
    const id = db.insertOrderSettlement({
      signalId: 'sig-1', exchange: 'ts', symbol: 'MESM26', kind: 'exit', side: 'sell', qty: 4, orderId: 'ord-9',
    })
    db.resolveOrderSettlement(id, 'filled')
    expect(db.listUnresolvedSettlements()).toHaveLength(0)
  })

  it('scopes unresolved settlements by exchange', () => {
    db.insertOrderSettlement({ signalId: 'a', exchange: 'tradestation', symbol: 'MESM26', kind: 'entry', side: 'buy', qty: 1, orderId: 'o1' })
    db.insertOrderSettlement({ signalId: 'b', exchange: 'bybit', symbol: 'BTCUSDT', kind: 'entry', side: 'buy', qty: 1, orderId: 'o2' })
    expect(db.listUnresolvedSettlements('tradestation')).toHaveLength(1)
    expect(db.listUnresolvedSettlements('bybit')).toHaveLength(1)
  })
})

describe('bracket_pairs persistence (survives restart)', () => {
  it('persists a pair and reloads it after a simulated restart', () => {
    db.upsertBracketPair({ signalId: 'sig-1', exchange: 'deribit', slOrderId: 'sl-1', tpOrderId: 'tp-1' })
    db.close()

    // Reopen the same DB file → migrations already applied, data intact.
    db = new KaiBotDatabase(join(dir, 'test.db'))
    const pairs = db.listBracketPairs()
    expect(pairs).toHaveLength(1)
    expect(pairs[0]).toMatchObject({ signal_id: 'sig-1', sl_order_id: 'sl-1', tp_order_id: 'tp-1' })
  })

  it('upsert replaces the order ids for the same signal', () => {
    db.upsertBracketPair({ signalId: 'sig-1', exchange: 'deribit', slOrderId: 'sl-1', tpOrderId: 'tp-1' })
    db.upsertBracketPair({ signalId: 'sig-1', exchange: 'deribit', slOrderId: 'sl-2', tpOrderId: null })
    const pairs = db.listBracketPairs()
    expect(pairs).toHaveLength(1)
    expect(pairs[0].sl_order_id).toBe('sl-2')
    expect(pairs[0].tp_order_id).toBeNull()
  })

  it('deletes a pair', () => {
    db.upsertBracketPair({ signalId: 'sig-1', exchange: 'deribit', slOrderId: 'sl-1', tpOrderId: 'tp-1' })
    db.deleteBracketPair('sig-1')
    expect(db.listBracketPairs()).toHaveLength(0)
  })

  it('counts a bracket leg as a known order id', () => {
    db.upsertBracketPair({ signalId: 'sig-1', exchange: 'tradestation', slOrderId: 'sl-1', tpOrderId: 'tp-1' })
    const known = db.listKnownOrderIds('tradestation')
    expect(known.has('sl-1')).toBe(true)
    expect(known.has('tp-1')).toBe(true)
  })
})

describe('reconciliations audit log', () => {
  it('records a correction and a flagged mismatch', () => {
    db.insertReconciliation({
      exchange: 'tradestation', accountId: 'ACC1', symbol: 'MESM26',
      expectedNet: 4, brokerNet: 2, delta: 2, action: 'corrected', side: 'buy', qty: 2, orderId: 'ord-c', status: 'filled',
    })
    db.insertReconciliation({
      exchange: 'tradestation', accountId: 'ACC1', symbol: 'MNQM26',
      expectedNet: 0, brokerNet: 50, delta: -50, action: 'skipped_large',
    })
    const rows = db.listRecentReconciliations()
    expect(rows).toHaveLength(2)
    const actions = rows.map((r) => r.action)
    expect(actions).toContain('corrected')
    expect(actions).toContain('skipped_large')
    const correction = rows.find((r) => r.action === 'corrected')!
    expect(correction.order_id).toBe('ord-c')
  })
})

// Regression (live-data-review 28/08): the "latest per symbol" query grouped on
// the symbol alone, so the 26/08 incident on account 21084931 painted the
// healthy MNQ position of account 21084933 with a red MISMATCH badge.
describe('latestReconciliationPerSymbol scopes to (account, symbol)', () => {
  it('keeps one latest row per account for the same contract', () => {
    db.insertReconciliation({
      exchange: 'tradestation', accountId: '21084931', symbol: 'MNQU26',
      expectedNet: 0, brokerNet: -1, delta: 1, action: 'alert_observed_mismatch',
    })
    db.insertReconciliation({
      exchange: 'tradestation', accountId: '21084933', symbol: 'MNQU26',
      expectedNet: 1, brokerNet: 1, delta: 0, action: 'corrected',
    })

    const latest = db.latestReconciliationPerSymbol('tradestation')
    expect(latest).toHaveLength(2)
    const byAccount = new Map(latest.map((r) => [r.account_id, r]))
    expect(byAccount.get('21084931')!.delta).toBe(1)
    expect(byAccount.get('21084933')!.delta).toBe(0)
  })

  it('returns the newest row per pair, not per symbol', async () => {
    db.insertReconciliation({
      exchange: 'tradestation', accountId: 'ACC1', symbol: 'MGCZ26',
      expectedNet: 0, brokerNet: 1, delta: -1, action: 'skipped_working',
    })
    // ts is millisecond-resolution; both rows in the same tick are both "latest".
    await Bun.sleep(2)
    db.insertReconciliation({
      exchange: 'tradestation', accountId: 'ACC1', symbol: 'MGCZ26',
      expectedNet: 1, brokerNet: 1, delta: 0, action: 'corrected',
    })

    const latest = db.latestReconciliationPerSymbol('tradestation')
    expect(latest).toHaveLength(1)
    expect(latest[0].action).toBe('corrected')
  })
})

describe("signal_executions 'closing' status", () => {
  it('lists closing executions and transitions back to closed', () => {
    db.insertSignalExecution({ signalId: 's1', symbol: 'MESM26', exchange: 'tradestation', direction: 'long', status: 'open', qtyOpened: 4 })
    db.updateSignalExecution('s1', { status: 'closing' })
    let closing = db.listClosingExecutions()
    expect(closing).toHaveLength(1)
    expect(closing[0].signal_id).toBe('s1')

    db.updateSignalExecution('s1', { status: 'closed' })
    closing = db.listClosingExecutions()
    expect(closing).toHaveLength(0)
  })

  it('lists open/closing executions for an exchange and distinct symbols', () => {
    db.insertSignalExecution({ signalId: 's1', symbol: 'MESM26', exchange: 'tradestation', direction: 'long', status: 'open', qtyOpened: 4 })
    db.insertSignalExecution({ signalId: 's2', symbol: 'MNQM26', exchange: 'tradestation', direction: 'short', status: 'closing', qtyOpened: 2 })
    db.insertSignalExecution({ signalId: 's3', symbol: 'BTCUSDT', exchange: 'bybit', direction: 'long', status: 'open', qtyOpened: 1 })

    expect(db.listOpenExecutionsForExchange('tradestation')).toHaveLength(2)
    expect(db.listExecutionSymbols('tradestation').map((r) => r.symbol).sort()).toEqual(['MESM26', 'MNQM26'])
  })
})

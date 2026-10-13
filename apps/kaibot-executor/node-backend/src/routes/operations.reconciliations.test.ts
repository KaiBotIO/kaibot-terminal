import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Hono } from 'hono'
import { KaiBotDatabase } from '../storage/database.js'
import { createOperationsRoutes } from './operations.js'
import type { ExchangeManager } from '../services/exchanges/exchangeManager.js'
import type { ReconciliationRow } from '../storage/types.js'

let dir: string
let db: KaiBotDatabase
let app: Hono

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-ops-recon-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
  app = new Hono()
  const exchangeManager = { getSession: async () => null } as unknown as ExchangeManager
  app.route('/api/ops', createOperationsRoutes(db, exchangeManager))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

type Finding = ReconciliationRow & { finding: 'settled' | 'open' | 'archived' }

const get = async () => {
  const res = await app.request('/api/ops/reconciliations')
  expect(res.status).toBe(200)
  return (await res.json()) as {
    latestPerSymbol: Finding[]
    mismatched: Finding[]
    archived: Finding[]
    reconciler: { lastTickAt: number | null; lastCleanPassAt: number | null; intervalMs: number } | null
  }
}

// Regression (live-data-review 28/08): the accidental short on 26/08 was adopted
// onto the books 2.5 minutes later, but `adopted_existing` was not in the
// resolved set, so the page kept reporting "MISMATCHED 1 / MATCHED 0" two days
// after the book was clean.
describe('reconciliation status treats an adoption as settled', () => {
  it('does not report an adopted overhang as an open mismatch', async () => {
    db.insertReconciliation({
      exchange: 'tradestation', accountId: '21084931', symbol: 'MNQU26',
      expectedNet: 0, brokerNet: -1, delta: 1, action: 'adopted_existing',
    })

    const body = await get()
    expect(body.latestPerSymbol).toHaveLength(1)
    expect(body.mismatched).toHaveLength(0)
  })

  it('still reports drift the reconciler could not settle', async () => {
    db.insertReconciliation({
      exchange: 'tradestation', accountId: '21084931', symbol: 'MNQU26',
      expectedNet: 0, brokerNet: 50, delta: -50, action: 'skipped_large',
    })

    const body = await get()
    expect(body.mismatched).toHaveLength(1)
    expect(body.mismatched[0].account_id).toBe('21084931')
  })

  it('scopes an open mismatch to the account that has it', async () => {
    db.insertReconciliation({
      exchange: 'tradestation', accountId: '21084931', symbol: 'MNQU26',
      expectedNet: 0, brokerNet: -1, delta: 1, action: 'alert_observed_mismatch',
    })
    db.insertReconciliation({
      exchange: 'tradestation', accountId: '21084933', symbol: 'MNQU26',
      expectedNet: 1, brokerNet: 1, delta: 0, action: 'corrected',
    })

    const body = await get()
    expect(body.mismatched.map((r) => r.account_id)).toEqual(['21084931'])
  })
})

// Kai, 2026-09-05: findings from before account scoping (no account_id) can
// never resolve, so they must not keep inflating the open count.
describe('legacy findings without an account are archived', () => {
  it('keeps an accountless finding out of open', async () => {
    db.insertReconciliation({
      exchange: 'tradestation', accountId: '', symbol: 'MGCZ26',
      expectedNet: 1, brokerNet: 0, delta: 1, action: 'skipped_large',
    })

    const body = await get()
    expect(body.mismatched).toHaveLength(0)
    expect(body.archived).toHaveLength(1)
    expect(body.archived[0].symbol).toBe('MGCZ26')
    expect(body.latestPerSymbol[0].finding).toBe('archived')
  })

  it('still opens the same drift once it carries an account', async () => {
    db.insertReconciliation({
      exchange: 'tradestation', accountId: '21084933', symbol: 'MGCZ26',
      expectedNet: 1, brokerNet: 0, delta: 1, action: 'skipped_large',
    })

    const body = await get()
    expect(body.mismatched).toHaveLength(1)
    expect(body.archived).toHaveLength(0)
  })

  it('reports the reconciler heartbeat when a status getter is wired', async () => {
    const withLoop = new Hono()
    withLoop.route(
      '/api/ops',
      createOperationsRoutes(db, { getSession: async () => null } as unknown as ExchangeManager, undefined, undefined, undefined, () => ({
        lastTickAt: 1_700_000_060_000,
        lastCleanPassAt: 1_700_000_060_000,
        intervalMs: 60_000,
      })),
    )
    const res = await withLoop.request('/api/ops/reconciliations')
    const body = (await res.json()) as { reconciler: { lastCleanPassAt: number | null } | null }
    expect(body.reconciler?.lastCleanPassAt).toBe(1_700_000_060_000)
  })

  it('reports no heartbeat when nothing is wired', async () => {
    const body = await get()
    expect(body.reconciler).toBeNull()
  })
})

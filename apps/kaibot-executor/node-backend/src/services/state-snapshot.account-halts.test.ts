import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { KaiBotDatabase } from '../storage/database.js'
import { assembleExecutorState } from './state-snapshot.js'
import type { ExchangeManager } from './exchanges/exchangeManager.js'

describe('executor state snapshot', () => {
  it('carries the account halts next to the global flag', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kaibot-snap-halts-'))
    const db = new KaiBotDatabase(join(dir, 'test.db'))
    try {
      db.setAccountHalt('tradestation', '21084931', true, 'daily_loss')
      const manager = { getAllSessions: async () => [] } as unknown as ExchangeManager
      const snap = await assembleExecutorState(db, manager)
      expect(snap.halt.halted).toBe(false)
      expect(snap.accountHalts).toMatchObject([{ exchange: 'tradestation', account_id: '21084931', reason: 'daily_loss' }])
      expect(snap.guardrails.accountHalts).toHaveLength(1)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

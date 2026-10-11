import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Hono } from 'hono'
import { KaiBotDatabase } from '../storage/database.js'
import { createOperationsRoutes } from './operations.js'
import type { ExchangeManager } from '../services/exchanges/exchangeManager.js'
import type { AccountScope } from '../auth/account-scope.js'

// GET/POST /api/ops/halt: the global flag and per-account halts, independent.

let dir: string
let db: KaiBotDatabase

function app(scope?: AccountScope) {
  const a = new Hono()
  if (scope) {
    a.use('*', async (c, next) => {
      c.set('accountScope', scope)
      await next()
    })
  }
  a.route('/api/ops', createOperationsRoutes(db, {} as ExchangeManager))
  return a
}

const post = (body: unknown) =>
  app().request('/api/ops/halt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-ops-halt-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('/api/ops/halt', () => {
  it('GET returns the global flag plus the account halts', async () => {
    db.setAccountHalt('tradestation', '21084931', true, 'daily_loss')
    const res = await app().request('/api/ops/halt')
    const body = (await res.json()) as any
    expect(body.halted).toBe(false)
    expect(body.accounts).toHaveLength(1)
    expect(body.accounts[0]).toMatchObject({ exchange: 'tradestation', account_id: '21084931', reason: 'daily_loss' })
  })

  it('POST with exchange+accountId sets and clears one account, the global flag untouched', async () => {
    db.setHaltState(true, 'panic')
    let body = (await (await post({ halted: true, exchange: 'deribit', accountId: 'eth' })).json()) as any
    expect(body.accounts.map((h: any) => `${h.exchange}:${h.account_id}`)).toEqual(['deribit:eth'])
    expect(body.halted).toBe(true)

    body = (await (await post({ halted: false, exchange: 'deribit', accountId: 'eth' })).json()) as any
    expect(body.accounts).toHaveLength(0)
    expect(body.halted).toBe(true)
  })

  it('clearing the global flag keeps account halts', async () => {
    db.setHaltState(true, 'panic')
    db.setAccountHalt('tradestation', '21084931', true, 'daily_loss')
    const body = (await (await post({ halted: false })).json()) as any
    expect(body.halted).toBe(false)
    expect(body.accounts).toHaveLength(1)
  })

  it('an account halt needs both exchange and accountId', async () => {
    const res = await post({ halted: true, exchange: 'deribit' })
    expect(res.status).toBe(400)
    expect(db.listAccountHalts()).toHaveLength(0)
    expect(db.getHaltState().halted).toBe(false)
  })

  it('a viewer only sees halts of granted accounts', async () => {
    db.setAccountHalt('tradestation', '21084931', true, 'daily_loss')
    db.setAccountHalt('tradestation', '21084933', true, 'daily_loss')
    const scope: AccountScope = { all: false, grants: [{ exchange: 'tradestation', kind: 'account', ref: '21084933' }] }
    const body = (await (await app(scope).request('/api/ops/halt')).json()) as any
    expect(body.accounts.map((h: any) => h.account_id)).toEqual(['21084933'])
  })
})

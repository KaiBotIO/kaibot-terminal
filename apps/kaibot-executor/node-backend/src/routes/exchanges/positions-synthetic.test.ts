// The fired synthetic short on Positions (live 08/10: deribit/eth short
// 12.356 USD read as "manual, no stop"): the row carries its synthetic row.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Hono } from 'hono'
import { KaiBotDatabase } from '../../storage/database.js'
import { createRoleMiddleware } from '../../auth/roles.js'
import { scopeForUser } from '../../auth/account-scope.js'
import { createExchangeRoutes } from './index.js'
import type { ExchangeManager } from '../../services/exchanges/exchangeManager.js'
import type { UserRole } from '../../storage/types.js'

const positions = [
  { accountId: 'eth', symbol: 'ETH-PERPETUAL', side: 'short', size: 12_356 },
  { accountId: 'btc', symbol: 'BTC-PERPETUAL', side: 'long', size: 2_950 },
  { accountId: 'acct1/eth', symbol: 'ETH-PERPETUAL', side: 'short', size: 500 },
]
const session = (label: string, rows: typeof positions) => ({
  userId: 'default',
  exchangeName: 'deribit',
  label,
  accountKey: label === 'default' ? undefined : label,
  connectionId: label === 'default' ? 'default:deribit' : `default:deribit:${label}`,
  status: 'connected' as const,
  lastRefresh: 0,
  adapter: {
    async getPositions() {
      return rows.map((p) => ({
        id: `${p.symbol}@${p.accountId}`, ...p, entryPrice: 2_460.79, markPrice: 2_455, unrealizedPnL: 0,
      }))
    },
  } as any,
})
const SESSIONS = [
  session('default', positions.slice(0, 2)),
  session('acct1', positions.slice(2)),
]
const manager = {
  getAllSessions: async () => SESSIONS,
  getSessions: async () => SESSIONS,
  getSession: async (_u: string, _e: string, key?: string) => SESSIONS.find((s) => s.label === (key || 'default')),
} as unknown as ExchangeManager

let dir: string
let db: KaiBotDatabase

function appAs(role: UserRole, userId: number) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('role', role)
    c.set('userId', userId)
    c.set('accountScope', scopeForUser(db, userId, role))
    return next()
  })
  app.use('/api/*', createRoleMiddleware())
  app.route('/api/exchanges/v2', createExchangeRoutes(db, manager))
  return app
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-pos-synth-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
  const synth = { target_usd: 12_356, holdings_basis_usd: 12_297.65, leverage: 1, short_size: 12_356, leverage_cap: 2 }
  db.insertSyntheticUsdPosition({ id: 'syn-eth', exchange: 'deribit', account_id: 'eth', symbol: 'ETH-PERPETUAL', ...synth })
  db.updateSyntheticUsdPosition('syn-eth', {
    arm_direction: 'long', arm_trigger_price: 2_471.2424, arm_fired_trigger_price: 2_471.2424,
    arm_fired_price: 2_460.79, arm_fired_at: 1_791_472_995_129, arm_holdings_coin: 5,
  })
  // Armed only (no short yet): never a tag.
  db.insertSyntheticUsdPosition({
    id: 'syn-acct1', exchange: 'deribit', account_id: 'acct1/eth', symbol: 'ETH-PERPETUAL', ...synth, status: 'armed',
  })
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const get = async (app: Hono) => {
  const res = await app.request('/api/exchanges/v2/positions/deribit')
  expect(res.status).toBe(200)
  return (await res.json()) as any[]
}

describe('positions v2: synthetic hedge tag', () => {
  it('tags the short of an open synthetic row with trigger and holdings, nothing else', async () => {
    await db.createAdminUser('kai', 'admin-password')
    const rows = await get(appAs('admin', db.getUserByUsername('kai')!.id))
    const eth = rows.find((p) => p.accountId === 'eth')
    expect(eth.synthetic).toEqual({
      id: 'syn-eth', triggerPrice: 2_471.2424, firedPrice: 2_460.79, firedAt: 1_791_472_995_129,
      shortUsd: 12_356, holdingsCoin: 5, holdingsUsd: 12_297.65,
    })
    expect(rows.find((p) => p.accountId === 'btc').synthetic).toBeNull()
    expect(rows.find((p) => p.accountId === 'acct1/eth').synthetic).toBeNull()
  })

  it('a viewer granted the connection sees the same tag', async () => {
    const kay = await db.createViewerUser('kay', 'viewer-pass-1')
    db.setAccountGrants(kay.id, [{ exchange: 'deribit', kind: 'connection', ref: 'default' }])
    const rows = await get(appAs('viewer', kay.id))
    expect(rows.map((p) => p.accountId)).toEqual(['eth', 'btc'])
    expect(rows[0].synthetic?.id).toBe('syn-eth')
  })
})

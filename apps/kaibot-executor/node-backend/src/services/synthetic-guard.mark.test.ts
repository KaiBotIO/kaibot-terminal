import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { KaiBotDatabase } from '../storage/database.js'
import { PaperExchangeAdapter } from './exchanges/adapters/paper.js'
import { scopeAdapter } from './exchanges/account-scope.js'
import { orderLockIdle } from './order-lock.js'
import { createSyntheticUsdService } from './synthetic-usd.js'
import { createSyntheticGuardService, MARK_CACHE_TTL_MS, type SyntheticGuardService } from './synthetic-guard.js'

const ETH = 'ETH-PERPETUAL'
const TIMEOUT = 'The operation timed out.'

// acct1 (labeled connection, flat on ETH) needs the public ticker for its mark;
// the default connection quotes the same venue-wide price.
describe('armed floor mark on a labeled connection (acct1)', () => {
  let dir: string
  let db: KaiBotDatabase
  let defaultInner: PaperExchangeAdapter
  let acct1Inner: PaperExchangeAdapter
  let defaultSession: any
  let acct1Session: any
  let guard: SyntheticGuardService
  let clock: number
  let acct1Fails: number
  let defaultFails: boolean

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kaibot-floor-mark-'))
    db = new KaiBotDatabase(join(dir, 'test.db'))
    clock = 1_000_000
    acct1Fails = 0
    defaultFails = false
    defaultInner = new PaperExchangeAdapter('deribit', { [ETH]: 2_455 })
    acct1Inner = new PaperExchangeAdapter('deribit', { [ETH]: 2_455 })
    ;(defaultInner as any).quoteLastPrice = async () => {
      if (defaultFails) throw new Error(TIMEOUT)
      return 2_455
    }
    ;(acct1Inner as any).quoteLastPrice = async () => {
      if (acct1Fails !== 0) {
        if (acct1Fails > 0) acct1Fails--
        throw new Error(TIMEOUT)
      }
      return 2_456
    }
    defaultSession = { status: 'connected', adapter: defaultInner, label: 'default' }
    acct1Session = { status: 'connected', adapter: scopeAdapter(acct1Inner as any, 'acct1'), label: 'acct1', accountKey: 'acct1' }
    const manager = {
      getSession: async (_u: string, _e: string, key?: string) =>
        key === 'acct1' ? acct1Session : key ? undefined : defaultSession,
      getSessions: async () => [defaultSession, acct1Session],
    }
    guard = createSyntheticGuardService(db, manager as any, createSyntheticUsdService(db, manager as any), null, 'default', {
      now: () => clock,
    })
  })

  afterEach(async () => {
    await orderLockIdle()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const arm = () =>
    guard.arm({ exchange: 'deribit', accountId: 'eth', accountKey: 'acct1', symbol: ETH, triggerPrice: 1_503.85, holdingsCoin: 5 })

  it('acct1 ticker down, default session up: the mark comes from the default connection', async () => {
    const row = await arm()
    expect(row.account_id).toBe('acct1/eth')
    acct1Fails = -1
    clock += MARK_CACHE_TTL_MS * 10 // no cache to lean on
    const p = await guard.preflight(row.id)
    expect(p).toMatchObject({ canFire: true, reason: null, connected: true, mark: 2_455 })
  })

  it('one timeout is bridged by the last good mark, then the ticker recovers', async () => {
    defaultSession.status = 'error'
    const row = await arm()
    let p = await guard.preflight(row.id)
    expect(p).toMatchObject({ canFire: true, mark: 2_456 })

    acct1Fails = 1
    clock += 5_000
    p = await guard.preflight(row.id)
    // Still fireable, but the operator sees the guard is blind right now.
    expect(p).toMatchObject({ canFire: true, mark: 2_456 })
    expect(p.reason).toBe(`cached mark for ${ETH} 5s old, ticker failed (${TIMEOUT})`)

    p = await guard.preflight(row.id)
    expect(p).toMatchObject({ canFire: true, reason: null, mark: 2_456 })
  })

  it('distinguishes ticker failed from stale mark', async () => {
    defaultSession.status = 'error'
    const row = await arm()
    acct1Fails = -1
    clock += MARK_CACHE_TTL_MS + 30_000
    let p = await guard.preflight(row.id)
    expect(p.canFire).toBe(false)
    expect(p.reason).toBe(`stale mark for ${ETH}: last good 90s ago, ticker failed (${TIMEOUT})`)

    // A fresh row on a symbol never quoted: no cache at all.
    db.updateSyntheticUsdPosition(row.id, { arm_last_mark: null, arm_last_mark_at: null })
    const fresh = createSyntheticGuardService(
      db,
      { getSession: async (_u: string, _e: string, k?: string) => (k === 'acct1' ? acct1Session : undefined), getSessions: async () => [acct1Session] } as any,
      createSyntheticUsdService(db, {} as any),
      null,
      'default',
      { now: () => clock },
    )
    p = await fresh.preflight(row.id)
    expect(p.reason).toBe(`no mark for ${ETH}: ticker failed (${TIMEOUT})`)
  })

  it('no connected session on the row is reported as such', async () => {
    defaultSession.status = 'error'
    const row = await arm()
    acct1Session.status = 'error'
    defaultSession.status = 'error'
    const p = await guard.preflight(row.id)
    expect(p.reason).toMatch(/not connected/)
  })

  it('the tick never fires on a cached mark', async () => {
    defaultSession.status = 'error'
    const row = await arm()
    expect((await guard.preflight(row.id)).mark).toBe(2_456)
    // Cached 2.456 sits below this trigger: firing on it would mint.
    db.updateSyntheticUsdPosition(row.id, { arm_trigger_price: 2_460 })
    acct1Fails = -1
    clock += 1_000
    await guard.tickExchange('deribit', acct1Session.adapter, [])
    await orderLockIdle()
    expect(db.getSyntheticUsdPosition(row.id)!.status).toBe('armed')
    expect(acct1Inner.getOrders()).toHaveLength(0)
  })

  it('never takes a testnet price for a mainnet row: the tick holds, the preflight says why', async () => {
    const row = await arm()
    expect((await guard.preflight(row.id)).mark).toBe(2_456)
    // Testnet would quote 2.455, below this trigger: using it would mint.
    db.updateSyntheticUsdPosition(row.id, { arm_trigger_price: 2_460 })
    ;(defaultInner as any).isTestnet = true
    acct1Fails = -1
    clock += MARK_CACHE_TTL_MS + 1_000
    await guard.tickExchange('deribit', acct1Session.adapter, [])
    await orderLockIdle()
    expect(db.getSyntheticUsdPosition(row.id)!.status).toBe('armed')
    expect(acct1Inner.getOrders()).toHaveLength(0)
    expect(defaultInner.getOrders()).toHaveLength(0)
    const p = await guard.preflight(row.id)
    expect(p.canFire).toBe(false)
    expect(p.reason).toContain(`ticker failed (${TIMEOUT}; 1 testnet session not used (other environment))`)
  })

  it('a hanging venue costs one budget per lookup, not one timeout per session', async () => {
    const hang = () => new Promise<number>(() => {})
    ;(acct1Inner as any).quoteLastPrice = hang
    ;(defaultInner as any).quoteLastPrice = hang
    const manager = {
      getSession: async (_u: string, _e: string, key?: string) => (key === 'acct1' ? acct1Session : defaultSession),
      getSessions: async () => [defaultSession, acct1Session],
    }
    const g = createSyntheticGuardService(db, manager as any, createSyntheticUsdService(db, manager as any), null, 'default', {
      markBudgetMs: 150,
    })
    const row = await g.arm({
      exchange: 'deribit', accountId: 'eth', accountKey: 'acct1', symbol: ETH, triggerPrice: 1_503.85, holdingsCoin: 5,
    })
    db.updateSyntheticUsdPosition(row.id, { arm_last_mark: null, arm_last_mark_at: null })
    const t0 = Date.now()
    const p = await g.preflight(row.id)
    expect(Date.now() - t0).toBeLessThan(1_000)
    expect(p.reason).toContain('mark lookup budget used up')
  })
})

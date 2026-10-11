// Whipsaw guard (migration 051): recovery confirmed on the UTC hour close, and
// the short held after repeated triggers at one level. Live 11/10: ETH floor
// minted 08/10, covered 11/10 after the 2 % recovery, re-armed at the same
// trigger with no cycle limit, so every saw cost ~recoveryPct + fees.
import { afterEach, beforeEach, describe, expect, it, setSystemTime } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { KaiBotDatabase } from '../storage/database.js'
import { PaperExchangeAdapter } from './exchanges/adapters/paper.js'
import { orderLockIdle } from './order-lock.js'
import { createSyntheticUsdService, type SyntheticUsdService } from './synthetic-usd.js'
import { createSyntheticGuardService, hourCloseDue, type SyntheticGuardService } from './synthetic-guard.js'

const INV = 'BTC-PERPETUAL'
const at = (iso: string) => setSystemTime(new Date(iso))

describe('hourCloseDue', () => {
  it('is the first tick at/after hh:00 UTC since the previous tick', () => {
    const t = (iso: string) => Date.parse(iso)
    expect(hourCloseDue(t('2026-10-11T15:59:59Z'), t('2026-10-11T16:00:00Z'))).toBe(true)
    expect(hourCloseDue(t('2026-10-11T16:00:00Z'), t('2026-10-11T16:00:30Z'))).toBe(false)
    expect(hourCloseDue(t('2026-10-11T15:20:00Z'), t('2026-10-11T15:59:59Z'))).toBe(false)
    expect(hourCloseDue(t('2026-10-11T13:10:00Z'), t('2026-10-11T16:20:00Z'))).toBe(true)
    expect(hourCloseDue(null, t('2026-10-11T16:00:00Z'))).toBe(false)
  })
})

describe('synthetic-guard whipsaw', () => {
  let dir: string
  let db: KaiBotDatabase
  let adapter: PaperExchangeAdapter
  let service: SyntheticUsdService
  let guard: SyntheticGuardService
  let events: any[]

  beforeEach(() => {
    at('2026-10-11T15:20:00Z')
    dir = mkdtempSync(join(tmpdir(), 'kaibot-synth-whipsaw-'))
    db = new KaiBotDatabase(join(dir, 'test.db'))
    adapter = new PaperExchangeAdapter('deribit', { [INV]: 100_000 })
    const manager = { getSession: async () => ({ status: 'connected', adapter }) } as any
    service = createSyntheticUsdService(db, manager)
    events = []
    guard = createSyntheticGuardService(db, manager, service, { publish: (e: any) => events.push(e) } as any)
    db.setHoldingsBasis('manual:cold', 200_000, true)
  })

  afterEach(async () => {
    await orderLockIdle()
    setSystemTime()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  async function tick() {
    await guard.tickExchange('deribit', adapter, await adapter.getPositions())
    await orderLockIdle()
  }
  async function markAt(iso: string, mark: number) {
    at(iso)
    adapter.setMarkPrice(INV, mark)
    await tick()
  }
  const market = { exchange: 'deribit', accountId: 'btc', symbol: INV }
  const row = (id: string) => db.getSyntheticUsdPosition(id)!
  const buys = () => adapter.getOrders().filter((o) => o.order.side === 'buy')
  const held = () => events.filter((e) => e.title === 'Synthetic USD held')

  it('defaults: hour-close confirmation, 2 recoveries, nothing held', async () => {
    const r = await guard.arm({ ...market, triggerPrice: 90_000, holdingsCoin: 2, recoveryPct: 2 })
    expect(r.arm_recovery_confirm).toBe('hour-close')
    expect(r.arm_max_recoveries).toBe(2)
    expect(r.arm_recoveries_at_level).toBe(0)
    const v = guard.view(r)
    expect(v).toMatchObject({ recoveryConfirm: 'hour-close', maxRecoveries: 2, recoveriesAtLevel: 0, held: false })
  })

  it('validates recoveryConfirm and maxRecoveries on arm and arm-update', async () => {
    const base = { ...market, triggerPrice: 90_000, holdingsCoin: 2 }
    await expect(guard.arm({ ...base, recoveryConfirm: 'close' as any })).rejects.toThrow(/recoveryConfirm/)
    await expect(guard.arm({ ...base, maxRecoveries: -1 })).rejects.toThrow(/maxRecoveries/)
    await expect(guard.arm({ ...base, maxRecoveries: 1.5 })).rejects.toThrow(/maxRecoveries/)
    const r = await guard.arm({ ...base, maxRecoveries: 0, recoveryConfirm: 'immediate' })
    expect(r.arm_max_recoveries).toBe(0)
    expect(() => guard.updateArm(r.id, { maxRecoveries: -2 })).toThrow(/maxRecoveries/)
    const u = guard.updateArm(r.id, { recoveryConfirm: 'hour-close', maxRecoveries: 4 })
    expect(u.arm_recovery_confirm).toBe('hour-close')
    expect(u.arm_max_recoveries).toBe(4)
  })

  // (a) The saw: past the recovery level intrabar, back under it before the hour.
  it('hour-close: an intrabar recovery that falls back before the hour does not cover', async () => {
    const r = await guard.arm({ ...market, triggerPrice: 90_000, holdingsCoin: 2, recoveryPct: 2 })
    await markAt('2026-10-11T15:20:00Z', 89_000)
    expect(row(r.id).status).toBe('open')

    await markAt('2026-10-11T15:40:00Z', 92_000) // past 91.800 intrabar
    expect(row(r.id).status).toBe('open')
    await markAt('2026-10-11T15:55:00Z', 90_500)
    await markAt('2026-10-11T16:00:10Z', 90_500) // hour close below the level
    expect(row(r.id).status).toBe('open')
    // Only the first tick of the hour counts.
    await markAt('2026-10-11T16:20:00Z', 92_500)
    expect(row(r.id).status).toBe('open')
    expect(buys()).toHaveLength(0)

    await markAt('2026-10-11T17:00:05Z', 92_000)
    const done = row(r.id)
    expect(done.status).toBe('armed')
    expect(done.arm_recoveries_at_level).toBe(1)
    expect(buys()).toHaveLength(1)
  })

  it('hour-close: a failed unwind on the due tick leaves the next tick due', async () => {
    const r = await guard.arm({ ...market, triggerPrice: 90_000, holdingsCoin: 2, recoveryPct: 2 })
    await markAt('2026-10-11T15:20:00Z', 89_000)
    await markAt('2026-10-11T15:50:00Z', 89_500)
    const place = adapter.placeOrder.bind(adapter)
    adapter.placeOrder = async () => { throw new Error('venue down') }
    await markAt('2026-10-11T16:00:05Z', 92_000)
    expect(row(r.id).status).toBe('open')
    expect(row(r.id).arm_last_mark_at).toBe(Date.parse('2026-10-11T15:50:00Z'))

    adapter.placeOrder = place
    await markAt('2026-10-11T16:00:40Z', 92_000)
    expect(row(r.id).status).toBe('armed')
    expect(buys()).toHaveLength(1)
  })

  it('immediate: the same intrabar recovery covers right away (pre-051 behaviour)', async () => {
    const r = await guard.arm({ ...market, triggerPrice: 90_000, holdingsCoin: 2, recoveryPct: 2, recoveryConfirm: 'immediate' })
    await markAt('2026-10-11T15:20:00Z', 89_000)
    expect(row(r.id).status).toBe('open')
    await markAt('2026-10-11T15:40:00Z', 92_000)
    expect(row(r.id).status).toBe('armed')
    expect(buys()).toHaveLength(1)
    expect(row(r.id).arm_trigger_price).toBe(90_000)
  })

  // (b) Third trigger at the same level with the default 2: held.
  it('holds the third mint at one level: no recovery, one alert', async () => {
    const r = await guard.arm({ ...market, triggerPrice: 90_000, holdingsCoin: 2, recoveryPct: 2, recoveryConfirm: 'immediate' })
    for (let i = 0; i < 2; i++) {
      await markAt(`2026-10-11T15:2${i}:00Z`, 89_000)
      expect(row(r.id).status).toBe('open')
      await markAt(`2026-10-11T15:2${i}:30Z`, 92_000)
      expect(row(r.id).status).toBe('armed')
    }
    expect(row(r.id).arm_recoveries_at_level).toBe(2)
    expect(held()).toHaveLength(0)

    await markAt('2026-10-11T15:30:00Z', 89_000)
    let v = guard.view(row(r.id))
    expect(row(r.id).status).toBe('open')
    expect(v.held).toBe(true)
    expect(v.recoveriesAtLevel).toBe(2)
    expect(held()).toHaveLength(1)
    expect(held()[0].body).toBe(`Synthetic USD ${INV}: third trigger at 90.000, short held, recovery off`)

    await markAt('2026-10-11T15:31:00Z', 95_000)
    await markAt('2026-10-11T16:00:05Z', 96_000)
    expect(row(r.id).status).toBe('open')
    expect(buys()).toHaveLength(2)
    expect(held()).toHaveLength(1)
    expect((await guard.preflight(r.id)).reason).toMatch(/^held; recovery off after 3 triggers/)

    // The operator closes it: the short goes.
    const closed = await service.close(r.id)
    expect(closed.status).toBe('closed')
    expect(buys()).toHaveLength(3)
  })

  it('maxRecoveries 0 holds on the first mint', async () => {
    const r = await guard.arm({ ...market, triggerPrice: 90_000, holdingsCoin: 2, recoveryPct: 2, recoveryConfirm: 'immediate', maxRecoveries: 0 })
    await markAt('2026-10-11T15:20:00Z', 89_000)
    expect(guard.view(row(r.id)).held).toBe(true)
    expect(held()[0].body).toMatch(/first trigger at 90\.000/)
    await markAt('2026-10-11T15:21:00Z', 99_000)
    expect(row(r.id).status).toBe('open')
  })

  it('lowering maxRecoveries on an open row holds it and alerts once', async () => {
    const r = await guard.arm({ ...market, triggerPrice: 90_000, holdingsCoin: 2, recoveryPct: 2, recoveryConfirm: 'immediate' })
    await markAt('2026-10-11T15:20:00Z', 89_000)
    await markAt('2026-10-11T15:21:00Z', 92_000)
    await markAt('2026-10-11T15:22:00Z', 89_000)
    expect(guard.view(row(r.id))).toMatchObject({ held: false, recoveriesAtLevel: 1, triggersAtLevel: 2 })
    expect(held()).toHaveLength(0)

    guard.updateArm(r.id, { maxRecoveries: 1 })
    expect(guard.view(row(r.id)).held).toBe(true)
    expect(held()).toHaveLength(1)
    expect(held()[0].body).toBe(`Synthetic USD ${INV}: second trigger at 90.000, short held, recovery off`)
    expect((await guard.preflight(r.id)).reason).toMatch(/^held; recovery off after 2 triggers/)
    guard.updateArm(r.id, { maxRecoveries: 0 })
    expect(held()).toHaveLength(1)
    await markAt('2026-10-11T15:23:00Z', 95_000)
    expect(row(r.id).status).toBe('open')
  })

  it('preflight says "1 trigger" for a hold on the first mint', async () => {
    const r = await guard.arm({ ...market, triggerPrice: 90_000, holdingsCoin: 2, maxRecoveries: 0 })
    await markAt('2026-10-11T15:20:00Z', 89_000)
    expect((await guard.preflight(r.id)).reason).toBe('held; recovery off after 1 trigger at this level')
  })

  it('raising maxRecoveries via arm-update releases a held short', async () => {
    const r = await guard.arm({ ...market, triggerPrice: 90_000, holdingsCoin: 2, recoveryPct: 2, recoveryConfirm: 'immediate', maxRecoveries: 0 })
    await markAt('2026-10-11T15:20:00Z', 89_000)
    expect(guard.view(row(r.id)).held).toBe(true)
    guard.updateArm(r.id, { maxRecoveries: 1 })
    expect(guard.view(row(r.id)).held).toBe(false)
    await markAt('2026-10-11T15:21:00Z', 92_000)
    expect(row(r.id).status).toBe('armed')
  })

  // (c) The ratchet moves the level up: a fresh count.
  it('a ratchet move resets the recovery count', async () => {
    const r = await guard.arm({
      ...market, triggerPrice: 90_000, holdingsCoin: 2, recoveryPct: 2, trailPct: 10, recoveryConfirm: 'immediate',
    })
    await markAt('2026-10-11T15:20:00Z', 89_000)
    await markAt('2026-10-11T15:21:00Z', 92_000)
    expect(row(r.id).arm_recoveries_at_level).toBe(1)
    await markAt('2026-10-11T15:22:00Z', 99_000) // 10 % below → 89.100, stays at 90.000
    expect(row(r.id).arm_recoveries_at_level).toBe(1)
    await markAt('2026-10-11T15:23:00Z', 120_000)
    expect(row(r.id).arm_trigger_price).toBe(108_000)
    expect(row(r.id).arm_recoveries_at_level).toBe(0)
  })

  // (d) The operator moves the trigger: a fresh count.
  it('arm-update with a new trigger resets the recovery count; other knobs keep it', async () => {
    const r = await guard.arm({ ...market, triggerPrice: 90_000, holdingsCoin: 2, recoveryPct: 2, recoveryConfirm: 'immediate' })
    await markAt('2026-10-11T15:20:00Z', 89_000)
    await markAt('2026-10-11T15:21:00Z', 92_000)
    expect(row(r.id).arm_recoveries_at_level).toBe(1)
    expect(guard.updateArm(r.id, { tolerancePct: 0.2 }).arm_recoveries_at_level).toBe(1)
    expect(guard.updateArm(r.id, { triggerPrice: 90_000 }).arm_recoveries_at_level).toBe(1)
    expect(guard.updateArm(r.id, { triggerPrice: 88_000 }).arm_recoveries_at_level).toBe(0)
  })
})

import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { KaiBotDatabase } from './database.js'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Exercises the migration-015 margin_guards helpers against a real on-disk DB.

let dir: string
let db: KaiBotDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-margin-test-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('margin_guards', () => {
  it('returns null when no row is configured', () => {
    expect(db.getMarginGuard('bybit', 'default')).toBeNull()
  })

  it('upserts and reads back a config (enabled stored as 0/1)', () => {
    db.setMarginGuard('bybit', 'default', { enabled: true, bufferMult: 1.5, floorMode: 'maintenance', equityPct: 0.2 })
    const row = db.getMarginGuard('bybit', 'default')!
    expect(row.enabled).toBe(1)
    expect(row.buffer_mult).toBe(1.5)
    expect(row.floor_mode).toBe('maintenance')
    expect(row.equity_pct).toBe(0.2)

    // updating overwrites in place (PK is exchange+account)
    db.setMarginGuard('bybit', 'default', { enabled: false, bufferMult: 2, floorMode: 'initial', equityPct: 0.3 })
    const row2 = db.getMarginGuard('bybit', 'default')!
    expect(row2.enabled).toBe(0)
    expect(row2.buffer_mult).toBe(2)
    expect(row2.floor_mode).toBe('initial')
    expect(db.listMarginGuards()).toHaveLength(1)
  })

  it('keeps the global default row separate from per-account rows', () => {
    db.setMarginGuard('*', '*', { enabled: true, bufferMult: 1, floorMode: 'maintenance', equityPct: 0.2 })
    db.setMarginGuard('deribit', 'btc', { enabled: true, bufferMult: 3, floorMode: 'equityPct', equityPct: 0.4 })
    expect(db.getMarginGuard('*', '*')!.buffer_mult).toBe(1)
    expect(db.getMarginGuard('deribit', 'btc')!.buffer_mult).toBe(3)
    expect(db.listMarginGuards()).toHaveLength(2)
  })
})

describe('guardrails (migration 016 columns)', () => {
  it('defaults all rails to 0 on a margin-guard-only row', () => {
    db.setMarginGuard('bybit', 'default', { enabled: true, bufferMult: 1, floorMode: 'maintenance', equityPct: 0.2 })
    const row = db.getMarginGuard('bybit', 'default')!
    expect(row.max_daily_loss).toBe(0)
    expect(row.max_concurrent_positions).toBe(0)
    expect(row.max_total_notional).toBe(0)
  })

  it('upserts guardrails without clobbering an existing margin-guard config', () => {
    db.setMarginGuard('bybit', 'default', { enabled: true, bufferMult: 1.5, floorMode: 'initial', equityPct: 0.3 })
    db.setGuardrails('bybit', 'default', { maxDailyLoss: 500, maxConcurrentPositions: 3, maxTotalNotional: 20_000 })
    const row = db.getMarginGuard('bybit', 'default')!
    // guardrails set
    expect(row.max_daily_loss).toBe(500)
    expect(row.max_concurrent_positions).toBe(3)
    expect(row.max_total_notional).toBe(20_000)
    // margin guard untouched
    expect(row.enabled).toBe(1)
    expect(row.buffer_mult).toBe(1.5)
    expect(row.floor_mode).toBe('initial')
  })

  it('setGuardrails on a fresh account creates a row with the margin guard off', () => {
    db.setGuardrails('deribit', 'btc', { maxDailyLoss: 100, maxConcurrentPositions: 0, maxTotalNotional: 0 })
    const row = db.getMarginGuard('deribit', 'btc')!
    expect(row.enabled).toBe(0) // breathing-room guard default-off
    expect(row.max_daily_loss).toBe(100)
  })
})

describe('executor_halt flag (migration 016)', () => {
  it('starts un-halted', () => {
    const s = db.getHaltState()
    expect(s.halted).toBe(false)
    expect(s.reason).toBeNull()
    expect(s.tripped_at).toBeNull()
  })

  it('sets and clears the halt flag with a reason + timestamp', () => {
    db.setHaltState(true, 'panic')
    const on = db.getHaltState()
    expect(on.halted).toBe(true)
    expect(on.reason).toBe('panic')
    expect(typeof on.tripped_at).toBe('number')

    db.setHaltState(false)
    const off = db.getHaltState()
    expect(off.halted).toBe(false)
    expect(off.reason).toBeNull()
    expect(off.tripped_at).toBeNull()
  })
})

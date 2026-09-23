import { test, expect } from 'bun:test'
import {
  computeBreathingRoom,
  effectiveMarginGuard,
  effectiveGuardrails,
  isInverseVenue,
  DEFAULT_MARGIN_GUARD,
  DEFAULT_LEVERAGE,
  FUTURES_DEFAULT_LEVERAGE,
  defaultLeverageFor,
  type MarginGuardConfig,
} from './margin-guard.js'
import { DEFAULT_GUARDRAILS } from './guardrails.js'

const cfg = (over: Partial<MarginGuardConfig> = {}): MarginGuardConfig => ({
  enabled: true,
  bufferMult: 1.5,
  floorMode: 'maintenance',
  equityPct: 0.2,
  ...over,
})

test('maintenance floor: plenty of free margin → allowed', () => {
  const r = computeBreathingRoom(cfg(), {
    equity: 10_000,
    initialMargin: 1_000,
    maintenanceMargin: 500,
    orderNotional: 2_000,
    leverage: 10,
  })
  expect(r.available).toBe(9_000) // equity − initialMargin
  expect(r.orderMargin).toBe(200) // 2000 / 10
  expect(r.floorBasis).toBe(500) // maintenance margin
  expect(r.required).toBe(750) // 1.5 × 500
  expect(r.after).toBe(8_800)
  expect(r.ok).toBe(true)
})

test('maintenance floor: heavy existing maintenance, little free margin → blocked', () => {
  const r = computeBreathingRoom(cfg(), {
    equity: 5_000,
    initialMargin: 4_500,
    maintenanceMargin: 2_000,
    orderNotional: 1_000,
    leverage: 10,
  })
  expect(r.available).toBe(500)
  expect(r.orderMargin).toBe(100)
  expect(r.required).toBe(3_000) // 1.5 × 2000
  expect(r.after).toBe(400)
  expect(r.ok).toBe(false)
})

test('order too large for free margin → blocked even with no existing positions', () => {
  const r = computeBreathingRoom(cfg(), {
    equity: 1_000,
    initialMargin: 0,
    maintenanceMargin: 0, // required = 0
    orderNotional: 2_000,
    leverage: 1, // full notional as margin
  })
  expect(r.required).toBe(0)
  expect(r.orderMargin).toBe(2_000)
  expect(r.after).toBe(-1_000)
  expect(r.ok).toBe(false)
})

test('empty account, order fits free margin → allowed (required 0)', () => {
  const r = computeBreathingRoom(cfg(), {
    equity: 5_000,
    initialMargin: 0,
    maintenanceMargin: 0,
    orderNotional: 1_000,
    leverage: 5,
  })
  expect(r.required).toBe(0)
  expect(r.orderMargin).toBe(200)
  expect(r.ok).toBe(true)
})

test("floorMode 'initial' builds the floor on account initial margin", () => {
  const r = computeBreathingRoom(cfg({ floorMode: 'initial', bufferMult: 1 }), {
    equity: 10_000,
    initialMargin: 4_000,
    maintenanceMargin: 1_000,
    orderNotional: 1_000,
    leverage: 10,
  })
  expect(r.floorBasis).toBe(4_000) // initial, not maintenance
  expect(r.required).toBe(4_000)
  expect(r.after).toBe(5_900) // 6000 − 100
  expect(r.ok).toBe(true)
})

test("floorMode 'equityPct' builds the floor on a fraction of equity", () => {
  const r = computeBreathingRoom(cfg({ floorMode: 'equityPct', equityPct: 0.5, bufferMult: 1 }), {
    equity: 10_000,
    initialMargin: 2_000,
    maintenanceMargin: 1_000,
    orderNotional: 1_000,
    leverage: 10,
  })
  expect(r.floorBasis).toBe(5_000) // 0.5 × 10000
  expect(r.required).toBe(5_000)
  expect(r.after).toBe(7_900) // 8000 − 100
  expect(r.ok).toBe(true)
})

test('leverage 0 is treated as full-notional margin (no divide-by-zero)', () => {
  const r = computeBreathingRoom(cfg(), {
    equity: 10_000,
    initialMargin: 0,
    maintenanceMargin: 0,
    orderNotional: 3_000,
    leverage: 0,
  })
  expect(r.orderMargin).toBe(3_000)
})

// ─── offset credit: an open opposing an existing same-root position (383e5bc) ───

test('pure offset frees margin → allowed even when the floor would otherwise block', () => {
  // Signal-2364 regression: broker short, an opposing long fully offsets it. Free
  // margin (2082) is well under the 4107 floor, but the open nets the broker down
  // and consumes no new margin, so it must pass.
  const r = computeBreathingRoom(cfg({ bufferMult: 1 }), {
    equity: 6_189,
    initialMargin: 4_107,
    maintenanceMargin: 4_107,
    orderNotional: 4_107,
    offsetNotional: 4_107,
    leverage: 1,
  })
  expect(r.orderMargin).toBe(0)
  expect(r.after).toBe(2_082) // available unchanged — nothing consumed
  expect(r.ok).toBe(true)
})

test('partial flip past flat: only the excess beyond the offset needs margin', () => {
  // Short 1, open long 3 → 1 offsets, 2 are genuinely new.
  const r = computeBreathingRoom(cfg({ bufferMult: 1 }), {
    equity: 50_000,
    initialMargin: 4_000,
    maintenanceMargin: 4_000,
    orderNotional: 12_000, // 3 contracts
    offsetNotional: 4_000, // 1 contract offsets
    leverage: 1,
  })
  expect(r.orderMargin).toBe(8_000) // only the 2 net-new contracts
  expect(r.ok).toBe(true)
})

test('offset larger than the order is capped → still a pure offset', () => {
  const r = computeBreathingRoom(cfg({ bufferMult: 1 }), {
    equity: 3_000,
    initialMargin: 2_500,
    maintenanceMargin: 2_500,
    orderNotional: 4_000,
    offsetNotional: 9_000, // capped at orderNotional
    leverage: 1,
  })
  expect(r.orderMargin).toBe(0)
  expect(r.ok).toBe(true)
})

test('no offset (0) leaves the guard exactly as before → still blocks', () => {
  // Same blocking scenario as the maintenance-floor test, with an explicit 0
  // offset: nothing to offset must not accidentally grant a pass.
  const r = computeBreathingRoom(cfg(), {
    equity: 5_000,
    initialMargin: 4_500,
    maintenanceMargin: 2_000,
    orderNotional: 1_000,
    offsetNotional: 0,
    leverage: 10,
  })
  expect(r.orderMargin).toBe(100)
  expect(r.ok).toBe(false)
})

// ─── effectiveMarginGuard resolution ───

type Row = {
  exchange: string
  account: string
  enabled: number
  buffer_mult: number
  floor_mode: string
  equity_pct: number
  max_daily_loss?: number
  max_concurrent_positions?: number
  max_total_notional?: number
}
const fakeDb = (rows: Row[]) =>
  ({
    getMarginGuard: (exchange: string, account: string) =>
      rows.find((r) => r.exchange === exchange && r.account === account) ?? null,
  }) as any

test('effectiveMarginGuard: no rows → built-in defaults', () => {
  expect(effectiveMarginGuard(fakeDb([]), 'bybit', 'default')).toEqual(DEFAULT_MARGIN_GUARD)
})

test('effectiveMarginGuard: per-account row wins over global', () => {
  const db = fakeDb([
    { exchange: '*', account: '*', enabled: 1, buffer_mult: 1, floor_mode: 'maintenance', equity_pct: 0.2 },
    { exchange: 'bybit', account: 'default', enabled: 1, buffer_mult: 2.5, floor_mode: 'initial', equity_pct: 0.3 },
  ])
  expect(effectiveMarginGuard(db, 'bybit', 'default')).toEqual({
    enabled: true,
    bufferMult: 2.5,
    floorMode: 'initial',
    equityPct: 0.3,
  })
})

test('effectiveMarginGuard: falls back to the global default row', () => {
  const db = fakeDb([
    { exchange: '*', account: '*', enabled: 1, buffer_mult: 1.2, floor_mode: 'equityPct', equity_pct: 0.25 },
  ])
  expect(effectiveMarginGuard(db, 'deribit', 'btc')).toEqual({
    enabled: true,
    bufferMult: 1.2,
    floorMode: 'equityPct',
    equityPct: 0.25,
  })
})

test('effectiveMarginGuard: unknown floor_mode in a row falls back to the default mode', () => {
  const db = fakeDb([
    { exchange: 'bybit', account: 'default', enabled: 1, buffer_mult: 1, floor_mode: 'bogus', equity_pct: 0.2 },
  ])
  expect(effectiveMarginGuard(db, 'bybit', 'default').floorMode).toBe(DEFAULT_MARGIN_GUARD.floorMode)
})

// ─── effectiveGuardrails resolution ───

test('effectiveGuardrails: no rows → all rails off (defaults)', () => {
  expect(effectiveGuardrails(fakeDb([]), 'bybit', 'default')).toEqual(DEFAULT_GUARDRAILS)
})

test('effectiveGuardrails: row with no guardrail columns → all off', () => {
  const db = fakeDb([
    { exchange: 'bybit', account: 'default', enabled: 1, buffer_mult: 1, floor_mode: 'maintenance', equity_pct: 0.2 },
  ])
  expect(effectiveGuardrails(db, 'bybit', 'default')).toEqual(DEFAULT_GUARDRAILS)
})

test('effectiveGuardrails: per-account row wins over global', () => {
  const db = fakeDb([
    {
      exchange: '*',
      account: '*',
      enabled: 0,
      buffer_mult: 1,
      floor_mode: 'maintenance',
      equity_pct: 0.2,
      max_daily_loss: 100,
      max_concurrent_positions: 1,
      max_total_notional: 1_000,
    },
    {
      exchange: 'bybit',
      account: 'default',
      enabled: 0,
      buffer_mult: 1,
      floor_mode: 'maintenance',
      equity_pct: 0.2,
      max_daily_loss: 500,
      max_concurrent_positions: 4,
      max_total_notional: 25_000,
    },
  ])
  expect(effectiveGuardrails(db, 'bybit', 'default')).toEqual({
    maxDailyLoss: 500,
    maxConcurrentPositions: 4,
    maxTotalNotional: 25_000,
  })
})

test('effectiveGuardrails: falls back to the global default row', () => {
  const db = fakeDb([
    {
      exchange: '*',
      account: '*',
      enabled: 0,
      buffer_mult: 1,
      floor_mode: 'maintenance',
      equity_pct: 0.2,
      max_daily_loss: 250,
      max_concurrent_positions: 0,
      max_total_notional: 0,
    },
  ])
  expect(effectiveGuardrails(db, 'deribit', 'btc')).toEqual({
    maxDailyLoss: 250,
    maxConcurrentPositions: 0,
    maxTotalNotional: 0,
  })
})

test('effectiveGuardrails: negative / non-finite column coerces to 0 (off)', () => {
  const db = fakeDb([
    {
      exchange: 'bybit',
      account: 'default',
      enabled: 0,
      buffer_mult: 1,
      floor_mode: 'maintenance',
      equity_pct: 0.2,
      max_daily_loss: -5,
      max_concurrent_positions: 3,
      max_total_notional: Number.NaN,
    },
  ])
  expect(effectiveGuardrails(db, 'bybit', 'default')).toEqual({
    maxDailyLoss: 0,
    maxConcurrentPositions: 3,
    maxTotalNotional: 0,
  })
})

test('isInverseVenue: deribit coin perps are inverse, USDC perps are linear', () => {
  expect(isInverseVenue('deribit', 'BTC-PERPETUAL')).toBe(true)
  expect(isInverseVenue('deribit', 'ETH-PERPETUAL')).toBe(true)
  expect(isInverseVenue('deribit', 'SOL_USDC-PERPETUAL')).toBe(false)
  expect(isInverseVenue('deribit', 'BTC_USDC-PERPETUAL')).toBe(false)
  expect(isInverseVenue('bybit', 'BTCUSDT')).toBe(false)
  expect(isInverseVenue('bybit', 'BTCPERP')).toBe(false)
})

// Regression (E2E 2026-08-24): a flat futures account resolved leverage to the
// spot default 1 → orderMargin = full notional → EVERY first entry rejected
// (1 MNQ, $58.9k notional, refused on a $12k account). Futures venues fall
// back to the 10x initial-margin assumption instead.
test('defaultLeverageFor: futures venues get the futures fallback, others the spot default', () => {
  expect(defaultLeverageFor('tradestation')).toBe(FUTURES_DEFAULT_LEVERAGE)
  expect(defaultLeverageFor('TradeStation')).toBe(FUTURES_DEFAULT_LEVERAGE)
  expect(defaultLeverageFor('interactivebrokers')).toBe(FUTURES_DEFAULT_LEVERAGE)
  expect(defaultLeverageFor('deribit')).toBe(DEFAULT_LEVERAGE)
  expect(defaultLeverageFor('bybit')).toBe(DEFAULT_LEVERAGE)
})

test('breathing room passes a 1-micro MNQ open on a $12k flat futures account at 10x', () => {
  const room = computeBreathingRoom(DEFAULT_MARGIN_GUARD, {
    equity: 11958,
    initialMargin: 0,
    maintenanceMargin: 0,
    orderNotional: 58893,
    leverage: FUTURES_DEFAULT_LEVERAGE,
  })
  expect(room.orderMargin).toBeCloseTo(5889.3, 1)
  expect(room.ok).toBe(true)
})

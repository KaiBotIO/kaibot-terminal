import { test, expect } from 'bun:test'
import {
  checkConcurrency,
  checkNotional,
  checkDailyLoss,
  guardrailsActive,
  DEFAULT_GUARDRAILS,
  type GuardrailsConfig,
} from './guardrails.js'

const cfg = (over: Partial<GuardrailsConfig> = {}): GuardrailsConfig => ({
  ...DEFAULT_GUARDRAILS,
  ...over,
})

// ─── concurrency ───

test('concurrency disabled (limit 0) always passes', () => {
  const r = checkConcurrency(cfg(), ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'], 'XRPUSDT')
  expect(r.enabled).toBe(false)
  expect(r.ok).toBe(true)
})

test('concurrency: new symbol blocked at the cap', () => {
  const r = checkConcurrency(cfg({ maxConcurrentPositions: 2 }), ['BTCUSDT', 'ETHUSDT'], 'SOLUSDT')
  expect(r.enabled).toBe(true)
  expect(r.openCount).toBe(2)
  expect(r.addsToExisting).toBe(false)
  expect(r.ok).toBe(false)
})

test('concurrency: new symbol allowed under the cap', () => {
  const r = checkConcurrency(cfg({ maxConcurrentPositions: 3 }), ['BTCUSDT', 'ETHUSDT'], 'SOLUSDT')
  expect(r.ok).toBe(true)
})

test('concurrency: adding to an existing symbol passes even at the cap', () => {
  const r = checkConcurrency(cfg({ maxConcurrentPositions: 2 }), ['BTCUSDT', 'ETHUSDT'], 'btcusdt')
  expect(r.addsToExisting).toBe(true)
  expect(r.ok).toBe(true)
})

test('concurrency: duplicate open symbols count once', () => {
  const r = checkConcurrency(cfg({ maxConcurrentPositions: 2 }), ['BTCUSDT', 'BTCUSDT'], 'ETHUSDT')
  expect(r.openCount).toBe(1)
  expect(r.ok).toBe(true)
})

// ─── notional ───

test('notional disabled (limit 0) always passes', () => {
  const r = checkNotional(cfg(), 50_000, 999_999)
  expect(r.enabled).toBe(false)
  expect(r.ok).toBe(true)
})

test('notional: open that stays within the cap passes', () => {
  const r = checkNotional(cfg({ maxTotalNotional: 10_000 }), 6_000, 3_000)
  expect(r.afterNotional).toBe(9_000)
  expect(r.ok).toBe(true)
})

test('notional: open that exceeds the cap is blocked', () => {
  const r = checkNotional(cfg({ maxTotalNotional: 10_000 }), 8_000, 3_000)
  expect(r.afterNotional).toBe(11_000)
  expect(r.ok).toBe(false)
})

test('notional: exactly at the cap passes (<=)', () => {
  const r = checkNotional(cfg({ maxTotalNotional: 10_000 }), 7_000, 3_000)
  expect(r.afterNotional).toBe(10_000)
  expect(r.ok).toBe(true)
})

// ─── daily loss ───

test('daily loss disabled (limit 0) never trips', () => {
  const r = checkDailyLoss(cfg(), -99_999)
  expect(r.enabled).toBe(false)
  expect(r.breached).toBe(false)
  expect(r.ok).toBe(true)
})

test('daily loss: a loss under the limit does not trip', () => {
  const r = checkDailyLoss(cfg({ maxDailyLoss: 500 }), -300)
  expect(r.breached).toBe(false)
  expect(r.ok).toBe(true)
})

test('daily loss: a loss exactly at the limit trips (<=)', () => {
  const r = checkDailyLoss(cfg({ maxDailyLoss: 500 }), -500)
  expect(r.breached).toBe(true)
  expect(r.ok).toBe(false)
})

test('daily loss: a loss beyond the limit trips', () => {
  const r = checkDailyLoss(cfg({ maxDailyLoss: 500 }), -800)
  expect(r.breached).toBe(true)
  expect(r.ok).toBe(false)
})

test('daily loss: a profitable day never trips', () => {
  const r = checkDailyLoss(cfg({ maxDailyLoss: 500 }), 1_200)
  expect(r.breached).toBe(false)
  expect(r.ok).toBe(true)
})

// ─── active flag ───

test('guardrailsActive: all-zero is inactive', () => {
  expect(guardrailsActive(cfg())).toBe(false)
})

test('guardrailsActive: any rail on is active', () => {
  expect(guardrailsActive(cfg({ maxConcurrentPositions: 3 }))).toBe(true)
  expect(guardrailsActive(cfg({ maxDailyLoss: 100 }))).toBe(true)
  expect(guardrailsActive(cfg({ maxTotalNotional: 100 }))).toBe(true)
})

import { describe, expect, it } from 'bun:test'
import {
  DEFAULT_DEFER_MAX_WAIT_MS,
  isWeekendGap,
  matchesDeferredLineage,
  nextWeekendOpenMs,
  planDeferral,
  resolveDeferConfig,
} from './deferred-entries.js'
import type { DeferredEntryRow } from '../storage/database.js'

// 2026-09-17 is a Thursday; 2026-09-18 Friday; 2026-09-20 Sunday.
const THU_2103 = Date.UTC(2026, 8, 17, 21, 3)
const FRI_2030 = Date.UTC(2026, 8, 18, 20, 30)
const FRI_2105 = Date.UTC(2026, 8, 18, 21, 5)
const SAT_NOON = Date.UTC(2026, 8, 19, 12, 0)
const SUN_2130 = Date.UTC(2026, 8, 20, 21, 30)
const SUN_2200 = Date.UTC(2026, 8, 20, 22, 0)
const SUN_2230 = Date.UTC(2026, 8, 20, 22, 30)

describe('isWeekendGap', () => {
  it('covers Friday 21:00 UTC through Sunday 22:00 UTC', () => {
    expect(isWeekendGap(THU_2103)).toBe(false)
    expect(isWeekendGap(FRI_2030)).toBe(false)
    expect(isWeekendGap(FRI_2105)).toBe(true)
    expect(isWeekendGap(SAT_NOON)).toBe(true)
    expect(isWeekendGap(SUN_2130)).toBe(true)
    expect(isWeekendGap(SUN_2200)).toBe(false)
    expect(isWeekendGap(SUN_2230)).toBe(false)
  })
})

describe('nextWeekendOpenMs', () => {
  it('lands on the coming Sunday 22:00 UTC', () => {
    expect(nextWeekendOpenMs(SAT_NOON)).toBe(SUN_2200)
    expect(nextWeekendOpenMs(FRI_2105)).toBe(SUN_2200)
    expect(nextWeekendOpenMs(SUN_2130)).toBe(SUN_2200)
  })
  it('rolls a week forward once Sunday 22:00 has passed', () => {
    expect(nextWeekendOpenMs(SUN_2230)).toBe(SUN_2200 + 7 * 24 * 3_600_000)
  })
})

describe('planDeferral', () => {
  it('parks a weekday entry until now + max wait', () => {
    const plan = planDeferral({ nowMs: THU_2103, maxWaitMs: 3 * 3_600_000, deferOverWeekend: false })
    expect(plan.kind).toBe('defer')
    if (plan.kind === 'defer') {
      expect(plan.deadlineMs).toBe(THU_2103 + 3 * 3_600_000)
      expect(plan.reason).toContain('market closed')
    }
  })
  it('drops an entry inside the weekend gap by default, with the opt-in named', () => {
    const plan = planDeferral({ nowMs: SAT_NOON, maxWaitMs: 3 * 3_600_000, deferOverWeekend: false })
    expect(plan.kind).toBe('drop')
    expect(plan.reason).toContain('weekend')
    expect(plan.reason).toContain('DEFER_OVER_WEEKEND=1')
  })
  it('holds over the weekend when opted in, deadline = Sunday open + max wait', () => {
    const plan = planDeferral({ nowMs: SAT_NOON, maxWaitMs: 3 * 3_600_000, deferOverWeekend: true })
    expect(plan.kind).toBe('defer')
    if (plan.kind === 'defer') expect(plan.deadlineMs).toBe(SUN_2200 + 3 * 3_600_000)
  })
})

describe('resolveDeferConfig', () => {
  it('defaults to 3 h / 30 s / no weekend hold', () => {
    const cfg = resolveDeferConfig({})
    expect(cfg.maxWaitMs).toBe(DEFAULT_DEFER_MAX_WAIT_MS)
    expect(cfg.pollMs).toBe(30_000)
    expect(cfg.deferOverWeekend).toBe(false)
  })
  it('reads the env overrides and ignores junk', () => {
    const cfg = resolveDeferConfig({ DEFER_MAX_WAIT_MS: '7200000', DEFER_POLL_MS: 'nope', DEFER_OVER_WEEKEND: '1' })
    expect(cfg.maxWaitMs).toBe(7_200_000)
    expect(cfg.pollMs).toBe(30_000)
    expect(cfg.deferOverWeekend).toBe(true)
  })
})

function row(overrides: Partial<DeferredEntryRow> = {}): DeferredEntryRow {
  return {
    signal_id: 'entry-1',
    signal_json: '{}',
    canonical_symbol: 'MNQ',
    exchange: 'tradestation',
    order_symbol: 'MNQZ26',
    account_id: 'ACC1',
    signal_bot_id: 'bot-1',
    subscription_id: 'sub-1',
    position_id: 'pos-1',
    status: 'waiting',
    reason: null,
    deferred_at: 0,
    deadline_at: 1,
    last_check_at: null,
    resolved_at: null,
    ...overrides,
  }
}

describe('matchesDeferredLineage', () => {
  it('a cancel targets its entry by id only', () => {
    expect(matchesDeferredLineage(row(), { canonicalSymbol: 'MNQ', entrySignalId: 'entry-1' })).toBe(true)
    expect(matchesDeferredLineage(row(), { canonicalSymbol: 'MNQ', entrySignalId: 'entry-2' })).toBe(false)
  })
  it('a close with a positionId matches that position, not a sibling', () => {
    expect(matchesDeferredLineage(row(), { canonicalSymbol: 'MNQ', positionId: 'pos-1' })).toBe(true)
    expect(matchesDeferredLineage(row(), { canonicalSymbol: 'MNQ', positionId: 'pos-9', signalBotId: 'bot-1' })).toBe(false)
  })
  it('a close by bot / subscription matches the same market only', () => {
    expect(matchesDeferredLineage(row({ position_id: null }), { canonicalSymbol: 'MNQ', signalBotId: 'bot-1' })).toBe(true)
    expect(matchesDeferredLineage(row({ position_id: null }), { canonicalSymbol: 'MES', signalBotId: 'bot-1' })).toBe(false)
    expect(matchesDeferredLineage(row({ position_id: null }), { canonicalSymbol: 'MNQ', signalBotId: 'bot-2' })).toBe(false)
    expect(matchesDeferredLineage(row({ position_id: null }), { canonicalSymbol: 'MNQ', subscriptionId: 'sub-1' })).toBe(true)
  })
  it('an identity-less close flattens every waiting entry on the market', () => {
    expect(matchesDeferredLineage(row({ position_id: null }), { canonicalSymbol: 'mnq' })).toBe(true)
  })
})

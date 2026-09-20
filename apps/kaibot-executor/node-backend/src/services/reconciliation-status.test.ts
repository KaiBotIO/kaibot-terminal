import { describe, expect, it } from 'bun:test'
import { findingStatus, isArchivedFinding } from './reconciliation-status.js'

const row = (over: Partial<Parameters<typeof findingStatus>[0]> = {}) => ({
  account_id: '21084933',
  delta: 0,
  action: 'corrected',
  ...over,
})

// Kai, 2026-09-05: the MGCZ26 row from before account scoping has no account,
// so no later pass can ever produce a matching row. It sat in "Open" forever.
describe('findingStatus', () => {
  it('archives a finding written without an account', () => {
    expect(findingStatus(row({ account_id: null, delta: -1, action: 'skipped_large' }))).toBe(
      'archived',
    )
    expect(findingStatus(row({ account_id: '  ', delta: -1, action: 'skipped_large' }))).toBe(
      'archived',
    )
  })

  it('archives regardless of how bad the legacy delta looks', () => {
    expect(findingStatus(row({ account_id: '', delta: -50, action: 'alert_foreign_order' }))).toBe(
      'archived',
    )
  })

  it('settles a zero delta and every resolving action', () => {
    expect(findingStatus(row({ delta: 0, action: 'skipped_working' }))).toBe('settled')
    for (const action of ['corrected', 'adopted_existing', 'adopted_close']) {
      expect(findingStatus(row({ delta: 1, action }))).toBe('settled')
    }
  })

  it('leaves unsettled drift open', () => {
    for (const action of ['skipped_large', 'skipped_working', 'alert_observed_mismatch']) {
      expect(findingStatus(row({ delta: 1, action }))).toBe('open')
    }
  })

  it('isArchivedFinding only looks at the account', () => {
    expect(isArchivedFinding({ account_id: null })).toBe(true)
    expect(isArchivedFinding({ account_id: '21084931' })).toBe(false)
  })
})

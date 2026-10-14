// How one reconciliation finding reads on the Reconciliation page.
//
// Rows are the reconciler's incident log: it only writes when a pass found
// drift, so a row is a finding, never a heartbeat.

export type FindingStatus = 'settled' | 'open' | 'archived'

/** Reconciler outcomes that SETTLED the drift; anything else leaves it out of sync. */
export const SETTLED_RECONCILE_ACTIONS = new Set(['corrected', 'adopted_existing', 'adopted_close'])

export interface FindingRow {
  account_id: string | null
  delta: number
  action: string
}

/**
 * Findings written before the reconciler keyed on the broker account have no
 * account_id. Every pass since keys on (account, symbol), so no later pass can
 * produce a matching row and the finding can never resolve itself. It is
 * history, not an open problem: archived, and out of the open count.
 */
export function isArchivedFinding(r: Pick<FindingRow, 'account_id'>): boolean {
  return (r.account_id ?? '').trim() === ''
}

export function findingStatus(r: FindingRow): FindingStatus {
  if (isArchivedFinding(r)) return 'archived'
  if (r.delta === 0 || SETTLED_RECONCILE_ACTIONS.has(r.action)) return 'settled'
  return 'open'
}

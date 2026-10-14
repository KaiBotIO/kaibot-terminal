// Viewer-side reshaping of rows that mix several accounts in one record.
import { canSeeAccount, type AccountScope } from './account-scope.js'

interface OutcomeLike {
  exchange?: string | null
  accountId?: string | null
}

function parseOutcomes(raw: unknown): OutcomeLike[] | null {
  if (typeof raw !== 'string' || !raw) return null
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * A wire signal row (fan-out) carries one account of its own plus per-account
 * outcomes. A viewer sees it when any of those accounts is granted, with the
 * other accounts' outcomes removed. When its own account is hidden, the row
 * takes the first visible outcome's account and drops its order ids.
 */
export function scopeSignalRow<T extends Record<string, any>>(scope: AccountScope, row: T): T | null {
  if (scope.all) return row
  const own = canSeeAccount(scope, row.exchange, row.account_id)
  const outcomes = parseOutcomes(row.account_outcomes)
  const visible = outcomes?.filter((o) => canSeeAccount(scope, o.exchange ?? row.exchange, o.accountId)) ?? []
  if (!own && visible.length === 0) return null
  const out: Record<string, any> = { ...row }
  if (outcomes) out.account_outcomes = JSON.stringify(visible)
  if (!own) {
    out.exchange = visible[0].exchange ?? row.exchange
    out.account_id = visible[0].accountId ?? null
    out.stop_loss_order_id = null
    out.take_profit_order_id = null
  }
  return out as T
}

export function scopeSignalRows<T extends Record<string, any>>(scope: AccountScope, rows: T[]): T[] {
  if (scope.all) return rows
  return rows.map((r) => scopeSignalRow(scope, r)).filter((r): r is T => r !== null)
}

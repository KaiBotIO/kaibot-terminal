import type { KaiBotDatabase } from '../storage/database.js'
import { getCollateralFloor } from '../storage/collateral-store.js'
import type { NotificationEvent } from '../services/notifications/notification-bus.js'
import { canSeeAccount, type AccountScope } from './account-scope.js'

// Executor-wide events that say nothing about an account.
const GLOBAL_EVENTS = new Set<NotificationEvent['type']>([
  'connection_lost',
  'connection_restored',
  'executor_conflict',
  'update_available',
  'update_required',
])

type Ref = { exchange: string | null | undefined; accountId: string | null | undefined }

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

// 'pos:<exchange>:<account>:<SYMBOL>' (position-trail.ts).
function refFromPositionKey(key: string | null): Ref | null {
  if (!key) return null
  const parts = key.split(':')
  if (parts[0] !== 'pos' || parts.length < 4) return null
  return { exchange: parts[1], accountId: parts.slice(2, -1).join(':') }
}

// The account an event is about, from whatever its payload carries.
function eventRefs(db: KaiBotDatabase, data: Record<string, unknown>): Ref[] | null {
  const exchange = str(data.exchange)
  const accountId = str(data.accountId) ?? str(data.account)
  if (exchange && accountId) return [{ exchange, accountId }]

  const key = refFromPositionKey(str(data.key))
  if (key) return [key]

  const positionId = str(data.positionId)
  if (positionId) {
    const row = db.getSyntheticUsdPosition(positionId)
    if (row) return [{ exchange: row.exchange, accountId: row.account_id }]
  }

  const floorId = str(data.floorId)
  if (floorId) {
    const row = getCollateralFloor(db, floorId)
    if (row) return [{ exchange: row.exchange, accountId: row.account_id }]
  }

  for (const field of ['signalId', 'entrySignalId', 'closeSignalId']) {
    const id = str(data[field])
    const exec = id ? db.getSignalExecution(id) : undefined
    if (exec) return [{ exchange: exec.exchange, accountId: exec.account_id }]
  }

  // Futures roll events name the account only.
  if (accountId) return [{ exchange: null, accountId }]
  return null
}

/**
 * Whether a viewer with this scope may receive the event. Anything that can't
 * be tied to a granted account is withheld (fail closed): a signal that has
 * no execution yet, reconciler alerts, plain error toasts.
 */
export function notificationVisible(db: KaiBotDatabase, scope: AccountScope, event: NotificationEvent): boolean {
  if (scope.all) return true
  if (GLOBAL_EVENTS.has(event.type)) return true
  const refs = event.data ? eventRefs(db, event.data) : null
  if (!refs) return false
  // Without a venue only an exact account grant counts: '21084931' would
  // otherwise read as the default connection of any granted exchange.
  return refs.some((r) =>
    r.exchange
      ? canSeeAccount(scope, r.exchange, r.accountId)
      : scope.grants.some((g) => g.kind === 'account' && g.ref === r.accountId),
  )
}

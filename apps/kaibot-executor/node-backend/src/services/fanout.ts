// One bot, several subscriptions: entry fan-out per account.
//
// A bot routed to more than one connection ([ALLOC] subs per account, the
// Deribit couple on two accounts) used to execute an entry on the OLDEST
// active subscription only (getSubscriptionForBot = LIMIT 1). Every further
// subscription now runs the same signal on its own connection as its own
// lineage. The first subscription (creation order) keeps the wire signal id,
// so a bot with one subscription behaves exactly as before; every further
// subscription runs under a derived id `<wireId>~<8 hex>` that every
// per-lineage table (executions, fills, brackets, trails, settlements,
// deferred entries, server exit state) keys on unchanged. The server keeps
// seeing one signal: one ack per wire id, per-account outcomes in its body.

import crypto from 'crypto'
import type { Signal } from '../storage/types.js'

export const FANOUT_SEPARATOR = '~'

export interface FanoutSubscription {
  id: string
  signal_bot_id?: string
  exchange?: string | null
  account_id?: string | null
  account_key?: string | null
  status?: string
  selected_markets?: string | null
  [key: string]: unknown
}

export type AccountOutcomeStatus =
  | 'executed'
  | 'rejected'
  | 'deferred'
  | 'pending'
  // No order and no ack: a redelivered signal whose lineage already exists.
  | 'skipped'

// What one subscription did with the signal. Sent to the server on the ack
// (`accounts[]`) and stored on the wire signal row for the UI. Carries the
// fill PRICE only, never the filled size (positions.size on the server stays
// the seeded factor; the user's real size never leaves this machine).
export interface AccountOutcome {
  subscriptionId: string
  accountId: string | null
  accountKey: string | null
  exchange: string | null
  // The lineage id this subscription ran under (wire id for the first sub).
  signalId: string
  status: AccountOutcomeStatus
  orderId: string | null
  reason: string | null
  stopLossOrderId: string | null
  takeProfitOrderId: string | null
  fillPrice: number | null
  fillTime: number | null
}

// What ackToApi captured for one lineage while a fan-out was collecting.
export interface CapturedAck {
  signalId: string
  status: 'executed' | 'rejected' | 'deferred'
  orderId: string | null
  reason: string | null
  stopLossOrderId: string | null
  takeProfitOrderId: string | null
  fillPrice: number | null
  fillTime: number | null
}

export function fanoutSuffix(subscriptionId: string): string {
  return crypto.createHash('sha256').update(subscriptionId).digest('hex').slice(0, 8)
}

export function deriveFanoutId(wireId: string, subscriptionId: string): string {
  return `${wireId}${FANOUT_SEPARATOR}${fanoutSuffix(subscriptionId)}`
}

export function isFanoutChildId(id: string): boolean {
  return id.includes(FANOUT_SEPARATOR)
}

// The id the server knows: the derived suffix stripped.
export function wireIdOf(id: string): string {
  const i = id.indexOf(FANOUT_SEPARATOR)
  return i > 0 ? id.slice(0, i) : id
}

export function inFanoutFamily(id: string, wireId: string): boolean {
  return id === wireId || id.startsWith(wireId + FANOUT_SEPARATOR)
}

// The subscription a child signal was cloned for, when it is one.
export function fanoutSubscriptionIdOf(signal: Pick<Signal, 'metadata'>): string | undefined {
  const v = signal.metadata?.fanoutSubscriptionId
  return typeof v === 'string' && v ? v : undefined
}

// The per-account copy of a wire signal for subscription `index` in creation
// order. Index 0 keeps the wire id and metadata untouched (the single-sub
// path, unchanged); every further copy runs under a derived id and marks its
// origin so the family can be found again (closes, cancels, the UI).
export function childSignalFor(wire: Signal, sub: FanoutSubscription, index: number): Signal {
  const copy = structuredClone(wire)
  if (index === 0) return copy
  copy.id = deriveFanoutId(wire.id, sub.id)
  copy.metadata = {
    ...(wire.metadata ?? {}),
    fanoutOf: wire.id,
    fanoutSubscriptionId: sub.id,
  }
  return copy
}

// A lineage-scoped id for a per-account row (server_exit_state.position_id):
// the wire id for the first subscription, derived for the others.
export function fanoutScopedId(wireId: string, signal: Pick<Signal, 'metadata'>): string {
  const subId = fanoutSubscriptionIdOf(signal)
  return subId ? deriveFanoutId(wireId, subId) : wireId
}

// One subscription's outcome from what its run captured. A run that neither
// acked nor threw ended locally (pending settlement, or a duplicate that
// never placed an order); the local signal status tells the two apart.
export function outcomeFor(input: {
  sub: FanoutSubscription
  signalId: string
  captured: CapturedAck[]
  threw: string | null
  localStatus: string | undefined
}): AccountOutcome {
  const base = {
    subscriptionId: input.sub.id,
    accountId: input.sub.account_id ?? null,
    accountKey: input.sub.account_key ?? null,
    exchange: input.sub.exchange ?? null,
    signalId: input.signalId,
    orderId: null,
    reason: null,
    stopLossOrderId: null,
    takeProfitOrderId: null,
    fillPrice: null,
    fillTime: null,
  }
  const last = input.captured[input.captured.length - 1]
  if (last) {
    return {
      ...base,
      status: last.status,
      orderId: last.orderId,
      reason: last.reason,
      stopLossOrderId: last.stopLossOrderId,
      takeProfitOrderId: last.takeProfitOrderId,
      fillPrice: last.fillPrice,
      fillTime: last.fillTime,
    }
  }
  if (input.threw) return { ...base, status: 'rejected', reason: input.threw }
  if (input.localStatus === 'pending') {
    return { ...base, status: 'pending', reason: 'outcome pending resolution' }
  }
  return { ...base, status: 'skipped', reason: 'duplicate delivery: lineage already recorded' }
}

export type AggregateStatus = 'executed' | 'deferred' | 'pending' | 'rejected' | 'none'

export interface AggregatedOutcome {
  status: AggregateStatus
  // The outcome whose order ids / fill the single ack carries.
  primary: AccountOutcome | null
  // Ack error message (rejected / deferred) and the wire row's message.
  reason: string | null
  message: string
}

const accountLabel = (o: AccountOutcome) => o.accountId ?? o.accountKey ?? o.subscriptionId

// One ack per wire signal: executed as soon as one account executed, deferred
// when none did and one is waiting for market open, pending while an account
// is still settling, rejected only when every account refused. Nothing at all
// when every run was a silent duplicate.
export function aggregateOutcomes(outcomes: AccountOutcome[]): AggregatedOutcome {
  const total = outcomes.length
  const executed = outcomes.filter((o) => o.status === 'executed')
  const deferred = outcomes.filter((o) => o.status === 'deferred')
  const pending = outcomes.filter((o) => o.status === 'pending')
  const rejected = outcomes.filter((o) => o.status === 'rejected')
  if (executed.length > 0) {
    return {
      status: 'executed',
      primary: executed[0],
      reason: null,
      message:
        executed.length === total
          ? `executed on ${total} accounts`
          : `executed on ${executed.length} of ${total} accounts`,
    }
  }
  if (deferred.length > 0) {
    return {
      status: 'deferred',
      primary: deferred[0],
      reason: deferred[0].reason,
      message: `waiting for market open on ${deferred.length} of ${total} accounts`,
    }
  }
  if (pending.length > 0) {
    return {
      status: 'pending',
      primary: pending[0],
      reason: null,
      message: `outcome pending on ${pending.length} of ${total} accounts`,
    }
  }
  if (rejected.length > 0) {
    const reasons = new Set(rejected.map((o) => o.reason ?? 'rejected'))
    const reason =
      reasons.size === 1
        ? [...reasons][0]
        : rejected.map((o) => `${accountLabel(o)}: ${o.reason ?? 'rejected'}`).join('; ')
    return {
      status: 'rejected',
      primary: rejected[0],
      reason,
      message: rejected.length === total ? reason : `rejected on ${rejected.length} of ${total} accounts: ${reason}`,
    }
  }
  return { status: 'none', primary: null, reason: null, message: 'no account placed an order' }
}

// Which subscription owns a broker account: the connection label must match
// and, when the subscription pins an account, that account too.
export function subscriptionForAccount<T extends FanoutSubscription>(
  subs: T[],
  accountId: string,
  accountKeyOf: (accountId: string) => string | undefined,
): T | undefined {
  const key = accountKeyOf(accountId)
  return subs.find(
    (s) => (s.account_key ?? undefined) === key && (!s.account_id || s.account_id === accountId),
  )
}

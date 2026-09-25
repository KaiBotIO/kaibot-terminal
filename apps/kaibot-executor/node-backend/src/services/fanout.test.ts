import { describe, expect, it } from 'bun:test'
import {
  aggregateOutcomes,
  childSignalFor,
  deriveFanoutId,
  fanoutScopedId,
  inFanoutFamily,
  isFanoutChildId,
  outcomeFor,
  subscriptionForAccount,
  wireIdOf,
  type AccountOutcome,
} from './fanout.js'
import type { Signal } from '../storage/types.js'

const wire = (): Signal =>
  ({
    id: 'sig-1',
    strategy_id: 'strat',
    symbol: 'MES',
    action: 'buy',
    quantity: 1,
    price: 7779.25,
    metadata: { signalBotId: 'bot-1', positionId: 'pos-1' },
    received_at: new Date(),
    status: 'pending',
    created_at: new Date(),
  }) as unknown as Signal

const sub = (id: string, accountId: string | null = null, accountKey: string | null = null) => ({
  id,
  account_id: accountId,
  account_key: accountKey,
  exchange: 'tradestation',
})

const outcome = (over: Partial<AccountOutcome>): AccountOutcome => ({
  subscriptionId: 's',
  accountId: 'a',
  accountKey: null,
  exchange: 'tradestation',
  signalId: 'sig-1',
  status: 'executed',
  orderId: null,
  reason: null,
  stopLossOrderId: null,
  takeProfitOrderId: null,
  fillPrice: null,
  fillTime: null,
  ...over,
})

describe('fan-out ids', () => {
  it('derives a stable child id and finds the wire id back', () => {
    const a = deriveFanoutId('sig-1', 'sub-b')
    expect(a).toBe(deriveFanoutId('sig-1', 'sub-b'))
    expect(a).not.toBe(deriveFanoutId('sig-1', 'sub-c'))
    expect(a.startsWith('sig-1~')).toBe(true)
    expect(isFanoutChildId(a)).toBe(true)
    expect(isFanoutChildId('sig-1')).toBe(false)
    expect(wireIdOf(a)).toBe('sig-1')
    expect(wireIdOf('sig-1')).toBe('sig-1')
    expect(inFanoutFamily(a, 'sig-1')).toBe(true)
    expect(inFanoutFamily('sig-1', 'sig-1')).toBe(true)
    expect(inFanoutFamily('sig-10', 'sig-1')).toBe(false)
  })

  it('keeps the first subscription on the wire signal untouched', () => {
    const w = wire()
    const first = childSignalFor(w, sub('sub-a'), 0)
    expect(first.id).toBe('sig-1')
    expect(first.metadata).toEqual(w.metadata)
    expect(first).not.toBe(w)
    const second = childSignalFor(w, sub('sub-b'), 1)
    expect(second.id).toBe(deriveFanoutId('sig-1', 'sub-b'))
    expect(second.metadata?.fanoutOf).toBe('sig-1')
    expect(second.metadata?.fanoutSubscriptionId).toBe('sub-b')
    expect(second.metadata?.signalBotId).toBe('bot-1')
    // The wire position id stays: the server knows one position.
    expect(second.metadata?.positionId).toBe('pos-1')
    expect(fanoutScopedId('pos-1', second)).toBe(deriveFanoutId('pos-1', 'sub-b'))
    expect(fanoutScopedId('pos-1', first)).toBe('pos-1')
  })
})

describe('outcomeFor', () => {
  it('takes the captured ack, else a throw, else the local status', () => {
    const s = sub('sub-a', '933')
    expect(
      outcomeFor({
        sub: s,
        signalId: 'sig-1',
        captured: [
          {
            signalId: 'sig-1',
            status: 'executed',
            orderId: 'o1',
            reason: null,
            stopLossOrderId: 'sl1',
            takeProfitOrderId: null,
            fillPrice: 7780,
            fillTime: 1,
          },
        ],
        threw: null,
        localStatus: 'executed',
      }),
    ).toMatchObject({ status: 'executed', orderId: 'o1', stopLossOrderId: 'sl1', fillPrice: 7780, accountId: '933' })
    expect(
      outcomeFor({ sub: s, signalId: 'x', captured: [], threw: 'boom', localStatus: undefined }),
    ).toMatchObject({ status: 'rejected', reason: 'boom' })
    expect(
      outcomeFor({ sub: s, signalId: 'x', captured: [], threw: null, localStatus: 'pending' }),
    ).toMatchObject({ status: 'pending' })
    expect(
      outcomeFor({ sub: s, signalId: 'x', captured: [], threw: null, localStatus: 'executed' }),
    ).toMatchObject({ status: 'skipped' })
  })
})

describe('aggregateOutcomes', () => {
  it('is executed as soon as one account executed, primary = first executed', () => {
    const agg = aggregateOutcomes([
      outcome({ subscriptionId: 'a', status: 'rejected', reason: 'basis guard: x' }),
      outcome({ subscriptionId: 'b', status: 'executed', orderId: 'o-b' }),
      outcome({ subscriptionId: 'c', status: 'executed', orderId: 'o-c' }),
    ])
    expect(agg.status).toBe('executed')
    expect(agg.primary?.orderId).toBe('o-b')
    expect(agg.message).toBe('executed on 2 of 3 accounts')
  })

  it('is rejected only when every account refused, with one reason when they agree', () => {
    const same = aggregateOutcomes([
      outcome({ accountId: '933', status: 'rejected', reason: 'symbol not in selected markets' }),
      outcome({ accountId: '936', status: 'rejected', reason: 'symbol not in selected markets' }),
    ])
    expect(same.status).toBe('rejected')
    expect(same.reason).toBe('symbol not in selected markets')
    const mixed = aggregateOutcomes([
      outcome({ accountId: '933', status: 'rejected', reason: 'basis guard' }),
      outcome({ accountId: '936', status: 'rejected', reason: 'session status disconnected' }),
    ])
    expect(mixed.reason).toBe('933: basis guard; 936: session status disconnected')
  })

  it('prefers deferred over pending over rejected, and none when every run was silent', () => {
    expect(
      aggregateOutcomes([
        outcome({ status: 'rejected', reason: 'r' }),
        outcome({ status: 'deferred', reason: 'market closed' }),
        outcome({ status: 'pending' }),
      ]).status,
    ).toBe('deferred')
    expect(
      aggregateOutcomes([outcome({ status: 'rejected', reason: 'r' }), outcome({ status: 'pending' })]).status,
    ).toBe('pending')
    expect(aggregateOutcomes([outcome({ status: 'skipped' }), outcome({ status: 'skipped' })]).status).toBe('none')
  })
})

describe('subscriptionForAccount', () => {
  const keyOf = (id: string) => (id.includes('/') ? id.split('/')[0] : undefined)
  it('matches on connection label and pinned account', () => {
    const subs = [sub('a', '933', null), sub('b', '936', null), sub('c', null, 'acct2')]
    expect(subscriptionForAccount(subs, '936', keyOf)?.id).toBe('b')
    expect(subscriptionForAccount(subs, 'acct2/btc', keyOf)?.id).toBe('c')
    expect(subscriptionForAccount(subs, '999', keyOf)).toBeUndefined()
  })
})

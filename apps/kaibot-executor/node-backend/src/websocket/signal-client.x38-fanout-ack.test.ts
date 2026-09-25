// X.38 (docs/sweep/altlab3/X/x38-ack-review.ts): a server exit update fanned
// out over two accounts must report, on the single wire ack, what rests at
// the venue: per account in accounts[] and at wire level for the wire
// lineage. (a) both accounts cancel the old stop and fail to place the new
// one -> rejected with venueStop null everywhere; (b) both keep the old stop
// because the new one crossed the mark -> executed with venueStop 90, never
// the intent 98. Transport is intercepted; no DB, no venue.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { SignalWebSocketClient } from './signal-client'

const originalFetch = globalThis.fetch

function harness(mode: 'cancel-fails-placement' | 'crossed-noop') {
  const wireBodies: any[] = []
  const states = [0, 1].map((i) => ({
    position_id: i === 0 ? 'position-0' : 'position-0~1111aaaa',
    entry_signal_id: i === 0 ? 'entry-0' : 'entry-0~1111aaaa',
    exchange: 'test', symbol: 'X', direction: 'long', active: 1, last_exit_seq: 0, current_stop: 90, sl_order_id: `old-${i}`,
  }))
  const db: any = {
    log() {}, updateSignalStatus() {}, recordSignalAck() {}, setSignalAccountOutcomes() {},
    getServerExitState: (id: string) => states.find((s) => s.position_id === id),
    listServerExitStatesForFamily: () => states,
    getSignalExecution: () => undefined,
    getSignalBracket: (id: string) => ({ stop_loss_order_id: states.find((s) => s.entry_signal_id === id)?.sl_order_id, take_profit_order_id: null }),
    updateSignalOrderIds() {},
    applyServerExitUpdate: (id: string, patch: any) => {
      const s: any = states.find((x) => x.position_id === id)!
      s.sl_order_id = patch.slOrderId ?? null
      s.current_stop = patch.currentStop
      s.last_exit_seq = patch.exitSeq
    },
  }
  const adapter = {
    getPositions: async () => [{ symbol: 'X', size: 1, markPrice: mode === 'crossed-noop' ? 97 : 100 }],
    cancelOrder: async () => {},
    placeOrder: async () => { throw new Error('synthetic placement rejection') },
  }
  const client: any = new SignalWebSocketClient(db)
  client.apiUrl = 'https://mock.invalid'
  client.apiKey = 'synthetic-test-key'
  globalThis.fetch = (async (_url: unknown, options: any) => {
    wireBodies.push(JSON.parse(options.body))
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  client.subForLineage = (_subs: unknown, id: string) => ({ id, account_id: id })
  client.processSignalForSub = (sig: any, _wire: any, _sub: any, _bot: any, ctx: any) =>
    client.handleServerExitUpdate(sig, { adapter }, 'test', ctx.positionId)
  return { client, wireBodies, states }
}

describe('fan-out exit update ack reports the venue stop per lineage and at wire level', () => {
  beforeEach(() => { /* fetch replaced per harness */ })
  afterEach(() => { globalThis.fetch = originalFetch })

  it('(a) cancel ok + placement failed on both accounts: rejected, venueStop null on the wire and per account', async () => {
    const { client, wireBodies, states } = harness('cancel-fails-placement')
    const signal = { id: 'wire-update', action: 'update', symbol: 'X', price: 98, metadata: { positionId: 'position-0', exitSeq: 1 } }
    await client.fanOutUpdate(signal, signal, [], 'bot')
    expect(wireBodies).toHaveLength(1)
    const body = wireBodies[0]
    expect(body.status).toBe('rejected')
    expect(Object.hasOwn(body, 'venueStop')).toBe(true)
    expect(body.venueStop).toBeNull()
    expect(states.map((s) => s.sl_order_id)).toEqual([null, null])
    expect(body.accounts).toHaveLength(2)
    for (const a of body.accounts) {
      expect(a.status).toBe('rejected')
      expect(Object.hasOwn(a, 'venueStop')).toBe(true)
      expect(a.venueStop).toBeNull()
    }
  })

  it('(b) new stop crossed the mark on both accounts: executed, venueStop 90 (the resting stop), never the intent 98', async () => {
    const { client, wireBodies } = harness('crossed-noop')
    const signal = { id: 'wire-update', action: 'update', symbol: 'X', price: 98, metadata: { positionId: 'position-0', exitSeq: 1 } }
    await client.fanOutUpdate(signal, signal, [], 'bot')
    expect(wireBodies).toHaveLength(1)
    const body = wireBodies[0]
    expect(body.status).toBe('executed')
    expect(body.venueStop).toBe(90)
    expect(body.stopLossOrderId).toBe('old-0')
    expect(body.accounts).toHaveLength(2)
    expect(body.accounts.map((a: any) => a.venueStop)).toEqual([90, 90])
    expect(body.accounts.map((a: any) => a.stopLossOrderId)).toEqual(['old-0', 'old-1'])
  })

  it('(X.39) the wire account decides the wire value: a child report never stands in, no child order id', async () => {
    const { client, wireBodies } = harness('crossed-noop')
    // The wire account acks WITHOUT a report (an older-style path), the child reports 90.
    const realHandler = client.handleServerExitUpdate.bind(client)
    client.processSignalForSub = async (sig: any, _wire: any, _sub: any, _bot: any, ctx: any) => {
      if (ctx.positionId === 'position-0') {
        await client.ackToApi(sig.id, 'executed', undefined, undefined, 'wire-old-0', undefined, undefined, undefined)
        return
      }
      return realHandler(sig, { adapter: { getPositions: async () => [{ symbol: 'X', size: 1, markPrice: 97 }], cancelOrder: async () => {}, placeOrder: async () => { throw new Error('x') } } }, 'test', ctx.positionId)
    }
    const signal = { id: 'wire-update', action: 'update', symbol: 'X', price: 98, metadata: { positionId: 'position-0', exitSeq: 1 } }
    await client.fanOutUpdate(signal, signal, [], 'bot')
    const body = wireBodies[0]
    expect(body.status).toBe('executed')
    expect(Object.hasOwn(body, 'venueStop')).toBe(false)
    expect(body.stopLossOrderId).toBe('wire-old-0')
    // The child's own report is still in accounts[].
    const child = body.accounts.find((a: any) => a.signalId !== 'entry-0')
    expect(child.venueStop).toBe(90)
    expect(Object.hasOwn(body.accounts.find((a: any) => a.signalId === 'entry-0'), 'venueStop')).toBe(false)
  })

  it('single lineage keeps reporting as before', async () => {
    const { client, wireBodies } = harness('crossed-noop')
    const signal = { id: 'wire-update', action: 'update', symbol: 'X', price: 98, metadata: { positionId: 'position-0', exitSeq: 1 } }
    await client.handleServerExitUpdate(signal, { adapter: { getPositions: async () => [{ symbol: 'X', size: 1, markPrice: 97 }], cancelOrder: async () => {}, placeOrder: async () => { throw new Error('x') } } }, 'test')
    expect(wireBodies[0].status).toBe('executed')
    expect(wireBodies[0].venueStop).toBe(90)
  })
})

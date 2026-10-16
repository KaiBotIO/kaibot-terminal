// X.37 (docs/sweep/altlab3/X/x37-catchup-reproducers.ts): a stop amend that
// cancelled the old order and then failed to place the new one leaves the
// state row with sl_order_id null while current_stop still reads the old
// level. Nothing rests at the venue; the server must learn "no stop", never
// "still 90".
import { describe, expect, it } from 'bun:test'
import { replaceServerExitStop } from './server-exit-stop'

describe('replaceServerExitStop: cancel ok, place failed', () => {
  it('leaves sl_order_id null (no resting stop) and rethrows', async () => {
    const events: unknown[] = []
    const st: any = { position_id: 'x', entry_signal_id: 'entry', exchange: 'test', symbol: 'X', direction: 'long', last_exit_seq: 0, current_stop: 90, sl_order_id: 'old-stop' }
    const db: any = {
      getSignalBracket: () => ({ stop_loss_order_id: 'old-stop', take_profit_order_id: null }),
      applyServerExitUpdate: (_id: string, p: any) => { events.push({ patch: p }); st.sl_order_id = p.slOrderId ?? null; st.current_stop = p.currentStop },
      updateSignalOrderIds: () => {},
      log: () => {},
    }
    const adapter: any = {
      cancelOrder: async (id: string) => { events.push({ cancelled: id }) },
      placeOrder: async () => { throw new Error('simulated venue rejection') },
    }
    await expect(
      replaceServerExitStop({ db, adapter, state: st, live: { size: 1, symbol: 'X', accountId: 'test' } as any, lineageAccount: 'test', stopPrice: 98, exitSeq: 1, label: 'synthetic' }),
    ).rejects.toThrow('simulated venue rejection')
    expect(events[0]).toEqual({ cancelled: 'old-stop' })
    expect(st.sl_order_id).toBeNull()
    expect(st.current_stop).toBe(90)
    // The ack derives "what rests" from the order id, not from current_stop.
    const restingNow = st.sl_order_id && typeof st.current_stop === 'number' ? st.current_stop : null
    expect(restingNow).toBeNull()
  })
})

// M2 (verify-before-crack 06/10): an htf-close rung (metadata.add + resizeStop)
// on an armed position left the venue stop at the seed quantity. After the add
// fills, a full-size stop goes up at the same level FIRST; the seed-size stop
// is cancelled only after that succeeded. Trail-bot adds (no resizeStop) keep
// the old behaviour.
import { describe, expect, it } from 'bun:test'
import { SignalWebSocketClient } from './signal-client'

function harness(opts: { venueSize: number; markPrice: number; armed?: boolean; placeFails?: boolean }) {
  const calls: string[] = []
  const placed: any[] = []
  const notices: any[] = []
  const state = {
    position_id: 'pos-1', entry_signal_id: 'entry-1', exchange: 'bybit', symbol: 'NEARUSDT',
    direction: 'long', active: 1, last_exit_seq: 4, current_stop: 1.8, sl_order_id: 'sl-seed', engine_stop: 1.8,
  }
  const applied: any[] = []
  const db: any = {
    log() {},
    getServerExitState: (id: string) => (opts.armed === false || id !== 'pos-1' ? undefined : state),
    getSignalBracket: () => ({ stop_loss_order_id: 'sl-seed', take_profit_order_id: null }),
    updateSignalOrderIds: (_id: string, sl: string) => calls.push(`orderIds:${sl}`),
    applyServerExitUpdate: (_id: string, patch: any) => applied.push(patch),
  }
  const adapter = {
    getPositions: async () => [{ symbol: 'NEARUSDT', size: opts.venueSize, markPrice: opts.markPrice }],
    cancelOrder: async (id: string) => { calls.push(`cancel:${id}`) },
    placeOrder: async (o: any) => {
      calls.push('place')
      if (opts.placeFails) throw new Error('synthetic venue reject')
      placed.push(o)
      return { orderId: 'sl-full' }
    },
  }
  const client: any = new SignalWebSocketClient(db)
  client.notifications = { publish: (n: any) => notices.push(n) }
  return { client, adapter, placed, calls, applied, notices }
}

const htfAdd = { id: 'add-1', action: 'buy', symbol: 'NEARUSDT', metadata: { add: true, resizeStop: true, positionId: 'pos-1' } }

describe('stop resize after an htf-close add', () => {
  it('places the full-size stop first, then cancels the seed-size stop', async () => {
    const h = harness({ venueSize: 300, markPrice: 2.1 })
    await h.client.resizeServerExitStopAfterAdd(htfAdd, { adapter: h.adapter }, 'bybit', undefined)
    expect(h.calls.indexOf('place')).toBeLessThan(h.calls.indexOf('cancel:sl-seed'))
    expect(h.placed[0]).toMatchObject({ orderType: 'stop', quantity: 300, stopPrice: 1.8, reduceOnly: true, side: 'sell' })
    // Same level, same seq, bot stop untouched.
    expect(h.applied[0]).toEqual({ exitSeq: 4, currentStop: 1.8, slOrderId: 'sl-full' })
    expect(h.calls).toContain('orderIds:sl-full')
  })

  it('a failed place keeps the seed-size stop and alerts', async () => {
    const h = harness({ venueSize: 300, markPrice: 2.1, placeFails: true })
    await h.client.resizeServerExitStopAfterAdd(htfAdd, { adapter: h.adapter }, 'bybit', undefined)
    expect(h.calls).toEqual(['place'])
    expect(h.applied).toHaveLength(0)
    expect(h.notices).toHaveLength(1)
    expect(h.notices[0].type).toBe('error')
  })

  it('leaves the stop alone when the mark already crossed it', async () => {
    const h = harness({ venueSize: 300, markPrice: 1.7 })
    await h.client.resizeServerExitStopAfterAdd(htfAdd, { adapter: h.adapter }, 'bybit', undefined)
    expect(h.calls).toHaveLength(0)
  })

  it('does nothing for a position without server exit authority', async () => {
    const h = harness({ venueSize: 300, markPrice: 2.1, armed: false })
    await h.client.resizeServerExitStopAfterAdd(htfAdd, { adapter: h.adapter }, 'bybit', undefined)
    expect(h.calls).toHaveLength(0)
  })
})

describe('the entry path only resizes flagged adds', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(import.meta.dir, 'signal-client.ts'), 'utf8') as string
  it('gates the resize on metadata.resizeStop, so trail-bot adds keep their stop', () => {
    expect(src).toContain('if (isAdd && signal.metadata?.resizeStop === true) {')
  })
})

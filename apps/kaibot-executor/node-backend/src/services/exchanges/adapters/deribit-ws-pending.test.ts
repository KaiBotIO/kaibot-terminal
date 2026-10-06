import { describe, expect, it } from 'bun:test'
import { EventEmitter } from 'node:events'
import { DeribitAdapter } from './deribit.js'

// 2026-09-06 skaibox blip: a dropped Deribit socket left every in-flight
// JSON-RPC request to time out on its own, each as an UNHANDLED rejection
// ('WebSocket request timeout' every 5-15 s). Requests are now tracked and
// failed together, with a handled reason, the moment the socket goes.

class FakeWs extends EventEmitter {
  readyState = 1 // OPEN
  sent: any[] = []
  send(raw: string) {
    this.sent.push(JSON.parse(raw))
  }
  close() {
    this.readyState = 3
    this.emit('close')
  }
  terminate() {
    this.close()
  }
}

// Wire a fake socket through the adapter's real connect handlers by driving
// the private connectWebSocket with a stubbed WebSocket constructor is more
// than the pending registry needs: the registry only touches ws.send + the
// 'message'/'close'/'error' handlers, which we attach the same way here.
function adapterWithFakeWs() {
  const adapter = new DeribitAdapter()
  const ws = new FakeWs()
  ;(adapter as any).ws = ws
  ws.on('message', (data: string) => {
    const message = JSON.parse(data)
    const pending = (adapter as any).pendingWs.get(message.id)
    if (pending) {
      ;(adapter as any).pendingWs.delete(message.id)
      clearTimeout(pending.timer)
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result)
    }
  })
  ws.on('close', () => (adapter as any).rejectPendingWs(new Error('WebSocket disconnected')))
  return { adapter, ws }
}

function unhandledRejections(run: () => Promise<void>): Promise<number> {
  return new Promise(async (resolve) => {
    let count = 0
    const onUnhandled = () => count++
    process.on('unhandledRejection' as any, onUnhandled)
    await run()
    // Give the microtask queue a turn so any dangling rejection surfaces.
    await new Promise((r) => setTimeout(r, 20))
    process.off('unhandledRejection' as any, onUnhandled)
    resolve(count)
  })
}

describe('Deribit WS pending-request registry', () => {
  it('a response settles its request and clears the timer', async () => {
    const { adapter, ws } = adapterWithFakeWs()
    const p = (adapter as any).sendWsRequest('private/get_positions', { currency: 'BTC' })
    const req = ws.sent[0]
    ws.emit('message', JSON.stringify({ id: req.id, result: [{ instrument_name: 'BTC-PERPETUAL' }] }))
    expect(await p).toEqual([{ instrument_name: 'BTC-PERPETUAL' }])
    expect((adapter as any).pendingWs.size).toBe(0)
  })

  it('REGRESSION: a dropped socket fails in-flight requests together, with no unhandled rejection', async () => {
    const { adapter, ws } = adapterWithFakeWs()
    const unhandled = await unhandledRejections(async () => {
      // Real callers await their request before the socket can drop; mirror
      // that by attaching the handlers first (plain .then: bun's .rejects
      // matcher settles the promise eagerly and would race the close).
      const outcome = (p: Promise<unknown>) => p.then(() => 'resolved', (e: Error) => e.message)
      const a = outcome((adapter as any).sendWsRequest('private/get_positions', { currency: 'BTC' }, 1000))
      const b = outcome((adapter as any).sendWsRequest('private/get_positions', { currency: 'ETH' }, 1000))
      ws.close()
      expect(await a).toBe('WebSocket disconnected')
      expect(await b).toBe('WebSocket disconnected')
      expect((adapter as any).pendingWs.size).toBe(0)
      // The old per-request timers would have fired here into the void.
      await new Promise((r) => setTimeout(r, 30))
    })
    expect(unhandled).toBe(0)
  })

  it('a request that really times out rejects its own awaiter only', async () => {
    const { adapter } = adapterWithFakeWs()
    const unhandled = await unhandledRejections(async () => {
      await expect((adapter as any).sendWsRequest('public/test', {}, 20)).rejects.toThrow('WebSocket request timeout')
    })
    expect(unhandled).toBe(0)
    expect((adapter as any).pendingWs.size).toBe(0)
  })

  it('the heartbeat test_request reply never surfaces as an unhandled rejection', async () => {
    const { adapter, ws } = adapterWithFakeWs()
    const unhandled = await unhandledRejections(async () => {
      ;(adapter as any).handleWsMessage({ params: { type: 'test_request' } })
      expect(ws.sent[0].method).toBe('public/test')
      ws.close() // reply never comes; the request is failed and swallowed
      await new Promise((r) => setTimeout(r, 30))
    })
    expect(unhandled).toBe(0)
  })
})

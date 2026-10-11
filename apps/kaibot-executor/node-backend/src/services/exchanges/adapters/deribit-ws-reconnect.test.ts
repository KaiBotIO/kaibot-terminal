import { describe, expect, it } from 'bun:test'
import { EventEmitter } from 'node:events'
import { DeribitAdapter } from './deribit.js'

// 2026-09-05/06 Deribit reconnect storm: a fixed 5 s retry after every close,
// a new socket opened on top of the old one, and a ping interval leaked per
// attempt. Deribit's maintenance window seeded it; too_many_requests kept it
// alive at ~1.200 reconnects/hour until a container restart.

class FakeWs extends EventEmitter {
  readyState = 1
  sent: any[] = []
  terminated = 0
  send(raw: string) {
    this.sent.push(JSON.parse(raw))
  }
  close() {
    this.readyState = 3
    this.emit('close', 1000, Buffer.from(''))
  }
  terminate() {
    this.terminated++
    this.readyState = 3
  }
}

describe('Deribit WS reconnect hygiene', () => {
  it('a request timeout names the method and id', async () => {
    const adapter = new DeribitAdapter()
    const ws = new FakeWs()
    ;(adapter as any).ws = ws
    const outcome = await (adapter as any).sendWsRequest('private/get_positions', {}, 10).then(
      () => 'resolved',
      (e: Error) => e.message,
    )
    expect(outcome).toMatch(/^WebSocket request timeout \(private\/get_positions #\d+\)$/)
  })

  it('REGRESSION: replacing the socket terminates the old one, fails its requests and drops its ping interval', async () => {
    const adapter = new DeribitAdapter()
    const old = new FakeWs()
    ;(adapter as any).ws = old
    ;(adapter as any).startPingInterval()
    const firstInterval = (adapter as any).pingInterval
    expect(firstInterval).toBeDefined()
    // A second setup on the same adapter (reconnect) must not stack intervals.
    ;(adapter as any).startPingInterval()
    expect((adapter as any).pingInterval).not.toBe(firstInterval)

    const inflight = (adapter as any)
      .sendWsRequest('private/get_positions', {}, 5000)
      .then(() => 'resolved', (e: Error) => e.message)

    ;(adapter as any).teardownWs('replaced by a new connection')

    expect(old.terminated).toBe(1)
    expect((adapter as any).ws).toBeUndefined()
    expect((adapter as any).pingInterval).toBeUndefined()
    expect(await inflight).toBe('WebSocket disconnected (replaced by a new connection)')
    // The detached socket's late events reach nobody.
    expect(old.listenerCount('close')).toBe(0)
  })

  it('REGRESSION: reconnect backs off exponentially and stops when disconnected on purpose', () => {
    const adapter = new DeribitAdapter()
    ;(adapter as any).credentials = { type: 'apiKey', apiKey: 'k', apiSecret: 's' }
    const delays: number[] = []
    for (let i = 0; i < 8; i++) {
      delays.push(adapter.wsReconnectDelayMs())
      ;(adapter as any).scheduleReconnect()
      clearTimeout((adapter as any).reconnectTimeout) // never actually dial
      ;(adapter as any).reconnectTimeout = undefined
    }
    expect(delays).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000])

    // A successful setup resets the ladder (the open handler does this).
    ;(adapter as any).wsReconnectAttempts = 0
    expect(adapter.wsReconnectDelayMs()).toBe(5_000)

    // disconnect() clears credentials → no reconnect is ever scheduled again.
    ;(adapter as any).credentials = undefined
    ;(adapter as any).scheduleReconnect()
    expect((adapter as any).reconnectTimeout).toBeUndefined()
  })
})

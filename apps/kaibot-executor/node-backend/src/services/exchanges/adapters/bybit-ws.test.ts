import { describe, expect, it, beforeEach } from 'bun:test'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { BybitAdapter } from './bybit.js'

// Private WebSocket of the Bybit adapter with a fake socket: auth frame,
// subscriptions, normalised topic rows, pong watchdog and the reconnect
// ladder. Same hygiene rules as the Deribit reconnect regression (2026-09-05).

class FakeWs extends EventEmitter {
  static OPEN = 1
  readyState = 0
  sent: any[] = []
  terminated = 0
  constructor(_url: string) {
    super()
  }
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
    this.emit('close', 1006, Buffer.from(''))
  }
  // Test helpers
  open() {
    this.readyState = 1
    this.emit('open')
  }
  receive(msg: any) {
    this.emit('message', Buffer.from(JSON.stringify(msg)))
  }
}

// Every adapter built here dials into `created` instead of the network.
const fake = { created: [] as FakeWs[] }

function authedAdapter(): BybitAdapter {
  const adapter = new BybitAdapter()
  ;(adapter as any).credentials = { type: 'apiKey', apiKey: 'KEY', apiSecret: 'SECRET' }
  ;(adapter as any).createSocket = (url: string) => {
    const ws = new FakeWs(url)
    fake.created.push(ws)
    return ws
  }
  return adapter
}

describe('Bybit private WS', () => {
  beforeEach(() => {
    fake.created = []
  })

  it('auth frame: [apiKey, expires, HMAC("GET/realtime"+expires)] with the venue-corrected clock', () => {
    const adapter = authedAdapter()
    ;(adapter as any).timeOffsetMs = 5000
    const before = Date.now()
    const msg = adapter.buildAuthMessage()
    expect(msg.op).toBe('auth')
    expect(msg.args[0]).toBe('KEY')
    const expires = msg.args[1]
    expect(expires).toBeGreaterThanOrEqual(before + 5000 + 10000)
    expect(expires).toBeLessThan(before + 5000 + 10000 + 1000)
    const expected = crypto.createHmac('sha256', 'SECRET').update(`GET/realtime${expires}`).digest('hex')
    expect(msg.args[2]).toBe(expected)
  })

  it('handshake: sends auth on open, subscribes order/execution/position/wallet after success', async () => {
    const adapter = authedAdapter()
    const events: any[] = []
    adapter.subscribeToUpdates((e) => events.push(e))
    const connecting = (adapter as any).connectWebSocket() as Promise<void>
    const ws = fake.created[0]
    ws.open()
    expect(ws.sent[0].op).toBe('auth')
    ws.receive({ op: 'auth', success: true, ret_msg: '', conn_id: 'c1' })
    await connecting
    expect(ws.sent[1]).toEqual({ op: 'subscribe', args: ['order', 'execution', 'position', 'wallet'] })
    expect(adapter.wsConnected).toBe(true)
    expect(events[0]).toEqual({ type: 'account', data: { connected: true } })
    expect((adapter as any).pingInterval).toBeDefined()
    await adapter.disconnect()
    expect((adapter as any).pingInterval).toBeUndefined()
    expect(ws.terminated).toBe(1)
  })

  it('handshake rejects on auth failure, on close and on socket error (never hangs)', async () => {
    const a1 = authedAdapter()
    const p1 = (a1 as any).connectWebSocket() as Promise<void>
    fake.created[0].open()
    fake.created[0].receive({ op: 'auth', success: false, ret_msg: 'error: api key expired' })
    await expect(p1).rejects.toThrow(/api key expired/)
    clearTimeout((a1 as any).reconnectTimeout)

    const a2 = authedAdapter()
    const p2 = (a2 as any).connectWebSocket() as Promise<void>
    fake.created[1].close()
    await expect(p2).rejects.toThrow(/closed before auth/)
    clearTimeout((a2 as any).reconnectTimeout)

    const a3 = authedAdapter()
    const p3 = (a3 as any).connectWebSocket() as Promise<void>
    fake.created[2].emit('error', new Error('ECONNRESET'))
    await expect(p3).rejects.toThrow(/ECONNRESET/)
    clearTimeout((a3 as any).reconnectTimeout)
  })

  it('order topic rows reach the callback normalised (orderId + state), execution rows as fills', async () => {
    const adapter = authedAdapter()
    const events: any[] = []
    adapter.subscribeToUpdates((e) => events.push(e))
    const connecting = (adapter as any).connectWebSocket() as Promise<void>
    const ws = fake.created[0]
    ws.open()
    ws.receive({ op: 'auth', success: true })
    await connecting
    ws.receive({
      topic: 'order',
      creationTime: 1,
      data: [
        { category: 'linear', orderId: 'o-1', orderLinkId: 'lnk', symbol: 'SOLUSDT', side: 'Sell', orderStatus: 'Filled', cumExecQty: '0.1', avgPrice: '151.2', stopOrderType: 'Stop' },
        { category: 'linear', orderId: 'o-2', symbol: 'SOLUSDT', side: 'Buy', orderStatus: 'Cancelled' },
        { category: 'linear', orderId: 'o-3', symbol: 'SOLUSDT', side: 'Buy', orderStatus: 'Untriggered' },
      ],
    })
    ws.receive({
      topic: 'execution',
      data: [{ execId: 'e-1', orderId: 'o-1', symbol: 'SOLUSDT', side: 'Sell', execPrice: '151.2', execQty: '0.1', execFee: '0.0083', execType: 'Trade', execTime: '1700000000000' }],
    })
    ws.receive({ topic: 'position', data: [{ symbol: 'SOLUSDT', size: '0' }] })
    ws.receive({ topic: 'wallet', data: [{ coin: [] }] })

    const order = events.find((e) => e.type === 'order')
    expect(order.data.map((r: any) => [r.orderId, r.state])).toEqual([
      ['o-1', 'filled'],
      ['o-2', 'cancelled'],
      ['o-3', 'working'],
    ])
    expect(order.data[0]).toMatchObject({ orderLinkId: 'lnk', symbol: 'SOLUSDT', side: 'sell', filledQuantity: 0.1, averagePrice: 151.2, orderStatus: 'Filled' })
    const exec = events.find((e) => e.type === 'execution')
    expect(exec.data[0]).toMatchObject({ execId: 'e-1', orderId: 'o-1', price: 151.2, qty: 0.1, fee: 0.0083, execType: 'Trade', timeMs: 1700000000000 })
    expect(events.some((e) => e.type === 'position')).toBe(true)
    expect(events.some((e) => e.type === 'balance')).toBe(true)
    await adapter.disconnect()
  })

  it('pong watchdog: a private pong refreshes lastPongAt; a silent socket is terminated', async () => {
    const adapter = authedAdapter()
    const connecting = (adapter as any).connectWebSocket() as Promise<void>
    const ws = fake.created[0]
    ws.open()
    ws.receive({ op: 'auth', success: true })
    await connecting
    const t0 = (adapter as any).lastPongAt
    await new Promise((r) => setTimeout(r, 5))
    ws.receive({ op: 'ping', ret_msg: 'pong', success: true, conn_id: 'x' })
    expect((adapter as any).lastPongAt).toBeGreaterThan(t0)

    // Simulate a stale pong and run one ping tick by hand.
    ;(adapter as any).lastPongAt = Date.now() - 10 * 60 * 1000
    ;(adapter as any).stopPingInterval()
    ;(adapter as any).startPingInterval()
    const timer = (adapter as any).pingInterval as NodeJS.Timeout
    ;(timer as any)._onTimeout()
    expect(ws.terminated).toBe(1)
    // The close from terminate() scheduled a reconnect.
    expect((adapter as any).reconnectTimeout).toBeDefined()
    await adapter.disconnect()
  })

  it('replacing the socket terminates the old one and never leaves two ping intervals', async () => {
    const adapter = authedAdapter()
    const c1 = (adapter as any).connectWebSocket() as Promise<void>
    fake.created[0].open()
    fake.created[0].receive({ op: 'auth', success: true })
    await c1
    const firstInterval = (adapter as any).pingInterval

    const c2 = (adapter as any).connectWebSocket() as Promise<void>
    expect(fake.created[0].terminated).toBe(1)
    // The detached socket's late events reach nobody (no reconnect scheduled by it).
    expect(fake.created[0].listenerCount('close')).toBe(0)
    expect((adapter as any).reconnectTimeout).toBeUndefined()
    fake.created[1].open()
    fake.created[1].receive({ op: 'auth', success: true })
    await c2
    expect((adapter as any).pingInterval).not.toBe(firstInterval)
    await adapter.disconnect()
  })

  it('reconnect backs off exponentially, resets after a successful auth, stops after disconnect()', async () => {
    const adapter = authedAdapter()
    const delays: number[] = []
    for (let i = 0; i < 8; i++) {
      delays.push(adapter.wsReconnectDelayMs())
      ;(adapter as any).scheduleReconnect()
      clearTimeout((adapter as any).reconnectTimeout)
      ;(adapter as any).reconnectTimeout = undefined
    }
    expect(delays).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000])

    const connecting = (adapter as any).connectWebSocket() as Promise<void>
    fake.created[0].open()
    fake.created[0].receive({ op: 'auth', success: true })
    await connecting
    expect(adapter.wsReconnectDelayMs()).toBe(5_000)

    await adapter.disconnect()
    ;(adapter as any).scheduleReconnect()
    expect((adapter as any).reconnectTimeout).toBeUndefined()
  })
})

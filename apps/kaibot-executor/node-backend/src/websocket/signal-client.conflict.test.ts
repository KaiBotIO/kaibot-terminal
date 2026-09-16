import { describe, expect, it, afterEach } from 'bun:test'
import { WebSocketServer } from 'ws'
import { createServer, type Server } from 'node:http'
import { SignalWebSocketClient } from './signal-client.js'

// Regression: the signal hub allows exactly one LIVE executor socket per
// account (apps/api/src/lib/signal-wire.ts) and closes any later one with
// close code 4409 right after the handshake. Before this fix the client
// treated that close like any other transient disconnect: a generic
// "reconnecting" notification and the normal fast-starting backoff, which
// would just get rejected again immediately for as long as the other
// executor stayed connected.
//
// Second regression, found in review: the hub's own Hibernation API can keep
// an executor's OWN dead socket registered for up to CLIENT_TIMEOUT_MS after
// it silently vanished (network blip, sleep, container restart), so a single
// 4409 can be OUR OWN reconnect racing that cleanup, not a real second
// machine. Only two consecutive 4409s within a short window are treated as a
// confirmed standing conflict; a lone one is retried like any other close.

class FakeDb {
  logs: Array<{ level: string; message: string; meta?: unknown }> = []
  log(level: string, _category: string, message: string, meta?: unknown) {
    this.logs.push({ level, message, meta })
  }
  recordSignal() {}
  recordSignalQueue() {}
  updateSignalStatus() {}
}

class FakeNotifications {
  published: Array<{ type: string; title: string; body: string; data?: unknown }> = []
  publish(event: { type: string; title: string; body: string; data?: unknown }) {
    this.published.push(event)
  }
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as any).port)
    })
  })
}

describe('signal WS executor-conflict close (4409)', () => {
  let httpServer: Server | null = null
  let wss: WebSocketServer | null = null
  let client: SignalWebSocketClient | null = null

  afterEach(async () => {
    client?.disconnect()
    client = null
    // Terminate any still-open server-side sockets first — Node's
    // http.Server.close() waits for existing connections to end, and some
    // tests deliberately leave a later connection open.
    if (wss) {
      for (const ws of wss.clients) ws.terminate()
      wss.close()
      wss = null
    }
    if (httpServer) {
      httpServer.closeAllConnections?.()
      await new Promise<void>((r) => httpServer!.close(() => r()))
    }
    httpServer = null
  })

  it('does not alarm on a single 4409 — retries promptly, no conflict status or notification', async () => {
    httpServer = createServer()
    wss = new WebSocketServer({ server: httpServer })
    let connections = 0
    wss.on('connection', (socket) => {
      connections++
      if (connections === 1) {
        socket.close(4409, 'another executor is already connected for this account')
      }
      // second connection: a normal successful reconnect, stay open.
    })
    const port = await listen(httpServer)

    const db = new FakeDb()
    const notifications = new FakeNotifications()
    client = new SignalWebSocketClient(db as any, null, notifications as any)
    client.connect(`http://127.0.0.1:${port}`, 'test-key')

    // Normal (non-extended) backoff after one 4409: ~1s to the second dial.
    await new Promise((r) => setTimeout(r, 1500))

    expect(connections).toBe(2)
    expect(client.getConnectionStatus()).toBe('connected')
    expect(notifications.published.some((n) => n.type === 'executor_conflict')).toBe(false)
    expect(notifications.published.some((n) => n.type === 'connection_lost')).toBe(true)
  })

  it('confirms a standing conflict after two consecutive 4409s and backs off harder', async () => {
    httpServer = createServer()
    wss = new WebSocketServer({ server: httpServer })
    let connections = 0
    wss.on('connection', (socket) => {
      connections++
      socket.close(4409, 'another executor is already connected for this account')
    })
    const port = await listen(httpServer)

    const db = new FakeDb()
    const notifications = new FakeNotifications()
    client = new SignalWebSocketClient(db as any, null, notifications as any)
    client.connect(`http://127.0.0.1:${port}`, 'test-key')

    // First 4409 (~t=0, transient) → normal backoff redials at ~1s → second
    // 4409 confirms the conflict. Give it enough time for both.
    await new Promise((r) => setTimeout(r, 1800))

    expect(connections).toBe(2)
    expect(client.getConnectionStatus()).toBe('conflict')
    expect(
      notifications.published.some(
        (n) => n.type === 'executor_conflict' && n.title === 'Another executor is connected',
      ),
    ).toBe(true)

    // Extended backoff now: confirm no third dial shows up well past where a
    // normal (fast) backoff would have redialed again.
    await new Promise((r) => setTimeout(r, 1500))
    expect(connections).toBe(2)
  })

  it('clears the conflict status once a later connection succeeds', async () => {
    httpServer = createServer()
    wss = new WebSocketServer({ server: httpServer })
    let connections = 0
    wss.on('connection', (socket) => {
      connections++
      if (connections <= 2) {
        socket.close(4409, 'another executor is already connected for this account')
      }
      // third connection: stay open, no-op.
    })
    const port = await listen(httpServer)

    const db = new FakeDb()
    const notifications = new FakeNotifications()
    client = new SignalWebSocketClient(db as any, null, notifications as any)
    client.connect(`http://127.0.0.1:${port}`, 'test-key')

    await new Promise((r) => setTimeout(r, 1800))
    expect(connections).toBe(2)
    expect(client.getConnectionStatus()).toBe('conflict')

    // Force the pending (extended) backoff timer to fire now instead of
    // waiting out the real multi-second delay.
    const c: any = client
    if (c.reconnectInterval) clearTimeout(c.reconnectInterval)
    c.reconnectInterval = null
    c.connect(`http://127.0.0.1:${port}`, 'test-key')

    await new Promise((r) => setTimeout(r, 200))
    expect(client.getConnectionStatus()).toBe('connected')
    expect(connections).toBe(3)
  })
})

import { describe, expect, it, afterEach } from 'bun:test'
import { WebSocketServer } from 'ws'
import { createServer, type Server } from 'node:http'
import { SignalWebSocketClient } from './signal-client.js'

// EX8 regression: the client must detect a zombie socket (no inbound traffic —
// asymmetric network failure where the TCP session looks alive but nothing
// arrives) and force a reconnect through the existing backoff path. The old
// client only reacted to close/error events, so a silent server left it
// "connected" forever while receiving no signals.

class FakeDb {
  logs: Array<{ level: string; message: string }> = []
  log(level: string, _category: string, message: string) {
    this.logs.push({ level, message })
  }
  recordSignal() {}
  recordSignalQueue() {}
  updateSignalStatus() {}
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as any).port)
    })
  })
}

describe('signal WS staleness watchdog (EX8)', () => {
  let httpServer: Server | null = null
  let client: SignalWebSocketClient | null = null

  afterEach(async () => {
    client?.disconnect()
    client = null
    await new Promise<void>((r) => (httpServer ? httpServer.close(() => r()) : r()))
    httpServer = null
  })

  it('force-reconnects when no inbound message arrives within the window', async () => {
    httpServer = createServer()
    const wss = new WebSocketServer({ server: httpServer })
    let connections = 0
    wss.on('connection', () => {
      connections++
      // Server goes completely silent: no ping, no messages.
    })
    const port = await listen(httpServer)

    const db = new FakeDb()
    client = new SignalWebSocketClient(db as any, null, null)
    client.setStalenessTimeoutMs(150)
    client.connect(`http://127.0.0.1:${port}`, 'test-key')

    // First connection, then the watchdog trips and the reconnect path dials
    // again (backoff starts at ~1s).
    await new Promise((r) => setTimeout(r, 1600))

    expect(connections).toBeGreaterThanOrEqual(2)
    expect(db.logs.some((l) => l.message.includes('No inbound WS traffic'))).toBe(true)
  })

  // 2026-09-06 skaibox blip: the watchdog's terminate() never produced a
  // 'close' on a hung socket, so the client sat in 'closing' forever with no
  // reconnect ever logged. A forced reconnect must not wait for that event.
  it('REGRESSION: reconnects even when the old socket is stuck CLOSING', async () => {
    httpServer = createServer()
    const wss = new WebSocketServer({ server: httpServer })
    let connections = 0
    wss.on('connection', (socket) => {
      connections++
      // The first socket goes silent (watchdog trips); later ones stay chatty
      // so the reconnected client settles as 'connected'.
      if (connections >= 2) {
        const keepalive = setInterval(() => {
          try { socket.send(JSON.stringify({ type: 'ping' })) } catch { /* closing */ }
        }, 40)
        socket.on('close', () => clearInterval(keepalive))
      }
    })
    const port = await listen(httpServer)

    const db = new FakeDb()
    client = new SignalWebSocketClient(db as any, null, null)
    client.setStalenessTimeoutMs(150)
    client.connect(`http://127.0.0.1:${port}`, 'test-key')
    await new Promise((r) => setTimeout(r, 100))

    // Simulate the hung socket: terminate() does nothing and the state stays
    // CLOSING, no 'close' event ever fires.
    const stuck = (client as any).ws
    const realTerminate = stuck.terminate.bind(stuck)
    stuck.terminate = () => {
      Object.defineProperty(stuck, 'readyState', { value: 2 /* CLOSING */, configurable: true })
    }
    stuck.close = stuck.terminate

    await new Promise((r) => setTimeout(r, 400)) // watchdog trips
    expect(client.getConnectionStatus()).toBe('reconnecting')
    expect(client.getReconnectInfo().reconnectingSince).not.toBeNull()

    await new Promise((r) => setTimeout(r, 1400)) // backoff (~1s) → new dial
    expect(connections).toBeGreaterThanOrEqual(2)
    expect(client.getConnectionStatus()).toBe('connected')
    expect(client.getReconnectInfo().reconnectingSince).toBeNull()
    expect(db.logs.some((l) => l.message === 'Forcing signal WS reconnect')).toBe(true)
    // Let the hung TCP connection actually die so the server can close.
    realTerminate()
  })

  it('gives up on a handshake that never completes and dials again', async () => {
    // Server accepts TCP but never upgrades: the client would sit 'connecting'.
    httpServer = createServer((_req, res) => {
      /* hold the request open, no upgrade, no response */
      void res
    })
    httpServer.on('upgrade', () => {
      /* swallow: never complete the handshake */
    })
    const port = await listen(httpServer)

    const db = new FakeDb()
    client = new SignalWebSocketClient(db as any, null, null)
    client.setConnectTimeoutMs(200)
    client.connect(`http://127.0.0.1:${port}`, 'test-key')

    await new Promise((r) => setTimeout(r, 500))
    expect(client.getConnectionStatus()).toBe('reconnecting')
    expect(db.logs.filter((l) => l.message === 'Forcing signal WS reconnect').length).toBeGreaterThanOrEqual(1)
  })

  it('stays connected while the server keeps talking', async () => {
    httpServer = createServer()
    const wss = new WebSocketServer({ server: httpServer })
    let connections = 0
    const pingers: Array<ReturnType<typeof setInterval>> = []
    wss.on('connection', (ws) => {
      connections++
      const t = setInterval(() => ws.send(JSON.stringify({ type: 'ping' })), 40)
      pingers.push(t)
      ws.on('close', () => clearInterval(t))
    })
    const port = await listen(httpServer)

    const db = new FakeDb()
    client = new SignalWebSocketClient(db as any, null, null)
    client.setStalenessTimeoutMs(150)
    client.connect(`http://127.0.0.1:${port}`, 'test-key')

    await new Promise((r) => setTimeout(r, 600))

    expect(connections).toBe(1)
    expect(client.isConnected()).toBe(true)
    for (const t of pingers) clearInterval(t)
  })
})

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

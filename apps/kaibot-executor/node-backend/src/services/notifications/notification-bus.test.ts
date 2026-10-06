import { afterEach, describe, expect, it } from 'bun:test'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { connect as netConnect } from 'node:net'
import { randomBytes } from 'node:crypto'
import { NotificationBus } from './notification-bus.js'

// #22 regression: the notification WebSocket upgrade had NO auth at all — in
// web/Docker mode anyone who could reach the port streamed live trading
// activity. The attach() authorize gate must refuse the upgrade (401) exactly
// like the REST auth layer refuses an unauthenticated request.
//
// The handshake is driven with a raw TCP socket (bun's ws client shim does not
// surface 'unexpected-response', so the status line is asserted directly).

let server: Server | null = null
let bus: NotificationBus | null = null

afterEach(() => {
  bus?.close()
  bus = null
  if (server) {
    // Under bun a gracefully-closed ws connection can keep server.close()'s
    // callback from ever firing — force-drop connections and don't block the
    // suite on the close callback (each test opens its own server/port).
    ;(server as any).closeAllConnections?.()
    server.close()
    server = null
  }
})

async function listen(): Promise<number> {
  server = createServer((_req, res) => res.end('ok'))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  return addr.port
}

// Send a bare WebSocket upgrade request. 'accepted' = the server completed the
// handshake (101); 'refused' = it did not (401 status line on node, or a bare
// connection close under bun, whose node:http shim drops raw writes to the
// upgrade socket — either way no websocket is established).
function tryUpgrade(port: number, path: string): Promise<'accepted' | 'refused'> {
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (v: 'accepted' | 'refused') => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock.destroy()
      resolve(v)
    }
    const sock = netConnect(port, '127.0.0.1', () => {
      sock.write(
        `GET ${path} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          'Connection: Upgrade\r\n' +
          'Upgrade: websocket\r\n' +
          'Sec-WebSocket-Version: 13\r\n' +
          `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n` +
          '\r\n',
      )
    })
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        sock.destroy()
        reject(new Error('no upgrade outcome'))
      }
    }, 3000)
    sock.on('data', (buf) => {
      done(buf.toString().startsWith('HTTP/1.1 101') ? 'accepted' : 'refused')
    })
    sock.on('close', () => done('refused'))
    sock.on('error', () => done('refused'))
  })
}

describe('NotificationBus upgrade auth (#22)', () => {
  it('refuses the upgrade with 401 when authorize returns false', async () => {
    const port = await listen()
    bus = new NotificationBus()
    bus.attach(server!, { authorize: () => false })

    const outcome = await tryUpgrade(port, '/api/ws/notifications')
    expect(outcome).toBe('refused')
    expect(bus.clientCount()).toBe(0)
  })

  it('accepts the upgrade when authorize passes (token in query) and refuses a bad token', async () => {
    const port = await listen()
    bus = new NotificationBus()
    bus.attach(server!, {
      authorize: (req) =>
        new URL(req.url ?? '/', 'http://localhost').searchParams.get('token') === 'secret',
    })

    expect(await tryUpgrade(port, '/api/ws/notifications?token=secret')).toBe('accepted')
    expect(await tryUpgrade(port, '/api/ws/notifications?token=wrong')).toBe('refused')
  })

  it('stays open (no gate) when no authorize is configured — desktop loopback mode', async () => {
    const port = await listen()
    bus = new NotificationBus()
    bus.attach(server!)

    expect(await tryUpgrade(port, '/api/ws/notifications')).toBe('accepted')
  })

  it('back-compat: a bare string second arg is still the path', async () => {
    const port = await listen()
    bus = new NotificationBus()
    bus.attach(server!, '/custom/ws')

    expect(await tryUpgrade(port, '/custom/ws')).toBe('accepted')
  })
})

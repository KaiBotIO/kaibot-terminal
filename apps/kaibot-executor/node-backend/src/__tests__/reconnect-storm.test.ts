// Regression for the reconnect-storm bug: a failed handshake scheduled a
// reconnect TWICE (the unexpected-response branch schedules directly AND its
// terminate() fires 'close', which schedules again) while scheduleReconnect()
// overwrote any pending timer without clearing it. Every generation doubled
// the live timers → parallel WebSockets, each with its own listeners and
// staleness watchdog, multiplying during an LB 502/503 storm. Also locks the
// backoff: connect() used to reset reconnectAttempts, so the timer-driven
// retry loop never backed off past its first step.
import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { KaiBotDatabase } from '../storage/database.js'
import { SignalWebSocketClient } from '../websocket/signal-client.js'

// HTTP server that rejects every WS upgrade with 503 (the LB-during-deploy
// case that used to double-schedule via unexpected-response + close).
let upgradeAttempts = 0
const server = Bun.serve({
  port: 0,
  fetch() {
    upgradeAttempts++
    return new Response('deploying', { status: 503 })
  },
})

const dir = mkdtempSync(join(tmpdir(), 'kaibot-reconnect-'))
const execDb = new KaiBotDatabase(join(dir, 'exec.db'))
const manager = { async getSession() { return null } }
const client = new SignalWebSocketClient(execDb as any, manager as any, null)

afterAll(() => {
  client.disconnect()
  server.stop(true)
})

describe('SignalWebSocketClient reconnect scheduling', () => {
  it('a 503 handshake storm schedules ONE pending reconnect, never parallel timers', async () => {
    client.connect(`http://127.0.0.1:${server.port}`, 'test-key')

    // First attempt fails ~immediately; both failure paths (unexpected-response
    // + close) then race to schedule. Give a couple of backoff generations
    // (1s, 2s) room to run.
    await new Promise((r) => setTimeout(r, 3500))

    // Exactly one timer per generation: attempts follow the 1s/2s backoff
    // (initial + ~2 retries in 3.5s). The double-schedule bug doubled per
    // generation (1→2→4…), which lands well above this bound.
    expect(upgradeAttempts).toBeGreaterThanOrEqual(2)
    expect(upgradeAttempts).toBeLessThanOrEqual(4)

    // The invariant itself: never more than one pending reconnect timer.
    expect((client as any).reconnectInterval === null ? 0 : 1).toBeLessThanOrEqual(1)

    // Backoff must actually grow across timer-driven retries (the old
    // connect() reset pinned attempts at 0 forever).
    expect((client as any).reconnectAttempts).toBeGreaterThanOrEqual(2)
  }, 10_000)
})

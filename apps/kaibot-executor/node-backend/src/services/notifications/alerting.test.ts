import { describe, expect, it } from 'bun:test'
import { AlertingService } from './alerting.js'
import { NotificationBus } from './notification-bus.js'
import type { WebhookResult } from './webhook-sender.js'

const fakeDb = () => ({ log() {} }) as any

// A capturing webhook stub matching the sendWebhook signature.
function captureSend() {
  const sent: string[] = []
  const fn = (async (_url: string, text: string): Promise<WebhookResult> => {
    sent.push(text)
    return { ok: true, attempts: 1 }
  }) as any
  return { fn, sent }
}

describe('AlertingService', () => {
  it('is inactive without a webhook URL', () => {
    const svc = new AlertingService({
      db: fakeDb(),
      bus: new NotificationBus(),
      isSignalServiceConnected: () => true,
      getConfig: () => ({}),
    })
    expect(svc.isActive()).toBe(false)
  })

  it('forwards alertable events (order_rejected, error) to the webhook', async () => {
    const bus = new NotificationBus()
    const cap = captureSend()
    const svc = new AlertingService({
      db: fakeDb(),
      bus,
      isSignalServiceConnected: () => true,
      getConfig: () => ({ webhookUrl: 'http://hook', enabled: true }),
      sendImpl: cap.fn,
    })
    svc.start()
    bus.publish({ type: 'order_rejected', title: 'Order rejected', body: '✗ MES: nope' })
    bus.publish({ type: 'error', title: 'Settlement timeout', body: 'timed out' })
    // give the fire-and-forget sends a tick
    await new Promise((r) => setTimeout(r, 5))
    svc.stop()
    expect(cap.sent.length).toBe(2)
    expect(cap.sent[0]).toContain('Order rejected')
    expect(cap.sent[1]).toContain('Settlement timeout')
  })

  it('does not forward routine fills/connection events', async () => {
    const bus = new NotificationBus()
    const cap = captureSend()
    const svc = new AlertingService({
      db: fakeDb(),
      bus,
      isSignalServiceConnected: () => true,
      getConfig: () => ({ webhookUrl: 'http://hook', enabled: true }),
      sendImpl: cap.fn,
    })
    svc.start()
    bus.publish({ type: 'order_filled', title: 'Order filled', body: 'ok' })
    bus.publish({ type: 'connection_restored', title: 'Back', body: 'ok' })
    await new Promise((r) => setTimeout(r, 5))
    svc.stop()
    expect(cap.sent.length).toBe(0)
  })

  it('alerts on signal-service down and once on recovery', async () => {
    let connected = true
    const cap = captureSend()
    const svc = new AlertingService({
      db: fakeDb(),
      bus: new NotificationBus(),
      isSignalServiceConnected: () => connected,
      getConfig: () => ({ webhookUrl: 'http://hook', enabled: true }),
      sendImpl: cap.fn,
    })

    // first healthy tick: no alert
    await svc.healthTick()
    expect(cap.sent.length).toBe(0)

    // goes down: one down alert
    connected = false
    await svc.healthTick()
    expect(cap.sent.length).toBe(1)
    expect(cap.sent[0]).toContain('down')

    // still down within the re-alert window: no duplicate
    await svc.healthTick()
    expect(cap.sent.length).toBe(1)

    // recovers: one recovery alert
    connected = true
    await svc.healthTick()
    expect(cap.sent.length).toBe(2)
    expect(cap.sent[1]).toContain('back')
  })
})

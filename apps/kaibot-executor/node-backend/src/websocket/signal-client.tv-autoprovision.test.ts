import { describe, expect, it } from 'bun:test'
import { SignalWebSocketClient } from './signal-client.js'
import type { Signal } from '../storage/types.js'

// A TradingView-webhook source rides its own bot but keeps metadata.source =
// 'discretionary', so the executor auto-provisions a LOCAL subscription on the
// first signal. That subscription must show the SOURCE name (metadata.botName),
// not the generic "Discretionary" label. exchangeManager is null so the signal
// rejects right AFTER auto-provisioning — we only assert the upsert.

class FakeDb {
  upserts: any[] = []
  private sub: any = null
  logs: any[] = []
  statuses: any[] = []
  log(...a: any[]) { this.logs.push(a) }
  recordSignal() {}
  recordSignalQueue() {}
  getSubscriptionForBot() { return this.sub }
  getSubscription() { return this.sub }
  upsertSubscription(row: any) {
    this.upserts.push(row)
    this.sub = { id: row.id, status: row.status, factor: row.factor, botName: row.botName }
  }
  updateSignalStatus(id: string, status: string, _t?: number, error?: string) {
    this.statuses.push({ id, status, error })
  }
  updateSignalOrderIds() {}
  getSignalExecution() { return undefined }
  insertSignalExecution() { return true }
  updateSignalExecution() {}
  getOpenEntrySignals() { return [] }
}

function tvSignal(over: Partial<Signal> = {}): Signal {
  return {
    id: 'sig-tv-1',
    strategy_id: 'discretionary',
    strategy_name: 'My BTC Alert',
    symbol: 'BTCUSDT',
    action: 'buy',
    quantity: 1,
    metadata: { signalBotId: 'tvb_abc', source: 'discretionary', botName: 'My BTC Alert', kind: 'tv_webhook' },
    received_at: new Date(),
    status: 'pending',
    created_at: new Date(),
    ...over,
  } as Signal
}

describe('TradingView source auto-provision', () => {
  it('auto-provisions the local subscription with the source name from metadata.botName', async () => {
    const db = new FakeDb()
    const client = new SignalWebSocketClient(db as any, null as any, null)

    await (client as any).handleSignalInner(tvSignal())

    expect(db.upserts).toHaveLength(1)
    expect(db.upserts[0]).toMatchObject({
      signalBotId: 'tvb_abc',
      botName: 'My BTC Alert',
      factor: 1,
      status: 'active',
    })
  })

  it('falls back to "Discretionary" when metadata.botName is absent (built-in bot)', async () => {
    const db = new FakeDb()
    const client = new SignalWebSocketClient(db as any, null as any, null)

    await (client as any).handleSignalInner(
      tvSignal({ metadata: { signalBotId: 'disc_u1', source: 'discretionary' } }),
    )

    expect(db.upserts).toHaveLength(1)
    expect(db.upserts[0].botName).toBe('Discretionary')
  })
})

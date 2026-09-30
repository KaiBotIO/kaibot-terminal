import { describe, expect, it } from 'bun:test'
import { SignalWebSocketClient } from './signal-client.js'
import type { Signal } from '../storage/types.js'

// F3 guard rail: after take-over (detachBot pauses the bot config) the bot may
// NEVER touch that position again. The subscription gate doesn't cover this —
// detach pauses the CONFIG, not the subscription — so handleSignalInner must
// drop every signal (entry, add AND close) from a bot whose configs for the
// symbol are all non-running.

class FakeDb {
  logs: any[] = []
  statuses: Array<{ id: string; status: string; error?: string }> = []
  queued: any[] = []
  private configs: any[]
  constructor(configs: any[] = []) {
    this.configs = configs
  }
  log(...a: any[]) { this.logs.push(a) }
  recordSignal() {}
  recordSignalQueue(row: any) { this.queued.push(row) }
  getBotConfigs(_onlyRunning = true) { return this.configs }
  getSubscriptionForBot() {
    return { id: 'sub-1', signalBotId: 'bot1', status: 'active', factor: 1 }
  }
  getSubscription() { return { id: 'sub-1', status: 'active' } }
  updateSignalStatus(id: string, status: string, _t?: number, error?: string) {
    this.statuses.push({ id, status, error })
  }
  updateSignalOrderIds() {}
  getSignalExecution() { return undefined }
  insertSignalExecution() { return true }
  updateSignalExecution() {}
  getOpenEntrySignals() { return [] }
}

const cfg = (status: 'running' | 'paused' | 'stopped') => ({
  id: 'bot1:deribit:BTC-PERPETUAL:1h',
  signalBotId: 'bot1',
  strategyId: 'strat1',
  exchange: 'deribit',
  symbol: 'BTC-PERPETUAL',
  timeframe: '1h',
  status,
})

const botSignal = (over: Partial<Signal> = {}): Signal =>
  ({
    id: 'sig-1',
    strategy_id: 'strat1',
    symbol: 'BTC-PERPETUAL',
    action: 'buy',
    quantity: 1,
    metadata: { signalBotId: 'bot1' },
    received_at: new Date(),
    status: 'pending',
    created_at: new Date(),
    ...over,
  }) as Signal

describe('signal path — detached-bot gate (take-over guard rail)', () => {
  it('drops an entry signal from a detached (paused) bot config', async () => {
    const db = new FakeDb([cfg('paused')])
    const client = new SignalWebSocketClient(db as any, null, null)
    await (client as any).handleSignalInner(botSignal())
    expect(db.statuses).toEqual([
      { id: 'sig-1', status: 'rejected', error: 'bot detached (take-over)' },
    ])
    expect(db.queued[0]).toMatchObject({ signalId: 'sig-1', reason: 'bot_detached' })
  })

  it('drops a CLOSE signal too — the bot may not exit the taken-over position', async () => {
    const db = new FakeDb([cfg('paused')])
    const client = new SignalWebSocketClient(db as any, null, null)
    await (client as any).handleSignalInner(botSignal({ id: 'sig-close', action: 'close' }))
    expect(db.statuses).toEqual([
      { id: 'sig-close', status: 'rejected', error: 'bot detached (take-over)' },
    ])
  })

  it('drops signals from a STOPPED bot config as well', async () => {
    const db = new FakeDb([cfg('stopped')])
    const client = new SignalWebSocketClient(db as any, null, null)
    await (client as any).handleSignalInner(botSignal())
    expect(db.statuses[0].error).toBe('bot detached (take-over)')
  })

  it('passes signals through while the config runs (rejected later for another reason)', async () => {
    const db = new FakeDb([cfg('running')])
    const client = new SignalWebSocketClient(db as any, null, null)
    await (client as any).handleSignalInner(botSignal())
    // No exchange manager in this harness → the signal proceeds past the gate
    // and fails there, NOT on the detach gate.
    expect(db.statuses).toHaveLength(1)
    expect(db.statuses[0].error).not.toBe('bot detached (take-over)')
  })

  it('a bot without local configs is untouched by the gate', async () => {
    const db = new FakeDb([])
    const client = new SignalWebSocketClient(db as any, null, null)
    await (client as any).handleSignalInner(botSignal())
    expect(db.statuses[0]?.error).not.toBe('bot detached (take-over)')
  })
})

import { describe, expect, it } from 'bun:test'
import { SignalWebSocketClient } from './signal-client.js'
import type { Signal } from '../storage/types.js'

// Ride-bot phase 2: while the server phases a bot out, an in-flight / replayed
// ENTRY is clipped on the edge with a visible reason; closes and adds inside a
// position still pass the gate.

class FakeDb {
  logs: any[] = []
  statuses: Array<{ id: string; status: string; error?: string }> = []
  queued: any[] = []
  constructor(private configs: any[] = []) {}
  log(...a: any[]) { this.logs.push(a) }
  recordSignal() {}
  recordSignalQueue(row: any) { this.queued.push(row) }
  getBotConfigs(_onlyRunning = true) { return this.configs }
  getSubscriptionForBot() { return { id: 'sub-1', signalBotId: 'bot1', status: 'active', factor: 1 } }
  getSubscription() { return { id: 'sub-1', status: 'active' } }
  updateSignalStatus(id: string, status: string, _t?: number, error?: string) { this.statuses.push({ id, status, error }) }
  updateSignalOrderIds() {}
  getSignalExecution() { return undefined }
  insertSignalExecution() { return true }
  updateSignalExecution() {}
  getOpenEntrySignals() { return [] }
}

const cfg = (status: string) => ({
  id: 'bot1:tradestation:MNQ:1h', signalBotId: 'bot1', strategyId: 'strat1',
  exchange: 'tradestation', symbol: 'MNQ', timeframe: '1h', status,
})
const sig = (over: Partial<Signal> = {}): Signal =>
  ({ id: 'sig-1', strategy_id: 'strat1', symbol: 'MNQ', action: 'buy', quantity: 1,
     metadata: { signalBotId: 'bot1' }, received_at: new Date(), status: 'pending', created_at: new Date(), ...over }) as Signal

describe('signal path — phase-out entry clip', () => {
  it('clips a fresh entry with reason bot_phasing_out', async () => {
    const db = new FakeDb([cfg('phasing_out')])
    const client = new SignalWebSocketClient(db as any, null, null)
    await (client as any).handleSignalInner(sig())
    expect(db.statuses).toEqual([{ id: 'sig-1', status: 'rejected', error: 'bot phasing out (no new entries)' }])
    expect(db.queued[0]).toMatchObject({ signalId: 'sig-1', reason: 'bot_phasing_out' })
  })

  it('lets a close and an add inside a position through the gate', async () => {
    for (const over of [{ id: 'c', action: 'close' as const }, { id: 'a', metadata: { signalBotId: 'bot1', add: true, positionId: 'p1' } }]) {
      const db = new FakeDb([cfg('phasing_out')])
      const client = new SignalWebSocketClient(db as any, null, null)
      await (client as any).handleSignalInner(sig(over))
      expect(db.queued.find((q) => q.reason === 'bot_phasing_out')).toBeUndefined()
      expect(db.statuses.find((s) => s.error === 'bot phasing out (no new entries)')).toBeUndefined()
    }
  })

  it('does not clip while the config runs', async () => {
    const db = new FakeDb([cfg('running')])
    const client = new SignalWebSocketClient(db as any, null, null)
    await (client as any).handleSignalInner(sig())
    expect(db.queued.find((q) => q.reason === 'bot_phasing_out')).toBeUndefined()
  })
})

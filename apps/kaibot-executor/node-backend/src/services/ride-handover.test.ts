// Ride hand-over (edge side): the local lineage a hand-over writes so the
// server's R1 close finds it, the stop requirement, idempotency, take-back
// and the local-close → server hook. Fake adapter + temp DB, fake server.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { KaiBotDatabase } from '../storage/database.js'
import {
  accountRefFor,
  canonicalSymbolFor,
  createRideHandoverService,
  handoverSignalId,
} from './ride-handover.js'
import { positionTrailKey } from './position-trail.js'

let dir: string
let db: KaiBotDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-ride-handover-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const POS = {
  id: 'p1',
  accountId: 'SIM123',
  symbol: 'MNQZ26',
  side: 'long' as const,
  size: 2,
  entryPrice: 20000,
  markPrice: 20050,
}

function fakeManager(positions: any[], placed: any[] = [], cancelled: string[] = []) {
  const adapter = {
    getPositions: async () => positions,
    getAccounts: async () => [{ id: 'tradestation:SIM123', accountId: 'SIM123' }],
    placeOrder: async (o: any) => {
      placed.push(o)
      return { orderId: `ord-${placed.length}`, status: 'pending' }
    },
    cancelOrder: async (id: string) => {
      cancelled.push(id)
    },
  }
  return { getSession: async () => ({ status: 'connected', adapter }) } as any
}

function fakeServer(calls: Array<{ path: string; body: any }>, responder?: (path: string, body: any) => any) {
  return async (path: string, body: unknown) => {
    calls.push({ path, body })
    if (responder) return responder(path, body)
    if (path === '/api/ride/handover') {
      return {
        ok: true,
        status: 200,
        body: { success: true, positionId: 'srv-pos-1', runId: 'run-1', timeframe: '1h', subscriptionId: null, plan: 'create' },
      }
    }
    if (path === '/api/ride/takeback') return { ok: true, status: 200, body: { success: true, released: true } }
    if (path === '/api/ride/preview') return { ok: true, status: 200, body: { level: 2, barsReplayed: 12, exit: null } }
    return { ok: false, status: 404, body: { error: 'nope' } }
  }
}

describe('ride hand-over helpers', () => {
  it('derives an opaque account ref and the canonical market symbol', () => {
    expect(accountRefFor('tradestation', 'SIM123')).toHaveLength(16)
    expect(accountRefFor('tradestation', 'SIM123')).not.toContain('SIM123')
    expect(accountRefFor('tradestation', 'SIM123')).not.toBe(accountRefFor('tradestation', 'SIM124'))
    expect(canonicalSymbolFor('tradestation', 'MNQZ26')).toBe('MNQ')
    expect(canonicalSymbolFor('deribit', 'BTC-PERPETUAL')).toBe('BTC-PERPETUAL')
  })
})

describe('handover', () => {
  it('refuses without a stop and with a stop on the wrong side', async () => {
    const calls: any[] = []
    const svc = createRideHandoverService(db, fakeManager([POS]), { postToServer: fakeServer(calls) })
    db.addManualPosition('tradestation', 'SIM123', 'MNQZ26', 'buy', 2)
    await expect(svc.handover({ exchange: 'tradestation', symbol: 'MNQZ26', botId: 'bot-a' })).rejects.toThrow(
      /resting stop is required/,
    )
    await expect(
      svc.handover({ exchange: 'tradestation', symbol: 'MNQZ26', botId: 'bot-a', stopPrice: 20100 }),
    ).rejects.toThrow(/losing side/)
    expect(calls).toHaveLength(0)
  })

  it('places the stop, arms the server and writes the local lineage the R1 close needs', async () => {
    const calls: any[] = []
    const placed: any[] = []
    const svc = createRideHandoverService(db, fakeManager([POS], placed), {
      postToServer: fakeServer(calls),
      registerBracket: (exchange, signalId, slOrderId) =>
        db.upsertBracketPair({ signalId, exchange, slOrderId: slOrderId ?? null }),
    })
    db.addManualPosition('tradestation', 'SIM123', 'MNQZ26', 'buy', 2)
    // A manual trail + an edge manager on the position: both must step aside.
    const key = positionTrailKey('tradestation', 'SIM123', 'MNQZ26')
    db.upsertManagedPosition({
      positionKey: key, exchange: 'tradestation', accountId: 'SIM123', symbol: 'MNQZ26',
      direction: 'long', avgEntryPrice: 20000, size: 2, extremePrice: 20050, oppositePrice: 19950,
      currentStopLoss: null, referencePrice: null, openedTs: Date.now(),
    } as any)
    db.upsertPositionManager({ positionKey: key, managerId: 'risk-guard', execOrder: 100, params: '{}', state: '{}' } as any)

    const res = await svc.handover({
      exchange: 'tradestation', symbol: 'MNQZ26', botId: 'bot-a', stopPrice: 19800, anchor: 20010,
    })
    expect(res.positionId).toBe('srv-pos-1')
    expect(res.stop).toEqual({ price: 19800, slOrderId: 'ord-1', placed: true })
    expect(placed[0]).toMatchObject({ symbol: 'MNQZ26', side: 'sell', orderType: 'stop', stopPrice: 19800, quantity: 2, reduceOnly: true })

    // Server saw side/prices/times, never the size or the account id.
    const body = calls.find((c) => c.path === '/api/ride/handover')!.body
    expect(body).toMatchObject({ botId: 'bot-a', exchange: 'tradestation', symbol: 'MNQ', side: 'long', avgEntry: 20000, stop: 19800, anchor: 20010, ladderFrom: 'entry' })
    expect(JSON.stringify(body)).not.toContain('SIM123')
    expect(body.size).toBeUndefined()
    expect(body.qty).toBeUndefined()

    // Local lineage: the close's lookup (canonical symbol + bot id in metadata).
    const entryId = handoverSignalId('srv-pos-1')
    const entries = db.getOpenEntrySignals('MNQ', 'bot-a')
    expect(entries.map((e) => e.id)).toEqual([entryId])
    const exec = db.getSignalExecution(entryId)!
    expect(exec).toMatchObject({ symbol: 'MNQZ26', exchange: 'tradestation', direction: 'long', status: 'open', qty_opened: 2, qty_closed: 0, account_id: 'SIM123' })
    expect(db.getSignalFills(entryId).map((f) => f.kind)).toEqual(['entry'])
    expect(db.getServerExitState('srv-pos-1')).toMatchObject({ entry_signal_id: entryId, symbol: 'MNQZ26', direction: 'long', current_stop: 19800, sl_order_id: 'ord-1', active: 1 })
    // Sizing base + F3 gate for the bot's closes.
    expect(db.getSubscriptionForBot('bot-a')).toMatchObject({ signal_bot_id: 'bot-a', status: 'active' })
    expect(db.getBotConfig('bot-a:tradestation:MNQ:1h')).toMatchObject({ status: 'running', symbol: 'MNQ' })
    // The marker moved into the execution; managers and trails detached.
    expect(db.getManualPosition('tradestation', 'SIM123', 'MNQZ26')).toBeFalsy()
    expect(db.listActiveManagersForPosition(key)).toHaveLength(0)
    expect(res.detached.managers).toEqual(['risk-guard'])
  })

  it('adopts the manual bracket stop instead of placing a second one', async () => {
    const calls: any[] = []
    const placed: any[] = []
    const svc = createRideHandoverService(db, fakeManager([POS], placed), { postToServer: fakeServer(calls) })
    db.addManualPosition('tradestation', 'SIM123', 'MNQZ26', 'buy', 2)
    // A manual entry with its resting SL leg (what place() records).
    db.insertOrderSettlement({
      signalId: 'manual:abc', exchange: 'tradestation', accountId: 'SIM123', symbol: 'MNQZ26',
      kind: 'entry', side: 'buy', qty: 2, orderId: 'entry-1', targetLabel: 'entry', status: 'filled',
    })
    db.upsertBracketPair({ signalId: 'manual:abc', exchange: 'tradestation', accountId: 'SIM123', slOrderId: 'manual-sl-1' })

    const res = await svc.handover({ exchange: 'tradestation', symbol: 'MNQZ26', botId: 'bot-a', stopPrice: 19800 })
    expect(placed).toHaveLength(0)
    expect(res.stop).toEqual({ price: 19800, slOrderId: 'manual-sl-1', placed: false })
    expect(db.getServerExitState('srv-pos-1')!.sl_order_id).toBe('manual-sl-1')
  })

  it('is idempotent: a repeat writes no second execution and reduces the marker once', async () => {
    const calls: any[] = []
    const svc = createRideHandoverService(db, fakeManager([POS]), {
      postToServer: fakeServer(calls, (path) =>
        path === '/api/ride/handover'
          ? { ok: true, status: 200, body: { positionId: 'srv-pos-1', runId: 'run-1', timeframe: '1h', subscriptionId: null, plan: calls.length > 1 ? 'idempotent' : 'create' } }
          : { ok: true, status: 200, body: {} },
      ),
    })
    db.addManualPosition('tradestation', 'SIM123', 'MNQZ26', 'buy', 2)
    await svc.handover({ exchange: 'tradestation', symbol: 'MNQZ26', botId: 'bot-a', stopPrice: 19800 })
    const again = await svc.handover({ exchange: 'tradestation', symbol: 'MNQZ26', botId: 'bot-a', stopPrice: 19800 })
    expect(again.plan).toBe('idempotent')
    expect(db.getOpenEntrySignals('MNQ', 'bot-a')).toHaveLength(1)
    expect(db.getSignalExecution(handoverSignalId('srv-pos-1'))!.qty_opened).toBe(2)
    expect(db.listOpenExecutionsForExchange('tradestation')).toHaveLength(1)
  })

  it('refuses a position a running bot lineage already holds', async () => {
    const calls: any[] = []
    const svc = createRideHandoverService(db, fakeManager([POS]), { postToServer: fakeServer(calls) })
    db.recordSignal({ id: 'sig-bot', strategyId: 's', symbol: 'MNQ', action: 'buy', metadata: { signalBotId: 'bot-z' } })
    db.updateSignalStatus('sig-bot', 'executed')
    db.insertSignalExecution({ signalId: 'sig-bot', symbol: 'MNQZ26', exchange: 'tradestation', direction: 'long', status: 'open', qtyOpened: 2, accountId: 'SIM123' })
    await expect(
      svc.handover({ exchange: 'tradestation', symbol: 'MNQZ26', botId: 'bot-a', stopPrice: 19800 }),
    ).rejects.toThrow(/running bot/)
    expect(calls).toHaveLength(0)
  })

  it('cancels a stop it placed when the server refuses', async () => {
    const calls: any[] = []
    const placed: any[] = []
    const cancelled: string[] = []
    const svc = createRideHandoverService(db, fakeManager([POS], placed, cancelled), {
      postToServer: fakeServer(calls, () => ({ ok: false, status: 409, body: { error: 'already managed by another bot' } })),
    })
    db.addManualPosition('tradestation', 'SIM123', 'MNQZ26', 'buy', 2)
    await expect(
      svc.handover({ exchange: 'tradestation', symbol: 'MNQZ26', botId: 'bot-a', stopPrice: 19800 }),
    ).rejects.toThrow(/another bot/)
    expect(cancelled).toEqual(['ord-1'])
    expect(db.getManualPosition('tradestation', 'SIM123', 'MNQZ26')!.net).toBe(2)
    expect(db.listOpenExecutionsForExchange('tradestation')).toHaveLength(0)
  })
})

describe('takeback + local close hook', () => {
  it('take-back releases the lineage back to a manual marker and re-hand-over re-arms', async () => {
    const calls: any[] = []
    const svc = createRideHandoverService(db, fakeManager([POS]), { postToServer: fakeServer(calls) })
    db.addManualPosition('tradestation', 'SIM123', 'MNQZ26', 'buy', 2)
    await svc.handover({ exchange: 'tradestation', symbol: 'MNQZ26', botId: 'bot-a', stopPrice: 19800 })

    const tb = await svc.takeback('srv-pos-1')
    expect(tb.released).toBe(true)
    expect(calls.some((c) => c.path === '/api/ride/takeback')).toBe(true)
    expect(db.getServerExitState('srv-pos-1')!.active).toBe(0)
    expect(db.getSignalExecution(handoverSignalId('srv-pos-1'))!.status).toBe('closed')
    expect(db.getOpenEntrySignals('MNQ', 'bot-a')).toHaveLength(0)
    expect(db.getManualPosition('tradestation', 'SIM123', 'MNQZ26')!.net).toBe(2)

    // Hand over again (server re-arms the same row): the execution re-opens.
    const again = await svc.handover({ exchange: 'tradestation', symbol: 'MNQZ26', botId: 'bot-a', stopPrice: 19800 })
    expect(again.positionId).toBe('srv-pos-1')
    expect(db.getSignalExecution(handoverSignalId('srv-pos-1'))).toMatchObject({ status: 'open', qty_opened: 2, qty_closed: 0 })
    expect(db.getOpenEntrySignals('MNQ', 'bot-a')).toHaveLength(1)
    expect(db.getManualPosition('tradestation', 'SIM123', 'MNQZ26')).toBeFalsy()
    expect(db.getServerExitState('srv-pos-1')!.active).toBe(1)
  })

  it('a local full close on a server-managed lineage reports the venue exit', async () => {
    const calls: any[] = []
    const reported: any[] = []
    const svc = createRideHandoverService(db, fakeManager([POS]), {
      postToServer: fakeServer(calls),
      reportVenueExit: async (positionId, fill) => {
        reported.push({ positionId, fill })
      },
    })
    db.addManualPosition('tradestation', 'SIM123', 'MNQZ26', 'buy', 2)
    await svc.handover({ exchange: 'tradestation', symbol: 'MNQZ26', botId: 'bot-a', stopPrice: 19800 })
    const entryId = handoverSignalId('srv-pos-1')
    await svc.onExitAttributed('tradestation', [{ signalId: entryId, qty: 1, fullyClosed: false }], { price: 20100, timeMs: 1 })
    expect(reported).toHaveLength(0)
    await svc.onExitAttributed('tradestation', [{ signalId: entryId, qty: 1, fullyClosed: true }], { price: 20100, timeMs: 2, orderId: 'c1' })
    expect(reported).toEqual([{ positionId: 'srv-pos-1', fill: { price: 20100, timeMs: 2, orderId: 'c1' } }])
    expect(db.getServerExitState('srv-pos-1')!.active).toBe(0)
  })
})

describe('adoptEntry (drawing-trigger hand-over of a filled entry)', () => {
  it('re-tags the real lineage, registers the stop and lists the ride', async () => {
    const calls: any[] = []
    const svc = createRideHandoverService(db, fakeManager([POS]), {
      postToServer: fakeServer(calls, (path) =>
        path === '/api/ride/handover'
          ? { ok: true, status: 200, body: { positionId: 'srv-pos-9', runId: 'run-9', timeframe: '1h', subscriptionId: null, plan: 'rearm' } }
          : { ok: true, status: 200, body: {} },
      ),
    })
    // The discretionary entry the executor filled (canonical symbol row + execution).
    db.recordSignal({ id: 'disc-1', strategyId: 'discretionary', symbol: 'MNQ', action: 'buy', metadata: { signalBotId: 'disc_u', source: 'discretionary', positionId: 'srv-pos-9', handoverTo: { botId: 'bot-a' } } })
    db.updateSignalStatus('disc-1', 'executed')
    db.insertSignalExecution({ signalId: 'disc-1', symbol: 'MNQZ26', exchange: 'tradestation', direction: 'long', status: 'open', qtyOpened: 2, accountId: 'SIM123' })
    const r = await svc.adoptEntry({
      entrySignalId: 'disc-1', positionId: 'srv-pos-9', exchange: 'tradestation', symbol: 'MNQZ26', accountId: 'SIM123',
      direction: 'long', fillPrice: 20000, stopPrice: 19800, slOrderId: 'sl-9', botId: 'bot-a', botName: 'Ride A', marketExchange: 'tradestation', canonicalSymbol: 'MNQ',
    })
    expect(r.positionId).toBe('srv-pos-9')
    const body = calls.find((c) => c.path === '/api/ride/handover')!.body
    expect(body).toMatchObject({ positionId: 'srv-pos-9', botId: 'bot-a', symbol: 'MNQ', side: 'long', avgEntry: 20000, stop: 19800 })
    // The close's lineage lookup now matches the ride bot on the same entry.
    expect(db.getOpenEntrySignals('MNQ', 'bot-a').map((e) => e.id)).toEqual(['disc-1'])
    expect(db.getOpenEntrySignals('MNQ', 'disc_u').map((e) => e.id)).toEqual(['disc-1'])
    expect(db.getServerExitState('srv-pos-9')).toMatchObject({ entry_signal_id: 'disc-1', sl_order_id: 'sl-9', active: 1 })
    expect(db.listOpenExecutionsForExchange('tradestation')).toHaveLength(1)
    const rides = svc.list()
    expect(rides).toHaveLength(1)
    expect(rides[0]).toMatchObject({ positionId: 'srv-pos-9', botId: 'bot-a', symbol: 'MNQZ26' })
    expect(db.getSubscriptionForBot('bot-a')).toBeTruthy()
  })

  it('refuses without a resting stop', async () => {
    const svc = createRideHandoverService(db, fakeManager([POS]), { postToServer: fakeServer([]) })
    await expect(
      svc.adoptEntry({ entrySignalId: 'x', positionId: 'p', exchange: 'tradestation', symbol: 'MNQZ26', accountId: 'SIM123', direction: 'long', fillPrice: 1, stopPrice: null, slOrderId: null, botId: 'bot-a' }),
    ).rejects.toThrow(/resting stop/)
  })
})

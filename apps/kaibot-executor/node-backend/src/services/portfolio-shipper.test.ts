import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { KaiBotDatabase } from '../storage/database.js'
import { PortfolioShipper } from './portfolio-shipper.js'

let dir: string
let db: KaiBotDatabase
const origFetch = globalThis.fetch

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-shipper-test-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
  globalThis.fetch = origFetch
})

describe('PortfolioShipper', () => {
  it('ships unsynced fills + equity and marks them synced exactly once', async () => {
    db.insertSignalFill({ signalId: 's1', kind: 'entry', symbol: 'BTCUSDT', side: 'buy', qty: 1, price: 100 })
    db.insertSignalFill({ signalId: 's1', kind: 'exit', symbol: 'BTCUSDT', side: 'sell', qty: 1, price: 110 })
    db.insertBalanceSnapshot({ exchange: 'bybit', accountId: 'default', equity: 1000, balance: 1000 })

    const calls: Array<{ url: string; body: any }> = []
    globalThis.fetch = mock(async (url: any, init: any) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) })
      return { ok: true, json: async () => ({ ingested: 1 }) } as any
    }) as any

    const shipper = new PortfolioShipper(db, {
      getApiUrl: () => 'http://api.test',
      getSessionToken: () => 'tok',
    }, { shipMs: 999999 })

    const first = await shipper.tick()
    expect(first).toEqual({ fills: 2, equity: 1 })
    // R7: call 0 is the EMPTY consent probe — no real data before opt-in is confirmed.
    expect(calls).toHaveLength(3)
    expect(calls[0].url).toBe('http://api.test/api/portfolio/fills')
    expect(calls[0].body.fills).toHaveLength(0)
    expect(calls[1].url).toBe('http://api.test/api/portfolio/fills')
    expect(calls[1].body.fills).toHaveLength(2)
    expect(calls[1].body.fills[0]).toMatchObject({ signalId: 's1', kind: 'entry', qty: 1 })
    expect(calls[2].url).toBe('http://api.test/api/portfolio/equity')
    expect(calls[2].body.snapshots[0]).toMatchObject({ equity: 1000 })

    // Second pass: nothing new to ship (consent already granted, no re-probe).
    const second = await shipper.tick()
    expect(second).toEqual({ fills: 0, equity: 0 })
  })

  // R7: while the user is opted out, only the empty probe leaves the machine —
  // never a fill or an equity snapshot — and the probe backs off to a slow
  // interval instead of firing every tick.
  it('ships nothing real while opted out, and re-probes on a slow interval', async () => {
    db.insertSignalFill({ signalId: 's7', kind: 'entry', symbol: 'BTCUSDT', side: 'buy', qty: 1, price: 100 })
    db.insertBalanceSnapshot({ exchange: 'bybit', accountId: 'default', equity: 1000, balance: 1000 })

    const calls: Array<{ url: string; body: any }> = []
    globalThis.fetch = mock(async (url: any, init: any) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) })
      return { ok: true, json: async () => ({ ingested: 0, skipped: true, reason: 'opt-out' }) } as any
    }) as any

    const shipper = new PortfolioShipper(db, {
      getApiUrl: () => 'http://api.test',
      getSessionToken: () => 'tok',
    })

    const first = await shipper.tick()
    expect(first).toEqual({ fills: 0, equity: 0 })
    expect(calls).toHaveLength(1)
    expect(calls[0].body.fills).toHaveLength(0) // the probe carried no data
    expect(db.listUnsyncedFills().length).toBe(1) // nothing marked synced

    // Next tick inside the re-probe window: nothing goes out at all.
    const second = await shipper.tick()
    expect(second).toEqual({ fills: 0, equity: 0 })
    expect(calls).toHaveLength(1)
  })

  // R7: an opt-out response on a real batch (user flipped sharing off between
  // ticks) pauses shipping and leaves the rows unsynced.
  it('revokes consent when a real batch comes back opt-out', async () => {
    db.insertSignalFill({ signalId: 's8', kind: 'entry', symbol: 'BTCUSDT', side: 'buy', qty: 1, price: 100 })
    db.insertBalanceSnapshot({ exchange: 'bybit', accountId: 'default', equity: 1000, balance: 1000 })

    let n = 0
    const calls: Array<{ url: string; body: any }> = []
    globalThis.fetch = mock(async (url: any, init: any) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) })
      n += 1
      // Probe says opted in; the real fills batch then reports opt-out.
      const body = n === 1 ? { ingested: 0, skipped: false } : { ingested: 0, skipped: true, reason: 'opt-out' }
      return { ok: true, json: async () => body } as any
    }) as any

    const shipper = new PortfolioShipper(db, {
      getApiUrl: () => 'http://api.test',
      getSessionToken: () => 'tok',
    })

    const res = await shipper.tick()
    expect(res).toEqual({ fills: 0, equity: 0 })
    // probe + fills batch only — the equity snapshot never went out.
    expect(calls).toHaveLength(2)
    expect(db.listUnsyncedFills().length).toBe(1)

    // Consent revoked: the next tick sends nothing (inside the re-probe window).
    await shipper.tick()
    expect(calls).toHaveLength(2)
  })

  it('does not mark synced when the POST fails (retries next pass)', async () => {
    db.insertSignalFill({ signalId: 's2', kind: 'entry', symbol: 'BTCUSDT', side: 'buy', qty: 1, price: 100 })
    globalThis.fetch = mock(async () => ({ ok: false, status: 500, json: async () => ({}) }) as any) as any

    const shipper = new PortfolioShipper(db, { getApiUrl: () => 'http://api.test', getSessionToken: () => 'tok' })
    const res = await shipper.tick()
    expect(res.fills).toBe(0)
    // Still unsynced.
    expect(db.listUnsyncedFills().length).toBe(1)
  })

  it('no-ops when there is no API url or token', async () => {
    db.insertSignalFill({ signalId: 's3', kind: 'entry', symbol: 'BTCUSDT', side: 'buy', qty: 1, price: 100 })
    let called = false
    globalThis.fetch = mock(async () => { called = true; return { ok: true, json: async () => ({}) } as any }) as any

    const shipper = new PortfolioShipper(db, { getApiUrl: () => null, getSessionToken: () => undefined })
    const res = await shipper.tick()
    expect(res).toEqual({ fills: 0, equity: 0 })
    expect(called).toBe(false)
  })

  // API-1: ingest must carry the per-user API key so the server resolves the
  // right account, not a shared secret.
  it('sends the per-user API key header when available', async () => {
    db.insertSignalFill({ signalId: 's4', kind: 'entry', symbol: 'BTCUSDT', side: 'buy', qty: 1, price: 100 })
    let headers: Record<string, string> = {}
    globalThis.fetch = mock(async (_url: any, init: any) => {
      headers = init.headers
      return { ok: true, json: async () => ({ ingested: 1 }) } as any
    }) as any

    const shipper = new PortfolioShipper(db, {
      getApiUrl: () => 'http://api.test',
      getApiKey: () => 'kb_user_key',
    })
    await shipper.tick()
    expect(headers['x-api-key']).toBe('kb_user_key')
  })

  it('ships with only the API key (no session token)', async () => {
    db.insertSignalFill({ signalId: 's5', kind: 'entry', symbol: 'BTCUSDT', side: 'buy', qty: 1, price: 100 })
    let called = false
    globalThis.fetch = mock(async () => {
      called = true
      return { ok: true, json: async () => ({ ingested: 1 }) } as any
    }) as any

    const shipper = new PortfolioShipper(db, {
      getApiUrl: () => 'http://api.test',
      getApiKey: () => 'kb_user_key',
      getSessionToken: () => undefined,
    })
    const res = await shipper.tick()
    expect(called).toBe(true)
    expect(res.fills).toBe(1)
  })

  // EXEC-4: a 403 means consent off / not allowed → stop shipping for this
  // process and do not re-POST every interval.
  it('stops shipping after a 403 and marks nothing synced', async () => {
    db.insertSignalFill({ signalId: 's6', kind: 'entry', symbol: 'BTCUSDT', side: 'buy', qty: 1, price: 100 })
    let calls = 0
    globalThis.fetch = mock(async () => {
      calls += 1
      return { ok: false, status: 403, json: async () => ({}) } as any
    }) as any

    const shipper = new PortfolioShipper(db, {
      getApiUrl: () => 'http://api.test',
      getApiKey: () => 'kb_user_key',
    })

    const first = await shipper.tick()
    expect(first).toEqual({ fills: 0, equity: 0 })
    expect(db.listUnsyncedFills().length).toBe(1) // nothing dropped
    const callsAfterFirst = calls

    // Subsequent passes must not POST again (consent denied latched).
    const second = await shipper.tick()
    expect(second).toEqual({ fills: 0, equity: 0 })
    expect(calls).toBe(callsAfterFirst)
  })
})

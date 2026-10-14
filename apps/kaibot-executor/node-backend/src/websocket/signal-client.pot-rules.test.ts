// Onset pot rules on a real database + the in-memory Bybit: per-trade ceiling
// (clip, not reject) on the collateral pot, the top-up refusal once the venue
// part runs out, and no same-day slot reuse on max_concurrent_trades.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { KaiBotDatabase } from '../storage/database.js'
import { BybitSim } from '../services/exchanges/adapters/bybit-sim.fixture.js'
import type { BybitAdapter } from '../services/exchanges/adapters/bybit.js'
import { orderLockIdle } from '../services/order-lock.js'
import { createSyntheticUsdService } from '../services/synthetic-usd.js'
import { createSyntheticGuardService } from '../services/synthetic-guard.js'
import { createCollateralService, resetCollateralCaches, type CollateralService } from '../services/collateral.js'
import { SignalWebSocketClient } from './signal-client.js'
import { resetDynamicConstraints } from '../services/exchanges/contract-constraints.js'
import { parsePotRules } from '../routes/subscriptions.js'
import type { Signal } from '../storage/types.js'

const ACC = 'unified'
const MARKETS = ['SOLUSDT', 'XRPUSDT', 'ETHUSDT', 'SUIUSDT']

let dir: string
let db: KaiBotDatabase
let sim: BybitSim
let adapter: BybitAdapter
let service: CollateralService
let client: SignalWebSocketClient

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-pot-rules-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
  sim = new BybitSim()
  sim.prices = { BTCUSDT: 100_000, ETHUSDT: 4_000, SOLUSDT: 200, XRPUSDT: 2, SUIUSDT: 4 }
  sim.wallet = { BTC: 0.2 }
  sim.install()
  adapter = sim.adapter()
  const session = { exchangeName: 'bybit', status: 'connected', adapter, userId: 'default', label: 'default' }
  const manager = { getSession: async () => session, getAllSessions: async () => [session] }
  resetCollateralCaches()
  const synth = createSyntheticUsdService(db, manager as any)
  const bus = { publish: () => {} } as any
  const guard = createSyntheticGuardService(db, manager as any, synth, bus)
  service = createCollateralService(db, manager as any, guard, bus)
  // pot = venue 0,2 BTC + virtual 0,1 BTC, both at the 85.000 floor × 0,95
  await service.armFloor({ exchange: 'bybit', accountId: ACC, coin: 'BTC', mode: 'hedge', triggerPrice: 85_000 })
  service.updateSettings({ exchange: 'bybit', accountId: ACC, sizingBasis: 'floor' })
  service.setVirtualLine({ exchange: 'bybit', accountId: ACC, coin: 'BTC', quantity: 0.1, label: 'cold-wallet' })
  db.upsertSubscription({
    id: 'sub-1', signalBotId: 'bot-1', factor: 1, maxConcurrentTrades: 3, exchange: 'bybit', accountId: ACC,
    selectedMarkets: MARKETS, status: 'active',
  })
  db.setSubscriptionPotRules('sub-1', { maxTradePct: 25, noSameDayReuse: true })
  client = new SignalWebSocketClient(db, manager as any, null)
  client.setSettleOptions(2, 1)
})

afterEach(async () => {
  await orderLockIdle()
  resetDynamicConstraints()
  sim.uninstall()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

let seq = 0
function entry(symbol: string, quantity: number): Signal {
  return {
    id: `sig-${++seq}`, strategy_id: 'strat-1', symbol, action: 'buy', quantity, price: sim.prices[symbol],
    metadata: { exchange: 'bybit', signalBotId: 'bot-1' }, received_at: new Date(), status: 'pending', created_at: new Date(),
  } as unknown as Signal
}
const creates = () => sim.requests.filter((r) => r.path === '/v5/order/create').map((r) => r.params)
const status = (id: string) => db.get('SELECT status, error_message FROM signals WHERE id = ?', [id]) as any
const clips = (id: string) => (db.all('SELECT reason, original_quantity, adjusted_quantity FROM executor_safety_clips WHERE signal_id = ?', [id]) as any[])

describe('per-trade ceiling on the collateral pot', () => {
  it('clips a 40 % entry to 25 % of the pot (24.225 → 6.056,25 USD / 200 = 30,2 SOL)', async () => {
    const s = entry('SOLUSDT', 40)
    await (client as any).handleSignalInner(s)
    expect(creates()).toHaveLength(1)
    expect(creates()[0]).toMatchObject({ symbol: 'SOLUSDT', side: 'Buy', qty: '30.2' })
    expect(clips(s.id)).toContainEqual({ reason: 'max_trade_pct', original_quantity: 40, adjusted_quantity: 25 })
    expect(status(s.id).status).toBe('executed')
  })

  it('size unit usd does not convert the pot-sized quantity a second time', async () => {
    db.run(`UPDATE executor_subscriptions SET size_unit = 'usd' WHERE id = 'sub-1'`)
    await (client as any).handleSignalInner(entry('SOLUSDT', 10))
    expect(creates()[0]).toMatchObject({ qty: '12.1' })
  })

  it('an entry under the ceiling is untouched', async () => {
    const s = entry('SOLUSDT', 10)
    await (client as any).handleSignalInner(s)
    expect(creates()[0]).toMatchObject({ qty: '12.1' }) // 2.422,5 / 200
    expect(clips(s.id).map((c) => c.reason)).not.toContain('max_trade_pct')
  })

  it('the third 25 % slot needs a top-up: venue 16.150 holds two (30,2 SOL + 3.028 XRP = 12.096 USD after qtyStep), the third adds ~6.056 → 2.003 USD short', async () => {
    const a = entry('SOLUSDT', 30)
    const b = entry('XRPUSDT', 30)
    const c = entry('SUIUSDT', 30)
    await (client as any).handleSignalInner(a)
    await (client as any).handleSignalInner(b)
    await (client as any).handleSignalInner(c)
    expect(creates().map((o) => o.symbol)).toEqual(['SOLUSDT', 'XRPUSDT'])
    expect(status(c.id).status).toBe('rejected')
    expect(status(c.id).error_message).toBe('collateral: top-up needed 2.003 USD')
    expect(clips(c.id).map((x) => x.reason)).toContain('collateral_top_up')
  })
})

describe('no same-day slot reuse', () => {
  function closedToday(symbol: string) {
    const now = Date.now()
    db.run(
      `INSERT INTO signal_executions (signal_id, symbol, exchange, direction, status, qty_opened, qty_closed, account_id, created_at, updated_at)
       VALUES (?, ?, 'bybit', 'long', 'closed', 1, 1, ?, ?, ?)`,
      [`old-${symbol}`, symbol, ACC, now - 3_600_000, now],
    )
    db.run(`INSERT INTO signal_fills (signal_id, kind, symbol, side, qty, price, created_at) VALUES (?, 'exit', ?, 'sell', 1, 1, ?)`, [
      `old-${symbol}`, symbol, now - 60_000,
    ])
  }

  it('2 open + 1 freed today = cap 3 → refused with the reason', async () => {
    await (client as any).handleSignalInner(entry('SOLUSDT', 5))
    await (client as any).handleSignalInner(entry('XRPUSDT', 5))
    closedToday('ETHUSDT')
    const s = entry('SUIUSDT', 5)
    await (client as any).handleSignalInner(s)
    expect(creates()).toHaveLength(2)
    expect(status(s.id)).toMatchObject({
      status: 'rejected',
      error_message: 'maxConcurrentTrades reached (3: 2 open, 1 freed today, reusable tomorrow)',
    })
  })

  it('an exit yesterday or outside the sub markets frees nothing', async () => {
    await (client as any).handleSignalInner(entry('SOLUSDT', 5))
    await (client as any).handleSignalInner(entry('XRPUSDT', 5))
    closedToday('DOGEUSDT')
    const y = Date.now() - 2 * 86_400_000
    db.run(`INSERT INTO signal_executions (signal_id, symbol, exchange, direction, status, qty_opened, qty_closed, account_id, created_at, updated_at) VALUES ('y', 'ETHUSDT', 'bybit', 'long', 'closed', 1, 1, ?, ?, ?)`, [ACC, y, y])
    db.run(`INSERT INTO signal_fills (signal_id, kind, symbol, side, qty, price, created_at) VALUES ('y', 'exit', 'ETHUSDT', 'sell', 1, 1, ?)`, [y])
    await (client as any).handleSignalInner(entry('SUIUSDT', 5))
    expect(creates()).toHaveLength(3)
  })

  it('off: the freed slot is reusable the same day', async () => {
    db.setSubscriptionPotRules('sub-1', { noSameDayReuse: false })
    await (client as any).handleSignalInner(entry('SOLUSDT', 5))
    await (client as any).handleSignalInner(entry('XRPUSDT', 5))
    closedToday('ETHUSDT')
    await (client as any).handleSignalInner(entry('SUIUSDT', 5))
    expect(creates()).toHaveLength(3)
  })
})

describe('pot rule input', () => {
  it('validates and keeps absent keys absent', () => {
    expect(parsePotRules({})).toEqual({ rules: {} })
    expect(parsePotRules({ maxTradePct: 25, noSameDayReuse: true })).toEqual({ rules: { maxTradePct: 25, noSameDayReuse: true } })
    expect(parsePotRules({ maxTradePct: null })).toEqual({ rules: { maxTradePct: null } })
    expect(parsePotRules({ maxTradePct: 0 })).toHaveProperty('error')
    expect(parsePotRules({ maxTradePct: 120 })).toHaveProperty('error')
    expect(parsePotRules({ noSameDayReuse: 'yes' })).toHaveProperty('error')
  })

  it('the server sync (upsert) leaves the local rules alone', () => {
    db.upsertSubscription({ id: 'sub-1', signalBotId: 'bot-1', factor: 0.5, exchange: 'bybit', accountId: ACC, status: 'active' })
    const row = db.getSubscription('sub-1')
    expect(row.max_trade_pct).toBe(25)
    expect(row.no_same_day_reuse).toBe(1)
  })
})

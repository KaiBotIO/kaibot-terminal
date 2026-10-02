#!/usr/bin/env bun
// Bybit E2E: drives the executor's own BybitAdapter against a real account
// with the smallest order the venue accepts, step by step, and writes a
// PASS/FAIL report with the venue's answers. Runbook: docs/ops/bybit-e2e.md.
//
//   BYBIT_API_KEY=… BYBIT_API_SECRET=… [BYBIT_TESTNET=1] \
//   [BYBIT_E2E_SYMBOL=XRPUSDT] [BYBIT_E2E_REPORT=./bybit-e2e.md] \
//   bun run scripts/bybit-e2e.ts
//
// Coin-only collateral scenario (no stablecoin on the account; runbook §6):
//   BYBIT_E2E_SCENARIO=collateral [BYBIT_E2E_FLOOR_COIN=ETH] … bun run scripts/bybit-e2e.ts
//
// Hard caps (not configurable on purpose): one instrument, qty = the venue's
// minimum that clears minNotionalValue, order notional ≤ NOTIONAL_CAP_USDT,
// abort when the account already holds a position or resting orders on the
// symbol. Secrets never reach stdout or the report.
import { writeFileSync } from 'node:fs'
import { BybitAdapter, type BybitInstrument } from '../src/services/exchanges/adapters/bybit.js'
import type { Order, OrderStatus } from '../src/services/exchanges/types.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KaiBotDatabase } from '../src/storage/database.js'
import { createSyntheticUsdService } from '../src/services/synthetic-usd.js'
import { createSyntheticGuardService } from '../src/services/synthetic-guard.js'
import { createCollateralService, floorPerpSymbol } from '../src/services/collateral.js'
import { checkManualEntryGuards } from '../src/services/manual-trade-guards.js'
import { getCollateralFloor } from '../src/storage/collateral-store.js'

const NOTIONAL_CAP_USDT = 15
// Collateral scenario: the hedge short is the perp's minimum qty (ETH 0,01 ≈
// 40 USDT), so it gets its own cap.
const HEDGE_NOTIONAL_CAP_USDT = 120
const scenario = (process.env.BYBIT_E2E_SCENARIO ?? 'basic').toLowerCase()
const floorCoin = (process.env.BYBIT_E2E_FLOOR_COIN ?? 'ETH').toUpperCase()
const FILL_TIMEOUT_MS = 20_000
const WS_MATCH_TIMEOUT_MS = 10_000

const apiKey = process.env.BYBIT_API_KEY ?? ''
const apiSecret = process.env.BYBIT_API_SECRET ?? ''
const testnet = process.env.BYBIT_TESTNET === '1'
const symbol = (process.env.BYBIT_E2E_SYMBOL ?? 'XRPUSDT').toUpperCase()
const reportPath = process.env.BYBIT_E2E_REPORT ?? `./bybit-e2e-${new Date().toISOString().replace(/[:.]/g, '-')}.md`

if (!apiKey || !apiSecret) {
  console.error('BYBIT_API_KEY / BYBIT_API_SECRET missing')
  process.exit(2)
}

type StepResult = { name: string; status: 'PASS' | 'FAIL' | 'SKIP'; detail: string; venue?: unknown }
const results: StepResult[] = []
const startedAt = Date.now()
const runTag = `e2e${Date.now().toString(36)}`

function log(line: string) {
  console.log(`[bybit-e2e] ${line}`)
}

function compact(v: unknown, max = 600): string {
  try {
    const s = JSON.stringify(v)
    return s.length > max ? s.slice(0, max) + '…' : s
  } catch {
    return String(v)
  }
}

async function step<T>(name: string, fn: () => Promise<{ detail: string; venue?: unknown; value?: T }>): Promise<T | undefined> {
  try {
    const r = await fn()
    results.push({ name, status: 'PASS', detail: r.detail, venue: r.venue })
    log(`PASS ${name}: ${r.detail}`)
    return r.value
  } catch (e: any) {
    const detail = e?.message ?? String(e)
    results.push({ name, status: 'FAIL', detail, venue: e?.venue })
    log(`FAIL ${name}: ${detail}`)
    return undefined
  }
}

function skip(name: string, why: string) {
  results.push({ name, status: 'SKIP', detail: why })
  log(`SKIP ${name}: ${why}`)
}

async function waitFor<T>(what: string, probe: () => Promise<T | null | undefined>, timeoutMs: number, everyMs = 1000): Promise<T> {
  const until = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < until) {
    try {
      const v = await probe()
      if (v) return v
      last = v
    } catch (e) {
      last = e
    }
    await new Promise((r) => setTimeout(r, everyMs))
  }
  throw new Error(`timeout waiting for ${what} (last: ${compact(last, 200)})`)
}

function ceilToStep(x: number, step: number): number {
  const n = Math.ceil(x / step - 1e-9)
  const dec = (String(step).split('.')[1] ?? '').length
  return Number((n * step).toFixed(dec))
}

const adapter = new BybitAdapter()
const wsOrderEvents: Array<{ orderId: string; state: string; orderStatus: string }> = []
const wsExecEvents: Array<{ orderId: string; execId: string; qty: number; price: number }> = []
adapter.subscribeToUpdates((e) => {
  if (e.type === 'order') for (const r of e.data as any[]) wsOrderEvents.push({ orderId: r.orderId, state: r.state, orderStatus: r.orderStatus })
  if (e.type === 'execution') for (const r of e.data as any[]) wsExecEvents.push({ orderId: r.orderId, execId: r.execId, qty: r.qty, price: r.price })
})

const orderIds: Record<string, string> = {}
let instrument: BybitInstrument | undefined
let qty = 0
let mark = 0
let positionOpened = false

async function cleanup(reason: string) {
  log(`cleanup (${reason})`)
  try {
    const open = await adapter.getOpenOrders({ symbol })
    for (const o of open) {
      if (o.label && o.label.startsWith(runTag)) {
        await adapter.cancelOrder(o.orderId, { symbol }).catch((e) => log(`cleanup cancel ${o.orderId} failed: ${e.message}`))
      }
    }
  } catch (e: any) {
    log(`cleanup open-orders failed: ${e.message}`)
  }
  if (positionOpened) {
    try {
      const pos = (await adapter.getPositions()).find((p) => p.symbol === symbol)
      if (pos && pos.size > 0) {
        await adapter.placeOrder({
          accountId: 'unified', symbol, side: pos.side === 'long' ? 'sell' : 'buy', orderType: 'market', quantity: pos.size, reduceOnly: true, clientOrderId: `${runTag}-cleanup`,
        })
        log(`cleanup closed ${pos.side} ${pos.size} ${symbol}`)
      }
    } catch (e: any) {
      log(`cleanup close failed: ${e.message}`)
    }
  }
}

function writeReport() {
  const pass = results.filter((r) => r.status === 'PASS').length
  const fail = results.filter((r) => r.status === 'FAIL').length
  const lines: string[] = []
  lines.push(`# Bybit E2E ${new Date().toISOString()}`)
  lines.push('')
  lines.push(`- env: ${testnet ? 'TESTNET' : 'MAINNET'}, symbol ${symbol}, key ${apiKey.slice(0, 4)}…, run tag ${runTag}`)
  lines.push(`- result: ${fail === 0 ? 'GREEN' : 'RED'} (${pass} PASS / ${fail} FAIL / ${results.length - pass - fail} SKIP), ${Math.round((Date.now() - startedAt) / 1000)} s`)
  lines.push('')
  lines.push('| # | step | status | detail |')
  lines.push('|---|------|--------|--------|')
  results.forEach((r, i) => lines.push(`| ${i + 1} | ${r.name} | ${r.status} | ${r.detail.replace(/\|/g, '\\|')} |`))
  lines.push('')
  lines.push('## Venue answers')
  lines.push('')
  for (const r of results) {
    if (r.venue === undefined) continue
    lines.push(`- ${r.name}: \`${compact(r.venue).replace(/`/g, "'")}\``)
  }
  lines.push('')
  lines.push(`BYBIT-E2E ${fail === 0 ? 'GREEN' : 'RED'} ${pass}/${pass + fail}`)
  const text = lines.join('\n') + '\n'
  writeFileSync(reportPath, text)
  console.log(text)
  log(`report written to ${reportPath}`)
}

async function main() {
  // 1. connect
  const connected = await step('connect', async () => {
    await adapter.connect({ type: 'apiKey', apiKey, apiSecret, testnet })
    const offset = await adapter.syncServerTime()
    return {
      detail: `${testnet ? 'testnet' : 'mainnet'}, UTA=${adapter.isUnifiedAccount}, marginMode=${adapter.accountMarginMode}, clock offset ${offset} ms, ws=${adapter.wsConnected}`,
      value: true,
    }
  })
  if (!connected) return

  // 2. balances
  const usdtEquity = await step('balances', async () => {
    const accounts = await adapter.getAccounts()
    const balances = await adapter.getBalances()
    const usdt = balances.find((b) => b.currency === 'USDT')
    return {
      detail: `${accounts[0]?.name}; ${balances.map((b) => `${b.currency} eq ${b.equity}`).join(', ') || 'no balances'}`,
      venue: balances.map((b) => ({ currency: b.currency, balance: b.balance, equity: b.equity, im: b.initialMargin })),
      value: usdt?.equity ?? 0,
    }
  })

  // 3. instrument / precision / fees / ticker
  instrument = await step('instrument + precision', async () => {
    const inst = await adapter.getInstrument(symbol)
    const fee = await adapter.getFeeRate(symbol).catch(() => null)
    const ticker = await adapter.getMarketTicker(symbol)
    mark = ticker?.mark ?? 0
    if (!(mark > 0)) throw new Error('no mark price')
    if (inst.status !== 'Trading') throw new Error(`instrument status ${inst.status}`)
    return {
      detail: `qtyStep ${inst.qtyStep}, minQty ${inst.minOrderQty}, tick ${inst.tickSize}, minNotional ${inst.minNotionalValue}, mark ${mark}, funding ${ticker?.fundingRate}, fees taker ${fee?.taker} maker ${fee?.maker}`,
      venue: { ...inst, raw: undefined, fee, ticker },
      value: inst,
    }
  })
  if (!instrument) return

  // 4. sizing under the hard cap + pre-flight (flat, no resting orders)
  const sized = await step('sizing + pre-flight', async () => {
    const inst = instrument!
    const minNotional = inst.minNotionalValue ?? 5
    qty = Math.max(inst.minOrderQty, ceilToStep((minNotional * 1.1) / mark, inst.qtyStep))
    const notional = qty * mark
    if (notional > NOTIONAL_CAP_USDT) throw new Error(`notional ${notional.toFixed(2)} USDT exceeds cap ${NOTIONAL_CAP_USDT}`)
    if ((usdtEquity ?? 0) < notional * 3) throw new Error(`USDT equity ${usdtEquity} below 3× notional ${notional.toFixed(2)}`)
    const mode = await adapter.getPositionMode(symbol)
    const pos = (await adapter.getPositions()).find((p) => p.symbol === symbol)
    if (pos) throw new Error(`account already holds ${pos.side} ${pos.size} ${symbol}; refusing to run`)
    const open = await adapter.getOpenOrders({ symbol })
    if (open.length > 0) throw new Error(`${open.length} resting order(s) on ${symbol}; refusing to run`)
    return { detail: `qty ${qty} (${notional.toFixed(2)} USDT), position mode ${mode}, flat, no resting orders`, value: true }
  })
  if (!sized) return

  // 5. limit far from market
  const limitPrice = Number((mark * 0.5).toFixed(6))
  const limitId = await step('limit order far from market', async () => {
    const res = await adapter.placeOrder({
      accountId: 'unified', symbol, side: 'buy', orderType: 'limit', quantity: qty, price: limitPrice, timeInForce: 'GTC', clientOrderId: `${runTag}-limit`,
    })
    orderIds.limit = res.orderId
    const st = await waitFor('limit order working', async () => {
      const s = await adapter.getOrderStatus(res.orderId, { symbol })
      return s.state === 'working' ? s : null
    }, 10_000)
    return { detail: `id ${res.orderId}, ${st.raw?.orderStatus} @ ${st.raw?.price}`, venue: { orderId: res.orderId, orderStatus: st.raw?.orderStatus, price: st.raw?.price, qty: st.raw?.qty }, value: res.orderId }
  })

  // 6. amend
  if (limitId) {
    const amendPrice = Number((mark * 0.45).toFixed(6))
    await step('amend limit price', async () => {
      await adapter.amendOrder(limitId, { symbol }, { price: amendPrice })
      const expected = adapter.formatPrice(amendPrice, instrument)
      const st = await waitFor('amended price visible', async () => {
        const s = await adapter.getOrderStatus(limitId, { symbol })
        return String(s.raw?.price) === expected ? s : null
      }, 10_000)
      return { detail: `price now ${st.raw?.price} (asked ${expected})`, venue: { price: st.raw?.price, orderStatus: st.raw?.orderStatus } }
    })
  } else skip('amend limit price', 'no limit order')

  // 7. cancel
  if (limitId) {
    await step('cancel limit', async () => {
      await adapter.cancelOrder(limitId, { symbol })
      const st = await waitFor('cancelled', async () => {
        const s = await adapter.getOrderStatus(limitId, { symbol })
        return s.state === 'cancelled' ? s : null
      }, 10_000)
      return { detail: `${st.raw?.orderStatus}`, venue: { orderStatus: st.raw?.orderStatus } }
    })
  } else skip('cancel limit', 'no limit order')

  // 8. market entry
  const entry = await step('market entry (min qty)', async () => {
    const res = await adapter.placeOrder({ accountId: 'unified', symbol, side: 'buy', orderType: 'market', quantity: qty, clientOrderId: `${runTag}-entry` })
    orderIds.entry = res.orderId
    positionOpened = true
    const st = await waitFor('entry filled', async () => {
      const s = await adapter.getOrderStatus(res.orderId, { symbol })
      return s.state === 'filled' ? s : null
    }, FILL_TIMEOUT_MS)
    const pos = await waitFor('position visible', async () => (await adapter.getPositions()).find((p) => p.symbol === symbol) ?? null, 10_000)
    return {
      detail: `filled ${st.filledQuantity} @ ${st.averagePrice}, fee ${st.commission}, position ${pos.side} ${pos.size} entry ${pos.entryPrice}`,
      venue: { orderId: res.orderId, filledQuantity: st.filledQuantity, averagePrice: st.averagePrice, commission: st.commission, filledAtMs: st.filledAtMs, position: { side: pos.side, size: pos.size } },
      value: { status: st as OrderStatus, size: pos.size },
    }
  })
  if (!entry) {
    await cleanup('entry failed')
    return
  }

  // 9. resting reduce-only stop-market
  const stopPrice = Number((mark * 0.8).toFixed(6))
  const stopId = await step('reduce-only stop-market (resting venue stop)', async () => {
    const order: Order = { accountId: 'unified', symbol, side: 'sell', orderType: 'stop', quantity: entry.size, stopPrice, reduceOnly: true, triggerType: 'last_price', clientOrderId: `${runTag}-stop` }
    const res = await adapter.placeOrder(order)
    orderIds.stop = res.orderId
    const st = await waitFor('stop untriggered', async () => {
      const s = await adapter.getOrderStatus(res.orderId, { symbol })
      return s.state === 'working' ? s : null
    }, 10_000)
    return {
      detail: `id ${res.orderId}, ${st.raw?.orderStatus}, trigger ${st.raw?.triggerPrice} (${st.raw?.triggerBy}), reduceOnly ${st.raw?.reduceOnly}, stopOrderType ${st.raw?.stopOrderType}`,
      venue: { orderId: res.orderId, orderStatus: st.raw?.orderStatus, triggerPrice: st.raw?.triggerPrice, triggerDirection: st.raw?.triggerDirection, reduceOnly: st.raw?.reduceOnly, stopOrderType: st.raw?.stopOrderType, positionIdx: st.raw?.positionIdx },
      value: res.orderId,
    }
  })

  // 10. open-orders shows the stop
  if (stopId) {
    await step('open-orders lists the stop', async () => {
      const open = await adapter.getOpenOrders({ symbol })
      const row = open.find((o) => o.orderId === stopId)
      if (!row) throw new Error(`stop ${stopId} not in open orders (${open.length} rows)`)
      if (row.type !== 'stop_market' || !row.reduceOnly) throw new Error(`stop row wrong shape: ${compact({ ...row, raw: undefined })}`)
      return { detail: `${row.type} ${row.side} ${row.amount} trigger ${row.triggerPrice} reduceOnly, label ${row.label}`, venue: { ...row, raw: undefined } }
    })
  } else skip('open-orders lists the stop', 'no stop')

  // 11. cancel the stop
  if (stopId) {
    await step('cancel stop', async () => {
      await adapter.cancelOrder(stopId, { symbol })
      const st = await waitFor('stop cancelled', async () => {
        const s = await adapter.getOrderStatus(stopId, { symbol })
        return s.state === 'cancelled' ? s : null
      }, 10_000)
      const open = await adapter.getOpenOrders({ symbol })
      if (open.some((o) => o.orderId === stopId)) throw new Error('stop still listed after cancel')
      return { detail: `${st.raw?.orderStatus}, gone from open orders`, venue: { orderStatus: st.raw?.orderStatus } }
    })
  } else skip('cancel stop', 'no stop')

  // 12. market close
  await step('market close (reduce-only)', async () => {
    const res = await adapter.placeOrder({ accountId: 'unified', symbol, side: 'sell', orderType: 'market', quantity: entry.size, reduceOnly: true, clientOrderId: `${runTag}-close` })
    orderIds.close = res.orderId
    const st = await waitFor('close filled', async () => {
      const s = await adapter.getOrderStatus(res.orderId, { symbol })
      return s.state === 'filled' ? s : null
    }, FILL_TIMEOUT_MS)
    await waitFor('flat', async () => ((await adapter.getPositions()).some((p) => p.symbol === symbol) ? null : true), 10_000)
    positionOpened = false
    return { detail: `filled ${st.filledQuantity} @ ${st.averagePrice}, fee ${st.commission}, flat`, venue: { orderId: res.orderId, filledQuantity: st.filledQuantity, averagePrice: st.averagePrice, commission: st.commission } }
  })

  // 13. executions
  await step('executions / fills', async () => {
    const rows = await waitFor('fills for entry + close', async () => {
      const r = await adapter.getExecutions({ symbol, startTimeMs: startedAt - 60_000, limit: 50 })
      const have = new Set(r.map((x) => x.orderId))
      return have.has(orderIds.entry) && have.has(orderIds.close) ? r : null
    }, 15_000)
    const mine = rows.filter((r) => r.orderId === orderIds.entry || r.orderId === orderIds.close)
    const fees = mine.reduce((s, r) => s + r.fee, 0)
    return {
      detail: `${mine.length} fill(s), total fee ${fees.toFixed(6)}: ${mine.map((r) => `${r.side} ${r.qty}@${r.price} fee ${r.fee} ${r.execType}`).join('; ')}`,
      venue: mine.map((r) => ({ ...r, raw: undefined })),
    }
  })

  // 14. WS events matched
  await step('WS order + execution events matched', async () => {
    const want = Object.values(orderIds)
    await waitFor('ws events', async () => {
      const seen = new Set(wsOrderEvents.map((e) => e.orderId))
      return want.every((id) => seen.has(id)) ? true : null
    }, WS_MATCH_TIMEOUT_MS).catch(() => null)
    const seen = new Set(wsOrderEvents.map((e) => e.orderId))
    const missing = want.filter((id) => !seen.has(id))
    const execSeen = new Set(wsExecEvents.map((e) => e.orderId))
    const missingExec = [orderIds.entry, orderIds.close].filter((id) => id && !execSeen.has(id))
    if (missing.length || missingExec.length) {
      throw Object.assign(new Error(`missing order events for ${missing.join(',') || '-'}; missing execution events for ${missingExec.join(',') || '-'} (ws connected: ${adapter.wsConnected})`), {
        venue: { orderEvents: wsOrderEvents.slice(-20), execEvents: wsExecEvents.slice(-10) },
      })
    }
    const finalStates = want.map((id) => `${id.slice(0, 8)}→${wsOrderEvents.filter((e) => e.orderId === id).map((e) => e.orderStatus).join('>')}`)
    return { detail: `${wsOrderEvents.length} order events, ${wsExecEvents.length} execution events; ${finalStates.join(', ')}`, venue: { orderEvents: wsOrderEvents.slice(-20), execEvents: wsExecEvents.slice(-10) } }
  })

  // 15. final state
  await step('final state: flat, no resting orders', async () => {
    const pos = (await adapter.getPositions()).find((p) => p.symbol === symbol)
    const open = await adapter.getOpenOrders({ symbol })
    if (pos) throw new Error(`still holding ${pos.side} ${pos.size}`)
    if (open.length) throw new Error(`${open.length} resting order(s) left`)
    return { detail: 'flat, clean' }
  })
}

// ── Coin-only collateral scenario ─────────────────────────────────────────
// Real services (collateral + synthetic guard) on a throwaway DB, driven by
// the real adapter. The account holds coins as collateral and no stablecoin.
const collateralState: { floorIds: string[]; db?: KaiBotDatabase; dir?: string; altQty: number } = { floorIds: [], altQty: 0 }

async function collateralScenario() {
  const connected = await step('connect', async () => {
    await adapter.connect({ type: 'apiKey', apiKey, apiSecret, testnet })
    if (adapter.isUnifiedAccount !== true) throw new Error('not a unified trading account')
    return { detail: `${testnet ? 'testnet' : 'mainnet'}, UTA, marginMode=${adapter.accountMarginMode}`, value: true }
  })
  if (!connected) return

  const dir = mkdtempSync(join(tmpdir(), 'bybit-e2e-collateral-'))
  const db = new KaiBotDatabase(join(dir, 'e2e.db'))
  collateralState.db = db
  collateralState.dir = dir
  const session = { exchangeName: 'bybit', status: 'connected', adapter }
  const manager = { getSession: async () => session, getAllSessions: async () => [session] } as any
  const synth = createSyntheticUsdService(db, manager)
  const bus = { publish: (e: any) => log(`notify ${e.type}: ${e.title}: ${e.body}`) } as any
  const guard = createSyntheticGuardService(db, manager, synth, bus)
  const collateral = createCollateralService(db, manager, guard, bus)
  const tick = async () => {
    const positions = await adapter.getPositions()
    await guard.tickExchange('bybit', adapter, positions)
    await collateral.tickExchange('bybit', adapter, positions)
  }

  // C2. wallet: coin collateral on, no stablecoin
  const wallet = await step('wallet: coin-only collateral', async () => {
    const w = await adapter.getCollateralWallet()
    const coin = w.coins.find((c) => c.coin === floorCoin)
    const usdt = w.coins.find((c) => c.coin === 'USDT')
    if (!coin || !(coin.walletBalance > 0)) throw new Error(`no ${floorCoin} on the account`)
    if (!coin.collateralSwitch || !coin.marginCollateral) throw new Error(`${floorCoin} is not switched on as collateral`)
    if ((usdt?.walletBalance ?? 0) > 1) throw new Error(`account holds ${usdt!.walletBalance} USDT: this scenario needs a coin-only account`)
    const tiers = await adapter.getCollateralRatioTiers([floorCoin])
    return {
      detail: `${floorCoin} ${coin.walletBalance} ($${coin.usdValue.toFixed(2)}), USDT ${usdt?.walletBalance ?? 0}, IM ${w.accountIMRate}, MM ${w.accountMMRate}, tiers ${compact(tiers.get(floorCoin))}`,
      venue: { ...w, coins: w.coins.map((c) => ({ coin: c.coin, bal: c.walletBalance, usd: c.usdValue, sw: c.collateralSwitch })) },
      value: coin,
    }
  })
  if (!wallet) return

  // C3. pre-flight on UTA margin (USDT ≤ 0 must not block)
  const inst = await adapter.getInstrument(symbol)
  mark = (await adapter.getLastPrice(symbol)) ?? 0
  qty = Math.max(inst.minOrderQty, ceilToStep(((inst.minNotionalValue ?? 5) * 1.1) / mark, inst.qtyStep))
  const preflight = await step('pre-flight on account margin', async () => {
    if (qty * mark > NOTIONAL_CAP_USDT) throw new Error(`notional ${(qty * mark).toFixed(2)} exceeds cap`)
    if ((await adapter.getPositions()).some((p) => p.symbol === symbol || p.symbol === floorPerpSymbol(floorCoin))) {
      throw new Error('position already open on the alt or the floor perp; refusing to run')
    }
    db.setMarginGuard('bybit', 'unified', { enabled: true, bufferMult: 1, floorMode: 'maintenance', equityPct: 0.2 })
    const g = await checkManualEntryGuards(db, adapter, { exchange: 'bybit', accountId: 'unified', symbol, orderType: 'market', quantity: qty, side: 'buy' })
    if (!g.ok) throw new Error(`guard refused: ${g.guard}: ${g.reason}`)
    const m = await adapter.getAccountMargin()
    return { detail: `${qty} ${symbol} passes; equity $${m?.equityUsd.toFixed(2)}, available $${m?.availableUsd.toFixed(2)}`, value: true }
  })
  if (!preflight) return

  // C4. small alt order on coin collateral
  const alt = await step('alt market entry on coin collateral', async () => {
    const res = await adapter.placeOrder({ accountId: 'unified', symbol, side: 'buy', orderType: 'market', quantity: qty, clientOrderId: `${runTag}-alt` })
    positionOpened = true
    const st = await waitFor('alt filled', async () => {
      const s = await adapter.getOrderStatus(res.orderId, { symbol })
      return s.state === 'filled' ? s : null
    }, FILL_TIMEOUT_MS)
    collateralState.altQty = st.filledQuantity ?? qty
    const w = await adapter.getCollateralWallet()
    return { detail: `filled ${st.filledQuantity} @ ${st.averagePrice}; USDT now ${w.coins.find((c) => c.coin === 'USDT')?.walletBalance ?? 0}`, venue: { orderId: res.orderId }, value: true }
  })
  if (!alt) return

  // C5. hedge floor: arm → fire → recovery leg, minimal size
  const perp = floorPerpSymbol(floorCoin)
  const perpInst = await adapter.getInstrument(perp, 'linear')
  const perpMark = (await adapter.getLastPrice(perp)) ?? 0
  const hedgeCoin = perpInst.minOrderQty
  const hedge = await step('hedge floor: arm (min size)', async () => {
    if (hedgeCoin * perpMark > HEDGE_NOTIONAL_CAP_USDT) throw new Error(`min hedge ${(hedgeCoin * perpMark).toFixed(2)} USDT exceeds cap`)
    const f = await collateral.armFloor({ exchange: 'bybit', accountId: 'unified', coin: floorCoin, mode: 'hedge', triggerPrice: perpMark * 0.9, holdingsCoin: hedgeCoin, recoveryPct: 50 })
    collateralState.floorIds.push(f.id)
    return { detail: `armed ${hedgeCoin} ${floorCoin} at ${f.triggerPrice.toFixed(2)} (planned $${f.plannedFloorUsd.toFixed(2)})`, value: f }
  })
  if (hedge) {
    const fired = await step('hedge floor: fire (trigger moved above the mark)', async () => {
      await collateral.updateFloor(hedge.id, { triggerPrice: perpMark * 1.005 })
      await tick()
      const pos = await waitFor('hedge short', async () => (await adapter.getPositions()).find((p) => p.symbol === perp && p.side === 'short') ?? null, 15_000)
      const syn = db.getSyntheticUsdPosition(hedge.syntheticPositionId!)!
      if (syn.status !== 'open') throw new Error(`synthetic row ${syn.status}: ${syn.arm_last_error}`)
      return { detail: `short ${pos.size} ${perp} @ ${pos.entryPrice}, row open, cycle ${syn.arm_cycle}`, value: syn }
    })
    if (fired) {
      await step('hedge floor: recovery leg (reduce-only buy-back, re-armed)', async () => {
        const syn = db.getSyntheticUsdPosition(hedge.syntheticPositionId!)!
        const m = (await adapter.getLastPrice(perp)) ?? perpMark
        // The tick's own recovery leg; the level is forced because the market
        // will not move 50 % during a test.
        await synth.closeToArmed(syn.id, { mark: m, recoveryLevel: m, reduceOnly: true })
        const left = (await adapter.getPositions()).find((p) => p.symbol === perp)
        if (left) throw new Error(`perp not flat: ${left.side} ${left.size}`)
        const row = db.getSyntheticUsdPosition(syn.id)!
        return { detail: `bought back, row ${row.status} at ${row.arm_trigger_price}`, value: true }
      })
    }
    await step('hedge floor: disarm', async () => {
      const f = await collateral.disarmFloor(hedge.id)
      return { detail: `floor ${f.status}` }
    })
  }

  // C6. sell floor: resting spot conditional, amend, cancel
  const spotInst = await adapter.getInstrument(`${floorCoin}USDT`, 'spot')
  const minAmt = Number(spotInst.raw?.lotSizeFilter?.minOrderAmt ?? 5)
  const sellCoin = Math.max(spotInst.minOrderQty, ceilToStep((minAmt * 1.2) / perpMark, spotInst.qtyStep))
  const sell = await step('sell floor: spot conditional placed', async () => {
    const f = await collateral.armFloor({ exchange: 'bybit', accountId: 'unified', coin: floorCoin, mode: 'sell', triggerPrice: perpMark * 0.7, holdingsCoin: sellCoin })
    collateralState.floorIds.push(f.id)
    const open = await adapter.getOpenOrders()
    const row = open.find((o) => o.orderId === f.venueOrderId)
    if (!row) throw new Error(`spot conditional ${f.venueOrderId} not in open orders`)
    return { detail: `${sellCoin} ${floorCoin} resting sell at ${row.triggerPrice} (${row.type}, ${row.state})`, venue: row, value: f }
  })
  if (sell) {
    await step('sell floor: trigger amended on the venue', async () => {
      await collateral.updateFloor(sell.id, { triggerPrice: perpMark * 0.72 })
      const row = getCollateralFloor(db, sell.id)!
      const open = (await adapter.getOpenOrders()).find((o) => o.orderId === row.venue_order_id)
      if (!open || Math.abs((open.triggerPrice ?? 0) - perpMark * 0.72) > perpMark * 0.001) throw new Error(`venue trigger ${open?.triggerPrice}`)
      return { detail: `venue trigger ${open.triggerPrice}` }
    })
    await step('sell floor: disarm cancels the venue order', async () => {
      const id = getCollateralFloor(db, sell.id)!.venue_order_id
      await collateral.disarmFloor(sell.id)
      const open = (await adapter.getOpenOrders()).find((o) => o.orderId === id)
      if (open) throw new Error('spot conditional still resting')
      return { detail: 'cancelled, floor closed' }
    })
  }

  // C7. close the alt, final state
  await step('alt close (reduce-only)', async () => {
    const pos = (await adapter.getPositions()).find((p) => p.symbol === symbol)
    if (!pos) throw new Error('alt position missing')
    await adapter.placeOrder({ accountId: 'unified', symbol, side: 'sell', orderType: 'market', quantity: pos.size, reduceOnly: true, clientOrderId: `${runTag}-altx` })
    await waitFor('alt flat', async () => ((await adapter.getPositions()).some((p) => p.symbol === symbol) ? null : true), FILL_TIMEOUT_MS)
    positionOpened = false
    return { detail: 'flat' }
  })
  await step('final state: no positions, no resting floor orders', async () => {
    const pos = (await adapter.getPositions()).filter((p) => p.symbol === symbol || p.symbol === perp)
    const open = (await adapter.getOpenOrders()).filter((o) => (o.label ?? '').startsWith('kbcf-') || (o.label ?? '').startsWith(runTag))
    if (pos.length) throw new Error(`positions left: ${pos.map((p) => `${p.symbol} ${p.side} ${p.size}`).join(', ')}`)
    if (open.length) throw new Error(`${open.length} resting order(s) left`)
    const w = await adapter.getCollateralWallet()
    return { detail: `clean; USDT ${w.coins.find((c) => c.coin === 'USDT')?.walletBalance ?? 0} (a negative figure is the loan the losses left)` }
  })
}

async function collateralCleanup() {
  const { db, floorIds } = collateralState
  if (!db) return
  const session = { exchangeName: 'bybit', status: 'connected', adapter }
  const manager = { getSession: async () => session, getAllSessions: async () => [session] } as any
  const synth = createSyntheticUsdService(db, manager)
  const collateral = createCollateralService(db, manager, createSyntheticGuardService(db, manager, synth))
  for (const id of floorIds) {
    const f = getCollateralFloor(db, id)
    if (f && f.status !== 'closed') await collateral.disarmFloor(id).catch((e) => log(`cleanup disarm ${id}: ${e.message}`))
    const synId = f?.synthetic_position_id
    const syn = synId ? db.getSyntheticUsdPosition(synId) : null
    if (syn && syn.status === 'open') await synth.close(syn.id).catch((e) => log(`cleanup hedge close: ${e.message}`))
  }
}

const run = scenario === 'collateral' ? collateralScenario : main
run()
  .catch((e) => {
    results.push({ name: 'unexpected error', status: 'FAIL', detail: e?.message ?? String(e) })
  })
  .then(async () => {
    if (scenario === 'collateral') await collateralCleanup().catch((e) => log(`collateral cleanup: ${e.message}`))
    if (positionOpened || results.some((r) => r.status === 'FAIL')) await cleanup('end of run')
    if (collateralState.dir) {
      collateralState.db?.close()
      rmSync(collateralState.dir, { recursive: true, force: true })
    }
    await adapter.disconnect().catch(() => {})
    writeReport()
    process.exit(results.some((r) => r.status === 'FAIL') ? 1 : 0)
  })

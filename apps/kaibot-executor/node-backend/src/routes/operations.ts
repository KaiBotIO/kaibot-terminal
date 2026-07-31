import { Hono } from 'hono'
import type { KaiBotDatabase } from '../storage/database.js'
import type { ExchangeManager } from '../services/exchanges/exchangeManager.js'
import type { AlertingService } from '../services/notifications/alerting.js'
import { computeSignalPnl } from '../services/pnl.js'
import {
  KNOWN_FUTURES_ROOTS,
  isFuturesRoot,
} from '../services/exchanges/futures-contracts.js'
import { sizingRoot } from '../services/account-sizing.js'
import { panicCloseAll } from '../services/panic.js'
import {
  assemblePortfolio,
  assembleAccountSizes,
  assembleMarginGuards,
} from '../services/state-snapshot.js'

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

// Display labels for the futures roots the executor can size/trade.
const ROOT_LABELS: Record<string, string> = {
  MNQ: 'Micro Nasdaq',
  MES: 'Micro S&P 500',
  MGC: 'Micro Gold',
  SIL: 'Micro Silver',
  NQ: 'Nasdaq',
  ES: 'S&P 500',
  GC: 'Gold',
}

/**
 * Operational views over real broker data (portfolio, markets, per-signal
 * execution detail, reconciliation visibility, account sizing, alerting). All
 * data is live from the connected adapters / local audit tables — no signal
 * framing, no fabricated balances.
 */
export function createOperationsRoutes(
  db: KaiBotDatabase,
  exchangeManager: ExchangeManager,
  alerting?: AlertingService,
  // Called after a panic/halt/guardrail/account-size mutation so the companion
  // state snapshot is re-pushed (no-op while remote management is off).
  onMutation?: () => void,
) {
  const app = new Hono()

  // ── Portfolio: total equity + allocation + open positions with live PnL ──
  // Assembly lives in services/state-snapshot.ts (shared with the companion
  // state snapshot) so the route and the snapshot never drift.
  app.get('/portfolio', async (c) => {
    try {
      return c.json(await assemblePortfolio(db, exchangeManager))
    } catch (error) {
      db.log('error', 'trading', 'Failed to build portfolio', { error: errMsg(error) })
      return c.json({ error: 'Failed to build portfolio' }, 500)
    }
  })

  // ── Markets: front-month contract + last price + open status per root,
  //    plus live crypto markets per connected venue ──
  app.get('/markets', async (c) => {
    try {
      const sessions = await exchangeManager.getAllSessions('default')
      const futures: Array<{
        root: string
        label: string
        symbol: string | null
        last: number | null
        open: boolean
        exchange: string
      }> = []
      const crypto: Array<{
        exchange: string
        symbol: string
        last: number | null
        size: number
        side: 'long' | 'short' | null
      }> = []

      for (const session of sessions) {
        if (session.status !== 'connected') continue
        const adapter = session.adapter

        // Futures venues: resolve front-month + market status per known root.
        if (adapter.resolveSymbol && adapter.getMarketStatus) {
          const roots = KNOWN_FUTURES_ROOTS.filter((r) =>
            // Only roots this venue is meant to trade (TradeStation micros + minis).
            ['MES', 'MNQ', 'MGC', 'SIL'].includes(r),
          )
          for (const root of roots) {
            let symbol: string | null = null
            let last: number | null = null
            let open = false
            try {
              symbol = await adapter.resolveSymbol(root)
              const status = await adapter.getMarketStatus([symbol])
              const st = status.get(symbol)
              if (st) {
                last = st.last || null
                open = !!st.tradeTimeMs && Date.now() - st.tradeTimeMs < 3 * 60 * 1000
              }
            } catch {
              // front month not resolvable right now (quote throttle) → leave nulls
            }
            futures.push({
              root,
              label: ROOT_LABELS[root] ?? root,
              symbol,
              last,
              open,
              exchange: session.exchangeName,
            })
          }
          continue
        }

        // Crypto venues: surface the markets that actually have an open position
        // with their last mark price (24/7, always considered open).
        try {
          const positions = await adapter.getPositions()
          for (const p of positions) {
            if (Math.abs(p.size) <= 0) continue
            crypto.push({
              exchange: session.exchangeName,
              symbol: p.symbol,
              last: p.markPrice ?? p.entryPrice ?? null,
              size: Math.abs(p.size),
              side: p.side,
            })
          }
        } catch (err) {
          db.log('warn', 'trading', 'Markets: crypto positions failed', {
            exchange: session.exchangeName,
            error: errMsg(err),
          })
        }
      }

      return c.json({ futures, crypto })
    } catch (error) {
      db.log('error', 'trading', 'Failed to build markets', { error: errMsg(error) })
      return c.json({ error: 'Failed to build markets' }, 500)
    }
  })

  // ── Per-signal execution detail: signal + execution + fills + settlements +
  //    bracket pair + computed PnL ──
  app.get('/executions/:signalId', (c) => {
    const signalId = c.req.param('signalId')
    try {
      const signal = db.get('SELECT * FROM signals WHERE id = ?', [signalId]) as any
      const execution = db.getSignalExecution(signalId)
      if (!signal && !execution) return c.json({ error: 'not found' }, 404)

      const fills = db.getSignalFills(signalId)
      const settlements = db.all(
        'SELECT * FROM order_settlements WHERE signal_id = ? ORDER BY created_at ASC',
        [signalId],
      )
      const bracket = db.get('SELECT * FROM bracket_pairs WHERE signal_id = ?', [signalId])

      const pnl = execution ? computeSignalPnl(execution, fills) : null

      return c.json({ signal: signal ?? null, execution: execution ?? null, fills, settlements, bracket: bracket ?? null, pnl })
    } catch (error) {
      db.log('error', 'trading', 'Failed to get execution detail', { signalId, error: errMsg(error) })
      return c.json({ error: 'Failed to get execution detail' }, 500)
    }
  })

  // ── Reconciliation visibility: recent runs + latest status per symbol ──
  app.get('/reconciliations', (c) => {
    const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200)
    const exchange = c.req.query('exchange') || undefined
    try {
      const recent = db.listRecentReconciliations(limit)
      const latestPerSymbol = db.latestReconciliationPerSymbol(exchange)
      // A symbol is "mismatched" when its most recent run had a non-zero delta
      // and wasn't a clean correction outcome.
      const mismatched = latestPerSymbol.filter(
        (r) => r.delta !== 0 && r.action !== 'corrected',
      )
      return c.json({ recent, latestPerSymbol, mismatched })
    } catch (error) {
      db.log('error', 'trading', 'Failed to get reconciliations', { error: errMsg(error) })
      return c.json({ error: 'Failed to get reconciliations' }, 500)
    }
  })

  // ── Account sizing: per (exchange account, root) max contracts / signal ──
  // Assembly is shared with the companion state snapshot (services/state-snapshot.ts).
  app.get('/account-sizes', async (c) => {
    try {
      return c.json(await assembleAccountSizes(db, exchangeManager))
    } catch (error) {
      db.log('error', 'system', 'Failed to get account sizes', { error: errMsg(error) })
      return c.json({ error: 'Failed to get account sizes' }, 500)
    }
  })

  app.put('/account-sizes', async (c) => {
    try {
      const body = (await c.req.json()) as {
        exchange?: string
        account?: string
        root?: string
        maxContracts?: number
      }
      if (
        !body.exchange ||
        !body.account ||
        !body.root ||
        typeof body.maxContracts !== 'number' ||
        body.maxContracts < 0 ||
        !Number.isFinite(body.maxContracts)
      ) {
        return c.json({ error: 'exchange, account, root and non-negative maxContracts required' }, 400)
      }
      const root = isFuturesRoot(body.root) ? body.root.toUpperCase() : sizingRoot(body.root)
      db.setAccountSize(body.exchange, body.account, root, body.maxContracts)
      db.log('info', 'system', 'Account size updated', {
        exchange: body.exchange,
        account: body.account,
        root,
        maxContracts: body.maxContracts,
      })
      onMutation?.()
      return c.json({ exchange: body.exchange, account: body.account, root, maxContracts: body.maxContracts })
    } catch (error) {
      db.log('error', 'system', 'Failed to set account size', { error: errMsg(error) })
      return c.json({ error: 'Failed to set account size' }, 500)
    }
  })

  // ── Breathing-room margin guard + opt-in guardrails: per (exchange account) ──
  // One endpoint surfaces both the pre-open margin buffer (migration 015) and the
  // opt-in safety rails (migration 016) since they share a config row. Assembly
  // is shared with the companion state snapshot (services/state-snapshot.ts).
  app.get('/margin-guards', async (c) => {
    try {
      return c.json(await assembleMarginGuards(db, exchangeManager))
    } catch (error) {
      db.log('error', 'system', 'Failed to get margin guards', { error: errMsg(error) })
      return c.json({ error: 'Failed to get margin guards' }, 500)
    }
  })

  // Set the opt-in guardrail rails for (exchange, account). All three default-off
  // (0 = that rail disabled). Validated like margin-guards: non-negative finite.
  app.put('/guardrails', async (c) => {
    try {
      const body = (await c.req.json()) as {
        exchange?: string
        account?: string
        maxDailyLoss?: number
        maxConcurrentPositions?: number
        maxTotalNotional?: number
      }
      const nonNeg = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0
      if (
        !body.exchange ||
        !body.account ||
        !nonNeg(body.maxDailyLoss) ||
        !nonNeg(body.maxConcurrentPositions) ||
        !Number.isInteger(body.maxConcurrentPositions) ||
        !nonNeg(body.maxTotalNotional)
      ) {
        return c.json(
          {
            error:
              'exchange, account, non-negative maxDailyLoss, non-negative integer maxConcurrentPositions, non-negative maxTotalNotional required',
          },
          400,
        )
      }
      db.setGuardrails(body.exchange, body.account, {
        maxDailyLoss: body.maxDailyLoss!,
        maxConcurrentPositions: body.maxConcurrentPositions!,
        maxTotalNotional: body.maxTotalNotional!,
      })
      db.log('info', 'system', 'Guardrails updated', {
        exchange: body.exchange,
        account: body.account,
        maxDailyLoss: body.maxDailyLoss,
        maxConcurrentPositions: body.maxConcurrentPositions,
        maxTotalNotional: body.maxTotalNotional,
      })
      onMutation?.()
      return c.json({
        exchange: body.exchange,
        account: body.account,
        maxDailyLoss: body.maxDailyLoss,
        maxConcurrentPositions: body.maxConcurrentPositions,
        maxTotalNotional: body.maxTotalNotional,
      })
    } catch (error) {
      db.log('error', 'system', 'Failed to set guardrails', { error: errMsg(error) })
      return c.json({ error: 'Failed to set guardrails' }, 500)
    }
  })

  // ── PANIC: offline-proof close-all (+ optional halt) ──
  // Closes every open position across connected exchanges directly via the
  // adapters (not a cloud signal), so it works with the cloud down. `halt` also
  // stops the executor opening on further inbound signals until re-enabled.
  app.post('/panic', async (c) => {
    let halt = false
    try {
      const body = (await c.req.json().catch(() => ({}))) as { halt?: boolean }
      halt = body?.halt === true
    } catch {
      /* empty body → halt false */
    }
    try {
      const report = await panicCloseAll(db, exchangeManager, { halt, reason: 'manual' })
      onMutation?.()
      return c.json(report)
    } catch (error) {
      db.log('error', 'trading', 'PANIC failed', { error: errMsg(error) })
      return c.json({ error: 'Panic failed', detail: errMsg(error) }, 500)
    }
  })

  // ── Halt flag: read + clear (re-enable). Setting it on is done via panic. ──
  app.get('/halt', (c) => c.json(db.getHaltState()))

  app.post('/halt', async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as { halted?: boolean; reason?: string }
      const halted = body?.halted === true
      db.setHaltState(halted, halted ? body?.reason ?? 'manual' : null)
      db.log('warn', 'trading', halted ? 'Executor halted (manual)' : 'Executor halt cleared', {})
      onMutation?.()
      return c.json(db.getHaltState())
    } catch (error) {
      db.log('error', 'trading', 'Failed to set halt state', { error: errMsg(error) })
      return c.json({ error: 'Failed to set halt state' }, 500)
    }
  })

  app.put('/margin-guards', async (c) => {
    try {
      const body = (await c.req.json()) as {
        exchange?: string
        account?: string
        enabled?: boolean
        bufferMult?: number
        floorMode?: string
        equityPct?: number
      }
      const FLOOR_MODES = ['maintenance', 'initial', 'equityPct']
      if (
        !body.exchange ||
        !body.account ||
        typeof body.enabled !== 'boolean' ||
        typeof body.bufferMult !== 'number' ||
        !Number.isFinite(body.bufferMult) ||
        body.bufferMult < 0 ||
        !body.floorMode ||
        !FLOOR_MODES.includes(body.floorMode) ||
        typeof body.equityPct !== 'number' ||
        !Number.isFinite(body.equityPct) ||
        body.equityPct < 0 ||
        body.equityPct > 1
      ) {
        return c.json(
          {
            error:
              'exchange, account, enabled, non-negative bufferMult, floorMode (maintenance|initial|equityPct), equityPct 0..1 required',
          },
          400,
        )
      }
      db.setMarginGuard(body.exchange, body.account, {
        enabled: body.enabled,
        bufferMult: body.bufferMult,
        floorMode: body.floorMode,
        equityPct: body.equityPct,
      })
      db.log('info', 'system', 'Margin guard updated', {
        exchange: body.exchange,
        account: body.account,
        enabled: body.enabled,
        bufferMult: body.bufferMult,
        floorMode: body.floorMode,
        equityPct: body.equityPct,
      })
      onMutation?.()
      return c.json({
        exchange: body.exchange,
        account: body.account,
        enabled: body.enabled,
        bufferMult: body.bufferMult,
        floorMode: body.floorMode,
        equityPct: body.equityPct,
      })
    } catch (error) {
      db.log('error', 'system', 'Failed to set margin guard', { error: errMsg(error) })
      return c.json({ error: 'Failed to set margin guard' }, 500)
    }
  })

  // ── Alerting: status + test send (config itself lives in user settings) ──
  app.get('/alerting/status', (c) => {
    return c.json({ active: alerting?.isActive() ?? false })
  })

  app.post('/alerting/test', async (c) => {
    if (!alerting) return c.json({ ok: false, error: 'alerting not available' }, 500)
    try {
      const result = await alerting.sendTest()
      return c.json(result, result.ok ? 200 : 400)
    } catch (error) {
      return c.json({ ok: false, error: errMsg(error) }, 500)
    }
  })

  return app
}

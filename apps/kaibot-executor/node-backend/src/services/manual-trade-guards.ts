// Manual (discretionary) orders bypassed every safety rail the signal path
// enforces (2026-08-28 readiness review, gap #2): the halt gate, the account
// kill-switch/cap, the market-open guard, the opt-in daily-loss/concurrency/
// notional rails, and the margin breathing-room guard — `services/manual-trade.ts`
// and `routes/manual-trade.ts` had zero references to any of them. This runs the
// SAME checks — same config resolvers, same pure math, same realized-P&L source
// as the signal path — before a manual ENTRY is placed, so a manual order can't
// quietly open into a halted, over-cap or over-limit account.
//
// Manual CLOSES never run through this: like a signal exit, closing only
// reduces risk and must always be available (the panic-flatten / halt itself
// closes positions, so a close guard would be self-defeating).
//
// Fail-open on a data hiccup in an OPTIONAL/opt-in rail (margin, notional),
// mirroring the signal path's own `catch` around guardrail checks — a stale
// balance/position fetch must never silently block trading. The halt gate,
// account kill-switch and market-open guard are hard stops that never fail open.

import type { KaiBotDatabase } from '../storage/database.js'
import type { ExchangeAdapter, Position } from './exchanges/types.js'
import { isMarketTradable } from './market-guard.js'
import { clipToAccountSize, sizingRoot } from './account-sizing.js'
import { contractMultiplier } from './exchanges/futures-contracts.js'
import {
  effectiveMarginGuard,
  effectiveGuardrails,
  computeBreathingRoom,
  isInverseVenue,
  defaultLeverageFor,
} from './margin-guard.js'
import { checkConcurrency, checkNotional, checkDailyLoss, guardrailsActive } from './guardrails.js'
import { realizedPnlTodayUtc } from './daily-pnl.js'

export interface ManualGuardInput {
  exchange: string
  accountId: string
  symbol: string
  orderType: 'market' | 'limit' | 'stop'
  quantity: number // resolved venue-native TOTAL size (post USD conversion, pre-ladder-split)
  price?: number // limit/stop price — used as the notional/margin reference when present
}

export interface ManualGuardResult {
  ok: boolean
  guard?: string
  reason?: string
  // The account kill-switch cap may clip the size down (never reject outright
  // unless the cap is 0) — callers must re-derive legs/brackets from this.
  quantity: number
  clipped?: boolean
  // Set only when the daily-loss rail tripped: the caller (which holds the
  // ExchangeManager) is responsible for the flatten-all + halt side effect,
  // exactly like the signal path does — this module stays read-only.
  dailyLossBreached?: boolean
}

const ok = (quantity: number, clipped = false): ManualGuardResult => ({ ok: true, quantity, clipped })
const reject = (guard: string, reason: string, quantity: number, extra?: Partial<ManualGuardResult>): ManualGuardResult => ({
  ok: false,
  guard,
  reason,
  quantity,
  ...extra,
})

// Positions relevant to a routed account: drop other accounts' rows, keep rows
// without account attribution (single-account/crypto venues never tag one).
function positionsForAccount(positions: Position[], accountId: string): Position[] {
  return positions.filter((p) => !p.accountId || p.accountId === accountId)
}

export async function checkManualEntryGuards(
  db: KaiBotDatabase,
  adapter: ExchangeAdapter,
  input: ManualGuardInput,
): Promise<ManualGuardResult> {
  const { exchange, accountId, symbol, orderType, price } = input
  let quantity = input.quantity

  // ─── Local halt gate (panic-&-halt or a daily-loss trip) ───
  // Offline-proof kill switch: local state, so it bites with the cloud down.
  if (typeof db.getHaltState === 'function' && db.getHaltState().halted) {
    return reject(
      'executor halt',
      'executor halted (panic / daily-loss); not opening new positions',
      quantity,
    )
  }

  // ─── Per-account contract sizing (kill-switch + per-signal cap) ───
  // A configured cap of 0 kills the market for the account; a positive cap
  // clips the requested size down instead of rejecting.
  const sizeClip = clipToAccountSize(db, exchange, accountId, symbol, quantity)
  if (sizeClip.killed) {
    return reject(
      'account kill-switch',
      `market disabled for account (account size 0 on ${sizeClip.root})`,
      quantity,
    )
  }
  if (sizeClip.clipped) quantity = sizeClip.quantity

  // ─── Market-open / stale-quote guard (market orders only) ───
  if (orderType === 'market') {
    const tradable = await isMarketTradable(adapter, symbol)
    if (!tradable) {
      return reject('market closed', 'market closed / stale quote', quantity, { clipped: sizeClip.clipped })
    }
  }

  // ─── Opt-in auto-guardrails (daily loss, concurrency, total notional) ───
  const guardrails = effectiveGuardrails(db, exchange, accountId)
  let positions: Position[] | null = null
  const loadPositions = async () => {
    if (!positions) positions = positionsForAccount(await adapter.getPositions(), accountId)
    return positions
  }

  if (guardrailsActive(guardrails)) {
    try {
      if (guardrails.maxDailyLoss > 0) {
        const realized = realizedPnlTodayUtc(db)
        const dl = checkDailyLoss(guardrails, realized)
        if (dl.breached) {
          return reject(
            'daily-loss limit',
            `daily loss limit hit: realized $${realized.toFixed(0)} ≤ -$${guardrails.maxDailyLoss.toFixed(0)} — flattening + halting`,
            quantity,
            { clipped: sizeClip.clipped, dailyLossBreached: true },
          )
        }
      }

      if (guardrails.maxConcurrentPositions > 0) {
        const openSymbols = (await loadPositions()).filter((p) => Math.abs(p.size) > 0).map((p) => p.symbol)
        const cc = checkConcurrency(guardrails, openSymbols, symbol)
        if (!cc.ok) {
          return reject(
            'max concurrent positions',
            `max concurrent positions reached (${cc.openCount}/${cc.limit})`,
            quantity,
            { clipped: sizeClip.clipped },
          )
        }
      }

      if (guardrails.maxTotalNotional > 0) {
        const posNow = await loadPositions()
        const inverse = isInverseVenue(exchange, symbol)
        const notionalOf = (size: number, px: number, sym: string) =>
          px > 0 ? (inverse ? Math.abs(size) / px : Math.abs(size) * px * contractMultiplier(exchange, sym)) : 0
        const currentNotional = posNow
          .filter((p) => Math.abs(p.size) > 0)
          .reduce((s, p) => s + notionalOf(p.size, p.markPrice || p.entryPrice || 0, p.symbol), 0)
        const samePos = posNow.find((p) => sizingRoot(p.symbol) === sizingRoot(symbol) && Math.abs(p.size) > 0)
        const orderPrice = price || samePos?.markPrice || samePos?.entryPrice || (await adapter.getLastPrice?.(symbol)) || 0
        const orderNotional = notionalOf(quantity, orderPrice, symbol)
        if (orderNotional > 0) {
          const nc = checkNotional(guardrails, currentNotional, orderNotional)
          if (!nc.ok) {
            return reject(
              'max total notional',
              `max total notional exceeded ($${nc.afterNotional.toFixed(0)} > $${nc.limit.toFixed(0)})`,
              quantity,
              { clipped: sizeClip.clipped },
            )
          }
        }
      }
    } catch (e) {
      db.log('warn', 'trading', 'Manual-order guardrail check failed, proceeding', {
        exchange,
        symbol,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  // ─── Breathing room: pre-open margin buffer (opt-in, default off) ───
  const marginGuard = effectiveMarginGuard(db, exchange, accountId)
  if (marginGuard.enabled) {
    try {
      const balances = await adapter.getBalances()
      const bal =
        balances.find((b) => b.accountId === accountId) ??
        balances.reduce<(typeof balances)[number] | undefined>(
          (best, b) => ((b.equity ?? 0) > (best?.equity ?? -Infinity) ? b : best),
          undefined,
        )
      if (bal) {
        const posNow = await loadPositions()
        const root = sizingRoot(symbol)
        const samePos = posNow.find((p) => sizingRoot(p.symbol) === root && Math.abs(p.size) > 0)
        const leverage =
          (samePos?.leverage && samePos.leverage > 0 ? samePos.leverage : 0) ||
          Math.max(0, ...posNow.map((p) => p.leverage ?? 0)) ||
          defaultLeverageFor(exchange)
        const resolvedPrice = price || samePos?.markPrice || samePos?.entryPrice || (await adapter.getLastPrice?.(symbol)) || 0
        if (resolvedPrice > 0) {
          const orderNotional = isInverseVenue(exchange, symbol)
            ? quantity / resolvedPrice
            : quantity * resolvedPrice * contractMultiplier(exchange, symbol)
          const room = computeBreathingRoom(marginGuard, {
            equity: bal.equity,
            initialMargin: bal.initialMargin ?? 0,
            maintenanceMargin: bal.maintenanceMargin ?? 0,
            orderNotional,
            leverage,
          })
          if (!room.ok) {
            return reject(
              'breathing room',
              `breathing room: free margin $${room.available.toFixed(0)} minus ~$${room.orderMargin.toFixed(0)} ` +
                `order margin leaves $${room.after.toFixed(0)}, under the $${room.required.toFixed(0)} floor ` +
                `(${marginGuard.bufferMult}x ${marginGuard.floorMode} $${room.floorBasis.toFixed(0)})`,
              quantity,
              { clipped: sizeClip.clipped },
            )
          }
        }
      }
    } catch (e) {
      db.log('warn', 'trading', 'Manual-order breathing-room check failed, proceeding', {
        exchange,
        symbol,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  return ok(quantity, sizeClip.clipped)
}

// Synthetic USD auto-rebalancer.
//
// Keeps opted-in synthetic USD positions' short notional tracking
// rebalance_target_pct % of the (freshly aggregated) holdings basis. Mirrors
// BalanceSnapshotPoller's start/stop/tick shape and the reconciler's safety
// posture: per-position cooldowns, throttled alerts, and a hard drift guard
// that pauses instead of "fixing" books that no longer match the broker.
//
// SPINE: the executor never decides — doubly gated (SYNTHETIC_REBALANCE_ENABLED
// env + per-position auto_rebalance flag), never mints, never closes: a target
// below the venue minimum is a skip + alert, not an order.
//
// Lock discipline: the tick itself takes NO order lock. All orders go through
// service.scale(), whose placeAndSettle already serializes under the global
// withOrderLock — the lock is not reentrant, so wrapping the tick would
// deadlock.

import type { KaiBotDatabase } from '../storage/database.js'
import type { ExchangeManager } from './exchanges/exchangeManager.js'
import type { SyntheticUsdPositionRow } from '../storage/types.js'
import type { NotificationBus } from './notifications/notification-bus.js'
import {
  aggregateHoldingsBasis,
  computeSizing,
  holdingsBasisTotal,
  type BasisRefreshResult,
  type SyntheticUsdService,
} from './synthetic-usd.js'
import { getContractConstraints } from './exchanges/contract-constraints.js'
import { isSyntheticRebalanceEnabled } from './synthetic-rebalance-gate.js'
import { accountKeyOf } from './exchanges/account-scope.js'

const REBALANCE_INTERVAL_MS = Number(process.env.SYNTHETIC_REBALANCE_INTERVAL_MS) || 5 * 60 * 1000
const REBALANCE_COOLDOWN_MS = Number(process.env.SYNTHETIC_REBALANCE_COOLDOWN_MS) || 30 * 60 * 1000
const BASIS_STALE_MS = Number(process.env.SYNTHETIC_BASIS_STALE_MS) || 15 * 60 * 1000
const ALERT_THROTTLE_MS = 15 * 60 * 1000

export type RebalanceSkipReason =
  | 'halted'
  | 'disconnected'
  | 'stale_basis'
  | 'unknown_basis_mode'
  | 'drift'
  | 'cooldown'
  | 'within_band'
  | 'target_below_min'
  | 'error'

export interface RebalanceTickSummary {
  candidates: number
  rebalanced: number
  skipped: Partial<Record<RebalanceSkipReason, number>>
}

export interface RebalanceDecision {
  action: 'rebalance' | 'within_band' | 'target_below_min'
  // Post-cap target computeSizing produced (0 for target_below_min).
  nextTargetUsd: number
  // Rounded short contracts the target implies.
  desiredShort: number
  // |desired - current| / desired, in percent.
  driftPct: number
  capped: boolean
}

// Pure decision: delegates the clamp+round entirely to computeSizing — the
// same math scale() applies — so decision and execution cannot diverge.
export function planRebalance(
  pos: Pick<
    SyntheticUsdPositionRow,
    'short_size' | 'leverage_cap' | 'rebalance_target_pct' | 'rebalance_band_pct'
  >,
  basisUsd: number,
  stepSize: number,
  minSize: number,
): RebalanceDecision {
  const desiredUsd = (Math.max(0, basisUsd) * pos.rebalance_target_pct) / 100
  const sizing = computeSizing(desiredUsd, basisUsd, stepSize, pos.leverage_cap)
  if (sizing.shortContracts < Math.max(minSize, stepSize)) {
    return {
      action: 'target_below_min',
      nextTargetUsd: 0,
      desiredShort: sizing.shortContracts,
      driftPct: 0,
      capped: sizing.capped,
    }
  }
  const driftPct = (Math.abs(sizing.shortContracts - pos.short_size) / sizing.shortContracts) * 100
  const deltaBelowStep = Math.abs(sizing.shortContracts - pos.short_size) < Math.max(stepSize, 1e-9)
  if (deltaBelowStep || driftPct < pos.rebalance_band_pct) {
    return {
      action: 'within_band',
      nextTargetUsd: sizing.targetUsd,
      desiredShort: sizing.shortContracts,
      driftPct,
      capped: sizing.capped,
    }
  }
  return {
    action: 'rebalance',
    nextTargetUsd: sizing.targetUsd,
    desiredShort: sizing.shortContracts,
    driftPct,
    capped: sizing.capped,
  }
}

export interface SyntheticRebalancerDeps {
  db: KaiBotDatabase
  exchangeManager: ExchangeManager
  service: SyntheticUsdService
  notifications?: NotificationBus | null
  // Injectable for tests; defaults to aggregateHoldingsBasis.
  refreshBasis?: () => Promise<BasisRefreshResult>
  now?: () => number
  userId?: string
}

export class SyntheticRebalancer {
  private timer: ReturnType<typeof setInterval> | null = null
  // In-memory cooldown augments the persisted last_rebalance_at (also armed on
  // order FAILURE so a broken order cannot retry every tick).
  private lastAttemptAt = new Map<string, number>()
  private lastAlertAt = new Map<string, number>()

  constructor(private deps: SyntheticRebalancerDeps) {}

  start(): void {
    if (this.timer) return
    // No immediate tick: give exchange sessions time to boot.
    this.timer = setInterval(() => void this.tick(), REBALANCE_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private alert(key: string, title: string, body: string, data?: Record<string, unknown>): void {
    const now = (this.deps.now ?? Date.now)()
    const last = this.lastAlertAt.get(key) ?? 0
    if (now - last < ALERT_THROTTLE_MS) return
    this.lastAlertAt.set(key, now)
    this.deps.notifications?.publish({ type: 'error', title, body, data })
  }

  async tick(): Promise<RebalanceTickSummary> {
    const { db, exchangeManager, service } = this.deps
    const now = (this.deps.now ?? Date.now)()
    const userId = this.deps.userId ?? 'default'
    const summary: RebalanceTickSummary = { candidates: 0, rebalanced: 0, skipped: {} }
    const skip = (reason: RebalanceSkipReason) => {
      summary.skipped[reason] = (summary.skipped[reason] ?? 0) + 1
    }

    // Belt-and-braces: main.ts already gates start() on the env flag.
    if (!isSyntheticRebalanceEnabled()) return summary

    // Halt first: a scale-up grows exposure, an "open"-class action.
    if (typeof db.getHaltState === 'function' && db.getHaltState().halted) {
      skip('halted')
      return summary
    }

    const rows = db.listAutoRebalanceSyntheticUsdPositions()
    summary.candidates = rows.length
    if (rows.length === 0) return summary // zero venue load when unused

    let refresh: BasisRefreshResult
    try {
      refresh = await (this.deps.refreshBasis?.() ??
        aggregateHoldingsBasis(db, exchangeManager, userId))
    } catch (err) {
      this.alert('*:basis', 'Synthetic rebalance: basis refresh failed', String(err))
      skip('error')
      return summary
    }

    for (const pos of rows) {
      try {
        if (pos.rebalance_basis !== 'holdings') {
          skip('unknown_basis_mode')
          this.alert(
            `${pos.id}:basis_mode`,
            'Synthetic rebalance skipped',
            `Unknown basis mode "${pos.rebalance_basis}" on ${pos.symbol}.`,
          )
          continue
        }

        const session = await exchangeManager.getSession(userId, pos.exchange, accountKeyOf(pos.account_id))
        if (!session || session.status !== 'connected') {
          skip('disconnected')
          this.alert(
            `${pos.id}:disconnected`,
            'Synthetic rebalance skipped',
            `${pos.exchange} is not connected; auto-rebalance for ${pos.symbol} is paused.`,
          )
          continue
        }

        // Staleness: the venue must have refreshed cleanly, and its non-manual
        // lines must be recent. A manual-only basis is exempt (never stale).
        if (refresh.failures.includes(pos.exchange)) {
          skip('stale_basis')
          this.alert(
            `${pos.id}:stale`,
            'Synthetic rebalance skipped',
            `Holdings basis for ${pos.exchange} failed to refresh; not rebalancing on stale data.`,
          )
          continue
        }
        const venueLines = db
          .listHoldingsBasis()
          .filter((l) => !l.is_manual && l.source.startsWith(`${pos.exchange}:`))
        if (venueLines.length > 0 && venueLines.every((l) => now - l.updated_at > BASIS_STALE_MS)) {
          skip('stale_basis')
          this.alert(
            `${pos.id}:stale`,
            'Synthetic rebalance skipped',
            `Holdings basis for ${pos.exchange} is stale; not rebalancing.`,
          )
          continue
        }

        // Drift guard — the key crash/interference safety net: if the live net
        // position no longer matches our books (panic flattened the broker,
        // signals or manual orders trade the same instrument, missed fill),
        // pause and alert. Resolution stays human.
        const { stepSize, minSize } = getContractConstraints(pos.exchange, pos.symbol)
        let liveNetShort = 0
        try {
          const positions = await session.adapter.getPositions()
          for (const p of positions) {
            if (p.symbol !== pos.symbol) continue
            liveNetShort += p.side === 'short' ? p.size : -p.size
          }
        } catch (err) {
          skip('error')
          this.alert(
            `${pos.id}:positions`,
            'Synthetic rebalance skipped',
            `Could not read live positions on ${pos.exchange}: ${String(err)}`,
          )
          continue
        }
        if (Math.abs(liveNetShort - pos.short_size) > Math.max(stepSize, 1e-9)) {
          skip('drift')
          this.alert(
            `${pos.id}:drift`,
            'Synthetic rebalance paused: books do not match the broker',
            `${pos.symbol} live net short ${liveNetShort} vs recorded ${pos.short_size} — panic, signal or manual activity on this instrument. Resolve manually.`,
            { positionId: pos.id, liveNetShort, recorded: pos.short_size },
          )
          continue
        }

        // Cooldown (persisted + in-memory, restart-proof).
        const lastAct = Math.max(this.lastAttemptAt.get(pos.id) ?? 0, pos.last_rebalance_at ?? 0)
        if (now - lastAct < REBALANCE_COOLDOWN_MS) {
          skip('cooldown')
          continue
        }

        const decision = planRebalance(pos, holdingsBasisTotal(db), stepSize, minSize)
        if (decision.action === 'target_below_min') {
          skip('target_below_min')
          this.alert(
            `${pos.id}:below_min`,
            'Synthetic rebalance skipped',
            `Target for ${pos.symbol} rounds below the venue minimum — basis collapsed? Close the position manually if intended.`,
          )
          continue
        }
        if (decision.action === 'within_band') {
          skip('within_band')
          continue
        }

        // Halt re-check right before ordering (may have tripped mid-tick).
        if (typeof db.getHaltState === 'function' && db.getHaltState().halted) {
          skip('halted')
          continue
        }

        this.lastAttemptAt.set(pos.id, now)
        try {
          const before = pos.short_size
          const updated = await service.scale(pos.id, decision.nextTargetUsd, undefined, {
            kindOverride: 'auto_rebalance',
          })
          db.updateSyntheticUsdPosition(pos.id, { last_rebalance_at: now })
          summary.rebalanced++
          // Deliberately NOT throttled: real orders are rare by construction
          // and every one must be seen (also webhook-forwarded via ALERTABLE).
          this.deps.notifications?.publish({
            type: 'synthetic_rebalanced',
            title: 'Synthetic USD auto-rebalance',
            body: `Rebalanced ${pos.symbol}: short $${before} → $${updated.short_size} (basis $${Math.round(refresh.totalUsd)}, target ${pos.rebalance_target_pct}%).`,
            data: {
              positionId: pos.id,
              shortBefore: before,
              shortAfter: updated.short_size,
              basisUsd: refresh.totalUsd,
            },
          })
        } catch (err) {
          skip('error')
          db.log('error', 'trading', 'Synthetic auto-rebalance order failed', {
            positionId: pos.id,
            error: err instanceof Error ? err.message : String(err),
          })
          this.alert(
            `${pos.id}:order`,
            'Synthetic rebalance order failed',
            `${pos.symbol}: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      } catch (err) {
        skip('error')
        db.log('error', 'trading', 'Synthetic rebalancer tick error', {
          positionId: pos.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    return summary
  }
}

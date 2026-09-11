// Periodic balance-snapshot poller → dashboard equity curve.
//
// Ported from the standalone kaibot-exec service (src/jobs.ts balanceTick),
// adapted to the executor's ExchangeManager + adapter model: it snapshots the
// live equity/cash of every connected exchange session and stores it, so the
// dashboard can draw a real equity curve instead of reading the never-written
// performance_metrics table.
//
// Conservative by default (5 min) and configurable via BALANCE_SNAPSHOT_MS.

import type { KaiBotDatabase } from '../storage/database.js'
import type { ExchangeManager } from './exchanges/exchangeManager.js'

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000

export class BalanceSnapshotPoller {
  private timer: NodeJS.Timeout | null = null
  private userId: string

  constructor(
    private db: KaiBotDatabase,
    private exchangeManager: ExchangeManager,
    private intervalMs: number = Number(process.env.BALANCE_SNAPSHOT_MS) || DEFAULT_INTERVAL_MS,
    userId = 'default',
  ) {
    this.userId = userId
  }

  /** Take one snapshot now, then on the configured interval. */
  start(): void {
    if (this.timer) return
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.intervalMs)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * Snapshot every connected session's balances. All accounts written at the
   * same wall-clock ts so the equity curve groups them into one point. Returns
   * the number of snapshot rows written (handy for tests).
   */
  async tick(): Promise<number> {
    let written = 0
    const ts = Date.now()
    let sessions
    try {
      sessions = await this.exchangeManager.getAllSessions(this.userId)
    } catch (err) {
      this.db.log('warn', 'system', 'Balance poller: failed to list sessions', {
        error: err instanceof Error ? err.message : String(err),
      })
      return 0
    }

    for (const session of sessions) {
      if (session.status !== 'connected') continue
      try {
        const balances = await session.adapter.getBalances()
        for (const b of balances) {
          this.db.insertBalanceSnapshot({
            exchange: session.exchangeName,
            accountId: b.accountId,
            equity: b.equity ?? 0,
            balance: b.balance ?? 0,
            unrealizedPnL: b.unrealizedPnL ?? 0,
            currency: b.currency,
            ts,
          })
          written++
        }
      } catch (err) {
        this.db.log('warn', 'system', 'Balance poller: snapshot failed', {
          exchange: session.exchangeName,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    return written
  }
}

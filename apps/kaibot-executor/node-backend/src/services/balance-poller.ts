// Periodic balance-snapshot poller → dashboard equity curve.
//
// Ported from the standalone kaibot-exec service (src/jobs.ts balanceTick),
// adapted to the executor's ExchangeManager + adapter model: it snapshots the
// live equity/cash of every connected exchange session and stores it, so the
// dashboard can draw a real equity curve instead of reading the never-written
// performance_metrics table.
//
// Every wallet is stored in its own currency AND in USD at the venue mark
// (Deribit's 5 ETH is $13.500, not 5). A tick where a connected session
// delivers no valid balance (401, maintenance, empty account list) is written
// with `partial` set: the healthy wallets stay fresh for the risk guards, but
// the curve treats the tick as a gap instead of drawing a dip to the few
// wallets that did answer.
//
// Conservative by default (5 min) and configurable via BALANCE_SNAPSHOT_MS.

import type { KaiBotDatabase } from '../storage/database.js'
import type { ExchangeManager } from './exchanges/exchangeManager.js'
import type { Balance } from './exchanges/types.js'
import { usdRatesFor, withUsdValues, type UsdValuedBalance } from './exchanges/balance-usd.js'

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000

export interface BalanceTickResult {
  written: number
  partial: boolean
  // Sessions that delivered no valid balance this tick.
  failed: Array<{ exchange: string; accountKey: string | null; reason: string }>
}

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
    return (await this.tickDetailed()).written
  }

  async tickDetailed(): Promise<BalanceTickResult> {
    const ts = Date.now()
    let sessions
    try {
      sessions = await this.exchangeManager.getAllSessions(this.userId)
    } catch (err) {
      this.db.log('warn', 'system', 'Balance poller: failed to list sessions', {
        error: err instanceof Error ? err.message : String(err),
      })
      return { written: 0, partial: false, failed: [] }
    }

    // Fetch first, write second: whether the tick is partial is only known
    // once every connected session has answered.
    const fetched: Array<{ exchange: string; balances: UsdValuedBalance[] }> = []
    const failed: BalanceTickResult['failed'] = []
    for (const session of sessions) {
      if (session.status !== 'connected') continue
      const accountKey = session.accountKey ?? null
      try {
        const raw: Balance[] = await session.adapter.getBalances()
        if (raw.length === 0) {
          failed.push({ exchange: session.exchangeName, accountKey, reason: 'no balances returned' })
          continue
        }
        const adapter = session.adapter as { getLastPrice?: (s: string) => Promise<number | null> }
        const rates = await usdRatesFor(raw, adapter.getLastPrice?.bind(session.adapter))
        fetched.push({ exchange: session.exchangeName, balances: withUsdValues(raw, rates) })
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        failed.push({ exchange: session.exchangeName, accountKey, reason })
        this.db.log('warn', 'system', 'Balance poller: snapshot failed', {
          exchange: session.exchangeName,
          accountKey,
          error: reason,
        })
      }
    }

    const partial = failed.length > 0
    let written = 0
    for (const { exchange, balances } of fetched) {
      for (const b of balances) {
        this.db.insertBalanceSnapshot({
          exchange,
          accountId: b.accountId,
          equity: b.equity ?? 0,
          balance: b.balance ?? 0,
          unrealizedPnL: b.unrealizedPnL ?? 0,
          currency: b.currency,
          ts,
          usdEquity: b.usdEquity,
          usdUnrealizedPnL:
            b.usdRate != null && Number.isFinite(b.usdRate) ? (b.unrealizedPnL ?? 0) * b.usdRate : null,
          partial,
        })
        written++
      }
    }
    if (partial && written > 0) {
      this.db.log('warn', 'system', 'Balance poller: partial tick (curve gap)', {
        failed,
        written,
      })
    }
    return { written, partial, failed }
  }
}

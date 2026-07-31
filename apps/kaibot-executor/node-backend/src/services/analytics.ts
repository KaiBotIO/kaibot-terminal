// Local closed-trade analytics.
//
// Everything here is computed on the executor from its own fill ledger
// (signal_executions + signal_fills) — nothing leaves the machine and portfolio
// sharing is irrelevant. The web app shows the same figures behind the
// share-portfolio opt-in; the metric definitions below are kept in sync with
// packages/trpc/src/routers/analytics.ts (buildSummary / buildCumulativePnl /
// buildTradeDistribution) so both surfaces agree to the cent. The contract test
// in ./__tests__/analytics.test.ts mirrors the web app's fixtures — if you change
// a formula on one side, change it on the other and both tests stay green.
//
// The one intentional difference: no `optedIn` gate here (the data is local), and
// timestamps are ms epochs rather than Date objects.

import type { SignalExecutionRow, SignalFillRow } from '../storage/types.js'
import { computeSignalPnl } from './pnl.js'

export interface ClosedRow {
  symbol: string
  direction: 'long' | 'short'
  realizedPnl: number // net realized P&L for the trade (after commissions)
  entryAvg: number | null // weighted average entry fill price
  exitAvg: number | null // weighted average exit fill price
  closedAt: number // ms epoch — last exit fill
  openDate: number // ms epoch — first entry fill
}

export interface AnalyticsSummary {
  hasData: boolean
  totalTrades: number
  winningTrades: number
  losingTrades: number
  winRate: number | null // 0..1, null when no trades
  profitFactor: number | null // null when no losses (or no trades)
  // -1..0 (floored at -100%). Null when no data, and null while the cumulative
  // curve has never been positive: there is no peak to measure a percentage
  // against. Use maxDrawdownAbs in that case.
  maxDrawdownPct: number | null
  maxDrawdownAbs: number | null // <=0, in account currency. Null when no data.
  avgTradeDurationMs: number | null
  netPnl: number
}

export interface CumulativePnlPoint {
  ts: number // ms epoch of the closing trade
  pnl: number // running cumulative realized P&L
}

export interface TradeDistributionRow {
  market: string // symbol
  trades: number
  netPnl: number
}

// --- Pure aggregations (unit-tested independently of the DB) ---

export function buildSummary(closed: ClosedRow[]): AnalyticsSummary {
  const totalTrades = closed.length
  if (totalTrades === 0) {
    return {
      hasData: false,
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      winRate: null,
      profitFactor: null,
      maxDrawdownPct: null,
      maxDrawdownAbs: null,
      avgTradeDurationMs: null,
      netPnl: 0,
    }
  }

  let wins = 0
  let losses = 0
  let grossProfit = 0
  let grossLoss = 0 // positive magnitude
  let netPnl = 0
  let durationSum = 0
  for (const t of closed) {
    if (t.realizedPnl > 0) {
      wins += 1
      grossProfit += t.realizedPnl
    } else if (t.realizedPnl < 0) {
      losses += 1
      grossLoss += -t.realizedPnl
    }
    netPnl += t.realizedPnl
    durationSum += Math.max(0, t.closedAt - t.openDate)
  }

  // Max drawdown on the cumulative realized-P&L curve. The percentage is
  // peak-relative and floored at -100% (you can't lose more than the account).
  // While the curve has never been positive the peak is 0 and the percentage is
  // undefined, NOT zero — reporting 0.0% on an all-losing account reads as a
  // lie. The absolute drawdown is well defined either way.
  let cum = 0
  let peak = 0
  let maxDdPct = 0
  let maxDdAbs = 0
  let peakEverPositive = false
  for (const t of closed) {
    cum += t.realizedPnl
    if (cum > peak) peak = cum
    if (peak > 0) peakEverPositive = true
    const ddAbs = cum - peak
    if (ddAbs < maxDdAbs) maxDdAbs = ddAbs
    if (peak > 0) {
      const dd = ddAbs / peak
      if (dd < maxDdPct) maxDdPct = dd
    }
  }

  const profitFactor =
    grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : null

  return {
    hasData: true,
    totalTrades,
    winningTrades: wins,
    losingTrades: losses,
    winRate: wins / totalTrades,
    profitFactor,
    maxDrawdownPct: peakEverPositive ? Math.max(-1, maxDdPct) : null,
    maxDrawdownAbs: maxDdAbs,
    avgTradeDurationMs: durationSum / totalTrades,
    netPnl,
  }
}

export function buildCumulativePnl(closed: ClosedRow[]): CumulativePnlPoint[] {
  const out: CumulativePnlPoint[] = []
  let cum = 0
  for (const t of closed) {
    cum += t.realizedPnl
    out.push({ ts: t.closedAt, pnl: cum })
  }
  return out
}

export function buildTradeDistribution(closed: ClosedRow[]): TradeDistributionRow[] {
  const byMarket = new Map<string, { trades: number; netPnl: number }>()
  for (const t of closed) {
    const cur = byMarket.get(t.symbol) ?? { trades: 0, netPnl: 0 }
    cur.trades += 1
    cur.netPnl += t.realizedPnl
    byMarket.set(t.symbol, cur)
  }
  return [...byMarket.entries()]
    .map(([market, v]) => ({ market, trades: v.trades, netPnl: v.netPnl }))
    .sort((a, b) => b.trades - a.trades)
}

// --- Executor glue: closed executions + their fills → ClosedRow[] ---

type ClosedExecution = Pick<
  SignalExecutionRow,
  'signal_id' | 'symbol' | 'direction' | 'status' | 'qty_opened' | 'qty_closed'
>

/**
 * Map closed signal executions to ClosedRows using the fills-based PnL. A trade
 * only counts once it has both an exit fill and a realized close quantity —
 * open/errored executions and dangling entries never enter the analytics set.
 * Returned ascending by close time (required by the cumulative + drawdown passes).
 */
export function closedRowsFromExecutions(
  executions: ClosedExecution[],
  fillsBySignal: Map<string, SignalFillRow[]>,
): ClosedRow[] {
  const rows: ClosedRow[] = []
  for (const e of executions) {
    if (e.status !== 'closed') continue
    const fills = fillsBySignal.get(e.signal_id) ?? []
    const exitTs = fills.filter((f) => f.kind === 'exit').map((f) => f.created_at)
    if (exitTs.length === 0) continue // nothing realized to account for
    const pnl = computeSignalPnl(e, fills)
    if (pnl.qtyClosed <= 0) continue
    const entryTs = fills.filter((f) => f.kind === 'entry').map((f) => f.created_at)
    const closedAt = Math.max(...exitTs)
    const openDate = entryTs.length > 0 ? Math.min(...entryTs) : closedAt
    rows.push({
      symbol: e.symbol,
      direction: e.direction,
      realizedPnl: pnl.realizedNet,
      entryAvg: pnl.entryAvg,
      exitAvg: pnl.exitAvg,
      closedAt,
      openDate,
    })
  }
  return rows.sort((a, b) => a.closedAt - b.closedAt)
}

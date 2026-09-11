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
  /** Broker account the position sat on. Null when the execution predates it. */
  accountId?: string | null
  realizedPnl: number // net realized P&L for the trade (after commissions)
  entryAvg: number | null // weighted average entry fill price
  exitAvg: number | null // weighted average exit fill price
  closedAt: number // ms epoch — last exit fill
  openDate: number // ms epoch — first entry fill
  // Which bot/strategy held the position, resolved from the local position
  // group (see StrategyLabel). Null = the trade could not be attributed to one.
  strategy?: string | null
  signalBotId?: string | null
}

/** How a closed execution is attributed to a bot. Resolved locally, never shipped. */
export interface StrategyLabel {
  strategy: string
  signalBotId: string | null
}

/** Everything the local ledger knows about who owns one closed execution. */
export interface AttributionInput {
  /**
   * The bot id carried by the ORIGINATING signal, or null when the execution
   * has no signal behind it at all (a manual order, or a synthetic post such as
   * `reconcile-roundtrip:<orderId>`).
   */
  signalBotId: string | null
  /**
   * False when no signal row exists for this execution. Such a post never
   * belongs to a bot, whatever else happens to sit on the same symbol.
   */
  fromSignal: boolean
  /** Position group of the venue position. Symbol-scoped, so it may be another bot's. */
  group: { name: string; signalBotId: string | null } | null
  /** bot_configs row for the signal's own bot id, when there is one. */
  configForBot: { name: string } | null
  /** bot_configs row matched on (exchange, symbol). Legacy fallback only. */
  configForSymbol: { name: string; signalBotId: string } | null
}

/**
 * Who a closed execution belongs to, resolved from LINEAGE first.
 *
 * The position group is keyed on (exchange, account, symbol), so anything that
 * traded that contract inherited the bot that happens to hold it. That swept
 * the two 2026-09-01 reconciler round-trips into the Ascender MGC scorecard:
 * three trades at -3.001 where the bot did one at -2.820. A post with no signal
 * behind it is never a bot trade, and a signal that names its bot may only be
 * labelled with THAT bot.
 *
 * Returns null for "unattributed" — the caller buckets those under
 * UNATTRIBUTED_STRATEGY so the rows still add up to the panel totals.
 */
export function resolveStrategyLabel(input: AttributionInput): StrategyLabel | null {
  if (!input.fromSignal) return null

  const botId = input.signalBotId
  if (botId) {
    if (input.group && input.group.signalBotId === botId) {
      return { strategy: input.group.name, signalBotId: botId }
    }
    if (input.configForBot) return { strategy: input.configForBot.name, signalBotId: botId }
    // A group with no bot of its own cannot contradict the signal.
    if (input.group && input.group.signalBotId == null) {
      return { strategy: input.group.name, signalBotId: botId }
    }
    // Known bot, no local name for it: the id beats dropping a real bot trade
    // into the unattributed bucket.
    return { strategy: botId, signalBotId: botId }
  }

  // Signal without bot metadata (predates the field): fall back to the position
  // it traded, exactly as before.
  if (input.group) {
    return { strategy: input.group.name, signalBotId: input.group.signalBotId }
  }
  if (input.configForSymbol) {
    return { strategy: input.configForSymbol.name, signalBotId: input.configForSymbol.signalBotId }
  }
  return null
}

export interface AnalyticsSummary {
  hasData: boolean
  totalTrades: number
  winningTrades: number
  losingTrades: number
  winRate: number | null // 0..1, null when no trades
  profitFactor: number | null // null when no losses (or no trades)
  // -1..0 (floored at -100%). Null when no data, and null when the deepest
  // drawdown happened before the curve had a positive peak: there is no peak to
  // measure it against. Use maxDrawdownAbs in that case.
  maxDrawdownPct: number | null
  // True when the raw peak-relative drawdown was worse than -100% and the value
  // above is the floor, not the measurement. A $3.289 dip off a $560 peak is
  // -587%, and rendering that as "-100.0%" reads as a full wipeout of the
  // account instead of a dip five times its own peak. Surfaces so the UI can
  // lead with the amount and say ">100%".
  maxDrawdownPctClamped: boolean
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
      maxDrawdownPctClamped: false,
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
  // True when the DEEPEST drawdown happened while the peak was still 0 — the
  // curve below its starting point. Dividing by that peak is meaningless, and a
  // later, shallower post-peak percentage describes a different (smaller) dip
  // than maxDrawdownAbs reports, so the percentage is withheld instead.
  let deepestDdHadNoPeak = false
  for (const t of closed) {
    cum += t.realizedPnl
    if (cum > peak) peak = cum
    const ddAbs = cum - peak
    if (ddAbs < maxDdAbs) {
      maxDdAbs = ddAbs
      deepestDdHadNoPeak = peak <= 0
    }
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
    maxDrawdownPct: deepestDdHadNoPeak ? null : Math.max(-1, maxDdPct),
    maxDrawdownPctClamped: !deepestDdHadNoPeak && maxDdPct < -1,
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

/** One bot's live scorecard: the same metrics as the panel, over its own trades. */
export interface StrategyScorecard {
  /** Stable row id — the bot id when known, else the strategy name. */
  key: string
  strategy: string
  signalBotId: string | null
  summary: AnalyticsSummary
  /** Cumulative realized P&L since this bot's first closed trade. */
  curve: CumulativePnlPoint[]
  firstTradeAt: number
  lastTradeAt: number
}

// Trades that carry no bot attribution (manual entries, positions closed before
// grouping existed). Bucketed rather than dropped — the panel's totals and the
// per-strategy rows must add up.
export const UNATTRIBUTED_STRATEGY = 'Unattributed'

/**
 * Per-bot breakdown of the same closed trades the summary is built from. Each
 * row runs the SHARED buildSummary/buildCumulativePnl, so a strategy's win rate,
 * profit factor and drawdown follow exactly the panel's conventions (net of
 * fees, drawdown undefined when the deepest dip has no peak above it).
 * Sorted by net P&L, best first; the unattributed bucket always sorts last.
 */
export function buildStrategyScorecards(closed: ClosedRow[]): StrategyScorecard[] {
  const groups = new Map<string, { label: string; botId: string | null; rows: ClosedRow[] }>()
  for (const t of closed) {
    const label = t.strategy?.trim() || UNATTRIBUTED_STRATEGY
    const botId = t.signalBotId ?? null
    const key = strategyKeyOf(t)
    const cur = groups.get(key) ?? { label, botId, rows: [] }
    cur.rows.push(t)
    groups.set(key, cur)
  }

  const out: StrategyScorecard[] = []
  for (const [key, g] of groups) {
    // Rows arrive ascending by close time from closedRowsFromExecutions; the
    // per-strategy slice preserves that order, which the drawdown pass needs.
    const summary = buildSummary(g.rows)
    out.push({
      key,
      strategy: g.label,
      signalBotId: g.botId,
      summary,
      curve: buildCumulativePnl(g.rows),
      firstTradeAt: g.rows[0]!.closedAt,
      lastTradeAt: g.rows[g.rows.length - 1]!.closedAt,
    })
  }
  return out.sort((a, b) => {
    const aLast = a.strategy === UNATTRIBUTED_STRATEGY
    const bLast = b.strategy === UNATTRIBUTED_STRATEGY
    if (aLast !== bLast) return aLast ? 1 : -1
    return b.summary.netPnl - a.summary.netPnl
  })
}

// --- Filtering ---
//
// One pure pass over the closed rows, ahead of every aggregation, so the KPIs,
// the cumulative curve, the by-strategy table and the market distribution can
// never disagree about which trades they describe.

/** Row key a scorecard is grouped under: the bot id, else the strategy label. */
export function strategyKeyOf(r: Pick<ClosedRow, 'strategy' | 'signalBotId'>): string {
  return r.signalBotId ?? (r.strategy?.trim() || UNATTRIBUTED_STRATEGY)
}

/** True when the trade came from a bot; false for manual and repair posts. */
export function isBotTrade(r: Pick<ClosedRow, 'strategy' | 'signalBotId'>): boolean {
  return r.signalBotId != null || (r.strategy?.trim() ?? '') !== ''
}

export interface AnalyticsFilter {
  /** Broker accounts to keep. Empty = every account. */
  accounts?: string[]
  /** Strategy keys to keep (see strategyKeyOf). Empty = every strategy. */
  strategies?: string[]
  /** Symbols to keep. Empty = every market. */
  symbols?: string[]
  /** 'both' or undefined keeps long and short. */
  direction?: 'long' | 'short' | 'both'
  /** Inclusive close-time bounds, ms epoch. */
  from?: number | null
  to?: number | null
  /** False drops manual orders and repair posts. Default true. */
  includeNonBot?: boolean
}

/** The unfiltered choices a filter bar offers, taken from the whole ledger. */
export interface AnalyticsFilterOptions {
  accounts: string[]
  strategies: Array<{ key: string; label: string }>
  symbols: string[]
}

const hasAny = (list: string[] | undefined): list is string[] =>
  Array.isArray(list) && list.length > 0

export function filterClosedRows(rows: ClosedRow[], f: AnalyticsFilter): ClosedRow[] {
  const direction = f.direction && f.direction !== 'both' ? f.direction : null
  return rows.filter((r) => {
    if (f.includeNonBot === false && !isBotTrade(r)) return false
    if (direction && r.direction !== direction) return false
    if (hasAny(f.accounts) && !f.accounts.includes(r.accountId ?? '')) return false
    if (hasAny(f.symbols) && !f.symbols.includes(r.symbol)) return false
    if (hasAny(f.strategies) && !f.strategies.includes(strategyKeyOf(r))) return false
    if (f.from != null && r.closedAt < f.from) return false
    if (f.to != null && r.closedAt > f.to) return false
    return true
  })
}

/** Choices for the filter bar, built from rows BEFORE any filter is applied. */
export function filterOptionsFrom(rows: ClosedRow[]): AnalyticsFilterOptions {
  const accounts = new Set<string>()
  const symbols = new Set<string>()
  const strategies = new Map<string, string>()
  for (const r of rows) {
    if (r.accountId) accounts.add(r.accountId)
    symbols.add(r.symbol)
    strategies.set(strategyKeyOf(r), r.strategy?.trim() || UNATTRIBUTED_STRATEGY)
  }
  return {
    accounts: [...accounts].sort(),
    symbols: [...symbols].sort(),
    strategies: [...strategies.entries()]
      .map(([key, label]) => ({ key, label }))
      .sort((a, b) => {
        const aLast = a.label === UNATTRIBUTED_STRATEGY
        const bLast = b.label === UNATTRIBUTED_STRATEGY
        if (aLast !== bLast) return aLast ? 1 : -1
        return a.label.localeCompare(b.label)
      }),
  }
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
> & { account_id?: string | null; exchange?: string | null }

/**
 * Map closed signal executions to ClosedRows using the fills-based PnL. A trade
 * only counts once it has both an exit fill and a realized close quantity —
 * open/errored executions and dangling entries never enter the analytics set.
 * Returned ascending by close time (required by the cumulative + drawdown passes).
 */
export function closedRowsFromExecutions(
  executions: ClosedExecution[],
  fillsBySignal: Map<string, SignalFillRow[]>,
  labelsBySignal?: Map<string, StrategyLabel>,
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
    const label = labelsBySignal?.get(e.signal_id)
    rows.push({
      symbol: e.symbol,
      direction: e.direction,
      accountId: e.account_id ?? null,
      realizedPnl: pnl.realizedNet,
      entryAvg: pnl.entryAvg,
      exitAvg: pnl.exitAvg,
      closedAt,
      openDate,
      strategy: label?.strategy ?? null,
      signalBotId: label?.signalBotId ?? null,
    })
  }
  return rows.sort((a, b) => a.closedAt - b.closedAt)
}

/**
 * Closed executions that realized a close quantity but carry NO exit fill, so
 * there is no price to compute a result from. closedRowsFromExecutions drops
 * them, which silently shrinks the trade count — count them here so the UI can
 * say how many results it is missing instead of under-reporting in silence.
 *
 * Known producers: a close whose broker order came back pending and was later
 * flattened by the reconciler, and a manual close (its own signal id, so the
 * exit never lands on the bot's entry execution). A cancelled resting entry is
 * NOT one of these — it closes with qty_closed 0 and never traded.
 */
export function countUnpricedCloses(
  executions: ClosedExecution[],
  fillsBySignal: Map<string, SignalFillRow[]>,
): number {
  let n = 0
  for (const e of executions) {
    if (e.status !== 'closed' || e.qty_closed <= 0) continue
    const fills = fillsBySignal.get(e.signal_id) ?? []
    if (!fills.some((f) => f.kind === 'exit')) n += 1
  }
  return n
}

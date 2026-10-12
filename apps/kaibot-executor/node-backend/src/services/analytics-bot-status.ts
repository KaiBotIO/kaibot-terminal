// Run status per Analytics by-strategy row, from this Terminal's own bot configs
// and subscriptions.
//
// Mapping (matches the Subscriptions badges: active=running, paused=paused,
// cancelled=stopped): running = an active sub and no local config holding it
// back; paused = a sub exists but none active, or an active sub whose local
// configs are all paused/stopped, or a live config with no sub; stopped = no
// live config and no active/paused sub; unknown = bot id not known locally.

import { isLive, type BotConfigStatus } from './take-over.js'
import { canSeeAccount, type AccountScope } from '../auth/account-scope.js'
import { buildSummary, strategyKeyOf, UNATTRIBUTED_STRATEGY, type ClosedRow, type StrategyScorecard } from './analytics.js'

export type StrategyRunStatus = 'running' | 'paused' | 'stopped' | 'unknown'

export interface StatusConfig {
  signalBotId: string
  status: BotConfigStatus
  updatedAt: number | null
}

export interface StatusSubscription {
  signalBotId: string
  status: 'active' | 'paused' | 'cancelled'
  updatedAt: number | null
}

export interface StrategyStatus {
  status: StrategyRunStatus
  statusSince: number | null
}

// SQLite CURRENT_TIMESTAMP is 'YYYY-MM-DD HH:MM:SS' in UTC without a zone.
export function parseDbTimestamp(raw: unknown): number | null {
  if (raw == null || raw === '') return null
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  const s = String(raw)
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s) ? `${s.replace(' ', 'T')}Z` : s
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

const latest = (rows: Array<{ updatedAt: number | null }>): number | null =>
  rows.reduce<number | null>((m, r) => (r.updatedAt != null && (m == null || r.updatedAt > m) ? r.updatedAt : m), null)

export function deriveStrategyStatus(
  signalBotId: string | null,
  configs: StatusConfig[],
  subs: StatusSubscription[],
): StrategyStatus {
  if (!signalBotId) return { status: 'unknown', statusSince: null }
  const cfgs = configs.filter((c) => c.signalBotId === signalBotId)
  const mine = subs.filter((s) => s.signalBotId === signalBotId)
  if (cfgs.length === 0 && mine.length === 0) return { status: 'unknown', statusSince: null }

  const liveCfgs = cfgs.filter((c) => isLive(c.status))
  const active = mine.filter((s) => s.status === 'active')
  const paused = mine.filter((s) => s.status === 'paused')
  const configsHold = cfgs.length > 0 && liveCfgs.length === 0

  if (active.length > 0 && !configsHold) return { status: 'running', statusSince: latest(active) }
  if (active.length > 0) return { status: 'paused', statusSince: latest(cfgs) }
  if (paused.length > 0) return { status: 'paused', statusSince: latest(paused) }
  if (liveCfgs.length > 0) return { status: 'paused', statusSince: latest(liveCfgs) }
  return { status: 'stopped', statusSince: latest([...cfgs, ...mine]) }
}

export interface StrategyRowStatus extends StrategyStatus {
  openExecutions: number
}

/**
 * Adds run status and the open-execution count to each row. A bot holding an
 * open position without any closed trade yet still gets a row (empty metrics),
 * so a stopped bot with exposure never drops out of the table.
 */
export function withStrategyStatus(
  rows: StrategyScorecard[],
  configs: StatusConfig[],
  subs: StatusSubscription[],
  open: Array<Pick<ClosedRow, 'strategy' | 'signalBotId'>> = [],
): Array<StrategyScorecard & StrategyRowStatus> {
  const openByKey = new Map<string, { count: number; strategy: string; signalBotId: string | null }>()
  for (const o of open) {
    const key = strategyKeyOf(o)
    const cur = openByKey.get(key)
    if (cur) cur.count++
    else
      openByKey.set(key, {
        count: 1,
        strategy: o.strategy?.trim() || UNATTRIBUTED_STRATEGY,
        signalBotId: o.signalBotId ?? null,
      })
  }
  const known = new Set(rows.map((r) => r.key))
  const openOnly: StrategyScorecard[] = [...openByKey.entries()]
    .filter(([key]) => !known.has(key))
    .map(([key, o]) => ({
      key,
      strategy: o.strategy,
      signalBotId: o.signalBotId,
      summary: buildSummary([]),
      curve: [],
      firstTradeAt: 0,
      lastTradeAt: 0,
    }))
  return [...rows, ...openOnly].map((r) => ({
    ...r,
    ...deriveStrategyStatus(r.signalBotId, configs, subs),
    openExecutions: openByKey.get(r.key)?.count ?? 0,
  }))
}

// Subscriptions are scoped to the viewer's accounts (same rule as the
// Subscriptions route); bot configs carry no account and stay unfiltered.
export function loadStatusInputs(
  db: { all: (sql: string, params: unknown[]) => unknown[] },
  scope: AccountScope,
): { configs: StatusConfig[]; subs: StatusSubscription[] } {
  const configs = (db.all('SELECT signal_bot_id, status, updated_at FROM bot_configs', []) as Array<{
    signal_bot_id: string
    status: BotConfigStatus
    updated_at: unknown
  }>).map((r) => ({ signalBotId: r.signal_bot_id, status: r.status, updatedAt: parseDbTimestamp(r.updated_at) }))
  const subs = (db.all(
    'SELECT signal_bot_id, status, updated_at, exchange, account_id FROM executor_subscriptions',
    [],
  ) as Array<{
    signal_bot_id: string
    status: StatusSubscription['status']
    updated_at: unknown
    exchange: string | null
    account_id: string | null
  }>)
    .filter((r) => canSeeAccount(scope, r.exchange, r.account_id))
    .map((r) => ({ signalBotId: r.signal_bot_id, status: r.status, updatedAt: parseDbTimestamp(r.updated_at) }))
  return { configs, subs }
}

// Position-group identity + aggregates (G0, position-groups-visibility plan).
// Visibility ONLY: nothing in this service places, moves or cancels an order —
// grouping never changes trading behaviour (group ACTIONS are G2).
//
// Auto-grouping rules:
//   - bot config = group: a bot-driven fill lands in its bot's group, lazily
//     created on first fill (name = bot/strategy name).
//   - take-over keeps lineage: links persist through detach; positions that
//     predate grouping get a 'takeover'-sourced group at detach time (from the
//     retired trail rows, the only edge record carrying the account id).
//   - manual = Unsorted: a manual entry on a symbol with no live bot execution
//     clears a stale AUTO link (user assignments are never auto-overwritten).

import { randomUUID } from 'crypto'
import type { KaiBotDatabase } from '../storage/database.js'
import type { LocalTrailStateRow, PositionGroupRow } from '../storage/types.js'
import type { GroupAggregateState } from './edge-managers/contract.js'
import { composeEffectiveStop, positionNotional, positionTrailKey } from './position-trail.js'
import { expiryInfoForSymbol, type PositionExpiryInfo } from './exchanges/contract-expiry.js'

export interface PositionGroupInfo {
  id: string
  name: string
  source: 'bot' | 'takeover' | 'manual'
}

// One live position as the aggregator sees it (adapter Position + its venue).
export interface LivePositionRef {
  exchange: string
  accountId: string
  symbol: string
  side: 'long' | 'short'
  size: number
  entryPrice: number
  markPrice?: number
  unrealizedPnL?: number
}

export interface GroupAggregates {
  positionCount: number
  // Sum of venue-reported unrealized PnL (positions without one contribute 0).
  netUnrealizedPnl: number
  // Sum of |size| × (mark ?? entry) — gross notional at risk.
  exposure: number
  // Signed money from mark to the effective stop, summed over positions that
  // HAVE one (long: (mark − stop) × size). Positive = at risk if all stops hit;
  // negative = locked-in profit. null when no member has a stop.
  stopRisk: number | null
  // Members carrying an effective stop (stopRisk coverage).
  stoppedCount: number
}

export interface GroupedPosition extends LivePositionRef {
  positionKey: string
  group: PositionGroupInfo | null
  effectiveStop: number | null
  expiry: PositionExpiryInfo | null
}

export interface GroupOverviewEntry {
  group: PositionGroupInfo | null // null = Unsorted bucket
  aggregates: GroupAggregates
  positions: GroupedPosition[]
}

// Lazy per-bot group: one group per server bot id, created on first use.
export function ensureBotGroup(
  db: KaiBotDatabase,
  input: {
    signalBotId: string
    botConfigId?: string | null
    name?: string | null
    source?: 'bot' | 'takeover'
  },
): PositionGroupRow {
  const existing = db.getPositionGroupForBot(input.signalBotId)
  if (existing) return existing
  const id = randomUUID()
  db.createPositionGroup({
    id,
    name: input.name?.trim() || `Bot ${input.signalBotId.slice(0, 8)}`,
    source: input.source ?? 'bot',
    botConfigId: input.botConfigId ?? null,
    signalBotId: input.signalBotId,
  })
  return db.getPositionGroup(id)!
}

// Auto-link a position to a group. A 'user' assignment on the key is never
// overwritten (enforced in upsertPositionGroupLink).
export function autoLinkPosition(
  db: KaiBotDatabase,
  input: { exchange: string; accountId: string; symbol: string; groupId: string },
): void {
  db.upsertPositionGroupLink({
    positionKey: positionTrailKey(input.exchange, input.accountId, input.symbol),
    exchange: input.exchange.toLowerCase(),
    accountId: input.accountId,
    symbol: input.symbol.toUpperCase(),
    groupId: input.groupId,
    assignedBy: 'auto',
  })
}

// Manual-entry rule: when a manual entry opens on a symbol with NO live bot
// execution, a leftover AUTO link belongs to a previous (closed) position —
// clear it so the new manual position starts Unsorted. With a live bot
// execution the manual fill is an add to a bot position: the link stays.
export function clearStaleAutoLinkOnManualEntry(
  db: KaiBotDatabase,
  input: { exchange: string; accountId: string; symbol: string },
): void {
  const key = positionTrailKey(input.exchange, input.accountId, input.symbol)
  const link = db.getPositionGroupLink(key)
  if (!link || link.assigned_by !== 'auto') return
  const live = db
    .listOpenExecutionsForExchange(input.exchange)
    .some((e) => e.symbol.toUpperCase() === input.symbol.toUpperCase() && e.qty_opened > e.qty_closed)
  if (!live) db.deletePositionGroupLink(key)
}

// Take-over lineage for positions that predate grouping: the retired trail rows
// are the only edge record carrying (exchange, account, symbol) for the bot's
// positions, so link them into the bot's group (created 'takeover' if absent).
export function linkTakeoverLineage(
  db: KaiBotDatabase,
  cfg: { id: string; signalBotId: string; botName?: string; strategyName?: string },
  trails: Array<Pick<LocalTrailStateRow, 'exchange' | 'account_id' | 'symbol'>>,
): void {
  const withAccount = trails.filter((t) => t.account_id != null && t.account_id !== '')
  if (withAccount.length === 0) return
  const group = ensureBotGroup(db, {
    signalBotId: cfg.signalBotId,
    botConfigId: cfg.id,
    name: cfg.botName ?? cfg.strategyName ?? null,
    source: 'takeover',
  })
  for (const t of withAccount) {
    const key = positionTrailKey(t.exchange, t.account_id!, t.symbol)
    if (db.getPositionGroupLink(key)) continue // lineage only fills gaps
    autoLinkPosition(db, {
      exchange: t.exchange,
      accountId: t.account_id!,
      symbol: t.symbol,
      groupId: group.id,
    })
  }
}

export function groupInfoForPosition(
  db: KaiBotDatabase,
  exchange: string,
  accountId: string,
  symbol: string,
): PositionGroupInfo | null {
  const link = db.getPositionGroupLink(positionTrailKey(exchange, accountId, symbol))
  if (!link?.group_id) return null
  const group = db.getPositionGroup(link.group_id)
  return group ? { id: group.id, name: group.name, source: group.source } : null
}

// Effective stop for a live position from its active trail row (signal- or
// position-keyed — matched on the venue coordinates, same as one-stop-owner).
function effectiveStopFor(
  trails: LocalTrailStateRow[],
  p: LivePositionRef,
): number | null {
  const row = trails.find(
    (t) =>
      t.exchange.toLowerCase() === p.exchange.toLowerCase() &&
      t.symbol.toUpperCase() === p.symbol.toUpperCase() &&
      (t.account_id == null || t.account_id === p.accountId),
  )
  if (!row) return null
  return composeEffectiveStop({
    direction: row.direction,
    manualStop: row.manual_stop,
    engineStop: row.engine_stop ?? row.current_stop,
    trailingLock: !!row.trailing_lock,
  })
}

export function computeGroupAggregates(positions: GroupedPosition[]): GroupAggregates {
  let pnl = 0
  let exposure = 0
  let stopRisk = 0
  let stoppedCount = 0
  for (const p of positions) {
    const mark = p.markPrice && p.markPrice > 0 ? p.markPrice : p.entryPrice
    pnl += p.unrealizedPnL ?? 0
    exposure += positionNotional(p)
    if (p.effectiveStop != null) {
      const perUnit = p.side === 'long' ? mark - p.effectiveStop : p.effectiveStop - mark
      stopRisk += perUnit * Math.abs(p.size)
      stoppedCount++
    }
  }
  return {
    positionCount: positions.length,
    netUnrealizedPnl: pnl,
    exposure,
    stopRisk: stoppedCount > 0 ? stopRisk : null,
    stoppedCount,
  }
}

// Group aggregates for the edge manager runtime (G2, group-risk-guard):
// one GroupAggregateState per group with members among `live`, FROZEN from the
// positions fetched at the poll cycle's start — every member's guard sees the
// same aggregates this cycle, mirroring the backtester's per-bar freeze.
// Equity basis = summed latest balance snapshots of the members' accounts;
// none recorded yet → null (loss-fraction checks stay inert).
export function buildGroupAggregateStates(
  db: KaiBotDatabase,
  live: LivePositionRef[],
): Map<string, GroupAggregateState> {
  const members = new Map<string, LivePositionRef[]>()
  for (const p of live) {
    const group = groupInfoForPosition(db, p.exchange, p.accountId, p.symbol)
    if (!group) continue
    members.set(group.id, [...(members.get(group.id) ?? []), p])
  }
  const out = new Map<string, GroupAggregateState>()
  for (const [groupId, positions] of members) {
    let pnl = 0
    let notional = 0
    for (const p of positions) {
      pnl += p.unrealizedPnL ?? 0
      notional += positionNotional(p)
    }
    let equity: number | null = null
    const seen = new Set<string>()
    for (const p of positions) {
      const acctKey = `${p.exchange.toLowerCase()}:${p.accountId}`
      if (seen.has(acctKey)) continue
      seen.add(acctKey)
      const snap = db.getLatestBalanceSnapshot(p.exchange, p.accountId)
      if (snap) equity = (equity ?? 0) + snap.equity
    }
    out.set(groupId, {
      groupId,
      memberCount: positions.length,
      unrealizedPnl: pnl,
      notional,
      equity,
    })
  }
  return out
}

// Join live positions against links/groups and bucket them, Unsorted last.
export function buildGroupOverview(
  db: KaiBotDatabase,
  live: LivePositionRef[],
  activeTrails: LocalTrailStateRow[],
): GroupOverviewEntry[] {
  const grouped: GroupedPosition[] = live.map((p) => ({
    ...p,
    positionKey: positionTrailKey(p.exchange, p.accountId, p.symbol),
    group: groupInfoForPosition(db, p.exchange, p.accountId, p.symbol),
    effectiveStop: effectiveStopFor(activeTrails, p),
    expiry: expiryInfoForSymbol(p.symbol),
  }))
  const byGroup = new Map<string, GroupedPosition[]>()
  const unsorted: GroupedPosition[] = []
  for (const p of grouped) {
    if (!p.group) {
      unsorted.push(p)
      continue
    }
    const list = byGroup.get(p.group.id) ?? []
    list.push(p)
    byGroup.set(p.group.id, list)
  }
  const entries: GroupOverviewEntry[] = []
  for (const [, positions] of byGroup) {
    entries.push({
      group: positions[0].group,
      aggregates: computeGroupAggregates(positions),
      positions,
    })
  }
  entries.sort((a, b) => (a.group!.name < b.group!.name ? -1 : 1))
  if (unsorted.length > 0) {
    entries.push({ group: null, aggregates: computeGroupAggregates(unsorted), positions: unsorted })
  }
  return entries
}

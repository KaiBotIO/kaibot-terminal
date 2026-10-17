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

import { syntheticHedgeFor, type SyntheticHedgeInfo } from './synthetic-hedge-info.js'
import { randomUUID } from 'crypto'
import type { KaiBotDatabase } from '../storage/database.js'
import type { LocalTrailStateRow, PositionGroupRow } from '../storage/types.js'
import type { GroupAggregateState } from './edge-managers/contract.js'
import { composeEffectiveStop, positionNotional, positionTrailKey } from './position-trail.js'
import { pnlCurrencyOf, positionNotionalUsd, positionPnlSinceEntryUsd } from './exchanges/futures-contracts.js'
import { expiryInfoForSymbol, type PositionExpiryInfo } from './exchanges/contract-expiry.js'
import { ladderForPosition, type LadderSnapshot } from './bot-config-sync.js'
import { activeRideFor } from './ride-state.js'
import { hedgeLegsOn, type HedgeLegKind } from './venue-hedge-legs.js'
import { nettedClosePlan } from './netted-close.js'

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
  // Sum of P&L since entry in USD (positionPnlSinceEntryUsd); members that
  // can't be valued are left out and clear netUnrealizedPnlComplete.
  netUnrealizedPnl: number
  netUnrealizedPnlComplete: boolean
  // Sum of |size| × (mark ?? entry) — gross notional at risk.
  exposure: number
  // USD from mark to the effective stop, summed over positions that HAVE one
  // (same per-contract rule as the P&L). Positive = at risk if all stops hit;
  // negative = locked-in profit. null when no member has a stop.
  stopRisk: number | null
  // Members carrying an effective stop (stopRisk coverage).
  stoppedCount: number
}

export type LadderLookup = (signalBotId: string, symbol: string) => LadderSnapshot | null

export interface GroupedPosition extends LivePositionRef {
  positionKey: string
  group: PositionGroupInfo | null
  effectiveStop: number | null
  expiry: PositionExpiryInfo | null
  ladder: LadderSnapshot | null
  // Server-side ride this position was handed to (ride hand-over), if any.
  ride: { positionId: string; botId: string | null; botName: string | null } | null
  // Synthetic USD hedge this short is, if any.
  synthetic: SyntheticHedgeInfo | null
  // Set when the venue nets a floor/synthetic hedge on this (account, symbol):
  // the row is one leg of that one venue position.
  leg: VenueLegInfo | null
  // Why a group close must leave this bots' leg alone (netted inside a hedge).
  closeBlockedReason: string | null
  // P&L since entry in USD; null when it can't be valued.
  unrealizedPnLUsd: number | null
  // Currency the venue figure `unrealizedPnL` is in (base coin on inverse).
  pnlCurrency: string
}

export interface VenueLegInfo {
  kind: 'bots' | HedgeLegKind
  // Signed net the venue holds on the (account, symbol).
  venueNet: number
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

export function groupRowForPosition(
  db: KaiBotDatabase,
  exchange: string,
  accountId: string,
  symbol: string,
): PositionGroupRow | null {
  const link = db.getPositionGroupLink(positionTrailKey(exchange, accountId, symbol))
  if (!link?.group_id) return null
  return db.getPositionGroup(link.group_id) ?? null
}

export function groupInfoForPosition(
  db: KaiBotDatabase,
  exchange: string,
  accountId: string,
  symbol: string,
): PositionGroupInfo | null {
  const group = groupRowForPosition(db, exchange, accountId, symbol)
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
  let pnlComplete = true
  let exposure = 0
  let stopRisk = 0
  let stoppedCount = 0
  for (const p of positions) {
    const mark = p.markPrice && p.markPrice > 0 ? p.markPrice : p.entryPrice
    const usd = positionPnlSinceEntryUsd(p)
    if (usd == null) pnlComplete = false
    else pnl += usd
    // Display exposure in USD per contract kind. The guard-side aggregate
    // (buildGroupAggregateStates) keeps the sim's |size| x mark contract.
    exposure += positionNotionalUsd({ exchange: p.exchange, symbol: p.symbol, size: p.size, price: mark })
    if (p.effectiveStop != null) {
      // Loss from mark to stop = P&L of a position entered at the mark, marked at the stop.
      const toStop = positionPnlSinceEntryUsd({ ...p, entryPrice: mark, markPrice: p.effectiveStop })
      stopRisk -= toStop ?? 0
      stoppedCount++
    }
  }
  return {
    positionCount: positions.length,
    netUnrealizedPnl: pnl,
    netUnrealizedPnlComplete: pnlComplete,
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

function rideFor(db: KaiBotDatabase, p: LivePositionRef) {
  try {
    const r = activeRideFor(db, p.exchange, p.accountId, p.symbol)
    return r ? { positionId: r.positionId, botId: r.botId, botName: r.botName } : null
  } catch {
    return null
  }
}

function botLegEntry(db: KaiBotDatabase, p: LivePositionRef): number | null {
  try {
    const ids = db
      .listOpenExecutionsForExchange(p.exchange)
      .filter(
        (e) =>
          (e as { account_id?: string | null }).account_id === p.accountId &&
          e.symbol.toUpperCase() === p.symbol.toUpperCase(),
      )
      .map((e) => e.signal_id)
    if (ids.length === 0) return null
    let qty = 0
    let cost = 0
    for (const f of db.getFillsForSignals(ids)) {
      if (f.kind !== 'entry' || f.price == null || !(f.price > 0)) continue
      qty += f.qty
      cost += f.qty * f.price
    }
    return qty > 0 ? cost / qty : null
  } catch {
    return null
  }
}

/**
 * One venue position → its legs. A perp nets a floor/synthetic hedge with the
 * bots' exposure (2026-10-14: ETH hedge -12.356 + Fault Line +1.972 = venue
 * -10.384); each hedge becomes its own row and the remainder is the bots'.
 * The venue's own P&L figure covers the net, so legs drop it and are valued
 * from their own entry.
 */
export function venueLegs(
  db: KaiBotDatabase,
  p: LivePositionRef,
): Array<{ ref: LivePositionRef; leg: VenueLegInfo | null; hedgeId: string | null }> {
  const hedges = hedgeLegsOn(db, p.exchange, p.symbol, (a) => a === p.accountId)
  if (hedges.length === 0) return [{ ref: p, leg: null, hedgeId: null }]
  const venueNet = p.side === 'long' ? Math.abs(p.size) : -Math.abs(p.size)
  const legRef = (net: number, entryPrice: number | null): LivePositionRef => ({
    ...p,
    side: net < 0 ? 'short' : 'long',
    size: Math.abs(net),
    entryPrice: entryPrice ?? p.entryPrice,
    unrealizedPnL: undefined,
  })
  const rest = venueNet - hedges.reduce((a, h) => a + h.net, 0)
  const hasRest = Math.abs(rest) > 1e-9 * Math.max(1, Math.abs(venueNet))
  // The venue position IS the hedge: one row, venue figures intact.
  if (!hasRest && hedges.length === 1) return [{ ref: p, leg: null, hedgeId: hedges[0].id }]
  const out: Array<{ ref: LivePositionRef; leg: VenueLegInfo; hedgeId: string | null }> = hedges.map((h) => ({
    ref: legRef(h.net, h.entryPrice),
    leg: { kind: h.kind, venueNet },
    hedgeId: h.id,
  }))
  if (hasRest) out.push({ ref: legRef(rest, botLegEntry(db, p)), leg: { kind: 'bots', venueNet }, hedgeId: null })
  return out
}

function closeBlockedReasonOf(db: KaiBotDatabase, venue: LivePositionRef, leg: VenueLegInfo | null): string | null {
  if (leg?.kind !== 'bots') return null
  try {
    const plan = nettedClosePlan(db, venue, 'bots')
    return plan.kind === 'blocked' ? plan.reason : null
  } catch (err) {
    return `${venue.symbol}: hedge lookup failed (${err instanceof Error ? err.message : String(err)}).`
  }
}

// Join live positions against links/groups and bucket them, Unsorted last.
export function buildGroupOverview(
  db: KaiBotDatabase,
  live: LivePositionRef[],
  activeTrails: LocalTrailStateRow[],
  ladderLookup?: LadderLookup,
): GroupOverviewEntry[] {
  const grouped: GroupedPosition[] = live.flatMap((venue) =>
    venueLegs(db, venue).map(({ ref: p, leg, hedgeId }) => {
      const key = positionTrailKey(p.exchange, p.accountId, p.symbol)
      // A hedge leg is the account's floor, never a bot's position.
      const group = hedgeId ? null : groupRowForPosition(db, p.exchange, p.accountId, p.symbol)
      return {
        ...p,
        positionKey: hedgeId && leg ? `${key}#hedge:${hedgeId}` : key,
        group: group ? { id: group.id, name: group.name, source: group.source } : null,
        effectiveStop: hedgeId ? null : effectiveStopFor(activeTrails, p),
        expiry: expiryInfoForSymbol(p.symbol),
        ladder: ladderForPosition(ladderLookup, group?.signal_bot_id, p),
        ride: hedgeId ? null : rideFor(db, p),
        synthetic: leg?.kind === 'bots' ? null : syntheticHedgeFor(db, p.exchange, p),
        leg,
        closeBlockedReason: closeBlockedReasonOf(db, venue, leg),
        unrealizedPnLUsd: positionPnlSinceEntryUsd(p),
        pnlCurrency: pnlCurrencyOf(p.exchange, p.symbol),
      }
    }),
  )
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

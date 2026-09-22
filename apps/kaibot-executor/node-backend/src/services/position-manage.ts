// Attach/adjust/remove an edge trail + break-even on ANY open position — manual
// positions included (F1, pilot-ladder decomposition). Reduce/protect-only by
// design: this service moves PROTECTIVE stops; it never places an entry (§3
// design rule — entries are authored, never edge-decided).
//
// One stop owner per position: arming adopts the position's existing protective
// stop order as the seed (from the manual/signal bracket, or from a sibling
// trail row which is then retired) — from that point the trail's cancel/replace
// machinery owns the stop. Removing the trail leaves the last resting stop in
// place as static protection; it never strips a stop.

import type { KaiBotDatabase } from '../storage/database.js'
import type { LocalTrailStateRow } from '../storage/types.js'
import type { ExchangeManager } from './exchanges/exchangeManager.js'
import { withOrderLock } from './order-lock.js'
import { composeEffectiveStop, positionTrailKey } from './position-trail.js'
import { accountKeyOf, rowOnAccount } from './exchanges/account-scope.js'

export type ManageAction = 'arm' | 'update' | 'lock' | 'unlock' | 'remove'

export interface ManageTrailParams {
  mode: 'fixed' | 'drawdown'
  // fixed: constant trail distance; drawdown: floor on the trail distance (the
  // carried drawdown depth is ~0 right after arming). Points win over pct.
  trailPercentage?: number | null
  trailPoints?: number | null
  // Caps (fixed: on the distance; drawdown: on the depth — defaults 40% / 500pt).
  maxPercentage?: number | null
  maxPoints?: number | null
  // Drawdown only: trail off a FIXED pre-arm swing instead of the advancing
  // favourable extreme. Anchor = referencePrice (defaults to the arm-time mark).
  freezeExtreme?: boolean
  referencePrice?: number | null
  // Force point-based drawdown maths on any venue (else TradeStation => points).
  usePoints?: boolean
}

export interface ManagePositionInput {
  action: ManageAction
  exchange: string
  symbol: string
  accountId?: string
  // Trail component. null on 'update' switches the trail off (BE may remain).
  trail?: ManageTrailParams | null
  // Break-even fee fraction (e.g. 0.0015). null on 'update' switches BE off.
  breakevenFee?: number | null
  // The user's own stop — always participates; under lock it is absolute.
  // null on 'update' clears it.
  manualStop?: number | null
  trailingLock?: boolean
}

export interface ManagedTrailView {
  key: string
  exchange: string
  accountId: string | null
  symbol: string
  direction: 'long' | 'short'
  source: 'signal' | 'manual'
  mode: 'fixed' | 'drawdown'
  entryPrice: number
  trailPercentage: number | null
  trailPoints: number | null
  maxPercentage: number | null
  maxPoints: number | null
  breakevenFee: number | null
  freezeExtreme: boolean
  usePoints: boolean
  referencePrice: number | null
  trailingLock: boolean
  manualStop: number | null
  engineStop: number | null
  // The stop actually resting at the venue right now.
  currentStop: number | null
  // What the composition rule resolves to with today's state.
  effectiveStop: number | null
  extremePrice: number
  oppositePrice: number | null
  active: boolean
  updatedAt: number
}

export interface PositionManageService {
  manage(input: ManagePositionInput): Promise<ManagedTrailView>
  list(): ManagedTrailView[]
}

function toView(row: LocalTrailStateRow): ManagedTrailView {
  const effective = composeEffectiveStop({
    direction: row.direction,
    manualStop: row.manual_stop,
    engineStop: row.engine_stop ?? row.current_stop,
    trailingLock: !!row.trailing_lock,
  })
  return {
    key: row.signal_id,
    exchange: row.exchange,
    accountId: row.account_id,
    symbol: row.symbol,
    direction: row.direction,
    source: row.source,
    mode: row.mode,
    entryPrice: row.entry_price,
    trailPercentage: row.mode === 'drawdown' ? row.min_percentage : row.trail_percentage,
    trailPoints: row.mode === 'drawdown' ? row.min_points : row.trail_points,
    maxPercentage: row.max_percentage,
    maxPoints: row.max_points,
    breakevenFee: row.breakeven_fee,
    freezeExtreme: !!row.freeze_extreme,
    usePoints: !!row.use_points,
    referencePrice: row.reference_price,
    trailingLock: !!row.trailing_lock,
    manualStop: row.manual_stop,
    engineStop: row.engine_stop,
    currentStop: row.current_stop,
    effectiveStop: effective,
    extremePrice: row.extreme_price,
    oppositePrice: row.opposite_price,
    active: row.active === 1,
    updatedAt: row.updated_at,
  }
}

const isPos = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0

export interface AdoptableStopSeed {
  slOrderId: string
  bracketSignalId: string | null
  // Last known stop LEVEL of the adopted order, when derivable — seeds the
  // favourable-only ratchet so the trail never loosens the inherited stop.
  currentStop: number | null
}

// The position's resting protective stop, if any — the order a fresh stop
// owner adopts as its seed. SOURCE-AGNOSTIC (F3, take-over re-attach), in
// preference order:
//   1. manual entry bracket (the SL the user typed at order time — F0/F1),
//   2. an open executed entry signal's bracket (the BOT's stop, still resting
//      after take-over paused the config),
//   3. the most recently RETIRED trail row on the symbol (the bot trail
//      detachBot deactivated — it owned the live stop last and knows its level).
// Shared with the edge manager engine, which creates a stop-owner shell when a
// stop-emitting manager is attached to a position that has no trail yet (one
// adoption rule, not two). `live` guards against stale rows: a stop level on
// the wrong side of the current mark would already have fired, so such a
// candidate's level is dropped (id adoption still degrades safely: cancelling
// a dead order is a no-op).
export function findAdoptableStopSeed(
  db: KaiBotDatabase,
  exchange: string,
  symbol: string,
  live: { direction: 'long' | 'short'; mark: number },
  // Account the position lives on. Every candidate (bracket pair, manual entry,
  // retired trail) must sit on this account: two connections can each hold
  // the same instrument with their own resting stop (2026-09-22, the acct1
  // adoption took the default connection's ETH stop). Omitted = unscoped.
  accountId?: string | null,
): AdoptableStopSeed | null {
  const protective = (stop: number | null | undefined): number | null =>
    stop != null && (live.direction === 'long' ? stop < live.mark : stop > live.mark)
      ? stop
      : null

  const pairs = db
    .listBracketPairs()
    .filter((p) => p.exchange === exchange && p.sl_order_id && rowOnAccount(p.account_id, accountId))
  // Freshest stop knowledge for a candidate order id: the retired trail that
  // last owned it (its current_stop tracked every cancel/replace).
  const retired = db.findLatestRetiredTrailForSymbol(exchange, symbol, accountId)
  const retiredStopFor = (slOrderId: string): number | null =>
    retired && retired.sl_order_id === slOrderId ? protective(retired.current_stop) : null

  // 1) Manual entry bracket.
  const manualIds = new Set(db.listManualEntrySignalIds(exchange, symbol, accountId))
  const manualPair = pairs.find((p) => manualIds.has(p.signal_id))
  if (manualPair) {
    return {
      slOrderId: manualPair.sl_order_id!,
      bracketSignalId: manualPair.signal_id,
      currentStop: retiredStopFor(manualPair.sl_order_id!),
    }
  }

  // 2) Open executed entry signal bracket (bot position after take-over). Only
  //    same-direction entries on this account: an opposing entry's stop
  //    protects nothing here, another account's entry is not this position.
  const openEntries = db
    .getOpenEntrySignals(symbol)
    .filter((s) => (s.action === 'buy') === (live.direction === 'long'))
    .filter((s) => {
      if (accountId == null) return true
      const exec = db.getSignalExecution(s.id)
      return !exec?.account_id || exec.account_id === accountId
    })
  const openById = new Map(openEntries.map((s) => [s.id, s]))
  const botPair = pairs.find((p) => openById.has(p.signal_id))
  if (botPair) {
    const sig = openById.get(botPair.signal_id)!
    return {
      slOrderId: botPair.sl_order_id!,
      bracketSignalId: botPair.signal_id,
      // Prefer the retired trail's level (it moved the stop); fall back to the
      // signal's original bracket stop.
      currentStop: retiredStopFor(botPair.sl_order_id!) ?? protective(sig.stop_loss),
    }
  }

  // 3) Retired trail fallback (bot trail without a surviving bracket pair). A
  //    wrong-side stop level means the order already fired → stale row, skip.
  if (retired && retired.direction === live.direction) {
    const stop = protective(retired.current_stop)
    if (stop != null || retired.current_stop == null) {
      return {
        slOrderId: retired.sl_order_id!,
        bracketSignalId: retired.bracket_signal_id,
        currentStop: stop,
      }
    }
  }
  return null
}

// Validate the protective components. Exported pure so the rules are
// unit-testable without an adapter.
export function validateManageComponents(input: {
  trail?: ManageTrailParams | null
  breakevenFee?: number | null
  manualStop?: number | null
}): void {
  const t = input.trail
  if (t) {
    if (t.mode !== 'fixed' && t.mode !== 'drawdown') {
      throw new Error("trail.mode must be 'fixed' or 'drawdown'")
    }
    const pct = t.trailPercentage
    const pts = t.trailPoints
    if (pct != null && !isPos(pct)) throw new Error('trail percentage must be positive')
    if (pts != null && !isPos(pts)) throw new Error('trail points must be positive')
    if (t.maxPercentage != null && !isPos(t.maxPercentage)) throw new Error('max percentage must be positive')
    if (t.maxPoints != null && !isPos(t.maxPoints)) throw new Error('max points must be positive')
    if (t.referencePrice != null && !isPos(t.referencePrice)) throw new Error('reference price must be positive')
    if (t.mode === 'fixed' && !isPos(pct) && !isPos(pts)) {
      throw new Error('a fixed trail needs a positive distance (percentage or points)')
    }
    if (t.mode === 'drawdown' && !isPos(pct) && !isPos(pts) && t.referencePrice == null) {
      // Depth right after arming is ~0 — without a floor or a pre-arm anchor the
      // stop would sit on the price and noise-close the position instantly.
      throw new Error('a drawdown trail needs a distance floor (percentage or points) or a reference price')
    }
  }
  if (input.breakevenFee != null && !(typeof input.breakevenFee === 'number' && Number.isFinite(input.breakevenFee) && input.breakevenFee >= 0 && input.breakevenFee < 0.2)) {
    throw new Error('breakevenFee must be a fraction in [0, 0.2)')
  }
  if (input.manualStop != null && !isPos(input.manualStop)) {
    throw new Error('manualStop must be a positive price')
  }
  if (!t && input.breakevenFee == null && input.manualStop == null) {
    throw new Error('nothing to arm: provide a trail, a break-even fee, or a manual stop')
  }
}

export function createPositionManageService(
  db: KaiBotDatabase,
  exchangeManager: ExchangeManager,
  deps: { userId?: string } = {},
): PositionManageService {
  const userId = deps.userId ?? 'default'

  async function adapterFor(exchange: string, accountId?: string | null) {
    const session = await exchangeManager.getSession(userId, exchange, accountKeyOf(accountId))
    if (!session || session.status !== 'connected') {
      throw new Error(`exchange ${exchange} not connected`)
    }
    return session.adapter
  }

  async function arm(input: ManagePositionInput): Promise<ManagedTrailView> {
    validateManageComponents(input)

    const adapter = await adapterFor(input.exchange, input.accountId)
    const positions = await adapter.getPositions()
    const live = positions.find(
      (p) =>
        p.symbol.toLowerCase() === input.symbol.toLowerCase() &&
        Math.abs(p.size) > 0 &&
        (input.accountId == null || p.accountId === input.accountId),
    )
    if (!live) throw new Error(`no open position for ${input.symbol} on ${input.exchange}`)

    const direction = live.side
    const entryPrice = live.entryPrice
    const mark = live.markPrice != null && live.markPrice > 0 ? live.markPrice : entryPrice
    const accountId = input.accountId ?? live.accountId

    // A stop must protect: below the market for a long, above it for a short.
    if (input.manualStop != null) {
      const protective = direction === 'long' ? input.manualStop < mark : input.manualStop > mark
      if (!protective) {
        throw new Error(
          `manualStop must be ${direction === 'long' ? 'below' : 'above'} the current price (${mark})`,
        )
      }
    }

    const key = positionTrailKey(input.exchange, accountId, input.symbol)

    // Arm mutates who owns the protective stop — do it under the order lock so
    // it can't race an in-flight cancel/replace tick for a sibling row.
    return withOrderLock(input.exchange, async () => {
      // ONE stop owner per position: adopt the seed (stop order id + last known
      // stop) from any sibling trail on this position, then retire the sibling.
      // A position is (exchange, ACCOUNT, symbol): a same-symbol trail on a
      // DIFFERENT account is another position's stop owner — adopting it steals
      // that account's venue stop and retires its trail (multi-account MNQ
      // incident, vangnet 2026-08-24).
      let seedSlOrderId: string | null = null
      let seedCurrentStop: number | null = null
      let seedBracketSignalId: string | null = null
      for (const sibling of db.findActiveTrailsForSymbol(input.exchange, input.symbol)) {
        if (sibling.signal_id === key) continue
        if (sibling.account_id != null && sibling.account_id !== accountId) continue
        if (seedSlOrderId == null && sibling.sl_order_id) {
          seedSlOrderId = sibling.sl_order_id
          seedCurrentStop = sibling.current_stop
          seedBracketSignalId = sibling.bracket_signal_id
        }
        db.deactivateLocalTrail(sibling.signal_id)
        db.log('info', 'trading', 'Sibling trail retired on manual arm (one stop owner)', {
          key, retired: sibling.signal_id,
        })
      }
      // Re-arm on the same key keeps its own seed.
      const existing = db.getLocalTrail(key)
      if (existing?.active === 1) {
        seedSlOrderId = seedSlOrderId ?? existing.sl_order_id
        seedCurrentStop = seedCurrentStop ?? existing.current_stop
        seedBracketSignalId = seedBracketSignalId ?? existing.bracket_signal_id
      }
      // Else adopt the position's resting protective stop — source-agnostic:
      // manual entry bracket, an open bot signal's bracket (take-over
      // re-attach), or the retired bot trail's stop. The trail takes the order
      // over as its seed; every later move rebinds the bracket to the new id.
      if (seedSlOrderId == null) {
        const seed = findAdoptableStopSeed(db, input.exchange, input.symbol, { direction, mark }, accountId)
        if (seed) {
          seedSlOrderId = seed.slOrderId
          seedBracketSignalId = seed.bracketSignalId
          seedCurrentStop = seed.currentStop
        }
      }

      const trail = input.trail ?? null
      const freezeExtreme = !!trail?.freezeExtreme
      // Frozen anchor: the user's pre-arm swing, else snapshot the arm-time mark.
      const referencePrice = trail?.referencePrice ?? (freezeExtreme ? mark : null)

      db.upsertLocalTrailState({
        signalId: key,
        exchange: input.exchange,
        symbol: input.symbol,
        direction,
        entryPrice,
        slOrderId: seedSlOrderId,
        // fixed: distance; drawdown: min floor lives in min_*.
        trailPercentage: trail && trail.mode === 'fixed' ? trail.trailPercentage ?? null : null,
        trailPoints: trail && trail.mode === 'fixed' ? trail.trailPoints ?? null : null,
        minPercentage: trail && trail.mode === 'drawdown' ? trail.trailPercentage ?? null : null,
        minPoints: trail && trail.mode === 'drawdown' ? trail.trailPoints ?? null : null,
        maxPercentage: trail?.maxPercentage ?? null,
        maxPoints: trail?.maxPoints ?? null,
        breakevenFee: input.breakevenFee ?? null,
        // Water marks start at the arm-time mark: the trail manages the position
        // from NOW (the human takes the wheel here, not retroactively).
        extremePrice: mark,
        oppositePrice: mark,
        currentStop: input.manualStop ?? seedCurrentStop,
        source: 'manual',
        accountId,
        mode: trail?.mode ?? 'fixed',
        usePoints: !!trail?.usePoints,
        freezeExtreme,
        trailingLock: !!input.trailingLock,
        manualStop: input.manualStop ?? null,
        engineStop: null,
        referencePrice,
        bracketSignalId: seedBracketSignalId,
      })
      db.log('info', 'trading', 'Edge trail armed on position', {
        key, exchange: input.exchange, symbol: input.symbol, direction,
        mode: trail?.mode ?? 'fixed', breakeven: input.breakevenFee != null,
        manualStop: input.manualStop ?? undefined, seedSlOrderId: seedSlOrderId ?? undefined,
      })
      return toView(db.getLocalTrail(key)!)
    })
  }

  async function resolveActiveRow(input: ManagePositionInput): Promise<LocalTrailStateRow> {
    const rows = db
      .findActiveTrailsForSymbol(input.exchange, input.symbol)
      .filter((r) => input.accountId == null || r.account_id == null || r.account_id === input.accountId)
    if (rows.length === 0) {
      throw new Error(`no active trail on ${input.symbol} (${input.exchange})`)
    }
    return rows[0]
  }

  async function update(input: ManagePositionInput): Promise<ManagedTrailView> {
    const row = await resolveActiveRow(input)
    // Partial semantics: only the provided components change. Reuse arm for a
    // full re-parameterization (it upserts on the same key).
    if (input.manualStop !== undefined && input.manualStop != null && !isPos(input.manualStop)) {
      throw new Error('manualStop must be a positive price')
    }
    const fields: Parameters<KaiBotDatabase['updateLocalTrail']>[1] = {}
    if (input.manualStop !== undefined) fields.manualStop = input.manualStop
    if (input.trailingLock !== undefined) fields.trailingLock = input.trailingLock
    if (Object.keys(fields).length === 0) {
      throw new Error('nothing to update: provide manualStop and/or trailingLock')
    }
    db.updateLocalTrail(row.signal_id, fields)
    return toView(db.getLocalTrail(row.signal_id)!)
  }

  async function setLock(input: ManagePositionInput, locked: boolean): Promise<ManagedTrailView> {
    const row = await resolveActiveRow(input)
    db.updateLocalTrail(row.signal_id, {
      trailingLock: locked,
      ...(input.manualStop !== undefined ? { manualStop: input.manualStop } : {}),
    })
    return toView(db.getLocalTrail(row.signal_id)!)
  }

  async function remove(input: ManagePositionInput): Promise<ManagedTrailView> {
    const row = await resolveActiveRow(input)
    // Detach only — the last resting stop stays at the venue as static
    // protection. Removing a trail must never strip a protective order.
    db.deactivateLocalTrail(row.signal_id)
    db.log('info', 'trading', 'Edge trail removed from position', {
      key: row.signal_id, exchange: row.exchange, symbol: row.symbol,
      restingStop: row.sl_order_id ?? undefined,
    })
    return toView(db.getLocalTrail(row.signal_id)!)
  }

  async function manage(input: ManagePositionInput): Promise<ManagedTrailView> {
    switch (input.action) {
      case 'arm':
        return arm(input)
      case 'update':
        return update(input)
      case 'lock':
        return setLock(input, true)
      case 'unlock':
        return setLock(input, false)
      case 'remove':
        return remove(input)
      default:
        throw new Error(`unknown action: ${String((input as { action?: unknown }).action)}`)
    }
  }

  function list(): ManagedTrailView[] {
    return db.listActiveLocalTrails().map(toView)
  }

  return { manage, list }
}

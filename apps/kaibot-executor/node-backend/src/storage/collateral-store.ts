// Collateral floor persistence (migration 043). Kept out of database.ts: the
// feature owns three small tables and only needs the generic run/get/all.

import type { KaiBotDatabase } from './database.js'

export type FloorMode = 'hedge' | 'sell'
export type FloorStatus = 'armed' | 'fired' | 'closed'
export type SizingBasisMode = 'off' | 'floor'
export type UnflooredMode = 'exclude' | 'margin'
// What protects the virtual lines: nothing, or a perp short on the sell floor's breach.
export type VirtualCoverage = 'none' | 'hedge'
export type HedgeAlertTrap = 'near' | 'fired' | 'mmr'
export type HedgeAlerts = Partial<Record<HedgeAlertTrap, { at: number; title: string; body: string }>>
// Per floor: sent alerts (one per trap per arm cycle), the last refusal and
// the leg status seen last tick (detects fire and re-arm).
export interface HedgeState {
  alerts: HedgeAlerts
  error: string | null
  // Dedup key of `error` (refused:lev|liq|resize…): amounts in the text move every tick.
  errorKey: string | null
  legStatus: 'armed' | 'open' | null
}

export interface CollateralFloorRow {
  id: string
  exchange: string
  account_id: string
  coin: string
  mode: FloorMode
  status: FloorStatus
  symbol: string
  holdings_coin: number
  trigger_price: number
  trigger_price_initial: number | null
  high_water: number | null
  trail_pct: number | null
  recovery_pct: number | null
  tolerance_pct: number
  buy_back: number
  synthetic_position_id: string | null
  venue_order_id: string | null
  venue_order_link_id: string | null
  venue_order_side: 'buy' | 'sell' | null
  venue_trigger_price: number | null
  fired_trigger_price: number | null
  fired_price: number | null
  fired_qty: number | null
  fired_at: number | null
  proceeds_usd: number | null
  cycle: number
  last_mark: number | null
  last_mark_at: number | null
  last_check_at: number | null
  last_amend_at: number | null
  last_error: string | null
  virtual_hedge: number
  virtual_hedge_id: string | null
  hedge_state: string | null
  created_at: number
  updated_at: number
}

export interface CollateralSettingsRow {
  exchange: string
  account_id: string
  sizing_basis: SizingBasisMode
  unfloored: UnflooredMode
  block_mmr_pct: number
  warn_mmr_pct: number
  auto_reduce: number
  auto_reduce_pct: number
  ratio_overrides: string
  virtual_coverage?: VirtualCoverage
  last_warn_at: number | null
  last_auto_reduce_at: number | null
  updated_at: number
}

export interface CollateralSettings {
  exchange: string
  accountId: string
  sizingBasis: SizingBasisMode
  unfloored: UnflooredMode
  blockMmrPct: number
  warnMmrPct: number
  autoReduce: boolean
  autoReducePct: number
  ratioOverrides: Record<string, number>
  virtualCoverage: VirtualCoverage
}

export const DEFAULT_BLOCK_MMR_PCT = 60
export const DEFAULT_WARN_MMR_PCT = 80
export const DEFAULT_AUTO_REDUCE_PCT = 50

type FloorPatch = Partial<Omit<CollateralFloorRow, 'id' | 'exchange' | 'account_id' | 'coin' | 'created_at'>>

// Defensive on the db surface: test doubles without run/get/all read as empty.
function has(db: KaiBotDatabase, m: 'run' | 'get' | 'all'): boolean {
  return typeof (db as Partial<KaiBotDatabase>)[m] === 'function'
}

export function insertCollateralFloor(
  db: KaiBotDatabase,
  row: Pick<
    CollateralFloorRow,
    | 'id' | 'exchange' | 'account_id' | 'coin' | 'mode' | 'status' | 'symbol' | 'holdings_coin'
    | 'trigger_price' | 'trail_pct' | 'recovery_pct' | 'tolerance_pct' | 'buy_back'
  > & Partial<CollateralFloorRow>,
): CollateralFloorRow {
  const now = Date.now()
  db.run(
    `INSERT INTO collateral_floors
       (id, exchange, account_id, coin, mode, status, symbol, holdings_coin, trigger_price,
        trigger_price_initial, high_water, trail_pct, recovery_pct, tolerance_pct, buy_back,
        synthetic_position_id, venue_order_link_id, last_mark, last_mark_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id, row.exchange.toLowerCase(), row.account_id, row.coin.toUpperCase(), row.mode, row.status,
      row.symbol.toUpperCase(), row.holdings_coin, row.trigger_price, row.trigger_price_initial ?? row.trigger_price,
      row.high_water ?? null, row.trail_pct, row.recovery_pct, row.tolerance_pct, row.buy_back,
      row.synthetic_position_id ?? null, row.venue_order_link_id ?? null, row.last_mark ?? null,
      row.last_mark_at ?? null, now, now,
    ],
  )
  return getCollateralFloor(db, row.id)!
}

export function getCollateralFloor(db: KaiBotDatabase, id: string): CollateralFloorRow | null {
  if (!has(db, 'get')) return null
  return (db.get('SELECT * FROM collateral_floors WHERE id = ?', [id]) as CollateralFloorRow | null) ?? null
}

// A synthetic row a collateral floor owns: its hedge mode short or the hedge
// leg of its virtual qty. Those protect, so an account halt never holds them.
export function isCollateralHedgeSynthetic(db: KaiBotDatabase, syntheticId: string): boolean {
  if (!has(db, 'get')) return false
  return !!db.get('SELECT 1 FROM collateral_floors WHERE synthetic_position_id = ? OR virtual_hedge_id = ? LIMIT 1', [syntheticId, syntheticId])
}

export function getLiveCollateralFloor(
  db: KaiBotDatabase,
  exchange: string,
  accountId: string,
  coin: string,
): CollateralFloorRow | null {
  if (!has(db, 'get')) return null
  return (
    (db.get(
      `SELECT * FROM collateral_floors
        WHERE exchange = ? AND account_id = ? AND coin = ? AND status != 'closed'`,
      [exchange.toLowerCase(), accountId, coin.toUpperCase()],
    ) as CollateralFloorRow | null) ?? null
  )
}

export function listLiveCollateralFloors(
  db: KaiBotDatabase,
  exchange?: string,
  accountId?: string,
): CollateralFloorRow[] {
  if (!has(db, 'all')) return []
  const where = ["status != 'closed'"]
  const params: unknown[] = []
  if (exchange) {
    where.push('exchange = ?')
    params.push(exchange.toLowerCase())
  }
  if (accountId) {
    where.push('account_id = ?')
    params.push(accountId)
  }
  return db.all(
    `SELECT * FROM collateral_floors WHERE ${where.join(' AND ')} ORDER BY created_at ASC`,
    params,
  ) as CollateralFloorRow[]
}

export function updateCollateralFloor(db: KaiBotDatabase, id: string, patch: FloorPatch): void {
  const keys = Object.keys(patch) as (keyof FloorPatch)[]
  if (keys.length === 0) return
  const sets = keys.map((k) => `${k} = ?`)
  const values = keys.map((k) => (patch[k] === undefined ? null : patch[k]))
  db.run(`UPDATE collateral_floors SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, [
    ...values,
    Date.now(),
    id,
  ])
}

export function insertCollateralFloorEvent(
  db: KaiBotDatabase,
  floorId: string,
  kind: string,
  meta?: Record<string, unknown>,
): void {
  db.run('INSERT INTO collateral_floor_events (floor_id, kind, meta, created_at) VALUES (?, ?, ?, ?)', [
    floorId,
    kind,
    meta ? JSON.stringify(meta) : null,
    Date.now(),
  ])
}

export function listCollateralFloorEvents(
  db: KaiBotDatabase,
  floorId: string,
): Array<{ id: number; kind: string; meta: Record<string, unknown> | null; created_at: number }> {
  if (!has(db, 'all')) return []
  const rows = db.all(
    'SELECT id, kind, meta, created_at FROM collateral_floor_events WHERE floor_id = ? ORDER BY id ASC',
    [floorId],
  ) as Array<{ id: number; kind: string; meta: string | null; created_at: number }>
  return rows.map((r) => ({ ...r, meta: r.meta ? JSON.parse(r.meta) : null }))
}

function parseOverrides(raw: string | null | undefined): Record<string, number> {
  try {
    const obj = JSON.parse(raw ?? '{}')
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(obj ?? {})) {
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1) out[k.toUpperCase()] = v
    }
    return out
  } catch {
    return {}
  }
}

export function getCollateralSettingsRow(
  db: KaiBotDatabase,
  exchange: string,
  accountId: string,
): CollateralSettingsRow | null {
  if (!has(db, 'get')) return null
  try {
    return (
      (db.get('SELECT * FROM collateral_settings WHERE exchange = ? AND account_id = ?', [
        exchange.toLowerCase(),
        accountId,
      ]) as CollateralSettingsRow | null) ?? null
    )
  } catch {
    // Pre-043 database (tests that build a bare schema): no settings.
    return null
  }
}

export function getCollateralSettings(
  db: KaiBotDatabase,
  exchange: string,
  accountId: string,
): CollateralSettings {
  const row = getCollateralSettingsRow(db, exchange, accountId)
  return {
    exchange: exchange.toLowerCase(),
    accountId,
    sizingBasis: row?.sizing_basis === 'floor' ? 'floor' : 'off',
    unfloored: row?.unfloored === 'margin' ? 'margin' : 'exclude',
    blockMmrPct: row?.block_mmr_pct ?? DEFAULT_BLOCK_MMR_PCT,
    warnMmrPct: row?.warn_mmr_pct ?? DEFAULT_WARN_MMR_PCT,
    autoReduce: row?.auto_reduce === 1,
    autoReducePct: row?.auto_reduce_pct ?? DEFAULT_AUTO_REDUCE_PCT,
    ratioOverrides: parseOverrides(row?.ratio_overrides),
    virtualCoverage: row?.virtual_coverage === 'hedge' ? 'hedge' : 'none',
  }
}

export function upsertCollateralSettings(db: KaiBotDatabase, s: CollateralSettings): void {
  db.run(
    `INSERT INTO collateral_settings
       (exchange, account_id, sizing_basis, unfloored, block_mmr_pct, warn_mmr_pct,
        auto_reduce, auto_reduce_pct, ratio_overrides, virtual_coverage, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(exchange, account_id) DO UPDATE SET
       sizing_basis = excluded.sizing_basis,
       unfloored = excluded.unfloored,
       block_mmr_pct = excluded.block_mmr_pct,
       warn_mmr_pct = excluded.warn_mmr_pct,
       auto_reduce = excluded.auto_reduce,
       auto_reduce_pct = excluded.auto_reduce_pct,
       ratio_overrides = excluded.ratio_overrides,
       virtual_coverage = excluded.virtual_coverage,
       updated_at = excluded.updated_at`,
    [
      s.exchange.toLowerCase(), s.accountId, s.sizingBasis, s.unfloored, s.blockMmrPct, s.warnMmrPct,
      s.autoReduce ? 1 : 0, s.autoReducePct, JSON.stringify(s.ratioOverrides), s.virtualCoverage, Date.now(),
    ],
  )
}

export function listCollateralSettingsRows(db: KaiBotDatabase): CollateralSettingsRow[] {
  if (!has(db, 'all')) return []
  try {
    return db.all('SELECT * FROM collateral_settings', []) as CollateralSettingsRow[]
  } catch {
    return []
  }
}

export function touchCollateralSettings(
  db: KaiBotDatabase,
  exchange: string,
  accountId: string,
  fields: { last_warn_at?: number; last_auto_reduce_at?: number },
): void {
  // Ensure a row exists so the throttle survives a restart.
  if (!getCollateralSettingsRow(db, exchange, accountId)) {
    upsertCollateralSettings(db, getCollateralSettings(db, exchange, accountId))
  }
  const keys = Object.keys(fields) as (keyof typeof fields)[]
  if (keys.length === 0) return
  db.run(
    `UPDATE collateral_settings SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE exchange = ? AND account_id = ?`,
    [...keys.map((k) => fields[k]), exchange.toLowerCase(), accountId],
  )
}

// ── Virtual lines (migration 046): off-exchange coins counted in the pot ──

export interface CollateralVirtualLine {
  exchange: string
  accountId: string
  coin: string
  label: string
  quantity: number
  createdAt: number
  updatedAt: number
}

interface CollateralVirtualLineRow {
  exchange: string
  account_id: string
  coin: string
  label: string
  quantity: number
  created_at: number
  updated_at: number
}

export function listCollateralVirtualLines(
  db: KaiBotDatabase,
  exchange: string,
  accountId: string,
): CollateralVirtualLine[] {
  if (!has(db, 'all')) return []
  try {
    const rows = db.all(
      `SELECT * FROM collateral_virtual_lines WHERE exchange = ? AND account_id = ? ORDER BY coin ASC, label ASC`,
      [exchange.toLowerCase(), accountId],
    ) as CollateralVirtualLineRow[]
    return rows.map((r) => ({
      exchange: r.exchange,
      accountId: r.account_id,
      coin: r.coin,
      label: r.label,
      quantity: r.quantity,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }))
  } catch {
    // Pre-046 database.
    return []
  }
}

// quantity 0 removes the line.
export function setCollateralVirtualLine(
  db: KaiBotDatabase,
  line: { exchange: string; accountId: string; coin: string; label: string; quantity: number },
): void {
  const key = [line.exchange.toLowerCase(), line.accountId, line.coin.toUpperCase(), line.label]
  if (!(line.quantity > 0)) {
    db.run(
      'DELETE FROM collateral_virtual_lines WHERE exchange = ? AND account_id = ? AND coin = ? AND label = ?',
      key,
    )
    return
  }
  const now = Date.now()
  db.run(
    `INSERT INTO collateral_virtual_lines (exchange, account_id, coin, label, quantity, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(exchange, account_id, coin, label) DO UPDATE SET
       quantity = excluded.quantity,
       updated_at = excluded.updated_at`,
    [...key, line.quantity, now, now],
  )
}

export function parseHedgeState(raw: string | null | undefined): HedgeState {
  try {
    const obj = JSON.parse(raw ?? '{}') ?? {}
    return {
      alerts: obj.alerts && typeof obj.alerts === 'object' ? obj.alerts : {},
      error: typeof obj.error === 'string' ? obj.error : null,
      errorKey: typeof obj.errorKey === 'string' ? obj.errorKey : null,
      legStatus: obj.legStatus === 'armed' || obj.legStatus === 'open' ? obj.legStatus : null,
    }
  } catch {
    return { alerts: {}, error: null, errorKey: null, legStatus: null }
  }
}

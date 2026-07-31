// Pre-open "breathing room" margin guard (crypto-aware port of kaibot-exec).
//
// Before an open, check that enough free margin remains AFTER it to keep the
// account's existing positions safe. The pure math has no I/O so it's unit
// tested; the resolver reads per-(exchange, account) config from the DB with a
// global-default row and env-var defaults underneath.
//
// Why account-level (not per-position like the TradeStation original): the
// executor adapters only surface account-level initial/maintenance margin via
// getBalances(); per-position maintenance margin isn't available. For cross-
// margin crypto that's also the correct basis — liquidation is account-wide.

import type { KaiBotDatabase } from '../storage/database.js'
import { DEFAULT_GUARDRAILS, type GuardrailsConfig } from './guardrails.js'
import { isInverseContract } from '@kaibot/types/core'

export type FloorMode = 'maintenance' | 'initial' | 'equityPct'

export interface MarginGuardConfig {
  // Master switch. Default off — turning it on is opt-in per account so it never
  // silently changes existing behaviour.
  enabled: boolean
  // Keep this multiple of the floor free as margin after every open.
  bufferMult: number
  // What the floor is built on (see computeBreathingRoom).
  floorMode: FloorMode
  // Fraction of equity used as the floor when floorMode === 'equityPct' (0..1).
  equityPct: number
}

const FLOOR_MODES: readonly FloorMode[] = ['maintenance', 'initial', 'equityPct']

function envFloorMode(): FloorMode {
  const v = process.env.BREATHING_ROOM_FLOOR_MODE as FloorMode | undefined
  return v && FLOOR_MODES.includes(v) ? v : 'maintenance'
}

// Built-in defaults, env-overridable (mirrors the scattered `Number(env) || x`
// convention used by the other executor services). enabled defaults to false.
export const DEFAULT_MARGIN_GUARD: MarginGuardConfig = {
  enabled: /^(1|true|yes|on)$/i.test(process.env.BREATHING_ROOM_ENABLED ?? ''),
  bufferMult: Number(process.env.BREATHING_ROOM_MULT) || 1.0,
  floorMode: envFloorMode(),
  equityPct: Number(process.env.BREATHING_ROOM_EQUITY_PCT) || 0.2,
}

// Leverage assumed for the new order when no position context reveals it (first
// open on an empty account). 1 = treat the full notional as required margin
// (conservative). Override per deployment.
export const DEFAULT_LEVERAGE = Number(process.env.BREATHING_ROOM_DEFAULT_LEVERAGE) || 1

export interface BreathingRoomInput {
  equity: number // account equity
  initialMargin: number // margin currently locked by open positions
  maintenanceMargin: number // maintenance margin currently required
  orderNotional: number // qty × price (× contract multiplier) of the new open
  leverage: number // effective leverage for the new open
  // Notional of the new order that offsets an OPPOSING same-root position — it
  // nets the broker down and frees margin rather than consuming it, so only the
  // remainder past the offset needs new margin. 0/absent when there's nothing to
  // offset. Capped at orderNotional by the caller. Ref: kaibot-exec 383e5bc.
  offsetNotional?: number
}

export interface BreathingRoom {
  ok: boolean
  available: number // free margin now (equity − initialMargin)
  orderMargin: number // estimated margin the open consumes
  after: number // free margin left after the open
  required: number // floor that `after` must clear
  floorBasis: number // value the floor is built on (per floorMode)
}

/**
 * Would opening `orderNotional` leave at least `bufferMult × floor` of free
 * margin? Free margin = equity − initialMargin; the open consumes
 * `netNewNotional / leverage`. The floor is the account maintenance margin
 * (default), the account initial margin, or a fraction of equity.
 *
 * An order opposing an existing same-root position offsets it (the broker nets
 * per symbol): `offsetNotional` of it consumes no new margin, only the remainder
 * does. A PURE offset (the whole order is offset → netNewNotional 0) nets the
 * broker down and can never break breathing room, so the floor is skipped.
 * Ref: kaibot-exec 383e5bc.
 */
export function computeBreathingRoom(
  cfg: MarginGuardConfig,
  input: BreathingRoomInput,
): BreathingRoom {
  const available = input.equity - input.initialMargin
  const offset = Math.min(Math.max(0, input.offsetNotional ?? 0), input.orderNotional)
  const netNewNotional = input.orderNotional - offset
  const orderMargin = input.leverage > 0 ? netNewNotional / input.leverage : netNewNotional
  const floorBasis =
    cfg.floorMode === 'initial'
      ? input.initialMargin
      : cfg.floorMode === 'equityPct'
        ? cfg.equityPct * input.equity
        : input.maintenanceMargin
  const required = cfg.bufferMult * Math.max(0, floorBasis)
  const after = available - orderMargin
  // A pure offset frees margin — it can never break breathing room, so skip the
  // floor. Otherwise the net-new margin must still clear it.
  const pureOffset = input.orderNotional > 0 && netNewNotional <= 0
  return { ok: pureOffset ? true : after >= required, available, orderMargin, after, required, floorBasis }
}

/**
 * Inverse-settled venues: position value + margin are denominated in the
 * settlement coin (BTC/ETH) while the order quantity is a USD notional, so the
 * position value in coin = notional / price (vs linear venues where notional =
 * qty × price in the quote currency). Deribit BTC/ETH perps are inverse;
 * Deribit USDC perps (SOL_USDC-PERPETUAL) are LINEAR. Delegates to the shared
 * discriminator so the sim and the executor never disagree.
 */
export function isInverseVenue(exchange: string, symbol?: string): boolean {
  return isInverseContract(exchange, symbol)
}

/**
 * Effective config for (exchange, account): a per-account row wins, else the
 * global-default row ('*','*'), else the built-in/env defaults. Returns a copy
 * so callers can't mutate shared state.
 */
export function effectiveMarginGuard(
  db: KaiBotDatabase,
  exchange: string,
  account: string,
): MarginGuardConfig {
  // Defensive: some test doubles omit getMarginGuard. A missing method means
  // no config → built-in/env defaults (guard off).
  const get = (db as Partial<KaiBotDatabase>).getMarginGuard
  if (typeof get !== 'function') return { ...DEFAULT_MARGIN_GUARD }
  const row = get.call(db, exchange, account) ?? get.call(db, '*', '*')
  if (!row) return { ...DEFAULT_MARGIN_GUARD }
  const floorMode = (FLOOR_MODES as readonly string[]).includes(row.floor_mode)
    ? (row.floor_mode as FloorMode)
    : DEFAULT_MARGIN_GUARD.floorMode
  return {
    enabled: !!row.enabled,
    bufferMult: row.buffer_mult,
    floorMode,
    equityPct: row.equity_pct,
  }
}

/**
 * Effective opt-in guardrails for (exchange, account): a per-account row wins,
 * else the global-default row ('*','*'), else all rails off. Resolution mirrors
 * effectiveMarginGuard — the guardrail columns live on the same margin_guards
 * row (migration 016), so one row holds both the breathing-room guard and the
 * rails. Missing/legacy rows (pre-016 columns absent) coerce to 0 = off.
 */
export function effectiveGuardrails(
  db: KaiBotDatabase,
  exchange: string,
  account: string,
): GuardrailsConfig {
  const get = (db as Partial<KaiBotDatabase>).getMarginGuard
  if (typeof get !== 'function') return { ...DEFAULT_GUARDRAILS }
  const row = get.call(db, exchange, account) ?? get.call(db, '*', '*')
  if (!row) return { ...DEFAULT_GUARDRAILS }
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
  return {
    maxDailyLoss: num(row.max_daily_loss),
    maxConcurrentPositions: num(row.max_concurrent_positions),
    maxTotalNotional: num(row.max_total_notional),
  }
}

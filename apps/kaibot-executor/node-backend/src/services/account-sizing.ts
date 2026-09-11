// Per-account contract sizing (parity #6 with kaibot-exec account_sizes).
//
// Caps the contracts placed per signal per (exchange account, symbol root).
// A configured cap of 0 is a kill-switch for that market on that account. With
// no configured row the root's built-in default applies, and roots without a
// default are uncapped (returns the requested size). The signal pipeline calls
// `clipToAccountSize` after the factor/maxPositionSize steps and before the
// exchange min/step rounding, so the audit trail reads naturally.

import type { KaiBotDatabase } from '../storage/database.js'
import { isFuturesRoot, rootOf } from './exchanges/futures-contracts.js'

// Built-in per-signal caps by futures root (mirrors kaibot-exec DEFAULT_SIZES).
// Crypto roots are intentionally absent → uncapped unless configured.
export const DEFAULT_ACCOUNT_SIZES: Record<string, number> = {
  MNQ: 2,
  MES: 4,
  MGC: 2,
  SIL: 1,
}

// The sizing key for a symbol: the futures root for a future (dated or bare),
// otherwise the bare symbol (so crypto pairs can be sized/killed too).
export function sizingRoot(symbol: string): string {
  const up = symbol.toUpperCase()
  if (isFuturesRoot(up) || /^[A-Z]+[FGHJKMNQUVXZ]\d{2}$/.test(up)) return rootOf(up)
  return up
}

// Effective per-signal cap for (exchange, account, symbol): the configured
// account_sizes row, else the built-in default, else null (uncapped).
// Synthetic-mode sizing lives in synthetic-sizing.ts and runs earlier in the
// pipeline — these caps are operator policy and apply on top of it.
export function effectiveCap(
  db: KaiBotDatabase,
  exchange: string,
  account: string,
  symbol: string,
): number | null {
  const root = sizingRoot(symbol)
  const configured = db.getAccountSize(exchange, account, root)
  if (configured !== null) return configured
  return DEFAULT_ACCOUNT_SIZES[root] ?? null
}

export interface SizeClip {
  // Quantity after applying the cap.
  quantity: number
  // True when the cap is 0 — the market is killed for this account.
  killed: boolean
  // True when the requested quantity was reduced to the cap.
  clipped: boolean
  // The effective cap that was applied (null = uncapped, request passes through).
  cap: number | null
  root: string
}

// Pure clip used by the signal pipeline. Never raises the size; only caps it.
export function clipToAccountSize(
  db: KaiBotDatabase,
  exchange: string,
  account: string,
  symbol: string,
  quantity: number,
): SizeClip {
  const root = sizingRoot(symbol)
  const cap = effectiveCap(db, exchange, account, symbol)
  if (cap === null) return { quantity, killed: false, clipped: false, cap, root }
  if (cap <= 0) return { quantity: 0, killed: true, clipped: true, cap, root }
  if (quantity > cap) return { quantity: cap, killed: false, clipped: true, cap, root }
  return { quantity, killed: false, clipped: false, cap, root }
}

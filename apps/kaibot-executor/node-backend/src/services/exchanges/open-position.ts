import type { Position } from './types.js'

/**
 * A venue row is an OPEN position only when it holds size. Deribit lists every
 * instrument the account has ever traded and reports size 0 for the flat ones;
 * those are history, not exposure, and must never reach a position count, a
 * notional total or a close button.
 */
export function isOpenPosition(p: Pick<Position, 'size'>): boolean {
  return Number.isFinite(p.size) && Math.abs(p.size) > 0
}

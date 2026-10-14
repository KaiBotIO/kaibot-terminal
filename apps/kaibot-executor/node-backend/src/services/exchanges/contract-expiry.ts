// Expiry resolution for dated futures contracts, from the symbol alone (no
// network, no venue auth) so the positions endpoint can enrich every row
// synchronously.
//
// Two symbol families:
//  - Tradfi dated contracts (MNQZ26): expiry is CALCULATED from the standard
//    contract calendar (3rd Friday for equity index, 3rd-last business day for
//    COMEX metals). Holiday calendars are not modelled — day-level precision
//    is all the rollover UI needs, and rows are marked "calculated".
//  - Crypto dated futures (BTC-27MAR26): the venue encodes the expiry date in
//    the symbol itself (Deribit/Bybit delivery, settles 08:00 UTC), so the
//    parsed date is "exchange-provided".
//
// Cycle/rule tables mirror packages/exchange/src/futures.ts (the executor
// backend deliberately has no workspace dep on @kaibot/exchange — same
// precedent as futures-contracts.ts). Keep the two in sync.

const MONTH_CODE_NUM: Record<string, number> = {
  F: 1, G: 2, H: 3, J: 4, K: 5, M: 6, N: 7, Q: 8, U: 9, V: 10, X: 11, Z: 12,
}

const NUM_MONTH_CODE: Record<number, string> = Object.fromEntries(
  Object.entries(MONTH_CODE_NUM).map(([code, num]) => [num, code]),
)

// Per-root delivery-month cycles (the contracts actually listed/traded).
const ROLLOVER_CYCLES: Record<string, string> = {
  ES: 'HMUZ', MES: 'HMUZ', NQ: 'HMUZ', MNQ: 'HMUZ',
  GC: 'GJMQVZ', MGC: 'GJMQVZ',
  SI: 'HKNUZ', SIL: 'HKNUZ',
}

export type ExpiryRule = 'third-friday' | 'third-last-business-day'

const EXPIRY_RULES: Record<string, ExpiryRule> = {
  ES: 'third-friday', MES: 'third-friday', NQ: 'third-friday', MNQ: 'third-friday',
  GC: 'third-last-business-day', MGC: 'third-last-business-day',
  SI: 'third-last-business-day', SIL: 'third-last-business-day',
}

const TRADFI_CONTRACT_RE = /^([A-Z]+)([FGHJKMNQUVXZ])(\d{2})$/
// Deribit/Bybit delivery suffix: BTC-27MAR26, BTC_USDC-27MAR26.
const CRYPTO_DATED_RE = /-(\d{1,2})([A-Z]{3})(\d{2})$/
const CRYPTO_MONTHS: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
}

export interface PositionExpiryInfo {
  /** Expiry moment, ISO. Calculated tradfi: 00:00 UTC on the expiry day. */
  date: string
  /** Whole days until expiry (0 on the expiry day, never negative). */
  daysLeft: number
  source: 'exchange-provided' | 'calculated'
  /** Suggested contract to roll into; null when it can't be derived locally. */
  nextSymbol: string | null
}

export function thirdFriday(year: number, month: number): Date {
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay()
  const firstFriday = 1 + ((5 - firstDow + 7) % 7)
  return new Date(Date.UTC(year, month - 1, firstFriday + 14))
}

export function thirdLastBusinessDay(year: number, month: number): Date {
  let remaining = 3
  for (let day = new Date(Date.UTC(year, month, 0)).getUTCDate(); day >= 1; day--) {
    const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
    if (dow !== 0 && dow !== 6 && --remaining === 0) {
      return new Date(Date.UTC(year, month - 1, day))
    }
  }
  throw new Error(`no business days in ${year}-${month}`)
}

/** Next contract in the root's cycle after `symbol` (MNQZ26 -> MNQH27). */
export function nextCycleContract(symbol: string): string | null {
  const m = TRADFI_CONTRACT_RE.exec(symbol.toUpperCase())
  if (!m) return null
  const [, root, code, yy] = m
  const cycle = ROLLOVER_CYCLES[root]
  if (!cycle) return null
  const months = cycle.split('').map((c) => MONTH_CODE_NUM[c]).sort((a, b) => a - b)
  const month = MONTH_CODE_NUM[code]
  const year = 2000 + Number(yy)
  const next = months.find((mm) => mm > month)
  return next != null
    ? `${root}${NUM_MONTH_CODE[next]}${String(year).slice(2)}`
    : `${root}${NUM_MONTH_CODE[months[0]]}${String(year + 1).slice(2)}`
}

function daysUntil(expiry: Date, now: Date): number {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const expDay = Date.UTC(expiry.getUTCFullYear(), expiry.getUTCMonth(), expiry.getUTCDate())
  return Math.max(0, Math.round((expDay - today) / 86_400_000))
}

/**
 * Expiry info for a position symbol; null for perpetuals, spot, bare roots and
 * anything else without a resolvable expiry.
 */
export function expiryInfoForSymbol(symbol: string, now: Date = new Date()): PositionExpiryInfo | null {
  const upper = symbol.toUpperCase()

  const tradfi = TRADFI_CONTRACT_RE.exec(upper)
  if (tradfi) {
    const [, root, code, yy] = tradfi
    const rule = EXPIRY_RULES[root]
    if (!rule) return null
    const month = MONTH_CODE_NUM[code]
    const year = 2000 + Number(yy)
    const expiry = rule === 'third-friday'
      ? thirdFriday(year, month)
      : thirdLastBusinessDay(year, month)
    return {
      date: expiry.toISOString(),
      daysLeft: daysUntil(expiry, now),
      source: 'calculated',
      nextSymbol: nextCycleContract(upper),
    }
  }

  const dated = CRYPTO_DATED_RE.exec(upper)
  if (dated) {
    const [, dd, mon, yy] = dated
    const month = CRYPTO_MONTHS[mon]
    if (!month) return null
    // Deribit/Bybit delivery futures settle 08:00 UTC on the named day.
    const expiry = new Date(Date.UTC(2000 + Number(yy), month - 1, Number(dd), 8))
    return {
      date: expiry.toISOString(),
      daysLeft: daysUntil(expiry, now),
      source: 'exchange-provided',
      // The next listed contract depends on the venue's live instrument list.
      nextSymbol: null,
    }
  }

  return null
}

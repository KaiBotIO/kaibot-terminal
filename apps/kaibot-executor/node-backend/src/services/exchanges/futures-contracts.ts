// Futures front-month resolution for TradeStation.
//
// A signal can target a futures ROOT (MES, MNQ, MGC, ES, NQ, ...) rather than a
// specific dated contract (MESM26). TradeStation orders need the dated symbol,
// and the "front month" rolls over time. We resolve it the way a continuous
// symbol does: among the priced candidate months, pick the one with the highest
// traded volume — a near-expiry month still prices but its volume has already
// moved on to the next contract.
//
// Ported from the standalone kaibot-exec service (src/ts-trade.ts), where this
// pattern was proven against the live TradeStation API.

const MONTH_CODES = ['F', 'G', 'H', 'J', 'K', 'M', 'N', 'Q', 'U', 'V', 'X', 'Z']

// The multiplier table and root parsing live in @kaibot/types/core so the
// executor UI values a position exactly like the sizing/PnL math does.
export {
  FUTURES_MULTIPLIERS,
  KNOWN_FUTURES_ROOTS,
  isFuturesRoot,
  rootOf,
  multiplierFor,
  contractMultiplier,
  isDatedContractOf,
  pickOrderContract,
} from '@kaibot/types/core'

/** Candidate dated contracts for the next 14 months, nearest expiry first. */
export function candidateContracts(root: string, now: Date = new Date()): string[] {
  const out: string[] = []
  for (let i = 0; i < 14; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1)
    const code = MONTH_CODES[d.getMonth()]
    const yy = String(d.getFullYear()).slice(2)
    out.push(`${root}${code}${yy}`)
  }
  return out
}

export interface QuoteLike {
  Symbol: string
  Last?: string | number
  Close?: string | number
  Ask?: string | number
  Volume?: string | number
  Description?: string
}

export interface FrontMonth {
  symbol: string
  last: number
  volume: number
  description: string
}

/**
 * Pure picker: among quotes, keep the priced ones and return the highest-volume
 * candidate. Separated from the HTTP call so it is trivially unit-testable.
 */
export function pickFrontMonth(quotes: QuoteLike[]): FrontMonth | null {
  const priced = quotes
    .filter((q) => q.Last || q.Close || q.Ask)
    .map((q) => ({
      symbol: String(q.Symbol),
      last: parseFloat(String(q.Last ?? q.Close ?? q.Ask ?? '0')),
      volume: parseFloat(String(q.Volume ?? '0')) || 0,
      description: q.Description ?? '',
    }))
  if (priced.length === 0) return null
  priced.sort((a, b) => b.volume - a.volume)
  return priced[0]
}

/**
 * Resolve the front-month contract for a root by quoting the candidate months
 * and picking the highest-volume one. `quoteFn` performs the actual API call
 * (TradeStation `/v3/marketdata/quotes/<symbols>`), kept injectable for tests.
 *
 * Results are cached briefly per root: the front month only changes around a
 * roll, so a few minutes of caching saves a quote round-trip on every signal
 * without ever pointing at a stale contract within a session.
 */
export class FrontMonthResolver {
  private cache = new Map<string, { at: number; value: FrontMonth }>()

  constructor(private ttlMs: number = 5 * 60 * 1000) {}

  async resolve(
    root: string,
    quoteFn: (symbols: string[]) => Promise<QuoteLike[]>,
    now: number = Date.now(),
  ): Promise<FrontMonth> {
    const key = root.toUpperCase()
    const hit = this.cache.get(key)
    if (hit && now - hit.at < this.ttlMs) return hit.value

    const candidates = candidateContracts(key, new Date(now))
    const quotes = await quoteFn(candidates)
    const front = pickFrontMonth(quotes)
    if (!front) throw new Error(`no priced contract found for root "${key}"`)

    this.cache.set(key, { at: now, value: front })
    return front
  }

  clear(): void {
    this.cache.clear()
  }
}

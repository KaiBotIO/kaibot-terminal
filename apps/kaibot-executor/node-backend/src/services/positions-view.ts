// Shape of GET /api/positions when at least one venue could not be read. A
// plain [] there was taken as "flat" by watchers during the 2026-09-06 network
// blip; the answer is a 503 with this body instead: the partial list is still
// there for display, the flag says it is not the whole book.
export interface PositionsUnavailableBody<T = unknown> {
  unavailable: true
  /** Venues that are configured but could not be read right now. */
  exchanges: string[]
  /** Positions from the venues that DID answer — never the full book. */
  positions: T[]
  message: string
}

export function positionsUnavailableBody<T>(positions: T[], exchanges: string[]): PositionsUnavailableBody<T> {
  return {
    unavailable: true,
    exchanges: [...new Set(exchanges)],
    positions,
    message: `Positions unavailable for ${[...new Set(exchanges)].join(', ')} — not a flat book`,
  }
}

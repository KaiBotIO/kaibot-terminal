// Regression for the partial-close-masquerading-as-full bug: a fraction close
// on a bot whose tracked base exceeds the venue net position (opposing book
// nets it down) clamps closeQty to positionSize. The old predicate
// (`closeQty >= positionSize`) then flagged it as a FULL close, cancelling the
// SL/TP brackets and resting DCA rungs of a book that still had live
// remainder. Full-vs-partial must key on the bot-scoped base, never venue net.
import { describe, expect, it } from 'bun:test'
import { isFullCloseRequest } from '../websocket/signal-client.js'

describe('isFullCloseRequest', () => {
  it('a fraction close clamped to a netted-down venue position stays PARTIAL', () => {
    // Bot tracks 2.0; opposing exposure nets the venue to 0.5. fraction=0.5 →
    // requested 1.0, clamped closeQty 0.5. The buggy predicate saw
    // closeQty >= positionSize(0.5) and stripped the brackets.
    const closeBaseQty = 2.0
    const requestedSize = 1.0 // fraction 0.5 × base
    const closeQty = 0.5 // clamped to venue net
    expect(isFullCloseRequest(requestedSize, closeQty, closeBaseQty)).toBe(false)
  })

  it('requesting the whole base is a full close even when the venue nets lower', () => {
    // fraction=1 → requested = base; venue can only fill 0.5 but the bot book
    // is fully retired, so brackets must be cancelled.
    expect(isFullCloseRequest(2.0, 0.5, 2.0)).toBe(true)
  })

  it('a plain fraction close on an unnetted position stays partial', () => {
    // base == venue net == 1.0, fraction 0.5.
    expect(isFullCloseRequest(0.5, 0.5, 1.0)).toBe(false)
  })

  it('a full close on an unnetted position is full', () => {
    expect(isFullCloseRequest(1.0, 1.0, 1.0)).toBe(true)
  })

  it('the dust-fallback (closeQty raised to the whole base) counts as full', () => {
    // Rounding zeroed a tiny partial; the fallback closes the whole base, so
    // the book is retired even though requestedSize was small.
    expect(isFullCloseRequest(0.0004, 0.5, 0.5)).toBe(true)
  })

  it('tolerates float noise at the base boundary', () => {
    expect(isFullCloseRequest(0.3 * 3 + 0.1 - 1e-12, 0, 1.0)).toBe(true)
  })
})

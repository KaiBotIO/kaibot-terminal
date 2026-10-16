import { describe, expect, it } from 'bun:test'
import {
  deriveClientOrderId,
  toClientOrderRef,
  parseClientOrderRef,
} from './client-order-id.js'

// EX7: signal-originated orders carry a deterministic broker-side client order
// id derived from (signalId, leg, rung) so a retry submits the SAME id and the
// venue rejects the duplicate.

describe('deriveClientOrderId', () => {
  it('is deterministic for the same (signalId, leg, rung)', () => {
    expect(deriveClientOrderId('sig-1', 'entry')).toBe(deriveClientOrderId('sig-1', 'entry'))
    expect(deriveClientOrderId('sig-1', 'tp', 2)).toBe(deriveClientOrderId('sig-1', 'tp', 2))
  })

  it('differs across signals, legs and rungs', () => {
    const ids = [
      deriveClientOrderId('sig-1', 'entry'),
      deriveClientOrderId('sig-2', 'entry'),
      deriveClientOrderId('sig-1', 'sl'),
      deriveClientOrderId('sig-1', 'tp', 1),
      deriveClientOrderId('sig-1', 'tp', 2),
      deriveClientOrderId('sig-1', 'dca', 1),
    ]
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('fits the strictest venue constraints (Binance: 36 chars, [.A-Za-z0-9_-])', () => {
    const id = deriveClientOrderId('0b7ee2ad-9a51-4b2e-9f2c-2a1c69577d1e', 'exit:reduce:12.5')
    expect(id.length).toBeLessThanOrEqual(36)
    expect(id).toMatch(/^[.A-Za-z0-9_-]+$/)
  })

  it('long uuid ids never truncate into cross-leg collisions (the raw-string trap)', () => {
    const sig = '0b7ee2ad-9a51-4b2e-9f2c-2a1c69577d1e'
    expect(deriveClientOrderId(sig, 'entry')).not.toBe(deriveClientOrderId(sig, 'sl'))
  })
})

describe('client order refs', () => {
  it('round-trips through the client: prefix', () => {
    const ref = toClientOrderRef('kb-abc')
    expect(ref).toBe('client:kb-abc')
    expect(parseClientOrderRef(ref)).toBe('kb-abc')
  })
  it('parse returns null for a broker id', () => {
    expect(parseClientOrderRef('123456789')).toBeNull()
  })
})

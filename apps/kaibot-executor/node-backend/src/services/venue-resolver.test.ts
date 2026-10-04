import { describe, expect, it } from 'bun:test'
import { resolveVenue } from './venue-resolver.js'

describe('venue-resolver', () => {
  it('subscription exchange wins over signal metadata', () => {
    const r = resolveVenue({ subscriptionExchange: 'bybit', signalMetadataExchange: 'deribit' })
    expect(r.exchange).toBe('bybit')
    expect(r.rejectReason).toBeNull()
  })

  it('falls back to metadata.exchange for legacy per-venue signals', () => {
    const r = resolveVenue({ subscriptionExchange: null, signalMetadataExchange: 'Deribit' })
    expect(r.exchange).toBe('deribit')
  })

  it('composite signal without a subscription venue rejects loudly (no deribit default)', () => {
    const r = resolveVenue({ subscriptionExchange: null, signalMetadataExchange: 'index' })
    expect(r.exchange).toBeNull()
    expect(r.rejectReason).toContain('composite signal')
  })

  it('nothing resolvable rejects — never a hardcoded venue', () => {
    const r = resolveVenue({})
    expect(r.exchange).toBeNull()
    expect(r.rejectReason).toContain('no execution venue')
  })

  it("subscription exchange 'index' is never an execution venue", () => {
    const r = resolveVenue({ subscriptionExchange: 'index', signalMetadataExchange: 'index' })
    expect(r.exchange).toBeNull()
  })

  it('subscription venue routes a composite signal to the user venue', () => {
    const r = resolveVenue({ subscriptionExchange: 'bybit', signalMetadataExchange: 'index' })
    expect(r.exchange).toBe('bybit')
  })
})

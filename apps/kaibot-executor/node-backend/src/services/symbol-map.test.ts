import { describe, expect, it } from 'bun:test'
import { mapToVenueSymbol } from './symbol-map.js'

describe('symbol-map', () => {
  it('maps canonical BTC to the venue instrument', () => {
    expect(mapToVenueSymbol('bybit', 'BTC').venueSymbol).toBe('BTCUSDT')
    expect(mapToVenueSymbol('deribit', 'BTC').venueSymbol).toBe('BTC-PERPETUAL')
    expect(mapToVenueSymbol('binance', 'ETH').venueSymbol).toBe('ETHUSDT')
  })

  it('passes non-canonical (legacy venue) symbols through untouched', () => {
    const r = mapToVenueSymbol('deribit', 'BTC-PERPETUAL')
    expect(r.venueSymbol).toBe('BTC-PERPETUAL')
    expect(r.rejectReason).toBeNull()
  })

  it('rejects a canonical symbol with no mapping on the venue', () => {
    const r = mapToVenueSymbol('tradestation', 'BTC')
    expect(r.venueSymbol).toBeNull()
    expect(r.rejectReason).toContain('no venue symbol mapping')
  })

  it('prefers the payload venue map over the const fallback', () => {
    const map = { bybit: 'SOLPERP', deribit: 'SOL_USDC-PERPETUAL' }
    expect(mapToVenueSymbol('bybit', 'SOL', map).venueSymbol).toBe('SOLPERP')
    expect(mapToVenueSymbol('Deribit', 'SOL', map).venueSymbol).toBe('SOL_USDC-PERPETUAL')
    // Payload wins even for symbols the const knows.
    expect(mapToVenueSymbol('bybit', 'BTC', { bybit: 'BTCPERP' }).venueSymbol).toBe('BTCPERP')
  })

  it('falls back to the const map for a venue missing from the payload', () => {
    const r = mapToVenueSymbol('deribit', 'BTC', { bybit: 'BTCUSDT' })
    expect(r.venueSymbol).toBe('BTC-PERPETUAL')
  })

  it('never passes a canonical through when a payload map lacks the venue', () => {
    const r = mapToVenueSymbol('binance', 'SOL', { bybit: 'SOLPERP' })
    expect(r.venueSymbol).toBeNull()
    expect(r.rejectReason).toContain('no venue symbol mapping')
  })
})

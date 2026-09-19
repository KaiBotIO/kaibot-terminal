import { describe, expect, it } from 'bun:test'
import { positionsUnavailableBody } from './positions-view.js'

// 2026-09-06: during a network blip /api/positions answered [] because every
// venue read failed — watchers read that as FLAT. The unavailable body is a
// non-array with an explicit flag and the partial list.
describe('positionsUnavailableBody', () => {
  it('flags the unreadable venues and keeps the partial list', () => {
    const body = positionsUnavailableBody([{ symbol: 'MESU26' }], ['deribit', 'deribit'])
    expect(body.unavailable).toBe(true)
    expect(body.exchanges).toEqual(['deribit'])
    expect(body.positions).toEqual([{ symbol: 'MESU26' }])
    expect(Array.isArray(body)).toBe(false)
    expect(body.message).toContain('not a flat book')
  })
})

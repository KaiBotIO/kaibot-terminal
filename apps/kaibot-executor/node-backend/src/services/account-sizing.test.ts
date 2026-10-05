import { describe, expect, it } from 'bun:test'
import {
  clipToAccountSize,
  effectiveCap,
  sizingRoot,
  DEFAULT_ACCOUNT_SIZES,
} from './account-sizing.js'

// Minimal db double exposing just getAccountSize. A Map keyed by
// exchange:account:root drives the configured-vs-default branches.
function makeDb(config: Record<string, number> = {}) {
  return {
    getAccountSize(exchange: string, account: string, root: string): number | null {
      const k = `${exchange}:${account}:${root}`
      return k in config ? config[k] : null
    },
  } as any
}

describe('sizingRoot', () => {
  it('maps a bare futures root to itself', () => {
    expect(sizingRoot('MES')).toBe('MES')
  })
  it('strips a dated futures contract to its root', () => {
    expect(sizingRoot('MESM26')).toBe('MES')
  })
  it('keeps a crypto pair as its own root', () => {
    expect(sizingRoot('BTC-PERPETUAL')).toBe('BTC-PERPETUAL')
  })
})

describe('effectiveCap', () => {
  it('prefers a configured cap over the default', () => {
    const db = makeDb({ 'tradestation:ACC1:MES': 7 })
    expect(effectiveCap(db, 'tradestation', 'ACC1', 'MES')).toBe(7)
  })
  it('falls back to the built-in default when unconfigured', () => {
    const db = makeDb()
    expect(effectiveCap(db, 'tradestation', 'ACC1', 'MES')).toBe(DEFAULT_ACCOUNT_SIZES.MES)
  })
  it('returns null (uncapped) for a root with no default and no config', () => {
    const db = makeDb()
    expect(effectiveCap(db, 'deribit', 'btc', 'BTC-PERPETUAL')).toBeNull()
  })
})

describe('clipToAccountSize', () => {
  it('passes the request through unchanged when uncapped', () => {
    const db = makeDb()
    const r = clipToAccountSize(db, 'deribit', 'btc', 'BTC-PERPETUAL', 10)
    expect(r).toMatchObject({ quantity: 10, clipped: false, killed: false, cap: null })
  })

  it('clips to the configured cap when the request exceeds it', () => {
    const db = makeDb({ 'tradestation:ACC1:MES': 4 })
    const r = clipToAccountSize(db, 'tradestation', 'ACC1', 'MES', 10)
    expect(r.quantity).toBe(4)
    expect(r.clipped).toBe(true)
    expect(r.killed).toBe(false)
  })

  it('treats a configured cap of 0 as a kill-switch', () => {
    const db = makeDb({ 'tradestation:ACC1:MNQ': 0 })
    const r = clipToAccountSize(db, 'tradestation', 'ACC1', 'MNQ', 3)
    expect(r.killed).toBe(true)
    expect(r.quantity).toBe(0)
  })

  it('does not raise a request below the cap', () => {
    const db = makeDb({ 'tradestation:ACC1:MES': 4 })
    const r = clipToAccountSize(db, 'tradestation', 'ACC1', 'MES', 2)
    expect(r.quantity).toBe(2)
    expect(r.clipped).toBe(false)
  })

  it('applies the default cap when a futures root is unconfigured', () => {
    const db = makeDb()
    const r = clipToAccountSize(db, 'tradestation', 'ACC1', 'MNQ', 9)
    expect(r.quantity).toBe(DEFAULT_ACCOUNT_SIZES.MNQ)
    expect(r.clipped).toBe(true)
  })
})

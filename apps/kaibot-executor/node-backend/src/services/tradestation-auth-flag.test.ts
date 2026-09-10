import { describe, expect, it } from 'bun:test'
import { resolveTradestationUseOAuth } from './tradestation-auth-flag.js'

// HY4 regression: the TradeStation auth mode was hardcoded `false` in two
// mirrored files; it is now driven by one env var (default false).

describe('resolveTradestationUseOAuth', () => {
  it('defaults to false (CouchDB legacy session)', () => {
    expect(resolveTradestationUseOAuth({})).toBe(false)
  })

  it('TRADESTATION_USE_OAUTH=true enables OAuth', () => {
    expect(resolveTradestationUseOAuth({ TRADESTATION_USE_OAUTH: 'true' })).toBe(true)
    expect(resolveTradestationUseOAuth({ TRADESTATION_USE_OAUTH: 'TRUE' })).toBe(true)
    expect(resolveTradestationUseOAuth({ TRADESTATION_USE_OAUTH: ' true ' })).toBe(true)
  })

  it('the VITE_ alias works so one exported var drives frontend and backend', () => {
    expect(resolveTradestationUseOAuth({ VITE_TRADESTATION_USE_OAUTH: 'true' })).toBe(true)
  })

  it('anything else stays false', () => {
    expect(resolveTradestationUseOAuth({ TRADESTATION_USE_OAUTH: 'false' })).toBe(false)
    expect(resolveTradestationUseOAuth({ TRADESTATION_USE_OAUTH: '1' })).toBe(false)
    expect(resolveTradestationUseOAuth({ TRADESTATION_USE_OAUTH: 'yes' })).toBe(false)
  })

  it('an explicit TRADESTATION_USE_OAUTH wins over the VITE_ alias', () => {
    expect(
      resolveTradestationUseOAuth({
        TRADESTATION_USE_OAUTH: 'false',
        VITE_TRADESTATION_USE_OAUTH: 'true',
      }),
    ).toBe(false)
  })
})

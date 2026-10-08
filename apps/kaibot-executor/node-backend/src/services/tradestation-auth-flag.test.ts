import { describe, expect, it } from 'bun:test'
import { resolveTradestationAuthMode } from './tradestation-auth-flag.js'

// Regression: the mode used to come from a build-time env var the public
// release workflow never set, so every customer got the CouchDB form and could
// not connect TradeStation at all.

describe('resolveTradestationAuthMode', () => {
  it('defaults to oauth on a bare public install', () => {
    expect(resolveTradestationAuthMode({})).toBe('oauth')
  })

  it('picks couchdb only when the legacy session credentials are present', () => {
    expect(
      resolveTradestationAuthMode({
        COUCHDB_URL: 'http://couchdb.example:5984',
        COUCHDB_TS_SESSION_ID: 'session:ts',
      }),
    ).toBe('couchdb')
  })

  it('stays on oauth when the CouchDB config is half configured', () => {
    expect(resolveTradestationAuthMode({ COUCHDB_URL: 'http://couchdb.example:5984' })).toBe('oauth')
    expect(resolveTradestationAuthMode({ COUCHDB_TS_SESSION_ID: 'session:ts' })).toBe('oauth')
  })

  it('TRADESTATION_AUTH_MODE forces either mode', () => {
    expect(resolveTradestationAuthMode({ TRADESTATION_AUTH_MODE: 'couchdb' })).toBe('couchdb')
    expect(
      resolveTradestationAuthMode({
        TRADESTATION_AUTH_MODE: 'OAuth',
        COUCHDB_URL: 'http://couchdb.example:5984',
        COUCHDB_TS_SESSION_ID: 'session:ts',
      }),
    ).toBe('oauth')
  })

  it('the legacy dev override can force oauth but never couchdb', () => {
    expect(
      resolveTradestationAuthMode({
        TRADESTATION_USE_OAUTH: ' TRUE ',
        COUCHDB_URL: 'http://couchdb.example:5984',
        COUCHDB_TS_SESSION_ID: 'session:ts',
      }),
    ).toBe('oauth')
    expect(resolveTradestationAuthMode({ VITE_TRADESTATION_USE_OAUTH: 'true' })).toBe('oauth')
    expect(resolveTradestationAuthMode({ TRADESTATION_USE_OAUTH: 'false' })).toBe('oauth')
  })
})

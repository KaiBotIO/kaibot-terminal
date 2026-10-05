import { describe, expect, it } from 'bun:test'
import { checkSetupGate, isLoopbackAddress } from './setup-gate.js'

// #23 regression: /api/auth/setup was public AND network-reachable in
// web/Docker mode — whoever raced first on the LAN claimed the admin account.
// The gate must refuse non-loopback first-run setup unless the operator's
// EXECUTOR_SETUP_TOKEN is presented.

describe('checkSetupGate (#23)', () => {
  it('desktop mode always allows (loopback-only sidecar)', () => {
    expect(
      checkSetupGate({ isDesktop: true, setupToken: undefined, providedToken: undefined, remoteAddress: '192.168.1.50' }),
    ).toEqual({ allowed: true })
  })

  it('web mode without a setup token refuses non-loopback requests (landgrab)', () => {
    const r = checkSetupGate({
      isDesktop: false,
      setupToken: undefined,
      providedToken: undefined,
      remoteAddress: '192.168.1.50',
    })
    expect(r.allowed).toBe(false)
    expect(!r.allowed && r.reason).toBe('not_loopback')
  })

  it('web mode without a setup token still allows loopback (local first-run)', () => {
    for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      expect(
        checkSetupGate({ isDesktop: false, setupToken: undefined, providedToken: undefined, remoteAddress: addr }),
      ).toEqual({ allowed: true })
    }
  })

  it('web mode with a configured token requires the exact token', () => {
    const base = { isDesktop: false, setupToken: 's3cret', remoteAddress: '192.168.1.50' }
    expect(checkSetupGate({ ...base, providedToken: 's3cret' })).toEqual({ allowed: true })
    const missing = checkSetupGate({ ...base, providedToken: undefined })
    expect(missing.allowed).toBe(false)
    const wrong = checkSetupGate({ ...base, providedToken: 'nope' })
    expect(wrong.allowed).toBe(false)
    expect(!wrong.allowed && wrong.reason).toBe('bad_token')
  })

  it('a configured token gates loopback too (explicit operator policy wins)', () => {
    const r = checkSetupGate({
      isDesktop: false,
      setupToken: 's3cret',
      providedToken: undefined,
      remoteAddress: '127.0.0.1',
    })
    expect(r.allowed).toBe(false)
  })

  it('an unknown/missing remote address is not loopback', () => {
    expect(isLoopbackAddress(undefined)).toBe(false)
    expect(isLoopbackAddress('10.0.0.7')).toBe(false)
  })
})

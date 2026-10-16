// m3 (verify-before-crack 06/10): an unstamped build reported the stale
// fallback constant (0.4.24 on 0.4.31). Unstamped = the app's package.json.
import { describe, expect, it } from 'bun:test'
import pkg from '../../package.json'
import { EXECUTOR_VERSION } from './version'

describe('EXECUTOR_VERSION', () => {
  it('follows apps/kaibot-executor/package.json when no build stamp is set', () => {
    if (process.env.KAIBOT_EXECUTOR_VERSION) return
    expect(EXECUTOR_VERSION).toBe(pkg.version)
  })
})

import { describe, expect, it } from 'bun:test'
import { EDITION_VIEWER_REFUSED_BODY, hasViewerAccounts, loginRefusal, parseEdition, resolveEdition } from './edition.js'

describe('edition', () => {
  it('defaults to public for anything but "internal"', () => {
    expect(parseEdition(undefined)).toBe('public')
    expect(parseEdition('')).toBe('public')
    expect(parseEdition('INTERNAL ')).toBe('internal')
    expect(parseEdition('internal-ish')).toBe('public')
  })

  it('a baked value wins; a compiled binary ignores the env', () => {
    expect(resolveEdition({ baked: 'internal', env: undefined, compiled: true })).toBe('internal')
    expect(resolveEdition({ baked: 'public', env: 'internal', compiled: false })).toBe('public')
    expect(resolveEdition({ baked: undefined, env: 'internal', compiled: true })).toBe('public')
    expect(resolveEdition({ baked: undefined, env: 'internal', compiled: false })).toBe('internal')
    expect(resolveEdition({ baked: undefined, env: undefined, compiled: false })).toBe('public')
  })

  it('refuses viewer logins only in public', () => {
    expect(hasViewerAccounts('internal')).toBe(true)
    expect(hasViewerAccounts('public')).toBe(false)
    expect(loginRefusal('viewer', 'public')).toEqual(EDITION_VIEWER_REFUSED_BODY)
    expect(loginRefusal('viewer', 'internal')).toBeNull()
    expect(loginRefusal('admin', 'public')).toBeNull()
  })
})

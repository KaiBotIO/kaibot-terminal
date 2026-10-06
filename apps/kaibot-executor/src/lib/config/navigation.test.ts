import { describe, expect, it } from 'bun:test'
import { mainNavigation, navigationFor } from './navigation'

describe('navigationFor', () => {
  it('admin sees every page', () => {
    expect(navigationFor(false)).toBe(mainNavigation)
  })

  it('viewer loses the chart (Studio pairing + manual trading) and keeps the read pages', () => {
    const hrefs = navigationFor(true).map((i) => i.href)
    expect(hrefs).not.toContain('/terminal')
    for (const href of ['/', '/positions', '/portfolio', '/exchanges', '/analytics', '/subscriptions', '/activity', '/reconciliation', '/settings']) {
      expect(hrefs).toContain(href)
    }
  })
})

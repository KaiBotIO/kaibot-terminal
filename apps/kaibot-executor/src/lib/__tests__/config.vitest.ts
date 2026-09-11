import { describe, expect, it } from 'vitest'
import { KAIBOT_APP_URL, ONLINE_TERMINAL_URL } from '../config'

describe('ONLINE_TERMINAL_URL', () => {
  it('frames the chart route, not the app root', () => {
    expect(ONLINE_TERMINAL_URL).toBe(`${KAIBOT_APP_URL.replace(/\/$/, '')}/chart`)
    expect(new URL(ONLINE_TERMINAL_URL).pathname).toBe('/chart')
  })
})

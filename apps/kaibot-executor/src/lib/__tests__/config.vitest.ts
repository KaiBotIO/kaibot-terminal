import { describe, expect, it } from 'vitest'
import { KAIBOT_APP_URL, ONLINE_TERMINAL_URL, buildTerminalSrc } from '../config'

describe('ONLINE_TERMINAL_URL', () => {
  it('frames the chart route, not the app root', () => {
    expect(ONLINE_TERMINAL_URL).toBe(`${KAIBOT_APP_URL.replace(/\/$/, '')}/chart`)
    expect(new URL(ONLINE_TERMINAL_URL).pathname).toBe('/chart')
  })
})

describe('buildTerminalSrc', () => {
  const base = 'https://app.kaibot.io/chart'

  it('asks Studio for the chromeless render only when embedding', () => {
    expect(new URL(buildTerminalSrc({ embed: true }, base)).searchParams.get('embed')).toBe('1')
    expect(new URL(buildTerminalSrc({}, base)).searchParams.has('embed')).toBe(false)
  })

  it('keeps the symbol deep-link alongside the embed flag', () => {
    const url = new URL(buildTerminalSrc({ symbol: 'BTCUSDT', exchange: 'binance', embed: true }, base))
    expect(url.searchParams.get('symbol')).toBe('BINANCE:BTCUSDT')
    expect(url.searchParams.get('embed')).toBe('1')
    expect(url.pathname).toBe('/chart')
  })

  it('leaves an already-qualified symbol alone', () => {
    const url = new URL(buildTerminalSrc({ symbol: 'INDEX:BTC', exchange: 'binance' }, base))
    expect(url.searchParams.get('symbol')).toBe('INDEX:BTC')
  })

  it('carries the shell origin only on the embed URL', () => {
    const embed = new URL(buildTerminalSrc({ embed: true, host: 'http://shell.example:1420' }, base))
    expect(embed.searchParams.get('host')).toBe('http://shell.example:1420')
    const tab = new URL(buildTerminalSrc({ host: 'http://shell.example:1420' }, base))
    expect(tab.searchParams.has('host')).toBe(false)
    expect(new URL(buildTerminalSrc({ embed: true, host: '  ' }, base)).searchParams.has('host')).toBe(false)
  })

  it('still flags the embed when the base is not a parsable URL', () => {
    expect(buildTerminalSrc({ embed: true }, '/chart')).toBe('/chart?embed=1')
  })
})

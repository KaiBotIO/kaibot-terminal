import { describe, expect, it } from 'bun:test'
import { defaultAccountIdFor } from './venue-accounts.js'
import { BybitAdapter } from './adapters/bybit.js'

// The signal client used to hardcode Deribit's coin-wallet rule and answer
// 'default' for every other venue — an id no adapter ever reports, so a Bybit
// execution row could never match its own balance/position rows.

describe('defaultAccountIdFor', () => {
  it('Deribit: unchanged coin-wallet rule (btc / eth / usdc, BTC fallback)', () => {
    expect(defaultAccountIdFor('deribit', 'BTC-PERPETUAL')).toBe('btc')
    expect(defaultAccountIdFor('deribit', 'ETH-PERPETUAL')).toBe('eth')
    expect(defaultAccountIdFor('deribit', 'BTC_USDC-PERPETUAL')).toBe('usdc')
    expect(defaultAccountIdFor('deribit', 'SOL_USDC-PERPETUAL')).toBe('usdc')
    expect(defaultAccountIdFor('deribit', 'eth-26DEC26')).toBe('eth')
    expect(defaultAccountIdFor('Deribit', 'XRP-PERPETUAL')).toBe('btc')
  })

  it('Bybit: the single unified wallet the adapter reports, for every category', async () => {
    expect(defaultAccountIdFor('bybit', 'SOLUSDT')).toBe('unified')
    expect(defaultAccountIdFor('bybit', 'BTCUSD')).toBe('unified')
    expect(defaultAccountIdFor('BYBIT', 'ETHPERP')).toBe('unified')
    const adapter = new BybitAdapter()
    ;(adapter as any).unifiedAccount = true
    const [account] = await adapter.getAccounts()
    expect(account.accountId).toBe(defaultAccountIdFor('bybit', 'SOLUSDT'))
  })

  it('Binance: the USDⓈ-M futures wallet; unknown venues keep the legacy default', () => {
    expect(defaultAccountIdFor('binance', 'BTCUSDT')).toBe('usdm-futures')
    expect(defaultAccountIdFor('tradestation', 'MESZ26')).toBe('default')
    expect(defaultAccountIdFor('paper', 'MNQZ26')).toBe('default')
  })
})

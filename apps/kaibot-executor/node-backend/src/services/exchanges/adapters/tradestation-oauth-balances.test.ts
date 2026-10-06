import { test, expect } from 'bun:test'
import { TradeStationOAuthAdapter } from './tradestation-oauth.js'

// Regression: OAuth is now the default TradeStation path for every install, so
// it has to map the v3 payload like the CouchDB adapter does. It used to read
// top-level margin fields that don't exist (→ $0), keep numbers as strings, and
// hit an account-less /positions route.
const ACCOUNTS = { Accounts: [{ AccountID: '21084936' }] }

const RAW_BALANCE = {
  AccountID: '21084936',
  AccountType: 'Futures',
  CashBalance: '11957.89',
  Equity: '11983.89',
  BalanceDetail: {
    RealizedProfitLoss: '-0.4',
    UnrealizedProfitLoss: '26',
    InitialMargin: '4638',
    MaintenanceMargin: '4216',
  },
}

const RAW_POSITION = {
  PositionID: '283893625',
  AccountID: '21084936',
  Symbol: 'MNQU26',
  LongShort: 'Long',
  Quantity: '1',
  AveragePrice: '29428.5',
  Last: '29443.25',
  UnrealizedProfitLoss: '26',
  MarketValue: '58886.5',
  InitialRequirement: '4638',
}

function stub(adapter: TradeStationOAuthAdapter, routes: Record<string, unknown>) {
  const calls: string[] = []
  ;(adapter as any).call = async (path: string) => {
    calls.push(path)
    const hit = Object.entries(routes).find(([suffix]) => path.endsWith(suffix))
    if (!hit) throw new Error(`unexpected route ${path}`)
    return hit[1]
  }
  return calls
}

test('getBalances coerces strings and reads nested BalanceDetail margin', async () => {
  const adapter = new TradeStationOAuthAdapter()
  stub(adapter, { '/v3/brokerage/accounts': ACCOUNTS, '/balances': { Balances: [RAW_BALANCE] } })

  const [b] = await adapter.getBalances()
  expect(b.balance).toBe(11957.89)
  expect(b.equity).toBe(11983.89)
  expect(b.realizedPnL).toBe(-0.4)
  expect(b.unrealizedPnL).toBe(26)
  expect(b.initialMargin).toBe(4638)
  expect(b.maintenanceMargin).toBe(4216)
})

test('getPositions scopes the route to the account ids and derives leverage', async () => {
  const adapter = new TradeStationOAuthAdapter()
  const calls = stub(adapter, {
    '/v3/brokerage/accounts': ACCOUNTS,
    '/positions': { Positions: [RAW_POSITION] },
  })

  const [p] = await adapter.getPositions()
  expect(calls).toContain('/v3/brokerage/accounts/21084936/positions')
  expect(p.side).toBe('long')
  expect(p.size).toBe(1)
  expect(p.entryPrice).toBe(29428.5)
  expect(p.unrealizedPnL).toBe(26)
  expect(p.leverage).toBeCloseTo(12.7, 1)
})

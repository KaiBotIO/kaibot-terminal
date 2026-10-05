import { test, expect } from 'bun:test'
import { TradeStationCouchDBAdapter } from './tradestation-couchdb.js'

// Regression (2026-08-24): the v3 balances payload carries margin NESTED under
// BalanceDetail; the top-level InitialMargin/MaintenanceMargin fields don't
// exist. The old mapping read $0 even with an open 1-MNQ position, hiding the
// real margin from the breathing-room guard and the §9 verification. Payload
// below is the raw response captured from the live account.
const RAW_BALANCE = {
  AccountID: '21084936',
  AccountType: 'Futures',
  CashBalance: '11957.89',
  BuyingPower: '7337.39',
  Equity: '11983.89',
  MarketValue: '58883',
  BalanceDetail: {
    RealizedProfitLoss: '-0.4',
    UnrealizedProfitLoss: '26',
    DayTradeMargin: '4638',
    InitialMargin: '4638',
    MaintenanceMargin: '4216',
  },
  CurrencyDetails: [
    { Currency: 'USD', InitialMargin: '4638', MaintenanceMargin: '4216' },
  ],
}

test('getBalances maps nested BalanceDetail margin fields', async () => {
  const adapter = new TradeStationCouchDBAdapter()
  ;(adapter as any).cached = async (_key: string, _fn: () => Promise<unknown>) => ({
    Balances: [RAW_BALANCE],
  })
  ;(adapter as any).getAccountsRaw = async () => ({ Accounts: [{ AccountID: '21084936' }] })
  const balances = await adapter.getBalances()
  const b = balances.find((x) => x.accountId === '21084936')
  expect(b).toBeDefined()
  expect(b!.initialMargin).toBe(4638)
  expect(b!.maintenanceMargin).toBe(4216)
  expect(b!.realizedPnL).toBe(-0.4)
  expect(b!.unrealizedPnL).toBe(26)
})

test('getPositions derives real futures leverage from MarketValue/InitialRequirement', async () => {
  const adapter = new TradeStationCouchDBAdapter()
  ;(adapter as any).getAccountsRaw = async () => ({ Accounts: [{ AccountID: '21084936' }] })
  ;(adapter as any).cached = async () => ({
    Positions: [
      {
        PositionID: '283893625', AccountID: '21084936', Symbol: 'MNQU26',
        LongShort: 'Long', Quantity: '1', AveragePrice: '29428.5', Last: '29443.25',
        UnrealizedProfitLoss: '26', MarketValue: '58886.5', InitialRequirement: '4638',
      },
    ],
  })
  const [p] = await adapter.getPositions()
  expect(p.leverage).toBeCloseTo(12.7, 1)
  expect(p.side).toBe('long')
})

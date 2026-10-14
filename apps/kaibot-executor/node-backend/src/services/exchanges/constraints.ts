export const EXCHANGE_CONSTRAINTS = {
  tradestation: {
    supportedInstruments: ['ES', 'MES', 'NQ', 'MNQ'],
    instrumentType: 'futures',
    description: 'E-mini and Micro E-mini Futures',
    apiVersion: 'v3',
    pollingInterval: 30000,
    sessionRefreshTime: 15 * 60 * 1000,
  },
  deribit: {
    supportedInstruments: ['BTC-PERPETUAL', 'ETH-PERPETUAL'],
    instrumentType: 'inverse_perpetual',
    description: 'Inverse Perpetual Contracts',
    apiVersion: 'v2',
    pollingInterval: 5000,
    sessionRefreshTime: 15 * 60 * 1000,
    websocketEndpoint: {
      mainnet: 'wss://www.deribit.com/ws/api/v2',
      testnet: 'wss://test.deribit.com/ws/api/v2'
    }
  },
  bybit: {
    supportedInstruments: ['BTCUSDT', 'ETHUSDT', 'BTCUSD', 'ETHUSD'],
    instrumentType: 'linear_and_inverse_perpetual',
    description: 'USDT-margined (linear) and coin-margined (inverse) perpetuals + spot',
    apiVersion: 'v5',
    pollingInterval: 10000,
    sessionRefreshTime: 15 * 60 * 1000,
    websocketEndpoint: {
      mainnet: 'wss://stream.bybit.com/v5/private',
      testnet: 'wss://stream-testnet.bybit.com/v5/private'
    }
  },
}
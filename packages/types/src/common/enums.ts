export enum PositionSide {
  LONG = 'long',
  SHORT = 'short'
}

export enum PositionStatus {
  PENDING = 'pending',
  OPEN = 'open',
  CLOSED = 'closed'
}

export enum OrderType {
  MARKET = 'market',
  LIMIT = 'limit',
  STOP = 'stop',
  STOP_LIMIT = 'stop_limit'
}

export enum OrderStatus {
  PENDING = 'pending',
  FILLED = 'filled',
  CANCELLED = 'cancelled',
  REJECTED = 'rejected'
}

export enum TradeSide {
  BUY = 'buy',
  SELL = 'sell'
}

export enum ExchangeType {
  ALPACA = 'alpaca',
  TRADESTATION = 'tradestation',
  IBKR = 'ibkr',
  TD_AMERITRADE = 'td_ameritrade',
  BINANCE = 'binance',
  COINBASE = 'coinbase'
}

export enum InstrumentType {
  STOCK = 'stock',
  OPTION = 'option',
  CRYPTO = 'crypto',
  FOREX = 'forex',
  FUTURES = 'futures'
}
export interface ExchangeCredentials {
  type: 'apiKey' | 'oauth' | 'password';
  [key: string]: any;
}

export interface Account {
  id: string;
  exchangeName: string;
  accountId: string;
  accountType?: string;
  name: string;
  currency: string;
}

export interface Balance {
  accountId: string;
  balance: number;
  equity: number;
  realizedPnL: number;
  unrealizedPnL: number;
  initialMargin?: number;
  maintenanceMargin?: number;
  currency: string;
  timestamp: number;
}

export interface Position {
  id: string;
  accountId: string;
  symbol: string;
  side: 'long' | 'short';
  size: number;
  entryPrice: number;
  markPrice?: number;
  unrealizedPnL?: number;
  marginType?: string;
  leverage?: number;
}

export interface Order {
  accountId: string;
  symbol: string;
  side: 'buy' | 'sell';
  orderType: 'market' | 'limit' | 'stop' | 'stopLimit';
  quantity: number;
  price?: number;
  stopPrice?: number;
  timeInForce?: 'GTC' | 'IOC' | 'FOK' | 'DAY';
  reduceOnly?: boolean;
  label?: string;
  // Caller-supplied idempotency token. Adapters that support a broker-side
  // client order id (Bybit orderLinkId, Binance newClientOrderId) forward it so a
  // duplicate submit is rejected at the broker across a crash/retry; adapters
  // without one ignore it (the manual path also dedups locally).
  clientOrderId?: string;
  // For stop orders: which price channel the exchange watches
  // (Deribit: 'last_price' | 'mark_price' | 'index_price'). Defaults to 'last_price'.
  triggerType?: 'last_price' | 'mark_price' | 'index_price';
}

// Fee a venue charged on a fill. `commission` is always in USD (account
// currency); the native pair keeps the venue's own figure when it charged in
// coin (Deribit inverse: BTC/ETH) so the conversion stays auditable.
export interface FillFee {
  commission: number;
  feeNative?: number;
  feeCurrency?: string;
}

export interface OrderResult {
  orderId: string;
  status: 'pending' | 'filled' | 'partially_filled' | 'cancelled' | 'rejected';
  filledQuantity?: number;
  averagePrice?: number;
  message?: string;
  // USD fee on the immediate fill when the venue reports it with the order
  // (Deribit market orders fill inside the place call, so settlement never
  // polls for it).
  commission?: number;
  feeNative?: number;
  feeCurrency?: string;
}

// Settlement / reconciliation order status, returned by getOrderStatus.
// `working` = still live at the broker (not yet terminal). The other states are
// terminal. `unknown` means the broker no longer reports the order at all.
export type OrderStatusState =
  | 'working'
  | 'filled'
  | 'partially_filled'
  | 'cancelled'
  | 'rejected'
  | 'unknown';

export interface OrderStatus {
  orderId: string;
  state: OrderStatusState;
  filledQuantity?: number;
  averagePrice?: number;
  // USD, total for the order so far (cumulative across partial fills).
  commission?: number;
  feeNative?: number;
  feeCurrency?: string;
  // Epoch ms of the fill, when the venue reports it. A resting stop can fill
  // long before we poll it; bookkeeping wants the real fill time, not "now".
  filledAtMs?: number;
  // Only meaningful with state 'unknown': true when a venue query SUCCEEDED and
  // positively reported no such order. False/absent = the lookup itself failed
  // or was inconclusive — the order may still exist at the broker, so callers
  // must NOT treat 'unknown' as venue-confirmed never-placed.
  absenceConfirmed?: boolean;
  raw?: any;
}

// A resting order at the venue as the ops open-orders view reports it. Venue
// fields normalised; `raw` keeps the venue's own row for the operator.
export interface OpenOrder {
  orderId: string;
  symbol: string;
  side: 'buy' | 'sell';
  // Venue order type ('limit', 'stop_market', 'take_limit', ...).
  type: string;
  amount: number;
  price: number | null;
  triggerPrice: number | null;
  reduceOnly: boolean;
  label: string | null;
  state: string;
  createdAtMs: number | null;
  raw?: any;
}

// Context an adapter may need to resolve an order by id (account, symbol,
// category). Optional — adapters that don't need it ignore unknown fields.
export interface OrderQueryContext {
  accountId?: string;
  symbol?: string;
  category?: string;
}

// Per-symbol market status for the market-open guard. tradeTimeMs is the epoch
// ms of the last trade; a stale value means the session is closed/halted.
export interface MarketStatus {
  symbol: string;
  last: number;
  tradeTimeMs: number;
}

export type UpdateCallback = (data: {
  type: 'account' | 'balance' | 'position' | 'order';
  data: any;
}) => void;

export interface ExchangeAdapter {
  name: string;
  connect(credentials: ExchangeCredentials): Promise<void>;
  disconnect(): Promise<void>;
  refreshSession(): Promise<void>;
  getAccounts(): Promise<Account[]>;
  getBalances(): Promise<Balance[]>;
  getPositions(): Promise<Position[]>;
  placeOrder(order: Order): Promise<OrderResult>;
  // ctx carries the venue symbol/category. Bybit/Binance REQUIRE the symbol to
  // cancel; placeOrder returns a bare broker id, so callers pass ctx (or the
  // adapter resolves the symbol from the live order as a fallback).
  cancelOrder(orderId: string, ctx?: OrderQueryContext): Promise<void>;
  // Optional: query a placed order's current status by id, used by the order
  // settlement poller and the reconciler. Adapters without an order-status
  // endpoint omit it — settlement then trusts the placeOrder result as-is.
  getOrderStatus?(orderId: string, ctx?: OrderQueryContext): Promise<OrderStatus>;
  // Optional: the total fee the venue charged on one order, from its trade
  // history (the commission backfill). Null when the venue has no trades for
  // the id. Adapters whose getOrderStatus already carries the fee omit it.
  getOrderFee?(orderId: string, ctx?: OrderQueryContext): Promise<FillFee | null>;
  // Optional: every resting order (incl. trigger/stop orders) of this
  // connection's account, for one instrument or all. Read-only; the ops
  // open-orders view verifies the venue against the local bracket book.
  getOpenOrders?(ctx?: { symbol?: string }): Promise<OpenOrder[]>;
  // Optional: per-symbol last trade price + time, used by the market-open guard
  // to refuse market orders into a stale/closed session. Crypto venues trade
  // 24/7 and omit it (always considered open). TradeStation futures implement it.
  getMarketStatus?(symbols: string[]): Promise<Map<string, MarketStatus>>;
  // Whether this venue trades around the clock (crypto). When true, the
  // market-open guard is skipped entirely.
  alwaysOpen?: boolean;
  subscribeToUpdates(callback: UpdateCallback): void;
  unsubscribeFromUpdates(): void;
  // Optional: resolve a tradable symbol from the signal's symbol. TradeStation
  // uses this to map a bare futures ROOT (MES, MNQ, ...) to the front-month
  // dated contract. Adapters that need no mapping omit it (signal symbol = order
  // symbol). When present, the signal pipeline calls it once and reuses the
  // result for the entry order, bracket legs and the local signal record.
  resolveSymbol?(symbol: string): Promise<string>;
  // Optional: the venue's current price for a symbol (mark/last, public
  // endpoint, no auth). Used by the basis guard to compare a composite signal
  // price against the venue before entering. Adapters without a cheap ticker
  // omit it — the guard is then inconclusive (fail-open with a flagged event).
  getLastPrice?(symbol: string): Promise<number | null>;
  // Optional: a public snapshot for a market (mark, 24h change, funding).
  // The Markets page shows it per crypto market; adapters without a public
  // ticker omit it and the page shows the mark only.
  getMarketTicker?(symbol: string): Promise<MarketTicker | null>;
}

export interface MarketTicker {
  mark: number | null;
  /** Percentage move over the last 24h, signed. */
  change24hPct: number | null;
  /** Current funding rate as a fraction (0.0001 = 1 bp), null when not a perp. */
  fundingRate: number | null;
}

export interface ExchangeSession {
  userId: string;
  exchangeName: string;
  adapter: ExchangeAdapter;
  status: 'connected' | 'disconnected' | 'error' | 'pending_oauth';
  lastRefresh?: number;
  error?: string;
  // Connection label ('default' for the unlabeled row) and the account key
  // its adapter namespaces account ids with (undefined on the default
  // connection). See account-scope.ts.
  label: string;
  accountKey?: string;
  connectionId: string;
}
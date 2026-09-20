# Comprehensive Exchange Integration Guide for KaiBot Executor

## Table of Contents
1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Supported Exchanges](#supported-exchanges)
4. [Implementation Plan](#implementation-plan)
5. [TradeStation Integration](#tradestation-integration)
6. [Multi-Exchange Framework](#multi-exchange-framework)
7. [Database Schema](#database-schema)
8. [UI Components](#ui-components)
9. [Security Considerations](#security-considerations)
10. [Implementation Roadmap](#implementation-roadmap)

## Overview

This guide consolidates all exchange integration documentation for the KaiBot Executor, providing a comprehensive roadmap for implementing multi-exchange support with a focus on TradeStation as the initial implementation.

### Project Context
- **Application**: KaiBot Executor (Tauri-based desktop app)
- **Backend**: Node.js/Bun service for API communication
- **Frontend**: React with TypeScript in Tauri WebView
- **Database**: SQLite for local storage
- **Architecture**: Secure backend-handled API communication

## Architecture

### System Architecture
```
┌─────────────────────────────────────────────────────────────┐
│                       Tauri Application                       │
│                                                               │
│  ┌─────────────────────┐         ┌─────────────────────┐    │
│  │   Tauri Frontend    │         │   Node Backend      │    │
│  │   (React WebView)   │◄────────┤   (Bun Process)     │    │
│  │                     │  HTTP/  │                     │    │
│  │ - Exchanges Page    │   WS    │ - Exchange APIs     │    │
│  │ - Account Display   │         │ - Session Manager   │    │
│  │ - Connection Dialog │         │ - Data Polling      │    │
│  └─────────────────────┘         └──────────┬──────────┘    │
│                                              │                │
└──────────────────────────────────────────────┼───────────────┘
                                               │
                                               ▼
                              ┌─────────────────────────────┐
                              │    External Exchange APIs    │
                              │ (TradeStation, Deribit, etc)│
                              └─────────────────────────────┘
```

### Key Benefits of This Architecture
1. **Security**: API credentials never exposed to frontend
2. **Performance**: Background service manages polling
3. **Reliability**: Session persistence across app restarts
4. **Native Feel**: Desktop notifications and system integration
5. **Cross-Platform**: Works on Windows, macOS, Linux

## Supported Exchanges

### Phase 1: TradeStation
- **Instruments**: ES, MES, NQ, MNQ (E-mini and Micro E-mini futures)
- **Authentication**: Username/Password + API Keys
- **API Version**: v2/v3
- **Update Frequency**: 30-second polling

### Phase 2: Deribit
- **Instruments**: BTC-PERPETUAL, ETH-PERPETUAL (Inverse Perpetuals only)
- **Authentication**: API Key + Secret
- **Connection**: WebSocket-first
- **Real-time**: Live position updates

### Phase 3: Bybit
- **Instruments**: USDT Perpetuals only
- **Authentication**: API Key + Secret
- **Features**: Sub-account support
- **Connection**: REST + WebSocket

### Future Exchanges
- Binance (Spot & Futures)
- Interactive Brokers
- TD Ameritrade
- Coinbase

## Implementation Plan

### Core Framework Components

#### 1. Base Exchange Interface
```typescript
// node-backend/src/services/exchanges/types.ts
interface ExchangeAdapter {
  name: string;
  connect(credentials: ExchangeCredentials): Promise<void>;
  disconnect(): Promise<void>;
  refreshSession(): Promise<void>;
  getAccounts(): Promise<Account[]>;
  getBalances(): Promise<Balance[]>;
  getPositions(): Promise<Position[]>;
  placeOrder(order: Order): Promise<OrderResult>;
  cancelOrder(orderId: string): Promise<void>;
  subscribeToUpdates(callback: UpdateCallback): void;
  unsubscribeFromUpdates(): void;
}

interface ExchangeCredentials {
  type: 'apiKey' | 'oauth' | 'password';
  [key: string]: any;
}
```

#### 2. Exchange Manager
```typescript
// node-backend/src/services/exchanges/exchangeManager.ts
class ExchangeManager {
  private exchanges: Map<string, ExchangeAdapter> = new Map();
  private sessions: Map<string, ExchangeSession> = new Map();

  registerExchange(adapter: ExchangeAdapter) {
    this.exchanges.set(adapter.name, adapter);
  }

  async connectExchange(userId: string, exchangeName: string, credentials: ExchangeCredentials) {
    const adapter = this.exchanges.get(exchangeName);
    if (!adapter) throw new Error(`Exchange ${exchangeName} not supported`);
    
    await adapter.connect(credentials);
    this.sessions.set(`${userId}:${exchangeName}`, {
      userId,
      exchangeName,
      adapter,
      status: 'connected'
    });
  }

  async getUnifiedAccountData(userId: string) {
    const userSessions = Array.from(this.sessions.entries())
      .filter(([key]) => key.startsWith(userId));
    
    const allAccounts = await Promise.all(
      userSessions.map(async ([_, session]) => ({
        exchange: session.exchangeName,
        accounts: await session.adapter.getAccounts(),
        balances: await session.adapter.getBalances(),
        positions: await session.adapter.getPositions()
      }))
    );
    
    return allAccounts;
  }
}
```

## TradeStation Integration

### Implementation Tasks

#### 1. Authentication Flow
- [ ] Create TradeStation connection dialog in Exchanges page
- [ ] Implement OAuth2 authentication with TradeStation API
  - [ ] Use `/v2/Security/Authorize` endpoint
  - [ ] Handle authorization codes and access tokens
  - [ ] Implement refresh token mechanism (15-minute intervals)
- [ ] Store encrypted credentials in SQLite database
- [ ] Handle token refresh before expiry
- [ ] Add connection status indicators
- [ ] Implement disconnection flow

#### 2. Session Manager Service
Create `node-backend/src/services/tradestation/sessionManager.ts`:
- [ ] Port `TradeStationSession` class functionality
- [ ] Implement automatic token refresh logic
- [ ] Handle session lifecycle (init, resume, close)
- [ ] Manage multiple concurrent sessions
- [ ] Add email notifications for API expiry

#### 3. API Service Implementation
Create `node-backend/src/services/tradestation/api.ts`:
- [ ] Authentication methods
  - [ ] Initial authorization
  - [ ] Token refresh
  - [ ] Session validation
- [ ] Account data fetching
  - [ ] `/v3/brokerage/accounts` integration
  - [ ] `/v3/brokerage/accounts/{ids}/balances` integration
- [ ] Market data streaming
- [ ] Order placement/management
- [ ] Error handling with retry logic

#### 4. Data Models
```typescript
interface TradeStationAccount {
  Key: string; // Account ID from API
  Name: string;
  Type: string;
  TypeDescription: string;
  MarketValue: number;
  Equity: number;
  Balance: number;
  Currency: string;
}

interface TradeStationBalance {
  Key: string; // Account ID
  AccountBalance: number;
  Equity: number;
  RealizedProfitLoss: number;
  UnrealizedProfitLoss: number;
  InitialMarginRequirement: number;
  MaintenanceMarginRequirement: number;
  MarginEquity: number;
  LastUpdated: string;
}

interface TradeStationSession {
  id: string;
  access_token: string;
  refresh_token: string;
  expires_in: number;
  timestamp: number;
  status: 'active' | 'refreshing' | 'expired' | 'error';
}
```

### Legacy Code Reference

The implementation is based on proven patterns from the legacy system:

#### Session Management Pattern
```javascript
class TradeStationSession {
  constructor(doc, resume, higherCloseSession) {
    this.axios = Axios.create({
      baseURL: "https://api.tradestation.com",
      timeout: 10000,
    });
    
    // Session configuration
    this.sim = doc.sim || false;
    this.exchange_id = doc._id;
    
    // Database connections
    this.user_db = nano.use(`userdb-${utf8ToHex(user)}`);
    this.session_db = nano.use(`user-sessions`);
  }

  authenticateSession(callback) {
    // OAuth2 password grant flow
    const authorization_request = qs.stringify({
      grant_type: "password",
      username: this.doc.session.username,
      password: this.doc.session.password,
      client_id: this.doc.session.apikey,
      client_secret: this.doc.session.apisecret,
    });

    this.axios
      .post("/v2/Security/Authorize", authorization_request, config)
      .then((reply) => {
        const session = {
          access_token: reply.data.access_token,
          refresh_token: reply.data.refresh_token,
          expires_in: reply.data.expires_in,
          timestamp: new Date().getTime(),
          ts_refresh: true,
        };
        callback(session);
      });
  }

  refreshData(callback) {
    // Fetch accounts and balances
    this.axios
      .get(`/v3/brokerage/accounts`, config)
      .then((reply) => {
        const ts_accounts = reply.data.Accounts;
        const keys = _.map(ts_accounts, (d) => d["AccountID"]);

        this.axios
          .get(`/v3/brokerage/accounts/${keys.join(",")}/balances`, config)
          .then((reply) => {
            const ts_balances = reply.data.Balances;
            this.writeData({ ts_accounts, ts_balances });
          });
      });
  }
}
```

## Multi-Exchange Framework

### Exchange Adapters

Each exchange will have its own adapter implementing the common interface:

#### TradeStation Adapter
```typescript
export class TradeStationAdapter implements ExchangeAdapter {
  name = 'tradestation';
  
  async connect(credentials: ExchangeCredentials) {
    // OAuth2 authentication
  }
  
  async getAccounts() {
    // Fetch from /v3/brokerage/accounts
  }
  
  async getBalances() {
    // Fetch from /v3/brokerage/accounts/{ids}/balances
  }
}
```

#### Deribit Adapter (WebSocket-based)
```typescript
export class DeribitAdapter implements ExchangeAdapter {
  name = 'deribit';
  private ws: WebSocket;
  
  async connect(credentials: ExchangeCredentials) {
    this.ws = new WebSocket('wss://www.deribit.com/ws/api/v2');
    await this.authenticate();
  }
  
  subscribeToUpdates(callback: UpdateCallback) {
    this.ws.on('message', (data) => {
      callback(this.parseUpdate(data));
    });
  }
}
```

## Database Schema

### Generic Schema for Multi-Exchange Support

```sql
-- Generic exchange connections table
CREATE TABLE exchange_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  exchange_name TEXT NOT NULL,
  connection_type TEXT NOT NULL, -- 'apiKey', 'oauth', 'password'
  encrypted_credentials TEXT NOT NULL,
  session_data TEXT, -- JSON for exchange-specific session data
  is_active INTEGER DEFAULT 1,
  last_refresh INTEGER,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- Generic accounts table
CREATE TABLE exchange_accounts (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  exchange_name TEXT NOT NULL,
  account_id TEXT NOT NULL,
  account_type TEXT,
  account_data TEXT NOT NULL, -- JSON data
  last_sync INTEGER DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (connection_id) REFERENCES exchange_connections(id)
);

-- Generic balances cache
CREATE TABLE exchange_balances (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  balance_data TEXT NOT NULL, -- JSON data
  timestamp INTEGER DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (account_id) REFERENCES exchange_accounts(account_id)
);

-- Generic positions table
CREATE TABLE exchange_positions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  size REAL NOT NULL,
  entry_price REAL,
  mark_price REAL,
  unrealized_pnl REAL,
  position_data TEXT, -- JSON for exchange-specific fields
  last_update INTEGER DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (account_id) REFERENCES exchange_accounts(id)
);
```

### TradeStation-Specific Tables

```sql
-- TradeStation connections table
CREATE TABLE tradestation_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  encrypted_credentials TEXT NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  token_expiry INTEGER, -- Unix timestamp
  session_data TEXT, -- JSON session data
  is_active INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- TradeStation accounts cache
CREATE TABLE tradestation_accounts (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  account_type TEXT,
  account_data TEXT NOT NULL, -- JSON data
  last_sync INTEGER DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (connection_id) REFERENCES tradestation_connections(id)
);

-- TradeStation balances cache
CREATE TABLE tradestation_balances (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  balance_data TEXT NOT NULL, -- JSON data
  timestamp INTEGER DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (account_id) REFERENCES tradestation_accounts(account_id)
);
```

## UI Components

### Exchange Setup Guide Component

```tsx
// src/components/exchanges/ExchangeSetupGuide.tsx
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ExternalLink, Info, Shield, AlertCircle } from "lucide-react";

export function ExchangeSetupGuide({ exchange }: { exchange: string }) {
  return (
    <div className="space-y-4">
      <Alert>
        <Info className="h-4 w-4" />
        <AlertDescription>
          Before connecting, you'll need to obtain API credentials from {exchange}.
          Follow the guide below to get started.
        </AlertDescription>
      </Alert>

      {exchange === 'tradestation' && <TradeStationGuide />}
      {exchange === 'deribit' && <DeribitGuide />}
      {exchange === 'bybit' && <BybitGuide />}
    </div>
  );
}
```

### Exchange Connection Form

```tsx
// src/components/exchanges/ExchangeConnectionForm.tsx
export function ExchangeConnectionForm() {
  const [selectedExchange, setSelectedExchange] = useState<string>('tradestation');
  
  return (
    <Tabs value={selectedExchange} onValueChange={setSelectedExchange}>
      <TabsList className="grid w-full grid-cols-3">
        <TabsTrigger value="tradestation">TradeStation</TabsTrigger>
        <TabsTrigger value="deribit">Deribit</TabsTrigger>
        <TabsTrigger value="bybit">Bybit</TabsTrigger>
      </TabsList>
      
      <TabsContent value="tradestation">
        <TradeStationForm />
      </TabsContent>
      
      <TabsContent value="deribit">
        <DeribitForm />
      </TabsContent>
      
      <TabsContent value="bybit">
        <BybitForm />
      </TabsContent>
    </Tabs>
  );
}
```

### Account Display Component

```tsx
// src/components/exchanges/TradeStationAccountCard.tsx
export function TradeStationAccountCard({ account, balance }: Props) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{account.Name}</CardTitle>
        <CardDescription>{account.Type}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4">
          <Metric label="Balance" value={formatCurrency(balance.AccountBalance)} />
          <Metric label="Equity" value={formatCurrency(balance.Equity)} />
          <Metric label="Realized P&L" value={formatCurrency(balance.RealizedProfitLoss)} />
          <Metric label="Unrealized P&L" value={formatCurrency(balance.UnrealizedProfitLoss)} />
          <Metric label="Initial Margin" value={formatCurrency(balance.InitialMarginRequirement)} />
          <Metric label="Maintenance Margin" value={formatCurrency(balance.MaintenanceMarginRequirement)} />
        </div>
      </CardContent>
    </Card>
  );
}
```

## Security Considerations

### 1. Credential Encryption
- Use existing crypto module for encryption
- Store encrypted credentials in SQLite
- Never expose API credentials to frontend
- Implement secure key derivation

### 2. Session Security
- Automatic token refresh before expiry
- Secure storage of access/refresh tokens
- Session timeout handling
- Graceful recovery from auth failures

### 3. API Security
- Rate limiting for all API calls
- Request signing where required
- IP whitelisting support
- Audit logging for all operations

### 4. Network Security
- HTTPS/WSS only connections
- Certificate validation
- Proxy support for corporate networks
- Connection timeout handling

## Implementation Roadmap

### Phase 1: Core Framework (Week 1)
- [ ] Create base ExchangeAdapter interface
- [ ] Implement ExchangeManager service
- [ ] Set up generic database schema
- [ ] Create unified API endpoints
- [ ] Implement credential encryption

### Phase 2: TradeStation Integration (Week 2-3)
- [ ] Implement TradeStation adapter
- [ ] Port legacy authentication logic
- [ ] Create session management service
- [ ] Add account display components
- [ ] Implement data polling (30-second intervals)
- [ ] Test with live accounts

### Phase 3: Background Services (Week 4)
- [ ] Port background service logic
- [ ] Implement automatic token refresh
- [ ] Add session monitoring
- [ ] Email notifications for expiry
- [ ] Error recovery mechanisms

### Phase 4: UI Implementation (Week 5)
- [ ] Create connection dialogs
- [ ] Build account display components
- [ ] Add real-time update indicators
- [ ] Implement error handling UI
- [ ] Create setup guides

### Phase 5: Additional Exchanges (Week 6+)
- [ ] Deribit WebSocket adapter
- [ ] Bybit REST/WS adapter
- [ ] Binance implementation
- [ ] Testing and optimization

### Phase 6: Production Readiness (Week 7-8)
- [ ] Security hardening
- [ ] Performance optimization
- [ ] Comprehensive testing
- [ ] Documentation
- [ ] User guides

## Environment Configuration

### Required Environment Variables
```env
# TradeStation
TRADESTATION_API_URL=https://api.tradestation.com
TRADESTATION_CLIENT_ID=your_client_id
TRADESTATION_CLIENT_SECRET=your_client_secret
TRADESTATION_REDIRECT_URI=http://localhost:3000/exchanges/tradestation/callback

# Deribit
DERIBIT_WS_URL=wss://www.deribit.com/ws/api/v2
DERIBIT_TESTNET_URL=wss://test.deribit.com/ws/api/v2

# Bybit
BYBIT_API_URL=https://api.bybit.com
BYBIT_TESTNET_URL=https://api-testnet.bybit.com
```

## Testing Strategy

### Unit Tests
- Exchange adapter methods
- Session management logic
- Data transformation functions
- Encryption/decryption

### Integration Tests
- Authentication flows
- API communication
- WebSocket connections
- Database operations

### End-to-End Tests
- Complete connection flow
- Account data display
- Real-time updates
- Error scenarios

### Test Scenarios
- Invalid credentials
- API downtime
- Token expiry during operation
- Network failures
- Rate limiting
- WebSocket disconnections

## Monitoring and Maintenance

### Health Checks
- Session status monitoring
- API connectivity tests
- Token expiry warnings
- Data freshness checks

### Logging
- API request/response logging
- Error tracking
- Performance metrics
- User activity audit

### Alerts
- Failed authentication
- API errors
- Session expiry
- Unusual activity

## Conclusion

This comprehensive guide provides a complete roadmap for implementing multi-exchange support in the KaiBot Executor. Starting with TradeStation as the primary implementation, the architecture is designed to easily accommodate additional exchanges through a modular adapter pattern. The combination of secure backend processing, real-time updates, and intuitive UI components ensures a professional trading experience while maintaining the highest security standards.

The implementation leverages proven patterns from the legacy system while modernizing the architecture for better maintainability and extensibility. By following this guide, developers can systematically implement each exchange integration while maintaining consistency across the platform.
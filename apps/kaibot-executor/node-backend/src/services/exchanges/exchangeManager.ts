import { ExchangeAdapter, ExchangeCredentials, ExchangeSession } from './types.js'
import { KaiBotDatabase } from '../../storage/database.js'
import { Crypto } from '../../storage/crypto.js'
import { EventEmitter } from 'events'
import {
  DEFAULT_CONNECTION_LABEL,
  accountKeyOf,
  connectionId,
  normalizeConnectionLabel,
  scopeAdapter,
} from './account-scope.js'

/** Reconnect backoff: 1s, 2s, 4s … capped at 60s. */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.min(attempt, 6))
}

export class ExchangeManager extends EventEmitter {
  // Adapter FACTORIES, not shared instances: each session gets its own adapter
  // so a second user/session connecting the same exchange can never rebind the
  // credentials or subscriptions of an existing one, and disconnecting one
  // session never tears down another's connection (EX3).
  private exchangeFactories: Map<string, () => ExchangeAdapter> = new Map()
  // Keyed by connection id: `<user>:<exchange>` for the default connection,
  // `<user>:<exchange>:<label>` for every further connection on that exchange.
  private sessions: Map<string, ExchangeSession> = new Map()
  private db: KaiBotDatabase
  private crypto: Crypto
  private pollingIntervals: Map<string, NodeJS.Timeout> = new Map()
  private refreshTimeouts: Map<string, NodeJS.Timeout> = new Map()
  private reconnectTimeouts: Map<string, NodeJS.Timeout> = new Map()
  private reconnectAttempts: Map<string, number> = new Map()

  constructor(db: KaiBotDatabase) {
    super()
    this.db = db
    this.crypto = new Crypto()
  }

  registerExchange(name: string, factory: () => ExchangeAdapter): void {
    this.exchangeFactories.set(name, factory)
    console.log(`Registered exchange adapter factory: ${name}`)
  }

  /** Names of all registered venue adapters (subscription venue validation). */
  getRegisteredExchanges(): string[] {
    return [...this.exchangeFactories.keys()]
  }

  /** Fresh, unconnected adapter instance for this exchange (or undefined). */
  createAdapter(exchangeName: string): ExchangeAdapter | undefined {
    return this.exchangeFactories.get(exchangeName)?.()
  }

  // Fresh adapter for a connection: a labeled connection's adapter namespaces
  // its account ids with the label (account-scope.ts).
  private createConnectionAdapter(exchangeName: string, label?: string): ExchangeAdapter | undefined {
    const inner = this.createAdapter(exchangeName)
    if (!inner) return undefined
    return label ? scopeAdapter(inner, label) : inner
  }

  async connectExchange(
    userId: string,
    exchangeName: string,
    credentials: ExchangeCredentials,
    label?: string,
  ): Promise<void> {
    const accountKey = normalizeConnectionLabel(label)
    const sessionKey = connectionId(userId, exchangeName, accountKey)
    const storedLabel = accountKey ?? DEFAULT_CONNECTION_LABEL

    // Reuse this session's own adapter when reconnecting (it may hold OAuth
    // state); otherwise mint a fresh instance — never a registry-shared one.
    const adapter =
      this.sessions.get(sessionKey)?.adapter ?? this.createConnectionAdapter(exchangeName, accountKey)
    if (!adapter) {
      throw new Error(`Exchange ${exchangeName} not supported`)
    }

    try {
      await adapter.connect(credentials)

      const encryptedCredentials = this.crypto.encryptCredentials(credentials)

      await this.db.run(`
        INSERT OR REPLACE INTO exchange_connections (
          id, user_id, exchange_name, connection_type,
          encrypted_credentials, is_active, last_refresh, label
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      `, [
        sessionKey,
        userId,
        exchangeName,
        credentials.type,
        encryptedCredentials,
        Date.now(),
        storedLabel,
      ])

      this.sessions.set(sessionKey, {
        userId,
        exchangeName,
        adapter,
        status: 'connected',
        lastRefresh: Date.now(),
        label: storedLabel,
        accountKey,
        connectionId: sessionKey,
      })

      // Clear any stale pollers/timers so a reconnect doesn't stack duplicates.
      // The reconnect attempt counter is NOT reset here: connect() only proves
      // the session source is reachable (CouchDB-mode TradeStation reads a doc,
      // it never touches the broker). With an expired token every reconnect
      // "succeeded", the first poll 401'd, and the backoff restarted at 1s:
      // a ~1 Hz reconnect storm (20/09/2026). The counter resets on the first
      // successful data refresh instead.
      this.clearTimers(sessionKey)

      this.startDataPolling(sessionKey)
      this.scheduleSessionRefresh(sessionKey)

      adapter.subscribeToUpdates((data) => {
        this.emit('exchangeUpdate', { userId, exchangeName, accountKey, ...data })
      })

      console.log(`Connected to ${exchangeName} for user ${userId}${accountKey ? ` (${accountKey})` : ''}`)
    } catch (error: any) {
      // For OAuth flows, we need to keep the adapter available
      if (error.message === 'OAUTH_REDIRECT_REQUIRED') {
        this.sessions.set(sessionKey, {
          userId,
          exchangeName,
          adapter,
          status: 'pending_oauth',
          error: error.message,
          label: storedLabel,
          accountKey,
          connectionId: sessionKey,
        })
      } else {
        this.sessions.set(sessionKey, {
          userId,
          exchangeName,
          adapter,
          status: 'error',
          error: error.message,
          label: storedLabel,
          accountKey,
          connectionId: sessionKey,
        })
      }
      throw error
    }
  }

  async disconnectExchange(userId: string, exchangeName: string, label?: string): Promise<void> {
    const sessionKey = connectionId(userId, exchangeName, label)
    const session = this.sessions.get(sessionKey)

    if (!session) {
      throw new Error('Session not found')
    }

    await session.adapter.disconnect()
    session.adapter.unsubscribeFromUpdates()

    await this.db.run(`
      UPDATE exchange_connections
      SET is_active = 0
      WHERE id = ?
    `, [sessionKey])

    this.sessions.delete(sessionKey)

    const pollingInterval = this.pollingIntervals.get(sessionKey)
    if (pollingInterval) {
      clearInterval(pollingInterval)
      this.pollingIntervals.delete(sessionKey)
    }

    const refreshTimeout = this.refreshTimeouts.get(sessionKey)
    if (refreshTimeout) {
      clearTimeout(refreshTimeout)
      this.refreshTimeouts.delete(sessionKey)
    }

    console.log(`Disconnected from ${exchangeName} for user ${userId}${session.accountKey ? ` (${session.accountKey})` : ''}`)
  }

  async completeOAuthFlow(userId: string, exchangeName: string, code: string, label?: string): Promise<void> {
    const sessionKey = connectionId(userId, exchangeName, label)
    const session = this.sessions.get(sessionKey)

    if (!session || session.status !== 'pending_oauth') {
      throw new Error('No pending OAuth session found')
    }

    const adapter = session.adapter as any
    if (!adapter.handleAuthorizationCallback) {
      throw new Error('Adapter does not support OAuth callback')
    }

    await adapter.handleAuthorizationCallback(code)

    const storable = adapter.getStorableCredentials?.()
    if (storable) {
      const encryptedCredentials = this.crypto.encryptCredentials(storable)
      await this.db.run(`
        INSERT OR REPLACE INTO exchange_connections (
          id, user_id, exchange_name, connection_type,
          encrypted_credentials, is_active, last_refresh, label
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      `, [sessionKey, userId, exchangeName, 'oauth', encryptedCredentials, Date.now(), session.label])
    }

    session.status = 'connected'
    session.lastRefresh = Date.now()

    this.startDataPolling(sessionKey)
    this.scheduleSessionRefresh(sessionKey)

    adapter.subscribeToUpdates((data: any) => {
      this.emit('exchangeUpdate', { userId, exchangeName, accountKey: session.accountKey, ...data })
    })
  }

  /**
   * One connection's session. Without accountKey this is the default
   * connection (`<user>:<exchange>`), exactly as before multi-connection
   * support; with one it is that labeled connection.
   */
  async getSession(userId: string, exchangeName: string, accountKey?: string): Promise<ExchangeSession | undefined> {
    return this.sessions.get(connectionId(userId, exchangeName, accountKey || undefined))
  }

  /**
   * The session that owns an account id: a namespaced id ('acct2/btc') routes
   * to its labeled connection, a bare one ('btc', '931') to the default.
   */
  async sessionForAccount(
    userId: string,
    exchangeName: string,
    accountId?: string | null,
  ): Promise<ExchangeSession | undefined> {
    return this.getSession(userId, exchangeName, accountKeyOf(accountId))
  }

  /** Every connection on one exchange for this user, default first. */
  async getSessions(userId: string, exchangeName: string): Promise<ExchangeSession[]> {
    const out: ExchangeSession[] = []
    for (const session of this.sessions.values()) {
      if (session.userId === userId && session.exchangeName === exchangeName) out.push(session)
    }
    return out.sort((a, b) => Number(!!a.accountKey) - Number(!!b.accountKey) || a.label.localeCompare(b.label))
  }

  async getAllSessions(userId: string): Promise<ExchangeSession[]> {
    const userSessions: ExchangeSession[] = []
    for (const [key, session] of this.sessions.entries()) {
      if (key.startsWith(`${userId}:`)) {
        userSessions.push(session)
      }
    }
    return userSessions
  }

  private startDataPolling(sessionKey: string): void {
    const session = this.sessions.get(sessionKey)
    if (!session) return

    const pollData = async () => {
      try {
        await this.refreshExchangeData(sessionKey)
      } catch (error) {
        console.error(`Error polling data for ${sessionKey}:`, error)
      }
    }

    pollData()

    const interval = setInterval(pollData, 30000)
    this.pollingIntervals.set(sessionKey, interval)
  }

  async refreshExchangeData(sessionKey: string): Promise<void> {
    const session = this.sessions.get(sessionKey)
    if (!session || session.status !== 'connected') return

    try {
      const accounts = await session.adapter.getAccounts()
      const balances = await session.adapter.getBalances()
      const positions = await session.adapter.getPositions()
      this.reconnectAttempts.delete(sessionKey)

      for (const account of accounts) {
        await this.db.run(`
          INSERT OR REPLACE INTO exchange_accounts (
            id, connection_id, exchange_name, account_id,
            account_type, account_data, last_sync
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [
          `${sessionKey}:${account.accountId}`,
          sessionKey,
          session.exchangeName,
          account.accountId,
          account.accountType,
          JSON.stringify(account),
          Date.now()
        ])
      }

      for (const balance of balances) {
        await this.db.run(`
          INSERT INTO exchange_balances (
            id, account_id, balance_data, timestamp
          ) VALUES (?, ?, ?, ?)
        `, [
          `${sessionKey}:${balance.accountId}:${Date.now()}`,
          `${sessionKey}:${balance.accountId}`,
          JSON.stringify(balance),
          Date.now()
        ])
      }

      this.emit('dataRefreshed', {
        sessionKey,
        accounts,
        balances,
        positions
      })
    } catch (error) {
      console.error(`Error refreshing data for ${sessionKey}:`, error)
      this.markSessionError(sessionKey, error)
    }
  }

  private scheduleSessionRefresh(sessionKey: string): void {
    const session = this.sessions.get(sessionKey)
    if (!session) return

    const refreshTime = 15 * 60 * 1000

    const timeout = setTimeout(async () => {
      try {
        await session.adapter.refreshSession()
        session.lastRefresh = Date.now()

        await this.db.run(`
          UPDATE exchange_connections
          SET last_refresh = ?
          WHERE id = ?
        `, [Date.now(), sessionKey])

        this.scheduleSessionRefresh(sessionKey)
      } catch (error) {
        console.error(`Error refreshing session for ${sessionKey}:`, error)
        this.markSessionError(sessionKey, error)
      }
    }, refreshTime)

    this.refreshTimeouts.set(sessionKey, timeout)
  }

  // Mark a session errored and kick off a backoff reconnect. Without this a
  // single transient WS/refresh failure leaves the session stuck in 'error'
  // forever (refreshExchangeData bails on non-connected status) and every order
  // fails with "session status error".
  private markSessionError(sessionKey: string, error: unknown): void {
    const session = this.sessions.get(sessionKey)
    if (!session) return
    session.status = 'error'
    session.error = error instanceof Error ? error.message : 'Unknown error'
    this.scheduleReconnect(sessionKey)
  }

  private scheduleReconnect(sessionKey: string): void {
    if (this.reconnectTimeouts.has(sessionKey)) return
    const delay = reconnectDelayMs(this.reconnectAttempts.get(sessionKey) ?? 0)
    const timer = setTimeout(() => {
      this.reconnectTimeouts.delete(sessionKey)
      void this.reconnectSession(sessionKey)
    }, delay)
    this.reconnectTimeouts.set(sessionKey, timer)
  }

  private async reconnectSession(sessionKey: string): Promise<void> {
    const session = this.sessions.get(sessionKey)
    if (!session || session.status === 'connected') {
      this.reconnectAttempts.delete(sessionKey)
      return
    }
    const attempt = (this.reconnectAttempts.get(sessionKey) ?? 0) + 1
    this.reconnectAttempts.set(sessionKey, attempt)

    try {
      const row = this.db.get(
        `SELECT encrypted_credentials FROM exchange_connections WHERE id = ? AND is_active = 1`,
        [sessionKey],
      ) as { encrypted_credentials: string } | undefined
      if (!row) {
        this.reconnectAttempts.delete(sessionKey)
        return
      }
      const credentials = this.crypto.decryptCredentials(row.encrypted_credentials) as ExchangeCredentials
      console.log(`Reconnecting ${sessionKey} (attempt ${attempt})…`)
      await this.connectExchange(session.userId, session.exchangeName, credentials, session.accountKey)
      console.log(`Reconnected ${sessionKey}`)
    } catch (error) {
      console.error(
        `Reconnect failed for ${sessionKey} (attempt ${attempt}):`,
        error instanceof Error ? error.message : error,
      )
      // Never give up: a session stuck in 'error' rejects every order with
      // "session status error" until a manual restart. Keep retrying with the
      // capped backoff — an unattended executor cannot self-heal otherwise.
      this.scheduleReconnect(sessionKey)
    }
  }

  private clearTimers(sessionKey: string): void {
    const poll = this.pollingIntervals.get(sessionKey)
    if (poll) {
      clearInterval(poll)
      this.pollingIntervals.delete(sessionKey)
    }
    const refresh = this.refreshTimeouts.get(sessionKey)
    if (refresh) {
      clearTimeout(refresh)
      this.refreshTimeouts.delete(sessionKey)
    }
  }

  async restoreSessions(): Promise<void> {
    const connections = await this.db.all(`
      SELECT * FROM exchange_connections WHERE is_active = 1
    `) as any[]

    for (const connection of connections) {
      // Rows from before migration 035 carry no label → default connection.
      const label: string | undefined =
        connection.label && connection.label !== DEFAULT_CONNECTION_LABEL ? connection.label : undefined
      let credentials: ExchangeCredentials
      try {
        credentials = this.crypto.decryptCredentials(connection.encrypted_credentials) as ExchangeCredentials
      } catch (error) {
        // Undecryptable ciphertext (APP_SECRET/salt rotated) is unrecoverable: a
        // reconnect would retry the same dead blob forever. Register the session
        // as errored instead — without this the exchange is simply absent from
        // /sessions and the operator has no idea the venue never came back.
        this.registerRestoreFailure(
          connection,
          label,
          "Stored credentials could not be decrypted — re-enter this exchange's API key",
        )
        continue
      }

      try {
        await this.connectExchange(connection.user_id, connection.exchange_name, credentials, label)
      } catch (error) {
        // connectExchange already recorded the session status; surface the reason.
        const message = error instanceof Error ? error.message : String(error)
        console.error(`Failed to restore session ${connection.id}:`, error)
        this.db.log('error', 'exchange', `Failed to restore ${connection.exchange_name} session`, {
          userId: connection.user_id,
          exchangeName: connection.exchange_name,
          label: label ?? DEFAULT_CONNECTION_LABEL,
          error: message,
        })
      }
    }
  }

  // A session that could not even be attempted (credentials unreadable). Kept out
  // of the reconnect path on purpose — only the user re-entering the key fixes it.
  private registerRestoreFailure(
    connection: { id: string; user_id: string; exchange_name: string },
    label: string | undefined,
    message: string,
  ): void {
    const adapter = this.createConnectionAdapter(connection.exchange_name, label)
    if (adapter) {
      this.sessions.set(connection.id, {
        userId: connection.user_id,
        exchangeName: connection.exchange_name,
        adapter,
        status: 'error',
        error: message,
        label: label ?? DEFAULT_CONNECTION_LABEL,
        accountKey: label,
        connectionId: connection.id,
      })
    }
    console.error(`Failed to restore session ${connection.id}: ${message}`)
    this.db.log('error', 'exchange', `Failed to restore ${connection.exchange_name} session`, {
      userId: connection.user_id,
      exchangeName: connection.exchange_name,
      label: label ?? DEFAULT_CONNECTION_LABEL,
      error: message,
    })
  }

  async shutdown(): Promise<void> {
    for (const [sessionKey, session] of this.sessions.entries()) {
      try {
        await session.adapter.disconnect()
      } catch (error) {
        console.error(`Error disconnecting ${sessionKey}:`, error)
      }
    }

    for (const interval of this.pollingIntervals.values()) {
      clearInterval(interval)
    }

    for (const timeout of this.refreshTimeouts.values()) {
      clearTimeout(timeout)
    }

    for (const timeout of this.reconnectTimeouts.values()) {
      clearTimeout(timeout)
    }

    this.sessions.clear()
    this.pollingIntervals.clear()
    this.refreshTimeouts.clear()
    this.reconnectTimeouts.clear()
    this.reconnectAttempts.clear()
  }

}

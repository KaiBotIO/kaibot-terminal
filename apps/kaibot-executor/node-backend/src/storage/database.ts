import { accountKeyOf } from '../services/exchanges/account-scope.js'
import { Database } from 'bun:sqlite'
import { join, dirname } from 'path'
import { sqlAsset } from './sql-assets'
import type {
  SignalExecutionRow,
  SignalExecutionStatus,
  SignalFillRow,
  RecentFillRow,
  OrderSettlementRow,
  DcaRestingRungRow,
  BracketPairRow,
  BalanceSnapshotRow,
  LocalTrailStateRow,
  ServerExitStateRow,
  ManagedPositionRow,
  PositionManagerRow,
  PositionGroupRow,
  PositionGroupLinkRow,
  ManualPositionRow,
  HedgeGuardRow,
  ReconciliationRow,
  SyntheticUsdPositionRow,
  SyntheticUsdMutationRow,
  SyntheticUsdMutationKind,
  HoldingsBasisRow,
  MarginGuardRow,
  BotConfigRow,
  BotRunStateRow,
} from './types.js'
import type { SizeUnit } from '@kaibot/types/core'

// Settlement statuses that placed nothing effective at the broker, so the same
// target may be retried in place. Mirrors kaibot-exec RETRYABLE_ORDER_STATUSES.
export const RETRYABLE_SETTLEMENT_STATUSES: OrderSettlementRow['status'][] = [
  'rejected',
  'cancelled',
]

// Decode the bracket_pairs.tp_order_ids JSON column (multi-TP ladder).
export function parseTpOrderIds(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export interface DeferredEntryRow {
  signal_id: string
  signal_json: string
  canonical_symbol: string
  exchange: string
  order_symbol: string
  account_id: string | null
  signal_bot_id: string | null
  subscription_id: string | null
  position_id: string | null
  status: 'waiting' | 'executed' | 'rejected' | 'cancelled' | 'expired'
  reason: string | null
  deferred_at: number
  deadline_at: number
  last_check_at: number | null
  resolved_at: number | null
}

export class KaiBotDatabase {
  // @ts-ignore - Bun SQLite type compatibility
  Database?: typeof Database
  private db: Database
  private dbPath: string

  constructor(dbPath?: string) {
    // Data dir resolution order: explicit dbPath (e.g. --profile) > KAIBOT_DATA_DIR
    // > cwd/data. Must stay in sync with crypto.ts dataDir() so the DB and the
    // crypto salt/secret always live together — otherwise an isolated instance
    // splits them across dirs and cannot decrypt its own keys.
    const baseDir = process.env.KAIBOT_DATA_DIR || join(process.cwd(), 'data')
    this.dbPath = dbPath || join(baseDir, 'kaibot.db')

    const dataDir = dirname(this.dbPath)
    if (!require('fs').existsSync(dataDir)) {
      require('fs').mkdirSync(dataDir, { recursive: true })
    }

    this.db = new Database(this.dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    
    this.migrate()
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    const migrations = this.db.query('SELECT name FROM migrations').all()
    const appliedMigrations = new Set(migrations.map((m: any) => m.name))

    if (!appliedMigrations.has('initial_schema')) {
      console.log('Running initial schema migration...')
      const schema = sqlAsset('schema.sql')
      this.db.exec(schema)
      this.db.run('INSERT INTO migrations (name) VALUES (?)', ['initial_schema'])
      console.log('Initial schema migration completed')
    }

    if (!appliedMigrations.has('exchange_tables')) {
      console.log('Running exchange tables migration...')
      const exchangeSchema = sqlAsset('migrations/002_exchanges.sql')
      this.db.exec(exchangeSchema)
      this.db.run('INSERT INTO migrations (name) VALUES (?)', ['exchange_tables'])
      console.log('Exchange tables migration completed')
    }

    if (!appliedMigrations.has('executor_subscriptions')) {
      console.log('Running executor subscriptions migration...')
      const subSchema = sqlAsset('migrations/003_subscriptions.sql')
      this.db.exec(subSchema)
      this.db.run('INSERT INTO migrations (name) VALUES (?)', ['executor_subscriptions'])
      console.log('Executor subscriptions migration completed')
    }

    if (!appliedMigrations.has('signal_stops')) {
      console.log('Running signal stops migration...')
      const stopsSchema = sqlAsset('migrations/004_signal_stops.sql')
      // ALTER TABLE ADD COLUMN is not idempotent in sqlite, and schema.sql already
      // contains the new columns for fresh installs — swallow duplicate-column errors.
      const statements = stopsSchema.split(';').map(s => s.trim()).filter(Boolean)
      for (const stmt of statements) {
        try {
          this.db.run(stmt)
        } catch (err: any) {
          if (!/duplicate column name/i.test(err?.message ?? '')) throw err
        }
      }
      this.db.run('INSERT INTO migrations (name) VALUES (?)', ['signal_stops'])
      console.log('Signal stops migration completed')
    }

    if (!appliedMigrations.has('auth_sessions')) {
      console.log('Running auth sessions migration...')
      const authSchema = sqlAsset('migrations/005_auth_sessions.sql')
      this.db.exec(authSchema)
      this.db.run('INSERT INTO migrations (name) VALUES (?)', ['auth_sessions'])
      console.log('Auth sessions migration completed')
    }

    if (!appliedMigrations.has('drop_dead_position_tables')) {
      console.log('Running drop dead position tables migration...')
      const dropSchema = sqlAsset('migrations/006_drop_dead_position_tables.sql')
      // FK to the dropped `trades` table is enforced during the DROP, so run the
      // statements with foreign_keys temporarily off (trade_id is always NULL).
      this.db.exec('PRAGMA foreign_keys = OFF')
      this.db.exec(dropSchema)
      this.db.exec('PRAGMA foreign_keys = ON')
      this.db.run('INSERT INTO migrations (name) VALUES (?)', ['drop_dead_position_tables'])
      console.log('Drop dead position tables migration completed')
    }

    if (!appliedMigrations.has('execution_state')) {
      console.log('Running execution state migration...')
      const execSchema = sqlAsset('migrations/007_execution_state.sql')
      this.db.exec(execSchema)
      this.db.run('INSERT INTO migrations (name) VALUES (?)', ['execution_state'])
      console.log('Execution state migration completed')
    }

    if (!appliedMigrations.has('reconciliation')) {
      console.log('Running reconciliation migration...')
      const reconSchema = sqlAsset('migrations/008_reconciliation.sql')
      this.db.exec(reconSchema)
      this.db.run('INSERT INTO migrations (name) VALUES (?)', ['reconciliation'])
      console.log('Reconciliation migration completed')
    }

    if (!appliedMigrations.has('account_sizes')) {
      console.log('Running account sizes migration...')
      const sizesSchema = sqlAsset('migrations/009_account_sizes.sql')
      this.db.exec(sizesSchema)
      this.db.run('INSERT INTO migrations (name) VALUES (?)', ['account_sizes'])
      console.log('Account sizes migration completed')
    }

    if (!appliedMigrations.has('synthetic_usd')) {
      console.log('Running synthetic usd migration...')
      const synthSchema = sqlAsset('migrations/010_synthetic_usd.sql')
      this.db.exec(synthSchema)
      this.db.run('INSERT INTO migrations (name) VALUES (?)', ['synthetic_usd'])
      console.log('Synthetic usd migration completed')
    }

    if (!appliedMigrations.has('order_settlement_dedup')) {
      console.log('Running order settlement dedup migration...')
      const dedupSchema = sqlAsset('migrations/011_order_settlement_dedup.sql')
      // ALTER TABLE ADD COLUMN is not idempotent in sqlite — swallow the
      // duplicate-column error so a re-run (or a fresh install that already has
      // the column) stays clean. The index uses IF NOT EXISTS.
      const statements = dedupSchema.split(';').map(s => s.trim()).filter(Boolean)
      for (const stmt of statements) {
        try {
          this.db.run(stmt)
        } catch (err: any) {
          if (!/duplicate column name/i.test(err?.message ?? '')) throw err
        }
      }
      this.db.run('INSERT INTO migrations (name) VALUES (?)', ['order_settlement_dedup'])
      console.log('Order settlement dedup migration completed')
    }

    if (!appliedMigrations.has('tp_ladder')) {
      console.log('Running tp ladder migration...')
      const tpSchema = sqlAsset('migrations/012_tp_ladder.sql')
      // exec() runs the whole script (handles the leading comment block); the
      // single ALTER ADD COLUMN is not idempotent, so swallow a re-run's
      // duplicate-column error.
      try {
        this.db.exec(tpSchema)
      } catch (err: any) {
        if (!/duplicate column name/i.test(err?.message ?? '')) throw err
      }
      this.db.run('INSERT INTO migrations (name) VALUES (?)', ['tp_ladder'])
      console.log('Tp ladder migration completed')
    }

    if (!appliedMigrations.has('local_trail_state')) {
      console.log('Running local trail state migration...')
      const trailSchema = sqlAsset('migrations/013_local_trail_state.sql')
      this.db.exec(trailSchema)
      this.db.run('INSERT INTO migrations (name) VALUES (?)', ['local_trail_state'])
      console.log('Local trail state migration completed')
    }

    if (!appliedMigrations.has('portfolio_sync')) {
      console.log('Running portfolio sync migration...')
      const syncSchema = sqlAsset('migrations/014_portfolio_sync.sql')
      // Run each ALTER independently (with its own duplicate-column swallow) so a
      // partially-applied migration still completes. Strip comment lines FIRST
      // (a ';' inside a comment would otherwise corrupt the split), then split.
      const statements = syncSchema
        .split('\n')
        .filter(l => !l.trim().startsWith('--'))
        .join('\n')
        .split(';')
        .map(s => s.trim())
        .filter(Boolean)
      for (const stmt of statements) {
        try {
          this.db.exec(stmt)
        } catch (err: any) {
          if (!/duplicate column name/i.test(err?.message ?? '')) throw err
        }
      }
      this.db.run('INSERT INTO migrations (name) VALUES (?)', ['portfolio_sync'])
      console.log('Portfolio sync migration completed')
    }

    if (!appliedMigrations.has('margin_guards')) {
      const marginSchema = sqlAsset('migrations/015_margin_guards.sql')
      this.db.exec(marginSchema)
      this.db.run('INSERT INTO migrations (name) VALUES (?)', ['margin_guards'])
    }

    if (!appliedMigrations.has('guardrails')) {
      const guardrailsSchema = sqlAsset('migrations/016_guardrails.sql')
      // The three ALTER ADD COLUMN statements are not idempotent in sqlite; the
      // executor_halt CREATE/INSERT use IF NOT EXISTS / OR IGNORE. Strip comment
      // lines first (a ';' inside a comment would corrupt the split), then run
      // each statement, swallowing only duplicate-column errors so a re-run / a
      // fresh install that already has the columns stays clean.
      const statements = guardrailsSchema
        .split('\n')
        .filter((l) => !l.trim().startsWith('--'))
        .join('\n')
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
      for (const stmt of statements) {
        try {
          this.db.exec(stmt)
        } catch (err: any) {
          if (!/duplicate column name/i.test(err?.message ?? '')) throw err
        }
      }
      this.db.run('INSERT INTO migrations (name) VALUES (?)', ['guardrails'])
    }

    if (!appliedMigrations.has('bot_configs')) {
      console.log('Running bot configs migration...')
      const botSchema = sqlAsset('migrations/017_bot_configs.sql')
      this.db.exec(botSchema)
      this.db.run('INSERT INTO migrations (name) VALUES (?)', ['bot_configs'])
      console.log('Bot configs migration completed')
    }

    if (!appliedMigrations.has('bot_config_execution_target')) {
      const execTargetSchema = sqlAsset('migrations/018_bot_config_execution_target.sql')
      // ALTER ADD COLUMN is not idempotent in sqlite; strip comment lines (a ';'
      // inside one would corrupt the split) then run each statement, swallowing
      // only duplicate-column errors so a re-run / a fresh install that already
      // carries the columns stays clean.
      const statements = execTargetSchema
        .split('\n')
        .filter((l) => !l.trim().startsWith('--'))
        .join('\n')
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
      for (const stmt of statements) {
        try {
          this.db.exec(stmt)
        } catch (err: any) {
          if (!/duplicate column name/i.test(err?.message ?? '')) throw err
        }
      }
      this.db.run('INSERT INTO migrations (name) VALUES (?)', ['bot_config_execution_target'])
    }

    if (!appliedMigrations.has('synthetic_usd_leverage_cap')) {
      const capSchema = sqlAsset('migrations/019_synthetic_usd_leverage_cap.sql')
      // Single ALTER ADD COLUMN — not idempotent in sqlite; strip comment lines
      // then swallow a duplicate-column error so a re-run / fresh install that
      // already carries the column stays clean.
      const statements = capSchema
        .split('\n')
        .filter((l) => !l.trim().startsWith('--'))
        .join('\n')
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
      for (const stmt of statements) {
        try {
          this.db.exec(stmt)
        } catch (err: any) {
          if (!/duplicate column name/i.test(err?.message ?? '')) throw err
        }
      }
      this.db.run('INSERT INTO migrations (name) VALUES (?)', ['synthetic_usd_leverage_cap'])
    }

    if (!appliedMigrations.has('companion')) {
      console.log('Running companion migration...')
      const companionSchema = sqlAsset('migrations/020_companion.sql')
      // CREATE/INSERT use IF NOT EXISTS / OR IGNORE — safe to re-run.
      this.db.exec(companionSchema)
      this.db.run('INSERT INTO migrations (name) VALUES (?)', ['companion'])
      console.log('Companion migration completed')
    }

    if (!appliedMigrations.has('companion_e2e')) {
      console.log('Running companion_e2e migration...')
      const schema = sqlAsset('migrations/021_companion_e2e.sql')
      // ALTER TABLE ADD COLUMN throws on re-run; tolerate duplicate-column like
      // the synthetic_usd_leverage_cap block above.
      const statements = schema.split(';').map((s) => s.trim()).filter((s) => s.length > 0)
      for (const stmt of statements) {
        try {
          this.db.exec(stmt)
        } catch (err: any) {
          if (!/duplicate column name/i.test(err?.message ?? '')) throw err
        }
      }
      this.db.run('INSERT INTO migrations (name) VALUES (?)', ['companion_e2e'])
      console.log('Companion_e2e migration completed')
    }

    if (!appliedMigrations.has('manual_positions')) {
      const schema = sqlAsset('migrations/022_manual_positions.sql')
      // CREATE TABLE/INDEX IF NOT EXISTS — safe to re-run.
      this.db.exec(schema)
      this.db.run('INSERT INTO migrations (name) VALUES (?)', ['manual_positions'])
    }

    // basis_guard (023): per-subscription threshold override. Guarded on the
    // actual column, NOT just the migration record — an earlier release shipped
    // this ALTER against a non-existent table name (`subscriptions` vs the real
    // `executor_subscriptions`) and threw on fresh installs before the record
    // was written, so gating on the record alone could leave the column missing.
    // The PRAGMA check makes adding it idempotent + self-healing.
    const hasBasisGuard = (
      this.db.query('PRAGMA table_info(executor_subscriptions)').all() as Array<{ name: string }>
    ).some((c) => c.name === 'basis_guard_bps')
    if (!hasBasisGuard) {
      this.db.run('ALTER TABLE executor_subscriptions ADD COLUMN basis_guard_bps REAL')
    }
    if (!appliedMigrations.has('basis_guard')) {
      this.db.run('INSERT INTO migrations (name) VALUES (?)', ['basis_guard'])
    }

    if (!appliedMigrations.has('synthetic_usd_auto_rebalance')) {
      const schema = sqlAsset('migrations/024_synthetic_usd_auto_rebalance.sql')
      const statements = schema.split(';').map((s) => s.trim()).filter((s) => s.length > 0)
      for (const stmt of statements) {
        try {
          this.db.exec(stmt)
        } catch (err: any) {
          if (!/duplicate column name/i.test(err?.message ?? '')) throw err
        }
      }
      this.db.run('INSERT INTO migrations (name) VALUES (?)', ['synthetic_usd_auto_rebalance'])
    }

    if (!appliedMigrations.has('subscription_size_unit')) {
      const schema = sqlAsset('migrations/025_subscription_size_unit.sql')
      const statements = schema.split(';').map((s) => s.trim()).filter((s) => s.length > 0)
      for (const stmt of statements) {
        try {
          this.db.exec(stmt)
        } catch (err: any) {
          if (!/duplicate column name/i.test(err?.message ?? '')) throw err
        }
      }
      this.db.run('INSERT INTO migrations (name) VALUES (?)', ['subscription_size_unit'])
    }

    if (!appliedMigrations.has('dca_resting_rungs')) {
      const schema = sqlAsset('migrations/026_dca_resting_rungs.sql')
      const statements = schema.split(';').map((s) => s.trim()).filter((s) => s.length > 0)
      for (const stmt of statements) {
        try {
          this.db.exec(stmt)
        } catch (err: any) {
          if (!/duplicate column name/i.test(err?.message ?? '')) throw err
        }
      }
      this.db.run('INSERT INTO migrations (name) VALUES (?)', ['dca_resting_rungs'])
    }

    if (!appliedMigrations.has('partial_fill_tracking')) {
      const schema = sqlAsset('migrations/027_partial_fill_tracking.sql')
      const statements = schema.split(';').map((s) => s.trim()).filter((s) => s.length > 0)
      for (const stmt of statements) {
        try {
          this.db.exec(stmt)
        } catch (err: any) {
          if (!/duplicate column name/i.test(err?.message ?? '')) throw err
        }
      }
      this.db.run('INSERT INTO migrations (name) VALUES (?)', ['partial_fill_tracking'])
    }

    if (!appliedMigrations.has('position_trail')) {
      const schema = sqlAsset('migrations/028_position_trail.sql')
      // ALTER ADD COLUMN is not idempotent in sqlite; strip comment lines (a ';'
      // inside one would corrupt the split), run each statement, swallow only
      // duplicate-column errors so a re-run stays clean.
      const statements = schema
        .split('\n')
        .filter((l) => !l.trim().startsWith('--'))
        .join('\n')
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
      for (const stmt of statements) {
        try {
          this.db.exec(stmt)
        } catch (err: any) {
          if (!/duplicate column name/i.test(err?.message ?? '')) throw err
        }
      }
      this.db.run('INSERT INTO migrations (name) VALUES (?)', ['position_trail'])
    }

    if (!appliedMigrations.has('position_managers')) {
      const schema = sqlAsset('migrations/029_position_managers.sql')
      this.db.exec(schema)
      this.db.run('INSERT INTO migrations (name) VALUES (?)', ['position_managers'])
    }

    if (!appliedMigrations.has('position_groups')) {
      const schema = sqlAsset('migrations/030_position_groups.sql')
      this.db.exec(schema)
      this.db.run('INSERT INTO migrations (name) VALUES (?)', ['position_groups'])
    }

    if (!appliedMigrations.has('server_exit_state')) {
      const schema = sqlAsset('migrations/031_server_exit_state.sql')
      this.db.exec(schema)
      this.db.run('INSERT INTO migrations (name) VALUES (?)', ['server_exit_state'])
    }

    if (!appliedMigrations.has('execution_account')) {
      const schema = sqlAsset('migrations/032_execution_account.sql')
      // ALTER ADD COLUMN is not idempotent in sqlite; strip comments, tolerate
      // duplicate-column like the earlier ALTER migrations.
      const statements = schema
        .split('\n')
        .filter((l) => !l.trim().startsWith('--'))
        .join('\n')
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
      for (const stmt of statements) {
        try {
          this.db.exec(stmt)
        } catch (err: any) {
          if (!/duplicate column name/i.test(err?.message ?? '')) throw err
        }
      }
      this.db.run('INSERT INTO migrations (name) VALUES (?)', ['execution_account'])
    }

    if (!appliedMigrations.has('hedge_guards')) {
      const schema = sqlAsset('migrations/033_hedge_guards.sql')
      this.db.exec(schema)
      this.db.run('INSERT INTO migrations (name) VALUES (?)', ['hedge_guards'])
    }

    if (!appliedMigrations.has('synthetic_usd_armed')) {
      this.execTolerantAlter(sqlAsset('migrations/034_synthetic_usd_armed.sql'))
      this.db.run('INSERT INTO migrations (name) VALUES (?)', ['synthetic_usd_armed'])
    }

    if (!appliedMigrations.has('exchange_connection_label')) {
      this.execTolerantAlter(sqlAsset('migrations/035_exchange_connection_label.sql'))
      this.db.run('INSERT INTO migrations (name) VALUES (?)', ['exchange_connection_label'])
    }

    if (!appliedMigrations.has('signal_ack')) {
      this.execTolerantAlter(sqlAsset('migrations/036_signal_ack.sql'))
      this.db.run('INSERT INTO migrations (name) VALUES (?)', ['signal_ack'])
    }

    if (!appliedMigrations.has('deferred_entries')) {
      this.db.exec(sqlAsset('migrations/037_deferred_entries.sql'))
      this.db.run('INSERT INTO migrations (name) VALUES (?)', ['deferred_entries'])
    }

    if (!appliedMigrations.has('stop_floor')) {
      this.execTolerantAlter(sqlAsset('migrations/038_stop_floor.sql'))
      this.db.run('INSERT INTO migrations (name) VALUES (?)', ['stop_floor'])
    }
  }

  // ALTER ADD COLUMN is not idempotent in sqlite: strip comments, run each
  // statement on its own and tolerate duplicate-column.
  private execTolerantAlter(schema: string) {
    const statements = schema
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
    for (const stmt of statements) {
      try {
        this.db.exec(stmt)
      } catch (err: any) {
        if (!/duplicate column name/i.test(err?.message ?? '')) throw err
      }
    }
  }

  async createAdminUser(username: string, password: string) {
    const bcrypt = await import('bcryptjs')
    const hashedPassword = await bcrypt.hash(password, 10)
    return this.db.run(
      'INSERT INTO users (username, password_hash) VALUES (?, ?)',
      [username, hashedPassword]
    )
  }

  async validateUser(username: string, password: string): Promise<boolean> {
    const user = this.db.query('SELECT password_hash FROM users WHERE username = ?').get(username) as any
    if (!user) return false

    const bcrypt = await import('bcryptjs')
    const isValid = await bcrypt.compare(password, user.password_hash)
    if (isValid) {
      this.db.run('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE username = ?', [username])
    }
    return isValid
  }

  async hasAdminUser(): Promise<boolean> {
    const count = this.db.query('SELECT COUNT(*) as count FROM users').get() as any
    return count.count > 0
  }

  getAdminUser() {
    return this.db.query('SELECT * FROM users LIMIT 1').get() as any
  }

  // Lockout escape hatch (`kaibot-executor reset-admin`): drop the admin user
  // and every session so /api/auth/setup accepts a fresh account. Local-only —
  // reachable exclusively via CLI/filesystem access, never over HTTP.
  resetAdminUser() {
    this.db.run('DELETE FROM auth_sessions')
    return this.db.run('DELETE FROM users')
  }

  updateUserSettings(userId: number, settings: string) {
    return this.db.run('UPDATE users SET settings = ? WHERE id = ?', [settings, userId])
  }

  // ────────────────────────────────────────────────────────────────
  // Auth sessions (hashed token + expiry)
  // ────────────────────────────────────────────────────────────────

  createAuthSession(tokenHash: string, userId: number, expiresAt: Date) {
    return this.db.run(
      'INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
      [tokenHash, userId, expiresAt.toISOString()],
    )
  }

  // Returns the session row when the token hash is known and not expired.
  getValidAuthSession(tokenHash: string): { id: number; user_id: number; expires_at: string } | undefined {
    return this.db.query(
      `SELECT id, user_id, expires_at FROM auth_sessions
       WHERE token_hash = ? AND expires_at > CURRENT_TIMESTAMP
       LIMIT 1`,
    ).get(tokenHash) as any
  }

  deleteAuthSession(tokenHash: string) {
    return this.db.run('DELETE FROM auth_sessions WHERE token_hash = ?', [tokenHash])
  }

  purgeExpiredAuthSessions() {
    return this.db.run('DELETE FROM auth_sessions WHERE expires_at <= CURRENT_TIMESTAMP')
  }

  storeApiKey(name: string, encryptedKey: string, permissions?: string[]) {
    return this.db.run(
      'INSERT INTO api_keys (name, key_encrypted, permissions) VALUES (?, ?, ?)',
      [name, encryptedKey, JSON.stringify(permissions || [])]
    )
  }

  getActiveApiKeys() {
    return this.db.query('SELECT * FROM api_keys WHERE is_active = 1').all()
  }

  addExchange(name: string, type: string, encryptedCredentials: string, isPaper: boolean = false) {
    return this.db.run(
      'INSERT INTO exchanges (name, type, credentials_encrypted, is_paper) VALUES (?, ?, ?, ?)',
      [name, type, encryptedCredentials, isPaper ? 1 : 0]
    )
  }

  getExchanges() {
    return this.db.query('SELECT * FROM exchanges WHERE is_active = 1').all()
  }

  updateExchangeConnection(id: number) {
    return this.db.run(
      'UPDATE exchanges SET last_connected = CURRENT_TIMESTAMP WHERE id = ?',
      [id]
    )
  }

  recordSignal(signal: {
    id: string
    strategyId: string
    strategyName?: string
    symbol: string
    action: string
    quantity?: number
    price?: number
    type?: string
    confidence?: number
    stopLoss?: number
    takeProfit?: number
    metadata?: any
  }) {
    return this.db.run(
      `INSERT INTO signals (id, strategy_id, strategy_name, symbol, action, quantity, price, type, confidence, stop_loss, take_profit, metadata, received_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 'pending')`,
      [
        signal.id,
        signal.strategyId,
        signal.strategyName ?? null,
        signal.symbol,
        signal.action,
        signal.quantity ?? null,
        signal.price ?? null,
        signal.type ?? null,
        signal.confidence ?? null,
        signal.stopLoss ?? null,
        signal.takeProfit ?? null,
        JSON.stringify(signal.metadata)
      ]
    )
  }

  updateSignalStatus(signalId: string, status: string, tradeId?: number, errorMessage?: string) {
    return this.db.run(
      'UPDATE signals SET status = ?, processed_at = CURRENT_TIMESTAMP, trade_id = ?, error_message = ? WHERE id = ?',
      [status, tradeId ?? null, errorMessage ?? null, signalId]
    )
  }

  updateSignalOrderIds(signalId: string, stopLossOrderId?: string, takeProfitOrderId?: string) {
    return this.db.run(
      'UPDATE signals SET stop_loss_order_id = ?, take_profit_order_id = ? WHERE id = ?',
      [stopLossOrderId ?? null, takeProfitOrderId ?? null, signalId]
    )
  }

  getBracketByOrderId(orderId: string): { id: string; stop_loss_order_id?: string; take_profit_order_id?: string } | undefined {
    return this.db.query(
      `SELECT id, stop_loss_order_id, take_profit_order_id
       FROM signals
       WHERE stop_loss_order_id = ? OR take_profit_order_id = ?
       LIMIT 1`
    ).get(orderId, orderId) as any
  }

  // The entry signal's resting stop order + symbol/side, keyed by signal id.
  // Used by the server-pushed stop-update handler to amend the right stop.
  getSignalBracket(signalId: string): { symbol: string; action: string; stop_loss_order_id: string | null; take_profit_order_id: string | null } | undefined {
    return this.db.query(
      `SELECT symbol, action, stop_loss_order_id, take_profit_order_id FROM signals WHERE id = ? LIMIT 1`
    ).get(signalId) as any
  }

  // Open entry signals (buy/sell) that were executed for a symbol and have not
  // been closed yet. Used to resolve which positions a `close` signal targets
  // and to cancel their outstanding bracket legs. Newest first so a partial
  // close peels off the most recent entry. Filter by subscription via the
  // metadata LIKE match (subscriptionId / signalBotId are stored in metadata).
  getOpenEntrySignals(
    symbol: string,
    subscriptionFilter?: string,
  ): Array<{
    id: string
    symbol: string
    action: 'buy' | 'sell'
    quantity: number | null
    stop_loss: number | null
    stop_loss_order_id: string | null
    take_profit_order_id: string | null
    metadata: string | null
  }> {
    const params: any[] = [symbol]
    let sql =
      `SELECT id, symbol, action, quantity, stop_loss, stop_loss_order_id, take_profit_order_id, metadata
       FROM signals
       WHERE symbol = ?
         AND action IN ('buy', 'sell')
         AND status = 'executed'`
    if (subscriptionFilter) {
      sql += ` AND metadata LIKE '%' || ? || '%'`
      params.push(subscriptionFilter)
    }
    sql += ` ORDER BY received_at DESC`
    return this.db.query(sql).all(...params) as any
  }

  // Mark an entry signal as closed and clear its bracket order ids so it no
  // longer counts as open. Stored in status='closed'.
  markEntrySignalClosed(signalId: string, reason?: string) {
    return this.db.run(
      `UPDATE signals
       SET status = 'closed', processed_at = CURRENT_TIMESTAMP, error_message = ?,
           stop_loss_order_id = NULL, take_profit_order_id = NULL
       WHERE id = ?`,
      [reason ?? null, signalId],
    )
  }

  // Local terminal-status lookup for the replay guard: a replayed signal this
  // executor already finished must not be re-processed or re-acked.
  getSignalStatus(signalId: string): string | undefined {
    const row = this.db.query('SELECT status FROM signals WHERE id = ?').get(signalId) as
      | { status: string }
      | null
    return row?.status ?? undefined
  }

  // Signals plus the account the execution landed on and how many guardrail
  // clips it took: the feed states the reason on the row itself, and both of
  // those are part of the reason.
  getRecentSignals(limit: number = 50) {
    return this.db.query(
      `SELECT s.*,
              COALESCE(e.account_id, sub.account_id) AS account_id,
              COALESCE(e.exchange, sub.exchange)     AS exchange,
              (SELECT COUNT(*) FROM executor_safety_clips c WHERE c.signal_id = s.id) AS clip_count
         FROM signals s
         LEFT JOIN signal_executions e ON e.signal_id = s.id
         -- A rejected signal never gets an execution, so its account comes from
         -- the subscription that would have placed it.
         LEFT JOIN executor_subscriptions sub
                ON sub.signal_bot_id = COALESCE(
                     json_extract(s.metadata, '$.signalBotId'),
                     json_extract(s.metadata, '$.signal_bot_id'))
        ORDER BY s.received_at DESC
        LIMIT ?`,
    ).all(limit)
  }

  getEquityHistory(days: number = 30) {
    return this.db.query(
      `SELECT
         date,
         SUM(total_pnl) as daily_pnl,
         SUM(total_trades) as trades,
         SUM(winning_trades) as wins,
         SUM(losing_trades) as losses
       FROM performance_metrics
       WHERE date >= date('now', ?)
       GROUP BY date
       ORDER BY date ASC`
    ).all(`-${days} days`) as Array<{
      date: string
      daily_pnl: number
      trades: number
      wins: number
      losses: number
    }>
  }

  log(level: 'debug' | 'info' | 'warn' | 'error', category: string, message: string, metadata?: any) {
    return this.db.run(
      'INSERT INTO logs (level, category, message, metadata) VALUES (?, ?, ?, ?)',
      [level, category, message, metadata ? JSON.stringify(metadata) : null]
    )
  }

  getRecentLogs(limit: number = 100, level?: string) {
    if (level) {
      return this.db.query(
        'SELECT * FROM logs WHERE level = ? ORDER BY created_at DESC LIMIT ?'
      ).all(level, limit)
    }
    return this.db.query(
      'SELECT * FROM logs ORDER BY created_at DESC LIMIT ?'
    ).all(limit)
  }

  // ────────────────────────────────────────────────────────────────
  // Executor subscriptions (mirror of server state)
  // ────────────────────────────────────────────────────────────────

  upsertSubscription(sub: {
    id: string
    signalBotId: string
    botName?: string
    selectedMarkets?: string[]
    factor: number
    maxPositionSize?: number
    maxConcurrentTrades?: number
    exchange?: string
    accountId?: string
    // Connection label the sub routes through (multi-connection venues);
    // null/absent = the default connection.
    accountKey?: string | null
    status?: 'active' | 'paused' | 'cancelled'
    sizeUnit?: SizeUnit
  }) {
    return this.db.run(
      `INSERT INTO executor_subscriptions
        (id, signal_bot_id, bot_name, selected_markets, factor, max_position_size, max_concurrent_trades, exchange, account_id, account_key, status, size_unit, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET
         signal_bot_id = excluded.signal_bot_id,
         bot_name = excluded.bot_name,
         selected_markets = excluded.selected_markets,
         factor = excluded.factor,
         max_position_size = excluded.max_position_size,
         max_concurrent_trades = excluded.max_concurrent_trades,
         exchange = excluded.exchange,
         account_id = excluded.account_id,
         account_key = excluded.account_key,
         status = excluded.status,
         size_unit = excluded.size_unit,
         updated_at = CURRENT_TIMESTAMP`,
      [
        sub.id,
        sub.signalBotId,
        sub.botName ?? null,
        sub.selectedMarkets ? JSON.stringify(sub.selectedMarkets) : null,
        sub.factor,
        sub.maxPositionSize ?? null,
        sub.maxConcurrentTrades ?? null,
        sub.exchange ?? null,
        sub.accountId ?? null,
        sub.accountKey ?? null,
        sub.status ?? 'active',
        sub.sizeUnit ?? null,
      ],
    )
  }

  getSubscriptions(includeCancelled: boolean = false) {
    if (includeCancelled) {
      return this.db.query('SELECT * FROM executor_subscriptions ORDER BY updated_at DESC').all()
    }
    return this.db.query(
      "SELECT * FROM executor_subscriptions WHERE status != 'cancelled' ORDER BY updated_at DESC",
    ).all()
  }

  getSubscription(id: string) {
    return this.db.query('SELECT * FROM executor_subscriptions WHERE id = ?').get(id) as any
  }

  getSubscriptionForBot(signalBotId: string) {
    return this.db.query(
      "SELECT * FROM executor_subscriptions WHERE signal_bot_id = ? AND status = 'active' LIMIT 1",
    ).get(signalBotId) as any
  }

  // Every active subscription of a bot, in creation order: one bot can be
  // routed to several connections (an [ALLOC] sub per account), and the caller
  // picks by connection (account_key / account_id).
  listActiveSubscriptionsForBot(signalBotId: string): Array<{
    id: string
    signal_bot_id: string
    bot_name: string | null
    exchange: string | null
    account_id: string | null
    account_key: string | null
    status: string
  }> {
    return this.db
      .query(
        "SELECT * FROM executor_subscriptions WHERE signal_bot_id = ? AND status = 'active' ORDER BY rowid ASC",
      )
      .all(signalBotId) as any
  }

  setSubscriptionStatus(id: string, status: 'active' | 'paused' | 'cancelled') {
    return this.db.run(
      'UPDATE executor_subscriptions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [status, id],
    )
  }

  deleteSubscription(id: string) {
    return this.db.run('DELETE FROM executor_subscriptions WHERE id = ?', [id])
  }

  // ────────────────────────────────────────────────────────────────
  // Bot config projection (identity + routing) + per-bot run state.
  // NOT the brain: holds NO strategy/indicator code — the server decides and
  // emits signals; these rows only drive the executor's bot control plane and
  // take-over/detach. strategyType/strategyConfig/indicatorSources are vestigial
  // columns kept for the schema, never populated from the server.
  // ────────────────────────────────────────────────────────────────

  upsertBotConfig(cfg: {
    id: string
    signalBotId: string
    botName?: string
    strategyId: string
    strategyName?: string
    status?: 'running' | 'paused' | 'stopped' | 'phasing_out'
    exchange: string
    symbol: string
    timeframe: string
    // INV7 — per-bot execution target. 'webhook' means the SERVER renders+POSTs
    // the alert to alertWebhookUrl; 'kaibot' means the server emits a WS signal.
    // The executor never fires the webhook; this is the routing projection only.
    executionTarget?: 'kaibot' | 'webhook'
    alertWebhookUrl?: string | null
    alertPayloadTemplate?: string | null
  }) {
    return this.db.run(
      `INSERT INTO bot_configs
        (id, signal_bot_id, bot_name, strategy_id, strategy_name, strategy_type,
         strategy_config, indicator_sources, exchange, symbol, timeframe, status,
         execution_target, alert_webhook_url, alert_payload_template, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET
         signal_bot_id = excluded.signal_bot_id,
         bot_name = excluded.bot_name,
         strategy_id = excluded.strategy_id,
         strategy_name = excluded.strategy_name,
         strategy_type = excluded.strategy_type,
         strategy_config = excluded.strategy_config,
         indicator_sources = excluded.indicator_sources,
         exchange = excluded.exchange,
         symbol = excluded.symbol,
         timeframe = excluded.timeframe,
         status = excluded.status,
         execution_target = excluded.execution_target,
         alert_webhook_url = excluded.alert_webhook_url,
         alert_payload_template = excluded.alert_payload_template,
         updated_at = CURRENT_TIMESTAMP`,
      [
        cfg.id,
        cfg.signalBotId,
        cfg.botName ?? null,
        cfg.strategyId,
        cfg.strategyName ?? null,
        // Vestigial code columns (strategy_type/strategy_config are NOT NULL) —
        // the executor holds no strategy/indicator code, so these stay empty.
        '',
        '',
        null,
        cfg.exchange,
        cfg.symbol,
        cfg.timeframe,
        cfg.status ?? 'running',
        cfg.executionTarget ?? 'kaibot',
        cfg.alertWebhookUrl ?? null,
        cfg.alertPayloadTemplate ?? null,
      ],
    )
  }

  getBotConfigs(onlyRunning = true): BotConfigRow[] {
    const rows = onlyRunning
      ? this.db.query("SELECT * FROM bot_configs WHERE status = 'running' ORDER BY updated_at DESC").all()
      : this.db.query('SELECT * FROM bot_configs ORDER BY updated_at DESC').all()
    return (rows as any[]).map((r) => this.parseBotConfigRow(r))
  }

  getBotConfig(id: string): BotConfigRow | null {
    const r = this.db.query('SELECT * FROM bot_configs WHERE id = ?').get(id) as any
    return r ? this.parseBotConfigRow(r) : null
  }

  // Point lookup by server signal-bot id. A bot can have one row per market, so
  // prefer the row matching the signal symbol, else the most recently updated.
  getBotConfigBySignalBotId(signalBotId: string, symbol?: string): BotConfigRow | undefined {
    if (symbol) {
      const bySymbol = this.db
        .query('SELECT * FROM bot_configs WHERE signal_bot_id = ? AND symbol = ? ORDER BY updated_at DESC')
        .get(signalBotId, symbol) as any
      if (bySymbol) return this.parseBotConfigRow(bySymbol)
    }
    const r = this.db
      .query('SELECT * FROM bot_configs WHERE signal_bot_id = ? ORDER BY updated_at DESC')
      .get(signalBotId) as any
    return r ? this.parseBotConfigRow(r) : undefined
  }

  setBotConfigStatus(id: string, status: 'running' | 'paused' | 'stopped' | 'phasing_out') {
    return this.db.run(
      'UPDATE bot_configs SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [status, id],
    )
  }

  deleteBotConfig(id: string) {
    this.db.run('DELETE FROM bot_run_state WHERE bot_config_id = ?', [id])
    return this.db.run('DELETE FROM bot_configs WHERE id = ?', [id])
  }

  private parseBotConfigRow(r: any): BotConfigRow {
    return {
      id: r.id,
      signalBotId: r.signal_bot_id,
      botName: r.bot_name ?? undefined,
      strategyId: r.strategy_id,
      strategyName: r.strategy_name ?? undefined,
      strategyType: r.strategy_type,
      strategyConfig: r.strategy_config ? JSON.parse(r.strategy_config) : {},
      indicatorSources: r.indicator_sources ? JSON.parse(r.indicator_sources) : undefined,
      exchange: r.exchange,
      symbol: r.symbol,
      timeframe: r.timeframe,
      status: r.status,
      executionTarget: r.execution_target === 'webhook' ? 'webhook' : 'kaibot',
      alertWebhookUrl: r.alert_webhook_url ?? null,
      alertPayloadTemplate: r.alert_payload_template ?? null,
    }
  }

  getBotRunState(botConfigId: string): BotRunStateRow | null {
    const r = this.db.query('SELECT * FROM bot_run_state WHERE bot_config_id = ?').get(botConfigId) as any
    if (!r) return null
    return {
      botConfigId: r.bot_config_id,
      state: r.state ? JSON.parse(r.state) : null,
      lastCandleAt: typeof r.last_candle_at === 'number' ? r.last_candle_at : null,
      lastSignalAt: typeof r.last_signal_at === 'number' ? r.last_signal_at : null,
    }
  }

  upsertBotRunState(s: {
    botConfigId: string
    state: unknown
    lastCandleAt: number | null
    lastSignalAt?: number | null
  }) {
    return this.db.run(
      `INSERT INTO bot_run_state (bot_config_id, state, last_candle_at, last_signal_at, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(bot_config_id) DO UPDATE SET
         state = excluded.state,
         last_candle_at = excluded.last_candle_at,
         last_signal_at = excluded.last_signal_at,
         updated_at = CURRENT_TIMESTAMP`,
      [
        s.botConfigId,
        s.state != null ? JSON.stringify(s.state) : null,
        s.lastCandleAt,
        s.lastSignalAt ?? null,
      ],
    )
  }

  // ────────────────────────────────────────────────────────────────
  // Offline signal queue + safety clip audit
  // ────────────────────────────────────────────────────────────────

  /** Outcome of the ack POST to the server; the drawer's third timestamp. */
  recordSignalAck(signalId: string, ok: boolean) {
    return this.db.run(
      "UPDATE signals SET acked_at = CURRENT_TIMESTAMP, ack_status = ? WHERE id = ?",
      [ok ? 'ok' : 'failed', signalId],
    )
  }

  listSafetyClips(signalId: string) {
    return this.db
      .query('SELECT * FROM executor_safety_clips WHERE signal_id = ? ORDER BY id ASC')
      .all(signalId) as Array<{
      id: number
      signal_id: string
      subscription_id: string | null
      reason: string
      original_quantity: number | null
      adjusted_quantity: number | null
      created_at: string
    }>
  }

  listSignalQueue(signalId: string) {
    return this.db
      .query('SELECT * FROM executor_signal_queue WHERE signal_id = ? ORDER BY id ASC')
      .all(signalId) as Array<{
      id: number
      signal_id: string
      action: string
      received_at: string
      processed_at: string | null
      reason: string | null
      metadata: string | null
    }>
  }

  recordSignalQueue(entry: {
    signalId: string
    action: string
    reason: string
    metadata?: any
  }) {
    return this.db.run(
      `INSERT INTO executor_signal_queue (signal_id, action, reason, metadata, processed_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [entry.signalId, entry.action, entry.reason, entry.metadata ? JSON.stringify(entry.metadata) : null],
    )
  }

  // ── Deferred entries (migration 037) ──────────────────────────────────────
  // A market entry that hit a closed venue waits here, wire signal included,
  // until the poller resumes it or the deadline passes.
  upsertDeferredEntry(row: {
    signalId: string
    signalJson: string
    canonicalSymbol: string
    exchange: string
    orderSymbol: string
    accountId?: string | null
    signalBotId?: string | null
    subscriptionId?: string | null
    positionId?: string | null
    reason: string
    deferredAt: number
    deadlineAt: number
  }) {
    return this.db.run(
      `INSERT INTO deferred_entries
         (signal_id, signal_json, canonical_symbol, exchange, order_symbol, account_id,
          signal_bot_id, subscription_id, position_id, status, reason, deferred_at, deadline_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?, ?)
       ON CONFLICT(signal_id) DO UPDATE SET
         last_check_at = excluded.deferred_at`,
      [
        row.signalId,
        row.signalJson,
        row.canonicalSymbol,
        row.exchange,
        row.orderSymbol,
        row.accountId ?? null,
        row.signalBotId ?? null,
        row.subscriptionId ?? null,
        row.positionId ?? null,
        row.reason,
        row.deferredAt,
        row.deadlineAt,
      ],
    )
  }

  getDeferredEntry(signalId: string): DeferredEntryRow | undefined {
    return this.db.query('SELECT * FROM deferred_entries WHERE signal_id = ?').get(signalId) as
      | DeferredEntryRow
      | undefined
  }

  listWaitingDeferredEntries(): DeferredEntryRow[] {
    return this.db
      .query("SELECT * FROM deferred_entries WHERE status = 'waiting' ORDER BY deferred_at ASC")
      .all() as DeferredEntryRow[]
  }

  touchDeferredEntry(signalId: string, checkedAt: number) {
    return this.db.run('UPDATE deferred_entries SET last_check_at = ? WHERE signal_id = ?', [
      checkedAt,
      signalId,
    ])
  }

  // Only a waiting row resolves; a second resolution is a no-op (idempotent).
  resolveDeferredEntry(
    signalId: string,
    status: 'executed' | 'rejected' | 'cancelled' | 'expired',
    reason: string | null,
    resolvedAt: number,
  ): boolean {
    const res = this.db.run(
      `UPDATE deferred_entries SET status = ?, reason = ?, resolved_at = ?
       WHERE signal_id = ? AND status = 'waiting'`,
      [status, reason, resolvedAt, signalId],
    )
    return (res as { changes?: number })?.changes === 1
  }

  logSafetyClip(entry: {
    signalId: string
    subscriptionId?: string
    reason: string
    originalQuantity?: number
    adjustedQuantity?: number
  }) {
    return this.db.run(
      `INSERT INTO executor_safety_clips (signal_id, subscription_id, reason, original_quantity, adjusted_quantity)
       VALUES (?, ?, ?, ?, ?)`,
      [
        entry.signalId,
        entry.subscriptionId ?? null,
        entry.reason,
        entry.originalQuantity ?? null,
        entry.adjustedQuantity ?? null,
      ],
    )
  }

  // A signal's metadata carries the SIGNAL BOT id, never the local subscription
  // id, so matching on the subscription id (`local-...`) matched nothing and
  // every sub read "0 signals". Resolve the bot id first, then match on it.
  // The subscription id stays in the OR for rows that do carry it.
  private signalOwnerIds(subscriptionId: string): string[] {
    const row = this.db
      .query('SELECT signal_bot_id FROM executor_subscriptions WHERE id = ?')
      .get(subscriptionId) as { signal_bot_id?: string } | undefined
    const ids = new Set<string>([subscriptionId])
    if (row?.signal_bot_id) ids.add(row.signal_bot_id)
    return Array.from(ids)
  }

  private static readonly SIGNAL_OWNER_MATCH =
    "COALESCE(json_extract(metadata, '$.signalBotId'), json_extract(metadata, '$.signal_bot_id')) IN (SELECT value FROM json_each(?))"

  getSignalCountForSubscription(subscriptionId: string, sinceHours: number = 24): number {
    const row = this.db.query(
      `SELECT COUNT(*) as count FROM signals
       WHERE ${KaiBotDatabase.SIGNAL_OWNER_MATCH}
         AND received_at >= datetime('now', '-' || ? || ' hours')`,
    ).get(JSON.stringify(this.signalOwnerIds(subscriptionId)), sinceHours) as any
    return row?.count ?? 0
  }

  getSignalsForSubscription(subscriptionId: string, limit: number = 50) {
    return this.db.query(
      `SELECT * FROM signals
       WHERE ${KaiBotDatabase.SIGNAL_OWNER_MATCH}
       ORDER BY received_at DESC
       LIMIT ?`,
    ).all(JSON.stringify(this.signalOwnerIds(subscriptionId)), limit)
  }

  // ────────────────────────────────────────────────────────────────
  // Per-signal execution state (idempotent open / failed-open guard)
  // ────────────────────────────────────────────────────────────────

  getSignalExecution(signalId: string): SignalExecutionRow | undefined {
    return this.db.query('SELECT * FROM signal_executions WHERE signal_id = ?').get(signalId) as
      | SignalExecutionRow
      | undefined
  }

  // Record a brand-new execution. Returns false on a primary-key collision (the
  // signal already has an execution row) so the caller can treat it as a no-op.
  insertSignalExecution(row: {
    signalId: string
    symbol: string
    exchange: string
    direction: 'long' | 'short'
    status: SignalExecutionStatus
    qtyOpened?: number
    qtyClosed?: number
    errorReason?: string | null
    accountId?: string | null
    // Historical repair rows carry their real open moment. Default: now.
    createdAtMs?: number
  }): boolean {
    const now = row.createdAtMs ?? Date.now()
    try {
      this.db.run(
        `INSERT INTO signal_executions
           (signal_id, symbol, exchange, direction, status, qty_opened, qty_closed, error_reason, account_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.signalId,
          row.symbol,
          row.exchange,
          row.direction,
          row.status,
          row.qtyOpened ?? 0,
          row.qtyClosed ?? 0,
          row.errorReason ?? null,
          row.accountId ?? null,
          now,
          now,
        ],
      )
      return true
    } catch (err: any) {
      if (/UNIQUE|PRIMARY KEY/i.test(err?.message ?? '')) return false
      throw err
    }
  }

  updateSignalExecution(
    signalId: string,
    patch: Partial<{
      status: SignalExecutionStatus
      qtyOpened: number
      qtyClosed: number
      qtyPendingClose: number | null
      errorReason: string | null
    }>,
  ) {
    const sets: string[] = ['updated_at = ?']
    const params: any[] = [Date.now()]
    const colMap: Record<string, string> = {
      status: 'status',
      qtyOpened: 'qty_opened',
      qtyClosed: 'qty_closed',
      qtyPendingClose: 'qty_pending_close',
      errorReason: 'error_reason',
    }
    for (const [k, v] of Object.entries(patch)) {
      const col = colMap[k]
      if (!col) continue
      sets.push(`${col} = ?`)
      params.push(v as any)
    }
    params.push(signalId)
    return this.db.run(`UPDATE signal_executions SET ${sets.join(', ')} WHERE signal_id = ?`, params)
  }

  // Contract roll (services/futures-roll): the lineage moves to the next
  // dated contract, its identity (signal id) does not.
  updateSignalExecutionSymbol(signalId: string, symbol: string) {
    return this.db.run('UPDATE signal_executions SET symbol = ?, updated_at = ? WHERE signal_id = ?', [
      symbol,
      Date.now(),
      signalId,
    ])
  }

  // ────────────────────────────────────────────────────────────────
  // Per-signal fills (basis for fills-based PnL)
  // ────────────────────────────────────────────────────────────────

  insertSignalFill(fill: {
    signalId: string
    kind: 'entry' | 'exit'
    symbol: string
    side: 'buy' | 'sell'
    qty: number
    price?: number | null
    commission?: number
    orderId?: string | null
    // Real fill moment when the venue reports one (a resting stop can fill long
    // before it is booked). Default: now.
    createdAtMs?: number
  }) {
    return this.db.run(
      `INSERT INTO signal_fills (signal_id, kind, symbol, side, qty, price, commission, order_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        fill.signalId,
        fill.kind,
        fill.symbol,
        fill.side,
        fill.qty,
        fill.price ?? null,
        fill.commission ?? 0,
        fill.orderId ?? null,
        fill.createdAtMs ?? Date.now(),
      ],
    )
  }

  // Exit quantity already in the ledger for one broker order — the venue-exit
  // sweep books only the cumulative delta past this on partial fills.
  sumExitFillQtyForOrder(orderId: string): number {
    const row = this.db
      .query("SELECT COALESCE(SUM(qty), 0) AS total FROM signal_fills WHERE order_id = ? AND kind = 'exit'")
      .get(orderId) as { total: number } | null
    return row?.total ?? 0
  }

  getSignalFills(signalId: string): SignalFillRow[] {
    return this.db
      .query('SELECT * FROM signal_fills WHERE signal_id = ? ORDER BY created_at ASC')
      .all(signalId) as SignalFillRow[]
  }

  // All fills for a set of signals (used to compute PnL for the recent feed in one query).
  getFillsForSignals(signalIds: string[]): SignalFillRow[] {
    if (signalIds.length === 0) return []
    const placeholders = signalIds.map(() => '?').join(',')
    return this.db
      .query(`SELECT * FROM signal_fills WHERE signal_id IN (${placeholders}) ORDER BY created_at ASC`)
      .all(...signalIds) as SignalFillRow[]
  }

  // Newest fills with the execution they belong to (exchange, direction,
  // account). Feeds the chart's own-trades layer; fills whose execution row is
  // gone have no venue and are skipped.
  listRecentFills(limit = 500): RecentFillRow[] {
    return this.db
      .query(
        `SELECT f.id, f.signal_id, e.exchange, e.account_id, f.symbol, e.direction,
                f.kind, f.side, f.qty, f.price, f.commission, f.created_at
           FROM signal_fills f
           JOIN signal_executions e ON e.signal_id = f.signal_id
          ORDER BY f.created_at DESC, f.id DESC
          LIMIT ?`,
      )
      .all(limit) as RecentFillRow[]
  }

  // Portfolio sharing (migration 014): fills not yet shipped to the server.
  listUnsyncedFills(limit = 500): SignalFillRow[] {
    return this.db
      .query('SELECT * FROM signal_fills WHERE synced = 0 ORDER BY created_at ASC LIMIT ?')
      .all(limit) as SignalFillRow[]
  }

  markFillsSynced(ids: number[]) {
    if (ids.length === 0) return
    const placeholders = ids.map(() => '?').join(',')
    return this.db.run(`UPDATE signal_fills SET synced = 1 WHERE id IN (${placeholders})`, ids)
  }

  // ────────────────────────────────────────────────────────────────
  // Balance snapshots → equity curve
  // ────────────────────────────────────────────────────────────────

  insertBalanceSnapshot(snap: {
    exchange: string
    accountId: string
    equity: number
    balance: number
    unrealizedPnL?: number
    currency?: string
    ts?: number
  }) {
    return this.db.run(
      `INSERT INTO balance_snapshots (exchange, account_id, equity, balance, unrealized_pnl, currency, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        snap.exchange,
        snap.accountId,
        snap.equity,
        snap.balance,
        snap.unrealizedPnL ?? 0,
        snap.currency ?? null,
        snap.ts ?? Date.now(),
      ],
    )
  }

  // Portfolio sharing (migration 014): balance snapshots not yet shipped.
  listUnsyncedSnapshots(limit = 500): BalanceSnapshotRow[] {
    return this.db
      .query('SELECT * FROM balance_snapshots WHERE synced = 0 ORDER BY ts ASC LIMIT ?')
      .all(limit) as BalanceSnapshotRow[]
  }

  markSnapshotsSynced(ids: number[]) {
    if (ids.length === 0) return
    const placeholders = ids.map(() => '?').join(',')
    return this.db.run(`UPDATE balance_snapshots SET synced = 1 WHERE id IN (${placeholders})`, ids)
  }

  // Latest equity snapshot for one account — the group risk-guard's equity
  // basis (loss-as-fraction-of-equity checks).
  getLatestBalanceSnapshot(exchange: string, accountId: string): BalanceSnapshotRow | undefined {
    return this.db
      .query(
        'SELECT * FROM balance_snapshots WHERE exchange = ? AND account_id = ? ORDER BY ts DESC LIMIT 1',
      )
      .get(exchange, accountId) as BalanceSnapshotRow | undefined
  }

  // Total equity over time across all accounts: one summed equity point per
  // snapshot timestamp (the poller writes every account at the same ts).
  getEquitySnapshots(sinceMs: number): Array<{ ts: number; equity: number; unrealizedPnL: number }> {
    return this.db
      .query(
        `SELECT ts, SUM(equity) AS equity, SUM(unrealized_pnl) AS unrealizedPnL
         FROM balance_snapshots
         WHERE ts >= ?
         GROUP BY ts
         ORDER BY ts ASC`,
      )
      .all(sinceMs) as Array<{ ts: number; equity: number; unrealizedPnL: number }>
  }

  // ────────────────────────────────────────────────────────────────
  // Execution-state queries for settlement / closing-retry / reconciler
  // ────────────────────────────────────────────────────────────────

  // Executions in 'closing' state (close requested but not yet confirmed).
  listClosingExecutions(): SignalExecutionRow[] {
    return this.db
      .query("SELECT * FROM signal_executions WHERE status = 'closing'")
      .all() as SignalExecutionRow[]
  }

  // Live executions (open or closing) for a given exchange, used by the
  // reconciler to compute the expected net per (account, symbol).
  listOpenExecutionsForExchange(exchange: string): SignalExecutionRow[] {
    return this.db
      .query(
        "SELECT * FROM signal_executions WHERE exchange = ? AND status IN ('open', 'closing')",
      )
      .all(exchange) as SignalExecutionRow[]
  }

  // Distinct (exchange, symbol) pairs we've ever executed — the only symbols the
  // reconciler will touch, so manual positions on untouched symbols stay alone.
  listExecutionSymbols(exchange: string): Array<{ symbol: string }> {
    return this.db
      .query('SELECT DISTINCT symbol FROM signal_executions WHERE exchange = ?')
      .all(exchange) as Array<{ symbol: string }>
  }

  // Distinct (account, symbol) pairs ever executed on an exchange. account_id
  // NULL = a pre-migration row that can't be attributed to a broker account.
  listExecutionAccountSymbols(exchange: string): Array<{ account_id: string | null; symbol: string }> {
    return this.db
      .query('SELECT DISTINCT account_id, symbol FROM signal_executions WHERE exchange = ?')
      .all(exchange) as Array<{ account_id: string | null; symbol: string }>
  }

  // Distinct exchanges with live (open/closing) executions — the venues the
  // reconciler's detect-and-alert pass must observe.
  listExecutionExchanges(): Array<{ exchange: string }> {
    return this.db
      .query(
        "SELECT DISTINCT exchange FROM signal_executions WHERE status IN ('open', 'closing')",
      )
      .all() as Array<{ exchange: string }>
  }

  // ────────────────────────────────────────────────────────────────
  // Order settlements (migration 008) — unknown-outcome resolution
  // ────────────────────────────────────────────────────────────────

  // Insert a settlement row. When a targetLabel is given the (signal_id, kind,
  // target_label) UNIQUE index dedups: a re-fired order for the same target
  // updates the existing row in place (order id / qty / status) instead of
  // adding a second row. Returns the row id (existing one on a dedup hit).
  insertOrderSettlement(row: {
    signalId: string
    exchange: string
    accountId?: string | null
    symbol: string
    category?: string | null
    kind: 'entry' | 'exit'
    side: 'buy' | 'sell'
    qty: number
    orderId: string
    targetLabel?: string | null
    status?: OrderSettlementRow['status']
  }): number {
    const status = row.status ?? 'unknown'
    try {
      const res = this.db.run(
        `INSERT INTO order_settlements
           (signal_id, exchange, account_id, symbol, category, kind, side, qty, order_id, target_label, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.signalId,
          row.exchange,
          row.accountId ?? null,
          row.symbol,
          row.category ?? null,
          row.kind,
          row.side,
          row.qty,
          row.orderId,
          row.targetLabel ?? null,
          status,
          Date.now(),
        ],
      )
      return Number(res.lastInsertRowid)
    } catch (err: any) {
      if (!/UNIQUE/i.test(err?.message ?? '') || row.targetLabel == null) throw err
      // Dedup hit: refresh the existing row for this (signal, kind, target).
      const existing = this.getExitSettlement(row.signalId, row.kind, row.targetLabel)
      if (existing) {
        this.db.run(
          'UPDATE order_settlements SET order_id = ?, qty = ?, side = ?, status = ?, resolved_at = NULL WHERE id = ?',
          [row.orderId, row.qty, row.side, status, existing.id],
        )
        return existing.id
      }
      throw err
    }
  }

  // The settlement row for a specific (signal, kind, target), if any.
  getExitSettlement(
    signalId: string,
    kind: 'entry' | 'exit',
    targetLabel: string,
  ): OrderSettlementRow | undefined {
    return this.db
      .query(
        'SELECT * FROM order_settlements WHERE signal_id = ? AND kind = ? AND target_label = ? LIMIT 1',
      )
      .get(signalId, kind, targetLabel) as OrderSettlementRow | undefined
  }

  // Whether a re-fired order for this (signal, kind, target) already landed an
  // effect — i.e. an existing row whose outcome is not a retryable terminal-
  // without-fill. Mirrors kaibot-exec targetAlreadyProcessed. 'unknown' counts
  // as processed too: the order is in flight and must not be restacked.
  targetAlreadyProcessed(signalId: string, kind: 'entry' | 'exit', targetLabel: string): boolean {
    const row = this.getExitSettlement(signalId, kind, targetLabel)
    if (!row) return false
    return !RETRYABLE_SETTLEMENT_STATUSES.includes(row.status)
  }

  listUnresolvedSettlements(exchange?: string): OrderSettlementRow[] {
    if (exchange) {
      return this.db
        .query("SELECT * FROM order_settlements WHERE status = 'unknown' AND exchange = ?")
        .all(exchange) as OrderSettlementRow[]
    }
    return this.db
      .query("SELECT * FROM order_settlements WHERE status = 'unknown'")
      .all() as OrderSettlementRow[]
  }

  // Exit settlements newer than `sinceMs` — the reconciler holds corrections on
  // these pairs while the close's bookkeeping may still be landing.
  listRecentExitSettlements(
    exchange: string,
    sinceMs: number,
  ): Array<{ account_id: string | null; symbol: string }> {
    return this.db
      .query(
        "SELECT account_id, symbol FROM order_settlements WHERE exchange = ? AND kind = 'exit' AND created_at >= ?",
      )
      .all(exchange, sinceMs) as Array<{ account_id: string | null; symbol: string }>
  }

  resolveOrderSettlement(id: number, status: OrderSettlementRow['status']) {
    return this.db.run(
      'UPDATE order_settlements SET status = ?, resolved_at = ? WHERE id = ?',
      [status, Date.now(), id],
    )
  }

  // Whether a signal already has an unresolved (unknown) settlement of a given
  // kind — guards against placing another order on top of one in flight.
  hasUnresolvedSettlement(signalId: string, kind: 'entry' | 'exit'): boolean {
    const row = this.db
      .query(
        "SELECT 1 FROM order_settlements WHERE signal_id = ? AND kind = ? AND status = 'unknown' LIMIT 1",
      )
      .get(signalId, kind)
    return !!row
  }

  // ────────────────────────────────────────────────────────────────
  // Resting DCA scale-in rungs (migration 026) — TTL + cancel-on-close
  // ────────────────────────────────────────────────────────────────

  // Track a DCA rung that rested unfilled at placement. INSERT OR REPLACE by the
  // order_id PK keeps it idempotent (a re-placed same-id rung refreshes in place).
  insertDcaRestingRung(row: {
    orderId: string
    signalId: string
    exchange: string
    accountId?: string | null
    symbol: string
    category?: string | null
    side: 'buy' | 'sell'
    qty: number
    price?: number | null
    expiresAt?: number | null
  }): void {
    this.db.run(
      `INSERT OR REPLACE INTO dca_resting_rungs
         (order_id, signal_id, exchange, account_id, symbol, category, side, qty, price, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.orderId,
        row.signalId,
        row.exchange,
        row.accountId ?? null,
        row.symbol,
        row.category ?? null,
        row.side,
        row.qty,
        row.price ?? null,
        row.expiresAt ?? null,
        Date.now(),
      ],
    )
  }

  listDcaRestingRungs(exchange?: string): DcaRestingRungRow[] {
    if (exchange) {
      return this.db
        .query('SELECT * FROM dca_resting_rungs WHERE exchange = ?')
        .all(exchange) as DcaRestingRungRow[]
    }
    return this.db.query('SELECT * FROM dca_resting_rungs').all() as DcaRestingRungRow[]
  }

  getDcaRestingRungsForSignal(signalId: string): DcaRestingRungRow[] {
    return this.db
      .query('SELECT * FROM dca_resting_rungs WHERE signal_id = ?')
      .all(signalId) as DcaRestingRungRow[]
  }

  deleteDcaRestingRung(orderId: string): void {
    this.db.run('DELETE FROM dca_resting_rungs WHERE order_id = ?', [orderId])
  }

  // Record how much of a still-resting rung has already been BOOKED as entry
  // fills, so later sweeps book only the delta (never double-count a partial).
  setDcaRestingRungFilledQty(orderId: string, filledQty: number): void {
    this.db.run('UPDATE dca_resting_rungs SET filled_qty = ? WHERE order_id = ?', [
      filledQty,
      orderId,
    ])
  }

  // Every broker order id we've ever placed for an exchange (settlements +
  // bracket legs + corrections). The reconciler uses this to spot working
  // orders it didn't place.
  listKnownOrderIds(exchange: string): Set<string> {
    const ids = new Set<string>()
    for (const r of this.db
      .query('SELECT order_id FROM order_settlements WHERE exchange = ? AND order_id IS NOT NULL')
      .all(exchange) as Array<{ order_id: string }>) {
      ids.add(String(r.order_id))
    }
    for (const r of this.db
      .query('SELECT order_id FROM reconciliations WHERE exchange = ? AND order_id IS NOT NULL')
      .all(exchange) as Array<{ order_id: string }>) {
      ids.add(String(r.order_id))
    }
    for (const r of this.db
      .query(
        'SELECT sl_order_id, tp_order_id, tp_order_ids FROM bracket_pairs WHERE exchange = ?',
      )
      .all(exchange) as Array<{ sl_order_id: string | null; tp_order_id: string | null; tp_order_ids: string | null }>) {
      if (r.sl_order_id) ids.add(String(r.sl_order_id))
      if (r.tp_order_id) ids.add(String(r.tp_order_id))
      for (const id of parseTpOrderIds(r.tp_order_ids)) ids.add(id)
    }
    // Resting scale-in rungs (signal DCA + manual entry ladders) are working
    // orders we placed — without these the foreign-order sweep would treat a
    // resting rung on a reconciled venue as somebody else's order.
    for (const r of this.db
      .query('SELECT order_id FROM dca_resting_rungs WHERE exchange = ?')
      .all(exchange) as Array<{ order_id: string }>) {
      ids.add(String(r.order_id))
    }
    // Stops owned by an edge trail: each cancel/replace mints a fresh order id
    // that may not (yet) be reflected in a bracket pair.
    for (const r of this.db
      .query('SELECT sl_order_id FROM local_trail_state WHERE exchange = ? AND sl_order_id IS NOT NULL')
      .all(exchange) as Array<{ sl_order_id: string }>) {
      ids.add(String(r.sl_order_id))
    }
    return ids
  }

  // ────────────────────────────────────────────────────────────────
  // Bracket pairs (migration 008) — persisted OCO pairing
  // ────────────────────────────────────────────────────────────────

  upsertBracketPair(row: {
    signalId: string
    exchange: string
    // Account the legs rest on (routes the OCO sibling cancel to the right
    // connection). Null on legacy rows = default connection.
    accountId?: string | null
    slOrderId?: string | null
    tpOrderId?: string | null
    // Full TP ladder; when given, tp_order_id mirrors the first leg.
    tpOrderIds?: string[] | null
  }) {
    const tpIds = row.tpOrderIds && row.tpOrderIds.length > 0 ? row.tpOrderIds : null
    const firstTp = tpIds ? tpIds[0] : row.tpOrderId ?? null
    return this.db.run(
      `INSERT INTO bracket_pairs (signal_id, exchange, account_id, sl_order_id, tp_order_id, tp_order_ids, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(signal_id) DO UPDATE SET
         exchange = excluded.exchange,
         account_id = COALESCE(excluded.account_id, bracket_pairs.account_id),
         sl_order_id = excluded.sl_order_id,
         tp_order_id = excluded.tp_order_id,
         tp_order_ids = excluded.tp_order_ids`,
      [row.signalId, row.exchange, row.accountId ?? null, row.slOrderId ?? null, firstTp, tpIds ? JSON.stringify(tpIds) : null, Date.now()],
    )
  }

  getBracketPair(signalId: string): BracketPairRow | undefined {
    return this.db.query('SELECT * FROM bracket_pairs WHERE signal_id = ?').get(signalId) as
      | BracketPairRow
      | undefined
  }

  listBracketPairs(): BracketPairRow[] {
    return this.db.query('SELECT * FROM bracket_pairs').all() as BracketPairRow[]
  }

  deleteBracketPair(signalId: string) {
    return this.db.run('DELETE FROM bracket_pairs WHERE signal_id = ?', [signalId])
  }

  // ────────────────────────────────────────────────────────────────
  // Local trailing-stop / break-even state (migration 013)
  // ────────────────────────────────────────────────────────────────

  upsertLocalTrailState(row: {
    signalId: string
    exchange: string
    symbol: string
    direction: 'long' | 'short'
    entryPrice: number
    slOrderId?: string | null
    trailPercentage?: number | null
    trailPoints?: number | null
    maxPercentage?: number | null
    maxPoints?: number | null
    breakevenFee?: number | null
    extremePrice: number
    currentStop?: number | null
    // migration 028 — omitted fields keep the legacy signal/fixed defaults.
    source?: 'signal' | 'manual'
    accountId?: string | null
    mode?: 'fixed' | 'drawdown'
    minPercentage?: number | null
    minPoints?: number | null
    usePoints?: boolean
    freezeExtreme?: boolean
    trailingLock?: boolean
    manualStop?: number | null
    engineStop?: number | null
    oppositePrice?: number | null
    referencePrice?: number | null
    bracketSignalId?: string | null
  }) {
    const now = Date.now()
    return this.db.run(
      `INSERT INTO local_trail_state
         (signal_id, exchange, symbol, direction, entry_price, sl_order_id,
          trail_percentage, trail_points, max_percentage, max_points, breakeven_fee,
          extreme_price, current_stop, active, created_at, updated_at,
          source, account_id, mode, min_percentage, min_points, use_points,
          freeze_extreme, trailing_lock, manual_stop, engine_stop, opposite_price,
          reference_price, bracket_signal_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(signal_id) DO UPDATE SET
         direction = excluded.direction,
         entry_price = excluded.entry_price,
         sl_order_id = excluded.sl_order_id,
         trail_percentage = excluded.trail_percentage,
         trail_points = excluded.trail_points,
         max_percentage = excluded.max_percentage,
         max_points = excluded.max_points,
         breakeven_fee = excluded.breakeven_fee,
         extreme_price = excluded.extreme_price,
         current_stop = excluded.current_stop,
         active = 1,
         updated_at = excluded.updated_at,
         source = excluded.source,
         account_id = excluded.account_id,
         mode = excluded.mode,
         min_percentage = excluded.min_percentage,
         min_points = excluded.min_points,
         use_points = excluded.use_points,
         freeze_extreme = excluded.freeze_extreme,
         trailing_lock = excluded.trailing_lock,
         manual_stop = excluded.manual_stop,
         engine_stop = excluded.engine_stop,
         opposite_price = excluded.opposite_price,
         reference_price = excluded.reference_price,
         bracket_signal_id = excluded.bracket_signal_id`,
      [
        row.signalId, row.exchange, row.symbol, row.direction, row.entryPrice,
        row.slOrderId ?? null, row.trailPercentage ?? null, row.trailPoints ?? null,
        row.maxPercentage ?? null, row.maxPoints ?? null, row.breakevenFee ?? null,
        row.extremePrice, row.currentStop ?? null, now, now,
        row.source ?? 'signal', row.accountId ?? null, row.mode ?? 'fixed',
        row.minPercentage ?? null, row.minPoints ?? null, row.usePoints ? 1 : 0,
        row.freezeExtreme ? 1 : 0, row.trailingLock ? 1 : 0,
        row.manualStop ?? null, row.engineStop ?? null, row.oppositePrice ?? null,
        row.referencePrice ?? null, row.bracketSignalId ?? null,
      ],
    )
  }

  listActiveLocalTrails(): LocalTrailStateRow[] {
    return this.db
      .query('SELECT * FROM local_trail_state WHERE active = 1')
      .all() as LocalTrailStateRow[]
  }

  getLocalTrail(key: string): LocalTrailStateRow | undefined {
    return this.db
      .query('SELECT * FROM local_trail_state WHERE signal_id = ?')
      .get(key) as LocalTrailStateRow | undefined
  }

  // Active trails steering a (exchange, symbol) position — any attach key, any
  // account by default. Used to enforce ONE stop-owner per position (callers
  // there filter siblings by account themselves). Pass accountId to scope the
  // query itself — the manual close path does, so it never retires or cancels
  // the stop of a same-symbol position on a DIFFERENT account (account_id NULL
  // rows still match: non-account-routed venues never set it).
  findActiveTrailsForSymbol(exchange: string, symbol: string, accountId?: string | null): LocalTrailStateRow[] {
    if (accountId != null) {
      return this.db
        .query(
          `SELECT * FROM local_trail_state
           WHERE active = 1 AND exchange = ? AND LOWER(symbol) = LOWER(?)
             AND (account_id IS NULL OR account_id = ?)`,
        )
        .all(exchange, symbol, accountId) as LocalTrailStateRow[]
    }
    return this.db
      .query(
        'SELECT * FROM local_trail_state WHERE active = 1 AND exchange = ? AND LOWER(symbol) = LOWER(?)',
      )
      .all(exchange, symbol) as LocalTrailStateRow[]
  }

  // Most recently retired trail on a (exchange, symbol) that still knows its
  // resting stop order. Take-over re-attach adopts it as the stop seed: the bot
  // trail detachBot retired carries the LIVE stop order id + last stop level.
  // accountId scopes to that account (rows without one belong to the default
  // connection and only match a default-connection account).
  findLatestRetiredTrailForSymbol(
    exchange: string,
    symbol: string,
    accountId?: string | null,
  ): LocalTrailStateRow | undefined {
    if (accountId != null) {
      const key = accountKeyOf(accountId)
      return this.db
        .query(
          `SELECT * FROM local_trail_state
           WHERE active = 0 AND exchange = ? AND LOWER(symbol) = LOWER(?) AND sl_order_id IS NOT NULL
             AND (account_id = ? OR (account_id IS NULL AND ? IS NULL))
           ORDER BY updated_at DESC LIMIT 1`,
        )
        .get(exchange, symbol, accountId, key ?? null) as LocalTrailStateRow | undefined
    }
    return this.db
      .query(
        `SELECT * FROM local_trail_state
         WHERE active = 0 AND exchange = ? AND LOWER(symbol) = LOWER(?) AND sl_order_id IS NOT NULL
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(exchange, symbol) as LocalTrailStateRow | undefined
  }

  updateLocalTrail(signalId: string, fields: {
    slOrderId?: string | null
    extremePrice?: number
    currentStop?: number | null
    engineStop?: number | null
    oppositePrice?: number | null
    manualStop?: number | null
    trailingLock?: boolean
  }) {
    const sets: string[] = []
    const vals: any[] = []
    if (fields.slOrderId !== undefined) { sets.push('sl_order_id = ?'); vals.push(fields.slOrderId) }
    if (fields.extremePrice !== undefined) { sets.push('extreme_price = ?'); vals.push(fields.extremePrice) }
    if (fields.currentStop !== undefined) { sets.push('current_stop = ?'); vals.push(fields.currentStop) }
    if (fields.engineStop !== undefined) { sets.push('engine_stop = ?'); vals.push(fields.engineStop) }
    if (fields.oppositePrice !== undefined) { sets.push('opposite_price = ?'); vals.push(fields.oppositePrice) }
    if (fields.manualStop !== undefined) { sets.push('manual_stop = ?'); vals.push(fields.manualStop) }
    if (fields.trailingLock !== undefined) { sets.push('trailing_lock = ?'); vals.push(fields.trailingLock ? 1 : 0) }
    if (sets.length === 0) return
    sets.push('updated_at = ?'); vals.push(Date.now())
    vals.push(signalId)
    return this.db.run(`UPDATE local_trail_state SET ${sets.join(', ')} WHERE signal_id = ?`, vals)
  }

  deactivateLocalTrail(signalId: string) {
    return this.db.run(
      'UPDATE local_trail_state SET active = 0, updated_at = ? WHERE signal_id = ?',
      [Date.now(), signalId],
    )
  }

  // ────────────────────────────────────────────────────────────────
  // Edge manager engine state (migration 029)
  // ────────────────────────────────────────────────────────────────

  upsertManagedPosition(row: {
    positionKey: string
    exchange: string
    accountId?: string | null
    symbol: string
    direction: 'long' | 'short'
    avgEntryPrice: number
    size: number
    extremePrice: number
    oppositePrice: number
    currentStopLoss?: number | null
    referencePrice?: number | null
    openedTs?: number
  }) {
    const now = Date.now()
    return this.db.run(
      `INSERT INTO managed_positions
         (position_key, exchange, account_id, symbol, direction, avg_entry_price,
          size, extreme_price, opposite_price, current_stop_loss, reference_price,
          opened_ts, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(position_key) DO UPDATE SET
         direction = excluded.direction,
         avg_entry_price = excluded.avg_entry_price,
         size = excluded.size,
         extreme_price = excluded.extreme_price,
         opposite_price = excluded.opposite_price,
         current_stop_loss = excluded.current_stop_loss,
         reference_price = excluded.reference_price,
         active = 1,
         updated_at = excluded.updated_at`,
      [
        row.positionKey, row.exchange, row.accountId ?? null, row.symbol, row.direction,
        row.avgEntryPrice, row.size, row.extremePrice, row.oppositePrice,
        row.currentStopLoss ?? null, row.referencePrice ?? null,
        row.openedTs ?? now, now, now,
      ],
    )
  }

  getManagedPosition(positionKey: string): ManagedPositionRow | undefined {
    return this.db
      .query('SELECT * FROM managed_positions WHERE position_key = ?')
      .get(positionKey) as ManagedPositionRow | undefined
  }

  // Active managed positions that still have at least one active manager — the
  // engine's tick set. A row whose managers were all detached is skipped.
  listActiveManagedPositions(): ManagedPositionRow[] {
    return this.db
      .query(
        `SELECT mp.* FROM managed_positions mp
         WHERE mp.active = 1
           AND EXISTS (
             SELECT 1 FROM position_managers pm
             WHERE pm.position_key = mp.position_key AND pm.active = 1
           )`,
      )
      .all() as ManagedPositionRow[]
  }

  updateManagedPosition(positionKey: string, fields: {
    avgEntryPrice?: number
    size?: number
    extremePrice?: number
    oppositePrice?: number
    currentStopLoss?: number | null
  }) {
    const sets: string[] = []
    const vals: any[] = []
    if (fields.avgEntryPrice !== undefined) { sets.push('avg_entry_price = ?'); vals.push(fields.avgEntryPrice) }
    if (fields.size !== undefined) { sets.push('size = ?'); vals.push(fields.size) }
    if (fields.extremePrice !== undefined) { sets.push('extreme_price = ?'); vals.push(fields.extremePrice) }
    if (fields.oppositePrice !== undefined) { sets.push('opposite_price = ?'); vals.push(fields.oppositePrice) }
    if (fields.currentStopLoss !== undefined) { sets.push('current_stop_loss = ?'); vals.push(fields.currentStopLoss) }
    if (sets.length === 0) return
    sets.push('updated_at = ?'); vals.push(Date.now())
    vals.push(positionKey)
    return this.db.run(`UPDATE managed_positions SET ${sets.join(', ')} WHERE position_key = ?`, vals)
  }

  // Deactivate the position row AND all of its manager rows (position flat, or
  // last manager detached).
  deactivateManagedPosition(positionKey: string) {
    const now = Date.now()
    this.db.run(
      'UPDATE position_managers SET active = 0, updated_at = ? WHERE position_key = ?',
      [now, positionKey],
    )
    return this.db.run(
      'UPDATE managed_positions SET active = 0, updated_at = ? WHERE position_key = ?',
      [now, positionKey],
    )
  }

  upsertPositionManager(row: {
    positionKey: string
    managerId: string
    execOrder: number
    params: string
    state: string
  }) {
    const now = Date.now()
    return this.db.run(
      `INSERT INTO position_managers
         (position_key, manager_id, exec_order, params, state, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(position_key, manager_id) DO UPDATE SET
         exec_order = excluded.exec_order,
         params = excluded.params,
         state = excluded.state,
         active = 1,
         updated_at = excluded.updated_at`,
      [row.positionKey, row.managerId, row.execOrder, row.params, row.state, now, now],
    )
  }

  getPositionManager(positionKey: string, managerId: string): PositionManagerRow | undefined {
    return this.db
      .query('SELECT * FROM position_managers WHERE position_key = ? AND manager_id = ?')
      .get(positionKey, managerId) as PositionManagerRow | undefined
  }

  listActiveManagersForPosition(positionKey: string): PositionManagerRow[] {
    return this.db
      .query(
        'SELECT * FROM position_managers WHERE position_key = ? AND active = 1 ORDER BY exec_order ASC',
      )
      .all(positionKey) as PositionManagerRow[]
  }

  updatePositionManagerState(positionKey: string, managerId: string, state: string) {
    return this.db.run(
      'UPDATE position_managers SET state = ?, updated_at = ? WHERE position_key = ? AND manager_id = ?',
      [state, Date.now(), positionKey, managerId],
    )
  }

  deactivatePositionManager(positionKey: string, managerId: string) {
    return this.db.run(
      'UPDATE position_managers SET active = 0, updated_at = ? WHERE position_key = ? AND manager_id = ?',
      [Date.now(), positionKey, managerId],
    )
  }

  // ────────────────────────────────────────────────────────────────
  // Position groups (migration 030) — visibility-only grouping
  // ────────────────────────────────────────────────────────────────

  createPositionGroup(row: {
    id: string
    name: string
    source: 'bot' | 'takeover' | 'manual'
    botConfigId?: string | null
    signalBotId?: string | null
  }) {
    const now = Date.now()
    return this.db.run(
      `INSERT INTO position_groups
         (id, name, source, bot_config_id, signal_bot_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.name, row.source, row.botConfigId ?? null, row.signalBotId ?? null, now, now],
    )
  }

  getPositionGroup(id: string): PositionGroupRow | undefined {
    return this.db
      .query('SELECT * FROM position_groups WHERE id = ?')
      .get(id) as PositionGroupRow | undefined
  }

  // The lazy-create lookup for bot auto-grouping: one group per server bot id.
  getPositionGroupForBot(signalBotId: string): PositionGroupRow | undefined {
    return this.db
      .query('SELECT * FROM position_groups WHERE signal_bot_id = ? ORDER BY created_at ASC')
      .get(signalBotId) as PositionGroupRow | undefined
  }

  listPositionGroups(): PositionGroupRow[] {
    return this.db
      .query('SELECT * FROM position_groups ORDER BY created_at ASC')
      .all() as PositionGroupRow[]
  }

  renamePositionGroup(id: string, name: string) {
    return this.db.run(
      'UPDATE position_groups SET name = ?, updated_at = ? WHERE id = ?',
      [name, Date.now(), id],
    )
  }

  // ─── Server exit state (migration 031, exit-as-signal-update E2) ───
  // Acceptance gate for server-authored `update` signals: only positions whose
  // entry carried metadata.exitAuthority = 'server' get a row; everything else
  // keeps the flat refusal. last_exit_seq is the monotonic replay guard.

  upsertServerExitState(row: {
    positionId: string
    entrySignalId: string
    exchange: string
    symbol: string
    direction: 'long' | 'short'
    currentStop?: number | null
    slOrderId?: string | null
  }) {
    const now = Date.now()
    return this.db.run(
      `INSERT INTO server_exit_state
         (position_id, entry_signal_id, exchange, symbol, direction,
          last_exit_seq, current_stop, engine_stop, sl_order_id, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(position_id) DO UPDATE SET
         entry_signal_id = excluded.entry_signal_id,
         exchange = excluded.exchange,
         symbol = excluded.symbol,
         direction = excluded.direction,
         current_stop = excluded.current_stop,
         engine_stop = excluded.engine_stop,
         sl_order_id = excluded.sl_order_id,
         active = 1,
         updated_at = excluded.updated_at`,
      [
        row.positionId, row.entrySignalId, row.exchange, row.symbol, row.direction,
        row.currentStop ?? null, row.currentStop ?? null, row.slOrderId ?? null, now, now,
      ],
    )
  }

  getServerExitState(positionId: string): ServerExitStateRow | null {
    return this.db
      .query('SELECT * FROM server_exit_state WHERE position_id = ?')
      .get(positionId) as ServerExitStateRow | null
  }

  // current_stop = what rests at the venue; engineStop = the bot's own stop
  // (omitted = unchanged, so a floor-only amend never touches the ratchet).
  applyServerExitUpdate(positionId: string, patch: {
    exitSeq: number
    currentStop?: number | null
    slOrderId?: string | null
    engineStop?: number | null
  }) {
    const sets = ['last_exit_seq = ?', 'current_stop = ?', 'sl_order_id = ?']
    const vals: any[] = [patch.exitSeq, patch.currentStop ?? null, patch.slOrderId ?? null]
    if (patch.engineStop !== undefined) { sets.push('engine_stop = ?'); vals.push(patch.engineStop) }
    sets.push('updated_at = ?'); vals.push(Date.now())
    vals.push(positionId)
    return this.db.run(`UPDATE server_exit_state SET ${sets.join(', ')} WHERE position_id = ?`, vals)
  }

  // The user's stop floor on a bot position (migration 038). Partial: only the
  // provided fields change.
  updateServerExitStopFloor(positionId: string, fields: { manualStop?: number | null; trailingLock?: boolean }) {
    const sets: string[] = []
    const vals: any[] = []
    if (fields.manualStop !== undefined) { sets.push('manual_stop = ?'); vals.push(fields.manualStop) }
    if (fields.trailingLock !== undefined) { sets.push('trailing_lock = ?'); vals.push(fields.trailingLock ? 1 : 0) }
    if (sets.length === 0) return
    sets.push('updated_at = ?'); vals.push(Date.now())
    vals.push(positionId)
    return this.db.run(`UPDATE server_exit_state SET ${sets.join(', ')} WHERE position_id = ?`, vals)
  }

  // Contract roll: the armed position now lives on the next contract; the
  // exit-update handler matches the venue position by this symbol.
  updateServerExitStateSymbol(positionId: string, symbol: string) {
    return this.db.run('UPDATE server_exit_state SET symbol = ?, updated_at = ? WHERE position_id = ?', [
      symbol,
      Date.now(),
      positionId,
    ])
  }

  deactivateServerExitState(positionId: string) {
    return this.db.run(
      'UPDATE server_exit_state SET active = 0, updated_at = ? WHERE position_id = ?',
      [Date.now(), positionId],
    )
  }

  // Active rows for the venue-exit sweep: these carry the resting stop order
  // ids whose broker-side fill must be noticed and booked.
  listActiveServerExitStates(exchange?: string): ServerExitStateRow[] {
    return (
      exchange
        ? this.db.query('SELECT * FROM server_exit_state WHERE active = 1 AND exchange = ?').all(exchange)
        : this.db.query('SELECT * FROM server_exit_state WHERE active = 1').all()
    ) as ServerExitStateRow[]
  }

  // Every manual marker, for the position-lineage view.
  listManualPositions(): ManualPositionRow[] {
    return this.db.query('SELECT * FROM manual_positions').all() as ManualPositionRow[]
  }

  // Deleting a group NEVER touches positions — members revert to Unsorted.
  deletePositionGroup(id: string) {
    this.db.run(
      'UPDATE position_group_links SET group_id = NULL, updated_at = ? WHERE group_id = ?',
      [Date.now(), id],
    )
    return this.db.run('DELETE FROM position_groups WHERE id = ?', [id])
  }

  // Auto rules ('auto') never overwrite a user assignment; a 'user' write always
  // wins and pins the link.
  upsertPositionGroupLink(row: {
    positionKey: string
    exchange: string
    accountId: string
    symbol: string
    groupId: string | null
    assignedBy: 'auto' | 'user'
  }) {
    const existing = this.getPositionGroupLink(row.positionKey)
    if (existing && existing.assigned_by === 'user' && row.assignedBy === 'auto') return
    const now = Date.now()
    return this.db.run(
      `INSERT INTO position_group_links
         (position_key, exchange, account_id, symbol, group_id, assigned_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(position_key) DO UPDATE SET
         group_id = excluded.group_id,
         assigned_by = excluded.assigned_by,
         updated_at = excluded.updated_at`,
      [row.positionKey, row.exchange, row.accountId, row.symbol, row.groupId, row.assignedBy, now, now],
    )
  }

  getPositionGroupLink(positionKey: string): PositionGroupLinkRow | undefined {
    return this.db
      .query('SELECT * FROM position_group_links WHERE position_key = ?')
      .get(positionKey) as PositionGroupLinkRow | undefined
  }

  listPositionGroupLinks(): PositionGroupLinkRow[] {
    return this.db.query('SELECT * FROM position_group_links').all() as PositionGroupLinkRow[]
  }

  deletePositionGroupLink(positionKey: string) {
    return this.db.run('DELETE FROM position_group_links WHERE position_key = ?', [positionKey])
  }

  // ────────────────────────────────────────────────────────────────
  // Hedge guards (migration 033)
  // ────────────────────────────────────────────────────────────────

  // Arm a guard on the main position key. A terminal row (active=0) on the same
  // key is replaced — a one-shot lifecycle ended and the user re-arms; an ACTIVE
  // row must never be silently replaced (the service enforces that).
  insertHedgeGuard(row: {
    positionKey: string
    exchange: string
    accountId: string
    symbol: string
    direction: 'long' | 'short'
    hedgeSymbol: string
    hedgeAccountId: string
    triggerPrice: number
    sizeMode: 'match' | 'fixed-usd'
    fixedUsd?: number | null
    recoveryPrice?: number | null
    onMainClose: 'keep' | 'close'
  }) {
    const now = Date.now()
    return this.db.run(
      `INSERT OR REPLACE INTO hedge_guards
         (position_key, exchange, account_id, symbol, direction,
          hedge_symbol, hedge_account_id, trigger_price, size_mode, fixed_usd,
          recovery_price, on_main_close, status, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'armed', 1, ?, ?)`,
      [
        row.positionKey, row.exchange.toLowerCase(), row.accountId, row.symbol.toUpperCase(),
        row.direction, row.hedgeSymbol.toUpperCase(), row.hedgeAccountId,
        row.triggerPrice, row.sizeMode, row.fixedUsd ?? null,
        row.recoveryPrice ?? null, row.onMainClose, now, now,
      ],
    )
  }

  getHedgeGuard(positionKey: string): HedgeGuardRow | undefined {
    return this.db
      .query('SELECT * FROM hedge_guards WHERE position_key = ?')
      .get(positionKey) as HedgeGuardRow | undefined
  }

  listActiveHedgeGuards(): HedgeGuardRow[] {
    return this.db
      .query('SELECT * FROM hedge_guards WHERE active = 1 ORDER BY created_at ASC')
      .all() as HedgeGuardRow[]
  }

  listHedgeGuards(): HedgeGuardRow[] {
    return this.db
      .query('SELECT * FROM hedge_guards ORDER BY updated_at DESC')
      .all() as HedgeGuardRow[]
  }

  updateHedgeGuard(
    positionKey: string,
    fields: Partial<{
      triggerPrice: number
      sizeMode: 'match' | 'fixed-usd'
      fixedUsd: number | null
      recoveryPrice: number | null
      onMainClose: 'keep' | 'close'
      hedgeSymbol: string
      hedgeAccountId: string
      status: 'armed' | 'hedged' | 'closed' | 'orphaned'
      hedgeSide: 'buy' | 'sell' | null
      hedgeQty: number | null
      hedgeEntryPrice: number | null
      hedgeOpenedTs: number | null
      closeReason: string | null
      lastError: string | null
      active: number
    }>,
  ) {
    const sets: string[] = []
    const vals: unknown[] = []
    const map: Record<string, string> = {
      triggerPrice: 'trigger_price',
      sizeMode: 'size_mode',
      fixedUsd: 'fixed_usd',
      recoveryPrice: 'recovery_price',
      onMainClose: 'on_main_close',
      hedgeSymbol: 'hedge_symbol',
      hedgeAccountId: 'hedge_account_id',
      status: 'status',
      hedgeSide: 'hedge_side',
      hedgeQty: 'hedge_qty',
      hedgeEntryPrice: 'hedge_entry_price',
      hedgeOpenedTs: 'hedge_opened_ts',
      closeReason: 'close_reason',
      lastError: 'last_error',
      active: 'active',
    }
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || !map[k]) continue
      sets.push(`${map[k]} = ?`)
      vals.push(k === 'hedgeSymbol' && typeof v === 'string' ? v.toUpperCase() : v)
    }
    if (sets.length === 0) return
    sets.push('updated_at = ?')
    vals.push(Date.now())
    vals.push(positionKey)
    return this.db.run(
      `UPDATE hedge_guards SET ${sets.join(', ')} WHERE position_key = ?`,
      vals as any[],
    )
  }

  deleteHedgeGuard(positionKey: string) {
    return this.db.run('DELETE FROM hedge_guards WHERE position_key = ?', [positionKey])
  }

  // ────────────────────────────────────────────────────────────────
  // Manual (discretionary) position markers (migration 022)
  // ────────────────────────────────────────────────────────────────

  private static readonly MANUAL_POSITION_EPSILON = 1e-9

  // Apply a manual fill to the (exchange, account, symbol) marker: buy adds,
  // sell subtracts. Creates the row on first fill; deletes it once the net
  // rounds back to flat. Used on a manual OPEN (the marker the reconciler skips).
  addManualPosition(exchange: string, accountId: string, symbol: string, side: 'buy' | 'sell', qty: number) {
    const signed = side === 'buy' ? qty : -qty
    const existing = this.getManualPosition(exchange, accountId, symbol)
    const net = (existing?.net ?? 0) + signed
    const now = Date.now()
    if (Math.abs(net) < KaiBotDatabase.MANUAL_POSITION_EPSILON) {
      this.clearManualPosition(exchange, accountId, symbol)
      return
    }
    this.db.run(
      `INSERT INTO manual_positions (exchange, account_id, symbol, net, opened_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(exchange, account_id, symbol) DO UPDATE SET net = excluded.net, updated_at = excluded.updated_at`,
      [exchange, accountId, symbol, net, existing?.opened_at ?? now, now],
    )
  }

  // Reduce an EXISTING manual marker toward flat by qty (never flips sign, never
  // creates a row). No-op when there's no marker — so closing a taken-over or
  // signal-owned position never conjures a phantom manual marker.
  reduceManualPosition(exchange: string, accountId: string, symbol: string, qty: number) {
    const existing = this.getManualPosition(exchange, accountId, symbol)
    if (!existing) return
    const magnitude = Math.max(0, Math.abs(existing.net) - Math.abs(qty))
    if (magnitude < KaiBotDatabase.MANUAL_POSITION_EPSILON) {
      this.clearManualPosition(exchange, accountId, symbol)
      return
    }
    const net = existing.net < 0 ? -magnitude : magnitude
    this.db.run(
      'UPDATE manual_positions SET net = ?, updated_at = ? WHERE exchange = ? AND account_id = ? AND symbol = ?',
      [net, Date.now(), exchange, accountId, symbol],
    )
  }

  getManualPosition(exchange: string, accountId: string, symbol: string): ManualPositionRow | undefined {
    return this.db
      .query('SELECT * FROM manual_positions WHERE exchange = ? AND account_id = ? AND symbol = ?')
      .get(exchange, accountId, symbol) as ManualPositionRow | undefined
  }

  // Whether ANY account carries an open manual position on this (exchange, symbol).
  // The reconciler uses this to hold off on corrections for the symbol.
  hasManualPosition(exchange: string, symbol: string): boolean {
    return !!this.db
      .query('SELECT 1 FROM manual_positions WHERE exchange = ? AND symbol = ? LIMIT 1')
      .get(exchange, symbol)
  }

  clearManualPosition(exchange: string, accountId: string, symbol: string) {
    return this.db.run(
      'DELETE FROM manual_positions WHERE exchange = ? AND account_id = ? AND symbol = ?',
      [exchange, accountId, symbol],
    )
  }

  // Clear every account's marker for a symbol — used by the reconciler auto-heal
  // when the broker net is back to the signal-expected net (manual overhang gone).
  clearManualPositionSymbol(exchange: string, symbol: string) {
    return this.db.run('DELETE FROM manual_positions WHERE exchange = ? AND symbol = ?', [exchange, symbol])
  }

  // Distinct synthetic signal ids of manual ENTRY orders recorded for a symbol,
  // so a manual close can cancel their resting bracket legs (OCO cleanup). Pass
  // accountId to scope to that account only — a full close on account A must
  // never retire account B's resting bracket on the same symbol (account_id
  // NULL rows still match: non-account-routed venues never set it).
  listManualEntrySignalIds(exchange: string, symbol: string, accountId?: string | null): string[] {
    if (accountId != null) {
      return (
        this.db
          .query(
            `SELECT DISTINCT signal_id FROM order_settlements
             WHERE exchange = ? AND symbol = ? AND kind = 'entry' AND signal_id LIKE 'manual:%'
               AND (account_id IS NULL OR account_id = ?)`,
          )
          .all(exchange, symbol, accountId) as Array<{ signal_id: string }>
      ).map((r) => r.signal_id)
    }
    return (
      this.db
        .query(
          "SELECT DISTINCT signal_id FROM order_settlements WHERE exchange = ? AND symbol = ? AND kind = 'entry' AND signal_id LIKE 'manual:%'",
        )
        .all(exchange, symbol) as Array<{ signal_id: string }>
    ).map((r) => r.signal_id)
  }

  // Open (still-held) executed entry signals that belong to a given bot config.
  // A systematic signal stores its originating botConfigId in metadata JSON
  // (set by the server when it emits the signal). Used by take-over/detach to find
  // the local positions a bot still manages so their local trails can be retired.
  getOpenSignalsForBotConfig(botConfigId: string): Array<{ id: string; symbol: string }> {
    return this.db
      .query(
        `SELECT id, symbol FROM signals
         WHERE action IN ('buy', 'sell')
           AND status = 'executed'
           AND metadata LIKE '%' || ? || '%'
         ORDER BY received_at DESC`,
      )
      .all(botConfigId) as Array<{ id: string; symbol: string }>
  }

  // Active local trails for a set of signals — the edge-side "position managers"
  // (server position_managers analog) steering those positions' exits.
  activeLocalTrailsForSignals(signalIds: string[]): LocalTrailStateRow[] {
    if (signalIds.length === 0) return []
    const placeholders = signalIds.map(() => '?').join(',')
    return this.db
      .query(
        `SELECT * FROM local_trail_state WHERE active = 1 AND signal_id IN (${placeholders})`,
      )
      .all(...signalIds) as LocalTrailStateRow[]
  }

  // ────────────────────────────────────────────────────────────────
  // Reconciliations (migration 008) — reconciler audit log
  // ────────────────────────────────────────────────────────────────

  insertReconciliation(row: {
    exchange: string
    accountId: string
    symbol: string
    expectedNet: number
    brokerNet: number
    delta: number
    action: string
    side?: string | null
    qty?: number | null
    orderId?: string | null
    status?: string | null
  }) {
    return this.db.run(
      `INSERT INTO reconciliations
         (exchange, account_id, symbol, expected_net, broker_net, delta, action, side, qty, order_id, status, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.exchange,
        row.accountId,
        row.symbol,
        row.expectedNet,
        row.brokerNet,
        row.delta,
        row.action,
        row.side ?? null,
        row.qty ?? null,
        row.orderId ?? null,
        row.status ?? null,
        Date.now(),
      ],
    )
  }

  listRecentReconciliations(limit = 100): ReconciliationRow[] {
    return this.db
      .query('SELECT * FROM reconciliations ORDER BY ts DESC LIMIT ?')
      .all(limit) as ReconciliationRow[]
  }

  // The most recent reconciliation row per (exchange, symbol). Drives the
  // mismatch badges in the positions/exchange views without scanning the whole
  // audit log on each render.
  // One row per (exchange, account, symbol). Grouping on the symbol alone let an
  // incident on one account paint the healthy position of another account with
  // the same contract as mismatched.
  latestReconciliationPerSymbol(exchange?: string): ReconciliationRow[] {
    const sql = `
      SELECT r.* FROM reconciliations r
      JOIN (
        SELECT exchange, account_id, symbol, MAX(ts) AS ts
        FROM reconciliations
        ${exchange ? 'WHERE exchange = ?' : ''}
        GROUP BY exchange, account_id, symbol
      ) latest
        ON r.exchange = latest.exchange
       AND r.account_id = latest.account_id
       AND r.symbol = latest.symbol
       AND r.ts = latest.ts`
    return (exchange
      ? this.db.query(sql).all(exchange)
      : this.db.query(sql).all()) as ReconciliationRow[]
  }

  // ────────────────────────────────────────────────────────────────
  // Per-account contract sizing (migration 009)
  // ────────────────────────────────────────────────────────────────

  // Configured cap for (exchange, account, root), or null when none is set (the
  // caller then falls back to a built-in default).
  getAccountSize(exchange: string, account: string, root: string): number | null {
    const row = this.db
      .query(
        'SELECT max_contracts FROM account_sizes WHERE exchange = ? AND account = ? AND root = ?',
      )
      .get(exchange, account, root) as { max_contracts: number } | undefined
    return row ? row.max_contracts : null
  }

  setAccountSize(exchange: string, account: string, root: string, maxContracts: number) {
    return this.db.run(
      `INSERT INTO account_sizes (exchange, account, root, max_contracts, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(exchange, account, root) DO UPDATE SET
         max_contracts = excluded.max_contracts,
         updated_at = excluded.updated_at`,
      [exchange, account, root, maxContracts, Date.now()],
    )
  }

  listAccountSizes(): Array<{ exchange: string; account: string; root: string; max_contracts: number }> {
    return this.db
      .query('SELECT exchange, account, root, max_contracts FROM account_sizes')
      .all() as Array<{ exchange: string; account: string; root: string; max_contracts: number }>
  }

  // ────────────────────────────────────────────────────────────────
  // Per-account breathing-room margin guard (migration 015)
  // ────────────────────────────────────────────────────────────────

  // Config for (exchange, account), or null when none is set. ('*','*') holds
  // the global-default row; the caller falls back to it then to env defaults.
  // The guardrail columns (max_daily_loss / max_concurrent_positions /
  // max_total_notional) ride on the same row (migration 016); 0 = that rail off.
  getMarginGuard(exchange: string, account: string): MarginGuardRow | null {
    const row = this.db
      .query(
        `SELECT exchange, account, enabled, buffer_mult, floor_mode, equity_pct,
                max_daily_loss, max_concurrent_positions, max_total_notional
         FROM margin_guards WHERE exchange = ? AND account = ?`,
      )
      .get(exchange, account) as MarginGuardRow | undefined
    return row ?? null
  }

  setMarginGuard(
    exchange: string,
    account: string,
    cfg: { enabled: boolean; bufferMult: number; floorMode: string; equityPct: number },
  ) {
    return this.db.run(
      `INSERT INTO margin_guards (exchange, account, enabled, buffer_mult, floor_mode, equity_pct, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(exchange, account) DO UPDATE SET
         enabled = excluded.enabled,
         buffer_mult = excluded.buffer_mult,
         floor_mode = excluded.floor_mode,
         equity_pct = excluded.equity_pct,
         updated_at = excluded.updated_at`,
      [exchange, account, cfg.enabled ? 1 : 0, cfg.bufferMult, cfg.floorMode, cfg.equityPct, Date.now()],
    )
  }

  // Set the opt-in guardrail rails for (exchange, account). Upserts onto the same
  // row as the margin guard, leaving the breathing-room columns untouched (the
  // INSERT side seeds sane breathing-room defaults only for a brand-new row).
  setGuardrails(
    exchange: string,
    account: string,
    cfg: { maxDailyLoss: number; maxConcurrentPositions: number; maxTotalNotional: number },
  ) {
    return this.db.run(
      `INSERT INTO margin_guards
         (exchange, account, enabled, buffer_mult, floor_mode, equity_pct,
          max_daily_loss, max_concurrent_positions, max_total_notional, updated_at)
       VALUES (?, ?, 0, 1.0, 'maintenance', 0.2, ?, ?, ?, ?)
       ON CONFLICT(exchange, account) DO UPDATE SET
         max_daily_loss = excluded.max_daily_loss,
         max_concurrent_positions = excluded.max_concurrent_positions,
         max_total_notional = excluded.max_total_notional,
         updated_at = excluded.updated_at`,
      [
        exchange,
        account,
        cfg.maxDailyLoss,
        cfg.maxConcurrentPositions,
        cfg.maxTotalNotional,
        Date.now(),
      ],
    )
  }

  listMarginGuards(): MarginGuardRow[] {
    return this.db
      .query(
        `SELECT exchange, account, enabled, buffer_mult, floor_mode, equity_pct,
                max_daily_loss, max_concurrent_positions, max_total_notional
         FROM margin_guards`,
      )
      .all() as MarginGuardRow[]
  }

  // ────────────────────────────────────────────────────────────────
  // Local halt flag (migration 016) — panic-&-halt + daily-loss trip
  // ────────────────────────────────────────────────────────────────

  // The single halt row (id pinned to 1). When halted = 1 the signal-client drops
  // inbound opens. This is local executor state — it survives a restart and works
  // with no cloud, which is the whole point of an offline-proof kill switch.
  getHaltState(): { halted: boolean; reason: string | null; tripped_at: number | null } {
    const row = this.db
      .query('SELECT halted, reason, tripped_at FROM executor_halt WHERE id = 1')
      .get() as { halted: number; reason: string | null; tripped_at: number | null } | undefined
    return {
      halted: !!row?.halted,
      reason: row?.reason ?? null,
      tripped_at: row?.tripped_at ?? null,
    }
  }

  setHaltState(halted: boolean, reason?: string | null) {
    return this.db.run(
      'UPDATE executor_halt SET halted = ?, reason = ?, tripped_at = ? WHERE id = 1',
      [halted ? 1 : 0, halted ? reason ?? null : null, halted ? Date.now() : null],
    )
  }

  // ────────────────────────────────────────────────────────────────
  // Companion control plane (migration 020) — opt-in, default OFF.
  // The single companion_settings row (id pinned to 1) holds the enabled flag +
  // the pairing code. paired devices live in companion_devices. Layer 3 swaps
  // the pairing internals (real keys/PAKE) — these methods are the storage seam.
  // ────────────────────────────────────────────────────────────────

  getCompanionSettings(): { enabled: boolean; pairingCode: string | null; enabledAt: number | null } {
    const row = this.db
      .query('SELECT enabled, pairing_code, enabled_at FROM companion_settings WHERE id = 1')
      .get() as { enabled: number; pairing_code: string | null; enabled_at: number | null } | undefined
    return {
      enabled: !!row?.enabled,
      pairingCode: row?.pairing_code ?? null,
      enabledAt: row?.enabled_at ?? null,
    }
  }

  setCompanionEnabled(enabled: boolean, pairingCode: string | null) {
    return this.db.run(
      'UPDATE companion_settings SET enabled = ?, pairing_code = ?, enabled_at = ? WHERE id = 1',
      [enabled ? 1 : 0, enabled ? pairingCode : null, enabled ? Date.now() : null],
    )
  }

  listCompanionDevices(): Array<{
    id: string
    label: string | null
    paired_at: number
    pub_key: string | null
    verified: number
  }> {
    return this.db
      .query('SELECT id, label, paired_at, pub_key, verified FROM companion_devices ORDER BY paired_at DESC')
      .all() as Array<{ id: string; label: string | null; paired_at: number; pub_key: string | null; verified: number }>
  }

  // Upsert a device row with its pinned public key + verified state. PENDING =
  // verified 0 (pair seen, awaiting pairConfirm); PAIRED = verified 1.
  addCompanionDevice(id: string, label: string | null, pubKey?: string | null, verified = false) {
    return this.db.run(
      `INSERT INTO companion_devices (id, label, paired_at, pub_key, verified) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET label = excluded.label, paired_at = excluded.paired_at,
         pub_key = excluded.pub_key, verified = excluded.verified`,
      [id, label, Date.now(), pubKey ?? null, verified ? 1 : 0],
    )
  }

  setCompanionDeviceVerified(id: string, verified: boolean) {
    return this.db.run('UPDATE companion_devices SET verified = ? WHERE id = ?', [verified ? 1 : 0, id])
  }

  removeCompanionDevice(id: string) {
    return this.db.run('DELETE FROM companion_devices WHERE id = ?', [id])
  }

  clearCompanionDevices() {
    return this.db.run('DELETE FROM companion_devices')
  }

  // ── Companion identity keypair (Layer 3) ──
  // The executor's long-term X25519 identity. enc_secret_key is the Crypto-vault
  // ciphertext of the 32-byte secret key; pub_key is hex (relayed, not secret).
  getCompanionIdentity(): { pubKey: string; encSecretKey: string } | null {
    const row = this.db
      .query('SELECT pub_key, enc_secret_key FROM companion_identity WHERE id = 1')
      .get() as { pub_key: string; enc_secret_key: string } | undefined
    return row ? { pubKey: row.pub_key, encSecretKey: row.enc_secret_key } : null
  }

  setCompanionIdentity(pubKey: string, encSecretKey: string) {
    return this.db.run(
      `INSERT INTO companion_identity (id, pub_key, enc_secret_key, created_at) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET pub_key = excluded.pub_key, enc_secret_key = excluded.enc_secret_key`,
      [pubKey, encSecretKey, Date.now()],
    )
  }

  // ─── Synthetic USD ───

  getSyntheticUsdPosition(id: string): SyntheticUsdPositionRow | null {
    const row = this.db
      .query('SELECT * FROM synthetic_usd_positions WHERE id = ?')
      .get(id) as SyntheticUsdPositionRow | undefined
    return row ?? null
  }

  getOpenSyntheticUsdPosition(
    exchange: string,
    account: string,
    symbol: string,
  ): SyntheticUsdPositionRow | null {
    const row = this.db
      .query(
        `SELECT * FROM synthetic_usd_positions
         WHERE exchange = ? AND account_id = ? AND symbol = ? AND status = 'open'`,
      )
      .get(exchange, account, symbol) as SyntheticUsdPositionRow | undefined
    return row ?? null
  }

  // One basis per (exchange, account). Without arguments: any flagged row
  // (legacy callers); the sizing lookup always passes the account.
  getFactorBasisSyntheticUsdPosition(exchange?: string, account?: string): SyntheticUsdPositionRow | null {
    const row = (
      exchange != null && account != null
        ? this.db
            .query(
              `SELECT * FROM synthetic_usd_positions
               WHERE is_factor_basis = 1 AND status IN ('open', 'armed')
                 AND exchange = ? AND account_id = ? LIMIT 1`,
            )
            .get(exchange, account)
        : this.db
            .query(
              `SELECT * FROM synthetic_usd_positions
               WHERE is_factor_basis = 1 AND status IN ('open', 'armed') LIMIT 1`,
            )
            .get()
    ) as SyntheticUsdPositionRow | undefined
    return row ?? null
  }

  listFactorBasisSyntheticUsdPositions(): SyntheticUsdPositionRow[] {
    return this.db
      .query(
        `SELECT * FROM synthetic_usd_positions
         WHERE is_factor_basis = 1 AND status IN ('open', 'armed') ORDER BY exchange, account_id`,
      )
      .all() as SyntheticUsdPositionRow[]
  }

  // Live = open or armed (an armed row has no short yet but owns the market).
  getLiveSyntheticUsdPosition(
    exchange: string,
    account: string,
    symbol: string,
  ): SyntheticUsdPositionRow | null {
    const row = this.db
      .query(
        `SELECT * FROM synthetic_usd_positions
         WHERE exchange = ? AND account_id = ? AND symbol = ? AND status IN ('open', 'armed')`,
      )
      .get(exchange, account, symbol) as SyntheticUsdPositionRow | undefined
    return row ?? null
  }

  listSyntheticUsdPositions(includeClosed = false): SyntheticUsdPositionRow[] {
    const sql = includeClosed
      ? 'SELECT * FROM synthetic_usd_positions ORDER BY created_at DESC'
      : "SELECT * FROM synthetic_usd_positions WHERE status IN ('open', 'armed') ORDER BY created_at DESC"
    return this.db.query(sql).all() as SyntheticUsdPositionRow[]
  }

  // Rows in an arm cycle: armed (waiting for the trigger) or open after a
  // trigger mint (waiting for recovery). Drives the synthetic-guard tick.
  listArmCycleSyntheticUsdPositions(): SyntheticUsdPositionRow[] {
    return this.db
      .query(
        `SELECT * FROM synthetic_usd_positions
         WHERE status IN ('open', 'armed') AND arm_trigger_price IS NOT NULL
         ORDER BY created_at ASC`,
      )
      .all() as SyntheticUsdPositionRow[]
  }

  insertSyntheticUsdPosition(row: {
    id: string
    exchange: string
    account_id: string
    symbol: string
    target_usd: number
    holdings_basis_usd: number
    leverage: number
    short_size: number
    // User-authored protective ceiling. Defaults to the historical 10x.
    leverage_cap: number
    // 'armed' inserts a trigger-only row (no short yet). Default 'open'.
    status?: 'open' | 'armed'
  }) {
    const now = Date.now()
    return this.db.run(
      `INSERT INTO synthetic_usd_positions
        (id, exchange, account_id, symbol, target_usd, holdings_basis_usd,
         leverage, short_size, leverage_cap, status, is_factor_basis, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        row.id,
        row.exchange,
        row.account_id,
        row.symbol,
        row.target_usd,
        row.holdings_basis_usd,
        row.leverage,
        row.short_size,
        row.leverage_cap,
        row.status ?? 'open',
        now,
        now,
      ],
    )
  }

  listAutoRebalanceSyntheticUsdPositions(): SyntheticUsdPositionRow[] {
    return this.db
      .query(
        "SELECT * FROM synthetic_usd_positions WHERE status = 'open' AND auto_rebalance = 1 ORDER BY created_at ASC",
      )
      .all() as SyntheticUsdPositionRow[]
  }

  updateSyntheticUsdPosition(
    id: string,
    patch: {
      target_usd?: number
      holdings_basis_usd?: number
      leverage?: number
      short_size?: number
      leverage_cap?: number
      status?: SyntheticUsdPositionRow['status']
      auto_rebalance?: number
      rebalance_target_pct?: number
      rebalance_band_pct?: number
      rebalance_basis?: string
      last_rebalance_at?: number
      arm_direction?: 'long' | 'short' | null
      arm_trigger_price?: number | null
      arm_trigger_price_initial?: number | null
      arm_holdings_coin?: number | null
      arm_planned_usd?: number | null
      arm_trail_pct?: number | null
      arm_trail_abs?: number | null
      arm_high_water?: number | null
      arm_recovery_price?: number | null
      arm_recovery_pct?: number | null
      arm_tolerance_pct?: number
      arm_fired_trigger_price?: number | null
      arm_fired_price?: number | null
      arm_fired_at?: number | null
      arm_cycle?: number
      arm_armed_at?: number | null
      arm_last_mark?: number | null
      arm_last_mark_at?: number | null
      arm_last_error?: string | null
    },
  ) {
    const fields: string[] = []
    const values: any[] = []
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue
      fields.push(`${k} = ?`)
      values.push(v)
    }
    if (fields.length === 0) return
    fields.push('updated_at = ?')
    values.push(Date.now(), id)
    return this.db.run(
      `UPDATE synthetic_usd_positions SET ${fields.join(', ')} WHERE id = ?`,
      values,
    )
  }

  // Mark one position as the factor basis for ITS (exchange, account),
  // clearing any other row on that same account. Atomic.
  setSyntheticUsdFactorBasis(id: string, enabled: boolean) {
    this.transaction(() => {
      const target = this.getSyntheticUsdPosition(id)
      if (!target) return
      this.db.run(
        'UPDATE synthetic_usd_positions SET is_factor_basis = 0, updated_at = ? WHERE exchange = ? AND account_id = ?',
        [Date.now(), target.exchange, target.account_id],
      )
      if (enabled) {
        this.db.run(
          'UPDATE synthetic_usd_positions SET is_factor_basis = 1, updated_at = ? WHERE id = ?',
          [Date.now(), id],
        )
      }
    })
  }

  insertSyntheticUsdMutation(row: {
    position_id: string
    kind: SyntheticUsdMutationKind
    target_usd_before: number
    target_usd_after: number
    short_size_before: number
    short_size_after: number
    order_id?: string | null
    order_side?: string | null
    order_qty?: number | null
    // Serialized to JSON. Planned vs realized for arm-cycle mutations.
    meta?: Record<string, unknown> | null
  }) {
    return this.db.run(
      `INSERT INTO synthetic_usd_mutations
        (position_id, kind, target_usd_before, target_usd_after,
         short_size_before, short_size_after, order_id, order_side, order_qty, meta, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.position_id,
        row.kind,
        row.target_usd_before,
        row.target_usd_after,
        row.short_size_before,
        row.short_size_after,
        row.order_id ?? null,
        row.order_side ?? null,
        row.order_qty ?? null,
        row.meta ? JSON.stringify(row.meta) : null,
        Date.now(),
      ],
    )
  }

  listSyntheticUsdMutations(positionId: string): SyntheticUsdMutationRow[] {
    return this.db
      .query(
        'SELECT * FROM synthetic_usd_mutations WHERE position_id = ? ORDER BY created_at ASC',
      )
      .all(positionId) as SyntheticUsdMutationRow[]
  }

  listHoldingsBasis(): HoldingsBasisRow[] {
    return this.db
      .query('SELECT * FROM holdings_basis ORDER BY is_manual ASC, source ASC')
      .all() as HoldingsBasisRow[]
  }

  setHoldingsBasis(source: string, usdValue: number, isManual: boolean) {
    return this.db.run(
      `INSERT INTO holdings_basis (source, usd_value, is_manual, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(source) DO UPDATE SET
         usd_value = excluded.usd_value,
         is_manual = excluded.is_manual,
         updated_at = excluded.updated_at`,
      [source, usdValue, isManual ? 1 : 0, Date.now()],
    )
  }

  deleteHoldingsBasis(source: string) {
    return this.db.run('DELETE FROM holdings_basis WHERE source = ?', [source])
  }

  run(sql: string, params: any[] = []) {
    return this.db.run(sql, ...params)
  }

  all(sql: string, params: any[] = []) {
    return this.db.query(sql).all(...params)
  }

  get(sql: string, params: any[] = []) {
    return this.db.query(sql).get(...params)
  }

  close() {
    this.db.close()
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }
}
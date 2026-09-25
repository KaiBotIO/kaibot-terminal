// Local types specific to executor.
// (The shared @kaibot/types barrel is intentionally not re-exported here — it
// pulls a heavy transitive graph and none of those names are used by the
// backend, which uses the exchange adapter types and the locals below.)
export type UserRole = 'admin' | 'viewer'

export interface UserAccount {
  id: number
  username: string
  role: UserRole
  created_at: string
  last_login: string | null
}

export interface AuthSessionRow {
  id: number
  user_id: number
  expires_at: string
  role: UserRole
  username: string
}

export interface ApiKey {
  id: number
  name: string
  key_encrypted: string
  permissions?: string[]
  last_validated?: Date
  is_active: boolean
  created_at: Date
}

// Local mirror of @kaibot/types OrderPlan. Kept structural (not imported) so the
// backend stays off the shared barrel's heavy transitive graph — see the file
// header. Must stay shape-compatible with packages/types/src/trading/order-plan.ts.
export interface PlannedEntry {
  price?: number
  size: number
}
export interface PlannedTakeProfit {
  price: number
  fraction: number
}
// Deliberately NO `trail` field (the shared OrderPlan has one): trail params on
// the wire are the server's proprietary IP. The executor sources trail distance
// exclusively from the user's own local settings, so an inbound
// order_plan.trail must stay structurally unreadable here.
export interface OrderPlan {
  entries?: PlannedEntry[]
  stopLoss?: number
  takeProfits?: PlannedTakeProfit[]
  ttlBars?: number
  postpone?: boolean
}

export interface Signal {
  id: string
  strategy_id: string
  strategy_name?: string
  symbol: string
  action: 'buy' | 'sell' | 'close'
  quantity?: number
  price?: number
  type?: 'market' | 'limit' | 'stop' | 'stopLimit'
  confidence?: number
  stop_loss?: number
  take_profit?: number
  // Cornix-parity execution plan. Present = honour the multi-TP ladder / DCA /
  // trailing rule; absent = single-leg behaviour (back-compat).
  order_plan?: OrderPlan
  metadata?: Record<string, any>
  received_at: Date
  processed_at?: Date
  // 'deferred': a market entry parked until the venue trades again.
  status: 'pending' | 'executed' | 'rejected' | 'expired' | 'closed' | 'deferred'
  trade_id?: number
  error_message?: string
  stop_loss_order_id?: string
  take_profit_order_id?: string
  created_at: Date
}

// Bot config projection (migration 017) — identity + routing the executor's bot
// control plane shows, synced from the server. NOT the brain: the executor runs
// no strategy/indicator code. The strategy*/indicatorSources fields are vestigial
// (kept for the schema, never populated server-side) and must stay empty.
export interface BotConfigRow {
  id: string
  signalBotId: string
  botName?: string
  strategyId: string
  strategyName?: string
  // Vestigial — never populated (the server holds the strategy, not the executor).
  strategyType: string
  strategyConfig: unknown
  indicatorSources?: Record<string, string>
  exchange: string
  symbol: string
  timeframe: string
  // 'phasing_out' (projected from the server run state): entries are clipped
  // edge-side, exits/updates still flow; back to 'running' when the server resumes.
  status: 'running' | 'paused' | 'stopped' | 'phasing_out'
  // INV7 — per-bot execution target. 'kaibot' (default): the SERVER emits a WS
  // signal to this executor. 'webhook': the SERVER renders alertPayloadTemplate
  // and POSTs it to alertWebhookUrl. The executor never fires the webhook; this
  // is the routing projection the control plane displays.
  executionTarget: 'kaibot' | 'webhook'
  alertWebhookUrl?: string | null
  // User-defined body with {{placeholders}}, rendered SERVER-SIDE per fired alert.
  alertPayloadTemplate?: string | null
}

// Per-bot run state (migration 017). Mirrors server signalBotRuns.state /
// lastCandleAt so the executor threads the same JSON RunnerState between ticks
// and the lastCandleAt guard fires identically (no re-emit on a stale candle).
export interface BotRunStateRow {
  botConfigId: string
  state: unknown | null
  lastCandleAt: number | null
  lastSignalAt: number | null
}

export interface PerformanceMetric {
  id: number
  bot_id?: number
  date: Date
  total_trades: number
  winning_trades: number
  losing_trades: number
  total_pnl: number
  win_rate?: number
  average_win?: number
  average_loss?: number
  sharpe_ratio?: number
  max_drawdown?: number
  created_at: Date
}

export interface Log {
  id: number
  level: 'debug' | 'info' | 'warn' | 'error'
  category: 'system' | 'trading' | 'connection' | 'signal' | 'risk'
  message: string
  metadata?: Record<string, any>
  created_at: Date
}

// Per-signal execution status.
//  open    — position held (or partially closed but still live)
//  closing — a close was requested but its order hasn't confirmed a fill yet;
//            the position still counts as live and a background job retries it
//  closed  — flat
//  error   — open failed; never held a position
export type SignalExecutionStatus = 'open' | 'closing' | 'closed' | 'error'

// Idempotent per-signal execution state (migration 007).
export interface SignalExecutionRow {
  signal_id: string
  symbol: string
  exchange: string
  direction: 'long' | 'short'
  status: SignalExecutionStatus
  qty_opened: number
  qty_closed: number
  // Close qty still owed by an in-flight unconfirmed close (status 'closing').
  // retryPendingCloses re-issues exactly this remainder, never the whole live
  // position. NULL = the pending close targets the full position (migration 027).
  qty_pending_close: number | null
  error_reason: string | null
  // Broker account the entry was routed to (migration 032). NULL on
  // pre-migration rows — those stay unattributed and are never auto-corrected.
  account_id: string | null
  created_at: number
  updated_at: number
}

// Order whose broker outcome was unknown when placed (migration 008).
// target_label (migration 011): stable per-target dedup key for exits — 'close'
// for a full close, or a sized partial reduce label (e.g. 'reduce:30'). NULL for
// entries and legacy rows.
export interface OrderSettlementRow {
  id: number
  signal_id: string
  exchange: string
  account_id: string | null
  symbol: string
  category: string | null
  kind: 'entry' | 'exit'
  side: 'buy' | 'sell'
  qty: number
  order_id: string
  target_label: string | null
  status: 'unknown' | 'filled' | 'rejected' | 'cancelled' | 'lost'
  created_at: number
  resolved_at: number | null
}

// One row per DCA scale-in rung that rested unfilled at placement (migration
// 026). Tracked so it can be (a) settled when it later fills, (b) TTL-cancelled
// after the ttlBars-equivalent elapsed time, (c) cancelled when the parent
// position closes — so a stale add can never fill into a phantom position on a
// non-reconciled venue.
export interface DcaRestingRungRow {
  order_id: string
  signal_id: string
  exchange: string
  account_id: string | null
  symbol: string
  category: string | null
  side: 'buy' | 'sell'
  qty: number
  price: number | null
  // Cumulative qty already BOOKED as entry fills while the rung rested (partial
  // fills); sweeps book only the delta past this (migration 027).
  filled_qty: number
  // epoch ms; NULL = no time-based TTL (bar duration unresolved) → cancel-on-close only.
  expires_at: number | null
  created_at: number
}

// Persisted OCO bracket pairing (migration 008; tp_order_ids added in 012).
export interface BracketPairRow {
  signal_id: string
  exchange: string
  // Null on legacy rows (default connection).
  account_id?: string | null
  sl_order_id: string | null
  // First TP leg, kept for back-compat readers.
  tp_order_id: string | null
  // JSON array of all TP leg order ids (multi-TP ladder). Null on legacy rows.
  tp_order_ids: string | null
  created_at: number
}

// Reconciler audit row (migration 008).
export interface ReconciliationRow {
  id: number
  exchange: string
  account_id: string
  symbol: string
  expected_net: number
  broker_net: number
  delta: number
  action: string
  side: string | null
  qty: number | null
  order_id: string | null
  status: string | null
  ts: number
}

// Per-signal fill, basis for fills-based PnL (migration 007).
export interface SignalFillRow {
  id: number
  signal_id: string
  kind: 'entry' | 'exit'
  symbol: string
  side: 'buy' | 'sell'
  qty: number
  price: number | null
  // USD; the native pair is what the venue charged in its own currency
  // (migration 040). Null on fills booked before it or without a venue fee.
  commission: number
  fee_native?: number | null
  fee_currency?: string | null
  order_id: string | null
  created_at: number
  // 1 once shipped to the server analytics ingest (migration 014).
  synced?: number
}

// One signal_fills row with its execution's venue and account (commission
// backfill).
export interface FillWithVenueRow {
  id: number
  signal_id: string
  exchange: string
  account_id: string | null
  symbol: string
  kind: 'entry' | 'exit'
  side: 'buy' | 'sell'
  qty: number
  price: number | null
  commission: number
  fee_native: number | null
  fee_currency: string | null
  order_id: string
  created_at: number
}

// One signal_fills row joined to its execution (exchange/direction/account).
export interface RecentFillRow {
  id: number
  signal_id: string
  exchange: string
  account_id: string | null
  symbol: string
  direction: 'long' | 'short'
  kind: 'entry' | 'exit'
  side: 'buy' | 'sell'
  qty: number
  price: number | null
  commission: number
  created_at: number
}

// Per-(exchange, account) margin guard + opt-in guardrails (migrations 015/016).
// enabled / buffer_mult / floor_mode / equity_pct are the breathing-room guard;
// the max_* columns are the opt-in safety rails (0 = that rail off).
export interface MarginGuardRow {
  exchange: string
  account: string
  enabled: number
  buffer_mult: number
  floor_mode: string
  equity_pct: number
  max_daily_loss: number
  max_concurrent_positions: number
  max_total_notional: number
}

// Equity/cash snapshot per exchange account (migration 007).
export interface BalanceSnapshotRow {
  id: number
  exchange: string
  account_id: string
  equity: number
  balance: number
  unrealized_pnl: number
  currency: string | null
  ts: number
  // 1 once shipped to the server analytics ingest (migration 014).
  synced?: number
}

// Local trailing-stop / break-even state (migrations 013 + 028). One row per
// open position carrying an edge trail; driven by the LocalPositionManager poll
// loop. signal_id is the ATTACH KEY: the signal id on the signal path, the
// deterministic `pos:{exchange}:{account}:{symbol}` key for a trail the user
// armed on a position by hand (source='manual').
// server_exit_state (migration 031 + 038): the acceptance gate for
// server-authored exit updates on one bot position, plus the user's stop floor.
export interface ServerExitStateRow {
  position_id: string
  entry_signal_id: string
  exchange: string
  symbol: string
  direction: 'long' | 'short'
  last_exit_seq: number
  // The stop resting at the venue (the composed effective stop).
  current_stop: number | null
  sl_order_id: string | null
  active: number
  created_at: number
  updated_at: number
  // ── migration 038 (stop floor) ──
  // The user's floor: always participates, the bot only improves on it.
  manual_stop: number | null
  // Lock: bot stop moves recorded but not placed; manual_stop is absolute.
  trailing_lock: number
  // The bot's own last accepted stop, favourable-only against itself.
  engine_stop: number | null
}

export interface LocalTrailStateRow {
  signal_id: string
  exchange: string
  symbol: string
  direction: 'long' | 'short'
  entry_price: number
  sl_order_id: string | null
  trail_percentage: number | null
  trail_points: number | null
  max_percentage: number | null
  max_points: number | null
  breakeven_fee: number | null
  extreme_price: number
  current_stop: number | null
  active: number
  created_at: number
  updated_at: number
  // ── migration 028 (position-scoped trails) ──
  source: 'signal' | 'manual'
  account_id: string | null
  mode: 'fixed' | 'drawdown'
  // Drawdown mode: floor on the trail distance (max_* double as the caps).
  min_percentage: number | null
  min_points: number | null
  use_points: number
  freeze_extreme: number
  // Lock: engine trail suspended, manual_stop absolute.
  trailing_lock: number
  // The user's stop — always participates; the engine only improves on it.
  manual_stop: number | null
  // Engine ratchet (favourable-only), separate from the venue-resting
  // current_stop so a dominant manual stop never resets it.
  engine_stop: number | null
  // Adverse water mark (addon opposite_price) — drawdown depth input.
  opposite_price: number | null
  // Frozen trail anchor / reference under freeze_extreme.
  reference_price: number | null
  // Bracket whose protective stop this trail took over (OCO rebind target).
  bracket_signal_id: string | null
}

// Locally persisted ManagedPositionState for the edge manager engine
// (migration 029). One row per managed position; position_key is the same
// deterministic attach key as position trails (pos:{exchange}:{account}:{symbol}).
export interface ManagedPositionRow {
  position_key: string
  exchange: string
  account_id: string | null
  symbol: string
  direction: 'long' | 'short'
  avg_entry_price: number
  size: number
  extreme_price: number
  opposite_price: number
  // Mirror of the resting protective stop — the reducers' favourable yardstick.
  current_stop_loss: number | null
  reference_price: number | null
  opened_ts: number
  active: number
  created_at: number
  updated_at: number
}

// One (position, manager) attachment (migration 029). params = user-authored
// JSON config; state = threaded JSON RunnerState; exec_order = composition slot.
export interface PositionManagerRow {
  position_key: string
  manager_id: string
  exec_order: number
  params: string
  state: string
  active: number
  created_at: number
  updated_at: number
}

// Manual (discretionary) position presence marker (migration 022). Signed live
// size per (exchange, account, symbol); the reconciler skips symbols carrying one.
export interface ManualPositionRow {
  exchange: string
  account_id: string
  symbol: string
  net: number
  opened_at: number
  updated_at: number
}

// Position groups (migration 030) — visibility-only grouping of live positions.
export interface PositionGroupRow {
  id: string
  name: string
  source: 'bot' | 'takeover' | 'manual'
  bot_config_id: string | null
  signal_bot_id: string | null
  created_at: number
  updated_at: number
}

// One row per position (keyed pos:{exchange}:{account}:{symbol}); group_id
// NULL (or no row) = Unsorted. 'user' assignments are never auto-overwritten.
export interface PositionGroupLinkRow {
  position_key: string
  exchange: string
  account_id: string
  symbol: string
  group_id: string | null
  assigned_by: 'auto' | 'user'
  created_at: number
  updated_at: number
}

// Hedge guard (migration 033) — one per MAIN position key. The hedge leg lives
// on a DIFFERENT (paired) instrument; lifecycle is one-shot (legacy parity):
// armed -> hedged -> closed/orphaned. Terminal rows keep active=0 for audit.
export interface HedgeGuardRow {
  position_key: string
  exchange: string
  account_id: string
  symbol: string
  direction: 'long' | 'short'
  hedge_symbol: string
  hedge_account_id: string
  trigger_price: number
  size_mode: 'match' | 'fixed-usd'
  fixed_usd: number | null
  recovery_price: number | null
  on_main_close: 'keep' | 'close'
  status: 'armed' | 'hedged' | 'closed' | 'orphaned'
  hedge_side: 'buy' | 'sell' | null
  hedge_qty: number | null
  hedge_entry_price: number | null
  hedge_opened_ts: number | null
  close_reason: string | null
  last_error: string | null
  active: number
  created_at: number
  updated_at: number
}

// 'armed' (migration 034): the row carries a trigger but no short yet — the
// edge mints through the normal path on an adverse breach.
export type SyntheticUsdStatus = 'open' | 'closed' | 'armed'

// 'equity' is reserved (column accepts it, the v1 route rejects it).
export type SyntheticUsdRebalanceBasis = 'holdings' | 'equity'

export interface SyntheticUsdPositionRow {
  id: string
  exchange: string
  account_id: string
  symbol: string
  target_usd: number
  holdings_basis_usd: number
  leverage: number
  short_size: number
  // User-set protective ceiling: target_usd may not exceed
  // holdings_basis_usd * leverage_cap. Authored by the user, not KaiBot.
  leverage_cap: number
  status: SyntheticUsdStatus
  is_factor_basis: number
  // Auto-rebalance (opt-in per position AND gated globally by env):
  // the loop keeps the short at rebalance_target_pct % of the basis, acting
  // only when drift exceeds rebalance_band_pct.
  auto_rebalance: number
  rebalance_target_pct: number
  rebalance_band_pct: number
  rebalance_basis: string
  last_rebalance_at: number | null
  // Armed (dynamic) synthetic — migration 034. All null on a plain position.
  // Non-null arm_trigger_price = the row is in an arm cycle (armed, or open
  // after a trigger mint and waiting for recovery).
  arm_direction: 'long' | 'short' | null
  arm_trigger_price: number | null
  arm_trigger_price_initial: number | null
  // Holdings in coin units; planned protected USD = coin × trigger.
  arm_holdings_coin: number | null
  arm_planned_usd: number | null
  arm_trail_pct: number | null
  arm_trail_abs: number | null
  arm_high_water: number | null
  arm_recovery_price: number | null
  arm_recovery_pct: number | null
  arm_tolerance_pct: number
  arm_fired_trigger_price: number | null
  arm_fired_price: number | null
  arm_fired_at: number | null
  arm_cycle: number
  arm_armed_at: number | null
  arm_last_mark: number | null
  arm_last_mark_at: number | null
  arm_last_error: string | null
  created_at: number
  updated_at: number
}

export type SyntheticUsdMutationKind =
  | 'mint'
  | 'scale_up'
  | 'scale_down'
  | 'close'
  | 'auto_rebalance'
  | 'arm'
  | 'arm_update'
  | 'disarm'
  | 'recovery_close'

export interface SyntheticUsdMutationRow {
  id: number
  position_id: string
  kind: SyntheticUsdMutationKind
  target_usd_before: number
  target_usd_after: number
  short_size_before: number
  short_size_after: number
  order_id: string | null
  order_side: string | null
  order_qty: number | null
  // JSON: planned vs realized for arm-cycle mutations (trigger, mark,
  // plannedUsd, realizedUsd, avgFillPrice, capped, gapPct). Null otherwise.
  meta: string | null
  created_at: number
}

export interface HoldingsBasisRow {
  source: string
  usd_value: number
  is_manual: number
  updated_at: number
}
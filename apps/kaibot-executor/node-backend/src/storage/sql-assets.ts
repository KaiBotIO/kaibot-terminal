// Every .sql asset the daemon needs at runtime, embedded via Bun text
// imports so they exist inside compiled binaries (`bun build --compile`).
// A plain readFileSync(__dirname) points at the BUILD machine's path in a
// compiled binary and crashes the first boot on a user machine.
import schemaSql from './schema.sql' with { type: 'text' }
import m002 from './migrations/002_exchanges.sql' with { type: 'text' }
import m003 from './migrations/003_subscriptions.sql' with { type: 'text' }
import m004 from './migrations/004_signal_stops.sql' with { type: 'text' }
import m005 from './migrations/005_auth_sessions.sql' with { type: 'text' }
import m006 from './migrations/006_drop_dead_position_tables.sql' with { type: 'text' }
import m007 from './migrations/007_execution_state.sql' with { type: 'text' }
import m008 from './migrations/008_reconciliation.sql' with { type: 'text' }
import m009 from './migrations/009_account_sizes.sql' with { type: 'text' }
import m010 from './migrations/010_synthetic_usd.sql' with { type: 'text' }
import m011 from './migrations/011_order_settlement_dedup.sql' with { type: 'text' }
import m012 from './migrations/012_tp_ladder.sql' with { type: 'text' }
import m013 from './migrations/013_local_trail_state.sql' with { type: 'text' }
import m014 from './migrations/014_portfolio_sync.sql' with { type: 'text' }
import m015 from './migrations/015_margin_guards.sql' with { type: 'text' }
import m016 from './migrations/016_guardrails.sql' with { type: 'text' }
import m017 from './migrations/017_bot_configs.sql' with { type: 'text' }
import m018 from './migrations/018_bot_config_execution_target.sql' with { type: 'text' }
import m019 from './migrations/019_synthetic_usd_leverage_cap.sql' with { type: 'text' }
import m020 from './migrations/020_companion.sql' with { type: 'text' }
import m021 from './migrations/021_companion_e2e.sql' with { type: 'text' }
import m022 from './migrations/022_manual_positions.sql' with { type: 'text' }
import m023 from './migrations/023_basis_guard.sql' with { type: 'text' }
import m024 from './migrations/024_synthetic_usd_auto_rebalance.sql' with { type: 'text' }
import m025 from './migrations/025_subscription_size_unit.sql' with { type: 'text' }
import m026 from './migrations/026_dca_resting_rungs.sql' with { type: 'text' }
import m027 from './migrations/027_partial_fill_tracking.sql' with { type: 'text' }
import m028 from './migrations/028_position_trail.sql' with { type: 'text' }
import m029 from './migrations/029_position_managers.sql' with { type: 'text' }
import m030 from './migrations/030_position_groups.sql' with { type: 'text' }
import m031 from './migrations/031_server_exit_state.sql' with { type: 'text' }

const assets: Record<string, string> = {
  'schema.sql': schemaSql,
  'migrations/002_exchanges.sql': m002,
  'migrations/003_subscriptions.sql': m003,
  'migrations/004_signal_stops.sql': m004,
  'migrations/005_auth_sessions.sql': m005,
  'migrations/006_drop_dead_position_tables.sql': m006,
  'migrations/007_execution_state.sql': m007,
  'migrations/008_reconciliation.sql': m008,
  'migrations/009_account_sizes.sql': m009,
  'migrations/010_synthetic_usd.sql': m010,
  'migrations/011_order_settlement_dedup.sql': m011,
  'migrations/012_tp_ladder.sql': m012,
  'migrations/013_local_trail_state.sql': m013,
  'migrations/014_portfolio_sync.sql': m014,
  'migrations/015_margin_guards.sql': m015,
  'migrations/016_guardrails.sql': m016,
  'migrations/017_bot_configs.sql': m017,
  'migrations/018_bot_config_execution_target.sql': m018,
  'migrations/019_synthetic_usd_leverage_cap.sql': m019,
  'migrations/020_companion.sql': m020,
  'migrations/021_companion_e2e.sql': m021,
  'migrations/022_manual_positions.sql': m022,
  'migrations/023_basis_guard.sql': m023,
  'migrations/024_synthetic_usd_auto_rebalance.sql': m024,
  'migrations/025_subscription_size_unit.sql': m025,
  'migrations/026_dca_resting_rungs.sql': m026,
  'migrations/027_partial_fill_tracking.sql': m027,
  'migrations/028_position_trail.sql': m028,
  'migrations/029_position_managers.sql': m029,
  'migrations/030_position_groups.sql': m030,
  'migrations/031_server_exit_state.sql': m031,
}

export function sqlAsset(rel: string): string {
  const sql = assets[rel]
  if (!sql) throw new Error(`sql asset not embedded: ${rel} — add it to sql-assets.ts`)
  return sql
}

export const sqlAssetNames = Object.keys(assets)

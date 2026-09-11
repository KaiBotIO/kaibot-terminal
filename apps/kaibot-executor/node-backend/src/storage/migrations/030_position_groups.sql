-- Position groups (G0, position-groups-visibility plan). Identity/visibility
-- ONLY — grouping never changes trading behaviour (group actions are G2).
--
-- Live positions are venue-derived (adapter.getPositions()), not local rows, so
-- the persistent "group_id on the position" surface is a link table keyed by
-- the same deterministic position key trails/managers already use:
-- pos:{exchange}:{account}:{symbol}. No link (or a NULL group_id) = Unsorted.

CREATE TABLE IF NOT EXISTS position_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- 'bot': lazily created on a bot config's first fill; 'takeover': created at
  -- take-over for a bot position that predates grouping; 'manual': user-created.
  source TEXT NOT NULL CHECK (source IN ('bot', 'takeover', 'manual')),
  bot_config_id TEXT,
  signal_bot_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_position_groups_bot
  ON position_groups(signal_bot_id);

CREATE TABLE IF NOT EXISTS position_group_links (
  position_key TEXT PRIMARY KEY,
  exchange TEXT NOT NULL,
  account_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  group_id TEXT,
  -- 'auto' links (bot fill / take-over lineage) may be rewritten by the auto
  -- rules; 'user' assignments are never auto-overwritten.
  assigned_by TEXT NOT NULL CHECK (assigned_by IN ('auto', 'user')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_position_group_links_group
  ON position_group_links(group_id);

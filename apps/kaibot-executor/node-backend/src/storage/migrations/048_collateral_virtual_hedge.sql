-- Virtual-line coverage (migration 048): per account 'none' (counted, not
-- protected) or 'hedge' (a perp short for the virtual qty fires with the
-- sell floor). Per floor: the hedge leg toggle, its armed synthetic and the
-- alert-trap state (dedup per trap, cleared when the leg re-arms).
ALTER TABLE collateral_settings ADD COLUMN virtual_coverage TEXT NOT NULL DEFAULT 'none';
ALTER TABLE collateral_floors ADD COLUMN virtual_hedge INTEGER NOT NULL DEFAULT 1;
ALTER TABLE collateral_floors ADD COLUMN virtual_hedge_id TEXT;
ALTER TABLE collateral_floors ADD COLUMN hedge_state TEXT;

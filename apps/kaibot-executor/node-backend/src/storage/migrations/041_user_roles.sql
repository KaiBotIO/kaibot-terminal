-- Account roles (2026-09-25, migration 041). 'admin' is the single operator account that
-- existed before this migration; 'viewer' accounts (created by the admin)
-- only get read routes, see auth/roles.ts.
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'viewer'));

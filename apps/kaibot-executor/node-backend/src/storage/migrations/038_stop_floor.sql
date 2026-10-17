-- Manual stop floor on bot-managed positions (2026-09-23).
--
-- The user can pin a stop under a position the bot manages without taking it
-- over. manual_stop always participates in the venue stop; the engine
-- (server exit updates, roll, ratchet) only improves on it; under
-- trailing_lock the manual value is absolute. engine_stop keeps the bot's own
-- last accepted stop separate from the resting current_stop, so the server's
-- favourable-only check runs against the ENGINE, never against the floor.
ALTER TABLE server_exit_state ADD COLUMN manual_stop REAL;
ALTER TABLE server_exit_state ADD COLUMN trailing_lock INTEGER NOT NULL DEFAULT 0;
ALTER TABLE server_exit_state ADD COLUMN engine_stop REAL;
UPDATE server_exit_state SET engine_stop = current_stop WHERE engine_stop IS NULL;

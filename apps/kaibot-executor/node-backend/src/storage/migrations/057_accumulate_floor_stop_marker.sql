-- Accumulate (migration 057): the part of a floor stop's qty that sits on the
-- manual marker; its fill takes no more than that off the marker.
ALTER TABLE accumulate_plans ADD COLUMN floor_stop_marker_qty REAL;

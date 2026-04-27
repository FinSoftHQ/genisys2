-- Migration: Slice 4 — Event Log (immutable audit trail)
CREATE TABLE IF NOT EXISTS event_log (
  event_id TEXT PRIMARY KEY,
  card_uid TEXT NOT NULL,
  board_uid TEXT,
  timestamp TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('CARD_CREATED','CARD_UPDATED','CARD_MOVED','MOVED','ACTION_TRIGGERED','PROCESSING_STARTED','PROCESSING_COMPLETED','PROCESSING_ERROR','ROLLUP_CHANGED','ADMIN_OVERRIDE','BOARD_RELOAD')),
  category TEXT NOT NULL CHECK (category IN ('routing','lifecycle','user_action','system')),
  lifecycle_event TEXT CHECK (lifecycle_event IN ('PROCESSING_STARTED','PROCESSING_COMPLETED','PROCESSING_ERROR')),
  from_column TEXT,
  to_column TEXT,
  idempotency_key TEXT,
  payload_delta TEXT,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS event_log_card_timestamp_idx ON event_log (card_uid, timestamp);
CREATE INDEX IF NOT EXISTS event_log_board_timestamp_idx ON event_log (board_uid, timestamp);
CREATE INDEX IF NOT EXISTS event_log_category_timestamp_idx ON event_log (category, timestamp);

-- Prevent UPDATE and DELETE on event_log to enforce append-only semantics
CREATE TRIGGER IF NOT EXISTS event_log_prevent_update
BEFORE UPDATE ON event_log
BEGIN
  SELECT RAISE(ABORT, 'event_log is immutable: updates are not allowed');
END;

CREATE TRIGGER IF NOT EXISTS event_log_prevent_delete
BEFORE DELETE ON event_log
BEGIN
  SELECT RAISE(ABORT, 'event_log is immutable: deletes are not allowed');
END;

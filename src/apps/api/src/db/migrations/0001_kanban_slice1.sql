CREATE TABLE IF NOT EXISTS boards (
  uid TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  prefix TEXT NOT NULL UNIQUE,
  schema TEXT NOT NULL,
  permissions TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS board_sequences (
  prefix TEXT PRIMARY KEY,
  seq_value INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cards (
  uid TEXT PRIMARY KEY,
  board_uid TEXT NOT NULL,
  display_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  processing_state TEXT NOT NULL DEFAULT 'IDLE',
  is_editable INTEGER NOT NULL DEFAULT 1,
  payload TEXT NOT NULL DEFAULT '{}',
  current_status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cards_board_uid ON cards(board_uid);
CREATE INDEX IF NOT EXISTS idx_cards_display_id ON cards(display_id);

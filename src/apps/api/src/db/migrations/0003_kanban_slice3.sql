CREATE TABLE IF NOT EXISTS callback_tokens (
  token TEXT PRIMARY KEY,
  card_uid TEXT NOT NULL,
  processor_id TEXT NOT NULL,
  hook TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  context TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (card_uid) REFERENCES cards(uid)
);

CREATE INDEX IF NOT EXISTS idx_callback_tokens_card_uid ON callback_tokens(card_uid);
CREATE INDEX IF NOT EXISTS idx_callback_tokens_expires_at ON callback_tokens(expires_at);

CREATE TABLE IF NOT EXISTS consumed_callback_tokens (
  token TEXT PRIMARY KEY,
  consumed_at TEXT NOT NULL
);

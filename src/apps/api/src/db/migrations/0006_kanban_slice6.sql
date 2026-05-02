-- Migration: Slice 6 — Board Suites / Cross-Board Relationships
CREATE TABLE IF NOT EXISTS board_suites (
  uid TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE boards ADD COLUMN suite_uid TEXT;
ALTER TABLE boards ADD COLUMN role TEXT;

CREATE INDEX IF NOT EXISTS boards_suite_idx ON boards (suite_uid);

ALTER TABLE card_relationships ADD COLUMN parent_board_uid TEXT;
ALTER TABLE card_relationships ADD COLUMN child_board_uid TEXT;

CREATE INDEX IF NOT EXISTS card_relationships_parent_board_idx ON card_relationships (parent_board_uid, parent_card_uid);
CREATE INDEX IF NOT EXISTS card_relationships_child_board_idx ON card_relationships (child_board_uid, child_card_uid);

-- Migration: Slice 5 — Family Tree / Card Relationships
CREATE TABLE IF NOT EXISTS card_relationships (
  parent_card_uid TEXT NOT NULL,
  child_card_uid TEXT NOT NULL,
  relationship_type TEXT NOT NULL DEFAULT 'dependency',
  created_at TEXT NOT NULL,
  PRIMARY KEY (parent_card_uid, child_card_uid),
  FOREIGN KEY (parent_card_uid) REFERENCES cards(uid) ON DELETE CASCADE,
  FOREIGN KEY (child_card_uid) REFERENCES cards(uid) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS card_relationships_parent_idx ON card_relationships (parent_card_uid);
CREATE INDEX IF NOT EXISTS card_relationships_child_idx ON card_relationships (child_card_uid);

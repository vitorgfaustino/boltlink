-- Copyright (c) 2026 Vitor Faustino
-- AGPL-3.0 License — https://github.com/vitorgfaustino/boltlink
-- BoltLink historical migration for advanced features
-- Adds advanced features: link groups and password-protected links

CREATE TABLE IF NOT EXISTS link_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parent_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (parent_id) REFERENCES link_groups(id) ON DELETE SET NULL
);

ALTER TABLE links ADD COLUMN group_id INTEGER;
ALTER TABLE links ADD COLUMN password_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_link_groups_parent_id ON link_groups(parent_id);
CREATE INDEX IF NOT EXISTS idx_links_group_id ON links(group_id);

-- Copyright (c) 2026 Vitor Faustino
-- AGPL-3.0 License — https://github.com/vitorgfaustino/boltlink
-- BoltLink v2.0.0 Migration
-- Privacy-first data minimization: remove event analytics and free-form notes.

DROP TABLE IF EXISTS stats;

ALTER TABLE links RENAME TO links_legacy;

CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  target_url TEXT NOT NULL,
  clicks_total INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  disabled_at TEXT,
  expires_at TEXT,
  go_live_at TEXT,
  redirect_type TEXT NOT NULL DEFAULT '302',
  tags TEXT,
  has_qrcode INTEGER NOT NULL DEFAULT 0,
  group_id INTEGER,
  password_hash TEXT,
  version INTEGER NOT NULL DEFAULT 1
);

INSERT INTO links (
  id,
  slug,
  target_url,
  clicks_total,
  created_at,
  updated_at,
  disabled_at,
  expires_at,
  go_live_at,
  redirect_type,
  tags,
  has_qrcode,
  group_id,
  password_hash,
  version
)
SELECT
  id,
  slug,
  target_url,
  clicks_total,
  created_at,
  updated_at,
  disabled_at,
  expires_at,
  go_live_at,
  redirect_type,
  tags,
  has_qrcode,
  group_id,
  password_hash,
  version
FROM links_legacy;

DROP TABLE links_legacy;

CREATE INDEX IF NOT EXISTS idx_links_slug ON links(slug);
CREATE INDEX IF NOT EXISTS idx_links_created_at ON links(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_links_has_qrcode ON links(has_qrcode);
CREATE INDEX IF NOT EXISTS idx_links_tags ON links(tags);
CREATE INDEX IF NOT EXISTS idx_links_group_id ON links(group_id);

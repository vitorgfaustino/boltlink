-- BoltLink v1.1.0 Phase 3-4 Migration
-- Adds link management features: UTM support, QR codes, expiration, tags, etc.

-- Phase 3: UTM support, QR code flag, redirect type control
ALTER TABLE links ADD COLUMN has_qrcode INTEGER NOT NULL DEFAULT 0;
ALTER TABLE links ADD COLUMN redirect_type TEXT NOT NULL DEFAULT '302';

-- Phase 4: Link expiration and go-live scheduling
ALTER TABLE links ADD COLUMN expires_at TEXT;
ALTER TABLE links ADD COLUMN go_live_at TEXT;

-- Phase 4: Link categorization
ALTER TABLE links ADD COLUMN tags TEXT;

-- Create indexes for new columns
CREATE INDEX IF NOT EXISTS idx_links_has_qrcode ON links(has_qrcode);
CREATE INDEX IF NOT EXISTS idx_links_tags ON links(tags);

-- Copyright (c) 2026 Vitor Faustino
-- AGPL-3.0 License — https://github.com/vitorgfaustino/boltlink
-- BoltLink v2.2.x migration
-- Privacy-first stateless A/B testing: aggregate split counters live on the link row.
--
-- This migration is the authoritative source for the A/B columns. Runtime
-- reconciliation intentionally does NOT pre-create them so the migration
-- history stays executable on installations updated through Wrangler.

-- Remove the pre-migration compatibility projection before touching the table
-- so a stale projection can never make the ALTER TABLE statements fail.
DROP VIEW IF EXISTS boltlink_metric_fence;

ALTER TABLE links ADD COLUMN ab_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE links ADD COLUMN ab_target_url TEXT;
ALTER TABLE links ADD COLUMN ab_weight_b INTEGER NOT NULL DEFAULT 50;
ALTER TABLE links ADD COLUMN ab_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE links ADD COLUMN metric_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE links ADD COLUMN ab_clicks_a INTEGER NOT NULL DEFAULT 0;
ALTER TABLE links ADD COLUMN ab_clicks_b INTEGER NOT NULL DEFAULT 0;
ALTER TABLE links ADD COLUMN ab_started_at TEXT;

-- Runtime creates this projection as a compatibility shim that reports the
-- implicit initial epoch 0 before this migration. Replacing it here keeps a
-- delayed pre-migration click write fenced by the real metric_epoch at the
-- exact moment it executes, so it can never resurrect a reset.
DROP VIEW IF EXISTS boltlink_metric_fence;
CREATE VIEW boltlink_metric_fence AS SELECT id, metric_epoch FROM links;

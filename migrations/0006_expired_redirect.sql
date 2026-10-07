-- Copyright (c) 2026 Vitor Faustino
-- AGPL-3.0 License — https://github.com/vitorgfaustino/boltlink
-- BoltLink v2.2.x migration
-- Expired destination: administrative URL stored for a link that has already
-- elapsed its `expires_at`.
--
-- NULL means no expired destination is configured, which keeps the pre-0006
-- behavior for every existing row. The runtime never creates or alters this
-- column. This migration is the only authority for it.
--
-- Additive only: no default (existing rows stay NULL), no UPDATE, no table
-- rebuild, no auxiliary table and no index.

ALTER TABLE links ADD COLUMN expired_redirect_url TEXT;

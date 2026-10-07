-- Copyright (c) 2026 Vitor Faustino
-- AGPL-3.0 License — https://github.com/vitorgfaustino/boltlink
-- BoltLink v2.2.x migration
-- Smart Routing: ordered administrative rules stored as canonical JSON.
--
-- NULL means Smart Routing is disabled for the link. The runtime never creates
-- or alters this column. This migration is the only authority for it.

ALTER TABLE links ADD COLUMN smart_routing_rules TEXT;

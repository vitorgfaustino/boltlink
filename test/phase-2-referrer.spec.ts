/**
 * Phase 2 Tests: Transparent Referrer Policy
 * BoltLink v1.1.0
 * AGPL-3.0 License — https://github.com/vitorgfaustino/boltlink
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import worker from "../src/index";

const SCHEMA_STATEMENTS = [
	`CREATE TABLE IF NOT EXISTS links (
	  id INTEGER PRIMARY KEY AUTOINCREMENT,
	  slug TEXT NOT NULL UNIQUE,
	  target_url TEXT NOT NULL,
	  clicks_total INTEGER NOT NULL DEFAULT 0,
	  last_clicked_at TEXT,
	  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	  disabled_at TEXT,
	  expires_at TEXT,
	  go_live_at TEXT,
	  redirect_type TEXT NOT NULL DEFAULT '302',
	  tags TEXT,
	  notes TEXT,
	  has_qrcode INTEGER NOT NULL DEFAULT 0,
	  group_id INTEGER,
	  password_hash TEXT,
	  version INTEGER NOT NULL DEFAULT 1
	)`,
	"CREATE INDEX IF NOT EXISTS idx_links_slug ON links(slug)",
	"CREATE INDEX IF NOT EXISTS idx_links_created_at ON links(created_at DESC)",
	"CREATE INDEX IF NOT EXISTS idx_links_has_qrcode ON links(has_qrcode)",
	"CREATE INDEX IF NOT EXISTS idx_links_tags ON links(tags)",
	"CREATE INDEX IF NOT EXISTS idx_links_group_id ON links(group_id)",
	`CREATE TABLE IF NOT EXISTS stats (
	  id INTEGER PRIMARY KEY AUTOINCREMENT,
	  link_id INTEGER,
	  slug_snapshot TEXT NOT NULL,
	  clicked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	  ip_hash TEXT,
	  country TEXT,
	  FOREIGN KEY (link_id) REFERENCES links(id) ON DELETE SET NULL
	)`,
	"CREATE INDEX IF NOT EXISTS idx_stats_link_id_clicked_at ON stats(link_id, clicked_at DESC)",
	"CREATE INDEX IF NOT EXISTS idx_stats_slug_snapshot_clicked_at ON stats(slug_snapshot, clicked_at DESC)",
	`CREATE TABLE IF NOT EXISTS link_groups (
	  id INTEGER PRIMARY KEY AUTOINCREMENT,
	  name TEXT NOT NULL,
	  parent_id INTEGER,
	  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	  FOREIGN KEY (parent_id) REFERENCES link_groups(id) ON DELETE SET NULL
	)`,
	"CREATE INDEX IF NOT EXISTS idx_link_groups_parent_id ON link_groups(parent_id)",
];

async function resetDatabase() {
	for (const statement of SCHEMA_STATEMENTS) {
		await env.db_boltlink.prepare(statement).run();
	}
	await env.db_boltlink.prepare("DELETE FROM stats").run();
	await env.db_boltlink.prepare("DELETE FROM links").run();
}

describe("Phase 2: Transparent Referrer Policy", () => {
	beforeEach(async () => {
		await resetDatabase();
	});

	// --- Test case 1: Redirect 302 public path → should have strict-origin-when-cross-origin
	it("uses strict-origin-when-cross-origin for public redirect (/:slug)", async () => {
		// Create a link first
		await env.db_boltlink
			.prepare(
				`INSERT INTO links (slug, target_url, created_at, updated_at)
			 VALUES (?, ?, datetime('now'), datetime('now'))`
			)
			.bind("phase2-test", "https://destination.example.com")
			.run();

		const request = new Request("https://example.com/phase2-test", {
			headers: {
				"user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/91.0",
			},
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(302);
		expect(response.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
	});

	// --- Test case 2: Admin path → should have no-referrer
	it("uses no-referrer for admin path (/admin)", async () => {
		const request = new Request("http://localhost/admin", {
			headers: {
				"user-agent": "Mozilla/5.0",
			},
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
	});

	// --- Test case 3: Admin.html asset → should have no-referrer
	it("uses no-referrer for admin.html asset", async () => {
		const request = new Request("http://localhost/admin.html", {
			headers: {
				"user-agent": "Mozilla/5.0",
			},
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
	});

	// --- Test case 4: API path /api/links → should have no-referrer
	it("uses no-referrer for API path (/api/links)", async () => {
		const request = new Request("http://localhost/api/links", {
			method: "GET",
			headers: {
				"user-agent": "Mozilla/5.0",
			},
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
	});

	// --- Test case 5: API path /api/links/{slug} → should have no-referrer
	it("uses no-referrer for API path (/api/links/{slug})", async () => {
		const request = new Request("http://localhost/api/links/test-slug", {
			method: "GET",
			headers: {
				"user-agent": "Mozilla/5.0",
			},
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect([200, 404]).toContain(response.status);
		expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
	});

	// --- Test case 6: 404 Not found public path → should have no-referrer (non-redirect)
	it("uses no-referrer for 404 responses", async () => {
		const request = new Request("https://example.com/non-existent-slug", {
			headers: {
				"user-agent": "Mozilla/5.0",
			},
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(404);
		expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
	});

	// --- Test case 7: Landing page / → should have no-referrer (non-redirect public)
	it("uses no-referrer for landing page (/)", async () => {
		const request = new Request("https://example.com/", {
			headers: {
				"user-agent": "Mozilla/5.0",
			},
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
	});

	// --- Test case 8: Health endpoint /healt → should have no-referrer
	it("uses no-referrer for health endpoint (/healt)", async () => {
		const request = new Request("https://example.com/healt", {
			headers: {
				"user-agent": "Mozilla/5.0",
			},
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
	});
});

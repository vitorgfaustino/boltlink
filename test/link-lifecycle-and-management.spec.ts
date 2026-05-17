/**
 * Copyright (c) 2026 Vitor Faustino
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";

const SCHEMA_STATEMENTS = [
	`CREATE TABLE IF NOT EXISTS links (
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
	)`,
	"CREATE INDEX IF NOT EXISTS idx_links_slug ON links(slug)",
	"CREATE INDEX IF NOT EXISTS idx_links_created_at ON links(created_at DESC)",
	"CREATE INDEX IF NOT EXISTS idx_links_has_qrcode ON links(has_qrcode)",
	"CREATE INDEX IF NOT EXISTS idx_links_tags ON links(tags)",
	"CREATE INDEX IF NOT EXISTS idx_links_group_id ON links(group_id)",
	`CREATE TABLE IF NOT EXISTS link_groups (
	  id INTEGER PRIMARY KEY AUTOINCREMENT,
	  name TEXT NOT NULL,
	  parent_id INTEGER,
	  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	  FOREIGN KEY (parent_id) REFERENCES link_groups(id) ON DELETE SET NULL
	)`,
	"CREATE INDEX IF NOT EXISTS idx_link_groups_parent_id ON link_groups(parent_id)",
];

async function fetchWorker(url: string, init?: RequestInit) {
	const request = new Request(url, init);
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

async function resetDatabase() {
	for (const statement of SCHEMA_STATEMENTS) {
		await env.db_boltlink.prepare(statement).run();
	}
	await env.db_boltlink.prepare("DROP TABLE IF EXISTS stats").run();
	await env.db_boltlink.prepare("DELETE FROM links").run();
	await env.db_boltlink.prepare("DELETE FROM link_groups").run();
}

describe("Link lifecycle and management features", () => {
	beforeEach(async () => {
		await resetDatabase();
	});

	it("returns 301 when redirect_type=301", async () => {
		await fetchWorker("http://localhost/api/links", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				slug: "perm-link",
				targetUrl: "https://example.com/permanent",
				redirectType: "301",
			}),
		});

		const response = await fetchWorker("https://example.com/perm-link", {
			headers: { "user-agent": "Mozilla/5.0" },
		});
		expect(response.status).toBe(301);
	});

	it("returns 410 for expired links", async () => {
		const expiredAt = new Date(Date.now() - 60_000).toISOString();
		await fetchWorker("http://localhost/api/links", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				slug: "expired-link",
				targetUrl: "https://example.com/expired",
				expiresAt: expiredAt,
			}),
		});

		const response = await fetchWorker("https://example.com/expired-link", {
			headers: { "user-agent": "Mozilla/5.0" },
		});
		expect(response.status).toBe(410);
	});

	it("returns 404 before go_live_at", async () => {
		const goLiveAt = new Date(Date.now() + 60_000).toISOString();
		await fetchWorker("http://localhost/api/links", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				slug: "future-link",
				targetUrl: "https://example.com/future",
				goLiveAt,
			}),
		});

		const response = await fetchWorker("https://example.com/future-link", {
			headers: { "user-agent": "Mozilla/5.0" },
		});
		expect(response.status).toBe(404);
	});

	it("rejects expiresAt earlier than goLiveAt", async () => {
		const goLiveAt = new Date(Date.now() + 120_000).toISOString();
		const expiresAt = new Date(Date.now() + 60_000).toISOString();
		const response = await fetchWorker("http://localhost/api/links", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				slug: "invalid-window",
				targetUrl: "https://example.com/invalid",
				goLiveAt,
				expiresAt,
			}),
		});
		expect(response.status).toBe(400);
	});

	it("marks link with has_qrcode via API", async () => {
		await fetchWorker("http://localhost/api/links", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ slug: "qr-link", targetUrl: "https://example.com/qr" }),
		});

		const markResponse = await fetchWorker("http://localhost/api/links/qr-link/qrcode", {
			method: "POST",
		});
		expect(markResponse.status).toBe(200);

		const listResponse = await fetchWorker("http://localhost/api/links?has_qrcode=1");
		const listPayload = (await listResponse.json()) as { links: Array<{ slug: string }> };
		expect(listPayload.links.some((link) => link.slug === "qr-link")).toBe(true);
	});

	it("duplicates links with suggested slug", async () => {
		await fetchWorker("http://localhost/api/links", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ slug: "dup-base", targetUrl: "https://example.com/base" }),
		});

		const duplicateResponse = await fetchWorker("http://localhost/api/links/dup-base/duplicate", {
			method: "POST",
		});
		expect(duplicateResponse.status).toBe(201);
		const payload = (await duplicateResponse.json()) as { link: { slug: string } };
		expect(payload.link.slug).toBe("dup-base-2");
	});

	it("creates and lists groups", async () => {
		const createGroupResponse = await fetchWorker("http://localhost/api/groups", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "Campanhas 2026" }),
		});
		expect(createGroupResponse.status).toBe(201);

		const listResponse = await fetchWorker("http://localhost/api/groups");
		const payload = (await listResponse.json()) as { groups: Array<{ name: string }> };
		expect(payload.groups.some((group) => group.name === "Campanhas 2026")).toBe(true);
	});

	it("gates password-protected links", async () => {
		await fetchWorker("http://localhost/api/links", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				slug: "locked-link",
				targetUrl: "https://example.com/locked",
				password: "abc123",
			}),
		});

		const gateResponse = await fetchWorker("https://example.com/locked-link", {
			headers: { "user-agent": "Mozilla/5.0" },
		});
		expect(gateResponse.status).toBe(200);
		expect(await gateResponse.text()).toContain("Link protegido por senha");

		const unlockResponse = await fetchWorker("https://example.com/locked-link", {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				"user-agent": "Mozilla/5.0",
			},
			body: "password=abc123",
		});
		expect(unlockResponse.status).toBe(302);
		expect(unlockResponse.headers.get("Location")).toBe("https://example.com/locked");
		const sessionCookie = unlockResponse.headers.get("Set-Cookie")?.split(";")[0];
		expect(sessionCookie).toContain("boltlink_gate_locked-link=");

		const unlockedResponse = await fetchWorker("https://example.com/locked-link", {
			headers: {
				Cookie: sessionCookie ?? "",
				"user-agent": "Mozilla/5.0",
			},
		});
		expect(unlockedResponse.status).toBe(302);
		expect(unlockedResponse.headers.get("Location")).toBe("https://example.com/locked");
	});
});

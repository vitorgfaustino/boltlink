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
import { resetRateLimitStore } from "../src/rate-limit";
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
	  ab_enabled INTEGER NOT NULL DEFAULT 0,
	  ab_target_url TEXT,
	  ab_weight_b INTEGER NOT NULL DEFAULT 50,

	  ab_generation INTEGER NOT NULL DEFAULT 0,

	  metric_epoch INTEGER NOT NULL DEFAULT 0,
	  ab_clicks_a INTEGER NOT NULL DEFAULT 0,
	  ab_clicks_b INTEGER NOT NULL DEFAULT 0,
	  ab_started_at TEXT,
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

async function fetchWorker(url: string, init?: RequestInit, overrides?: Partial<Env>) {
	const request = new Request(url, init);
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, { ...env, PASSWORD_SESSION_SECRET: "test-secret", ...overrides }, ctx);
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
		resetRateLimitStore();
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

		const postResponse = await fetchWorker("https://example.com/expired-link", {
			method: "POST",
			headers: { "user-agent": "Mozilla/5.0" },
		});
		expect(postResponse.status).toBe(410);
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

		const postResponse = await fetchWorker("https://example.com/future-link", {
			method: "POST",
			headers: { "user-agent": "Mozilla/5.0" },
		});
		expect(postResponse.status).toBe(404);
	});

	it("redirects an active public link after lifecycle validation", async () => {
		await fetchWorker("http://localhost/api/links", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ slug: "active-post", targetUrl: "https://example.com/active" }),
		});

		const response = await fetchWorker("https://example.com/active-post", {
			method: "POST",
			headers: { "user-agent": "Mozilla/5.0" },
		});
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("https://example.com/active");
	});

	it("rejects password protection when PASSWORD_SESSION_SECRET is unavailable", async () => {
		const response = await fetchWorker("http://localhost/api/links", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				slug: "missing-secret",
				targetUrl: "https://example.com/locked",
				password: "abc123",
			}),
		}, { PASSWORD_SESSION_SECRET: undefined });

		expect(response.status).toBe(400);
		expect((await response.json() as { error: string }).error).toContain("PASSWORD_SESSION_SECRET");

		await fetchWorker("http://localhost/api/links", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ slug: "public-update", targetUrl: "https://example.com/public" }),
		});
		const updateResponse = await fetchWorker("http://localhost/api/links/public-update", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ password: "abc123" }),
		}, { PASSWORD_SESSION_SECRET: undefined });
		expect(updateResponse.status).toBe(400);
	});

	it("fails closed for a legacy protected link without PASSWORD_SESSION_SECRET", async () => {
		await fetchWorker("http://localhost/api/links", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				slug: "legacy-secret",
				targetUrl: "https://example.com/locked",
				password: "abc123",
			}),
		});

		const legacyEnv = { PASSWORD_SESSION_SECRET: undefined, API_KEY: "legacy-api-key" };

		const getResponse = await fetchWorker("https://example.com/legacy-secret", {
			headers: { "user-agent": "Mozilla/5.0" },
		}, legacyEnv);
		expect(getResponse.status).toBe(503);
		expect(getResponse.headers.get("Location")).toBeNull();
		expect(getResponse.headers.get("Set-Cookie")).toBeNull();
		expect(await getResponse.text()).not.toContain("https://example.com/locked");

		const postResponse = await fetchWorker("https://example.com/legacy-secret", {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				"user-agent": "Mozilla/5.0",
			},
			body: "password=abc123",
		}, legacyEnv);
		expect(postResponse.status).toBe(503);
		expect(postResponse.headers.get("Location")).toBeNull();
		expect(postResponse.headers.get("Set-Cookie")).toBeNull();
		expect(await postResponse.text()).not.toContain("https://example.com/locked");
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

	it("rejects empty, whitespace and invalid password values on create without creating the link", async () => {
		for (const password of ["", "   ", 123, true, { nested: true }, ["secret"]]) {
			const response = await fetchWorker("http://localhost/api/links", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					slug: "invalid-create",
					targetUrl: "https://example.com/locked",
					password,
				}),
			});
			expect(response.status).toBe(400);
			expect((await response.json() as { error: string }).error).toContain("Invalid password");
		}

		const stored = await env.db_boltlink
			.prepare("SELECT slug FROM links WHERE slug = ?")
			.bind("invalid-create")
			.first<{ slug: string }>();
		expect(stored).toBeNull();
	});

	it("rejects empty, whitespace and invalid password values on PATCH without partial update", async () => {
		await fetchWorker("http://localhost/api/links", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				slug: "guarded-patch",
				targetUrl: "https://example.com/locked",
				redirectType: "301",
				tags: ["keep-me"],
				password: "abc123",
			}),
		});

		const readRow = () =>
			env.db_boltlink
				.prepare(
					"SELECT target_url, redirect_type, tags, group_id, expires_at, go_live_at, password_hash, updated_at, version FROM links WHERE slug = ?",
				)
				.bind("guarded-patch")
				.first<Record<string, unknown>>();

		const before = await readRow();
		expect(before?.password_hash).toBeTruthy();

		for (const password of ["", "   ", 123, false, { admin: true }, ["x"]]) {
			const response = await fetchWorker("http://localhost/api/links/guarded-patch", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ password }),
			});
			expect(response.status).toBe(400);
		}

		const atomicResponse = await fetchWorker("http://localhost/api/links/guarded-patch", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ targetUrl: "https://example.com/hijacked", tags: ["changed"], password: "" }),
		});
		expect(atomicResponse.status).toBe(400);

		const after = await readRow();
		expect(after).toEqual(before);

		const gateResponse = await fetchWorker("https://example.com/guarded-patch", {
			headers: { "user-agent": "Mozilla/5.0" },
		});
		expect(gateResponse.status).toBe(200);
		expect(gateResponse.headers.get("Location")).toBeNull();
		expect(await gateResponse.text()).toContain("Link protegido por senha");
	});

	it("rejects empty, whitespace and invalid password values on PUT without partial update", async () => {
		await fetchWorker("http://localhost/api/links", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				slug: "guarded-put",
				targetUrl: "https://example.com/locked",
				password: "abc123",
			}),
		});

		const readRow = () =>
			env.db_boltlink
				.prepare("SELECT target_url, redirect_type, tags, password_hash, updated_at, version FROM links WHERE slug = ?")
				.bind("guarded-put")
				.first<Record<string, unknown>>();

		const before = await readRow();
		expect(before?.password_hash).toBeTruthy();

		for (const password of ["", "   ", 123, true, { nested: true }, ["x"]]) {
			const response = await fetchWorker("http://localhost/api/links/guarded-put", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ password }),
			});
			expect(response.status).toBe(400);
		}

		const atomicResponse = await fetchWorker("http://localhost/api/links/guarded-put", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ targetUrl: "https://example.com/hijacked", password: "   " }),
		});
		expect(atomicResponse.status).toBe(400);

		const after = await readRow();
		expect(after).toEqual(before);

		const gateResponse = await fetchWorker("https://example.com/guarded-put", {
			headers: { "user-agent": "Mozilla/5.0" },
		});
		expect(gateResponse.status).toBe(200);
		expect(gateResponse.headers.get("Location")).toBeNull();
		expect(await gateResponse.text()).toContain("Link protegido por senha");
	});

	it("removes password only when password is explicitly null", async () => {
		await fetchWorker("http://localhost/api/links", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				slug: "removable",
				targetUrl: "https://example.com/removable",
				password: "abc123",
			}),
		});

		const readHash = () =>
			env.db_boltlink
				.prepare("SELECT password_hash FROM links WHERE slug = ?")
				.bind("removable")
				.first<{ password_hash: string | null }>();

		const originalHash = (await readHash())?.password_hash;
		expect(originalHash).toBeTruthy();

		for (const password of ["", "   ", 123, false, { admin: true }, ["x"]]) {
			const response = await fetchWorker("http://localhost/api/links/removable", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ password }),
			});
			expect(response.status).toBe(400);
		}

		expect((await readHash())?.password_hash).toBe(originalHash);

		const stillProtected = await fetchWorker("https://example.com/removable", {
			headers: { "user-agent": "Mozilla/5.0" },
		});
		expect(stillProtected.status).toBe(200);
		expect(stillProtected.headers.get("Location")).toBeNull();
		expect(await stillProtected.text()).toContain("Link protegido por senha");

		const removeResponse = await fetchWorker("http://localhost/api/links/removable", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ password: null }),
		});
		expect(removeResponse.status).toBe(200);

		expect((await readHash())?.password_hash).toBeNull();

		const anonymousResponse = await fetchWorker("https://example.com/removable", {
			headers: { "user-agent": "Mozilla/5.0" },
		});
		expect(anonymousResponse.status).toBe(302);
		expect(anonymousResponse.headers.get("Location")).toBe("https://example.com/removable");
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

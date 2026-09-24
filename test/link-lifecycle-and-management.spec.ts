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
	  expired_redirect_url TEXT,
	  ab_enabled INTEGER NOT NULL DEFAULT 0,
	  ab_target_url TEXT,
	  ab_weight_b INTEGER NOT NULL DEFAULT 50,

	  ab_generation INTEGER NOT NULL DEFAULT 0,

	  metric_epoch INTEGER NOT NULL DEFAULT 0,
	  ab_clicks_a INTEGER NOT NULL DEFAULT 0,
	  ab_clicks_b INTEGER NOT NULL DEFAULT 0,
	  ab_started_at TEXT,
	  smart_routing_rules TEXT,
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

async function createLink(body: Record<string, unknown>, overrides?: Partial<Env>) {
	return fetchWorker("http://localhost/api/links", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	}, overrides);
}

async function patchLink(slug: string, body: Record<string, unknown>) {
	return fetchWorker(`http://localhost/api/links/${slug}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

/** Requires a database that carries the `expired_redirect_url` column. */
async function readLifecycleRow(slug: string) {
	return env.db_boltlink
		.prepare("SELECT expires_at, expired_redirect_url, version FROM links WHERE slug = ?")
		.bind(slug)
		.first<{ expires_at: string | null; expired_redirect_url: string | null; version: number }>();
}

/** The database as migration 0005 leaves it: no `expired_redirect_url` key. */
const PRE_0006_SCHEMA_STATEMENTS = SCHEMA_STATEMENTS.map((statement) =>
	statement.replace("\t  expired_redirect_url TEXT,\n", ""),
);

type TracedHandle = { handle: D1Database; statements: string[] };

/** A distinct handle identity that records every statement it runs. */
function tracedHandle(db: D1Database): TracedHandle {
	const statements: string[] = [];
	const handle = new Proxy(db, {
		get(target, prop) {
			if (prop !== "prepare") {
				const value = Reflect.get(target, prop);
				return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
			}
			return (sql: string) => {
				statements.push(sql);
				return target.prepare(sql);
			};
		},
	}) as D1Database;
	return { handle, statements };
}

/**
 * One request on a warmed traced handle, reporting only the statements that
 * request ran. Warming matters: the first request on a fresh handle also
 * installs the metric-fence projection, which is not part of the steady-state
 * public read pattern.
 */
async function measuredRequest(url: string, traced: TracedHandle, init?: RequestInit) {
	traced.statements.length = 0;
	const response = await fetchWorker(url, init, { db_boltlink: traced.handle });
	return { response, statements: [...traced.statements] };
}

async function warmTracedHandle(traced: TracedHandle) {
	await fetchWorker("https://example.com/p4-warmup", { headers: { "user-agent": "Mozilla/5.0" } }, { db_boltlink: traced.handle });
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

/**
 * Gate 4.1: the administrative contract of `expiredRedirectUrl`. The public
 * behavior of an expired link is deliberately unchanged here — the destination
 * is stored and validated, but the redirect engine that will consume it belongs
 * to Gate 4.2.
 */
describe("Phase 4: Expired destination lifecycle contracts (Gate 4.1)", () => {
	const DESTINATION = "https://example.com/expired";
	const FUTURE = () => new Date(Date.now() + 3_600_000).toISOString();
	const PAST = () => new Date(Date.now() - 3_600_000).toISOString();

	beforeEach(async () => {
		await resetDatabase();
		resetRateLimitStore();
	});

	it("creates a link without the field and stores NULL", async () => {
		const response = await createLink({ slug: "ed-absent", targetUrl: "https://example.com/absent" });
		expect(response.status).toBe(201);

		const payload = (await response.json()) as { link: { expiredRedirectUrl: unknown } };
		expect(payload.link.expiredRedirectUrl).toBeNull();
		expect((await readLifecycleRow("ed-absent"))?.expired_redirect_url).toBeNull();
	});

	it("treats an explicit null as no destination", async () => {
		const response = await createLink({
			slug: "ed-null",
			targetUrl: "https://example.com/null",
			expiresAt: FUTURE(),
			expiredRedirectUrl: null,
		});
		expect(response.status).toBe(201);

		const payload = (await response.json()) as { link: { expiredRedirectUrl: unknown } };
		expect(payload.link.expiredRedirectUrl).toBeNull();
		expect((await readLifecycleRow("ed-null"))?.expired_redirect_url).toBeNull();
	});

	it("stores a valid destination together with an expiration", async () => {
		const expiresAt = FUTURE();
		const response = await createLink({
			slug: "ed-valid",
			targetUrl: "https://example.com/valid",
			expiresAt,
			expiredRedirectUrl: DESTINATION,
		});
		expect(response.status).toBe(201);

		const payload = (await response.json()) as { link: { expiredRedirectUrl: unknown } };
		expect(payload.link.expiredRedirectUrl).toBe(DESTINATION);

		const stored = await readLifecycleRow("ed-valid");
		expect(stored?.expired_redirect_url).toBe(DESTINATION);
		expect(stored?.expires_at).toBe(expiresAt);

		// The canonical form produced by the shared URL policy is what is stored.
		const canonical = await createLink({
			slug: "ed-canonical",
			targetUrl: "https://example.com/canonical",
			expiresAt: FUTURE(),
			expiredRedirectUrl: "https://example.com",
		});
		expect(canonical.status).toBe(201);
		expect((await readLifecycleRow("ed-canonical"))?.expired_redirect_url).toBe("https://example.com/");

		const listResponse = await fetchWorker("http://localhost/api/links");
		const listPayload = (await listResponse.json()) as { links: Array<{ slug: string; expiredRedirectUrl: unknown }> };
		expect(listPayload.links.find((link) => link.slug === "ed-valid")?.expiredRedirectUrl).toBe(DESTINATION);
		expect(listPayload.links.find((link) => link.slug === "ed-canonical")?.expiredRedirectUrl).toBe("https://example.com/");
	});

	it("rejects a destination on a link without an expiration", async () => {
		const absent = await createLink({ slug: "ed-dormant", targetUrl: "https://example.com/dormant", expiredRedirectUrl: DESTINATION });
		expect(absent.status).toBe(400);
		expect(((await absent.json()) as { error: string }).error).toContain("expiresAt");

		const cleared = await createLink({
			slug: "ed-dormant",
			targetUrl: "https://example.com/dormant",
			expiresAt: null,
			expiredRedirectUrl: DESTINATION,
		});
		expect(cleared.status).toBe(400);
		expect(((await cleared.json()) as { error: string }).error).toContain("expiresAt");

		expect(await readLifecycleRow("ed-dormant")).toBeNull();
	});

	it("rejects empty, wrong-type, relative and non-http destinations", async () => {
		const rejected: unknown[] = ["", "   ", 12, true, { url: DESTINATION }, [DESTINATION], "javascript:alert(1)", "data:text/html,<b>x</b>", "/relative", "example.com/no-scheme"];
		for (const expiredRedirectUrl of rejected) {
			const response = await createLink({
				slug: "ed-invalid",
				targetUrl: "https://example.com/invalid",
				expiresAt: FUTURE(),
				expiredRedirectUrl,
			});
			expect(response.status).toBe(400);
			const body = await response.text();
			expect(body).toContain("Invalid expiredRedirectUrl");
			expect(body).not.toContain("javascript");
			expect(body).not.toContain("no such column");
		}

		expect(await readLifecycleRow("ed-invalid")).toBeNull();
	});

	it("preserves the destination on an unrelated patch", async () => {
		const expiresAt = FUTURE();
		await createLink({ slug: "ed-preserve", targetUrl: "https://example.com/preserve", expiresAt, expiredRedirectUrl: DESTINATION });
		const before = await readLifecycleRow("ed-preserve");

		const response = await patchLink("ed-preserve", { tags: ["editada"] });
		expect(response.status).toBe(200);

		const payload = (await response.json()) as { link: { expiredRedirectUrl: unknown } };
		expect(payload.link.expiredRedirectUrl).toBe(DESTINATION);

		const after = await readLifecycleRow("ed-preserve");
		expect(after?.expired_redirect_url).toBe(before?.expired_redirect_url);
		expect(after?.expires_at).toBe(before?.expires_at);
		expect(after?.version).toBe((before?.version ?? 0) + 1);
	});

	it("clears the destination with an explicit null and replaces it with a valid URL", async () => {
		const expiresAt = FUTURE();
		await createLink({ slug: "ed-replace", targetUrl: "https://example.com/replace", expiresAt, expiredRedirectUrl: DESTINATION });

		const replacement = "https://example.com/outro-destino";
		const replaced = await patchLink("ed-replace", { expiredRedirectUrl: replacement });
		expect(replaced.status).toBe(200);
		expect((await readLifecycleRow("ed-replace"))?.expired_redirect_url).toBe(replacement);

		const cleared = await patchLink("ed-replace", { expiredRedirectUrl: null });
		expect(cleared.status).toBe(200);
		const payload = (await cleared.json()) as { link: { expiredRedirectUrl: unknown } };
		expect(payload.link.expiredRedirectUrl).toBeNull();

		const after = await readLifecycleRow("ed-replace");
		expect(after?.expired_redirect_url).toBeNull();
		expect(after?.expires_at).toBe(expiresAt);
	});

	it("rejects an invalid destination on PATCH without changing the row or its version", async () => {
		const expiresAt = FUTURE();
		await createLink({ slug: "ed-reject", targetUrl: "https://example.com/reject", expiresAt, expiredRedirectUrl: DESTINATION });
		const before = await readLifecycleRow("ed-reject");

		for (const expiredRedirectUrl of ["javascript:alert(1)", "", 7, { nested: true }]) {
			const response = await patchLink("ed-reject", { tags: ["nao-deve-persistir"], expiredRedirectUrl });
			expect(response.status).toBe(400);
		}

		const after = await readLifecycleRow("ed-reject");
		expect(after).toEqual(before);
	});

	it("refuses to clear expiresAt while a destination is still stored", async () => {
		const expiresAt = FUTURE();
		await createLink({ slug: "ed-window", targetUrl: "https://example.com/window", expiresAt, expiredRedirectUrl: DESTINATION });
		const before = await readLifecycleRow("ed-window");

		const response = await patchLink("ed-window", { expiresAt: null });
		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: string }).error).toContain("expiresAt");

		const after = await readLifecycleRow("ed-window");
		expect(after).toEqual(before);
		expect(after?.expires_at).toBe(expiresAt);
	});

	it("clears expiration and destination atomically in one request", async () => {
		await createLink({ slug: "ed-atomic-clear", targetUrl: "https://example.com/atomic", expiresAt: FUTURE(), expiredRedirectUrl: DESTINATION });

		const response = await patchLink("ed-atomic-clear", { expiresAt: null, expiredRedirectUrl: null });
		expect(response.status).toBe(200);

		const after = await readLifecycleRow("ed-atomic-clear");
		expect(after?.expires_at).toBeNull();
		expect(after?.expired_redirect_url).toBeNull();
	});

	it("sets expiration and destination atomically in one request", async () => {
		await createLink({ slug: "ed-atomic-set", targetUrl: "https://example.com/atomic-set" });
		expect((await readLifecycleRow("ed-atomic-set"))?.expires_at).toBeNull();

		const expiresAt = FUTURE();
		const response = await patchLink("ed-atomic-set", { expiresAt, expiredRedirectUrl: DESTINATION });
		expect(response.status).toBe(200);

		const after = await readLifecycleRow("ed-atomic-set");
		expect(after?.expires_at).toBe(expiresAt);
		expect(after?.expired_redirect_url).toBe(DESTINATION);
	});

	it("duplicates without copying the expiration or the destination", async () => {
		const expiresAt = FUTURE();
		await createLink({ slug: "ed-dup", targetUrl: "https://example.com/dup", expiresAt, expiredRedirectUrl: DESTINATION });
		const sourceBefore = await readLifecycleRow("ed-dup");

		const response = await fetchWorker("http://localhost/api/links/ed-dup/duplicate", { method: "POST" });
		expect(response.status).toBe(201);

		const payload = (await response.json()) as { link: { slug: string; expiredRedirectUrl: unknown } };
		expect(payload.link.slug).toBe("ed-dup-2");
		expect(payload.link.expiredRedirectUrl).toBeNull();

		const duplicate = await readLifecycleRow("ed-dup-2");
		expect(duplicate?.expires_at).toBeNull();
		expect(duplicate?.expired_redirect_url).toBeNull();

		// The source keeps both values and its version.
		expect(await readLifecycleRow("ed-dup")).toEqual(sourceBefore);
	});

	it("resets clicks without touching the expiration or the destination", async () => {
		const expiresAt = FUTURE();
		await createLink({ slug: "ed-reset", targetUrl: "https://example.com/reset", expiresAt, expiredRedirectUrl: DESTINATION });
		await env.db_boltlink
			.prepare("UPDATE links SET clicks_total = 9, ab_clicks_a = 4, ab_clicks_b = 5 WHERE slug = ?")
			.bind("ed-reset")
			.run();
		const before = await readLifecycleRow("ed-reset");

		const response = await fetchWorker("http://localhost/api/links/ed-reset/reset-clicks", { method: "POST" });
		expect(response.status).toBe(200);

		const counters = await env.db_boltlink
			.prepare("SELECT clicks_total, ab_clicks_a, ab_clicks_b FROM links WHERE slug = ?")
			.bind("ed-reset")
			.first<{ clicks_total: number; ab_clicks_a: number; ab_clicks_b: number }>();
		expect(counters).toMatchObject({ clicks_total: 0, ab_clicks_a: 0, ab_clicks_b: 0 });

		const after = await readLifecycleRow("ed-reset");
		expect(after?.expires_at).toBe(expiresAt);
		expect(after?.expired_redirect_url).toBe(DESTINATION);
		expect(after?.version).toBe((before?.version ?? 0) + 1);
	});

	it("hands the filled destination over to the expired lifecycle", async () => {
		// Gate 4.1 only proved that the column was administratively usable and left
		// the public answer at 410. Gate 4.2 owns that answer now, so this assertion
		// pins the hand-off; the full public matrix lives in the Gate 4.2 block.
		await createLink({ slug: "ed-public", targetUrl: "https://example.com/public", expiresAt: PAST(), expiredRedirectUrl: DESTINATION });
		expect((await readLifecycleRow("ed-public"))?.expired_redirect_url).toBe(DESTINATION);

		const getResponse = await fetchWorker("https://example.com/ed-public", { headers: { "user-agent": "Mozilla/5.0" } });
		expect(getResponse.status).toBe(302);
		expect(getResponse.headers.get("Location")).toBe(DESTINATION);

		const postResponse = await fetchWorker("https://example.com/ed-public", {
			method: "POST",
			headers: { "user-agent": "Mozilla/5.0" },
		});
		expect(postResponse.status).toBe(302);
		expect(postResponse.headers.get("Location")).toBe(DESTINATION);
	});
});

/**
 * Gate 4.2: the public behavior of an expired link. Everything below observes
 * only the public redirect — the administrative contract of the stored value is
 * Gate 4.1's, and the migration boundary belongs to expired-redirect-migration.
 */
describe("Phase 4: Expired lifecycle public behavior (Gate 4.2)", () => {
	const DESTINATION = "https://example.com/expired-destination";
	const TARGET = "https://example.com/target";
	const PAST = () => new Date(Date.now() - 3_600_000).toISOString();
	const FUTURE = () => new Date(Date.now() + 3_600_000).toISOString();
	const HUMAN_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
	const BOT_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
	const NAVIGATION = { "user-agent": HUMAN_UA, "sec-fetch-mode": "navigate" };

	/** The public GET and POST, the two handles that must answer identically. */
	const HANDLES: Array<[string, RequestInit]> = [
		["GET", { headers: NAVIGATION }],
		["POST", { method: "POST", headers: NAVIGATION }],
	];

	beforeEach(async () => {
		await resetDatabase();
		resetRateLimitStore();
	});

	/** Everything a public redirect could mutate, read straight from the row. */
	async function publicRowState(slug: string) {
		return env.db_boltlink
			.prepare("SELECT clicks_total, ab_clicks_a, ab_clicks_b, ab_generation, metric_epoch, redirect_type, version FROM links WHERE slug = ?")
			.bind(slug)
			.first<Record<string, unknown>>();
	}

	/** Direct write, the way a manual `UPDATE` would leave the column. */
	async function setPersistedDestination(slug: string, value: string | number | null) {
		await env.db_boltlink.prepare("UPDATE links SET expired_redirect_url = ? WHERE slug = ?").bind(value, slug).run();
	}

	/** Every statement that is not the single public `SELECT`. */
	function writes(statements: string[]) {
		return statements.filter((sql) => !sql.trimStart().toUpperCase().startsWith("SELECT"));
	}

	async function expiredRedirectLocation(slug: string) {
		const response = await fetchWorker(`https://example.com/${slug}`, { headers: NAVIGATION });
		expect(response.status).toBe(302);
		return response.headers.get("Location");
	}

	it("answers 410 no-store without a destination on GET and POST", async () => {
		await createLink({ slug: "p42-gone", targetUrl: TARGET, expiresAt: PAST() });

		const traced = tracedHandle(env.db_boltlink);
		await warmTracedHandle(traced);

		for (const [handle, init] of HANDLES) {
			const { response, statements } = await measuredRequest("https://example.com/p42-gone", traced, init);
			expect(response.status, handle).toBe(410);
			expect(await response.text()).toBe("Link expired");
			expect(response.headers.get("Location")).toBeNull();
			expect(response.headers.get("Cache-Control")).toBe("no-store");
			// A 410 is not a redirect, so it keeps the existing non-redirect policy.
			expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
			expect(writes(statements)).toEqual([]);
		}

		expect(await publicRowState("p42-gone")).toMatchObject({ clicks_total: 0, ab_clicks_a: 0, ab_clicks_b: 0, version: 1 });
	});

	it("redirects 302 + no-store to the destination and ignores redirect_type=301", async () => {
		await createLink({
			slug: "p42-redirect",
			targetUrl: TARGET,
			redirectType: "301",
			expiresAt: PAST(),
			expiredRedirectUrl: DESTINATION,
		});

		const traced = tracedHandle(env.db_boltlink);
		await warmTracedHandle(traced);

		for (const [handle, init] of HANDLES) {
			const { response, statements } = await measuredRequest("https://example.com/p42-redirect", traced, init);
			expect(response.status, handle).toBe(302);
			expect(response.headers.get("Location")).toBe(DESTINATION);
			expect(response.headers.get("Cache-Control")).toBe("no-store");
			// A public redirect keeps the existing redirect policy.
			expect(response.headers.get("Referrer-Policy")).toBe("strict-origin");
			expect(writes(statements)).toEqual([]);
		}

		// The stored `redirect_type` is the main destination's, and is not rewritten.
		expect(await publicRowState("p42-redirect")).toMatchObject({ redirect_type: "301", clicks_total: 0, version: 1 });
	});

	it("keeps the canonical stored form in Location", async () => {
		await createLink({ slug: "p42-canonical", targetUrl: TARGET, expiresAt: PAST() });
		expect((await patchLink("p42-canonical", { expiredRedirectUrl: "https://example.com" })).status).toBe(200);

		expect(await expiredRedirectLocation("p42-canonical")).toBe("https://example.com/");
	});

	it("expiration wins over the password gate and creates no session", async () => {
		await createLink({
			slug: "p42-password",
			targetUrl: TARGET,
			password: "abc123",
			expiresAt: PAST(),
			expiredRedirectUrl: DESTINATION,
		});
		await createLink({ slug: "p42-password-gone", targetUrl: TARGET, password: "abc123", expiresAt: PAST() });

		const gate = await fetchWorker("https://example.com/p42-password", { headers: NAVIGATION });
		expect(gate.status).toBe(302);
		expect(gate.headers.get("Location")).toBe(DESTINATION);
		expect(gate.headers.get("Set-Cookie")).toBeNull();
		expect(await gate.text()).not.toContain("Link protegido");

		// Neither a wrong nor a correct password is ever verified, so no attempt is
		// consumed and no cookie is issued on the way to the expired destination.
		for (const password of ["errada", "abc123"]) {
			const submission = await fetchWorker("https://example.com/p42-password", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded", ...NAVIGATION },
				body: `password=${password}`,
			});
			expect(submission.status).toBe(302);
			expect(submission.headers.get("Location")).toBe(DESTINATION);
			expect(submission.headers.get("Set-Cookie")).toBeNull();
		}

		// Without a destination the gate is not shown either.
		const gone = await fetchWorker("https://example.com/p42-password-gone", { headers: NAVIGATION });
		expect(gone.status).toBe(410);
		expect(gone.headers.get("Cache-Control")).toBe("no-store");
		expect(gone.headers.get("Set-Cookie")).toBeNull();
		expect(await gone.text()).not.toContain("Link protegido");
	});

	it("expiration wins over A/B without touching a counter", async () => {
		await createLink({
			slug: "p42-ab",
			targetUrl: TARGET,
			abEnabled: true,
			abTargetUrl: "https://example.com/variant-b",
			abWeightB: 99,
			expiresAt: PAST(),
			expiredRedirectUrl: DESTINATION,
		});

		const before = await publicRowState("p42-ab");
		// Weight 99 would send almost every roll to variant B, so a single stable
		// destination across repeats is what proves the RNG never runs.
		for (let attempt = 0; attempt < 5; attempt += 1) {
			expect(await expiredRedirectLocation("p42-ab")).toBe(DESTINATION);
		}

		expect(await publicRowState("p42-ab")).toEqual(before);
	});

	it("expiration wins over Smart Routing without parsing the persisted rules", async () => {
		await createLink({ slug: "p42-smart", targetUrl: TARGET, expiresAt: PAST(), expiredRedirectUrl: DESTINATION });
		expect((await patchLink("p42-smart", { smartRoutingRules: [{ country: "BR", url: "https://example.com/br" }] })).status).toBe(200);

		const traced = tracedHandle(env.db_boltlink);
		await warmTracedHandle(traced);
		const before = await publicRowState("p42-smart");

		// A matching rule exists, yet the expired destination wins over the country
		// classifier and the rule selection.
		const matched = await measuredRequest("https://example.com/p42-smart", traced, {
			headers: NAVIGATION,
			cf: { country: "BR" },
		} as RequestInit);
		expect(matched.response.status).toBe(302);
		expect(matched.response.headers.get("Location")).toBe(DESTINATION);
		expect(matched.response.headers.get("Cache-Control")).toBe("no-store");
		expect(writes(matched.statements)).toEqual([]);

		// Corruption that only a working parser could interpret: the answer cannot
		// come from the rules, because reading them would fail safe to the target.
		await env.db_boltlink
			.prepare("UPDATE links SET smart_routing_rules = ? WHERE slug = ?")
			.bind("{{{ not json", "p42-smart")
			.run();

		const corrupted = await measuredRequest("https://example.com/p42-smart", traced, { headers: NAVIGATION });
		expect(corrupted.response.status).toBe(302);
		expect(corrupted.response.headers.get("Location")).toBe(DESTINATION);
		expect(writes(corrupted.statements)).toEqual([]);
		expect(await publicRowState("p42-smart")).toEqual(before);

		// Regression: the existing Smart fail-safe is untouched for a live link.
		await createLink({ slug: "p42-smart-live", targetUrl: TARGET });
		await env.db_boltlink
			.prepare("UPDATE links SET smart_routing_rules = ? WHERE slug = ?")
			.bind("{{{ not json", "p42-smart-live")
			.run();

		const live = await fetchWorker("https://example.com/p42-smart-live", { headers: NAVIGATION });
		expect(live.status).toBe(302);
		expect(live.headers.get("Location")).toBe(TARGET);
		expect(live.headers.get("Cache-Control")).toBe("no-store");
	});

	it("answers the same lifecycle for humans, bots and previews without writing", async () => {
		await createLink({ slug: "p42-agents", targetUrl: TARGET, expiresAt: PAST(), expiredRedirectUrl: DESTINATION });
		const before = await publicRowState("p42-agents");

		// A countable navigation, a crawler and a prefetch all get the same answer:
		// the lifecycle does not depend on the click classification.
		const agents: RequestInit[] = [
			{ headers: NAVIGATION },
			{ headers: { "user-agent": BOT_UA, "sec-fetch-mode": "navigate" } },
			{ headers: { "user-agent": HUMAN_UA, purpose: "prefetch" } },
		];

		for (const init of agents) {
			const response = await fetchWorker("https://example.com/p42-agents", init);
			expect(response.status).toBe(302);
			expect(response.headers.get("Location")).toBe(DESTINATION);
			expect(response.headers.get("Cache-Control")).toBe("no-store");
		}

		expect(await publicRowState("p42-agents")).toEqual(before);
	});

	it("fails closed to 410 no-store for a malformed persisted destination", async () => {
		await createLink({ slug: "p42-malformed", targetUrl: TARGET, expiresAt: PAST(), expiredRedirectUrl: DESTINATION });

		const traced = tracedHandle(env.db_boltlink);
		await warmTracedHandle(traced);

		for (const value of ["javascript:alert(1)", "data:text/html,<script>x</script>", "ftp://example.com/file", "/relative-path", "not a url", "", "   ", 42]) {
			await setPersistedDestination("p42-malformed", value);

			for (const [handle, init] of HANDLES) {
				const { response, statements } = await measuredRequest("https://example.com/p42-malformed", traced, init);
				expect(response.status, handle).toBe(410);
				expect(response.headers.get("Location")).toBeNull();
				expect(response.headers.get("Cache-Control")).toBe("no-store");
				// The raw configuration is never echoed, and the fallback is never the
				// main target.
				expect(await response.text()).toBe("Link expired");
				expect(writes(statements)).toEqual([]);
			}
		}
	});

	it("fails closed to 410 when the destination loops back to the current slug", async () => {
		await createLink({ slug: "p42-loop", targetUrl: TARGET, expiresAt: PAST(), expiredRedirectUrl: DESTINATION });

		const traced = tracedHandle(env.db_boltlink);
		await warmTracedHandle(traced);

		// Query string and fragment do not break the loop, so they cannot be used to
		// smuggle a self-redirect past the guard.
		for (const loop of [
			"https://example.com/p42-loop",
			"https://example.com/p42-loop?x=1",
			"https://example.com/p42-loop#expired",
		]) {
			await setPersistedDestination("p42-loop", loop);

			for (const [handle, init] of HANDLES) {
				const { response, statements } = await measuredRequest("https://example.com/p42-loop", traced, init);
				expect(response.status, handle).toBe(410);
				expect(response.headers.get("Location")).toBeNull();
				expect(response.headers.get("Cache-Control")).toBe("no-store");
				expect(writes(statements)).toEqual([]);
			}
		}
	});

	it("does not block another path on the same origin or the same path on another origin", async () => {
		await createLink({ slug: "p42-path", targetUrl: TARGET, expiresAt: PAST(), expiredRedirectUrl: DESTINATION });
		await createLink({ slug: "p42-origin", targetUrl: TARGET, expiresAt: PAST(), expiredRedirectUrl: DESTINATION });

		await setPersistedDestination("p42-path", "https://example.com/other");
		expect(await expiredRedirectLocation("p42-path")).toBe("https://example.com/other");

		// A cross-link chain is not a self-loop: detecting it would need a second
		// query or a traversal, which this path must not do.
		await setPersistedDestination("p42-origin", "https://other.example/p42-origin");
		expect(await expiredRedirectLocation("p42-origin")).toBe("https://other.example/p42-origin");
	});

	it("ignores the stored destination while the link has not expired, including at the boundary", async () => {
		await createLink({
			slug: "p42-active",
			targetUrl: TARGET,
			redirectType: "301",
			expiresAt: FUTURE(),
			expiredRedirectUrl: DESTINATION,
		});

		const active = await fetchWorker("https://example.com/p42-active", { headers: NAVIGATION });
		expect(active.status).toBe(301);
		expect(active.headers.get("Location")).toBe(TARGET);
		expect(active.headers.get("Cache-Control")).toBeNull();
		expect(await publicRowState("p42-active")).toMatchObject({ clicks_total: 1 });

		// `expires_at <= now` keeps its exact boundary: the instant of expiry is
		// already the expired lifecycle.
		await env.db_boltlink.prepare("UPDATE links SET expires_at = ? WHERE slug = ?").bind(new Date().toISOString(), "p42-active").run();
		expect(await expiredRedirectLocation("p42-active")).toBe(DESTINATION);
	});

	it("keeps 404 for a future link that stores an expired destination", async () => {
		await createLink({
			slug: "p42-future",
			targetUrl: TARGET,
			goLiveAt: FUTURE(),
			expiresAt: new Date(Date.now() + 7_200_000).toISOString(),
			expiredRedirectUrl: DESTINATION,
		});

		const response = await fetchWorker("https://example.com/p42-future", { headers: NAVIGATION });
		expect(response.status).toBe(404);
		expect(response.headers.get("Location")).toBeNull();
		expect(response.headers.get("Cache-Control")).toBeNull();
	});

	it("answers 410 no-store for an expired link on a pre-0006 database and redirects the rest", async () => {
		try {
			await env.db_boltlink.prepare("DROP TABLE links").run();
			for (const statement of PRE_0006_SCHEMA_STATEMENTS) {
				await env.db_boltlink.prepare(statement).run();
			}

			// A fresh handle identity models a Worker that never saw migration 0006:
			// the administrative capability caches are per handle and positive-only,
			// and the public path does not consult them at all.
			const traced = tracedHandle(env.db_boltlink);
			await warmTracedHandle(traced);

			expect((await createLink({ slug: "p42-old-expired", targetUrl: TARGET, expiresAt: PAST() }, { db_boltlink: traced.handle })).status).toBe(201);
			expect((await createLink({ slug: "p42-old-normal", targetUrl: TARGET }, { db_boltlink: traced.handle })).status).toBe(201);

			for (const [handle, init] of HANDLES) {
				const { response, statements } = await measuredRequest("https://example.com/p42-old-expired", traced, init);
				expect(response.status, handle).toBe(410);
				expect(response.headers.get("Cache-Control")).toBe("no-store");
				expect(response.headers.get("Location")).toBeNull();
				// The row shape alone answers the schema question: no probe, no column
				// name in SQL, no write.
				expect(statements.some((sql) => sql.includes("PRAGMA"))).toBe(false);
				expect(statements.some((sql) => sql.includes("expired_redirect_url"))).toBe(false);
				expect(writes(statements)).toEqual([]);
			}

			const normal = await measuredRequest("https://example.com/p42-old-normal", traced, { headers: NAVIGATION });
			expect(normal.response.status).toBe(302);
			expect(normal.response.headers.get("Location")).toBe(TARGET);
		} finally {
			// The next `beforeEach` recreates the table from the full schema.
			await env.db_boltlink.prepare("DROP TABLE links").run();
		}
	});
});

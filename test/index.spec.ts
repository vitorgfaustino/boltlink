/*
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
 *
 * ---
 * DISCLAIMER / ISENÇÃO DE RESPONSABILIDADE:
 * This software is provided "as is", without warranty of any kind.
 * Vitor Faustino (vitorfaustino.com.br) is not liable for any damages, 
 * losses, or inaccurate results arising from the use of this software.
 * 
 * Este software é fornecido "como está", sem garantias de qualquer tipo.
 * Vitor Faustino (vitorfaustino.com.br) não se responsabiliza por quaisquer
 * danos, perdas ou resultados imprecisos decorrentes do uso deste software.
 */

import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimitStore } from "../src/rate-limit";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

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
	)` ,
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
	)` ,
	"CREATE INDEX IF NOT EXISTS idx_link_groups_parent_id ON link_groups(parent_id)",
];

async function fetchWorker(url: string, init?: RequestInit, overrides?: Partial<Env>) {
	const request = new Request(url, init);
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, { ...env, ...overrides }, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

function passThrough(target: object, prop: string | symbol) {
	const value = Reflect.get(target, prop);
	return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
}

function cloneDbHandle(db: D1Database): D1Database {
	return new Proxy(db, {
		get(target, prop) {
			return passThrough(target, prop);
		},
	}) as D1Database;
}

/**
 * A distinct handle identity that records every statement it executes. Used to
 * prove a request path performs no database work at all, which a status-code
 * assertion alone cannot show.
 */
function recordingDbHandle(db: D1Database): { handle: D1Database; statements: string[] } {
	const statements: string[] = [];
	const handle = new Proxy(db, {
		get(target, prop) {
			if (prop !== "prepare") {
				return passThrough(target, prop);
			}
			return (sql: string) => {
				statements.push(sql);
				return target.prepare(sql);
			};
		},
	}) as D1Database;
	return { handle, statements };
}

async function resetDatabase() {
	for (const statement of SCHEMA_STATEMENTS) {
		await env.db_boltlink.prepare(statement).run();
	}
	await env.db_boltlink.prepare("DROP TABLE IF EXISTS stats").run();
	await env.db_boltlink.prepare("DELETE FROM links").run();
}

async function dropDatabase() {
	await env.db_boltlink.prepare("DROP VIEW IF EXISTS boltlink_metric_fence").run();
	await env.db_boltlink.prepare("DROP TABLE IF EXISTS link_groups").run();
	await env.db_boltlink.prepare("DROP TABLE IF EXISTS stats").run();
	await env.db_boltlink.prepare("DROP TABLE IF EXISTS links").run();
}

beforeEach(async () => {
	await resetDatabase();
	resetRateLimitStore();
});
afterEach(() => vi.useRealTimers());

describe("URL shortener worker", () => {
	it("serves a public landing page at the root path", async () => {
		const response = await fetchWorker("https://example.com/");
		const body = await response.text();

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");
		expect(body).toContain('href="/admin"');
		expect(body).toContain('BoltLink');
		expect(body).toContain('v3.2.1');
	});

	it("serves health data on the /healt alias", async () => {
		const response = await fetchWorker("https://example.com/healt");

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(await response.json()).toEqual({ ok: true, service: "boltlink" });
	});

	it("exposes the current app version", async () => {
		const response = await fetchWorker("https://example.com/version");

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(await response.json()).toEqual({ version: "3.2.1", timezone: "America/Sao_Paulo" });
	});

	it("serves the admin UI for localhost requests", async () => {
		const response = await fetchWorker("http://localhost/admin");

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");
		expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.text()).toContain('id="link-form"');
	});

	it("fails closed when the database schema was not initialized by migrations", async () => {
		await dropDatabase();
		const handle = cloneDbHandle(env.db_boltlink);

		const response = await fetchWorker(
			"http://localhost/api/links",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					slug: "first-run",
					targetUrl: "https://destination.example.com/first-run",
				}),
			},
			{ db_boltlink: handle },
		);

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: "Database schema is not initialized" });

		const linksTable = await env.db_boltlink
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'links'")
			.first<{ name: string }>();
		expect(linksTable).toBeNull();
	});

	it("reserves fixed public routes without consuming normal slugs", async () => {
		for (const slug of ["version", "privacidade", "admin", "api", "health"]) {
			const response = await fetchWorker("http://localhost/api/links", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ slug, targetUrl: "https://destination.example.com/reserved" }),
			});
			expect(response.status).toBe(400);
		}

		const normalResponse = await fetchWorker("http://localhost/api/links", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ slug: "normal-link", targetUrl: "https://destination.example.com/normal" }),
		});
		expect(normalResponse.status).toBe(201);
	});

	it("creates and lists active links", async () => {
		const createResponse = await fetchWorker("http://localhost/api/links", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				slug: "promo-q2",
				targetUrl: "https://destination.example.com/landing",
			}),
		});

		expect(createResponse.status).toBe(201);
		const createdPayload = (await createResponse.json()) as { link: { slug: string } };
		expect(createdPayload.link.slug).toBe("promo-q2");

		await fetchWorker("http://localhost/api/links", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				slug: "docs-team",
				targetUrl: "https://docs.example.com/overview",
			}),
		});

		const listResponse = await fetchWorker("http://localhost/api/links");

		expect(listResponse.status).toBe(200);
		const listPayload = (await listResponse.json()) as {
			links: Array<{ slug: string; clicks_total: number; target_url: string }>;
		};
		expect(listPayload.links).toHaveLength(2);
		expect(listPayload.links).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					slug: "docs-team",
					clicks_total: 0,
					target_url: "https://docs.example.com/overview",
				}),
				expect.objectContaining({
					slug: "promo-q2",
					clicks_total: 0,
					target_url: "https://destination.example.com/landing",
				}),
			]),
		);

		const searchBySlug = await fetchWorker("http://localhost/api/links?search=promo");
		const slugSearchPayload = (await searchBySlug.json()) as {
			links: Array<{ slug: string; target_url: string }>;
		};
		expect(slugSearchPayload.links).toHaveLength(1);
		expect(slugSearchPayload.links[0]).toMatchObject({
			slug: "promo-q2",
		});

		const searchByUrl = await fetchWorker("http://localhost/api/links?search=overview");
		const urlSearchPayload = (await searchByUrl.json()) as {
			links: Array<{ slug: string; target_url: string }>;
		};
		expect(urlSearchPayload.links).toHaveLength(1);
		expect(urlSearchPayload.links[0]).toMatchObject({
			slug: "docs-team",
			target_url: "https://docs.example.com/overview",
		});

		await fetchWorker("http://localhost/api/links", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				slug: "tagged-link",
				targetUrl: "https://destination.example.com/offer",
				tags: ["campanha-especial"],
			}),
		});

		const searchByTag = await fetchWorker("http://localhost/api/links?search=campanha-especial");
		const tagSearchPayload = (await searchByTag.json()) as {
			links: Array<{ slug: string }>;
		};
		expect(tagSearchPayload.links).toEqual(
			expect.arrayContaining([expect.objectContaining({ slug: "tagged-link" })]),
		);

	});

	it("filters links that have no group using group_id=null", async () => {
		const groupResponse = await fetchWorker("http://localhost/api/groups", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ name: "Campanhas" }),
		});
		const groupPayload = (await groupResponse.json()) as { group: { id: number } };

		await fetchWorker("http://localhost/api/links", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				slug: "with-group",
				targetUrl: "https://destination.example.com/group",
				groupId: groupPayload.group.id,
			}),
		});

		await fetchWorker("http://localhost/api/links", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				slug: "without-group",
				targetUrl: "https://destination.example.com/no-group",
			}),
		});

		const response = await fetchWorker("http://localhost/api/links?group_id=null");
		expect(response.status).toBe(200);
		const payload = (await response.json()) as { links: Array<{ slug: string }> };
		expect(payload.links).toHaveLength(1);
		expect(payload.links[0].slug).toBe("without-group");
	});

	it("keeps an emptied group after removing its last active link", async () => {
		const groupResponse = await fetchWorker("http://localhost/api/groups", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ name: "Temporario" }),
		});
		const groupPayload = (await groupResponse.json()) as { group: { id: number } };

		await fetchWorker("http://localhost/api/links", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				slug: "link-temporario",
				targetUrl: "https://destination.example.com/temp",
				groupId: groupPayload.group.id,
			}),
		});

		const deleteResponse = await fetchWorker("http://localhost/api/links/link-temporario", {
			method: "DELETE",
		});

		expect(deleteResponse.status).toBe(200);

		// Unreleased / Phase 5: the group survives its last link. Automatic deletion
		// ignored child groups and disabled links, so it was removed from the
		// product; only an explicit DELETE removes a group now.
		const groupsResponse = await fetchWorker("http://localhost/api/groups");
		const groupsPayload = (await groupsResponse.json()) as { groups: Array<{ id: number; name: string }> };
		expect(groupsPayload.groups).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: groupPayload.group.id, name: "Temporario" })]),
		);
	});

	it("keeps the original group when the last link moves to another group", async () => {
		const sourceGroupResponse = await fetchWorker("http://localhost/api/groups", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ name: "Origem" }),
		});
		const sourceGroupPayload = (await sourceGroupResponse.json()) as { group: { id: number } };

		const targetGroupResponse = await fetchWorker("http://localhost/api/groups", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ name: "Destino" }),
		});
		const targetGroupPayload = (await targetGroupResponse.json()) as { group: { id: number } };

		await fetchWorker("http://localhost/api/links", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				slug: "link-movido",
				targetUrl: "https://destination.example.com/moved",
				groupId: sourceGroupPayload.group.id,
			}),
		});

		const updateResponse = await fetchWorker("http://localhost/api/links/link-movido", {
			method: "PATCH",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ groupId: targetGroupPayload.group.id }),
		});

		expect(updateResponse.status).toBe(200);

		// Unreleased / Phase 5: moving the link away leaves the source group in
		// place, because it may still hold child groups or disabled links.
		const groupsResponse = await fetchWorker("http://localhost/api/groups");
		const groupsPayload = (await groupsResponse.json()) as { groups: Array<{ id: number; name: string }> };
		expect(groupsPayload.groups).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: targetGroupPayload.group.id, name: "Destino" })]),
		);
		expect(groupsPayload.groups).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: sourceGroupPayload.group.id, name: "Origem" })]),
		);
	});

	it("rejects target URLs without a dotted hostname", async () => {
		const response = await fetchWorker("http://localhost/api/links", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				slug: "no-tld",
				targetUrl: "https://iadiaudia",
			}),
		});

		expect(response.status).toBe(400);
		const payload = (await response.json()) as { error: string };
		expect(payload.error).toBe("Invalid target URL");
	});

	it("updates destination while keeping the slug stable and records clicks asynchronously", async () => {
		await fetchWorker("http://localhost/api/links", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				slug: "stable-slug",
				targetUrl: "https://destination.example.com/original",
			}),
		});

		const updateResponse = await fetchWorker("http://localhost/api/links/stable-slug", {
			method: "PATCH",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				targetUrl: "https://destination.example.com/updated",
			}),
		});

		expect(updateResponse.status).toBe(200);

		const request = new IncomingRequest("https://example.com/stable-slug", {
			headers: {
				"CF-Connecting-IP": "203.0.113.10",
				"CF-IPCountry": "BR",
				"user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/91.0",
			},
		});
		const ctx = createExecutionContext();
		const redirectResponse = await worker.fetch(request, env, ctx);

		expect(redirectResponse.status).toBe(302);
		expect(redirectResponse.headers.get("location")).toBe("https://destination.example.com/updated");

		await waitOnExecutionContext(ctx);

		const storedLink = await env.db_boltlink
			.prepare("SELECT slug, target_url, clicks_total FROM links WHERE slug = ?")
			.bind("stable-slug")
			.first<{ slug: string; target_url: string; clicks_total: number }>();
		expect(storedLink).toMatchObject({
			slug: "stable-slug",
			target_url: "https://destination.example.com/updated",
			clicks_total: 1,
		});
	});

	it("redirects social and search crawlers without counting them", async () => {
		await fetchWorker("http://localhost/api/links", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ slug: "preview-link", targetUrl: "https://destination.example.com/preview" }),
		});

		for (const userAgent of [
			"Mozilla/5.0 (compatible; Googlebot/2.1)",
			"facebookexternalhit/1.1",
			"Discordbot/2.0",
		]) {
			const response = await fetchWorker("https://example.com/preview-link", {
				headers: { "user-agent": userAgent, "sec-fetch-mode": "navigate" },
			});
			expect(response.status).toBe(302);
			expect(response.headers.get("Location")).toBe("https://destination.example.com/preview");
		}

		const storedLink = await env.db_boltlink
			.prepare("SELECT clicks_total FROM links WHERE slug = ?")
			.bind("preview-link")
			.first<{ clicks_total: number }>();
		expect(storedLink?.clicks_total).toBe(0);
	});

	it("redirects prefetch/prerender requests without writing a click", async () => {
		await fetchWorker("http://localhost/api/links", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ slug: "prefetch-link", targetUrl: "https://destination.example.com/prefetch" }),
		});

		const response = await fetchWorker("https://example.com/prefetch-link", {
			headers: {
				"user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/91.0",
				"sec-purpose": "prefetch;prerender",
			},
		});
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("https://destination.example.com/prefetch");

		const storedLink = await env.db_boltlink
			.prepare("SELECT clicks_total FROM links WHERE slug = ?")
			.bind("prefetch-link")
			.first<{ clicks_total: number }>();
		expect(storedLink?.clicks_total).toBe(0);
	});

	it("resets aggregate clicks for a single active link", async () => {
		await fetchWorker("http://localhost/api/links", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				slug: "reset-me",
				targetUrl: "https://destination.example.com/reset",
			}),
		});

		await fetchWorker("https://example.com/reset-me", {
			headers: {
				"CF-Connecting-IP": "203.0.113.11",
				"user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/91.0",
			},
		});

		const resetResponse = await fetchWorker("http://localhost/api/links/reset-me/reset-clicks", {
			method: "POST",
		});

		expect(resetResponse.status).toBe(200);
		const resetPayload = (await resetResponse.json()) as { link: { slug: string; clicks_total: number; ab_clicks_a: number; ab_clicks_b: number } };
		expect(resetPayload.link).toMatchObject({ slug: "reset-me", clicks_total: 0, ab_clicks_a: 0, ab_clicks_b: 0 });

		const storedLink = await env.db_boltlink
			.prepare("SELECT slug, target_url, clicks_total FROM links WHERE slug = ?")
			.bind("reset-me")
			.first<{ slug: string; target_url: string; clicks_total: number }>();
		expect(storedLink).toMatchObject({
			slug: "reset-me",
			target_url: "https://destination.example.com/reset",
			clicks_total: 0,
		});
	});

	it("rejects invalid public slug probes before bootstrapping D1", async () => {
		await dropDatabase();

		const response = await fetchWorker("https://example.com/.env", {
			headers: {
				"user-agent": "Mozilla/5.0",
			},
		});

		expect(response.status).toBe(404);

		const linksTable = await env.db_boltlink
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'links'")
			.first<{ name: string }>();
		expect(linksTable).toBeNull();
	});

	it("returns 404 for removed stats endpoint", async () => {
		await fetchWorker("http://localhost/api/links", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				slug: "stats-gone",
				targetUrl: "https://destination.example.com/analytics",
			}),
		});

		const response = await fetchWorker("http://localhost/api/links/stats-gone/stats");
		expect(response.status).toBe(404);
	});

	it("soft deletes links so the slug stops redirecting", async () => {
		await fetchWorker("http://localhost/api/links", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				slug: "sunset-link",
				targetUrl: "https://destination.example.com/archive",
			}),
		});

		const deleteResponse = await fetchWorker("http://localhost/api/links/sunset-link", {
			method: "DELETE",
		});

		expect(deleteResponse.status).toBe(200);

		const redirectResponse = await fetchWorker("https://example.com/sunset-link");
		expect(redirectResponse.status).toBe(404);

		const listResponse = await fetchWorker("http://localhost/api/links");
		const listPayload = (await listResponse.json()) as { links: Array<{ slug: string }> };
		expect(listPayload.links).toHaveLength(0);

		const deletedRow = await env.db_boltlink
			.prepare("SELECT disabled_at FROM links WHERE slug = ?")
			.bind("sunset-link")
			.first<{ disabled_at: string | null }>();
		expect(deletedRow?.disabled_at).toBeTruthy();
	});

	it("rejects remote admin access when Access is not configured", async () => {
		const response = await fetchWorker("https://example.com/admin");

		expect(response.status).toBe(401);
		expect(response.headers.get("strict-transport-security")).toContain("max-age=31536000");
		expect(await response.text()).toBe("Authentication required");
	});

	it("rejects remote access to the exact /api path when Access is not configured", async () => {
		const response = await fetchWorker("https://example.com/api");

		expect(response.status).toBe(401);
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(await response.json()).toEqual({ error: "Authentication required" });
	});

	it("rejects direct admin asset access when Access is not configured", async () => {
		const response = await fetchWorker("https://example.com/admin.html");

		expect(response.status).toBe(401);
		expect(await response.text()).toBe("Authentication required");
	});

	it("rejects token-based admin access when TEAM_DOMAIN is invalid", async () => {
		const response = await fetchWorker(
			"https://example.com/admin",
			{
				headers: {
					"Cf-Access-Jwt-Assertion": "test-session",
				},
			},
			{
				TEAM_DOMAIN: "::::",
				POLICY_AUD: "test-audience",
			} as unknown as Partial<Env>,
		);

		expect(response.status).toBe(401);
	});

	it("rejects token-based admin access when TEAM_DOMAIN is not HTTPS", async () => {
		const response = await fetchWorker(
			"https://example.com/admin",
			{
				headers: {
					"Cf-Access-Jwt-Assertion": "test-session",
				},
			},
			{
				TEAM_DOMAIN: "http://team.cloudflareaccess.com",
				POLICY_AUD: "test-audience",
			} as unknown as Partial<Env>,
		);

		expect(response.status).toBe(401);
	});

	it("accepts remote API access with a valid API key even without Access", async () => {
		const response = await fetchWorker(
			"https://example.com/api/links",
			{
				headers: {
					Authorization: "Bearer test-api-key",
				},
			},
			{
				API_KEY: "test-api-key",
			} as Partial<Env>,
		);

		expect(response.status).toBe(200);
	});

	it("rejects remote admin access with only a valid API key", async () => {
		const response = await fetchWorker(
			"https://example.com/admin",
			{
				headers: {
					Authorization: "Bearer test-api-key",
				},
			},
			{
				API_KEY: "test-api-key",
			} as Partial<Env>,
		);

		expect(response.status).toBe(401);
		expect(await response.text()).toBe("Authentication required");
	});

	it("rate limits API endpoints after 120 requests and resets with Retry-After", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-02T12:00:42.500Z"));
		for (let i = 0; i < 120; i++) {
			const response = await fetchWorker("http://localhost/api/links");
			expect(response.status).toBe(200);
		}

		// The 121st request is blocked until the aligned minute window resets.
		const limitedResponse = await fetchWorker("http://localhost/api/links");
		expect(limitedResponse.status).toBe(429);
		const payload = (await limitedResponse.json()) as { error: string };
		expect(payload.error).toBe("Rate limit exceeded");
		expect(limitedResponse.headers.get("Retry-After")).toBe("18");
		vi.setSystemTime(new Date("2026-10-02T12:00:59.999Z"));
		expect((await fetchWorker("http://localhost/api/links")).headers.get("Retry-After")).toBe("1");
		vi.setSystemTime(new Date("2026-10-02T12:01:00.000Z"));
		const resetResponse = await fetchWorker("http://localhost/api/links");
		expect(resetResponse.status).toBe(200);
		expect(resetResponse.headers.has("Retry-After")).toBe(false);
	});

	it.each(["admin-first", "public-first"])("isolates admin and public budgets: %s", async (order) => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-02T12:00:00.000Z"));
		// No API budget is spent on fixture setup.
		await env.db_boltlink.prepare("INSERT INTO links (slug, target_url) VALUES (?, ?)")
			.bind("isolated-budget", "https://destination.example.com/").run();
		const headers = { "CF-Connecting-IP": "203.0.113.121", "user-agent": "bot" };
		const paths = order === "admin-first" ? ["/api/links", "/isolated-budget"] : ["/isolated-budget", "/api/links"];
		for (const path of paths) {
			for (let i = 0; i < 120; i++) {
				const response = await fetchWorker("http://localhost" + path, { headers });
				expect(response.status).toBe(path.startsWith("/api") ? 200 : 302);
			}
			expect((await fetchWorker("http://localhost" + path, { headers })).status).toBe(429);
		}
	});

	it("rate limits public redirect lookups before they keep reading D1", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-02T12:00:59.999Z"));
		await fetchWorker("http://localhost/api/links", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				slug: "busy-link",
				targetUrl: "https://destination.example.com/busy",
			}),
		});

		for (let i = 0; i < 120; i++) {
			const response = await fetchWorker("https://example.com/busy-link", {
				headers: {
					"CF-Connecting-IP": "203.0.113.120",
					"user-agent": "Mozilla/5.0",
				},
			});
			expect(response.status).toBe(302);
		}

		const limitedResponse = await fetchWorker("https://example.com/busy-link", {
			headers: {
				"CF-Connecting-IP": "203.0.113.120",
				"user-agent": "Mozilla/5.0",
			},
		});

		expect(limitedResponse.status).toBe(429);
		expect(await limitedResponse.text()).toBe("Too many requests");
		vi.setSystemTime(new Date("2026-10-02T12:01:00.000Z"));
		expect((await fetchWorker("https://example.com/busy-link", {
			headers: { "CF-Connecting-IP": "203.0.113.120", "user-agent": "Mozilla/5.0" },
		})).status).toBe(302);
	});

	it("rejects JSON bodies larger than 10KB", async () => {
		const largeBody = JSON.stringify({
			slug: "test",
			targetUrl: "https://example.com",
			padding: "x".repeat(11 * 1024),
		});

		const response = await fetchWorker("http://localhost/api/links", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Content-Length": String(largeBody.length),
			},
			body: largeBody,
		});

		expect(response.status).toBe(400);
		const payload = (await response.json()) as { error: string };
		expect(payload.error).toBe("Invalid JSON body");
	});

	it("rejects JSON bodies larger than 10KB even without Content-Length", async () => {
		const largeBody = JSON.stringify({
			slug: "test",
			targetUrl: "https://example.com",
			padding: "x".repeat(11 * 1024),
		});

		const response = await fetchWorker("http://localhost/api/links", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: largeBody,
		});

		expect(response.status).toBe(400);
		const payload = (await response.json()) as { error: string };
		expect(payload.error).toBe("Invalid JSON body");
	});
});

/**
 * `ROOT_REDIRECT_URL` is operational environment configuration, so it is not part
 * of the generated `Env` type in this checkout.
 */
type RootRedirectEnv = Partial<Env> & { ROOT_REDIRECT_URL?: string };

const ROOT_ORIGIN = "https://links.example.com";

describe("Phase 4: root redirect configuration (Gate 4.3)", () => {
	async function fetchRoot(rootRedirectUrl?: string, path = "/", init?: RequestInit) {
		const overrides: RootRedirectEnv = rootRedirectUrl === undefined ? {} : { ROOT_REDIRECT_URL: rootRedirectUrl };
		return fetchWorker(`${ROOT_ORIGIN}${path}`, init, overrides as Partial<Env>);
	}

	it("serves the landing page when ROOT_REDIRECT_URL is absent", async () => {
		const response = await fetchRoot();
		const body = await response.text();

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");
		expect(body).toContain('href="/admin"');
		expect(body).toContain("BoltLink");
	});

	it("serves the landing page when ROOT_REDIRECT_URL is empty", async () => {
		const response = await fetchRoot("");

		expect(response.status).toBe(200);
		expect(response.headers.get("location")).toBeNull();
		expect(await response.text()).toContain("BoltLink");
	});

	it("redirects with 302 and no-store when ROOT_REDIRECT_URL is an https URL", async () => {
		const response = await fetchRoot("https://example.com/");

		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe("https://example.com/");
		expect(response.headers.get("cache-control")).toBe("no-store");
		// Operational, mutating configuration: never pinned as a permanent redirect.
		expect(response.status).not.toBe(301);
	});

	it("redirects with 302 for a valid http URL, following the shared destination policy", async () => {
		const response = await fetchRoot("http://example.com/landing");

		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe("http://example.com/landing");
		expect(response.headers.get("cache-control")).toBe("no-store");
	});

	it("falls back to the landing page for a rejected value and never echoes it", async () => {
		const rejected = [
			"javascript:alert(1)",
			"data:text/html,<script>alert(1)</script>",
			"ftp://example.com/",
			"/relative",
			"not a url",
			"https://localhost/",
			"https://links.example.com%%%/",
		];

		for (const value of rejected) {
			const response = await fetchRoot(value);
			const body = await response.text();

			expect(response.status, `status for ${value}`).toBe(200);
			expect(response.headers.get("location"), `location for ${value}`).toBeNull();
			expect(body, `body for ${value}`).toContain("BoltLink");
			expect(body, `echo of ${value}`).not.toContain("alert(1)");
		}
	});

	it("falls back to the landing page on a direct self-loop to the same origin root", async () => {
		const selfLoops = [
			`${ROOT_ORIGIN}/`,
			`${ROOT_ORIGIN}`,
			`${ROOT_ORIGIN}/?x=1`,
			`${ROOT_ORIGIN}/#section`,
			`${ROOT_ORIGIN}/?x=1#section`,
		];

		for (const value of selfLoops) {
			const response = await fetchRoot(value);

			expect(response.status, `status for ${value}`).toBe(200);
			expect(response.headers.get("location"), `location for ${value}`).toBeNull();
		}
	});

	it("redirects to another path on the same origin", async () => {
		const response = await fetchRoot(`${ROOT_ORIGIN}/some-page`);

		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe(`${ROOT_ORIGIN}/some-page`);
	});

	it("redirects to the root of a different origin", async () => {
		const response = await fetchRoot("https://example.com/");

		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe("https://example.com/");
	});

	it("uses strict-origin on the root redirect and keeps no-referrer on the landing page", async () => {
		const redirect = await fetchRoot("https://example.com/");
		expect(redirect.headers.get("referrer-policy")).toBe("strict-origin");

		const landing = await fetchRoot();
		expect(landing.headers.get("referrer-policy")).toBe("no-referrer");
	});

	it("sets no cookie on the root redirect", async () => {
		const response = await fetchRoot("https://example.com/");

		expect(response.headers.get("set-cookie")).toBeNull();
	});

	it("runs zero D1 operations on a configured root redirect", async () => {
		const recorder = recordingDbHandle(env.db_boltlink);
		const response = await fetchWorker(
			`${ROOT_ORIGIN}/`,
			undefined,
			{ db_boltlink: recorder.handle, ROOT_REDIRECT_URL: "https://example.com/" } as Partial<Env>,
		);

		expect(response.status).toBe(302);
		expect(recorder.statements).toEqual([]);
	});

	it("changes only GET / and leaves unknown slugs and reserved routes untouched", async () => {
		const rootRedirect = "https://example.com/";

		const missing = await fetchRoot(rootRedirect, "/missing-slug");
		expect(missing.status).toBe(404);
		expect(missing.headers.get("location")).toBeNull();
		expect(await missing.text()).toBe("Not found");

		// The Access gate and the reserved routes answer exactly as before: the root
		// configuration never turns one of them into a redirect.
		const admin = await fetchRoot(rootRedirect, "/admin");
		expect(admin.status).toBe(401);
		expect(admin.headers.get("location")).toBeNull();

		const api = await fetchRoot(rootRedirect, "/api/capabilities");
		expect(api.status).toBe(401);
		expect(api.headers.get("location")).toBeNull();

		const privacy = await fetchRoot(rootRedirect, "/privacidade");
		expect(privacy.status).toBe(200);
		expect(privacy.headers.get("location")).toBeNull();

		const posted = await fetchRoot(rootRedirect, "/", { method: "POST" });
		expect(posted.status).toBe(404);
		expect(posted.headers.get("location")).toBeNull();

		const health = await fetchRoot(rootRedirect, "/health");
		expect(health.status).toBe(200);
		expect(health.headers.get("location")).toBeNull();
	});
});

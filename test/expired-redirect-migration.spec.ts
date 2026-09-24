/*
 * Copyright (c) 2026 Vitor Faustino
 * AGPL-3.0 License — https://github.com/vitorgfaustino/boltlink
 *
 * Gate 4.1: expired destination — migration, capability, pre/post migration
 * contracts, runtime DDL prohibition and live promotion.
 *
 * This file owns the migration boundary of `links.expired_redirect_url`: the
 * column, its capability and the schema-neutral public read. The behavior of an
 * expired link itself belongs to Gate 4.2 in link-lifecycle-and-management, which
 * consumes the same single wildcard row; what stays here is that the read pattern
 * never names the column, never probes the schema and never caches a capability.
 */

import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetRateLimitStore } from "../src/rate-limit";
import worker from "../src/index";
import migration0000 from "../migrations/0000_initial_schema.sql";
import migration0001 from "../migrations/0001_link_management.sql";
import migration0002 from "../migrations/0002_advanced_features.sql";
import migration0003 from "../migrations/0003_lgpd_minimization.sql";
import migration0004 from "../migrations/0004_ab_testing.sql";
import migration0005 from "../migrations/0005_smart_routing.sql";
import migration0006 from "../migrations/0006_expired_redirect.sql";

const PRE_0006 = [migration0000, migration0001, migration0002, migration0003, migration0004, migration0005];
const FULL_CHAIN = [...PRE_0006, migration0006];
/** 0006 without 0004: the expired destination is an independent capability. */
const WITHOUT_AB = [migration0000, migration0001, migration0002, migration0003, migration0005, migration0006];

const EXPIRED_COLUMN = "expired_redirect_url";
const EXPIRED_MIGRATION_FILE = "0006_expired_redirect.sql";
const FALLBACK_URL = "https://example.com/fallback";
const DESTINATION_URL = "https://example.com/expired";
const HUMAN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const PAST = "2001-01-01T00:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";
const FROM = "2026-01-01T00:00:00.000Z";

type CfInit = RequestInit & { cf?: { country?: string } };

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

type TracedHandle = { handle: D1Database; statements: string[] };

/** A distinct handle identity that records every statement it runs. */
function tracedHandle(db: D1Database): TracedHandle {
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

function splitStatements(sql: string) {
	return sql
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.filter((line) => !line.trim().startsWith("--"))
		.join("\n")
		.split(";")
		.map((statement) => statement.trim())
		.filter(Boolean);
}

async function applySchema(sql: string) {
	for (const statement of splitStatements(sql)) {
		await env.db_boltlink.prepare(statement).run();
	}
}

async function applyChain(migrations: string[]) {
	for (const migration of migrations) {
		await applySchema(migration);
	}
}

async function resetAll() {
	await env.db_boltlink.prepare("DROP VIEW IF EXISTS boltlink_metric_fence").run();
	await env.db_boltlink.prepare("DROP TABLE IF EXISTS link_groups").run();
	await env.db_boltlink.prepare("DROP TABLE IF EXISTS links").run();
}

async function tableInfo() {
	const info = await env.db_boltlink
		.prepare("PRAGMA table_info(links)")
		.all<{ name: string; type: string; notnull: number; dflt_value: string | null }>();
	return info.results ?? [];
}

async function tableColumns() {
	return new Set((await tableInfo()).map((column) => column.name));
}

/**
 * Structural integrity of the database file after a migration. D1 refuses
 * `PRAGMA integrity_check` with SQLITE_AUTH, so `quick_check` — the strongest
 * integrity pragma D1 authorizes — is the available equivalent.
 */
async function quickCheck() {
	const result = await env.db_boltlink.prepare("PRAGMA quick_check").all<Record<string, string>>();
	return Object.values((result.results ?? [])[0] ?? {});
}

async function fetchWorker(url: string, init?: CfInit, handle?: D1Database) {
	const request = new Request(url, init as RequestInit);
	const ctx = createExecutionContext();
	const response = await worker.fetch(
		request,
		{ ...env, PASSWORD_SESSION_SECRET: "test-secret", db_boltlink: handle ?? cloneDbHandle(env.db_boltlink) },
		ctx,
	);
	await waitOnExecutionContext(ctx);
	return response;
}

async function createLink(body: Record<string, unknown>, handle?: D1Database) {
	return fetchWorker(
		"http://localhost/api/links",
		{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
		handle,
	);
}

async function patchLink(slug: string, body: Record<string, unknown>, handle?: D1Database) {
	return fetchWorker(
		`http://localhost/api/links/${slug}`,
		{ method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
		handle,
	);
}

async function capabilities(handle?: D1Database) {
	return fetchWorker("http://127.0.0.1/api/capabilities", undefined, handle);
}

/**
 * One request on an already-warmed traced handle, reporting only the statements
 * that request ran. Warming matters: the first request on a fresh handle also
 * installs the metric-fence projection, and that bootstrap is not part of the
 * steady-state read pattern this file measures.
 */
async function measuredRequest(url: string, traced: TracedHandle, init?: CfInit) {
	traced.statements.length = 0;
	const response = await fetchWorker(url, init, traced.handle);
	return { response, statements: [...traced.statements] };
}

async function warmHandle(handle: D1Database) {
	await fetchWorker("https://example.com/er-warmup", { headers: { "user-agent": HUMAN_UA } }, handle);
}

async function rawRow(slug: string) {
	return env.db_boltlink
		.prepare("SELECT expires_at, version FROM links WHERE slug = ?")
		.bind(slug)
		.first<{ expires_at: string | null; version: number }>();
}

/** Requires the database to be at 0006. */
async function rawDestination(slug: string) {
	return env.db_boltlink
		.prepare("SELECT expired_redirect_url FROM links WHERE slug = ?")
		.bind(slug)
		.first<{ expired_redirect_url: string | null }>();
}

beforeEach(async () => {
	await resetAll();
	await applyChain(PRE_0006);
	resetRateLimitStore();
});

describe("Phase 4: Expired destination migration and capability (Gate 4.1)", () => {
	it("applies the chain 0000 -> 0006 and creates the column as nullable TEXT without a default", async () => {
		await resetAll();
		await applyChain(FULL_CHAIN);

		const columns = await tableColumns();
		expect(columns.has(EXPIRED_COLUMN)).toBe(true);

		const column = (await tableInfo()).find((entry) => entry.name === EXPIRED_COLUMN);
		expect(column).toMatchObject({ type: "TEXT", notnull: 0, dflt_value: null });
		expect(await quickCheck()).toEqual(["ok"]);
	});

	it("is additive: 0006 adds exactly one nullable column and rebuilds nothing", async () => {
		const before = await tableColumns();
		await applySchema(migration0006);
		const after = await tableColumns();

		expect([...after].sort()).toEqual([...before, EXPIRED_COLUMN].sort());

		// No index may reference the new column: the expired destination is never
		// queried on its own, so an index would only cost writes.
		const indexes = await env.db_boltlink
			.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'links'")
			.all<{ sql: string | null }>();
		expect((indexes.results ?? []).some((row) => (row.sql ?? "").includes(EXPIRED_COLUMN))).toBe(false);

		const view = await env.db_boltlink
			.prepare("SELECT sql FROM sqlite_master WHERE type = 'view' AND name = ?")
			.bind("boltlink_metric_fence")
			.first<{ sql: string }>();
		expect(view?.sql ?? "").not.toContain(EXPIRED_COLUMN);
	});

	it("keeps every 0005 row identical and defaults the new column to NULL", async () => {
		await env.db_boltlink.prepare("INSERT INTO link_groups (id, name) VALUES (1, 'grupo')").run();

		const insert = `INSERT INTO links (
			slug, target_url, clicks_total, expires_at, go_live_at, redirect_type, tags, has_qrcode,
			group_id, password_hash, ab_enabled, ab_target_url, ab_weight_b, ab_generation,
			metric_epoch, ab_clicks_a, ab_clicks_b, ab_started_at, smart_routing_rules, version
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
		const rows: Array<[string, string, number, string | null, string | null, string, string | null, number, number | null, string | null, number, string | null, number, number, number, number, number, string | null, string | null, number]> = [
			["er-normal", "https://example.com/normal", 3, null, null, "302", JSON.stringify(["x"]), 1, 1, null, 0, null, 50, 0, 0, 0, 0, null, null, 2],
			["er-password", "https://example.com/locked", 1, null, null, "302", null, 0, null, "salt:hash", 0, null, 50, 0, 0, 0, 0, null, null, 4],
			["er-future", "https://example.com/future", 0, null, FUTURE, "302", null, 0, null, null, 0, null, 50, 0, 0, 0, 0, null, null, 1],
			["er-expired", "https://example.com/expired", 2, PAST, null, "302", null, 0, null, null, 0, null, 50, 0, 0, 0, 0, null, null, 3],
			["er-ab", "https://example.com/a", 11, null, null, "302", null, 0, null, null, 1, "https://example.com/b", 40, 3, 1, 4, 6, FROM, null, 5],
			["er-smart", "https://example.com/s", 7, null, null, "302", null, 0, null, null, 0, null, 50, 0, 0, 0, 0, null, JSON.stringify([{ country: "BR", url: "https://example.com/br" }]), 6],
			["er-permanent", "https://example.com/301", 9, null, null, "301", null, 0, null, null, 0, null, 60, 2, 0, 0, 0, null, null, 7],
		];
		for (const row of rows) {
			await env.db_boltlink.prepare(insert).bind(...row).run();
		}

		const selectAll = `SELECT
			slug, target_url, clicks_total, expires_at, go_live_at, redirect_type, tags, has_qrcode,
			group_id, password_hash, ab_enabled, ab_target_url, ab_weight_b, ab_generation,
			metric_epoch, ab_clicks_a, ab_clicks_b, ab_started_at, smart_routing_rules, version
			FROM links ORDER BY slug`;
		const before = await env.db_boltlink.prepare(selectAll).all<Record<string, unknown>>();

		await applySchema(migration0006);

		const after = await env.db_boltlink.prepare(selectAll).all<Record<string, unknown>>();
		expect(after.results).toEqual(before.results);

		const destination = await env.db_boltlink
			.prepare("SELECT COUNT(*) AS total, COUNT(expired_redirect_url) AS configured FROM links")
			.first<{ total: number; configured: number }>();
		expect(destination).toMatchObject({ total: rows.length, configured: 0 });
		expect(await quickCheck()).toEqual(["ok"]);
	});

	it("promotes expiredRedirect on the same handle without a restart and preserves the other capabilities", async () => {
		const handle = tracedHandle(cloneDbHandle(env.db_boltlink));

		const pre = await capabilities(handle.handle);
		expect(await pre.json()).toEqual({ abTesting: true, smartRouting: true, expiredRedirect: false });

		await applySchema(migration0006);

		const post = await capabilities(handle.handle);
		expect(await post.json()).toEqual({ abTesting: true, smartRouting: true, expiredRedirect: true });

		// A promoted handle answers from its positive cache: the next read runs no
		// schema probe at all.
		handle.statements.length = 0;
		expect(await (await capabilities(handle.handle)).json()).toEqual({
			abTesting: true,
			smartRouting: true,
			expiredRedirect: true,
		});
		expect(handle.statements.filter((sql) => sql.includes("PRAGMA"))).toHaveLength(0);
	});

	it("classifies the expired destination independently of the A/B columns", async () => {
		await resetAll();
		// 0004 intentionally skipped: the expired destination does not depend on A/B.
		await applyChain(WITHOUT_AB);

		const columns = await tableColumns();
		expect(columns.has(EXPIRED_COLUMN)).toBe(true);

		const response = await capabilities(cloneDbHandle(env.db_boltlink));
		expect(await response.json()).toEqual({ abTesting: false, smartRouting: true, expiredRedirect: true });
	});

	it("never creates the column at runtime and keeps every pre-0006 endpoint working", async () => {
		const handle = cloneDbHandle(env.db_boltlink);

		expect((await capabilities(handle)).status).toBe(200);
		expect((await fetchWorker("http://127.0.0.1/api/links", undefined, handle)).status).toBe(200);

		const created = await createLink({ slug: "er-pre-normal", targetUrl: FALLBACK_URL }, handle);
		expect(created.status).toBe(201);

		const patched = await patchLink("er-pre-normal", { tags: ["ainda-funciona"] }, handle);
		expect(patched.status).toBe(200);

		const duplicated = await fetchWorker("http://localhost/api/links/er-pre-normal/duplicate", { method: "POST" }, handle);
		expect(duplicated.status).toBe(201);

		const reset = await fetchWorker("http://localhost/api/links/er-pre-normal/reset-clicks", { method: "POST" }, handle);
		expect(reset.status).toBe(200);

		const listed = await fetchWorker("http://127.0.0.1/api/links", undefined, handle);
		const payload = (await listed.json()) as { links: Array<Record<string, unknown>> };
		for (const link of payload.links) {
			expect(Object.keys(link)).not.toContain("expiredRedirectUrl");
		}

		// No administrative path may have evolved the schema.
		expect((await tableColumns()).has(EXPIRED_COLUMN)).toBe(false);
	});

	it("rejects a create that mentions the field before 0006 and keeps normal creates working", async () => {
		const normal = await createLink({ slug: "er-pre-create", targetUrl: FALLBACK_URL });
		expect(normal.status).toBe(201);
		const normalPayload = (await normal.json()) as { link: Record<string, unknown> };
		expect(Object.keys(normalPayload.link)).not.toContain("expiredRedirectUrl");

		const withNull = await createLink({ slug: "er-pre-null", targetUrl: FALLBACK_URL, expiredRedirectUrl: null });
		expect(withNull.status).toBe(400);
		expect(((await withNull.json()) as { error: string }).error).toContain(EXPIRED_MIGRATION_FILE);

		const withUrl = await createLink({
			slug: "er-pre-url",
			targetUrl: FALLBACK_URL,
			expiresAt: PAST,
			expiredRedirectUrl: DESTINATION_URL,
		});
		expect(withUrl.status).toBe(400);

		// A controlled 400, never a raw SQLite error, and nothing was written.
		const body = await withUrl.text();
		expect(body).toContain(EXPIRED_MIGRATION_FILE);
		expect(body).not.toContain("no such column");
		expect(body).not.toContain("SQLITE_ERROR");
		expect(await rawRow("er-pre-url")).toBeNull();
	});

	it("rejects a patch that mentions the field before 0006 without touching the row", async () => {
		await createLink({ slug: "er-pre-patch", targetUrl: FALLBACK_URL });
		const before = await env.db_boltlink
			.prepare("SELECT tags, expires_at, updated_at, version FROM links WHERE slug = ?")
			.bind("er-pre-patch")
			.first<Record<string, unknown>>();

		// A normal pre-0006 PATCH keeps working.
		expect((await patchLink("er-pre-patch", { tags: ["ok"] })).status).toBe(200);

		const withNull = await patchLink("er-pre-patch", { expiredRedirectUrl: null });
		expect(withNull.status).toBe(400);
		expect(((await withNull.json()) as { error: string }).error).toContain(EXPIRED_MIGRATION_FILE);

		const withUrl = await patchLink("er-pre-patch", { expiresAt: PAST, expiredRedirectUrl: DESTINATION_URL });
		expect(withUrl.status).toBe(400);
		expect(((await withUrl.json()) as { error: string }).error).toContain(EXPIRED_MIGRATION_FILE);

		const row = await rawRow("er-pre-patch");
		expect(row?.expires_at).toBe(before?.expires_at ?? null);
		expect((await tableColumns()).has(EXPIRED_COLUMN)).toBe(false);
	});

	it("keeps the public read schema-neutral on a 0006 database with the column filled", async () => {
		await applySchema(migration0006);

		const created = await createLink({
			slug: "er-public-expired",
			targetUrl: FALLBACK_URL,
			expiresAt: PAST,
			expiredRedirectUrl: DESTINATION_URL,
		});
		expect(created.status).toBe(201);
		expect((await rawDestination("er-public-expired"))?.expired_redirect_url).toBe(DESTINATION_URL);

		const trace = tracedHandle(cloneDbHandle(env.db_boltlink));
		await warmHandle(trace.handle);

		// Gate 4.2 owns this answer: the filled destination is now the expired
		// lifecycle's, and this file keeps owning the read pattern that produces it.
		const get = await measuredRequest("https://example.com/er-public-expired", trace, { headers: { "user-agent": HUMAN_UA } });
		expect(get.response.status).toBe(302);
		expect(get.response.headers.get("Location")).toBe(DESTINATION_URL);

		const post = await measuredRequest(
			"https://example.com/er-public-expired",
			trace,
			{ method: "POST", headers: { "user-agent": HUMAN_UA } },
		);
		expect(post.response.status).toBe(302);
		expect(post.response.headers.get("Location")).toBe(DESTINATION_URL);

		// The public path must stay schema-neutral: one wildcard read, no PRAGMA and
		// no mention of the column the answer is derived from.
		for (const statements of [get.statements, post.statements]) {
			const selects = statements.filter((sql) => sql.trimStart().startsWith("SELECT"));
			expect(selects).toEqual(["SELECT * FROM links WHERE slug = ? AND disabled_at IS NULL"]);
			expect(statements.some((sql) => sql.includes("PRAGMA"))).toBe(false);
			expect(statements.some((sql) => sql.includes(EXPIRED_COLUMN))).toBe(false);
		}
	});

	it("lists the expired destination in the same single query, adding no per-row read", async () => {
		await applySchema(migration0006);

		expect((await createLink({
			slug: "er-list-configured",
			targetUrl: FALLBACK_URL,
			expiresAt: FUTURE,
			expiredRedirectUrl: DESTINATION_URL,
		})).status).toBe(201);
		expect((await createLink({ slug: "er-list-plain", targetUrl: FALLBACK_URL })).status).toBe(201);

		const trace = tracedHandle(cloneDbHandle(env.db_boltlink));
		await warmHandle(trace.handle);
		const measured = await measuredRequest("http://127.0.0.1/api/links", trace);
		expect(measured.response.status).toBe(200);

		const selects = measured.statements.filter((sql) => sql.trimStart().startsWith("SELECT"));
		expect(selects).toHaveLength(1);
		// The column is part of the single list projection, never a second read.
		expect(selects[0].split(EXPIRED_COLUMN)).toHaveLength(2);

		const payload = (await measured.response.json()) as { links: Array<Record<string, unknown> & { slug: string }> };
		const configured = payload.links.find((link) => link.slug === "er-list-configured");
		const plain = payload.links.find((link) => link.slug === "er-list-plain");
		expect(configured?.expiredRedirectUrl).toBe(DESTINATION_URL);
		expect(plain?.expiredRedirectUrl).toBeNull();
		expect(Object.keys(plain ?? {})).not.toContain(EXPIRED_COLUMN);
	});

	it("tolerates the extra column on a code rollback to the previous worker", async () => {
		await applySchema(migration0006);
		expect(await quickCheck()).toEqual(["ok"]);

		// A pre-gate worker writes the columns that existed at 0005 and never the new
		// one, which is exactly what a rolled-back worker does.
		await env.db_boltlink
			.prepare(
				`INSERT INTO links (slug, target_url, redirect_type, tags, group_id, ab_enabled, ab_target_url, ab_weight_b, ab_generation, ab_started_at, smart_routing_rules)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind("er-rollback", FALLBACK_URL, "302", null, null, 0, null, 50, 0, null, null)
			.run();

		const row = await env.db_boltlink
			.prepare("SELECT target_url, smart_routing_rules, expired_redirect_url, version FROM links WHERE slug = ?")
			.bind("er-rollback")
			.first<{ target_url: string; smart_routing_rules: string | null; expired_redirect_url: string | null; version: number }>();
		expect(row).toMatchObject({ target_url: FALLBACK_URL, smart_routing_rules: null, expired_redirect_url: null, version: 1 });

		const response = await fetchWorker("https://example.com/er-rollback", { headers: { "user-agent": HUMAN_UA } });
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(FALLBACK_URL);
	});
});

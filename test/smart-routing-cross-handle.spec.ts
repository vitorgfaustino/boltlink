/*
 * Copyright (c) 2026 Vitor Faustino
 * AGPL-3.0 License — https://github.com/vitorgfaustino/boltlink
 *
 * Gate 3.5: cross-handle capability convergence (BL-SR-GLOBAL-001).
 *
 * Two independent handles point at the same D1 database. A public handle warmed
 * before migration 0005 must converge on its own next public request: the
 * redirect read is schema-neutral (`SELECT *`) and derives what exists from the
 * row shape, so it needs no admin/API request on that handle, no per-click
 * probe and no cross-handle affinity. A handle that can observe a non-null
 * routing column must always answer 302 + no-store.
 */

import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimitStore } from "../src/rate-limit";
import worker from "../src/index";
import migration0000 from "../migrations/0000_initial_schema.sql";
import migration0001 from "../migrations/0001_link_management.sql";
import migration0002 from "../migrations/0002_advanced_features.sql";
import migration0003 from "../migrations/0003_lgpd_minimization.sql";
import migration0004 from "../migrations/0004_ab_testing.sql";
import migration0005 from "../migrations/0005_smart_routing.sql";

const rngControl = vi.hoisted(() => ({ value: 0, calls: 0 }));

vi.mock("../src/ab-random", () => ({
	randomPercent: () => {
		rngControl.calls += 1;
		return rngControl.value;
	},
}));

const PRE_0005 = [migration0000, migration0001, migration0002, migration0003, migration0004];
const HUMAN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const FALLBACK_URL = "https://example.com/fallback";
const RULE = (path: string) => `https://example.com/${path}`;
const COUNTRY_RULE = [{ country: "BR", url: RULE("br") }];

type CfInit = RequestInit & { cf?: { country?: string } };

function passThrough(target: object, prop: string | symbol) {
	const value = Reflect.get(target, prop);
	return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
}

/**
 * A distinct handle identity over the same database. Capability caches are keyed
 * per handle, so two clones model two isolates that never share memory.
 */
function cloneDbHandle(db: D1Database): D1Database {
	return new Proxy(db, {
		get(target, prop) {
			return passThrough(target, prop);
		},
	}) as D1Database;
}

type TracedHandle = { handle: D1Database; statements: string[] };

/** A distinct handle identity that records the SQL it runs. */
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

async function applyChain(migrations: string[]) {
	for (const migration of migrations) {
		for (const statement of splitStatements(migration)) {
			await env.db_boltlink.prepare(statement).run();
		}
	}
}

async function resetAll() {
	await env.db_boltlink.prepare("DROP VIEW IF EXISTS boltlink_metric_fence").run();
	await env.db_boltlink.prepare("DROP TABLE IF EXISTS link_groups").run();
	await env.db_boltlink.prepare("DROP TABLE IF EXISTS links").run();
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

/** Public request on an already-traced handle, reporting only the SQL it ran. */
async function publicRequest(url: string, traced: TracedHandle, init?: CfInit) {
	traced.statements.length = 0;
	const response = await fetchWorker(url, init, traced.handle);
	return { response, statements: traced.statements };
}

async function insertLink(slug: string, targetUrl = FALLBACK_URL) {
	await env.db_boltlink
		.prepare("INSERT INTO links (slug, target_url) VALUES (?, ?)")
		.bind(slug, targetUrl)
		.run();
}

async function patchLink(slug: string, body: Record<string, unknown>, handle?: D1Database) {
	return fetchWorker(
		`http://localhost/api/links/${slug}`,
		{ method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
		handle,
	);
}

const HUMAN_BR = { headers: { "user-agent": HUMAN_UA }, cf: { country: "BR" } } as CfInit;

function linkSelects(statements: string[]) {
	return statements.filter((sql) => sql.trimStart().startsWith("SELECT"));
}

beforeEach(async () => {
	await resetAll();
	await applyChain(PRE_0005);
	resetRateLimitStore();
	rngControl.value = 0;
	rngControl.calls = 0;
});

describe("Phase 3: Smart Routing cross-handle convergence (BL-SR-GLOBAL-001)", () => {
	/**
	 * The closing scenario: handle A is warmed while the database is still at
	 * 0004, migration 0005 is applied, a different handle enables Smart Routing,
	 * and handle A must route correctly on its very next public request without
	 * any admin/API traffic ever reaching it.
	 */
	it("converges on a live 0005 upgrade with no admin call on the stale public handle", async () => {
		await insertLink("xh-converge");
		const handleA = tracedHandle(cloneDbHandle(env.db_boltlink));
		const handleB = cloneDbHandle(env.db_boltlink);

		// A: warm the handle pre-0005. The old implementation cached the negative
		// capability here forever, which is exactly the finding.
		const warm = await publicRequest("https://example.com/xh-converge", handleA, HUMAN_BR);
		expect(warm.response.status).toBe(302);
		expect(warm.response.headers.get("Location")).toBe(FALLBACK_URL);

		// The operator applies migration 0005.
		await applyChain([migration0005]);

		// B: an unrelated handle validates the capability and enables Smart Routing.
		const capabilities = await fetchWorker("http://127.0.0.1/api/capabilities", undefined, handleB);
		expect(await capabilities.json()).toEqual({ abTesting: true, smartRouting: true });
		const enabled = await patchLink("xh-converge", { smartRoutingRules: COUNTRY_RULE }, handleB);
		expect(enabled.status).toBe(200);

		// A: no admin/API request on this handle, only the next public request.
		const after = await publicRequest("https://example.com/xh-converge", handleA, HUMAN_BR);
		expect(after.response.status).toBe(302);
		expect(after.response.headers.get("Location")).toBe(RULE("br"));
		expect(after.response.headers.get("Cache-Control")).toBe("no-store");

		// Convergence costs no schema probe: a single schema-neutral read.
		const selects = linkSelects(after.statements);
		expect(selects).toHaveLength(1);
		expect(selects[0]).toBe("SELECT * FROM links WHERE slug = ? AND disabled_at IS NULL");
		expect(after.statements.some((sql) => sql.includes("PRAGMA"))).toBe(false);
	});

	it("serves the fail-safe no-store fallback for a corrupt value on a stale handle", async () => {
		await insertLink("xh-corrupt");
		const handleA = tracedHandle(cloneDbHandle(env.db_boltlink));
		const handleB = cloneDbHandle(env.db_boltlink);

		await publicRequest("https://example.com/xh-corrupt", handleA, HUMAN_BR);

		await applyChain([migration0005]);
		await env.db_boltlink
			.prepare("UPDATE links SET smart_routing_rules = ? WHERE slug = ?")
			.bind("INVALID RAW VALUE", "xh-corrupt")
			.run();
		// A different handle observes the change; A still never runs an admin path.
		expect(await fetchWorker("http://127.0.0.1/api/capabilities", undefined, handleB)).toBeTruthy();

		const after = await publicRequest("https://example.com/xh-corrupt", handleA, HUMAN_BR);
		expect(after.response.status).toBe(302);
		expect(after.response.headers.get("Location")).toBe(FALLBACK_URL);
		expect(after.response.headers.get("Cache-Control")).toBe("no-store");
	});

	it("fails safe without RNG or Smart selection when a stale handle observes a hybrid row", async () => {
		await insertLink("xh-hybrid");
		const handleA = tracedHandle(cloneDbHandle(env.db_boltlink));

		await publicRequest("https://example.com/xh-hybrid", handleA, HUMAN_BR);

		await applyChain([migration0005]);
		await env.db_boltlink
			.prepare("UPDATE links SET ab_enabled = 1, ab_target_url = ?, ab_started_at = ?, smart_routing_rules = ? WHERE slug = ?")
			.bind(RULE("variant-b"), "2026-01-01T00:00:00.000Z", JSON.stringify(COUNTRY_RULE), "xh-hybrid")
			.run();

		// rngControl.value = 0 would select Variant B if the A/B engine ran.
		const after = await publicRequest("https://example.com/xh-hybrid", handleA, HUMAN_BR);
		expect(after.response.status).toBe(302);
		expect(after.response.headers.get("Location")).toBe(FALLBACK_URL);
		expect(after.response.headers.get("Location")).not.toBe(RULE("variant-b"));
		expect(after.response.headers.get("Location")).not.toBe(RULE("br"));
		expect(after.response.headers.get("Cache-Control")).toBe("no-store");
		expect(rngControl.calls).toBe(0);
	});

	it("never answers 301 for a row whose routing column is non-null", async () => {
		await insertLink("xh-permanent");
		const handle = tracedHandle(cloneDbHandle(env.db_boltlink));
		await applyChain([migration0005]);
		await env.db_boltlink
			.prepare("UPDATE links SET redirect_type = '301', smart_routing_rules = ? WHERE slug = ?")
			.bind(JSON.stringify(COUNTRY_RULE), "xh-permanent")
			.run();

		const valid = await publicRequest("https://example.com/xh-permanent", handle, HUMAN_BR);
		expect(valid.response.status).toBe(302);
		expect(valid.response.headers.get("Cache-Control")).toBe("no-store");

		await env.db_boltlink
			.prepare("UPDATE links SET smart_routing_rules = ? WHERE slug = ?")
			.bind("{broken", "xh-permanent")
			.run();
		const corrupt = await publicRequest("https://example.com/xh-permanent", handle, HUMAN_BR);
		expect(corrupt.response.status).toBe(302);
		expect(corrupt.response.headers.get("Location")).toBe(FALLBACK_URL);
		expect(corrupt.response.headers.get("Cache-Control")).toBe("no-store");
	});

	it("keeps the redirect working on a database that is still at 0004", async () => {
		await insertLink("xh-pre-0005");
		const handle = tracedHandle(cloneDbHandle(env.db_boltlink));

		const first = await publicRequest("https://example.com/xh-pre-0005", handle, HUMAN_BR);
		expect(first.response.status).toBe(302);
		expect(first.response.headers.get("Location")).toBe(FALLBACK_URL);
		// No statement may name a column this database does not have.
		expect(first.statements.every((sql) => !sql.includes("smart_routing_rules"))).toBe(true);

		const second = await publicRequest("https://example.com/xh-pre-0005", handle, HUMAN_BR);
		expect(second.response.status).toBe(302);
		expect(linkSelects(second.statements)).toHaveLength(1);
	});
});

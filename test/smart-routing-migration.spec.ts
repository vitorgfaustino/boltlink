/*
 * Copyright (c) 2026 Vitor Faustino
 * AGPL-3.0 License — https://github.com/vitorgfaustino/boltlink
 *
 * Gate 3.2: Smart Routing migration/schema coverage. Migrations remain the
 * only schema authority; the runtime never creates the smart column.
 */

import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import migration0000 from "../migrations/0000_initial_schema.sql";
import migration0001 from "../migrations/0001_link_management.sql";
import migration0002 from "../migrations/0002_advanced_features.sql";
import migration0003 from "../migrations/0003_lgpd_minimization.sql";
import migration0004 from "../migrations/0004_ab_testing.sql";
import migration0005 from "../migrations/0005_smart_routing.sql";

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

async function tableColumns() {
	const info = await env.db_boltlink.prepare("PRAGMA table_info(links)").all<{ name: string }>();
	return new Set((info.results ?? []).map((column) => column.name));
}

async function fetchWorker(url: string, handle: D1Database) {
	const request = new Request(url);
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, { ...env, db_boltlink: handle }, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

const PRE_0005 = [migration0000, migration0001, migration0002, migration0003, migration0004];
const FULL_CHAIN = [...PRE_0005, migration0005];

describe("Smart Routing migration/schema", () => {
	it("capability is false before 0005 and true after applying it without restart", async () => {
		await resetAll();
		await applyChain(PRE_0005);

		const handle = cloneDbHandle(env.db_boltlink);
		const pre = await fetchWorker("http://127.0.0.1/api/capabilities", handle);
		expect(await pre.json()).toEqual({ abTesting: true, smartRouting: false });

		await applySchema(migration0005);

		const post = await fetchWorker("http://127.0.0.1/api/capabilities", handle);
		expect(await post.json()).toEqual({ abTesting: true, smartRouting: true });
	});

	it("runtime never creates the smart_routing_rules column", async () => {
		await resetAll();
		await applyChain(PRE_0005);

		const handle = cloneDbHandle(env.db_boltlink);
		expect((await fetchWorker("http://127.0.0.1/api/capabilities", handle)).status).toBe(200);
		expect((await fetchWorker("http://127.0.0.1/api/links", handle)).status).toBe(200);

		const columns = await tableColumns();
		expect(columns.has("smart_routing_rules")).toBe(false);
	});

	it("partial schema: smart column without A/B is capable for routing only", async () => {
		await resetAll();
		// Skip 0004 intentionally: routing is an independent capability.
		await applyChain([migration0000, migration0001, migration0002, migration0003, migration0005]);

		const handle = cloneDbHandle(env.db_boltlink);
		const capability = await fetchWorker("http://127.0.0.1/api/capabilities", handle);
		expect(await capability.json()).toEqual({ abTesting: false, smartRouting: true });

		const columns = await tableColumns();
		expect(columns.has("smart_routing_rules")).toBe(true);
		expect(columns.has("metric_epoch")).toBe(false);
	});

	it("clean chain 0000 -> 0005 creates the column and keeps the metric fence valid", async () => {
		await resetAll();
		await applyChain(FULL_CHAIN);

		const columns = await tableColumns();
		expect(columns.has("smart_routing_rules")).toBe(true);

		const view = await env.db_boltlink
			.prepare("SELECT sql FROM sqlite_master WHERE type = 'view' AND name = ?")
			.bind("boltlink_metric_fence")
			.first<{ sql: string }>();
		expect(view?.sql).toContain("metric_epoch");
		const viewRows = await env.db_boltlink.prepare("SELECT * FROM boltlink_metric_fence LIMIT 1").all();
		expect(viewRows.success).toBe(true);
	});

	it("0004 -> 0005 upgrade preserves every row and defaults routing to NULL", async () => {
		await resetAll();
		await applyChain(PRE_0005);
		await env.db_boltlink.prepare("INSERT INTO link_groups (id, name) VALUES (1, 'grupo')").run();

		const insert = `INSERT INTO links (
			slug, target_url, clicks_total, expires_at, go_live_at, redirect_type, tags, has_qrcode,
			group_id, password_hash, ab_enabled, ab_target_url, ab_weight_b, ab_generation,
			metric_epoch, ab_clicks_a, ab_clicks_b, ab_started_at, version
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
		await env.db_boltlink.prepare(insert).bind("sr-normal", "https://example.com/n", 3, null, null, "302", JSON.stringify(["x"]), 1, 1, null, 0, null, 50, 0, 0, 0, 0, null, 2).run();
		await env.db_boltlink.prepare(insert).bind("sr-301", "https://example.com/301", 9, null, null, "301", null, 0, null, null, 0, null, 50, 0, 0, 0, 0, null, 7).run();
		await env.db_boltlink.prepare(insert).bind("sr-password", "https://example.com/p", 1, null, null, "302", null, 0, null, "salt:hash", 0, null, 50, 0, 0, 0, 0, null, 4).run();
		await env.db_boltlink.prepare(insert).bind("sr-scheduled", "https://example.com/s", 0, null, "2099-01-01T00:00:00.000Z", "302", null, 0, null, null, 0, null, 50, 0, 0, 0, 0, null, 1).run();
		await env.db_boltlink.prepare(insert).bind("sr-expired", "https://example.com/e", 2, "2001-01-01T00:00:00.000Z", null, "302", null, 0, null, null, 0, null, 50, 0, 0, 0, 0, null, 3).run();
		await env.db_boltlink.prepare(insert).bind("sr-ab-active", "https://example.com/a", 11, null, null, "302", null, 0, null, null, 1, "https://example.com/b", 40, 3, 1, 4, 6, "2026-02-01T00:00:00.000Z", 5).run();
		await env.db_boltlink.prepare(insert).bind("sr-ab-history", "https://example.com/h", 12, null, null, "302", null, 0, null, null, 0, "https://example.com/hb", 60, 5, 2, 7, 8, "2026-01-01T00:00:00.000Z", 6).run();

		const selectAll = "SELECT slug, target_url, clicks_total, expires_at, go_live_at, redirect_type, tags, has_qrcode, group_id, password_hash, ab_enabled, ab_target_url, ab_weight_b, ab_generation, metric_epoch, ab_clicks_a, ab_clicks_b, ab_started_at, version FROM links ORDER BY slug";
		const before = await env.db_boltlink.prepare(selectAll).all<Record<string, unknown>>();

		await applySchema(migration0005);

		const after = await env.db_boltlink.prepare(selectAll).all<Record<string, unknown>>();
		expect(after.results).toEqual(before.results);

		const routing = await env.db_boltlink
			.prepare("SELECT COUNT(*) AS total, COUNT(smart_routing_rules) AS configured FROM links")
			.first<{ total: number; configured: number }>();
		expect(routing).toMatchObject({ total: 7, configured: 0 });
	});
});

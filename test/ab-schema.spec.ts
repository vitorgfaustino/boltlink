/*
 * Copyright (c) 2026 Vitor Faustino
 * AGPL-3.0 License — https://github.com/vitorgfaustino/boltlink
 *
 * Installation coverage: versioned migrations are the only schema authority.
 * The runtime never creates tables or A/B columns; an empty database fails
 * closed until migrations are applied, and the full catalog (baseline or
 * 0000 -> 0004) prepares a clean install without duplicate columns.
 */

import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import schemaBaseline from "../schema.sql";
import migration0000 from "../migrations/0000_initial_schema.sql";
import migration0001 from "../migrations/0001_link_management.sql";
import migration0002 from "../migrations/0002_advanced_features.sql";
import migration0003 from "../migrations/0003_lgpd_minimization.sql";
import migration0004 from "../migrations/0004_ab_testing.sql";

const AB_COLUMNS = ["ab_enabled", "ab_target_url", "ab_weight_b", "ab_generation", "metric_epoch", "ab_clicks_a", "ab_clicks_b", "ab_started_at"];
const CHAIN = [schemaBaseline, migration0000, migration0001, migration0002, migration0003, migration0004];

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

async function tableColumns() {
	const info = await env.db_boltlink.prepare("PRAGMA table_info(links)").all<{ name: string }>();
	return new Set((info.results ?? []).map((column) => column.name));
}

async function schemaObject(name: string) {
	return env.db_boltlink
		.prepare("SELECT name FROM sqlite_master WHERE name = ?")
		.bind(name)
		.first<{ name: string }>();
}

async function fetchWorker(url: string, init?: RequestInit, overrides?: Partial<Env>) {
	const request = new Request(url, init);
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, { ...env, ...overrides }, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

async function dropEverything() {
	await env.db_boltlink.prepare("DROP VIEW IF EXISTS boltlink_metric_fence").run();
	await env.db_boltlink.prepare("DROP TABLE IF EXISTS link_groups").run();
	await env.db_boltlink.prepare("DROP TABLE IF EXISTS links").run();
}

describe("Schema installation contract", () => {
	it("fails closed with 503 on an empty database and creates nothing", async () => {
		await dropEverything();
		const handle = cloneDbHandle(env.db_boltlink);

		const apiResponse = await fetchWorker("http://127.0.0.1/api/links", undefined, { db_boltlink: handle });
		expect(apiResponse.status).toBe(503);
		expect(await apiResponse.json()).toEqual({ error: "Database schema is not initialized" });

		const redirectResponse = await fetchWorker("https://example.com/missing-link", { headers: { "user-agent": "Mozilla/5.0" } }, { db_boltlink: handle });
		expect(redirectResponse.status).toBe(503);
		expect(await redirectResponse.text()).toBe("Database schema is not initialized");

		expect(await schemaObject("links")).toBeNull();
		expect(await schemaObject("boltlink_metric_fence")).toBeNull();
	});

	it("applies the full migration chain on an empty database without duplicate columns", async () => {
		await dropEverything();

		for (const migration of [migration0000, migration0001, migration0002, migration0003, migration0004]) {
			await applySchema(migration);
		}

		const columns = await tableColumns();
		for (const column of AB_COLUMNS) {
			expect(columns.has(column)).toBe(true);
		}

		const capabilities = await fetchWorker("http://127.0.0.1/api/capabilities");
		expect(await capabilities.json()).toEqual({ abTesting: true });

		const createResponse = await fetchWorker("http://127.0.0.1/api/links", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ slug: "fresh-link", targetUrl: "https://example.com/fresh" }),
		});
		expect(createResponse.status).toBe(201);
		const payload = (await createResponse.json()) as { link: Record<string, unknown> };
		expect(payload.link).toMatchObject({
			ab_enabled: 0,
			ab_target_url: null,
			ab_weight_b: 50,
			ab_generation: 0,
			ab_clicks_a: 0,
			ab_clicks_b: 0,
			ab_started_at: null,
		});
	});

	it("accepts the documented baseline followed by the migration chain", async () => {
		await dropEverything();

		for (const sql of CHAIN) {
			await applySchema(sql);
		}

		const columns = await tableColumns();
		for (const column of AB_COLUMNS) {
			expect(columns.has(column)).toBe(true);
		}

		const handle = cloneDbHandle(env.db_boltlink);
		const capabilities = await fetchWorker("http://127.0.0.1/api/capabilities", undefined, { db_boltlink: handle });
		expect(await capabilities.json()).toEqual({ abTesting: true });
	});
});

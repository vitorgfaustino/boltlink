/*
 * Copyright (c) 2026 Vitor Faustino
 * AGPL-3.0 License — https://github.com/vitorgfaustino/boltlink
 *
 * Legacy schema coverage under the migration-ownership contract: the runtime
 * ignores extra legacy columns/tables, never rebuilds `links`, never creates
 * A/B columns and never leaves the fence projection pointing at `links_legacy`.
 */

import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import migration0004 from "../migrations/0004_ab_testing.sql";

const AB_COLUMNS = ["ab_enabled", "ab_target_url", "ab_weight_b", "ab_generation", "metric_epoch", "ab_clicks_a", "ab_clicks_b", "ab_started_at"];

type FullRow = {
	id: number;
	slug: string;
	target_url: string;
	clicks_total: number;
	disabled_at: string | null;
	expires_at: string | null;
	go_live_at: string | null;
	redirect_type: string | null;
	tags: string | null;
	has_qrcode: number | null;
	group_id: number | null;
	password_hash: string | null;
	version: number;
	ab_enabled: number | null;
	ab_target_url: string | null;
	ab_weight_b: number | null;
	ab_generation: number | null;
	metric_epoch: number | null;
	ab_clicks_a: number | null;
	ab_clicks_b: number | null;
	ab_started_at: string | null;
};

const FULL_SCHEMA_WITH_LEGACY_MARKER = `CREATE TABLE links (
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
	version INTEGER NOT NULL DEFAULT 1,
	last_clicked_at TEXT
)`;

const LEGACY_SCHEMA_WITH_MARKER = `CREATE TABLE links (
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
	version INTEGER NOT NULL DEFAULT 1,
	last_clicked_at TEXT
)`;

const PARTIAL_SCHEMA_WITH_MARKER = `CREATE TABLE links (
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
	version INTEGER NOT NULL DEFAULT 1,
	last_clicked_at TEXT
)`;

const LINK_GROUPS_DDL = `CREATE TABLE IF NOT EXISTS link_groups (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL,
	parent_id INTEGER,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	FOREIGN KEY (parent_id) REFERENCES link_groups(id) ON DELETE SET NULL
)`;

const FULL_ROW_SELECT = "SELECT id, slug, target_url, clicks_total, disabled_at, expires_at, go_live_at, redirect_type, tags, has_qrcode, group_id, password_hash, version, ab_enabled, ab_target_url, ab_weight_b, ab_generation, metric_epoch, ab_clicks_a, ab_clicks_b, ab_started_at FROM links WHERE slug = ?";
const HUMAN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/91.0";

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

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
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

async function resetTables() {
	await env.db_boltlink.prepare("DROP VIEW IF EXISTS boltlink_metric_fence").run();
	await env.db_boltlink.prepare("DROP TABLE IF EXISTS link_groups").run();
	await env.db_boltlink.prepare("DROP TABLE IF EXISTS stats").run();
	await env.db_boltlink.prepare("DROP TABLE IF EXISTS links").run();
}

async function tableColumns() {
	const info = await env.db_boltlink.prepare("PRAGMA table_info(links)").all<{ name: string }>();
	return new Set((info.results ?? []).map((column) => column.name));
}

async function tableExists(name: string) {
	return env.db_boltlink
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
		.bind(name)
		.first<{ name: string }>();
}

async function fenceViewSql() {
	const row = await env.db_boltlink
		.prepare("SELECT sql FROM sqlite_master WHERE type = 'view' AND name = ?")
		.bind("boltlink_metric_fence")
		.first<{ sql: string | null }>();
	return row?.sql ?? null;
}

async function fenceViewIsSelectable() {
	const result = await env.db_boltlink.prepare("SELECT * FROM boltlink_metric_fence LIMIT 1").all();
	return Boolean(result.success);
}

async function triggerRuntime(handle: D1Database) {
	const request = new Request("http://127.0.0.1/api/links");
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, { ...env, db_boltlink: handle }, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

async function fetchWorker(url: string, init?: RequestInit) {
	const request = new Request(url, init);
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

/**
 * Forces the BL-AB-015 interleaving point and gates it before execution.
 * - New runtime: the only projection DDL is `CREATE VIEW IF NOT EXISTS`, gated.
 * - Old rebuild runtime: `ALTER TABLE links RENAME TO links_legacy` is gated,
 *   so the test can apply migration 0004 while the rebuild is suspended and
 *   then let the rename rewrite the freshly promoted view to `links_legacy`.
 */
function gateLegacyRebuildOrViewDdl(db: D1Database, gate: Promise<void>) {
	let resolveReached!: () => void;
	const reached = new Promise<void>((r) => {
		resolveReached = r;
	});
	const executed: string[] = [];
	let gated = false;

	const handle = new Proxy(db, {
		get(target, prop) {
			if (prop !== "prepare") {
				return passThrough(target, prop);
			}

			return (sql: string) => {
				const statement = target.prepare(sql);
				const isRename = sql.startsWith("ALTER TABLE links RENAME");
				const isViewDdl = sql.startsWith("CREATE VIEW") && sql.includes("boltlink_metric_fence");
				if (!isRename && !isViewDdl) {
					return statement;
				}

				if (!gated) {
					gated = true;
					resolveReached();
				}

				return new Proxy(statement, {
					get(st, statementProp) {
						if (statementProp !== "run") {
							return passThrough(st, statementProp);
						}
						return async () => {
							await gate;
							executed.push(sql);
							return (st as unknown as { run: () => Promise<unknown> }).run();
						};
					},
				});
			};
		},
	}) as D1Database;
	return { db: handle, reached, executed };
}

describe("Legacy schema compatibility without runtime rebuild", () => {
	it("ignores extra legacy columns and preserves complete A/B state", async () => {
		await resetTables();
		await env.db_boltlink.prepare(FULL_SCHEMA_WITH_LEGACY_MARKER).run();
		await env.db_boltlink.prepare(LINK_GROUPS_DDL).run();
		await env.db_boltlink
			.prepare(
				`INSERT INTO links (
					slug, target_url, clicks_total, disabled_at, expires_at, go_live_at, redirect_type, tags,
					has_qrcode, group_id, password_hash, ab_enabled, ab_target_url, ab_weight_b, ab_generation,
					metric_epoch, ab_clicks_a, ab_clicks_b, ab_started_at, version
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				"ab-rebuild",
				"https://example.com/a",
				11,
				null,
				"2027-01-01T00:00:00.000Z",
				"2026-01-01T00:00:00.000Z",
				"302",
				JSON.stringify(["rebuild"]),
				1,
				null,
				"hash:salt",
				1,
				"https://example.com/b",
				40,
				7,
				3,
				4,
				6,
				"2026-02-01T00:00:00.000Z",
				5,
			)
			.run();

		const before = await env.db_boltlink.prepare(FULL_ROW_SELECT).bind("ab-rebuild").first<FullRow>();

		const handle = cloneDbHandle(env.db_boltlink);
		expect((await triggerRuntime(handle)).status).toBe(200);

		const columns = await tableColumns();
		for (const column of AB_COLUMNS) {
			expect(columns.has(column)).toBe(true);
		}
		expect(columns.has("last_clicked_at")).toBe(true);

		const after = await env.db_boltlink.prepare(FULL_ROW_SELECT).bind("ab-rebuild").first<FullRow>();
		expect(after).toEqual(before);
		expect(after).toMatchObject({ clicks_total: 11, password_hash: "hash:salt", version: 5, metric_epoch: 3 });

		expect(await tableExists("links_legacy")).toBeNull();
		expect(await fenceViewSql()).not.toMatch(/0\s+AS\s+metric_epoch/i);
		expect(await fenceViewIsSelectable()).toBe(true);
	});

	it("keeps legacy columns and the stats table while normal links keep working", async () => {
		await resetTables();
		await env.db_boltlink.prepare(LEGACY_SCHEMA_WITH_MARKER).run();
		await env.db_boltlink.prepare(LINK_GROUPS_DDL).run();
		await env.db_boltlink.prepare("CREATE TABLE stats (id INTEGER PRIMARY KEY, payload TEXT)").run();
		await env.db_boltlink.prepare("INSERT INTO stats (payload) VALUES ('legacy')").run();
		await env.db_boltlink
			.prepare("INSERT INTO links (slug, target_url, clicks_total, version) VALUES (?, ?, ?, ?)")
			.bind("legacy-rebuild", "https://example.com/legacy", 0, 2)
			.run();

		const handle = cloneDbHandle(env.db_boltlink);
		expect((await triggerRuntime(handle)).status).toBe(200);

		const columns = await tableColumns();
		expect(columns.has("last_clicked_at")).toBe(true);
		for (const column of AB_COLUMNS) {
			expect(columns.has(column)).toBe(false);
		}
		expect(await tableExists("stats")).not.toBeNull();
		expect(await tableExists("links_legacy")).toBeNull();
		expect(await fenceViewSql()).toMatch(/0\s+AS\s+metric_epoch/i);
		expect(await fenceViewIsSelectable()).toBe(true);

		const created = await fetchWorker("http://localhost/api/links", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ slug: "legacy-new", targetUrl: "https://example.com/new" }),
		});
		expect(created.status).toBe(201);

		const clickCtx = createExecutionContext();
		const click = await worker.fetch(new Request("https://example.com/legacy-rebuild", { headers: { "user-agent": HUMAN_UA } }), env, clickCtx);
		await waitOnExecutionContext(clickCtx);
		expect(click.status).toBe(302);
		const row = await env.db_boltlink.prepare("SELECT clicks_total, version FROM links WHERE slug = ?").bind("legacy-rebuild").first<{ clicks_total: number; version: number }>();
		expect(row).toMatchObject({ clicks_total: 1, version: 2 });

		// The migration still applies cleanly after the legacy runtime use (BL-AB-003).
		for (const statement of splitStatements(migration0004)) {
			await env.db_boltlink.prepare(statement).run();
		}
		const migratedColumns = await tableColumns();
		for (const column of AB_COLUMNS) {
			expect(migratedColumns.has(column)).toBe(true);
		}
		expect(migratedColumns.has("last_clicked_at")).toBe(true);
		expect(await fenceViewSql()).not.toMatch(/0\s+AS\s+metric_epoch/i);
		expect(await fenceViewIsSelectable()).toBe(true);
	});

	it("never completes a partial A/B schema nor mutates legacy columns", async () => {
		await resetTables();
		await env.db_boltlink.prepare(PARTIAL_SCHEMA_WITH_MARKER).run();
		await env.db_boltlink.prepare(LINK_GROUPS_DDL).run();
		await env.db_boltlink
			.prepare("INSERT INTO links (slug, target_url, clicks_total, ab_enabled, version) VALUES (?, ?, ?, ?, ?)")
			.bind("partial-rebuild", "https://example.com/partial", 3, 1, 4)
			.run();

		const handle = cloneDbHandle(env.db_boltlink);
		expect((await triggerRuntime(handle)).status).toBe(200);

		const columns = await tableColumns();
		expect(columns.has("ab_enabled")).toBe(true);
		for (const column of AB_COLUMNS.filter((name) => name !== "ab_enabled")) {
			expect(columns.has(column)).toBe(false);
		}
		expect(columns.has("last_clicked_at")).toBe(true);
		expect(await fenceViewSql()).toMatch(/0\s+AS\s+metric_epoch/i);
		expect(await fenceViewIsSelectable()).toBe(true);

		const row = await env.db_boltlink
			.prepare("SELECT clicks_total, ab_enabled, version FROM links WHERE slug = ?")
			.bind("partial-rebuild")
			.first<{ clicks_total: number; ab_enabled: number; version: number }>();
		expect(row).toMatchObject({ clicks_total: 3, ab_enabled: 1, version: 4 });
	});

	it("keeps the fence projection and a valid click when migration interleaves with legacy reconciliation", async () => {
		await resetTables();
		await env.db_boltlink.prepare(LEGACY_SCHEMA_WITH_MARKER).run();
		await env.db_boltlink.prepare(LINK_GROUPS_DDL).run();
		await env.db_boltlink
			.prepare("INSERT INTO links (slug, target_url, clicks_total, version) VALUES (?, ?, ?, ?)")
			.bind("stale-rebuild", "https://example.com/stale", 0, 3)
			.run();

		const gate = deferred();
		const gated = gateLegacyRebuildOrViewDdl(cloneDbHandle(env.db_boltlink), gate.promise);
		const ctx = createExecutionContext();
		const pending = worker.fetch(
			new Request("https://example.com/stale-rebuild", { headers: { "user-agent": HUMAN_UA } }),
			{ ...env, db_boltlink: gated.db },
			ctx,
		);
		await gated.reached;

		// Migration promotes the projection while reconciliation is suspended
		// exactly where the old rebuild used to allow the interleaving.
		for (const statement of splitStatements(migration0004)) {
			await env.db_boltlink.prepare(statement).run();
		}

		gate.resolve();
		const response = await pending;
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(302);
		expect(await tableExists("links_legacy")).toBeNull();
		expect(await fenceViewSql()).not.toMatch(/0\s+AS\s+metric_epoch/i);
		expect(await fenceViewIsSelectable()).toBe(true);

		const row = await env.db_boltlink
			.prepare("SELECT clicks_total, metric_epoch, version FROM links WHERE slug = ?")
			.bind("stale-rebuild")
			.first<{ clicks_total: number; metric_epoch: number; version: number }>();
		expect(row).toMatchObject({ clicks_total: 1, metric_epoch: 0, version: 3 });
	});
});

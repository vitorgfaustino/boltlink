/*
 * Copyright (c) 2026 Vitor Faustino
 * AGPL-3.0 License — https://github.com/vitorgfaustino/boltlink
 *
 * Migration coverage: runtime reconciliation must not pre-apply migration
 * 0004, so the migration history stays executable on baseline installs.
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

const AB_COLUMNS = ["ab_enabled", "ab_target_url", "ab_weight_b", "ab_generation", "metric_epoch", "ab_clicks_a", "ab_clicks_b", "ab_started_at"];

const LEGACY_LINKS_DDL = `CREATE TABLE links (
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
)`;

const FULL_AB_LINKS_DDL = `CREATE TABLE links (
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
)`;

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

async function applyStatements(sql: string) {
	for (const statement of splitStatements(sql)) {
		await env.db_boltlink.prepare(statement).run();
	}
}

async function tableColumns() {
	const info = await env.db_boltlink.prepare("PRAGMA table_info(links)").all<{ name: string }>();
	return new Set((info.results ?? []).map((column) => column.name));
}

async function fenceViewSql() {
	const row = await env.db_boltlink
		.prepare("SELECT sql FROM sqlite_master WHERE type = 'view' AND name = ?")
		.bind("boltlink_metric_fence")
		.first<{ sql: string | null }>();
	return row?.sql ?? null;
}

function passThrough(target: object, prop: string | symbol) {
	const value = Reflect.get(target, prop);
	return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
}

/** Fresh bootstrap key so capability detection re-runs for this test. */
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

/** Pauses aggregate metric writes until the gate resolves. */
function deferMetricWrites(db: D1Database, gate: Promise<void>): D1Database {
	return new Proxy(db, {
		get(target, prop) {
			if (prop !== "prepare") {
				return passThrough(target, prop);
			}

			return (sql: string) => {
				const statement = target.prepare(sql);
				if (!sql.includes("CASE WHEN metric_epoch = ?")) {
					return statement;
				}

				return new Proxy(statement, {
					get(st, statementProp) {
						if (statementProp !== "bind") {
							return passThrough(st, statementProp);
						}

						return (...args: unknown[]) => {
							const bound = (st as unknown as { bind: (...values: unknown[]) => D1PreparedStatement }).bind(...args);
							return new Proxy(bound, {
								get(bs, boundProp) {
									if (boundProp === "run") {
										return async () => {
											await gate;
											return (bs as unknown as { run: () => Promise<unknown> }).run();
										};
									}
									return passThrough(bs, boundProp);
								},
							});
						};
					},
				});
			};
		},
	}) as D1Database;
}

const HUMAN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/91.0";

describe("A/B schema migration", () => {
	it("applies the 0004 migration file to a baseline table without losing rows", async () => {
		await env.db_boltlink.prepare("DROP TABLE IF EXISTS links").run();
		await env.db_boltlink.prepare("DROP VIEW IF EXISTS boltlink_metric_fence").run();
		await env.db_boltlink.prepare(LEGACY_LINKS_DDL).run();
		await env.db_boltlink
			.prepare("INSERT INTO links (slug, target_url, clicks_total) VALUES (?, ?, ?)")
			.bind("migrated-link", "https://example.com/migrated", 3)
			.run();

		await applyStatements(migration0004);

		const columns = await tableColumns();
		for (const column of AB_COLUMNS) {
			expect(columns.has(column)).toBe(true);
		}

		const row = await env.db_boltlink
			.prepare("SELECT clicks_total, ab_enabled, ab_target_url, ab_weight_b, ab_generation, metric_epoch, ab_clicks_a, ab_clicks_b, ab_started_at FROM links WHERE slug = ?")
			.bind("migrated-link")
			.first<{ clicks_total: number; ab_enabled: number; ab_target_url: string | null; ab_weight_b: number; ab_generation: number; metric_epoch: number; ab_clicks_a: number; ab_clicks_b: number; ab_started_at: string | null }>();
		expect(row).toMatchObject({
			clicks_total: 3,
			ab_enabled: 0,
			ab_target_url: null,
			ab_weight_b: 50,
			ab_generation: 0,
			metric_epoch: 0,
			ab_clicks_a: 0,
			ab_clicks_b: 0,
			ab_started_at: null,
		});
	});

	it("keeps normal links working when runtime runs before 0004 and lets the migration apply afterwards", async () => {
		await env.db_boltlink.prepare("DROP TABLE IF EXISTS links").run();
		await env.db_boltlink.prepare("DROP VIEW IF EXISTS boltlink_metric_fence").run();
		await env.db_boltlink.prepare(LEGACY_LINKS_DDL).run();
		await env.db_boltlink
			.prepare("INSERT INTO links (slug, target_url, clicks_total) VALUES (?, ?, ?)")
			.bind("legacy-link", "https://example.com/legacy", 7)
			.run();

		const request = new Request("https://example.com/legacy-link", { headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/91.0" } });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("https://example.com/legacy");

		const runtimeColumns = await tableColumns();
		for (const column of AB_COLUMNS) {
			expect(runtimeColumns.has(column)).toBe(false);
		}

		const capabilitiesPre = await worker.fetch(new Request("http://127.0.0.1/api/capabilities"), env, createExecutionContext());
		expect(await capabilitiesPre.json()).toEqual({ abTesting: false, smartRouting: false });

		// Real admin payload for a normal link: no A/B fields at all.
		const normalCreateCtx = createExecutionContext();
		const normalCreate = await worker.fetch(
			new Request("http://localhost/api/links", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ slug: "normal-pre", targetUrl: "https://example.com/normal" }),
			}),
			env,
			normalCreateCtx,
		);
		await waitOnExecutionContext(normalCreateCtx);
		expect(normalCreate.status).toBe(201);

		const normalPatchCtx = createExecutionContext();
		const normalPatch = await worker.fetch(
			new Request("http://localhost/api/links/normal-pre", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ targetUrl: "https://example.com/normal-updated" }),
			}),
			env,
			normalPatchCtx,
		);
		await waitOnExecutionContext(normalPatchCtx);
		expect(normalPatch.status).toBe(200);

		const blockedConfig = await worker.fetch(
			new Request("http://localhost/api/links", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ slug: "blocked-ab", targetUrl: "https://example.com/a", abEnabled: true, abTargetUrl: "https://example.com/b" }),
			}),
			env,
			createExecutionContext(),
		);
		expect(blockedConfig.status).toBe(400);
		expect(((await blockedConfig.json()) as { error: string }).error).toContain("0004");

		// The exact sequence that used to fail with "duplicate column name".
		await applyStatements(migration0004);

		const migratedColumns = await tableColumns();
		for (const column of AB_COLUMNS) {
			expect(migratedColumns.has(column)).toBe(true);
		}

		const capabilitiesPost = await worker.fetch(new Request("http://127.0.0.1/api/capabilities"), env, createExecutionContext());
		expect(await capabilitiesPost.json()).toEqual({ abTesting: true, smartRouting: false });

		const legacyRow = await env.db_boltlink
			.prepare("SELECT clicks_total, ab_enabled, ab_target_url, ab_weight_b, ab_generation, metric_epoch, ab_clicks_a, ab_clicks_b, ab_started_at FROM links WHERE slug = ?")
			.bind("legacy-link")
			.first<{ clicks_total: number; ab_enabled: number; ab_target_url: string | null; ab_weight_b: number; ab_generation: number; metric_epoch: number; ab_clicks_a: number; ab_clicks_b: number; ab_started_at: string | null }>();

		expect(legacyRow).toMatchObject({
			clicks_total: 8,
			ab_enabled: 0,
			ab_target_url: null,
			ab_weight_b: 50,
			ab_generation: 0,
			metric_epoch: 0,
			ab_clicks_a: 0,
			ab_clicks_b: 0,
			ab_started_at: null,
		});
	});

	it("runs the full migration chain on a clean database", async () => {
		await env.db_boltlink.prepare("DROP TABLE IF EXISTS links").run();
		await env.db_boltlink.prepare("DROP TABLE IF EXISTS link_groups").run();
		await env.db_boltlink.prepare("DROP VIEW IF EXISTS boltlink_metric_fence").run();

		for (const migration of [migration0000, migration0001, migration0002, migration0003, migration0004, migration0005]) {
			await applyStatements(migration);
		}

		const columns = await tableColumns();
		for (const column of AB_COLUMNS) {
			expect(columns.has(column)).toBe(true);
		}
	});

	it("does not initialize an empty database at runtime and lets the full catalog apply", async () => {
		await env.db_boltlink.prepare("DROP VIEW IF EXISTS boltlink_metric_fence").run();
		await env.db_boltlink.prepare("DROP TABLE IF EXISTS link_groups").run();
		await env.db_boltlink.prepare("DROP TABLE IF EXISTS links").run();

		const handle = cloneDbHandle(env.db_boltlink);
		const blockedCtx = createExecutionContext();
		const blocked = await worker.fetch(new Request("http://127.0.0.1/api/links"), { ...env, db_boltlink: handle }, blockedCtx);
		await waitOnExecutionContext(blockedCtx);
		expect(blocked.status).toBe(503);
		expect(await blocked.json()).toEqual({ error: "Database schema is not initialized" });

		const untouched = await tableColumns();
		expect(untouched.size).toBe(0);

		for (const migration of [migration0000, migration0001, migration0002, migration0003, migration0004, migration0005]) {
			await applyStatements(migration);
		}

		const migrated = await tableColumns();
		for (const column of AB_COLUMNS) {
			expect(migrated.has(column)).toBe(true);
		}

		// The same handle recovers without a restart once migrations are applied.
		const capabilityCtx = createExecutionContext();
		const capability = await worker.fetch(new Request("http://127.0.0.1/api/capabilities"), { ...env, db_boltlink: handle }, capabilityCtx);
		await waitOnExecutionContext(capabilityCtx);
		expect(await capability.json()).toEqual({ abTesting: true, smartRouting: true });
	});

	it("treats a partial A/B column set as not ready without adding columns or losing data", async () => {
		await env.db_boltlink.prepare("DROP TABLE IF EXISTS links").run();
		await env.db_boltlink.prepare("DROP VIEW IF EXISTS boltlink_metric_fence").run();
		await env.db_boltlink.prepare(LEGACY_LINKS_DDL).run();
		await env.db_boltlink.prepare("ALTER TABLE links ADD COLUMN ab_enabled INTEGER NOT NULL DEFAULT 0").run();
		await env.db_boltlink
			.prepare("INSERT INTO links (slug, target_url, clicks_total) VALUES (?, ?, ?)")
			.bind("partial-link", "https://example.com/partial", 2)
			.run();

		const dbHandle = cloneDbHandle(env.db_boltlink);
		const request = new Request("https://example.com/partial-link", { headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/91.0" } });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, { ...env, db_boltlink: dbHandle }, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("https://example.com/partial");

		const columns = await tableColumns();
		expect(columns.has("ab_enabled")).toBe(true);
		for (const column of AB_COLUMNS.filter((name) => name !== "ab_enabled")) {
			expect(columns.has(column)).toBe(false);
		}

		const row = await env.db_boltlink
			.prepare("SELECT clicks_total, ab_enabled FROM links WHERE slug = ?")
			.bind("partial-link")
			.first<{ clicks_total: number; ab_enabled: number }>();
		expect(row).toMatchObject({ clicks_total: 3, ab_enabled: 0 });

		const blockedConfig = await worker.fetch(
			new Request("http://localhost/api/links", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ slug: "blocked-partial", targetUrl: "https://example.com/a", abEnabled: true, abTargetUrl: "https://example.com/b" }),
			}),
			{ ...env, db_boltlink: dbHandle },
			createExecutionContext(),
		);
		expect(blockedConfig.status).toBe(400);

		const capabilitiesPartial = await worker.fetch(
			new Request("http://127.0.0.1/api/capabilities"),
			{ ...env, db_boltlink: dbHandle },
			createExecutionContext(),
		);
		expect(await capabilitiesPartial.json()).toEqual({ abTesting: false, smartRouting: false });
	});

	it("re-detects capabilities on an existing handle after 0004 is applied", async () => {
		await env.db_boltlink.prepare("DROP TABLE IF EXISTS links").run();
		await env.db_boltlink.prepare("DROP VIEW IF EXISTS boltlink_metric_fence").run();
		await env.db_boltlink.prepare(LEGACY_LINKS_DDL).run();
		await env.db_boltlink
			.prepare("INSERT INTO links (slug, target_url, clicks_total) VALUES (?, ?, ?)")
			.bind("cap-link", "https://example.com/cap", 1)
			.run();

		// Handle A starts before the migration and observes a negative capability.
		const handle = cloneDbHandle(env.db_boltlink);
		const firstCtx = createExecutionContext();
		const first = await worker.fetch(
			new Request("https://example.com/cap-link", { headers: { "user-agent": HUMAN_UA } }),
			{ ...env, db_boltlink: handle },
			firstCtx,
		);
		await waitOnExecutionContext(firstCtx);
		expect(first.status).toBe(302);

		const preColumns = await tableColumns();
		for (const column of AB_COLUMNS) {
			expect(preColumns.has(column)).toBe(false);
		}

		await applyStatements(migration0004);

		// The migration owns the promotion SHIM -> REAL; the old handle must not
		// be able to downgrade it when it re-detects capabilities.
		const migratedView = await fenceViewSql();
		expect(migratedView).not.toBeNull();
		expect(migratedView ?? "").toContain("metric_epoch");
		expect(migratedView ?? "").not.toMatch(/0\s+AS\s+metric_epoch/i);

		// The same handle now discovers A/B without a process restart.
		const configCtx = createExecutionContext();
		const config = await worker.fetch(
			new Request("http://localhost/api/links/cap-link", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ abEnabled: true, abTargetUrl: "https://example.com/cap-b" }),
			}),
			{ ...env, db_boltlink: handle },
			configCtx,
		);
		await waitOnExecutionContext(configCtx);
		expect(config.status).toBe(200);

		const capabilityCtx = createExecutionContext();
		const capability = await worker.fetch(
			new Request("http://127.0.0.1/api/capabilities"),
			{ ...env, db_boltlink: handle },
			capabilityCtx,
		);
		expect(await capability.json()).toEqual({ abTesting: true, smartRouting: false });

		const clickCtx = createExecutionContext();
		const click = await worker.fetch(
			new Request("https://example.com/cap-link", { headers: { "user-agent": HUMAN_UA } }),
			{ ...env, db_boltlink: handle },
			clickCtx,
		);
		await waitOnExecutionContext(clickCtx);
		expect(click.status).toBe(302);

		const row = await env.db_boltlink
			.prepare("SELECT clicks_total, ab_enabled, ab_generation, ab_clicks_a, ab_clicks_b FROM links WHERE slug = ?")
			.bind("cap-link")
			.first<{ clicks_total: number; ab_enabled: number; ab_generation: number; ab_clicks_a: number; ab_clicks_b: number }>();
		expect(row?.ab_enabled).toBe(1);
		expect(row?.ab_generation).toBe(1);
		expect(row?.clicks_total).toBe(3);
		expect((row?.ab_clicks_a ?? 0) + (row?.ab_clicks_b ?? 0)).toBe(1);
		expect(await fenceViewSql()).toBe(migratedView);
	});

	it("fences a delayed metric write when the reset happens on another handle", async () => {
		await env.db_boltlink.prepare("DROP TABLE IF EXISTS links").run();
		await env.db_boltlink.prepare(FULL_AB_LINKS_DDL).run();
		await env.db_boltlink
			.prepare(
				`INSERT INTO links (slug, target_url, clicks_total, ab_enabled, ab_target_url, ab_weight_b, ab_generation, metric_epoch)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind("reset-handle", "https://example.com/reset-a", 0, 1, "https://example.com/reset-b", 50, 1, 0)
			.run();

		const gate = deferred();
		const clickHandle = deferMetricWrites(cloneDbHandle(env.db_boltlink), gate.promise);
		const clickCtx = createExecutionContext();
		const click = await worker.fetch(
			new Request("https://example.com/reset-handle", { headers: { "user-agent": HUMAN_UA } }),
			{ ...env, db_boltlink: clickHandle },
			clickCtx,
		);
		expect(click.status).toBe(302);

		const resetCtx = createExecutionContext();
		const reset = await worker.fetch(
			new Request("http://localhost/api/links/reset-handle/reset-clicks", { method: "POST" }),
			env,
			resetCtx,
		);
		await waitOnExecutionContext(resetCtx);
		expect(reset.status).toBe(200);

		gate.resolve();
		await waitOnExecutionContext(clickCtx);

		const row = await env.db_boltlink
			.prepare("SELECT clicks_total, ab_clicks_a, ab_clicks_b FROM links WHERE slug = ?")
			.bind("reset-handle")
			.first<{ clicks_total: number; ab_clicks_a: number; ab_clicks_b: number }>();
		expect(row).toMatchObject({ clicks_total: 0, ab_clicks_a: 0, ab_clicks_b: 0 });
	});
});

/*
 * Copyright (c) 2026 Vitor Faustino
 * AGPL-3.0 License — https://github.com/vitorgfaustino/boltlink
 *
 * Transition coverage: a click captured while the database was still
 * pre-0004 must revalidate the schema before writing. If migration 0004
 * landed (and possibly a reset happened) in the meantime, the delayed write
 * must respect the fenced semantics.
 */

import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import migration0004 from "../migrations/0004_ab_testing.sql";

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

type GateState = { count: number; gateFrom: number };

/** Gates PRAGMA table_info calls from `gateFrom` onwards (capability rechecks). */
function gateCapabilityRechecks(db: D1Database, gate: Promise<void>, state: GateState): D1Database {
	return new Proxy(db, {
		get(target, prop) {
			if (prop !== "prepare") {
				return passThrough(target, prop);
			}

			return (sql: string) => {
				const statement = target.prepare(sql);
				if (!sql.includes("PRAGMA table_info")) {
					return statement;
				}

				const index = (state.count += 1);
				return new Proxy(statement, {
					get(st, statementProp) {
						if (statementProp !== "all") {
							return passThrough(st, statementProp);
						}

						return async (...args: unknown[]) => {
							if (index >= state.gateFrom) {
								await gate;
							}
							return (st as unknown as { all: (...values: unknown[]) => Promise<unknown> }).all(...args);
						};
					},
				});
			};
		},
	}) as D1Database;
}

async function applyMigration0004() {
	for (const statement of migration0004
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.filter((line) => !line.trim().startsWith("--"))
		.join("\n")
		.split(";")
		.map((entry) => entry.trim())
		.filter(Boolean)) {
		await env.db_boltlink.prepare(statement).run();
	}
}

async function setupLegacyLink() {
	await env.db_boltlink.prepare("DROP TABLE IF EXISTS links").run();
	await env.db_boltlink.prepare("DROP TABLE IF EXISTS link_groups").run();
	// Dropping the base table invalidates the projection; the runtime never
	// downgrades it, so a clean reset must drop it too.
	await env.db_boltlink.prepare("DROP VIEW IF EXISTS boltlink_metric_fence").run();
	await env.db_boltlink.prepare(LEGACY_LINKS_DDL).run();
	await env.db_boltlink
		.prepare("INSERT INTO links (slug, target_url, clicks_total) VALUES (?, ?, ?)")
		.bind("transition-link", "https://example.com/transition", 0)
		.run();
}

async function startClick(handle: D1Database, state: GateState) {
	state.gateFrom = state.count + 2;
	const request = new Request("https://example.com/transition-link", { headers: { "user-agent": HUMAN_UA } });
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, { ...env, db_boltlink: handle }, ctx);
	return { response, ctx };
}

type FenceWrite = {
	db: D1Database;
	selected: Promise<string>;
	release: () => void;
};

/**
 * Suspends the already-selected legacy metric UPDATE at `run()` so the test can
 * apply the migration (and a reset) after the SQL was chosen but before it is
 * persisted. The selected SQL text is exposed so each test can assert which
 * branch (projection fence or plain legacy write) was chosen.
 */
function gateSelectedFenceWrite(db: D1Database): FenceWrite {
	let resolveSelected!: (sql: string) => void;
	const selected = new Promise<string>((resolve) => {
		resolveSelected = resolve;
	});
	const gate = deferred();
	let armed = true;

	const handle = new Proxy(db, {
		get(target, prop) {
			if (prop !== "prepare") {
				return passThrough(target, prop);
			}

			return (sql: string) => {
				const statement = target.prepare(sql);
				const isMetricWrite = sql.startsWith("UPDATE links") && sql.includes("clicks_total = clicks_total +");
				if (!isMetricWrite) {
					return statement;
				}

				if (armed) {
					armed = false;
					resolveSelected(sql);
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
											await gate.promise;
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

	return { db: handle, selected, release: gate.resolve };
}

async function warmLegacyHandle(handle: D1Database) {
	const warmCtx = createExecutionContext();
	await worker.fetch(new Request("http://127.0.0.1/api/links"), { ...env, db_boltlink: handle }, warmCtx);
	await waitOnExecutionContext(warmCtx);
}

async function resetTransitionLink() {
	const resetCtx = createExecutionContext();
	const reset = await worker.fetch(
		new Request("http://localhost/api/links/transition-link/reset-clicks", { method: "POST" }),
		env,
		resetCtx,
	);
	await waitOnExecutionContext(resetCtx);
	return reset;
}

async function enableTransitionAb() {
	const patchCtx = createExecutionContext();
	const patch = await worker.fetch(
		new Request("http://localhost/api/links/transition-link", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ abEnabled: true, abTargetUrl: "https://example.com/transition-b" }),
		}),
		env,
		patchCtx,
	);
	await waitOnExecutionContext(patchCtx);
	return patch;
}

async function readTransitionClicks() {
	return env.db_boltlink
		.prepare("SELECT clicks_total FROM links WHERE slug = ?")
		.bind("transition-link")
		.first<{ clicks_total: number }>();
}

async function readTransitionRow() {
	return env.db_boltlink
		.prepare("SELECT clicks_total, ab_enabled, ab_generation, metric_epoch, ab_clicks_a, ab_clicks_b FROM links WHERE slug = ?")
		.bind("transition-link")
		.first<{ clicks_total: number; ab_enabled: number; ab_generation: number; metric_epoch: number; ab_clicks_a: number; ab_clicks_b: number }>();
}

async function readFenceViewSql() {
	const row = await env.db_boltlink
		.prepare("SELECT sql FROM sqlite_master WHERE type = 'view' AND name = ?")
		.bind("boltlink_metric_fence")
		.first<{ sql: string | null }>();
	return row?.sql ?? null;
}

const SHIM_MARKER = /0\s+AS\s+metric_epoch/i;

async function expectShimView() {
	const sql = await readFenceViewSql();
	expect(sql).not.toBeNull();
	expect(sql ?? "").toMatch(SHIM_MARKER);
}

async function expectRealView() {
	const sql = await readFenceViewSql();
	expect(sql).not.toBeNull();
	expect(sql ?? "").toContain("metric_epoch");
	expect(sql ?? "").not.toMatch(SHIM_MARKER);
}

type StaleBootstrap = {
	db: D1Database;
	reached: Promise<void>;
	executed: string[];
};

/**
 * Suspends a bootstrap after its schema read and immediately before the
 * projection maintenance (view definition read, DROP or CREATE), recording the
 * SQL it eventually executes. Used to prove a pre-0004 bootstrap cannot
 * downgrade a projection promoted by the migration.
 */
function gateBootstrapViewMaintenance(db: D1Database, gate: Promise<void>): StaleBootstrap {
	const executed: string[] = [];
	let resolveReached!: () => void;
	const reached = new Promise<void>((resolve) => {
		resolveReached = resolve;
	});

	const handle = new Proxy(db, {
		get(target, prop) {
			if (prop !== "prepare") {
				return passThrough(target, prop);
			}

			return (sql: string) => {
				const statement = target.prepare(sql);
				const isProjectionMaintenance =
					sql.startsWith("SELECT sql FROM sqlite_master") ||
					(sql.includes("boltlink_metric_fence") && (sql.startsWith("CREATE VIEW") || sql.startsWith("DROP VIEW")));
				if (!isProjectionMaintenance) {
					return statement;
				}

				resolveReached();
				const wrapBound = (bound: D1PreparedStatement) =>
					new Proxy(bound, {
						get(bs, boundProp) {
							if (boundProp === "run") {
								return async () => {
									await gate;
									executed.push(sql);
									return (bs as unknown as { run: () => Promise<unknown> }).run();
								};
							}
							if (boundProp === "first") {
								return async (...args: unknown[]) => {
									await gate;
									executed.push(sql);
									return (bs as unknown as { first: (...values: unknown[]) => Promise<unknown> }).first(...args);
								};
							}
							return passThrough(bs, boundProp);
						},
					});

				return new Proxy(statement, {
					get(st, statementProp) {
						if (statementProp === "bind") {
							return (...args: unknown[]) =>
								wrapBound((st as unknown as { bind: (...values: unknown[]) => D1PreparedStatement }).bind(...args));
						}
						if (statementProp === "run") {
							return async () => {
								await gate;
								executed.push(sql);
								return (st as unknown as { run: () => Promise<unknown> }).run();
							};
						}
						if (statementProp === "first") {
							return async (...args: unknown[]) => {
								await gate;
								executed.push(sql);
								return (st as unknown as { first: (...values: unknown[]) => Promise<unknown> }).first(...args);
							};
						}
						return passThrough(st, statementProp);
					},
				});
			};
		},
	}) as D1Database;

	return { db: handle, reached, executed };
}

function startBootstrap(handle: D1Database) {
	const ctx = createExecutionContext();
	const promise = worker.fetch(new Request("http://127.0.0.1/api/links"), { ...env, db_boltlink: handle }, ctx);
	return { ctx, promise };
}

describe("pre-migration delayed metric transition", () => {
	it("does not resurrect a reset that happened after migration 0004", async () => {
		await setupLegacyLink();
		const gate = deferred();
		const state: GateState = { count: 0, gateFrom: Number.POSITIVE_INFINITY };
		const handle = gateCapabilityRechecks(cloneDbHandle(env.db_boltlink), gate.promise, state);

		// Warm up bootstrap + negative detection without clicking.
		const warmCtx = createExecutionContext();
		await worker.fetch(new Request("http://127.0.0.1/api/links"), { ...env, db_boltlink: handle }, warmCtx);
		await waitOnExecutionContext(warmCtx);

		const { response, ctx } = await startClick(handle, state);
		expect(response.status).toBe(302);

		await applyMigration0004();

		const resetCtx = createExecutionContext();
		const reset = await worker.fetch(
			new Request("http://localhost/api/links/transition-link/reset-clicks", { method: "POST" }),
			env,
			resetCtx,
		);
		await waitOnExecutionContext(resetCtx);
		expect(reset.status).toBe(200);

		gate.resolve();
		await waitOnExecutionContext(ctx);

		const row = await readTransitionRow();
		expect(row).toMatchObject({ clicks_total: 0, metric_epoch: 1, ab_clicks_a: 0, ab_clicks_b: 0 });
	});

	it("counts the delayed click once when migration lands without a reset", async () => {
		await setupLegacyLink();
		const gate = deferred();
		const state: GateState = { count: 0, gateFrom: Number.POSITIVE_INFINITY };
		const handle = gateCapabilityRechecks(cloneDbHandle(env.db_boltlink), gate.promise, state);

		const warmCtx = createExecutionContext();
		await worker.fetch(new Request("http://127.0.0.1/api/links"), { ...env, db_boltlink: handle }, warmCtx);
		await waitOnExecutionContext(warmCtx);

		const { response, ctx } = await startClick(handle, state);
		expect(response.status).toBe(302);

		await applyMigration0004();

		gate.resolve();
		await waitOnExecutionContext(ctx);

		const row = await readTransitionRow();
		expect(row).toMatchObject({ clicks_total: 1, metric_epoch: 0, ab_generation: 0, ab_clicks_a: 0, ab_clicks_b: 0 });
	});

	it("never assigns a pre-migration click to an A/B variant enabled after migration", async () => {
		await setupLegacyLink();
		const gate = deferred();
		const state: GateState = { count: 0, gateFrom: Number.POSITIVE_INFINITY };
		const handle = gateCapabilityRechecks(cloneDbHandle(env.db_boltlink), gate.promise, state);

		const warmCtx = createExecutionContext();
		await worker.fetch(new Request("http://127.0.0.1/api/links"), { ...env, db_boltlink: handle }, warmCtx);
		await waitOnExecutionContext(warmCtx);

		const { response, ctx } = await startClick(handle, state);
		expect(response.status).toBe(302);

		await applyMigration0004();

		const patchCtx = createExecutionContext();
		const patch = await worker.fetch(
			new Request("http://localhost/api/links/transition-link", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ abEnabled: true, abTargetUrl: "https://example.com/transition-b" }),
			}),
			env,
			patchCtx,
		);
		await waitOnExecutionContext(patchCtx);
		expect(patch.status).toBe(200);

		gate.resolve();
		await waitOnExecutionContext(ctx);

		const row = await readTransitionRow();
		expect(row).toMatchObject({ clicks_total: 1, metric_epoch: 0, ab_enabled: 1, ab_generation: 1, ab_clicks_a: 0, ab_clicks_b: 0 });
	});

	it("fences the already-selected legacy write when migration and reset land before run()", async () => {
		await setupLegacyLink();
		const fence = gateSelectedFenceWrite(cloneDbHandle(env.db_boltlink));
		await warmLegacyHandle(fence.db);

		const request = new Request("https://example.com/transition-link", { headers: { "user-agent": HUMAN_UA } });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, { ...env, db_boltlink: fence.db }, ctx);
		expect(response.status).toBe(302);

		// capability=false already returned and the legacy metric UPDATE was selected.
		const selectedSql = await fence.selected;
		expect(selectedSql).toContain("boltlink_metric_fence");

		await applyMigration0004();
		const reset = await resetTransitionLink();
		expect(reset.status).toBe(200);

		const beforeRelease = await readTransitionRow();
		expect(beforeRelease).toMatchObject({ clicks_total: 0, metric_epoch: 1, ab_clicks_a: 0, ab_clicks_b: 0 });

		fence.release();
		await waitOnExecutionContext(ctx);

		const row = await readTransitionRow();
		expect(row).toMatchObject({ clicks_total: 0, metric_epoch: 1, ab_clicks_a: 0, ab_clicks_b: 0 });
	});

	it("counts the already-selected legacy write once when migration lands without a reset", async () => {
		await setupLegacyLink();
		const fence = gateSelectedFenceWrite(cloneDbHandle(env.db_boltlink));
		await warmLegacyHandle(fence.db);

		const request = new Request("https://example.com/transition-link", { headers: { "user-agent": HUMAN_UA } });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, { ...env, db_boltlink: fence.db }, ctx);
		expect(response.status).toBe(302);
		await fence.selected;

		await applyMigration0004();

		fence.release();
		await waitOnExecutionContext(ctx);

		const row = await readTransitionRow();
		expect(row).toMatchObject({ clicks_total: 1, metric_epoch: 0, ab_generation: 0, ab_clicks_a: 0, ab_clicks_b: 0 });
	});

	it("never assigns the already-selected legacy write to a variant enabled after migration", async () => {
		await setupLegacyLink();
		const fence = gateSelectedFenceWrite(cloneDbHandle(env.db_boltlink));
		await warmLegacyHandle(fence.db);

		const request = new Request("https://example.com/transition-link", { headers: { "user-agent": HUMAN_UA } });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, { ...env, db_boltlink: fence.db }, ctx);
		expect(response.status).toBe(302);
		await fence.selected;

		await applyMigration0004();
		const patch = await enableTransitionAb();
		expect(patch.status).toBe(200);

		fence.release();
		await waitOnExecutionContext(ctx);

		const row = await readTransitionRow();
		expect(row).toMatchObject({ clicks_total: 1, metric_epoch: 0, ab_enabled: 1, ab_generation: 1, ab_clicks_a: 0, ab_clicks_b: 0 });
	});

	it("keeps counting a legacy click that is never interrupted by migration 0004", async () => {
		await setupLegacyLink();
		const fence = gateSelectedFenceWrite(cloneDbHandle(env.db_boltlink));
		await warmLegacyHandle(fence.db);

		const request = new Request("https://example.com/transition-link", { headers: { "user-agent": HUMAN_UA } });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, { ...env, db_boltlink: fence.db }, ctx);
		expect(response.status).toBe(302);
		await fence.selected;

		fence.release();
		await waitOnExecutionContext(ctx);

		const row = await readTransitionClicks();
		expect(row).toMatchObject({ clicks_total: 1 });
	});

	it("never downgrades the real projection when a stale pre-migration bootstrap resumes after 0004", async () => {
		await setupLegacyLink();
		const fence = gateSelectedFenceWrite(cloneDbHandle(env.db_boltlink));
		await warmLegacyHandle(fence.db);
		await expectShimView();

		// Delayed legacy click: SQL selected and bound, run() suspended.
		const clickCtx = createExecutionContext();
		const click = await worker.fetch(
			new Request("https://example.com/transition-link", { headers: { "user-agent": HUMAN_UA } }),
			{ ...env, db_boltlink: fence.db },
			clickCtx,
		);
		expect(click.status).toBe(302);
		await fence.selected;

		// Stale bootstrap: schema already read pre-0004, projection DDL suspended.
		const staleGate = deferred();
		const stale = gateBootstrapViewMaintenance(cloneDbHandle(env.db_boltlink), staleGate.promise);
		const staleRequest = startBootstrap(stale.db);
		await stale.reached;

		// Migration promotes SHIM -> REAL while both stale paths are paused.
		await applyMigration0004();
		await expectRealView();

		const reset = await resetTransitionLink();
		expect(reset.status).toBe(200);
		expect(await readTransitionRow()).toMatchObject({ clicks_total: 0, metric_epoch: 1, ab_clicks_a: 0, ab_clicks_b: 0 });

		// Stale bootstrap resumes: its only action must be a no-op IF NOT EXISTS.
		staleGate.resolve();
		await staleRequest.promise;
		await waitOnExecutionContext(staleRequest.ctx);
		await expectRealView();
		expect(stale.executed.some((sql) => sql.startsWith("DROP VIEW"))).toBe(false);
		expect(stale.executed.some((sql) => sql.includes("CREATE VIEW IF NOT EXISTS"))).toBe(true);

		// Old UPDATE resumes: the real projection fences it against the reset.
		fence.release();
		await waitOnExecutionContext(clickCtx);

		const row = await readTransitionRow();
		expect(row).toMatchObject({ clicks_total: 0, metric_epoch: 1, ab_clicks_a: 0, ab_clicks_b: 0 });
		await expectRealView();
	});

	it("never downgrades the projection when two stale pre-migration bootstraps resume after 0004", async () => {
		await setupLegacyLink();
		await warmLegacyHandle(cloneDbHandle(env.db_boltlink));
		await expectShimView();

		const gateA = deferred();
		const staleA = gateBootstrapViewMaintenance(cloneDbHandle(env.db_boltlink), gateA.promise);
		const gateB = deferred();
		const staleB = gateBootstrapViewMaintenance(cloneDbHandle(env.db_boltlink), gateB.promise);
		const requestA = startBootstrap(staleA.db);
		const requestB = startBootstrap(staleB.db);
		await staleA.reached;
		await staleB.reached;

		await applyMigration0004();
		await expectRealView();

		gateA.resolve();
		gateB.resolve();
		await Promise.all([requestA.promise, requestB.promise]);
		await waitOnExecutionContext(requestA.ctx);
		await waitOnExecutionContext(requestB.ctx);

		await expectRealView();
		for (const stale of [staleA, staleB]) {
			expect(stale.executed.some((sql) => sql.startsWith("DROP VIEW"))).toBe(false);
			expect(stale.executed.some((sql) => sql.includes("CREATE VIEW IF NOT EXISTS"))).toBe(true);
		}
	});

	it("creates the pre-migration shim idempotently and keeps counting legacy clicks", async () => {
		await setupLegacyLink();
		expect(await readFenceViewSql()).toBeNull();

		const first = cloneDbHandle(env.db_boltlink);
		const second = cloneDbHandle(env.db_boltlink);
		await warmLegacyHandle(first);
		await warmLegacyHandle(second);
		await expectShimView();

		const clickCtx = createExecutionContext();
		const click = await worker.fetch(
			new Request("https://example.com/transition-link", { headers: { "user-agent": HUMAN_UA } }),
			{ ...env, db_boltlink: first },
			clickCtx,
		);
		await waitOnExecutionContext(clickCtx);
		expect(click.status).toBe(302);

		const row = await readTransitionClicks();
		expect(row).toMatchObject({ clicks_total: 1 });
		await expectShimView();
	});

	it("keeps the real projection when bootstraps run after migration 0004", async () => {
		await setupLegacyLink();
		await applyMigration0004();
		await expectRealView();
		const realSql = await readFenceViewSql();

		await warmLegacyHandle(cloneDbHandle(env.db_boltlink));
		await warmLegacyHandle(cloneDbHandle(env.db_boltlink));

		expect(await readFenceViewSql()).toBe(realSql);
		await expectRealView();
	});
});

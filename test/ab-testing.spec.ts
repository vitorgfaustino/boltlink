/*
 * Copyright (c) 2026 Vitor Faustino
 * AGPL-3.0 License — https://github.com/vitorgfaustino/boltlink
 */

import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimitStore } from "../src/rate-limit";
import worker, { isVariantB } from "../src/index";

const rngControl = vi.hoisted(() => ({ value: 0, calls: 0 }));

vi.mock("../src/ab-random", () => ({
	randomPercent: () => {
		rngControl.calls += 1;
		return rngControl.value;
	},
}));

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
	`CREATE TABLE IF NOT EXISTS link_groups (
	  id INTEGER PRIMARY KEY AUTOINCREMENT,
	  name TEXT NOT NULL,
	  parent_id INTEGER,
	  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	  FOREIGN KEY (parent_id) REFERENCES link_groups(id) ON DELETE SET NULL
	)`,
];

async function fetchWorker(url: string, init?: RequestInit, overrides?: Partial<Env>) {
	const request = new Request(url, init);
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, { ...env, PASSWORD_SESSION_SECRET: "test-secret", ...overrides }, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

async function startWorkerFetch(url: string, init?: RequestInit, overrides?: Partial<Env>) {
	const request = new Request(url, init);
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, { ...env, PASSWORD_SESSION_SECRET: "test-secret", ...overrides }, ctx);
	return { response, ctx };
}

async function resetDatabase() {
	for (const statement of SCHEMA_STATEMENTS) {
		await env.db_boltlink.prepare(statement).run();
	}
	await env.db_boltlink.prepare("DROP TABLE IF EXISTS stats").run();
	await env.db_boltlink.prepare("DELETE FROM links").run();
	await env.db_boltlink.prepare("DELETE FROM link_groups").run();
}

type AbRow = {
	clicks_total: number;
	ab_enabled: number;
	ab_target_url: string | null;
	ab_weight_b: number;
	ab_generation: number;
	metric_epoch: number;
	ab_clicks_a: number;
	ab_clicks_b: number;
	ab_started_at: string | null;
	redirect_type: "301" | "302";
};

async function readAbRow(slug: string) {
	return env.db_boltlink
		.prepare("SELECT clicks_total, ab_enabled, ab_target_url, ab_weight_b, ab_generation, metric_epoch, ab_clicks_a, ab_clicks_b, ab_started_at, redirect_type FROM links WHERE slug = ?")
		.bind(slug)
		.first<AbRow>();
}

async function createAbLink(overrides: Record<string, unknown> = {}) {
	return fetchWorker("http://localhost/api/links", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			slug: "split-link",
			targetUrl: "https://example.com/landing-a",
			abEnabled: true,
			abTargetUrl: "https://example.com/landing-b",
			abWeightB: 50,
			...overrides,
		}),
	});
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

function passThrough<T extends object>(target: T, prop: string | symbol) {
	const value = Reflect.get(target, prop);
	return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
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

/** Simulates a concurrent admin write landing right after updateLink's read. */
function bumpVersionAfterRead(db: D1Database, slug: string, concurrentSql: string): D1Database {
	let armed = true;
	return new Proxy(db, {
		get(target, prop) {
			if (prop !== "prepare") {
				return passThrough(target, prop);
			}

			return (sql: string) => {
				const statement = target.prepare(sql);
				const isLinkRead = sql.trimStart().startsWith("SELECT") && sql.includes("FROM links") && sql.includes("WHERE slug = ?") && sql.includes("version");
				if (!isLinkRead) {
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
									if (boundProp !== "first") {
										return passThrough(bs, boundProp);
									}

									return async (...firstArgs: unknown[]) => {
										const row = await (bs as unknown as { first: (...values: unknown[]) => Promise<unknown> }).first(...firstArgs);
										if (armed) {
											armed = false;
											await db.prepare(concurrentSql).bind(slug).run();
										}
										return row;
									};
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

describe("Stateless A/B testing", () => {
	beforeEach(async () => {
		await resetDatabase();
		resetRateLimitStore();
		rngControl.value = 0;
		rngControl.calls = 0;
	});

	it("keeps non-A/B links behaving exactly as before and never runs the A/B RNG", async () => {
		const createResponse = await fetchWorker("http://localhost/api/links", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ slug: "plain-link", targetUrl: "https://example.com/plain" }),
		});
		expect(createResponse.status).toBe(201);

		rngControl.calls = 0;
		const response = await fetchWorker("https://example.com/plain-link", {
			headers: { "user-agent": HUMAN_UA },
		});
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("https://example.com/plain");
		expect(rngControl.calls).toBe(0);

		const row = await readAbRow("plain-link");
		expect(row).toMatchObject({ clicks_total: 1, ab_clicks_a: 0, ab_clicks_b: 0, ab_enabled: 0 });
	});

	it("applies deterministic split boundaries on the pure selector", () => {
		expect(isVariantB(50, 0)).toBe(true);
		expect(isVariantB(50, 49)).toBe(true);
		expect(isVariantB(50, 50)).toBe(false);
		expect(isVariantB(50, 99)).toBe(false);
		expect(isVariantB(1, 0)).toBe(true);
		expect(isVariantB(1, 1)).toBe(false);
		expect(isVariantB(99, 98)).toBe(true);
		expect(isVariantB(99, 99)).toBe(false);
	});

	it("redirects a controlled roll to Control A and increments only A", async () => {
		expect((await createAbLink()).status).toBe(201);
		rngControl.value = 50;

		const response = await fetchWorker("https://example.com/split-link", { headers: { "user-agent": HUMAN_UA } });
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("https://example.com/landing-a");
		expect(rngControl.calls).toBe(1);

		const row = await readAbRow("split-link");
		expect(row).toMatchObject({ clicks_total: 1, ab_clicks_a: 1, ab_clicks_b: 0 });
	});

	it("redirects a controlled roll to Variant B and increments only B", async () => {
		expect((await createAbLink()).status).toBe(201);
		rngControl.value = 0;

		const response = await fetchWorker("https://example.com/split-link", { headers: { "user-agent": HUMAN_UA } });
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("https://example.com/landing-b");
		expect(rngControl.calls).toBe(1);

		const row = await readAbRow("split-link");
		expect(row).toMatchObject({ clicks_total: 1, ab_clicks_a: 0, ab_clicks_b: 1 });
	});

	it("keeps bots and previews on Control A without RNG or metric write", async () => {
		expect((await createAbLink()).status).toBe(201);
		rngControl.calls = 0;

		const requests: Array<Record<string, string>> = [
			{ "user-agent": "facebookexternalhit/1.1", "sec-fetch-mode": "navigate" },
			{ "user-agent": "WhatsApp/2.20.1 A", "sec-fetch-mode": "navigate" },
			{ "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)", "sec-fetch-mode": "navigate" },
			{ "user-agent": HUMAN_UA, "sec-purpose": "prefetch;prerender", "sec-fetch-mode": "navigate" },
		];

		for (const headers of requests) {
			const response = await fetchWorker("https://example.com/split-link", { headers });
			expect(response.status).toBe(302);
			expect(response.headers.get("Location")).toBe("https://example.com/landing-a");
		}

		expect(rngControl.calls).toBe(0);
		const row = await readAbRow("split-link");
		expect(row).toMatchObject({ clicks_total: 0, ab_clicks_a: 0, ab_clicks_b: 0 });
	});

	it("validates A/B payloads with fail-fast 400 and no partial mutation", async () => {
		const invalidCreate = await fetchWorker("http://localhost/api/links", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				slug: "invalid-ab",
				targetUrl: "https://example.com/a",
				abEnabled: true,
				abTargetUrl: "not-a-url",
			}),
		});
		expect(invalidCreate.status).toBe(400);
		expect(await env.db_boltlink.prepare("SELECT slug FROM links WHERE slug = ?").bind("invalid-ab").first()).toBeNull();

		const missingB = await fetchWorker("http://localhost/api/links", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ slug: "missing-b", targetUrl: "https://example.com/a", abEnabled: true }),
		});
		expect(missingB.status).toBe(400);

		for (const abWeightB of [0, 100, -1, 50.5, "50"]) {
			const response = await fetchWorker("http://localhost/api/links", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ slug: "bad-weight", targetUrl: "https://example.com/a", abEnabled: false, abWeightB }),
			});
			expect(response.status).toBe(400);
		}

		const wrongType = await fetchWorker("http://localhost/api/links", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ slug: "bad-type", targetUrl: "https://example.com/a", abEnabled: "yes" }),
		});
		expect(wrongType.status).toBe(400);

		await createAbLink();
		const atomicPatch = await fetchWorker("http://localhost/api/links/split-link", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ targetUrl: "https://example.com/hijacked", abWeightB: 0 }),
		});
		expect(atomicPatch.status).toBe(400);
		const row = await readAbRow("split-link");
		expect(row?.ab_target_url).toBe("https://example.com/landing-b");
		expect(row?.ab_weight_b).toBe(50);
		const untouched = await env.db_boltlink.prepare("SELECT target_url FROM links WHERE slug = ?").bind("split-link").first<{ target_url: string }>();
		expect(untouched?.target_url).toBe("https://example.com/landing-a");
	});

	it("fences a delayed Variant B write when the experiment changes", async () => {
		expect((await createAbLink()).status).toBe(201);
		rngControl.value = 0;

		const gate = deferred();
		const { response, ctx } = await startWorkerFetch(
			"https://example.com/split-link",
			{ headers: { "user-agent": HUMAN_UA } },
			{ db_boltlink: deferMetricWrites(env.db_boltlink, gate.promise) },
		);
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("https://example.com/landing-b");

		const patch = await fetchWorker("http://localhost/api/links/split-link", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ abTargetUrl: "https://example.com/landing-b2" }),
		});
		expect(patch.status).toBe(200);
		const generationAfterPatch = (await readAbRow("split-link"))?.ab_generation;

		gate.resolve();
		await waitOnExecutionContext(ctx);

		const fenced = await readAbRow("split-link");
		expect(fenced?.clicks_total).toBe(1);
		expect(fenced?.ab_clicks_a).toBe(0);
		expect(fenced?.ab_clicks_b).toBe(0);
		expect(fenced?.ab_generation).toBe((generationAfterPatch ?? 0));

		rngControl.value = 0;
		await fetchWorker("https://example.com/split-link", { headers: { "user-agent": HUMAN_UA } });
		const newGeneration = await readAbRow("split-link");
		expect(newGeneration?.clicks_total).toBe(2);
		expect(newGeneration?.ab_clicks_b).toBe(1);
		expect(newGeneration?.ab_clicks_a).toBe(0);
	});

	it("fences a delayed Control A write when the experiment changes", async () => {
		expect((await createAbLink()).status).toBe(201);
		rngControl.value = 50;

		const gate = deferred();
		const { ctx } = await startWorkerFetch(
			"https://example.com/split-link",
			{ headers: { "user-agent": HUMAN_UA } },
			{ db_boltlink: deferMetricWrites(env.db_boltlink, gate.promise) },
		);

		const patch = await fetchWorker("http://localhost/api/links/split-link", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ abWeightB: 25 }),
		});
		expect(patch.status).toBe(200);

		gate.resolve();
		await waitOnExecutionContext(ctx);

		const fenced = await readAbRow("split-link");
		expect(fenced?.clicks_total).toBe(1);
		expect(fenced?.ab_clicks_a).toBe(0);
		expect(fenced?.ab_clicks_b).toBe(0);
	});

	it("fences a delayed write across a manual reset", async () => {
		expect((await createAbLink()).status).toBe(201);
		rngControl.value = 0;

		const gate = deferred();
		const { ctx } = await startWorkerFetch(
			"https://example.com/split-link",
			{ headers: { "user-agent": HUMAN_UA } },
			{ db_boltlink: deferMetricWrites(env.db_boltlink, gate.promise) },
		);

		const reset = await fetchWorker("http://localhost/api/links/split-link/reset-clicks", { method: "POST" });
		expect(reset.status).toBe(200);

		gate.resolve();
		await waitOnExecutionContext(ctx);

		const afterReset = await readAbRow("split-link");
		expect(afterReset?.clicks_total).toBe(0);
		expect(afterReset?.ab_clicks_a).toBe(0);
		expect(afterReset?.ab_clicks_b).toBe(0);

		rngControl.value = 0;
		await fetchWorker("https://example.com/split-link", { headers: { "user-agent": HUMAN_UA } });
		const afterNewClick = await readAbRow("split-link");
		expect(afterNewClick?.clicks_total).toBe(1);
		expect(afterNewClick?.ab_clicks_b).toBe(1);
	});

	it("rejects a stale PATCH after a concurrent update instead of corrupting the experiment", async () => {
		expect((await createAbLink({ abEnabled: false })).status).toBe(201);

		const proxy = bumpVersionAfterRead(
			env.db_boltlink,
			"split-link",
			"UPDATE links SET ab_enabled = 1, ab_target_url = 'https://example.com/landing-b', version = version + 1 WHERE slug = ?",
		);
		const stalePatch = await fetchWorker("http://localhost/api/links/split-link", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ abTargetUrl: null }),
		}, { db_boltlink: proxy });

		expect(stalePatch.status).toBe(409);

		const row = await readAbRow("split-link");
		expect(row?.ab_enabled).toBe(1);
		expect(row?.ab_target_url).toBe("https://example.com/landing-b");
	});

	it("resolves concurrent valid updates with a conflict or a fully validated state", async () => {
		expect((await createAbLink()).status).toBe(201);

		const proxy = bumpVersionAfterRead(
			env.db_boltlink,
			"split-link",
			"UPDATE links SET ab_weight_b = 75, version = version + 1 WHERE slug = ?",
		);
		const stalePatch = await fetchWorker("http://localhost/api/links/split-link", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ abWeightB: 25 }),
		}, { db_boltlink: proxy });
		expect(stalePatch.status).toBe(409);

		const afterConflict = await readAbRow("split-link");
		expect(afterConflict?.ab_weight_b).toBe(75);

		const retry = await fetchWorker("http://localhost/api/links/split-link", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ abWeightB: 25 }),
		});
		expect(retry.status).toBe(200);
		const finalRow = await readAbRow("split-link");
		expect(finalRow?.ab_weight_b).toBe(25);
		expect(finalRow?.ab_enabled).toBe(1);
		expect(finalRow?.ab_target_url).toBe("https://example.com/landing-b");
	});

	it("resets variant counters and bumps generation on material configuration changes", async () => {
		expect((await createAbLink()).status).toBe(201);
		rngControl.value = 0;
		await fetchWorker("https://example.com/split-link", { headers: { "user-agent": HUMAN_UA } });

		const before = await readAbRow("split-link");
		expect(before?.clicks_total).toBe(1);
		expect(before?.ab_clicks_b).toBe(1);

		const patchB = await fetchWorker("http://localhost/api/links/split-link", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ abTargetUrl: "https://example.com/landing-b2" }),
		});
		expect(patchB.status).toBe(200);

		const afterB = await readAbRow("split-link");
		expect(afterB?.ab_clicks_a).toBe(0);
		expect(afterB?.ab_clicks_b).toBe(0);
		expect(afterB?.ab_target_url).toBe("https://example.com/landing-b2");
		expect(afterB?.clicks_total).toBe(1);
		expect(afterB?.ab_generation).toBe((before?.ab_generation ?? 0) + 1);
		expect(afterB?.ab_started_at).not.toBeNull();
	});

	it("resets on Control A change, weight change and re-enable; keeps results on disable", async () => {
		expect((await createAbLink()).status).toBe(201);
		rngControl.value = 0;
		await fetchWorker("https://example.com/split-link", { headers: { "user-agent": HUMAN_UA } });

		const patchControl = await fetchWorker("http://localhost/api/links/split-link", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ targetUrl: "https://example.com/landing-a2" }),
		});
		expect(patchControl.status).toBe(200);
		let row = await readAbRow("split-link");
		expect(row?.ab_clicks_a).toBe(0);
		expect(row?.ab_clicks_b).toBe(0);
		expect(row?.clicks_total).toBe(1);

		const patchWeight = await fetchWorker("http://localhost/api/links/split-link", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ abWeightB: 25 }),
		});
		expect(patchWeight.status).toBe(200);
		rngControl.value = 0;
		await fetchWorker("https://example.com/split-link", { headers: { "user-agent": HUMAN_UA } });
		row = await readAbRow("split-link");
		expect(row?.ab_weight_b).toBe(25);
		expect((row?.ab_clicks_a ?? 0) + (row?.ab_clicks_b ?? 0)).toBe(1);

		const disable = await fetchWorker("http://localhost/api/links/split-link", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ abEnabled: false }),
		});
		expect(disable.status).toBe(200);
		row = await readAbRow("split-link");
		expect(row?.ab_enabled).toBe(0);
		expect((row?.ab_clicks_a ?? 0) + (row?.ab_clicks_b ?? 0)).toBe(1);

		const enable = await fetchWorker("http://localhost/api/links/split-link", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ abEnabled: true }),
		});
		expect(enable.status).toBe(200);
		row = await readAbRow("split-link");
		expect(row?.ab_enabled).toBe(1);
		expect(row?.ab_clicks_a).toBe(0);
		expect(row?.ab_clicks_b).toBe(0);
		expect(row?.clicks_total).toBeGreaterThanOrEqual(1);
		expect(row?.ab_started_at).not.toBeNull();
	});

	it("resets both aggregate counters and bumps generation with the reset-clicks action", async () => {
		expect((await createAbLink()).status).toBe(201);
		rngControl.value = 0;
		await fetchWorker("https://example.com/split-link", { headers: { "user-agent": HUMAN_UA } });
		const before = await readAbRow("split-link");

		const resetResponse = await fetchWorker("http://localhost/api/links/split-link/reset-clicks", { method: "POST" });
		expect(resetResponse.status).toBe(200);
		const payload = (await resetResponse.json()) as { link: { clicks_total: number; ab_clicks_a: number; ab_clicks_b: number } };
		expect(payload.link).toMatchObject({ clicks_total: 0, ab_clicks_a: 0, ab_clicks_b: 0 });

		const row = await readAbRow("split-link");
		expect(row).toMatchObject({ clicks_total: 0, ab_clicks_a: 0, ab_clicks_b: 0 });
		expect(row?.metric_epoch).toBe((before?.metric_epoch ?? 0) + 1);
		expect(row?.ab_generation).toBe((before?.ab_generation ?? 0) + 1);
	});

	it("duplicates A/B configuration without copying counters or generation history", async () => {
		expect((await createAbLink()).status).toBe(201);
		rngControl.value = 0;
		await fetchWorker("https://example.com/split-link", { headers: { "user-agent": HUMAN_UA } });

		const duplicateResponse = await fetchWorker("http://localhost/api/links/split-link/duplicate", { method: "POST" });
		expect(duplicateResponse.status).toBe(201);
		const duplicated = (await duplicateResponse.json()) as { link: { slug: string; ab_enabled: number; ab_target_url: string | null; ab_weight_b: number; ab_clicks_a: number; ab_clicks_b: number; ab_generation: number; ab_started_at: string | null; clicks_total: number } };
		expect(duplicated.link).toMatchObject({
			ab_enabled: 1,
			ab_target_url: "https://example.com/landing-b",
			ab_weight_b: 50,
			ab_clicks_a: 0,
			ab_clicks_b: 0,
			clicks_total: 0,
			ab_generation: 1,
		});
		expect(duplicated.link.ab_started_at).not.toBeNull();

		const source = await readAbRow("split-link");
		expect(source?.clicks_total).toBe(1);
	});

	it("rejects permanent redirects with A/B and forces temporary redirects on the hot path", async () => {
		const create = await fetchWorker("http://localhost/api/links", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				slug: "perm-split",
				targetUrl: "https://example.com/a",
				redirectType: "301",
				abEnabled: true,
				abTargetUrl: "https://example.com/b",
			}),
		});
		expect(create.status).toBe(400);

		await fetchWorker("http://localhost/api/links", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ slug: "perm-link", targetUrl: "https://example.com/permanent", redirectType: "301" }),
		});
		const normal301 = await fetchWorker("https://example.com/perm-link", { headers: { "user-agent": HUMAN_UA } });
		expect(normal301.status).toBe(301);
		expect(normal301.headers.get("Cache-Control")).toBeNull();

		const enableAbOn301 = await fetchWorker("http://localhost/api/links/perm-link", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ abEnabled: true, abTargetUrl: "https://example.com/permanent-b" }),
		});
		expect(enableAbOn301.status).toBe(400);

		const switchAndEnable = await fetchWorker("http://localhost/api/links/perm-link", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ redirectType: "302", abEnabled: true, abTargetUrl: "https://example.com/permanent-b" }),
		});
		expect(switchAndEnable.status).toBe(200);

		expect((await createAbLink({ slug: "temp-split" })).status).toBe(201);
		await env.db_boltlink.prepare("UPDATE links SET redirect_type = '301' WHERE slug = ?").bind("temp-split").run();

		rngControl.value = 0;
		const abResponse = await fetchWorker("https://example.com/temp-split", { headers: { "user-agent": HUMAN_UA } });
		expect(abResponse.status).toBe(302);
		expect(abResponse.headers.get("Location")).toBe("https://example.com/landing-b");
		expect(abResponse.headers.get("Cache-Control")).toBe("no-store");
	});

	it("keeps disabled A/B results visible to the admin API", async () => {
		expect((await createAbLink()).status).toBe(201);
		rngControl.value = 0;
		await fetchWorker("https://example.com/split-link", { headers: { "user-agent": HUMAN_UA } });

		const disable = await fetchWorker("http://localhost/api/links/split-link", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ abEnabled: false }),
		});
		expect(disable.status).toBe(200);

		const listResponse = await fetchWorker("http://localhost/api/links?search=split-link");
		const payload = (await listResponse.json()) as { links: Array<{ slug: string; ab_enabled: number; ab_target_url: string | null; ab_clicks_a: number; ab_clicks_b: number; ab_started_at: string | null }> };
		const link = payload.links.find((entry) => entry.slug === "split-link");
		expect(link).toMatchObject({
			ab_enabled: 0,
			ab_target_url: "https://example.com/landing-b",
			ab_clicks_a: 0,
			ab_clicks_b: 1,
		});
		expect(link?.ab_started_at).not.toBeNull();
	});

	it("supports A/B with password links without double counting", async () => {
		const createResponse = await fetchWorker("http://localhost/api/links", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				slug: "guarded-split",
				targetUrl: "https://example.com/guarded-a",
				password: "abc123",
				abEnabled: true,
				abTargetUrl: "https://example.com/guarded-b",
				abWeightB: 50,
			}),
		});
		expect(createResponse.status).toBe(201);

		const anonymous = await fetchWorker("https://example.com/guarded-split", { headers: { "user-agent": HUMAN_UA } });
		expect(anonymous.status).toBe(200);
		expect(anonymous.headers.get("Location")).toBeNull();
		expect(await anonymous.text()).toContain("Link protegido por senha");

		const crawler = await fetchWorker("https://example.com/guarded-split", {
			headers: { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" },
		});
		expect(crawler.status).toBe(200);
		expect(crawler.headers.get("Location")).toBeNull();
		const crawlerBody = await crawler.text();
		expect(crawlerBody).toContain("Link protegido por senha");
		expect(crawlerBody).not.toContain("https://example.com/guarded-b");

		const wrongPassword = await fetchWorker("https://example.com/guarded-split", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", "user-agent": HUMAN_UA },
			body: "password=nope",
		});
		expect(wrongPassword.status).toBe(401);
		expect(wrongPassword.headers.get("Location")).toBeNull();

		rngControl.value = 0;
		const unlocked = await fetchWorker("https://example.com/guarded-split", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", "user-agent": HUMAN_UA },
			body: "password=abc123",
		});
		expect(unlocked.status).toBe(302);
		expect(unlocked.headers.get("Location")).toBe("https://example.com/guarded-b");

		const row = await readAbRow("guarded-split");
		expect(row?.clicks_total).toBe(1);
		expect(row?.ab_clicks_b).toBe(1);
		expect(row?.ab_clicks_a).toBe(0);
	});

	it("keeps clicks_total consistent with the sum of variant counters", async () => {
		expect((await createAbLink()).status).toBe(201);
		for (let index = 0; index < 6; index += 1) {
			rngControl.value = index % 2 === 0 ? 0 : 50;
			await fetchWorker("https://example.com/split-link", { headers: { "user-agent": HUMAN_UA } });
		}

		const row = await readAbRow("split-link");
		expect(row?.clicks_total).toBe(6);
		expect((row?.ab_clicks_a ?? 0) + (row?.ab_clicks_b ?? 0)).toBe(6);
	});
});

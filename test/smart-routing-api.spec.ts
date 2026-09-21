/*
 * Copyright (c) 2026 Vitor Faustino
 * AGPL-3.0 License — https://github.com/vitorgfaustino/boltlink
 *
 * Gate 3.2: Smart Routing administrative API coverage (migration 0005).
 * The public redirect is not exercised here; it does not use Smart Routing.
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

const FULL_CHAIN = [migration0000, migration0001, migration0002, migration0003, migration0004, migration0005];
const PRE_0005 = [migration0000, migration0001, migration0002, migration0003, migration0004];

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

async function fetchWorker(url: string, init?: RequestInit, handle?: D1Database) {
	const request = new Request(url, init);
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, { ...env, PASSWORD_SESSION_SECRET: "test-secret", db_boltlink: handle ?? cloneDbHandle(env.db_boltlink) }, ctx);
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

async function rawRouting(slug: string) {
	const row = await env.db_boltlink
		.prepare("SELECT smart_routing_rules FROM links WHERE slug = ?")
		.bind(slug)
		.first<{ smart_routing_rules: string | null }>();
	return row?.smart_routing_rules ?? null;
}

async function linkState(slug: string) {
	return env.db_boltlink
		.prepare("SELECT ab_enabled, ab_target_url, ab_generation, metric_epoch, ab_clicks_a, ab_clicks_b, redirect_type, clicks_total, version, smart_routing_rules FROM links WHERE slug = ?")
		.bind(slug)
		.first<Record<string, unknown>>();
}

const COUNTRY_RULE = [{ country: "BR", url: "https://example.com/br" }];
const CANONICAL_COUNTRY_RULE = JSON.stringify([{ country: "BR", url: "https://example.com/br" }]);

async function duplicateSnapshot(slug: string) {
	return env.db_boltlink
		.prepare(
			"SELECT target_url, redirect_type, clicks_total, version, ab_enabled, ab_target_url, ab_weight_b, ab_clicks_a, ab_clicks_b, ab_started_at, ab_generation, metric_epoch, smart_routing_rules FROM links WHERE slug = ?",
		)
		.bind(slug)
		.first<Record<string, unknown>>();
}

async function linkCount() {
	const row = await env.db_boltlink.prepare("SELECT COUNT(*) AS total FROM links").first<{ total: number }>();
	return row?.total ?? 0;
}

/** Simulates a concurrent admin write landing right after the PATCH read. */
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
											await env.db_boltlink.prepare(concurrentSql).bind(slug).run();
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

beforeEach(async () => {
	await resetAll();
	await applyChain(FULL_CHAIN);
	resetRateLimitStore();
});

describe("Smart Routing API: capability", () => {
	it("exposes smartRouting=true after 0005 and omits the field pre-0005", async () => {
		const capabilities = await fetchWorker("http://127.0.0.1/api/capabilities");
		expect(await capabilities.json()).toEqual({ abTesting: true, smartRouting: true });

		await resetAll();
		await applyChain(PRE_0005);
		const pre = await fetchWorker("http://127.0.0.1/api/capabilities");
		expect(await pre.json()).toEqual({ abTesting: true, smartRouting: false });
	});
});

describe("Smart Routing API: CREATE", () => {
	it("creates a normal link without the field and stores NULL", async () => {
		const response = await createLink({ slug: "sr-plain", targetUrl: "https://example.com/plain" });
		expect(response.status).toBe(201);
		const payload = (await response.json()) as { link: { smartRoutingRules: unknown } };
		expect(payload.link.smartRoutingRules).toBeNull();
		expect(await rawRouting("sr-plain")).toBeNull();
	});

	it("treats an explicit null as disabled", async () => {
		const response = await createLink({ slug: "sr-null", targetUrl: "https://example.com/null", smartRoutingRules: null });
		expect(response.status).toBe(201);
		const payload = (await response.json()) as { link: { smartRoutingRules: unknown } };
		expect(payload.link.smartRoutingRules).toBeNull();
		expect(await rawRouting("sr-null")).toBeNull();
	});

	it("creates country, device and combined rules with canonical storage", async () => {
		const country = await createLink({ slug: "sr-country", targetUrl: "https://example.com/c", smartRoutingRules: [{ country: "BR", url: "https://example.com" }] });
		expect(country.status).toBe(201);
		const countryPayload = (await country.json()) as { link: { smartRoutingRules: unknown } };
		expect(countryPayload.link.smartRoutingRules).toEqual([{ country: "BR", url: "https://example.com/" }]);
		expect(await rawRouting("sr-country")).toBe(JSON.stringify([{ country: "BR", url: "https://example.com/" }]));

		const device = await createLink({ slug: "sr-device", targetUrl: "https://example.com/d", smartRoutingRules: [{ device: "ios", url: "https://example.com/ios" }] });
		expect(device.status).toBe(201);

		const combined = await createLink({ slug: "sr-combined", targetUrl: "https://example.com/x", smartRoutingRules: [{ country: "US", device: "android", url: "https://example.com/us-android" }] });
		expect(combined.status).toBe(201);
		const combinedPayload = (await combined.json()) as { link: { smartRoutingRules: unknown } };
		expect(combinedPayload.link.smartRoutingRules).toEqual([{ country: "US", device: "android", url: "https://example.com/us-android" }]);
	});

	it("rejects empty arrays and domain validation errors safely", async () => {
		const empty = await createLink({ slug: "sr-empty", targetUrl: "https://example.com/e", smartRoutingRules: [] });
		expect(empty.status).toBe(400);
		expect(((await empty.json()) as { error: string }).error).toContain("EMPTY_RULES");

		const invalidCountry = await createLink({ slug: "sr-bad-country", targetUrl: "https://example.com/b", smartRoutingRules: [{ country: "br", url: "https://example.com/x" }] });
		expect(invalidCountry.status).toBe(400);
		expect(((await invalidCountry.json()) as { error: string }).error).toContain("INVALID_COUNTRY");

		const unsafe = await createLink({ slug: "sr-unsafe", targetUrl: "https://example.com/u", smartRoutingRules: [{ country: "BR", url: "javascript:alert(1)" }] });
		expect(unsafe.status).toBe(400);
		const unsafeBody = await unsafe.text();
		expect(unsafeBody).toContain("INVALID_URL");
		expect(unsafeBody).not.toContain("javascript");

		const missingMatcher = await createLink({ slug: "sr-any", targetUrl: "https://example.com/a", smartRoutingRules: [{ url: "https://example.com/any" }] });
		expect(missingMatcher.status).toBe(400);
		expect(((await missingMatcher.json()) as { error: string }).error).toContain("MISSING_MATCHER");
	});

	it("rejects A/B and 301 conflicts on CREATE", async () => {
		const abConflict = await createLink({ slug: "sr-ab", targetUrl: "https://example.com/a", abEnabled: true, abTargetUrl: "https://example.com/b", smartRoutingRules: COUNTRY_RULE });
		expect(abConflict.status).toBe(400);
		expect(((await abConflict.json()) as { error: string }).error).toContain("mutually exclusive");

		const permanentConflict = await createLink({ slug: "sr-301", targetUrl: "https://example.com/p", redirectType: "301", smartRoutingRules: COUNTRY_RULE });
		expect(permanentConflict.status).toBe(400);
		expect(((await permanentConflict.json()) as { error: string }).error).toContain("302");
	});

	it("rejects the field before 0005 and keeps normal payloads working", async () => {
		await resetAll();
		await applyChain(PRE_0005);

		const normal = await createLink({ slug: "sr-pre-normal", targetUrl: "https://example.com/n" });
		expect(normal.status).toBe(201);
		const normalPayload = (await normal.json()) as { link: Record<string, unknown> };
		expect("smartRoutingRules" in normalPayload.link).toBe(false);

		const withNull = await createLink({ slug: "sr-pre-null", targetUrl: "https://example.com/nn", smartRoutingRules: null });
		expect(withNull.status).toBe(400);
		expect(((await withNull.json()) as { error: string }).error).toContain("0005");

		const withRules = await createLink({ slug: "sr-pre-rules", targetUrl: "https://example.com/nr", smartRoutingRules: COUNTRY_RULE });
		expect(withRules.status).toBe(400);
		expect(((await withRules.json()) as { error: string }).error).toContain("0005");

		const columns = await env.db_boltlink.prepare("PRAGMA table_info(links)").all<{ name: string }>();
		expect(new Set((columns.results ?? []).map((column) => column.name)).has("smart_routing_rules")).toBe(false);
	});
});

describe("Smart Routing API: PATCH", () => {
	it("treats absent as no-op and preserves rules on unrelated patches", async () => {
		await createLink({ slug: "sr-keep", targetUrl: "https://example.com/k", smartRoutingRules: COUNTRY_RULE });
		const before = await rawRouting("sr-keep");

		const response = await patchLink("sr-keep", { tags: ["keep"] });
		expect(response.status).toBe(200);
		const payload = (await response.json()) as { link: { smartRoutingRules: unknown } };
		expect(payload.link.smartRoutingRules).toEqual([{ country: "BR", url: "https://example.com/br" }]);
		expect(await rawRouting("sr-keep")).toBe(before);
	});

	it("disables routing with null and allows 301 afterwards", async () => {
		await createLink({ slug: "sr-off", targetUrl: "https://example.com/o", smartRoutingRules: COUNTRY_RULE });

		const disabled = await patchLink("sr-off", { smartRoutingRules: null });
		expect(disabled.status).toBe(200);
		const payload = (await disabled.json()) as { link: { smartRoutingRules: unknown } };
		expect(payload.link.smartRoutingRules).toBeNull();
		expect(await rawRouting("sr-off")).toBeNull();

		const permanent = await patchLink("sr-off", { redirectType: "301" });
		expect(permanent.status).toBe(200);
		expect((await linkState("sr-off"))?.redirect_type).toBe("301");
	});

	it("replaces the whole rule set", async () => {
		await createLink({ slug: "sr-replace", targetUrl: "https://example.com/r", smartRoutingRules: COUNTRY_RULE });
		const response = await patchLink("sr-replace", { smartRoutingRules: [{ device: "desktop", url: "https://example.com/desktop" }] });
		expect(response.status).toBe(200);
		expect(await rawRouting("sr-replace")).toBe(JSON.stringify([{ device: "desktop", url: "https://example.com/desktop" }]));
	});

	it("rejects A/B conflict and keeps the row unchanged", async () => {
		await createLink({ slug: "sr-ab-conflict", targetUrl: "https://example.com/a", abEnabled: true, abTargetUrl: "https://example.com/b" });

		const response = await patchLink("sr-ab-conflict", { smartRoutingRules: COUNTRY_RULE });
		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: string }).error).toContain("mutually exclusive");
		expect(await rawRouting("sr-ab-conflict")).toBeNull();
		expect((await linkState("sr-ab-conflict"))?.ab_enabled).toBe(1);
	});

	it("rejects 301 conflict and keeps the row 302", async () => {
		await createLink({ slug: "sr-301-conflict", targetUrl: "https://example.com/x", smartRoutingRules: COUNTRY_RULE });

		const response = await patchLink("sr-301-conflict", { redirectType: "301" });
		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: string }).error).toContain("302");
		expect((await linkState("sr-301-conflict"))?.redirect_type).toBe("302");
	});

	it("converts A/B -> Smart Routing atomically in one PATCH", async () => {
		await createLink({ slug: "sr-ab-to", targetUrl: "https://example.com/a", abEnabled: true, abTargetUrl: "https://example.com/b" });

		const response = await patchLink("sr-ab-to", { abEnabled: false, smartRoutingRules: COUNTRY_RULE });
		expect(response.status).toBe(200);
		const state = await linkState("sr-ab-to");
		expect(state?.ab_enabled).toBe(0);
		expect(state?.smart_routing_rules).toBe(JSON.stringify([{ country: "BR", url: "https://example.com/br" }]));
	});

	it("converts Smart Routing -> A/B atomically in one PATCH", async () => {
		await createLink({ slug: "sr-to-ab", targetUrl: "https://example.com/a", smartRoutingRules: COUNTRY_RULE });

		const response = await patchLink("sr-to-ab", { smartRoutingRules: null, abEnabled: true, abTargetUrl: "https://example.com/b" });
		expect(response.status).toBe(200);
		const state = await linkState("sr-to-ab");
		expect(state?.smart_routing_rules).toBeNull();
		expect(state?.ab_enabled).toBe(1);
	});

	it("converts 301 -> 302 + routing in one PATCH", async () => {
		await createLink({ slug: "sr-301-to", targetUrl: "https://example.com/301", redirectType: "301" });

		const response = await patchLink("sr-301-to", { redirectType: "302", smartRoutingRules: COUNTRY_RULE });
		expect(response.status).toBe(200);
		const state = await linkState("sr-301-to");
		expect(state?.redirect_type).toBe("302");
		expect(state?.smart_routing_rules).not.toBeNull();
	});

	it("returns 409 on a stale version and never touches rules", async () => {
		await createLink({ slug: "sr-race", targetUrl: "https://example.com/race", smartRoutingRules: COUNTRY_RULE });
		const before = await rawRouting("sr-race");

		const proxy = bumpVersionAfterRead(cloneDbHandle(env.db_boltlink), "sr-race", "UPDATE links SET version = version + 1 WHERE slug = ?");
		const response = await patchLink("sr-race", { tags: ["stale"] }, proxy);
		expect(response.status).toBe(409);
		expect(await rawRouting("sr-race")).toBe(before);
	});

	it("never produces the hybrid state under A/B vs routing concurrency", async () => {
		await createLink({ slug: "sr-hybrid-a", targetUrl: "https://example.com/h" });

		// The concurrent writer enables Smart Routing right after the read.
		const proxy = bumpVersionAfterRead(
			cloneDbHandle(env.db_boltlink),
			"sr-hybrid-a",
			`UPDATE links SET smart_routing_rules = '${JSON.stringify(COUNTRY_RULE)}', version = version + 1 WHERE slug = ?`,
		);
		const response = await patchLink("sr-hybrid-a", { abEnabled: true, abTargetUrl: "https://example.com/b" }, proxy);
		expect(response.status).toBe(409);

		const state = await linkState("sr-hybrid-a");
		expect(state?.ab_enabled).toBe(0);
		expect(state?.smart_routing_rules).not.toBeNull();
	});

	it("never produces routing + 301 under redirect-type concurrency", async () => {
		await createLink({ slug: "sr-hybrid-b", targetUrl: "https://example.com/h2" });

		const proxy = bumpVersionAfterRead(cloneDbHandle(env.db_boltlink), "sr-hybrid-b", "UPDATE links SET redirect_type = '301', version = version + 1 WHERE slug = ?");
		const response = await patchLink("sr-hybrid-b", { smartRoutingRules: COUNTRY_RULE }, proxy);
		expect(response.status).toBe(409);

		const state = await linkState("sr-hybrid-b");
		expect(state?.redirect_type).toBe("301");
		expect(state?.smart_routing_rules).toBeNull();
	});
});

describe("Smart Routing API: LIST / GET", () => {
	it("returns canonical arrays post-0005 and omits the field pre-0005", async () => {
		await createLink({ slug: "sr-list", targetUrl: "https://example.com/l", smartRoutingRules: COUNTRY_RULE });
		await createLink({ slug: "sr-list-plain", targetUrl: "https://example.com/lp" });

		const response = await fetchWorker("http://localhost/api/links");
		expect(response.status).toBe(200);
		const payload = (await response.json()) as { links: Array<{ slug: string; smartRoutingRules: unknown }> };
		const routing = payload.links.find((link) => link.slug === "sr-list");
		const plain = payload.links.find((link) => link.slug === "sr-list-plain");
		expect(routing?.smartRoutingRules).toEqual([{ country: "BR", url: "https://example.com/br" }]);
		expect(plain?.smartRoutingRules).toBeNull();

		await resetAll();
		await applyChain(PRE_0005);
		const pre = await fetchWorker("http://localhost/api/links");
		expect(pre.status).toBe(200);
		const prePayload = (await pre.json()) as { links: Array<Record<string, unknown>> };
		expect(prePayload.links).toEqual([]);
	});

	it("reports invalid persisted content as null without 500 or raw leakage", async () => {
		await createLink({ slug: "sr-corrupt", targetUrl: "https://example.com/corrupt" });
		await env.db_boltlink.prepare("UPDATE links SET smart_routing_rules = ? WHERE slug = ?").bind("{\"broken\":", "sr-corrupt").run();

		const response = await fetchWorker("http://localhost/api/links");
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).toContain('"smartRoutingRules":null');
		expect(text).not.toContain("{\\\"broken\\\"");
		expect(await rawRouting("sr-corrupt")).toBe("{\"broken\":");
	});
});

type SerializedSmartState = { smartRoutingRules?: unknown; smartRoutingStatus?: unknown };

async function listSerialized(slug: string): Promise<SerializedSmartState | undefined> {
	const response = await fetchWorker("http://localhost/api/links");
	const payload = (await response.json()) as { links: Array<SerializedSmartState & { slug: string }> };
	return payload.links.find((link) => link.slug === slug);
}

describe("Smart Routing API: persisted state contract", () => {
	/**
	 * `smartRoutingRules: null` is ambiguous on its own (disabled vs corrupt), so
	 * the API also reports the classification. Losing it would let the Admin treat
	 * a corrupt row as ordinary off and erase it on an unrelated edit.
	 */
	it("classifies disabled, valid and invalid state in the list response", async () => {
		await createLink({ slug: "state-off", targetUrl: "https://example.com/off" });
		await createLink({ slug: "state-valid", targetUrl: "https://example.com/valid", smartRoutingRules: COUNTRY_RULE });
		await createLink({ slug: "state-invalid", targetUrl: "https://example.com/invalid" });
		await env.db_boltlink.prepare("UPDATE links SET smart_routing_rules = ? WHERE slug = ?").bind("INVALID RAW VALUE", "state-invalid").run();

		expect(await listSerialized("state-off")).toMatchObject({ smartRoutingRules: null, smartRoutingStatus: "disabled" });
		expect(await listSerialized("state-valid")).toMatchObject({
			smartRoutingRules: [{ country: "BR", url: "https://example.com/br" }],
			smartRoutingStatus: "valid",
		});
		expect(await listSerialized("state-invalid")).toMatchObject({ smartRoutingRules: null, smartRoutingStatus: "invalid" });
	});

	it("never serializes the raw corrupt value and never repairs it on read", async () => {
		await createLink({ slug: "state-readonly", targetUrl: "https://example.com/ro" });
		await env.db_boltlink.prepare("UPDATE links SET smart_routing_rules = ? WHERE slug = ?").bind("INVALID RAW VALUE", "state-readonly").run();

		const listed = await listSerialized("state-readonly");
		expect(listed?.smartRoutingStatus).toBe("invalid");
		expect(JSON.stringify(listed)).not.toContain("INVALID RAW VALUE");
		expect(await rawRouting("state-readonly")).toBe("INVALID RAW VALUE");
	});

	it("omits the status entirely pre-0005 just like the rules field", async () => {
		await resetAll();
		await applyChain(PRE_0005);
		await env.db_boltlink
			.prepare("INSERT INTO links (slug, target_url) VALUES (?, ?)")
			.bind("state-pre", "https://example.com/pre")
			.run();

		const response = await fetchWorker("http://localhost/api/links");
		expect(response.status).toBe(200);
		const payload = (await response.json()) as { links: Array<Record<string, unknown>> };
		expect(payload.links).toHaveLength(1);
		expect(Object.keys(payload.links[0])).not.toContain("smartRoutingRules");
		expect(Object.keys(payload.links[0])).not.toContain("smartRoutingStatus");
	});
});

describe("Smart Routing API: DUPLICATE", () => {
	it("copies canonical rules without copying click history", async () => {
		await createLink({ slug: "sr-dup", targetUrl: "https://example.com/dup", smartRoutingRules: COUNTRY_RULE });
		await env.db_boltlink.prepare("UPDATE links SET clicks_total = 9 WHERE slug = ?").bind("sr-dup").run();

		const response = await fetchWorker("http://localhost/api/links/sr-dup/duplicate", { method: "POST" });
		expect(response.status).toBe(201);
		const payload = (await response.json()) as { link: { slug: string; smartRoutingRules: unknown; clicks_total: number; redirect_type: string } };
		expect(payload.link.smartRoutingRules).toEqual([{ country: "BR", url: "https://example.com/br" }]);
		expect(payload.link.clicks_total).toBe(0);
		expect(payload.link.redirect_type).toBe("302");
	});

	it("does not propagate corrupt persisted rules", async () => {
		await createLink({ slug: "sr-dup-corrupt", targetUrl: "https://example.com/dc" });
		await env.db_boltlink.prepare("UPDATE links SET smart_routing_rules = ? WHERE slug = ?").bind("{broken", "sr-dup-corrupt").run();

		const response = await fetchWorker("http://localhost/api/links/sr-dup-corrupt/duplicate", { method: "POST" });
		expect(response.status).toBe(201);
		const payload = (await response.json()) as { link: { smartRoutingRules: unknown } };
		expect(payload.link.smartRoutingRules).toBeNull();
	});

	it("keeps duplicate working pre-0005", async () => {
		await resetAll();
		await applyChain(PRE_0005);
		await createLink({ slug: "sr-dup-pre", targetUrl: "https://example.com/dp" });

		const response = await fetchWorker("http://localhost/api/links/sr-dup-pre/duplicate", { method: "POST" });
		expect(response.status).toBe(201);
	});
});

	it("rejects a hybrid source (A/B active + valid routing) with 409 and zero insert", async () => {
		await createLink({ slug: "hybrid-source", targetUrl: "https://example.com/h", abEnabled: true, abTargetUrl: "https://example.com/hb" });
		await env.db_boltlink.prepare("UPDATE links SET smart_routing_rules = ? WHERE slug = ?").bind(CANONICAL_COUNTRY_RULE, "hybrid-source").run();

		const sourceBefore = await duplicateSnapshot("hybrid-source");
		expect(sourceBefore).toMatchObject({ ab_enabled: 1 });
		expect(sourceBefore?.smart_routing_rules).toBe(CANONICAL_COUNTRY_RULE);

		const countBefore = await linkCount();
		const response = await fetchWorker("http://localhost/api/links/hybrid-source/duplicate", { method: "POST" });
		expect(response.status).toBe(409);
		const body = await response.text();
		expect(body).toContain("incompatible routing configuration");
		expect(body).not.toContain("example.com");

		expect(await linkCount()).toBe(countBefore);
		const rows = await env.db_boltlink.prepare("SELECT slug FROM links").all<{ slug: string }>();
		expect((rows.results ?? []).map((row) => row.slug)).toEqual(["hybrid-source"]);
		expect(await duplicateSnapshot("hybrid-source")).toEqual(sourceBefore);
	});

	it("allows duplicate when A/B is active and routing is NULL", async () => {
		await createLink({ slug: "dup-ab-only", targetUrl: "https://example.com/ab", abEnabled: true, abTargetUrl: "https://example.com/ab-b" });

		const response = await fetchWorker("http://localhost/api/links/dup-ab-only/duplicate", { method: "POST" });
		expect(response.status).toBe(201);
		const payload = (await response.json()) as { link: Record<string, unknown> };
		expect(payload.link.ab_enabled).toBe(1);
		expect(payload.link.smartRoutingRules).toBeNull();
	});

	it("allows duplicate when A/B is disabled with old history and routing is valid", async () => {
		await createLink({ slug: "dup-history", targetUrl: "https://example.com/hist", smartRoutingRules: COUNTRY_RULE });
		await env.db_boltlink
			.prepare("UPDATE links SET ab_target_url = ?, ab_clicks_a = 4, ab_clicks_b = 5, ab_generation = 3, metric_epoch = 2, ab_started_at = ? WHERE slug = ?")
			.bind("https://example.com/hist-b", "2026-01-01T00:00:00.000Z", "dup-history")
			.run();

		const response = await fetchWorker("http://localhost/api/links/dup-history/duplicate", { method: "POST" });
		expect(response.status).toBe(201);
		const payload = (await response.json()) as { link: Record<string, unknown> };
		expect(payload.link.ab_enabled).toBe(0);
		expect(payload.link.smartRoutingRules).toEqual([{ country: "BR", url: "https://example.com/br" }]);
	});

	it("allows duplicate when A/B is active and routing is corrupt (effective copy is disabled)", async () => {
		await createLink({ slug: "dup-ab-corrupt", targetUrl: "https://example.com/ac", abEnabled: true, abTargetUrl: "https://example.com/ac-b" });
		await env.db_boltlink.prepare("UPDATE links SET smart_routing_rules = ? WHERE slug = ?").bind("{broken", "dup-ab-corrupt").run();

		const response = await fetchWorker("http://localhost/api/links/dup-ab-corrupt/duplicate", { method: "POST" });
		expect(response.status).toBe(201);
		const payload = (await response.json()) as { link: Record<string, unknown> };
		expect(payload.link.ab_enabled).toBe(1);
		expect(payload.link.smartRoutingRules).toBeNull();
		expect(await rawRouting("dup-ab-corrupt")).toBe("{broken");
	});

describe("Smart Routing API: RESET CLICKS", () => {
	it("resets metrics without touching routing rules", async () => {
		await createLink({ slug: "sr-reset", targetUrl: "https://example.com/reset", smartRoutingRules: COUNTRY_RULE });
		const before = await rawRouting("sr-reset");
		await env.db_boltlink.prepare("UPDATE links SET clicks_total = 5 WHERE slug = ?").bind("sr-reset").run();

		const response = await fetchWorker("http://localhost/api/links/sr-reset/reset-clicks", { method: "POST" });
		expect(response.status).toBe(200);
		const state = await linkState("sr-reset");
		expect(state?.clicks_total).toBe(0);
		expect(await rawRouting("sr-reset")).toBe(before);
	});
});

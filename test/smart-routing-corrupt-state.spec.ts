/*
 * Copyright (c) 2026 Vitor Faustino
 * AGPL-3.0 License — https://github.com/vitorgfaustino/boltlink
 *
 * Gate 3.6: corrupt persisted Smart Routing state (BL-SR-GLOBAL-002).
 *
 * A corrupt non-null `smart_routing_rules` is not the same state as a NULL one.
 * The Admin must be able to tell them apart, an unrelated edit must preserve the
 * stored bytes exactly, and only an explicit clear may discard them. Discarding
 * them silently changes public routing: the hybrid fail-safe disappears and the
 * A/B split starts serving Variant B.
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

const FULL_CHAIN = [migration0000, migration0001, migration0002, migration0003, migration0004, migration0005];
const HUMAN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const FALLBACK_URL = "https://example.com/fallback";
const VARIANT_B_URL = "https://example.com/variant-b";
const INVALID_RAW = "INVALID RAW VALUE";
const SLUG = "corrupt-hybrid";

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

async function fetchWorker(url: string, init?: CfInit) {
	const request = new Request(url, init as RequestInit);
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, { ...env, PASSWORD_SESSION_SECRET: "test-secret", db_boltlink: cloneDbHandle(env.db_boltlink) }, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

async function fetchAdminApi(url: string, init?: RequestInit) {
	return fetchWorker(url, init as CfInit);
}

async function listLink(slug: string) {
	const response = await fetchAdminApi("http://localhost/api/links");
	expect(response.status).toBe(200);
	const payload = (await response.json()) as { links: Array<Record<string, unknown> & { slug: string }> };
	return payload.links.find((link) => link.slug === slug);
}

async function patchLink(body: Record<string, unknown>) {
	return fetchAdminApi(`http://localhost/api/links/${SLUG}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function rawState() {
	const row = await env.db_boltlink
		.prepare("SELECT smart_routing_rules, ab_enabled, ab_target_url, redirect_type, clicks_total FROM links WHERE slug = ?")
		.bind(SLUG)
		.first<{
			smart_routing_rules: string | null;
			ab_enabled: number;
			ab_target_url: string | null;
			redirect_type: string;
			clicks_total: number;
		}>();
	expect(row).toBeTruthy();
	return row!;
}

/** Seeds the hybrid corruption: A/B enabled on top of an unreadable routing value. */
async function seedCorruptHybrid() {
	await env.db_boltlink
		.prepare("INSERT INTO links (slug, target_url) VALUES (?, ?)")
		.bind(SLUG, FALLBACK_URL)
		.run();
	await env.db_boltlink
		.prepare("UPDATE links SET ab_enabled = 1, ab_target_url = ?, ab_weight_b = 50, ab_started_at = ?, smart_routing_rules = ? WHERE slug = ?")
		.bind(VARIANT_B_URL, "2026-01-01T00:00:00.000Z", INVALID_RAW, SLUG)
		.run();
	rngControl.value = 0;
	rngControl.calls = 0;
}

/** The exact public request shape used by every assertion in this file. */
function publicRequest() {
	return fetchWorker(`https://example.com/${SLUG}`, { headers: { "user-agent": HUMAN_UA }, cf: { country: "BR" } } as CfInit);
}

beforeEach(async () => {
	await resetAll();
	await applyChain(FULL_CHAIN);
	resetRateLimitStore();
	await seedCorruptHybrid();
});

describe("Phase 3: Smart Routing corrupt state — public fail-safe (BL-SR-GLOBAL-002)", () => {
	it("serves the main destination with no-store and no RNG for a corrupt hybrid", async () => {
		const response = await publicRequest();
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(FALLBACK_URL);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(rngControl.calls).toBe(0);
	});
});

describe("Phase 3: Smart Routing corrupt state — preserved across unrelated edits (BL-SR-GLOBAL-002)", () => {
	it("reports invalid instead of disabled so the client can tell the states apart", async () => {
		const link = await listLink(SLUG);
		expect(link?.smartRoutingStatus).toBe("invalid");
		expect(link?.smartRoutingRules).toBeNull();
		expect(JSON.stringify(link)).not.toContain(INVALID_RAW);
	});

	/**
	 * The permanent closing scenario: the Admin loads the corrupt row, edits only
	 * the tags, and the PATCH must not touch the routing column. Before the fix
	 * the client sent `smartRoutingRules: null` (its "off" value) and the column
	 * was erased, which resumed Variant B.
	 */
	it("keeps the stored bytes, the A/B flag and the public fail-safe on a tags-only edit", async () => {
		const before = await rawState();
		const loaded = await listLink(SLUG);
		expect(loaded?.smartRoutingStatus).toBe("invalid");

		// Faithful tags-only Admin payload: the A/B fields are re-sent as loaded
		// and the routing field is omitted entirely.
		const response = await patchLink({
			targetUrl: FALLBACK_URL,
			redirectType: "302",
			tags: ["editada"],
			abEnabled: true,
			abTargetUrl: VARIANT_B_URL,
			abWeightB: 50,
		});
		expect(response.status).toBe(200);

		const after = await rawState();
		expect(after.smart_routing_rules).toBe(before.smart_routing_rules);
		expect(after.smart_routing_rules).toBe(INVALID_RAW);
		expect(after.ab_enabled).toBe(1);
		expect(after.ab_target_url).toBe(VARIANT_B_URL);

		// Public behavior is identical, including the hybrid fail-safe.
		rngControl.calls = 0;
		const response2 = await publicRequest();
		expect(response2.status).toBe(302);
		expect(response2.headers.get("Location")).toBe(FALLBACK_URL);
		expect(response2.headers.get("Location")).not.toBe(VARIANT_B_URL);
		expect(response2.headers.get("Cache-Control")).toBe("no-store");
		expect(rngControl.calls).toBe(0);

		const listed = await listLink(SLUG);
		expect(listed?.smartRoutingStatus).toBe("invalid");
	});

	it("still refuses to build a new hybrid while the corrupt value is preserved", async () => {
		// A/B is already on; enabling routing on top of it stays rejected, so a
		// preserved corrupt value can never be extended into a valid hybrid.
		const response = await patchLink({ smartRoutingRules: [{ country: "BR", url: "https://example.com/br" }] });
		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: string }).error).toContain("mutually exclusive");
		expect((await rawState()).smart_routing_rules).toBe(INVALID_RAW);
	});
});

describe("Phase 3: Smart Routing corrupt state — explicit clear (BL-SR-GLOBAL-002)", () => {
	/**
	 * The explicit clear is the only path allowed to send `smartRoutingRules: null`
	 * for a corrupt row. Because it is an explicit operator decision, A/B may then
	 * resume - that difference is the point of the finding.
	 */
	it("clears only on the explicit action and lets the A/B split operate again", async () => {
		const response = await patchLink({
			targetUrl: FALLBACK_URL,
			redirectType: "302",
			tags: ["editada"],
			abEnabled: true,
			abTargetUrl: VARIANT_B_URL,
			abWeightB: 50,
			smartRoutingRules: null,
		});
		expect(response.status).toBe(200);

		const state = await rawState();
		expect(state.smart_routing_rules).toBeNull();
		expect(state.ab_enabled).toBe(1);

		const listed = await listLink(SLUG);
		expect(listed?.smartRoutingStatus).toBe("disabled");
		expect(listed?.smartRoutingRules).toBeNull();

		// A/B is valid and no longer shadowed by the hybrid fail-safe.
		rngControl.calls = 0;
		const response2 = await publicRequest();
		expect(response2.status).toBe(302);
		expect(response2.headers.get("Location")).toBe(VARIANT_B_URL);
		expect(response2.headers.get("Cache-Control")).toBe("no-store");
		expect(rngControl.calls).toBe(1);
	});
});

/** Full routing/metrics snapshot: everything a rejected PATCH must leave untouched. */
type RoutingMetrics = {
	smart_routing_rules: string | null;
	ab_enabled: number;
	ab_target_url: string | null;
	ab_weight_b: number;
	ab_generation: number;
	ab_clicks_a: number;
	ab_clicks_b: number;
	ab_started_at: string | null;
	metric_epoch: number;
	version: number;
};

async function routingSnapshot(): Promise<RoutingMetrics> {
	const row = await env.db_boltlink
		.prepare(
			`SELECT smart_routing_rules, ab_enabled, ab_target_url, ab_weight_b, ab_generation,
				ab_clicks_a, ab_clicks_b, ab_started_at, metric_epoch, version
			FROM links WHERE slug = ?`,
		)
		.bind(SLUG)
		.first<RoutingMetrics>();
	expect(row).toBeTruthy();
	return row!;
}

/** Snapshot without `version`, which legitimately changes on an accepted edit. */
function routingState(snapshot: RoutingMetrics) {
	return { ...snapshot, version: 0 };
}

const NEW_VARIANT_B = "https://example.com/new-b";
const VALID_BR_RULE = [{ country: "BR", url: "https://example.com/br" }];
const CANONICAL_BR_RULE = JSON.stringify(VALID_BR_RULE);

/**
 * The hybrid guard reads the effective routing configuration, not field
 * presence, so the Admin may re-send identical A/B values during an unrelated
 * edit while any real change to the split stays rejected.
 */
describe("Phase 3: Smart Routing corrupt state — effective routing change guard (BL-SR-GLOBAL-002)", () => {
	beforeEach(async () => {
		// Counters and generation start non-default so a silent reset is visible.
		await env.db_boltlink
			.prepare("UPDATE links SET ab_generation = 0, ab_clicks_a = 7, ab_clicks_b = 9 WHERE slug = ?")
			.bind(SLUG)
			.run();
	});

	it("rejects a Variant B change on an existing hybrid and preserves every column", async () => {
		const before = await routingSnapshot();
		expect(before).toMatchObject({ ab_target_url: VARIANT_B_URL, ab_generation: 0, ab_clicks_a: 7, ab_clicks_b: 9 });

		const response = await patchLink({ abTargetUrl: NEW_VARIANT_B });
		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: string }).error).toContain("mutually exclusive");

		const after = await routingSnapshot();
		expect(after).toEqual(before);
		expect(after.ab_target_url).toBe(VARIANT_B_URL);
		expect(after.smart_routing_rules).toBe(INVALID_RAW);

		// The public fail-safe is untouched: still the main destination, still no RNG.
		rngControl.calls = 0;
		const publicResponse = await publicRequest();
		expect(publicResponse.status).toBe(302);
		expect(publicResponse.headers.get("Location")).toBe(FALLBACK_URL);
		expect(publicResponse.headers.get("Cache-Control")).toBe("no-store");
		expect(rngControl.calls).toBe(0);
	});

	it("rejects an effective weight change on an existing hybrid", async () => {
		const before = await routingSnapshot();
		expect(before.ab_weight_b).not.toBe(75);

		const response = await patchLink({ abWeightB: 75 });
		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: string }).error).toContain("mutually exclusive");

		const after = await routingSnapshot();
		expect(after).toEqual(before);
		expect(after.ab_weight_b).toBe(before.ab_weight_b);
		expect(after.ab_generation).toBe(0);
		expect(after.ab_clicks_a).toBe(7);
		expect(after.ab_clicks_b).toBe(9);
	});

	it("rejects the exact ASTRA target+weight payload without resetting the split", async () => {
		const before = await routingSnapshot();

		const response = await patchLink({ abTargetUrl: NEW_VARIANT_B, abWeightB: 75 });
		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: string }).error).toContain("mutually exclusive");

		const after = await routingSnapshot();
		expect(after).toEqual(before);
		expect(after.ab_generation).toBe(before.ab_generation);
		expect(after.ab_clicks_a).toBe(7);
		expect(after.ab_clicks_b).toBe(9);
		expect(after.ab_started_at).toBe(before.ab_started_at);
	});

	it("rejects a hybrid rewrite of a valid routing value while A/B stays enabled", async () => {
		await env.db_boltlink
			.prepare("UPDATE links SET smart_routing_rules = ? WHERE slug = ?")
			.bind(CANONICAL_BR_RULE, SLUG)
			.run();

		const before = await routingSnapshot();
		const response = await patchLink({ smartRoutingRules: [{ country: "BR", url: "https://example.com/br2" }] });
		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: string }).error).toContain("mutually exclusive");

		const after = await routingSnapshot();
		expect(after).toEqual(before);
		expect(after.smart_routing_rules).toBe(CANONICAL_BR_RULE);
		expect(after.ab_generation).toBe(0);
	});

	it("accepts an unrelated edit that re-sends identical A/B values and resets nothing", async () => {
		const before = await routingSnapshot();

		const response = await patchLink({
			targetUrl: FALLBACK_URL,
			redirectType: "302",
			tags: ["identico"],
			abEnabled: true,
			abTargetUrl: VARIANT_B_URL,
			abWeightB: 50,
		});
		expect(response.status).toBe(200);

		const after = await routingSnapshot();
		expect(routingState(after)).toEqual(routingState(before));
		expect(after.ab_generation).toBe(0);
		expect(after.ab_clicks_a).toBe(7);
		expect(after.ab_clicks_b).toBe(9);
		expect(after.smart_routing_rules).toBe(INVALID_RAW);
		// An accepted edit follows the normal version policy.
		expect(after.version).toBe(before.version + 1);

		const listed = await listLink(SLUG);
		expect(listed?.tags).toBe(JSON.stringify(["identico"]));
		expect(listed?.smartRoutingStatus).toBe("invalid");
	});

	it("allows an explicit clear combined with an A/B change to leave the hybrid state", async () => {
		const response = await patchLink({
			smartRoutingRules: null,
			abTargetUrl: NEW_VARIANT_B,
			abWeightB: 75,
		});
		expect(response.status).toBe(200);

		const after = await routingSnapshot();
		expect(after.smart_routing_rules).toBeNull();
		expect(after.ab_enabled).toBe(1);
		expect(after.ab_target_url).toBe(NEW_VARIANT_B);
		expect(after.ab_weight_b).toBe(75);
		// Leaving the hybrid state is a normal A/B configuration change.
		expect(after.ab_generation).toBe(1);
		expect(after.ab_clicks_a).toBe(0);
		expect(after.ab_clicks_b).toBe(0);

		// A/B is valid again: a roll below the stored weight serves Variant B.
		rngControl.value = 10;
		rngControl.calls = 0;
		const publicResponse = await publicRequest();
		expect(publicResponse.headers.get("Location")).toBe(NEW_VARIANT_B);
		expect(rngControl.calls).toBe(1);
	});

	it("allows disabling A/B while installing valid routing, leaving the hybrid state", async () => {
		const response = await patchLink({ abEnabled: false, smartRoutingRules: VALID_BR_RULE });
		expect(response.status).toBe(200);

		const after = await routingSnapshot();
		expect(after.ab_enabled).toBe(0);
		expect(after.smart_routing_rules).toBe(CANONICAL_BR_RULE);

		rngControl.calls = 0;
		const publicResponse = await publicRequest();
		expect(publicResponse.status).toBe(302);
		expect(publicResponse.headers.get("Cache-Control")).toBe("no-store");
		expect(rngControl.calls).toBe(0);
	});

	it("still rejects introducing a hybrid on a row that is not hybrid yet", async () => {
		await env.db_boltlink
			.prepare("INSERT INTO links (slug, target_url) VALUES (?, ?)")
			.bind("plain-smart", "https://example.com/plain")
			.run();
		await env.db_boltlink
			.prepare("UPDATE links SET smart_routing_rules = ? WHERE slug = ?")
			.bind(CANONICAL_BR_RULE, "plain-smart")
			.run();

		const response = await fetchAdminApi("http://localhost/api/links/plain-smart", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ abEnabled: true, abTargetUrl: VARIANT_B_URL }),
		});
		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: string }).error).toContain("mutually exclusive");

		const row = await env.db_boltlink
			.prepare("SELECT ab_enabled, smart_routing_rules FROM links WHERE slug = ?")
			.bind("plain-smart")
			.first<{ ab_enabled: number; smart_routing_rules: string | null }>();
		expect(row).toEqual({ ab_enabled: 0, smart_routing_rules: CANONICAL_BR_RULE });
	});

	it("keeps allowing a normal A/B configuration change without Smart Routing", async () => {
		await env.db_boltlink
			.prepare("INSERT INTO links (slug, target_url) VALUES (?, ?)")
			.bind("plain-ab", "https://example.com/plain-ab")
			.run();
		await env.db_boltlink
			.prepare("UPDATE links SET ab_enabled = 1, ab_target_url = ?, ab_weight_b = 50, ab_started_at = ? WHERE slug = ?")
			.bind(VARIANT_B_URL, "2026-01-01T00:00:00.000Z", "plain-ab")
			.run();

		const response = await fetchAdminApi("http://localhost/api/links/plain-ab", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ abTargetUrl: NEW_VARIANT_B, abWeightB: 75 }),
		});
		expect(response.status).toBe(200);

		const row = await env.db_boltlink
			.prepare("SELECT ab_target_url, ab_weight_b, ab_generation FROM links WHERE slug = ?")
			.bind("plain-ab")
			.first<{ ab_target_url: string; ab_weight_b: number; ab_generation: number }>();
		expect(row).toEqual({ ab_target_url: NEW_VARIANT_B, ab_weight_b: 75, ab_generation: 1 });
	});

	it("keeps allowing a normal Smart Routing change while A/B is disabled", async () => {
		await env.db_boltlink
			.prepare("INSERT INTO links (slug, target_url) VALUES (?, ?)")
			.bind("plain-rule", "https://example.com/plain-rule")
			.run();
		await env.db_boltlink
			.prepare("UPDATE links SET smart_routing_rules = ? WHERE slug = ?")
			.bind(CANONICAL_BR_RULE, "plain-rule")
			.run();

		const response = await fetchAdminApi("http://localhost/api/links/plain-rule", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ smartRoutingRules: [{ device: "ios", url: "https://example.com/ios" }] }),
		});
		expect(response.status).toBe(200);

		const row = await env.db_boltlink
			.prepare("SELECT ab_enabled, smart_routing_rules FROM links WHERE slug = ?")
			.bind("plain-rule")
			.first<{ ab_enabled: number; smart_routing_rules: string | null }>();
		expect(row?.ab_enabled).toBe(0);
		expect(row?.smart_routing_rules).toBe(JSON.stringify([{ device: "ios", url: "https://example.com/ios" }]));
	});
});

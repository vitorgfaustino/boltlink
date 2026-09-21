/*
 * Copyright (c) 2026 Vitor Faustino
 * AGPL-3.0 License — https://github.com/vitorgfaustino/boltlink
 *
 * Gate 3.3: Smart Routing integration into the public redirect. The pure domain
 * is covered by smart-routing.spec.ts; this file proves request -> context ->
 * route, fail-safe states, metrics and compatibility with the redirect paths.
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
const FULL_CHAIN = [...PRE_0005, migration0005];

const HUMAN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const IPAD_UA = "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const ANDROID_PHONE_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";
const ANDROID_TABLET_UA = "Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const LINUX_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const CROS_UA = "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const UNKNOWN_UA = "SomeCustomClient/1.0";

const FALLBACK_URL = "https://example.com/fallback";
const RULE = (path: string) => `https://example.com/${path}`;

type CfInit = RequestInit & { cf?: { country?: string } };

type LinkMetrics = {
	clicks_total: number;
	ab_enabled: number;
	ab_target_url: string | null;
	ab_clicks_a: number;
	ab_clicks_b: number;
	ab_generation: number;
	metric_epoch: number;
	version: number;
	redirect_type: string;
	smart_routing_rules: string | null;
};

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

async function startWorkerFetch(url: string, init?: CfInit, handle?: D1Database) {
	const request = new Request(url, init as RequestInit);
	const ctx = createExecutionContext();
	const response = await worker.fetch(
		request,
		{ ...env, PASSWORD_SESSION_SECRET: "test-secret", db_boltlink: handle ?? cloneDbHandle(env.db_boltlink) },
		ctx,
	);
	return { response, ctx };
}

async function createLink(body: Record<string, unknown>) {
	return fetchWorker("http://localhost/api/links", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function createRoutingLink(slug: string, rules: unknown, overrides: Record<string, unknown> = {}) {
	const response = await createLink({
		slug,
		targetUrl: FALLBACK_URL,
		smartRoutingRules: rules,
		...overrides,
	});
	expect(response.status).toBe(201);
	return response;
}

async function insertLink(slug: string, targetUrl = FALLBACK_URL) {
	await env.db_boltlink.prepare("INSERT INTO links (slug, target_url) VALUES (?, ?)").bind(slug, targetUrl).run();
}

async function setRawRouting(slug: string, raw: string | null) {
	await env.db_boltlink.prepare("UPDATE links SET smart_routing_rules = ? WHERE slug = ?").bind(raw, slug).run();
}

async function readLink(slug: string) {
	return env.db_boltlink
		.prepare("SELECT clicks_total, ab_enabled, ab_target_url, ab_clicks_a, ab_clicks_b, ab_generation, metric_epoch, version, redirect_type, smart_routing_rules FROM links WHERE slug = ?")
		.bind(slug)
		.first<LinkMetrics>();
}

async function readBaseMetrics(slug: string) {
	return env.db_boltlink
		.prepare("SELECT clicks_total, ab_enabled, ab_target_url, ab_clicks_a, ab_clicks_b, ab_generation, metric_epoch, version, redirect_type FROM links WHERE slug = ?")
		.bind(slug)
		.first<Omit<LinkMetrics, "smart_routing_rules">>();
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

beforeEach(async () => {
	await resetAll();
	await applyChain(FULL_CHAIN);
	resetRateLimitStore();
	rngControl.value = 0;
	rngControl.calls = 0;
});

describe("Phase 3: Smart Routing public redirect — routing context", () => {
	it("routes a country rule with request.cf.country and falls back otherwise", async () => {
		await createRoutingLink("sr-country", [{ country: "BR", url: RULE("br") }]);

		const brazil = await fetchWorker("https://example.com/sr-country", {
			headers: { "user-agent": HUMAN_UA },
			cf: { country: "BR" },
		});
		expect(brazil.status).toBe(302);
		expect(brazil.headers.get("Location")).toBe(RULE("br"));
		expect(brazil.headers.get("Cache-Control")).toBe("no-store");

		const unitedStates = await fetchWorker("https://example.com/sr-country", {
			headers: { "user-agent": HUMAN_UA },
			cf: { country: "US" },
		});
		expect(unitedStates.status).toBe(302);
		expect(unitedStates.headers.get("Location")).toBe(FALLBACK_URL);
		expect(unitedStates.headers.get("Cache-Control")).toBe("no-store");

		expect(await readLink("sr-country")).toMatchObject({ clicks_total: 2 });
	});

	it("never trusts a client-supplied CF-IPCountry header as country metadata", async () => {
		await createRoutingLink("sr-forged-country", [{ country: "BR", url: RULE("br") }]);

		const response = await fetchWorker("https://example.com/sr-forged-country", {
			headers: { "user-agent": HUMAN_UA, "CF-IPCountry": "BR" },
		});
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(FALLBACK_URL);
	});

	it("keeps device-only routing functional when request.cf is absent", async () => {
		await createRoutingLink("sr-device-no-cf", [{ device: "android", url: RULE("android") }]);

		const android = await fetchWorker("https://example.com/sr-device-no-cf", {
			headers: { "user-agent": ANDROID_PHONE_UA },
		});
		expect(android.headers.get("Location")).toBe(RULE("android"));

		const desktop = await fetchWorker("https://example.com/sr-device-no-cf", {
			headers: { "user-agent": HUMAN_UA },
		});
		expect(desktop.headers.get("Location")).toBe(FALLBACK_URL);
	});

	it("normalizes the request country without blocking device-only rules", async () => {
		await createRoutingLink("sr-country-matrix", [
			{ country: "BR", url: RULE("br") },
			{ country: "US", url: RULE("us") },
			{ device: "android", url: RULE("android") },
		]);

		const cases: Array<{ country: string | undefined; ua: string; expected: string }> = [
			{ country: "BR", ua: HUMAN_UA, expected: RULE("br") },
			{ country: "US", ua: HUMAN_UA, expected: RULE("us") },
			{ country: "DE", ua: HUMAN_UA, expected: FALLBACK_URL },
			{ country: undefined, ua: ANDROID_PHONE_UA, expected: RULE("android") },
			{ country: "XX", ua: ANDROID_PHONE_UA, expected: RULE("android") },
			{ country: "T1", ua: ANDROID_PHONE_UA, expected: RULE("android") },
			{ country: "br", ua: ANDROID_PHONE_UA, expected: RULE("android") },
			{ country: "BRA", ua: ANDROID_PHONE_UA, expected: RULE("android") },
		];

		for (const entry of cases) {
			const response = await fetchWorker("https://example.com/sr-country-matrix", {
				headers: { "user-agent": entry.ua },
				cf: entry.country === undefined ? undefined : { country: entry.country },
			});
			expect(response.status).toBe(302);
			expect(response.headers.get("Location")).toBe(entry.expected);
			expect(response.headers.get("Cache-Control")).toBe("no-store");
		}

		expect(await readLink("sr-country-matrix")).toMatchObject({ clicks_total: cases.length });
	});

	it("integrates the device classifier from the request User-Agent", async () => {
		await createRoutingLink("sr-device-matrix", [
			{ device: "ios", url: RULE("ios") },
			{ device: "android", url: RULE("android") },
			{ device: "desktop", url: RULE("desktop") },
			{ device: "other", url: RULE("other") },
		]);

		const cases: Array<[string, string]> = [
			[IPHONE_UA, RULE("ios")],
			[IPAD_UA, RULE("ios")],
			[ANDROID_PHONE_UA, RULE("android")],
			[ANDROID_TABLET_UA, RULE("android")],
			[HUMAN_UA, RULE("desktop")],
			[MAC_UA, RULE("desktop")],
			[LINUX_UA, RULE("desktop")],
			[CROS_UA, RULE("desktop")],
			[UNKNOWN_UA, RULE("other")],
		];

		for (const [userAgent, expected] of cases) {
			const response = await fetchWorker("https://example.com/sr-device-matrix", {
				headers: { "user-agent": userAgent },
			});
			expect(response.headers.get("Location")).toBe(expected);
		}
	});

	it("combines country and device rules in the documented order", async () => {
		await createRoutingLink("sr-combination", [
			{ country: "BR", device: "android", url: RULE("br-android") },
			{ country: "BR", url: RULE("br") },
			{ device: "android", url: RULE("android") },
		]);

		const cases: Array<{ country: string; ua: string; expected: string }> = [
			{ country: "BR", ua: ANDROID_PHONE_UA, expected: RULE("br-android") },
			{ country: "BR", ua: IPHONE_UA, expected: RULE("br") },
			{ country: "US", ua: ANDROID_PHONE_UA, expected: RULE("android") },
			{ country: "US", ua: IPHONE_UA, expected: FALLBACK_URL },
		];

		for (const entry of cases) {
			const response = await fetchWorker("https://example.com/sr-combination", {
				headers: { "user-agent": entry.ua },
				cf: { country: entry.country },
			});
			expect(response.headers.get("Location")).toBe(entry.expected);
		}
	});

	it("uses the first compatible rule even when a later rule would also match", async () => {
		await createRoutingLink("sr-first-match", [
			{ country: "BR", url: RULE("first") },
			{ device: "desktop", url: RULE("second") },
		]);

		const response = await fetchWorker("https://example.com/sr-first-match", {
			headers: { "user-agent": HUMAN_UA },
			cf: { country: "BR" },
		});
		expect(response.headers.get("Location")).toBe(RULE("first"));
	});
});

describe("Phase 3: Smart Routing public redirect — fail-safe states", () => {
	it("falls back to target_url when no rule matches", async () => {
		await createRoutingLink("sr-no-match", [{ country: "JP", url: RULE("jp") }]);

		const response = await fetchWorker("https://example.com/sr-no-match", {
			headers: { "user-agent": HUMAN_UA },
			cf: { country: "US" },
		});
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(FALLBACK_URL);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(await readLink("sr-no-match")).toMatchObject({ clicks_total: 1 });
	});

	it("never returns 301 for a configured routing row even when the database says 301", async () => {
		await createRoutingLink("sr-corrupt-301", [{ country: "BR", url: RULE("br") }]);
		await env.db_boltlink.prepare("UPDATE links SET redirect_type = '301' WHERE slug = ?").bind("sr-corrupt-301").run();

		const match = await fetchWorker("https://example.com/sr-corrupt-301", {
			headers: { "user-agent": HUMAN_UA },
			cf: { country: "BR" },
		});
		expect(match.status).toBe(302);
		expect(match.headers.get("Location")).toBe(RULE("br"));
		expect(match.headers.get("Cache-Control")).toBe("no-store");

		const fallback = await fetchWorker("https://example.com/sr-corrupt-301", {
			headers: { "user-agent": HUMAN_UA },
			cf: { country: "US" },
		});
		expect(fallback.status).toBe(302);
		expect(fallback.headers.get("Location")).toBe(FALLBACK_URL);
		expect(fallback.headers.get("Cache-Control")).toBe("no-store");

		const bot = await fetchWorker("https://example.com/sr-corrupt-301", {
			headers: { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)", "sec-fetch-mode": "navigate" },
			cf: { country: "BR" },
		});
		expect(bot.status).toBe(302);
		expect(bot.headers.get("Location")).toBe(FALLBACK_URL);
		expect(bot.headers.get("Cache-Control")).toBe("no-store");

		expect(await readLink("sr-corrupt-301")).toMatchObject({ clicks_total: 2 });
	});

	it("treats an invalid persisted configuration as fallback with one metric and no 500", async () => {
		await insertLink("sr-invalid");
		await setRawRouting("sr-invalid", "{broken");
		await env.db_boltlink.prepare("UPDATE links SET redirect_type = '301' WHERE slug = ?").bind("sr-invalid").run();

		const response = await fetchWorker("https://example.com/sr-invalid", {
			headers: { "user-agent": HUMAN_UA },
			cf: { country: "BR" },
		});
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(FALLBACK_URL);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		const body = await response.text();
		expect(body).not.toContain("{broken");
		expect(body).not.toContain("fallback");

		expect(await readLink("sr-invalid")).toMatchObject({
			clicks_total: 1,
			ab_clicks_a: 0,
			ab_clicks_b: 0,
			smart_routing_rules: "{broken",
		});
	});

	it("never uses an unsafe persisted URL and keeps the row untouched", async () => {
		await insertLink("sr-unsafe");
		await setRawRouting("sr-unsafe", JSON.stringify([{ country: "BR", url: "javascript:alert(1)" }]));

		const response = await fetchWorker("https://example.com/sr-unsafe", {
			headers: { "user-agent": HUMAN_UA },
			cf: { country: "BR" },
		});
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(FALLBACK_URL);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(await readLink("sr-unsafe")).toMatchObject({ clicks_total: 1 });
		expect((await readLink("sr-unsafe"))?.smart_routing_rules).toContain("javascript");
	});

	it("fails safe on a hybrid A/B + valid routing state without variant counters", async () => {
		await createRoutingLink("sr-hybrid", [{ country: "BR", url: RULE("br") }]);
		await env.db_boltlink
			.prepare("UPDATE links SET ab_enabled = 1, ab_target_url = ? WHERE slug = ?")
			.bind(RULE("ab-variant"), "sr-hybrid")
			.run();
		rngControl.calls = 0;

		const human = await fetchWorker("https://example.com/sr-hybrid", {
			headers: { "user-agent": HUMAN_UA },
			cf: { country: "BR" },
		});
		expect(human.status).toBe(302);
		expect(human.headers.get("Location")).toBe(FALLBACK_URL);
		expect(human.headers.get("Cache-Control")).toBe("no-store");
		expect(rngControl.calls).toBe(0);

		const bot = await fetchWorker("https://example.com/sr-hybrid", {
			headers: { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)", "sec-fetch-mode": "navigate" },
			cf: { country: "BR" },
		});
		expect(bot.status).toBe(302);
		expect(bot.headers.get("Location")).toBe(FALLBACK_URL);

		expect(await readLink("sr-hybrid")).toMatchObject({
			clicks_total: 1,
			ab_clicks_a: 0,
			ab_clicks_b: 0,
			ab_generation: 0,
			version: 1,
		});
		expect(rngControl.calls).toBe(0);
	});

	it("fails safe on a hybrid state even when the persisted routing is invalid", async () => {
		await insertLink("sr-hybrid-invalid");
		await setRawRouting("sr-hybrid-invalid", "{broken");
		await env.db_boltlink
			.prepare("UPDATE links SET ab_enabled = 1, ab_target_url = ? WHERE slug = ?")
			.bind(RULE("ab-variant"), "sr-hybrid-invalid")
			.run();
		rngControl.calls = 0;

		const response = await fetchWorker("https://example.com/sr-hybrid-invalid", {
			headers: { "user-agent": HUMAN_UA },
			cf: { country: "BR" },
		});
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(FALLBACK_URL);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(rngControl.calls).toBe(0);
		expect(await readLink("sr-hybrid-invalid")).toMatchObject({
			clicks_total: 1,
			ab_clicks_a: 0,
			ab_clicks_b: 0,
		});
	});

	it("fails safe on the persisted A/B flag with a NULL variant B target", async () => {
		await createRoutingLink("sr-hybrid-null-b", [{ country: "BR", url: RULE("br") }]);
		await env.db_boltlink
			.prepare("UPDATE links SET ab_enabled = 1, ab_target_url = NULL, redirect_type = '301' WHERE slug = ?")
			.bind("sr-hybrid-null-b")
			.run();
		rngControl.calls = 0;

		const response = await fetchWorker("https://example.com/sr-hybrid-null-b", {
			headers: { "user-agent": HUMAN_UA },
			cf: { country: "BR" },
		});
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(FALLBACK_URL);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(rngControl.calls).toBe(0);
		expect(await readLink("sr-hybrid-null-b")).toMatchObject({
			clicks_total: 1,
			ab_enabled: 1,
			ab_target_url: null,
			ab_clicks_a: 0,
			ab_clicks_b: 0,
			version: 1,
		});
	});

	it("fails safe on the persisted A/B flag with an empty variant B target", async () => {
		await createRoutingLink("sr-hybrid-empty-b", [{ country: "BR", url: RULE("br") }]);
		await env.db_boltlink
			.prepare("UPDATE links SET ab_enabled = 1, ab_target_url = '' WHERE slug = ?")
			.bind("sr-hybrid-empty-b")
			.run();
		rngControl.calls = 0;

		const response = await fetchWorker("https://example.com/sr-hybrid-empty-b", {
			headers: { "user-agent": HUMAN_UA },
			cf: { country: "BR" },
		});
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(FALLBACK_URL);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(rngControl.calls).toBe(0);
		expect(await readLink("sr-hybrid-empty-b")).toMatchObject({
			clicks_total: 1,
			ab_enabled: 1,
			ab_target_url: "",
			ab_clicks_a: 0,
			ab_clicks_b: 0,
		});
	});

	it("keeps the Smart Routing destination untouched in a hybrid state with a valid variant B", async () => {
		await createRoutingLink("sr-hybrid-valid-b", [{ country: "BR", url: RULE("br") }]);
		await env.db_boltlink
			.prepare("UPDATE links SET ab_enabled = 1, ab_target_url = ? WHERE slug = ?")
			.bind(RULE("ab-variant"), "sr-hybrid-valid-b")
			.run();
		rngControl.calls = 0;

		const response = await fetchWorker("https://example.com/sr-hybrid-valid-b", {
			headers: { "user-agent": HUMAN_UA },
			cf: { country: "BR" },
		});
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(FALLBACK_URL);
		expect(rngControl.calls).toBe(0);
		expect(await readLink("sr-hybrid-valid-b")).toMatchObject({
			clicks_total: 1,
			ab_clicks_a: 0,
			ab_clicks_b: 0,
		});
	});

	it("does not bump the version when Smart Routing records a click", async () => {
		await createRoutingLink("sr-version", [{ country: "BR", url: RULE("br") }]);

		await fetchWorker("https://example.com/sr-version", {
			headers: { "user-agent": HUMAN_UA },
			cf: { country: "BR" },
		});

		expect(await readLink("sr-version")).toMatchObject({ clicks_total: 1, version: 1 });
	});
});

describe("Phase 3: Smart Routing public redirect — bots and previews", () => {
	it("sends every recognized automation to target_url with no metric and no alternate URL", async () => {
		await createRoutingLink("sr-bots", [{ country: "BR", url: RULE("br") }, { device: "desktop", url: RULE("desktop") }]);

		const cases: Array<Record<string, string>> = [
			{ "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "sec-fetch-mode": "navigate" },
			{ "user-agent": "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)", "sec-fetch-mode": "navigate" },
			{ "user-agent": "WhatsApp/2.23.20.0", "sec-fetch-mode": "navigate" },
			{ "user-agent": "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)", "sec-fetch-mode": "navigate" },
			{ "user-agent": "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)", "sec-fetch-mode": "navigate" },
			{ "user-agent": HUMAN_UA, "sec-purpose": "prefetch;prerender", "sec-fetch-mode": "navigate" },
		];

		for (const headers of cases) {
			const response = await fetchWorker("https://example.com/sr-bots", { headers, cf: { country: "BR" } });
			expect(response.status).toBe(302);
			expect(response.headers.get("Location")).toBe(FALLBACK_URL);
			expect(response.headers.get("Cache-Control")).toBe("no-store");
		}

		expect(await readLink("sr-bots")).toMatchObject({ clicks_total: 0, ab_clicks_a: 0, ab_clicks_b: 0 });
	});

	it("keeps bots on the fallback even when the persisted routing is corrupt", async () => {
		await insertLink("sr-bot-corrupt");
		await setRawRouting("sr-bot-corrupt", "not-json");

		const response = await fetchWorker("https://example.com/sr-bot-corrupt", {
			headers: { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" },
		});
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(FALLBACK_URL);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(await readLink("sr-bot-corrupt")).toMatchObject({ clicks_total: 0 });
	});
});

describe("Phase 3: Smart Routing public redirect — password and lifecycle", () => {
	it("shows the password gate without routing, counting or leaking the alternate URL", async () => {
		await createRoutingLink("sr-locked", [{ country: "BR", url: RULE("secret-br") }], { password: "abc123" });

		const response = await fetchWorker("https://example.com/sr-locked", {
			headers: { "user-agent": HUMAN_UA },
			cf: { country: "BR" },
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("Location")).toBeNull();
		const body = await response.text();
		expect(body).toContain("Link protegido por senha");
		expect(body).not.toContain("secret-br");
		expect(await readLink("sr-locked")).toMatchObject({ clicks_total: 0 });
	});

	it("never routes or counts a wrong password submission", async () => {
		await createRoutingLink("sr-wrong-password", [{ country: "BR", url: RULE("secret-br") }], { password: "abc123" });

		const response = await fetchWorker("https://example.com/sr-wrong-password", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", "user-agent": HUMAN_UA },
			body: "password=nope",
			cf: { country: "BR" },
		});
		expect(response.status).toBe(401);
		expect(response.headers.get("Location")).toBeNull();
		expect(await response.text()).not.toContain("secret-br");
		expect(await readLink("sr-wrong-password")).toMatchObject({ clicks_total: 0 });
	});

	it("routes an authenticated POST and counts exactly one click", async () => {
		await createRoutingLink("sr-post", [{ country: "BR", url: RULE("br") }], { password: "abc123" });

		const response = await fetchWorker("https://example.com/sr-post", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", "user-agent": HUMAN_UA },
			body: "password=abc123",
			cf: { country: "BR" },
		});
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(RULE("br"));
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		const setCookie = response.headers.get("Set-Cookie") ?? "";
		const sessionCookie = setCookie.split(";")[0];
		expect(sessionCookie).toContain("boltlink_gate_sr-post=");
		expect(setCookie).toContain("HttpOnly");
		expect(setCookie).toContain("SameSite=Lax");
		expect(setCookie).toContain("Secure");
		expect(await readLink("sr-post")).toMatchObject({ clicks_total: 1, ab_clicks_a: 0, ab_clicks_b: 0 });

		const warm = await fetchWorker("https://example.com/sr-post", {
			headers: { Cookie: sessionCookie ?? "", "user-agent": HUMAN_UA },
			cf: { country: "BR" },
		});
		expect(warm.status).toBe(302);
		expect(warm.headers.get("Location")).toBe(RULE("br"));
		expect(await readLink("sr-post")).toMatchObject({ clicks_total: 2 });
	});

	it("fails safe on an authenticated POST when the A/B flag is set with a NULL variant B", async () => {
		await createRoutingLink("sr-post-hybrid-null", [{ country: "BR", url: RULE("br") }], { password: "abc123" });
		await env.db_boltlink
			.prepare("UPDATE links SET ab_enabled = 1, ab_target_url = NULL WHERE slug = ?")
			.bind("sr-post-hybrid-null")
			.run();
		rngControl.calls = 0;

		const response = await fetchWorker("https://example.com/sr-post-hybrid-null", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", "user-agent": HUMAN_UA },
			body: "password=abc123",
			cf: { country: "BR" },
		});
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(FALLBACK_URL);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(response.headers.get("Set-Cookie")).toContain("boltlink_gate_sr-post-hybrid-null=");
		expect(rngControl.calls).toBe(0);
		expect(await readLink("sr-post-hybrid-null")).toMatchObject({
			clicks_total: 1,
			ab_clicks_a: 0,
			ab_clicks_b: 0,
			version: 1,
		});
	});

	it("fails safe on an authenticated POST when the A/B flag is set with an empty variant B", async () => {
		await createRoutingLink("sr-post-hybrid-empty", [{ country: "BR", url: RULE("br") }], { password: "abc123" });
		await env.db_boltlink
			.prepare("UPDATE links SET ab_enabled = 1, ab_target_url = '' WHERE slug = ?")
			.bind("sr-post-hybrid-empty")
			.run();
		rngControl.calls = 0;

		const response = await fetchWorker("https://example.com/sr-post-hybrid-empty", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", "user-agent": HUMAN_UA },
			body: "password=abc123",
			cf: { country: "BR" },
		});
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(FALLBACK_URL);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(rngControl.calls).toBe(0);
		expect(await readLink("sr-post-hybrid-empty")).toMatchObject({
			clicks_total: 1,
			ab_clicks_a: 0,
			ab_clicks_b: 0,
		});
	});

	it("keeps lifecycle decisions ahead of Smart Routing with zero metrics", async () => {
		await createRoutingLink("sr-future", [{ country: "BR", url: RULE("br") }], { goLiveAt: "2099-01-01T00:00:00Z" });
		const future = await fetchWorker("https://example.com/sr-future", {
			headers: { "user-agent": HUMAN_UA },
			cf: { country: "BR" },
		});
		expect(future.status).toBe(404);
		expect(future.headers.get("Location")).toBeNull();

		await createRoutingLink("sr-expired", [{ country: "BR", url: RULE("br") }], { expiresAt: "2001-01-01T00:00:00Z" });
		const expired = await fetchWorker("https://example.com/sr-expired", {
			headers: { "user-agent": HUMAN_UA },
			cf: { country: "BR" },
		});
		expect(expired.status).toBe(410);
		expect(expired.headers.get("Location")).toBeNull();

		await createRoutingLink("sr-disabled", [{ country: "BR", url: RULE("br") }]);
		await env.db_boltlink.prepare("UPDATE links SET disabled_at = ? WHERE slug = ?").bind("2026-01-01T00:00:00.000Z", "sr-disabled").run();
		const disabled = await fetchWorker("https://example.com/sr-disabled", {
			headers: { "user-agent": HUMAN_UA },
			cf: { country: "BR" },
		});
		expect(disabled.status).toBe(404);

		for (const slug of ["sr-future", "sr-expired", "sr-disabled"]) {
			expect(await readLink(slug)).toMatchObject({ clicks_total: 0 });
		}
	});
});

describe("Phase 3: Smart Routing public redirect — metrics and compatibility", () => {
	it("fences a delayed Smart Routing click against a manual reset", async () => {
		await createRoutingLink("sr-reset-race", [{ country: "BR", url: RULE("br") }]);

		const gate = deferred();
		const handle = deferMetricWrites(cloneDbHandle(env.db_boltlink), gate.promise);
		const { response, ctx } = await startWorkerFetch(
			"https://example.com/sr-reset-race",
			{ headers: { "user-agent": HUMAN_UA }, cf: { country: "BR" } },
			handle,
		);
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(RULE("br"));

		const reset = await fetchWorker("http://localhost/api/links/sr-reset-race/reset-clicks", { method: "POST" });
		expect(reset.status).toBe(200);

		gate.resolve();
		await waitOnExecutionContext(ctx);

		expect(await readLink("sr-reset-race")).toMatchObject({ clicks_total: 0, metric_epoch: 1 });

		await fetchWorker("https://example.com/sr-reset-race", {
			headers: { "user-agent": HUMAN_UA },
			cf: { country: "BR" },
		});
		expect(await readLink("sr-reset-race")).toMatchObject({ clicks_total: 1 });
	});

	it("keeps the normal redirect behavior when the routing column is NULL post-0005", async () => {
		await createLink({ slug: "plain-301", targetUrl: "https://example.com/permanent", redirectType: "301" });
		await createLink({ slug: "plain-302", targetUrl: "https://example.com/temporary" });

		const permanent = await fetchWorker("https://example.com/plain-301", { headers: { "user-agent": HUMAN_UA } });
		expect(permanent.status).toBe(301);
		expect(permanent.headers.get("Cache-Control")).toBeNull();

		const temporary = await fetchWorker("https://example.com/plain-302", { headers: { "user-agent": HUMAN_UA } });
		expect(temporary.status).toBe(302);
		expect(temporary.headers.get("Cache-Control")).toBeNull();

		expect(await readLink("plain-301")).toMatchObject({ clicks_total: 1 });
		expect(await readLink("plain-302")).toMatchObject({ clicks_total: 1 });
	});

	it("keeps the exact A/B behavior when routing is NULL post-0005", async () => {
		await createLink({
			slug: "ab-plain",
			targetUrl: RULE("a"),
			abEnabled: true,
			abTargetUrl: RULE("b"),
			abWeightB: 50,
		});

		rngControl.value = 0;
		const variantB = await fetchWorker("https://example.com/ab-plain", { headers: { "user-agent": HUMAN_UA } });
		expect(variantB.status).toBe(302);
		expect(variantB.headers.get("Location")).toBe(RULE("b"));
		expect(variantB.headers.get("Cache-Control")).toBe("no-store");
		expect(rngControl.calls).toBe(1);

		rngControl.value = 50;
		const controlA = await fetchWorker("https://example.com/ab-plain", { headers: { "user-agent": HUMAN_UA } });
		expect(controlA.headers.get("Location")).toBe(RULE("a"));

		const bot = await fetchWorker("https://example.com/ab-plain", {
			headers: { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" },
		});
		expect(bot.headers.get("Location")).toBe(RULE("a"));

		expect(await readLink("ab-plain")).toMatchObject({ clicks_total: 2, ab_clicks_a: 1, ab_clicks_b: 1 });
	});

	it("keeps the public redirect working pre-0005 while the routing projection stays untouched", async () => {
		await resetAll();
		await applyChain(PRE_0005);
		await insertLink("pre-0005-plain");

		const response = await fetchWorker("https://example.com/pre-0005-plain", {
			headers: { "user-agent": HUMAN_UA },
		});
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(FALLBACK_URL);
		expect(await readBaseMetrics("pre-0005-plain")).toMatchObject({ clicks_total: 1 });
	});

	it("keeps A/B and password flows working pre-0005", async () => {
		await resetAll();
		await applyChain(PRE_0005);

		const ab = await createLink({
			slug: "pre-ab",
			targetUrl: RULE("a"),
			abEnabled: true,
			abTargetUrl: RULE("b"),
		});
		expect(ab.status).toBe(201);
		rngControl.value = 0;
		const abResponse = await fetchWorker("https://example.com/pre-ab", { headers: { "user-agent": HUMAN_UA } });
		expect(abResponse.status).toBe(302);
		expect(abResponse.headers.get("Location")).toBe(RULE("b"));
		expect(await readBaseMetrics("pre-ab")).toMatchObject({ clicks_total: 1, ab_clicks_b: 1 });

		const locked = await createLink({ slug: "pre-locked", targetUrl: RULE("locked"), password: "abc123" });
		expect(locked.status).toBe(201);
		const gate = await fetchWorker("https://example.com/pre-locked", { headers: { "user-agent": HUMAN_UA } });
		expect(gate.status).toBe(200);
		expect(await gate.text()).toContain("Link protegido por senha");

		const unlocked = await fetchWorker("https://example.com/pre-locked", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", "user-agent": HUMAN_UA },
			body: "password=abc123",
		});
		expect(unlocked.status).toBe(302);
		expect(unlocked.headers.get("Location")).toBe(RULE("locked"));
		expect(await readBaseMetrics("pre-locked")).toMatchObject({ clicks_total: 1 });
	});

	it("preserves strict-origin referrer policy on Smart Routing redirects", async () => {
		await createRoutingLink("sr-referrer", [{ country: "BR", url: RULE("br") }]);

		const response = await fetchWorker("https://example.com/sr-referrer", {
			headers: { "user-agent": HUMAN_UA },
			cf: { country: "BR" },
		});
		expect(response.status).toBe(302);
		expect(response.headers.get("Referrer-Policy")).toBe("strict-origin");
	});
});

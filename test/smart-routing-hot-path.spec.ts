/*
 * Copyright (c) 2026 Vitor Faustino
 * AGPL-3.0 License — https://github.com/vitorgfaustino/boltlink
 *
 * Gate 3.3: Smart Routing hot path budget. Counts the SQL executed per public
 * request (cold vs warm), proves the redirect never performs a second SELECT or
 * a per-click PRAGMA, and proves bots skip the parser and the classifiers.
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

const control = vi.hoisted(() => ({ parse: 0, classify: 0, country: 0, rng: 0, rngValue: 0 }));

vi.mock("../src/ab-random", () => ({
	randomPercent: () => {
		control.rng += 1;
		return control.rngValue;
	},
}));

vi.mock("../src/smart-routing", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/smart-routing")>();
	return {
		...actual,
		parseSmartRoutingRules: (value: unknown) => {
			control.parse += 1;
			return actual.parseSmartRoutingRules(value);
		},
		parsePersistedSmartRoutingRules: (raw: string | null | undefined) => {
			control.parse += 1;
			return actual.parsePersistedSmartRoutingRules(raw);
		},
		normalizeRequestCountry: (value: unknown) => {
			control.country += 1;
			return actual.normalizeRequestCountry(value);
		},
		classifyDevice: (userAgent: unknown) => {
			control.classify += 1;
			return actual.classifyDevice(userAgent);
		},
	};
});

const PRE_0005 = [migration0000, migration0001, migration0002, migration0003, migration0004];
const FULL_CHAIN = [...PRE_0005, migration0005];
const PRE_0004_WITH_ROUTING = [migration0000, migration0001, migration0002, migration0003, migration0005];

const HUMAN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const BOT_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const FALLBACK_URL = "https://example.com/fallback";
const RULE = (path: string) => `https://example.com/${path}`;

type CfInit = RequestInit & { cf?: { country?: string } };

type SqlTrace = {
	statements: string[];
	handle: D1Database;
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

function tracedDb(db: D1Database): SqlTrace {
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
	return { statements, handle };
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

async function createLink(body: Record<string, unknown>) {
	return fetchWorker("http://localhost/api/links", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function createRoutingLink(slug: string, rules: unknown) {
	const response = await createLink({ slug, targetUrl: FALLBACK_URL, smartRoutingRules: rules });
	expect(response.status).toBe(201);
}

async function insertLink(slug: string) {
	await env.db_boltlink.prepare("INSERT INTO links (slug, target_url) VALUES (?, ?)").bind(slug, FALLBACK_URL).run();
}

async function readClicks(slug: string) {
	return env.db_boltlink.prepare("SELECT clicks_total FROM links WHERE slug = ?").bind(slug).first<{ clicks_total: number }>();
}

function resetControls() {
	control.parse = 0;
	control.classify = 0;
	control.country = 0;
	control.rng = 0;
	control.rngValue = 0;
}

/**
 * The public redirect reads the link row with a column-agnostic wildcard so the
 * statement is valid on every migration level and a migration becomes visible
 * through the row shape. Naming a feature column here would reintroduce the
 * schema dependency the redirect must not have.
 */
const SCHEMA_NEUTRAL_READ = /^SELECT \* FROM links WHERE slug = \? AND disabled_at IS NULL$/;

/** Link-row reads on the public path: exactly one per request, migration-agnostic. */
function linkReads(statements: string[]): string[] {
	return statements.filter((sql) => SCHEMA_NEUTRAL_READ.test(sql));
}

function classifyTrace(statements: string[]) {
	return {
		selects: statements.filter((sql) => sql.trimStart().startsWith("SELECT")),
		updates: statements.filter((sql) => sql.trimStart().startsWith("UPDATE")),
		pragmas: statements.filter((sql) => sql.includes("PRAGMA")),
		inserts: statements.filter((sql) => sql.trimStart().startsWith("INSERT")),
		writes: statements.filter((sql) => /^(UPDATE|INSERT|DELETE)/.test(sql.trimStart())),
	};
}

beforeEach(async () => {
	await resetAll();
	await applyChain(FULL_CHAIN);
	resetRateLimitStore();
	resetControls();
});

describe("Phase 3: Smart Routing hot path — SQL budget", () => {
	it("executes exactly one SELECT and one aggregate UPDATE on a warm human routing request", async () => {
		await createRoutingLink("hot-smart", [{ country: "BR", url: RULE("br") }]);
		const trace = tracedDb(env.db_boltlink);

		await fetchWorker("https://example.com/hot-smart", { headers: { "user-agent": HUMAN_UA }, cf: { country: "BR" } }, trace.handle);
		trace.statements.length = 0;
		resetControls();

		const response = await fetchWorker("https://example.com/hot-smart", { headers: { "user-agent": HUMAN_UA }, cf: { country: "BR" } }, trace.handle);
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(RULE("br"));

		const measured = classifyTrace(trace.statements);
		expect(measured.selects).toHaveLength(1);
		expect(measured.selects[0]).toMatch(SCHEMA_NEUTRAL_READ);
		expect(measured.updates).toHaveLength(1);
		expect(measured.updates[0]).toContain("clicks_total");
		expect(measured.updates[0]).not.toContain("ab_clicks");
		expect(measured.pragmas).toHaveLength(0);
		expect(measured.inserts).toHaveLength(0);
		expect(trace.statements).toHaveLength(2);

		expect(control.parse).toBe(1);
		expect(control.classify).toBe(1);
		expect(control.country).toBe(1);
		expect(control.rng).toBe(0);
		expect(await readClicks("hot-smart")).toMatchObject({ clicks_total: 2 });
	});

	it("executes only the row SELECT for a warm bot and skips parser, classifiers and RNG", async () => {
		await createRoutingLink("hot-bot", [{ country: "BR", url: RULE("br") }]);
		const trace = tracedDb(env.db_boltlink);

		await fetchWorker("https://example.com/hot-bot", { headers: { "user-agent": HUMAN_UA }, cf: { country: "BR" } }, trace.handle);
		trace.statements.length = 0;
		resetControls();

		const response = await fetchWorker("https://example.com/hot-bot", { headers: { "user-agent": BOT_UA, "sec-fetch-mode": "navigate" }, cf: { country: "BR" } }, trace.handle);
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(FALLBACK_URL);
		expect(response.headers.get("Cache-Control")).toBe("no-store");

		const measured = classifyTrace(trace.statements);
		expect(measured.selects).toHaveLength(1);
		expect(measured.writes).toHaveLength(0);
		expect(measured.pragmas).toHaveLength(0);

		expect(control.parse).toBe(0);
		expect(control.classify).toBe(0);
		expect(control.country).toBe(0);
		expect(control.rng).toBe(0);
		expect(await readClicks("hot-bot")).toMatchObject({ clicks_total: 1 });
	});

	it("keeps warm normal links on one SELECT plus one UPDATE with no schema probe", async () => {
		await createLink({ slug: "hot-plain", targetUrl: FALLBACK_URL });
		const trace = tracedDb(env.db_boltlink);

		await fetchWorker("https://example.com/hot-plain", { headers: { "user-agent": HUMAN_UA } }, trace.handle);
		trace.statements.length = 0;
		resetControls();

		const response = await fetchWorker("https://example.com/hot-plain", { headers: { "user-agent": HUMAN_UA } }, trace.handle);
		expect(response.status).toBe(302);

		const measured = classifyTrace(trace.statements);
		expect(measured.selects).toHaveLength(1);
		expect(measured.updates).toHaveLength(1);
		expect(measured.pragmas).toHaveLength(0);
		expect(trace.statements).toHaveLength(2);
		expect(control.parse).toBe(0);
		expect(control.rng).toBe(0);
	});

	it("keeps the link read schema-neutral and stops probing once the handle is warm", async () => {
		await createRoutingLink("hot-cold", [{ country: "BR", url: RULE("br") }]);
		const trace = tracedDb(env.db_boltlink);

		const cold = await fetchWorker("https://example.com/hot-cold", { headers: { "user-agent": HUMAN_UA }, cf: { country: "BR" } }, trace.handle);
		expect(cold.headers.get("Location")).toBe(RULE("br"));
		const coldTrace = classifyTrace(trace.statements);
		// Cold only pays the one-time bootstrap lookup; the link itself is still a
		// single wildcard read, and no capability is probed for it.
		expect(linkReads(trace.statements)).toHaveLength(1);
		expect(coldTrace.selects.every((sql) => SCHEMA_NEUTRAL_READ.test(sql) || /sqlite_master/i.test(sql))).toBe(true);

		trace.statements.length = 0;
		const warm = await fetchWorker("https://example.com/hot-cold", { headers: { "user-agent": HUMAN_UA }, cf: { country: "BR" } }, trace.handle);
		expect(warm.headers.get("Location")).toBe(RULE("br"));
		const warmTrace = classifyTrace(trace.statements);
		expect(warmTrace.pragmas).toHaveLength(0);
		expect(warmTrace.selects).toHaveLength(1);
		expect(warmTrace.selects[0]).toMatch(SCHEMA_NEUTRAL_READ);
		expect(warmTrace.updates).toHaveLength(1);
	});

	it("detects Smart Routing on a cold post-0005 isolate without any admin call", async () => {
		await createRoutingLink("hot-cold-detect", [{ country: "BR", url: RULE("br") }]);
		const trace = tracedDb(env.db_boltlink);

		const first = await fetchWorker("https://example.com/hot-cold-detect", { headers: { "user-agent": HUMAN_UA }, cf: { country: "BR" } }, trace.handle);
		expect(first.status).toBe(302);
		expect(first.headers.get("Location")).toBe(RULE("br"));
		expect(first.headers.get("Cache-Control")).toBe("no-store");
		const coldTrace = classifyTrace(trace.statements);
		expect(linkReads(trace.statements)).toHaveLength(1);
		expect(coldTrace.selects.every((sql) => SCHEMA_NEUTRAL_READ.test(sql) || /sqlite_master/i.test(sql))).toBe(true);
	});

	it("converges on a live 0005 upgrade without any admin call on the public handle", async () => {
		await resetAll();
		await applyChain(PRE_0005);
		await insertLink("hot-live");
		const trace = tracedDb(env.db_boltlink);

		const before = await fetchWorker("https://example.com/hot-live", { headers: { "user-agent": HUMAN_UA }, cf: { country: "BR" } }, trace.handle);
		expect(before.status).toBe(302);
		expect(before.headers.get("Location")).toBe(FALLBACK_URL);
		expect(trace.statements.every((sql) => !sql.includes("smart_routing_rules"))).toBe(true);

		await applyChain([migration0005]);
		await env.db_boltlink
			.prepare("UPDATE links SET smart_routing_rules = ? WHERE slug = ?")
			.bind(JSON.stringify([{ country: "BR", url: RULE("br") }]), "hot-live")
			.run();

		trace.statements.length = 0;
		const after = await fetchWorker("https://example.com/hot-live", { headers: { "user-agent": HUMAN_UA }, cf: { country: "BR" } }, trace.handle);
		expect(after.status).toBe(302);
		expect(after.headers.get("Location")).toBe(RULE("br"));
		expect(after.headers.get("Cache-Control")).toBe("no-store");
		const warmTrace = classifyTrace(trace.statements);
		expect(warmTrace.pragmas).toHaveLength(0);
		expect(warmTrace.selects).toHaveLength(1);
		expect(warmTrace.selects[0]).toMatch(SCHEMA_NEUTRAL_READ);
		expect(warmTrace.updates).toHaveLength(1);
	});

	it("never mentions the routing column in pre-0005 public SQL", async () => {
		await resetAll();
		await applyChain(PRE_0005);
		await insertLink("hot-pre");
		const trace = tracedDb(env.db_boltlink);

		const first = await fetchWorker("https://example.com/hot-pre", { headers: { "user-agent": HUMAN_UA } }, trace.handle);
		expect(first.status).toBe(302);
		expect(first.headers.get("Location")).toBe(FALLBACK_URL);
		expect(trace.statements.length).toBeGreaterThan(0);
		expect(trace.statements.every((sql) => !sql.includes("smart_routing_rules"))).toBe(true);

		trace.statements.length = 0;
		const second = await fetchWorker("https://example.com/hot-pre", { headers: { "user-agent": HUMAN_UA } }, trace.handle);
		expect(second.status).toBe(302);
		expect(trace.statements.length).toBeGreaterThan(0);
		expect(trace.statements.every((sql) => !sql.includes("smart_routing_rules"))).toBe(true);
		expect(trace.statements.every((sql) => !sql.includes("PRAGMA"))).toBe(true);
		expect(await readClicks("hot-pre")).toMatchObject({ clicks_total: 2 });
	});

	it("supports the artificial pre-0004 schema with routing as a total-only writer", async () => {
		await resetAll();
		await applyChain(PRE_0004_WITH_ROUTING);
		await createRoutingLink("hot-legacy-smart", [{ country: "BR", url: RULE("br") }]);
		const trace = tracedDb(env.db_boltlink);

		await fetchWorker("https://example.com/hot-legacy-smart", { headers: { "user-agent": HUMAN_UA }, cf: { country: "BR" } }, trace.handle);
		trace.statements.length = 0;

		const response = await fetchWorker("https://example.com/hot-legacy-smart", { headers: { "user-agent": HUMAN_UA }, cf: { country: "BR" } }, trace.handle);
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(RULE("br"));

		const measured = classifyTrace(trace.statements);
		expect(measured.selects).toHaveLength(1);
		expect(measured.selects[0]).not.toContain("ab_enabled");
		expect(measured.updates).toHaveLength(1);
		expect(measured.updates[0]).toContain("boltlink_metric_fence");
		expect(measured.updates[0]).not.toContain("ab_clicks");
		expect(measured.writes).toHaveLength(1);
		expect(await readClicks("hot-legacy-smart")).toMatchObject({ clicks_total: 2 });
	});
});

describe("Phase 3: Smart Routing hot path — work avoidance proofs", () => {
	it("does not parse or classify an invalid persisted configuration before the fallback", async () => {
		await insertLink("spy-invalid");
		await env.db_boltlink.prepare("UPDATE links SET smart_routing_rules = ? WHERE slug = ?").bind("{broken", "spy-invalid").run();
		resetControls();

		const response = await fetchWorker("https://example.com/spy-invalid", { headers: { "user-agent": HUMAN_UA }, cf: { country: "BR" } });
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(FALLBACK_URL);

		expect(control.parse).toBe(1);
		expect(control.classify).toBe(0);
		expect(control.country).toBe(0);
		expect(control.rng).toBe(0);
	});

	it("runs zero RNG and zero classification on a hybrid state", async () => {
		await createRoutingLink("spy-hybrid", [{ country: "BR", url: RULE("br") }]);
		await env.db_boltlink
			.prepare("UPDATE links SET ab_enabled = 1, ab_target_url = ? WHERE slug = ?")
			.bind(RULE("ab-variant"), "spy-hybrid")
			.run();
		resetControls();

		const response = await fetchWorker("https://example.com/spy-hybrid", { headers: { "user-agent": HUMAN_UA }, cf: { country: "BR" } });
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(FALLBACK_URL);

		expect(control.parse).toBe(0);
		expect(control.classify).toBe(0);
		expect(control.country).toBe(0);
		expect(control.rng).toBe(0);
	});

	it("does not parse or classify a GET password gate", async () => {
		const created = await createLink({
			slug: "spy-gate",
			targetUrl: FALLBACK_URL,
			password: "abc123",
			smartRoutingRules: [{ country: "BR", url: RULE("br") }],
		});
		expect(created.status).toBe(201);
		resetControls();

		const response = await fetchWorker("https://example.com/spy-gate", { headers: { "user-agent": HUMAN_UA }, cf: { country: "BR" } });
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("Link protegido por senha");

		expect(control.parse).toBe(0);
		expect(control.classify).toBe(0);
		expect(control.country).toBe(0);
		expect(control.rng).toBe(0);
	});

	it("does not parse or classify a wrong password POST", async () => {
		const created = await createLink({
			slug: "spy-wrong",
			targetUrl: FALLBACK_URL,
			password: "abc123",
			smartRoutingRules: [{ country: "BR", url: RULE("br") }],
		});
		expect(created.status).toBe(201);
		resetControls();

		const response = await fetchWorker("https://example.com/spy-wrong", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", "user-agent": HUMAN_UA },
			body: "password=nope",
			cf: { country: "BR" },
		});
		expect(response.status).toBe(401);

		expect(control.parse).toBe(0);
		expect(control.classify).toBe(0);
		expect(control.country).toBe(0);
		expect(control.rng).toBe(0);
	});

	it("does not parse or classify a lifecycle-blocked request", async () => {
		const created = await createLink({
			slug: "spy-future",
			targetUrl: FALLBACK_URL,
			goLiveAt: "2099-01-01T00:00:00Z",
			smartRoutingRules: [{ country: "BR", url: RULE("br") }],
		});
		expect(created.status).toBe(201);
		resetControls();

		const response = await fetchWorker("https://example.com/spy-future", { headers: { "user-agent": HUMAN_UA }, cf: { country: "BR" } });
		expect(response.status).toBe(404);

		expect(control.parse).toBe(0);
		expect(control.classify).toBe(0);
		expect(control.country).toBe(0);
		expect(control.rng).toBe(0);
	});

	it("runs zero engine work on a hybrid flag with a NULL variant B target", async () => {
		await createRoutingLink("spy-hybrid-null-b", [{ country: "BR", url: RULE("br") }]);
		await env.db_boltlink
			.prepare("UPDATE links SET ab_enabled = 1, ab_target_url = NULL WHERE slug = ?")
			.bind("spy-hybrid-null-b")
			.run();
		resetControls();

		const response = await fetchWorker("https://example.com/spy-hybrid-null-b", { headers: { "user-agent": HUMAN_UA }, cf: { country: "BR" } });
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(FALLBACK_URL);
		expect(response.headers.get("Cache-Control")).toBe("no-store");

		expect(control.parse).toBe(0);
		expect(control.classify).toBe(0);
		expect(control.country).toBe(0);
		expect(control.rng).toBe(0);
		expect(await readClicks("spy-hybrid-null-b")).toMatchObject({ clicks_total: 1 });
	});

	it("runs zero engine work on a hybrid flag with an empty variant B target", async () => {
		await createRoutingLink("spy-hybrid-empty-b", [{ country: "BR", url: RULE("br") }]);
		await env.db_boltlink
			.prepare("UPDATE links SET ab_enabled = 1, ab_target_url = '' WHERE slug = ?")
			.bind("spy-hybrid-empty-b")
			.run();
		resetControls();

		const response = await fetchWorker("https://example.com/spy-hybrid-empty-b", { headers: { "user-agent": HUMAN_UA }, cf: { country: "BR" } });
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(FALLBACK_URL);

		expect(control.parse).toBe(0);
		expect(control.classify).toBe(0);
		expect(control.country).toBe(0);
		expect(control.rng).toBe(0);
		expect(await readClicks("spy-hybrid-empty-b")).toMatchObject({ clicks_total: 1 });
	});

	it("runs zero engine work on an authenticated hybrid POST with a NULL variant B", async () => {
		const created = await createLink({
			slug: "spy-post-hybrid",
			targetUrl: FALLBACK_URL,
			password: "abc123",
			smartRoutingRules: [{ country: "BR", url: RULE("br") }],
		});
		expect(created.status).toBe(201);
		await env.db_boltlink
			.prepare("UPDATE links SET ab_enabled = 1, ab_target_url = NULL WHERE slug = ?")
			.bind("spy-post-hybrid")
			.run();
		resetControls();

		const response = await fetchWorker("https://example.com/spy-post-hybrid", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", "user-agent": HUMAN_UA },
			body: "password=abc123",
			cf: { country: "BR" },
		});
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(FALLBACK_URL);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(response.headers.get("Set-Cookie")).toContain("boltlink_gate_spy-post-hybrid=");

		expect(control.parse).toBe(0);
		expect(control.classify).toBe(0);
		expect(control.country).toBe(0);
		expect(control.rng).toBe(0);
		expect(await readClicks("spy-post-hybrid")).toMatchObject({ clicks_total: 1 });
	});

	it("keeps the A/B RNG working when routing is NULL", async () => {
		const created = await createLink({
			slug: "spy-ab",
			targetUrl: RULE("a"),
			abEnabled: true,
			abTargetUrl: RULE("b"),
		});
		expect(created.status).toBe(201);
		resetControls();
		control.rngValue = 0;

		const response = await fetchWorker("https://example.com/spy-ab", { headers: { "user-agent": HUMAN_UA } });
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(RULE("b"));
		expect(control.rng).toBe(1);
		expect(control.parse).toBe(0);
		expect(control.classify).toBe(0);
		expect(control.country).toBe(0);
	});
});

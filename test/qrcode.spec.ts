/**
 * Copyright (c) 2026 Vitor Faustino
 *
 * This program is free software and can be redistributed under the terms of the GNU
 * Affero General Public License as published by the Free Software Foundation, either
 * version 3 of the License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/*
 * Phase 5, Gate 5.4: QR code generation contract.
 *
 * The QR is a rendering of the public short URL, decided by the same Worker that
 * serves the redirect. Every content assertion below is a byte-for-byte comparison
 * against the qrcode library rendering the expected URL with the endpoint's exact
 * options, which proves the encoded payload without shipping a decoder dependency:
 * a different URL (the destination, a variant, a rule target, a secret) produces a
 * different document, and identical bytes are only possible for identical input.
 */

import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetRateLimitStore } from "../src/rate-limit";
import worker from "../src/index";
import QRCode from "qrcode";

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
	  expired_redirect_url TEXT,
	  ab_enabled INTEGER NOT NULL DEFAULT 0,
	  ab_target_url TEXT,
	  ab_weight_b INTEGER NOT NULL DEFAULT 50,

	  ab_generation INTEGER NOT NULL DEFAULT 0,

	  metric_epoch INTEGER NOT NULL DEFAULT 0,
	  ab_clicks_a INTEGER NOT NULL DEFAULT 0,
	  ab_clicks_b INTEGER NOT NULL DEFAULT 0,
	  ab_started_at TEXT,
	  smart_routing_rules TEXT,
	  version INTEGER NOT NULL DEFAULT 1
	)`,
	"CREATE INDEX IF NOT EXISTS idx_links_slug ON links(slug)",
	"CREATE INDEX IF NOT EXISTS idx_links_created_at ON links(created_at DESC)",
	"CREATE INDEX IF NOT EXISTS idx_links_has_qrcode ON links(has_qrcode)",
	"CREATE INDEX IF NOT EXISTS idx_links_tags ON links(tags)",
	"CREATE INDEX IF NOT EXISTS idx_links_group_id ON links(group_id)",
	`CREATE TABLE IF NOT EXISTS link_groups (
	  id INTEGER PRIMARY KEY AUTOINCREMENT,
	  name TEXT NOT NULL,
	  parent_id INTEGER,
	  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	  FOREIGN KEY (parent_id) REFERENCES link_groups(id) ON DELETE SET NULL
	)`,
	"CREATE INDEX IF NOT EXISTS idx_link_groups_parent_id ON link_groups(parent_id)",
];

/** The exact options the endpoint passes to the renderer. */
const QR_RENDER_OPTIONS = {
	type: "svg",
	margin: 2,
	errorCorrectionLevel: "M",
	width: 512,
} as const;

async function fetchWorker(url: string, init?: RequestInit, overrides?: Partial<Env>) {
	const request = new Request(url, init);
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, { ...env, PASSWORD_SESSION_SECRET: "test-secret", ...overrides }, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

async function resetDatabase() {
	// A full rebuild, not an `IF NOT EXISTS` pass: a test that shrank the table to an
	// older migration level must not leak that shape into the next test.
	await env.db_boltlink.prepare("DROP VIEW IF EXISTS boltlink_metric_fence").run();
	await env.db_boltlink.prepare("DROP TABLE IF EXISTS links").run();
	await env.db_boltlink.prepare("DROP TABLE IF EXISTS link_groups").run();
	for (const statement of SCHEMA_STATEMENTS) {
		await env.db_boltlink.prepare(statement).run();
	}
}

async function createLink(body: Record<string, unknown>) {
	return fetchWorker("http://localhost/api/links", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

/** The document the endpoint must produce for a short URL, computed by the same library. */
async function expectedQrSvg(shortUrl: string) {
	return QRCode.toString(shortUrl, QR_RENDER_OPTIONS);
}

async function readLinkRow(slug: string) {
	return env.db_boltlink
		.prepare("SELECT clicks_total, has_qrcode FROM links WHERE slug = ?")
		.bind(slug)
		.first<{ clicks_total: number; has_qrcode: number }>();
}

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

async function dropEverything() {
	await env.db_boltlink.prepare("DROP VIEW IF EXISTS boltlink_metric_fence").run();
	await env.db_boltlink.prepare("DROP TABLE IF EXISTS link_groups").run();
	await env.db_boltlink.prepare("DROP TABLE IF EXISTS links").run();
}

type TracedHandle = { handle: D1Database; statements: string[] };

/**
 * A distinct handle identity over the same database that records every statement it runs.
 * The readiness caches are per handle, so this is both "a second isolate" and the record
 * of exactly what the request did to the database.
 */
function tracedHandle(db: D1Database): TracedHandle {
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
	return { handle, statements };
}

/** Schema mutation, the class of statement a QR render must never run. */
const DDL_STATEMENT_PATTERN = /^\s*(CREATE|ALTER|DROP)\b/i;
/** Data mutation, the other class the read-only render must never run. */
const DML_STATEMENT_PATTERN = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i;

/** Reads a `sqlite_master` entry, so a projection the runtime created can be observed. */
async function schemaObject(name: string): Promise<{ name: string } | null> {
	return env.db_boltlink
		.prepare("SELECT name FROM sqlite_master WHERE type = 'view' AND name = ?")
		.bind(name)
		.first<{ name: string }>();
}

/**
 * The projection the bootstrapping readiness installs is a side effect of the *write*
 * routes. Dropping it leaves the database prepared but fence-less, which is the state a
 * read-only route must be able to serve from without re-installing it.
 */
async function dropMetricFence(): Promise<void> {
	await env.db_boltlink.prepare("DROP VIEW IF EXISTS boltlink_metric_fence").run();
}

beforeEach(async () => {
	await resetDatabase();
	resetRateLimitStore();
});

describe("Phase 5, Gate 5.4: QR code endpoint", () => {
	it("encodes exactly the public short URL, never the destination", async () => {
		await createLink({ slug: "campanha", targetUrl: "https://destination.example.com/page" });

		const response = await fetchWorker("http://localhost/api/links/campanha/qrcode");
		expect(response.status).toBe(200);

		const body = await response.text();
		expect(body).toBe(await expectedQrSvg("http://localhost/campanha"));
		expect(body).not.toBe(await expectedQrSvg("https://destination.example.com/page"));
	});

	it("serves the image with the admin cache and referrer contracts", async () => {
		await createLink({ slug: "campanha", targetUrl: "https://destination.example.com/page" });

		const response = await fetchWorker("http://localhost/api/links/campanha/qrcode");
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("image/svg+xml; charset=utf-8");
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
	});

	it("rejects reserved slugs with 400 on both QR routes", async () => {
		const getResponse = await fetchWorker("http://localhost/api/links/admin/qrcode");
		expect(getResponse.status).toBe(400);

		const postResponse = await fetchWorker("http://localhost/api/links/robots.txt/qrcode", { method: "POST" });
		expect(postResponse.status).toBe(400);
	});

	it("answers 404 for an unknown slug without writing the flag", async () => {
		const getResponse = await fetchWorker("http://localhost/api/links/nao-existe/qrcode");
		expect(getResponse.status).toBe(404);

		const postResponse = await fetchWorker("http://localhost/api/links/nao-existe/qrcode", { method: "POST" });
		expect(postResponse.status).toBe(404);

		const listResponse = await fetchWorker("http://localhost/api/links?has_qrcode=1");
		const listPayload = (await listResponse.json()) as { links: Array<{ slug: string }> };
		expect(listPayload.links.some((link) => link.slug === "nao-existe")).toBe(false);
	});

	it("answers 404 for a disabled (tombstoned) link on both QR routes", async () => {
		await createLink({ slug: "qr-tombstone", targetUrl: "https://example.com/gone" });
		await fetchWorker("http://localhost/api/links/qr-tombstone", { method: "DELETE" });

		const getResponse = await fetchWorker("http://localhost/api/links/qr-tombstone/qrcode");
		expect(getResponse.status).toBe(404);

		const postResponse = await fetchWorker("http://localhost/api/links/qr-tombstone/qrcode", { method: "POST" });
		expect(postResponse.status).toBe(404);
	});

	it("does not count a click for generation or for marking the flag", async () => {
		await createLink({ slug: "campanha", targetUrl: "https://destination.example.com/page" });

		await fetchWorker("http://localhost/api/links/campanha/qrcode");
		await fetchWorker("http://localhost/api/links/campanha/qrcode", { method: "POST" });

		const row = await readLinkRow("campanha");
		expect(row?.clicks_total).toBe(0);
	});

	it("marks has_qrcode only through the POST, never through generation", async () => {
		await createLink({ slug: "campanha", targetUrl: "https://destination.example.com/page" });

		await fetchWorker("http://localhost/api/links/campanha/qrcode");
		expect((await readLinkRow("campanha"))?.has_qrcode).toBe(0);

		const markResponse = await fetchWorker("http://localhost/api/links/campanha/qrcode", { method: "POST" });
		expect(markResponse.status).toBe(200);
		expect((await readLinkRow("campanha"))?.has_qrcode).toBe(1);
	});

	it("encodes only the short URL for a password-protected link", async () => {
		await createLink({ slug: "qr-senha", targetUrl: "https://example.com/privado", password: "abc123" });

		const response = await fetchWorker("http://localhost/api/links/qr-senha/qrcode");
		expect(response.status).toBe(200);

		const body = await response.text();
		expect(body).toBe(await expectedQrSvg("http://localhost/qr-senha"));
		expect(body).not.toContain("abc123");
	});

	it("encodes only the short URL for an A/B link", async () => {
		await createLink({
			slug: "qr-ab",
			targetUrl: "https://example.com/a",
			abEnabled: true,
			abTargetUrl: "https://example.com/b",
			abWeightB: 30,
		});

		const response = await fetchWorker("http://localhost/api/links/qr-ab/qrcode");
		expect(response.status).toBe(200);

		const body = await response.text();
		expect(body).toBe(await expectedQrSvg("http://localhost/qr-ab"));
		expect(body).not.toBe(await expectedQrSvg("https://example.com/b"));
	});

	it("encodes only the short URL for a Smart Routing link", async () => {
		await createLink({
			slug: "qr-smart",
			targetUrl: "https://example.com/fallback",
			redirectType: "302",
			smartRoutingRules: [
				{ country: "BR", device: "android", url: "https://example.com/br-android" },
			],
		});

		const response = await fetchWorker("http://localhost/api/links/qr-smart/qrcode");
		expect(response.status).toBe(200);

		const body = await response.text();
		expect(body).toBe(await expectedQrSvg("http://localhost/qr-smart"));
		expect(body).not.toBe(await expectedQrSvg("https://example.com/br-android"));
	});

	it("encodes the same short URL for scheduled and for expired links", async () => {
		const goLiveAt = new Date(Date.now() + 60_000).toISOString();
		const futureExpiry = new Date(Date.now() + 120_000).toISOString();
		await createLink({
			slug: "qr-agendado",
			targetUrl: "https://example.com/agendado",
			goLiveAt,
			expiresAt: futureExpiry,
			expiredRedirectUrl: "https://example.com/expirado",
		});

		const scheduledResponse = await fetchWorker("http://localhost/api/links/qr-agendado/qrcode");
		expect(scheduledResponse.status).toBe(200);
		expect(await scheduledResponse.text()).toBe(await expectedQrSvg("http://localhost/qr-agendado"));

		const pastExpiry = new Date(Date.now() - 60_000).toISOString();
		await createLink({
			slug: "qr-expirado",
			targetUrl: "https://example.com/expirado",
			expiresAt: pastExpiry,
			expiredRedirectUrl: "https://example.com/pos-expiracao",
		});

		const expiredResponse = await fetchWorker("http://localhost/api/links/qr-expirado/qrcode");
		expect(expiredResponse.status).toBe(200);
		expect(await expiredResponse.text()).toBe(await expectedQrSvg("http://localhost/qr-expirado"));
	});

	it("fails closed with 503 on an unprepared database", async () => {
		await dropEverything();
		const handle = cloneDbHandle(env.db_boltlink);

		const getResponse = await fetchWorker("http://localhost/api/links/campanha/qrcode", undefined, { db_boltlink: handle });
		expect(getResponse.status).toBe(503);

		const postResponse = await fetchWorker("http://localhost/api/links/campanha/qrcode", { method: "POST" }, { db_boltlink: handle });
		expect(postResponse.status).toBe(503);
	});
});

/*
 * `GET /api/links/:slug/qrcode` renders the short URL: it reads the link's existence and
 * nothing else, so its request must not install the metric fence projection the
 * bootstrapping readiness creates. The tests below observe the statements themselves, not
 * just the status code, on a handle that never bootstrapped — which is the only way the
 * side effect is visible.
 */
describe("Phase 5, Gate 5.4: QR generation schema readiness", () => {
	it("never installs the fence projection for a GET on a prepared database", async () => {
		await createLink({ slug: "campanha", targetUrl: "https://destination.example.com/page" });
		// The POST is what a bootstrapping readiness belongs to; dropping the projection it
		// left behind makes the GET the only thing that could create it again.
		await dropMetricFence();
		expect(await schemaObject("boltlink_metric_fence")).toBeNull();

		const traced = tracedHandle(cloneDbHandle(env.db_boltlink));
		const response = await fetchWorker("http://localhost/api/links/campanha/qrcode", undefined, {
			db_boltlink: traced.handle,
		});

		// Prepared is still served: the finding was the DDL, not the answer.
		expect(response.status).toBe(200);
		expect(await response.text()).toBe(await expectedQrSvg("http://localhost/campanha"));

		expect(traced.statements.some((sql) => DDL_STATEMENT_PATTERN.test(sql))).toBe(false);
		expect(traced.statements.some((sql) => DML_STATEMENT_PATTERN.test(sql))).toBe(false);
		expect(traced.statements.some((sql) => /boltlink_metric_fence/i.test(sql))).toBe(false);
		expect(await schemaObject("boltlink_metric_fence")).toBeNull();
	});

	it("stays read-only on a second GET over the same handle", async () => {
		await createLink({ slug: "campanha", targetUrl: "https://destination.example.com/page" });
		await dropMetricFence();

		const traced = tracedHandle(cloneDbHandle(env.db_boltlink));
		const first = await fetchWorker("http://localhost/api/links/campanha/qrcode", undefined, {
			db_boltlink: traced.handle,
		});
		expect(first.status).toBe(200);
		traced.statements.length = 0;

		const second = await fetchWorker("http://localhost/api/links/campanha/qrcode", undefined, {
			db_boltlink: traced.handle,
		});
		expect(second.status).toBe(200);

		// Warm: like the bootstrapping readiness, the read-only one is cached, so not even a
		// PRAGMA is issued — and still nothing is written.
		expect(traced.statements.some((sql) => /PRAGMA/i.test(sql))).toBe(false);
		expect(traced.statements.some((sql) => DDL_STATEMENT_PATTERN.test(sql))).toBe(false);
		expect(traced.statements.some((sql) => DML_STATEMENT_PATTERN.test(sql))).toBe(false);
		expect(await schemaObject("boltlink_metric_fence")).toBeNull();
	});

	it("serves a pre-0004 database without creating the legacy projection", async () => {
		await createLink({ slug: "legado", targetUrl: "https://destination.example.com/page" });
		await dropMetricFence();
		// The pre-0004 shape: `metric_epoch` is owned by migration 0004, so a database that
		// never received it is exactly the case where the fence source switches to the
		// legacy SELECT 0 projection — still a CREATE, and still forbidden here.
		await env.db_boltlink.prepare("ALTER TABLE links DROP COLUMN metric_epoch").run();

		const traced = tracedHandle(cloneDbHandle(env.db_boltlink));
		const response = await fetchWorker("http://localhost/api/links/legado/qrcode", undefined, {
			db_boltlink: traced.handle,
		});

		expect(response.status).toBe(200);
		expect(await response.text()).toBe(await expectedQrSvg("http://localhost/legado"));
		expect(traced.statements.some((sql) => DDL_STATEMENT_PATTERN.test(sql))).toBe(false);
		expect(await schemaObject("boltlink_metric_fence")).toBeNull();
	});

	it("keeps the bootstrapping readiness for the POST that writes the flag", async () => {
		await createLink({ slug: "campanha", targetUrl: "https://destination.example.com/page" });
		await dropMetricFence();
		expect(await schemaObject("boltlink_metric_fence")).toBeNull();

		// The write route keeps writing the schema it needs: read-only is specific to the
		// render, and moving the POST would be a behaviour change of its own.
		const traced = tracedHandle(cloneDbHandle(env.db_boltlink));
		const response = await fetchWorker(
			"http://localhost/api/links/campanha/qrcode",
			{ method: "POST" },
			{ db_boltlink: traced.handle },
		);

		expect(response.status).toBe(200);
		expect(traced.statements.some((sql) => /CREATE VIEW IF NOT EXISTS boltlink_metric_fence/i.test(sql))).toBe(true);
		expect(await schemaObject("boltlink_metric_fence")).not.toBeNull();
	});
});

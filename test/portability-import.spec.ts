/*
 * Copyright (c) 2026 Vitor Faustino
 * AGPL-3.0 License — https://github.com/vitorgfaustino/boltlink
 *
 * Phase 5, Gate 5.3: portability import.
 *
 * The import is the inverse of the export, so this suite pins the same three things from
 * the other side: what the format accepts (and refuses) entry by entry, what the
 * destination decides (collisions, capabilities, depth, its own corrupt tree), and the one
 * property that makes an import safe to run at all — the whole document or nothing.
 *
 * Fixtures are written with direct SQL where the point is a *persisted* state the API
 * would refuse or cannot produce (a corrupt tree, an inconsistent row); everything else
 * goes through the API, which is what proves the format and the write paths agree.
 */

import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetRateLimitStore } from "../src/rate-limit";
import worker from "../src/index";
import { PORTABILITY_MAX_BYTES, PORTABILITY_MAX_GROUPS, PORTABILITY_MAX_LINKS } from "../src/portability";

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

/** Columns each migration level is missing, so a capability test can shrink the schema. */
const CAPABILITY_COLUMNS: Record<3 | 4 | 5 | 6, string[]> = {
	3: [
		"\t  expired_redirect_url TEXT,\n",
		"\t  ab_enabled INTEGER NOT NULL DEFAULT 0,\n",
		"\t  ab_target_url TEXT,\n",
		"\t  ab_weight_b INTEGER NOT NULL DEFAULT 50,\n",
		"\t  ab_generation INTEGER NOT NULL DEFAULT 0,\n",
		"\t  metric_epoch INTEGER NOT NULL DEFAULT 0,\n",
		"\t  ab_clicks_a INTEGER NOT NULL DEFAULT 0,\n",
		"\t  ab_clicks_b INTEGER NOT NULL DEFAULT 0,\n",
		"\t  ab_started_at TEXT,\n",
		"\t  smart_routing_rules TEXT,\n",
	],
	4: ["\t  expired_redirect_url TEXT,\n", "\t  smart_routing_rules TEXT,\n"],
	5: ["\t  expired_redirect_url TEXT,\n"],
	6: [],
};

function schemaAt(migration: 3 | 4 | 5 | 6): string[] {
	const removed = CAPABILITY_COLUMNS[migration];
	return SCHEMA_STATEMENTS.map((statement) => removed.reduce((sql, column) => sql.replace(column, ""), statement));
}

/** Rebuilds an empty database at the newest level. */
async function resetDatabase() {
	await env.db_boltlink.prepare("DROP TABLE IF EXISTS links").run();
	await env.db_boltlink.prepare("DROP TABLE IF EXISTS link_groups").run();
	await env.db_boltlink.prepare("DROP VIEW IF EXISTS boltlink_metric_fence").run();
	for (const statement of SCHEMA_STATEMENTS) {
		await env.db_boltlink.prepare(statement).run();
	}
}

/** Rebuilds `links` at an older migration level, leaving the group table alone. */
async function installSchemaLevel(migration: 3 | 4 | 5 | 6) {
	await env.db_boltlink.prepare("DROP TABLE IF EXISTS links").run();
	await env.db_boltlink.prepare("DROP VIEW IF EXISTS boltlink_metric_fence").run();
	for (const statement of schemaAt(migration)) {
		await env.db_boltlink.prepare(statement).run();
	}
}

async function fetchWorker(url: string, init?: RequestInit, overrides?: Partial<Env>) {
	const request = new Request(url, init);
	const ctx = createExecutionContext();
	const response = await worker.fetch(
		request,
		{ ...env, PASSWORD_SESSION_SECRET: "test-secret", ...overrides },
		ctx,
	);
	await waitOnExecutionContext(ctx);
	return response;
}

async function counts(): Promise<{ groups: number; links: number }> {
	const row = await env.db_boltlink
		.prepare("SELECT (SELECT COUNT(1) FROM link_groups) AS groups, (SELECT COUNT(1) FROM links) AS links")
		.first<{ groups: number; links: number }>();
	return { groups: row?.groups ?? -1, links: row?.links ?? -1 };
}

async function schemaObjectNames(): Promise<string[]> {
	const rows = await env.db_boltlink
		.prepare("SELECT type, name FROM sqlite_master ORDER BY type, name")
		.all<{ type: string; name: string }>();
	return (rows.results ?? []).map((row) => `${row.type}:${row.name}`);
}

async function slugRows(): Promise<string[]> {
	const rows = await env.db_boltlink.prepare("SELECT slug FROM links ORDER BY slug").all<{ slug: string }>();
	return (rows.results ?? []).map((row) => row.slug);
}

async function groupRows(): Promise<Array<{ id: number; name: string; parent_id: number | null }>> {
	const rows = await env.db_boltlink
		.prepare("SELECT id, name, parent_id FROM link_groups ORDER BY id")
		.all<{ id: number; name: string; parent_id: number | null }>();
	return rows.results ?? [];
}

type ExportGroup = { ref: string; name: string; parentRef: string | null };
type ExportLink = Record<string, unknown> & { slug: string; groupRef: string | null };
type ExportDocument = {
	format: string;
	schemaVersion: number;
	exportedAt: string;
	groups: ExportGroup[];
	links: ExportLink[];
};

type ApiAnswer = {
	response: Response;
	text: string;
	payload: Record<string, unknown> | null;
};

async function readAnswer(response: Response): Promise<ApiAnswer> {
	const text = await response.text();
	let payload: Record<string, unknown> | null = null;
	try {
		payload = JSON.parse(text) as Record<string, unknown>;
	} catch {
		payload = null;
	}
	return { response, text, payload };
}

async function postImport(path: string, body: unknown, overrides?: Partial<Env>, url = "http://localhost"): Promise<ApiAnswer> {
	return readAnswer(
		await fetchWorker(`${url}${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: typeof body === "string" ? body : JSON.stringify(body),
		}, overrides),
	);
}

async function previewDocument(document: unknown, overrides?: Partial<Env>, url?: string): Promise<ApiAnswer> {
	return postImport("/api/import/preview", { document }, overrides, url);
}

async function applyDocument(
	document: unknown,
	replacementPasswords?: Record<string, string>,
	overrides?: Partial<Env>,
	url?: string,
): Promise<ApiAnswer> {
	return postImport(
		"/api/import/apply",
		replacementPasswords ? { document, replacementPasswords } : { document },
		overrides,
		url,
	);
}

/**
 * Posts raw bytes as the body. Bytes are the only honest way to send a body that is not
 * valid UTF-8: `JSON.stringify` can never produce one.
 */
async function postRawImport(path: string, bytes: Uint8Array, overrides?: Partial<Env>): Promise<ApiAnswer> {
	return readAnswer(
		await fetchWorker(
			`http://localhost${path}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: bytes,
			},
			overrides,
		),
	);
}

/** Position of a byte sequence inside another, or -1. */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
	outer: for (let start = 0; start + needle.length <= haystack.length; start += 1) {
		for (let offset = 0; offset < needle.length; offset += 1) {
			if (haystack[start + offset] !== needle[offset]) {
				continue outer;
			}
		}
		return start;
	}
	return -1;
}

/**
 * The same body with one byte of `marker` replaced by `0xFF`: a byte that is not valid
 * UTF-8 in any position. The text can no longer be read back as the JSON that was
 * serialized, while a decoder in its default mode replaces it with U+FFFD and produces a
 * *different* document that still validates.
 */
function withCorruptedByte(body: string, marker: string): Uint8Array {
	const bytes = new TextEncoder().encode(body);
	const at = indexOfBytes(bytes, new TextEncoder().encode(marker));
	expect(at, `marker ${marker} is not in the body`).toBeGreaterThan(-1);
	bytes[at] = 0xff;
	return bytes;
}

async function readExport(overrides?: Partial<Env>): Promise<ExportDocument> {
	const response = await fetchWorker("http://localhost/api/export", undefined, overrides);
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`expected a 200 export, got ${response.status}: ${text}`);
	}
	return JSON.parse(text) as ExportDocument;
}

function validDocument(overrides: Partial<ExportDocument> = {}): ExportDocument {
	return {
		format: "boltlink-portability",
		schemaVersion: 1,
		exportedAt: "2026-01-01T00:00:00.000Z",
		groups: [],
		links: [],
		...overrides,
	};
}

function validLink(overrides: Record<string, unknown> = {}): ExportLink {
	return {
		slug: "novo-link",
		targetUrl: "https://example.com/destino",
		redirectType: "302",
		tags: [],
		groupRef: null,
		disabled: false,
		goLiveAt: null,
		expiresAt: null,
		passwordProtected: false,
		...overrides,
	} as ExportLink;
}

function validGroup(overrides: Partial<ExportGroup> = {}): ExportGroup {
	return { ref: "g1", name: "Campanha", parentRef: null, ...overrides };
}

/** Asserts one specific issue of a bounded error report, without pinning the rest. */
function expectIssue(answer: ApiAnswer, status: number, path: string, code: string) {
	expect(answer.response.status, answer.text).toBe(status);
	expect(answer.payload?.errors, answer.text).toEqual(
		expect.arrayContaining([{ path, code }]),
	);
}

/** Asserts that no error report leaked a stack, SQL text or a persisted value. */
function expectControlledBody(answer: ApiAnswer) {
	expect(answer.text).not.toMatch(/SQLITE_|SELECT |INSERT |UPDATE |at .*\(.*:\d+:\d+\)/);
	expect(answer.text).not.toContain("stack");
}

async function insertGroup(name: string, parentId: number | null = null): Promise<number> {
	const row = await env.db_boltlink
		.prepare("INSERT INTO link_groups (name, parent_id) VALUES (?, ?) RETURNING id")
		.bind(name, parentId)
		.first<{ id: number }>();
	if (!row) {
		throw new Error("group insert returned no row");
	}
	return row.id;
}

async function insertLink(slug: string, extra: Record<string, unknown> = {}): Promise<void> {
	const row: Record<string, unknown> = {
		target_url: "https://example.com/reservado",
		redirect_type: "302",
		...extra,
		slug,
	};
	const columns = Object.keys(row);
	await env.db_boltlink
		.prepare(`INSERT INTO links (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
		.bind(...Object.values(row))
		.run();
}

function passThrough(target: object, prop: string | symbol) {
	const value = Reflect.get(target, prop);
	return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
}

/**
 * A distinct handle identity over the same database, modelling a second isolate. The schema
 * readiness cache is per handle and positive-only, so a *smaller* schema — an installation
 * that has not applied the newest migration, or one that was never prepared at all — is only
 * observable through an identity that never saw the prepared one.
 */
function cloneDbHandle(db: D1Database): D1Database {
	return new Proxy(db, {
		get(target, prop) {
			return passThrough(target, prop);
		},
	}) as D1Database;
}

type TracedHandle = { handle: D1Database; statements: string[] };

/** A distinct handle identity over the same database that records every statement it runs. */
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

/**
 * Deterministic interleaving of the import race: another operator takes a slug between the
 * apply's collision check and its batch. `seams.injected` proves the competing write ran, so
 * an implementation that stopped checking — or that wrote outside a transaction — cannot
 * pass this test by answering from a state that existed before the race.
 */
function injectSlugBeforeBatch(db: D1Database, slug: string, seams: { injected: number }): D1Database {
	return new Proxy(db, {
		get(target, prop) {
			if (prop !== "batch") {
				return passThrough(target, prop);
			}

			return async (statements: D1PreparedStatement[]) => {
				seams.injected += 1;
				await db
					.prepare("INSERT INTO links (slug, target_url) VALUES (?, ?)")
					.bind(slug, "https://example.com/outro-operador")
					.run();
				return target.batch(statements);
			};
		},
	}) as D1Database;
}

const DDL_STATEMENT_PATTERN = /^\s*(CREATE|ALTER|DROP)\b/i;
const DML_STATEMENT_PATTERN = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i;

/**
 * The same seam as {@link injectSlugBeforeBatch}, for the other table: a group created by
 * another operator between the apply's own reads and its batch. Every id the plan derives
 * from the table shifts, so a mapping that baked in a value read earlier would put the
 * imported links on the wrong groups — or on this one.
 */
function injectGroupBeforeBatch(db: D1Database, name: string, seams: { injected: number }): D1Database {
	return new Proxy(db, {
		get(target, prop) {
			if (prop !== "batch") {
				return passThrough(target, prop);
			}

			return async (statements: D1PreparedStatement[]) => {
				seams.injected += 1;
				await db.prepare("INSERT INTO link_groups (name) VALUES (?)").bind(name).run();
				return target.batch(statements);
			};
		},
	}) as D1Database;
}

/** A handle whose `batch` always fails with the given error, whatever it was asked to run. */
function failingBatchHandle(db: D1Database, error: Error): D1Database {
	return new Proxy(db, {
		get(target, prop) {
			if (prop !== "batch") {
				return passThrough(target, prop);
			}
			return async () => {
				throw error;
			};
		},
	}) as D1Database;
}

/** The id the table shows at its top, and the id the AUTOINCREMENT allocator has spent. */
async function groupIdentityState(): Promise<{ maxId: number; sequence: number }> {
	const row = await env.db_boltlink
		.prepare(
			`SELECT COALESCE((SELECT MAX(id) FROM link_groups), 0) AS maxId,
			        COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'link_groups'), 0) AS sequence`,
		)
		.first<{ maxId: number; sequence: number }>();
	return { maxId: row?.maxId ?? 0, sequence: row?.sequence ?? 0 };
}

/**
 * A destination whose newest groups were deleted: `MAX(id)` falls back to what is left
 * while the AUTOINCREMENT sequence keeps the ids the table already handed out. These are
 * the two numbers the fix has to reconcile, and the shape of a real installation that
 * cleaned up a branch of its tree.
 */
async function spendGroupIds(total: number, keep: number): Promise<void> {
	for (let index = 1; index <= total; index += 1) {
		await insertGroup(`historico-${String(index).padStart(3, "0")}`);
	}
	await env.db_boltlink.prepare("DELETE FROM link_groups WHERE id > ?").bind(keep).run();
}

/**
 * The document's *logical* configuration: group membership expressed as the chain of group
 * names instead of a document-local ref, and links ordered by slug. Refs are regenerated by
 * every export by design, so comparing them would compare numbering, not configuration.
 */
function logicalConfiguration(document: ExportDocument) {
	const byRef = new Map(document.groups.map((group) => [group.ref, group]));

	function pathOf(ref: string | null): string[] | null {
		if (ref === null) {
			return null;
		}
		const chain: string[] = [];
		const seen = new Set<string>();
		let current: string | null = ref;
		while (current !== null) {
			expect(seen.has(current)).toBe(false);
			seen.add(current);
			const group = byRef.get(current);
			if (!group) {
				throw new Error(`dangling ref ${current}`);
			}
			chain.unshift(group.name);
			current = group.parentRef;
		}
		return chain;
	}

	const groups = document.groups
		.map((group) => ({ path: pathOf(group.ref) }))
		.sort((left, right) => JSON.stringify(left.path).localeCompare(JSON.stringify(right.path)));

	const links = [...document.links]
		.sort((left, right) => left.slug.localeCompare(right.slug))
		.map((link) => ({ ...link, groupRef: undefined, groupPath: pathOf(link.groupRef) }));

	return { groups, links };
}

/** A realistic source installation, built through the API the operator would use. */
async function buildSourceConfiguration(): Promise<ExportDocument> {
	const createGroup = async (name: string, parentId?: number) => {
		const response = await fetchWorker("http://localhost/api/groups", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(parentId === undefined ? { name } : { name, parentId }),
		});
		const payload = (await response.json()) as { group?: { id: number } };
		if (!response.ok || !payload.group) {
			throw new Error(`group create failed: ${response.status}`);
		}
		return payload.group.id;
	};

	const createLink = async (body: Record<string, unknown>) => {
		const response = await fetchWorker("http://localhost/api/links", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		const payload = (await response.json()) as { link?: { slug: string } };
		if (!response.ok || !payload.link) {
			throw new Error(`link create failed: ${response.status} ${JSON.stringify(payload)}`);
		}
		return payload.link.slug;
	};

	const root = await createGroup("Campanha");
	const child = await createGroup("Desktop", root);
	const grandchild = await createGroup("Mobile", child);
	await createGroup("Parceiros");

	await createLink({ slug: "plain-link", targetUrl: "https://example.com/plain", tags: ["a", "b"] });
	await createLink({ slug: "grouped-link", targetUrl: "https://example.com/grouped", redirectType: "301", groupId: child });
	await createLink({ slug: "deep-link", targetUrl: "https://example.com/deep", groupId: grandchild });
	await createLink({ slug: "lifecycle-link", targetUrl: "https://example.com/agendado", expiresAt: "2030-01-01T00:00:00.000Z", expiredRedirectUrl: "https://example.com/expirado" });
	await createLink({
		slug: "ab-link",
		targetUrl: "https://example.com/controle",
		abEnabled: true,
		abTargetUrl: "https://example.com/variante",
		abWeightB: 30,
	});
	await createLink({
		slug: "smart-link",
		targetUrl: "https://example.com/padrao",
		smartRoutingRules: [
			{ country: "BR", url: "https://example.com/brasil" },
			{ device: "ios", url: "https://example.com/ios" },
		],
	});
	await createLink({ slug: "protected-link", targetUrl: "https://example.com/protegido", password: "senha-de-origem" });

	const disabled = await createLink({ slug: "disabled-link", targetUrl: "https://example.com/desativado" });
	const deleteResponse = await fetchWorker(`http://localhost/api/links/${disabled}`, { method: "DELETE" });
	if (!deleteResponse.ok) {
		throw new Error(`link delete failed: ${deleteResponse.status}`);
	}

	// Metrics exist on the source and are deliberately not part of the format: this is what
	// makes the destination's zeroed counters an assertion instead of an accident.
	await env.db_boltlink.prepare("UPDATE links SET clicks_total = 7 WHERE slug = ?").bind("plain-link").run();

	return readExport();
}

describe("Phase 5, Gate 5.3: preview is read-only", () => {
	beforeEach(async () => {
		resetRateLimitStore();
		await resetDatabase();
	});

	it("answers a valid document without writing a row or a schema object", async () => {
		const document = validDocument({
			groups: [validGroup({ ref: "g1", name: "Raiz" }), validGroup({ ref: "g2", name: "Filho", parentRef: "g1" })],
			links: [validLink({ slug: "um-link", groupRef: "g2" })],
		});

		const before = { counts: await counts(), objects: await schemaObjectNames() };
		const answer = await previewDocument(document);
		const after = { counts: await counts(), objects: await schemaObjectNames() };

		expect(answer.response.status, answer.text).toBe(200);
		expect(answer.payload).toEqual({
			ok: true,
			summary: { groups: 2, links: 1, disabledLinks: 0, protectedLinks: 0, abTests: 0, smartRouting: 0 },
			conflicts: [],
			requiresPasswords: [],
			warnings: ["METRICS_NOT_EXPORTED"],
		});
		expect(after).toEqual(before);
	});

	it("runs no INSERT, UPDATE, DELETE or DDL while previewing", async () => {
		const document = validDocument({ links: [validLink({ slug: "sem-escrita" })] });
		const traced = tracedHandle(env.db_boltlink);

		await fetchWorker(
			"http://localhost/api/import/preview",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ document }),
			},
			{ db_boltlink: traced.handle } as Partial<Env>,
		);

		expect(traced.statements.length).toBeGreaterThan(0);
		const mutations = traced.statements.filter(
			(statement) => DDL_STATEMENT_PATTERN.test(statement) || DML_STATEMENT_PATTERN.test(statement),
		);
		expect(mutations).toEqual([]);
	});

	it("does not install the metric fence projection, even on a cold handle", async () => {
		const document = validDocument({ links: [validLink({ slug: "fence-check" })] });
		const traced = tracedHandle(env.db_boltlink);

		// A fresh handle identity has no cached readiness, so the first request is where a
		// bootstrapping path would create the projection.
		const answer = await fetchWorker(
			"http://localhost/api/import/preview",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ document }),
			},
			{ db_boltlink: traced.handle } as Partial<Env>,
		);

		expect(answer.status, await answer.text()).toBe(200);
		expect(traced.statements.some((statement) => /CREATE VIEW/i.test(statement))).toBe(false);
		const view = await env.db_boltlink
			.prepare("SELECT name FROM sqlite_master WHERE type = 'view' AND name = ?")
			.bind("boltlink_metric_fence")
			.first<{ name: string }>();
		expect(view).toBeNull();
	});
});

describe("Phase 5, Gate 5.3: envelope and limits", () => {
	beforeEach(async () => {
		resetRateLimitStore();
		await resetDatabase();
	});

	it("refuses a body that is not the import envelope", async () => {
		for (const body of ["", "not json", "[1,2,3]", "{}", '"texto"']) {
			const answer = await postImport("/api/import/preview", body);
			expect(answer.response.status, body).toBe(400);
			expect(answer.payload?.code, body).toBe("INVALID_BODY");
			expectControlledBody(answer);
		}
	});

	it("refuses an unknown envelope key and a document that is not an object", async () => {
		const withExtra = await postImport("/api/import/preview", { document: validDocument(), extra: true });
		expectIssue(withExtra, 400, "envelope.extra", "INVALID_BODY");

		const notAnObject = await previewDocument("documento");
		expect(notAnObject.payload?.code).toBe("INVALID_DOCUMENT");
		expect(notAnObject.response.status).toBe(400);
	});

	it("refuses a document above the format's byte ceiling without truncating it", async () => {
		const padding = "a".repeat(PORTABILITY_MAX_BYTES);
		const answer = await previewDocument(validDocument({ links: [validLink({ tags: [padding] })] }));

		expect(answer.response.status).toBe(413);
		expect(answer.payload?.code).toBe("TOO_LARGE");
		expect(answer.payload?.errors).toEqual([]);
	});

	it("refuses a body above the transport ceiling before parsing it", async () => {
		const answer = await postImport("/api/import/preview", `{"document":{"pad":"${"a".repeat(PORTABILITY_MAX_BYTES + 70 * 1024)}"}}`);
		expect(answer.response.status).toBe(413);
		expect(answer.payload?.code).toBe("TOO_LARGE");
	});

	it("refuses more groups or more links than the format carries, with 413", async () => {
		const tooManyGroups = await previewDocument(
			validDocument({
				groups: Array.from({ length: PORTABILITY_MAX_GROUPS + 1 }, (_, index) => validGroup({ ref: `g${index + 1}`, name: `Grupo ${index}` })),
			}),
		);
		expect(tooManyGroups.response.status).toBe(413);
		expect(tooManyGroups.payload?.code).toBe("TOO_MANY_GROUPS");

		const tooManyLinks = await previewDocument(
			validDocument({
				links: Array.from({ length: PORTABILITY_MAX_LINKS + 1 }, (_, index) => validLink({ slug: `limite-${index}` })),
			}),
		);
		expect(tooManyLinks.response.status).toBe(413);
		expect(tooManyLinks.payload?.code).toBe("TOO_MANY_LINKS");
	});

	it("bounds the error report instead of answering with a cascade", async () => {
		const links = Array.from({ length: 40 }, (_, index) => validLink({ slug: `ruim-${index}`, targetUrl: "ftp://invalido" }));
		const answer = await previewDocument(validDocument({ links }));

		expect(answer.response.status).toBe(400);
		const errors = answer.payload?.errors as Array<{ path: string; code: string }>;
		expect(errors.length).toBe(20);
		expect(errors[0]).toEqual({ path: "links[0].targetUrl", code: "INVALID_TARGET_URL" });
		expectControlledBody(answer);
	});
});

describe("Phase 5, Gate 5.3: request encoding", () => {
	beforeEach(async () => {
		resetRateLimitStore();
		await resetDatabase();
	});

	it("refuses a body that is not valid UTF-8 instead of importing the repaired text", async () => {
		// The corruption lands inside a group name, which is the loudest place for it: a
		// decoding that substitutes U+FFFD still produces a valid document, so the operator
		// would import a configuration whose text is not the text of the file.
		const document = validDocument({ groups: [validGroup({ ref: "g1", name: "MarcadorUnico" })] });
		const bytes = withCorruptedByte(JSON.stringify({ document }), "MarcadorUnico");

		const preview = await postRawImport("/api/import/preview", bytes);
		expect(preview.response.status, preview.text).toBe(400);
		expect(preview.payload?.code).toBe("INVALID_BODY");
		expectControlledBody(preview);

		const applied = await postRawImport("/api/import/apply", bytes);
		expect(applied.response.status, applied.text).toBe(400);
		expect(applied.payload?.code).toBe("INVALID_BODY");
		expectControlledBody(applied);

		expect(await counts()).toEqual({ groups: 0, links: 0 });
	});

	it("still reads a body that is valid UTF-8, including non-ASCII text", async () => {
		const document = validDocument({
			groups: [validGroup({ ref: "g1", name: "Ação — café 😀" })],
			links: [validLink({ slug: "acentuado", tags: ["ação", "café"], groupRef: "g1" })],
		});
		const bytes = new TextEncoder().encode(JSON.stringify({ document }));

		const preview = await postRawImport("/api/import/preview", bytes);
		expect(preview.response.status, preview.text).toBe(200);

		const applied = await postRawImport("/api/import/apply", bytes);
		expect(applied.response.status, applied.text).toBe(200);

		// The text arrives exactly as it was encoded: no replacement character anywhere.
		const stored = await env.db_boltlink
			.prepare("SELECT name FROM link_groups WHERE name = ?")
			.bind("Ação — café 😀")
			.first<{ name: string }>();
		expect(stored?.name).toBe("Ação — café 😀");
		expect(applied.text).not.toContain("\uFFFD");
	});
});

describe("Phase 5, Gate 5.3: document validation", () => {
	beforeEach(async () => {
		resetRateLimitStore();
		await resetDatabase();
	});

	it("refuses a foreign format and an unsupported schema version", async () => {
		const foreign = await previewDocument({ ...validDocument(), format: "outro-formato" });
		expectIssue(foreign, 400, "format", "UNSUPPORTED_FORMAT");

		for (const version of [0, 2, 999]) {
			const answer = await previewDocument({ ...validDocument(), schemaVersion: version });
			expectIssue(answer, 400, "schemaVersion", "UNSUPPORTED_SCHEMA_VERSION");
		}
	});

	it("refuses an unknown field instead of ignoring it", async () => {
		const answer = await previewDocument({ ...validDocument(), passwordHash: "abc" });
		expectIssue(answer, 400, "document.passwordHash", "UNKNOWN_FIELD");

		const inLink = await previewDocument(
			validDocument({ links: [{ ...validLink(), clicks: 12 } as ExportLink] }),
		);
		expectIssue(inLink, 400, "links[0].clicks", "UNKNOWN_FIELD");

		// The typo case the contract names explicitly: the misspelled key is reported and
		// the missing required one is reported too, so nothing is accepted by accident.
		const typo = await previewDocument(
			validDocument({ links: [{ ...validLink(), targetURL: "https://example.com/x", targetUrl: undefined } as unknown as ExportLink] }),
		);
		expect(typo.response.status).toBe(400);
		const codes = (typo.payload?.errors as Array<{ code: string }>).map((entry) => entry.code);
		expect(codes).toContain("UNKNOWN_FIELD");
		expect(codes).toContain("INVALID_LINK_ENTRY");
	});

	it("refuses coercion of every field it checks", async () => {
		const cases: Array<{ link: Record<string, unknown>; path: string; code: string }> = [
			{ link: { redirectType: 302 }, path: "links[0].redirectType", code: "INVALID_REDIRECT_TYPE" },
			{ link: { disabled: "true" }, path: "links[0].disabled", code: "INVALID_LINK_ENTRY" },
			{ link: { passwordProtected: 1 }, path: "links[0].passwordProtected", code: "INVALID_LINK_ENTRY" },
			{ link: { slug: 123 }, path: "links[0].slug", code: "INVALID_SLUG" },
			{ link: { tags: "a,b" }, path: "links[0].tags", code: "INVALID_TAGS" },
			{ link: { tags: [" com-espaco "] }, path: "links[0].tags", code: "INVALID_TAGS" },
			{ link: { goLiveAt: "2026-01-01T10:00" }, path: "links[0].goLiveAt", code: "INVALID_LIFECYCLE" },
			{ link: { expiresAt: 1893456000000 }, path: "links[0].expiresAt", code: "INVALID_LIFECYCLE" },
			{ link: { groupRef: 7 }, path: "links[0].groupRef", code: "INVALID_GROUP_REF" },
		];

		for (const testCase of cases) {
			const answer = await previewDocument(validDocument({ links: [validLink(testCase.link)] }));
			expectIssue(answer, 400, testCase.path, testCase.code);
		}
	});

	it("refuses a reserved or malformed slug", async () => {
		for (const slug of ["admin", "api", "ab", "com espaço"]) {
			const answer = await previewDocument(validDocument({ links: [validLink({ slug })] }));
			expectIssue(answer, 400, "links[0].slug", "INVALID_SLUG");
		}
	});

	it("refuses the same slug twice inside one document", async () => {
		const answer = await previewDocument(
			validDocument({ links: [validLink({ slug: "repetido" }), validLink({ slug: "repetido" })] }),
		);
		expectIssue(answer, 400, "links[1].slug", "DUPLICATE_LINK_SLUG");
		expect(await counts()).toEqual({ groups: 0, links: 0 });
	});

	it("refuses a lifecycle that ends before it starts", async () => {
		const answer = await previewDocument(
			validDocument({
				links: [validLink({ goLiveAt: "2030-06-01T00:00:00.000Z", expiresAt: "2030-01-01T00:00:00.000Z" })],
			}),
		);
		expectIssue(answer, 400, "links[0].expiresAt", "INVALID_LIFECYCLE");
	});

	it("refuses an expired destination without an expiration", async () => {
		const answer = await previewDocument(
			validDocument({ links: [validLink({ expiredRedirectUrl: "https://example.com/expirado" })] }),
		);
		expectIssue(answer, 400, "links[0].expiredRedirectUrl", "INVALID_EXPIRED_REDIRECT");
	});

	it("refuses an A/B configuration the runtime would not write", async () => {
		const enabledWithoutVariant = await previewDocument(
			validDocument({ links: [validLink({ abTest: { enabled: true, variantBUrl: null, weightB: 50 } })] }),
		);
		expectIssue(enabledWithoutVariant, 400, "links[0].abTest.variantBUrl", "INVALID_AB_CONFIG");

		const permanentSplit = await previewDocument(
			validDocument({
				links: [validLink({ redirectType: "301", abTest: { enabled: true, variantBUrl: "https://example.com/b", weightB: 50 } })],
			}),
		);
		expectIssue(permanentSplit, 400, "links[0].abTest.enabled", "INVALID_AB_CONFIG");

		const weightOutOfRange = await previewDocument(
			validDocument({ links: [validLink({ abTest: { enabled: false, variantBUrl: null, weightB: 100 } })] }),
		);
		expectIssue(weightOutOfRange, 400, "links[0].abTest.weightB", "INVALID_AB_CONFIG");
	});

	it("refuses a hybrid routing row and corrupt Smart Routing rules", async () => {
		const hybrid = await previewDocument(
			validDocument({
				links: [
					validLink({
						abTest: { enabled: true, variantBUrl: "https://example.com/b", weightB: 50 },
						smartRouting: [{ country: "BR", url: "https://example.com/brasil" }],
					}),
				],
			}),
		);
		expectIssue(hybrid, 400, "links[0].smartRouting", "CONFLICTING_ROUTING_CONFIG");

		const shadowed = await previewDocument(
			validDocument({
				links: [
					validLink({
						smartRouting: [
							{ country: "BR", url: "https://example.com/a" },
							{ country: "BR", device: "ios", url: "https://example.com/b" },
						],
					}),
				],
			}),
		);
		expectIssue(shadowed, 400, "links[0].smartRouting", "INVALID_SMART_ROUTING");

		const unknownKey = await previewDocument(
			validDocument({ links: [validLink({ smartRouting: [{ country: "BR", url: "https://example.com/a", peso: 1 }] })] }),
		);
		expectIssue(unknownKey, 400, "links[0].smartRouting", "INVALID_SMART_ROUTING");
	});

	it("refuses a Smart Routing configuration on a permanent redirect", async () => {
		const answer = await previewDocument(
			validDocument({
				links: [validLink({ redirectType: "301", smartRouting: [{ country: "BR", url: "https://example.com/brasil" }] })],
			}),
		);
		expectIssue(answer, 400, "links[0].smartRouting", "INVALID_SMART_ROUTING");
	});
});

describe("Phase 5, Gate 5.3: group references", () => {
	beforeEach(async () => {
		resetRateLimitStore();
		await resetDatabase();
	});

	it("refuses a non-canonical group name", async () => {
		for (const name of [" nome", "nome ", "   ", "a".repeat(121)]) {
			const answer = await previewDocument(validDocument({ groups: [validGroup({ name })] }));
			expectIssue(answer, 400, "groups[0].name", "INVALID_GROUP_NAME");
		}
	});

	it("refuses a duplicated ref", async () => {
		const answer = await previewDocument(
			validDocument({ groups: [validGroup({ ref: "g1", name: "A" }), validGroup({ ref: "g1", name: "B" })] }),
		);
		expectIssue(answer, 400, "groups[1].ref", "DUPLICATE_GROUP_REF");
	});

	it("refuses a dangling parent reference", async () => {
		const answer = await previewDocument(
			validDocument({ groups: [validGroup({ ref: "g1", parentRef: "g9" })] }),
		);
		expectIssue(answer, 400, "groups[0].parentRef", "DANGLING_PARENT_REF");
	});

	it("refuses self-parenting and every indirect cycle", async () => {
		const selfParent = await previewDocument(validDocument({ groups: [validGroup({ ref: "g1", parentRef: "g1" })] }));
		expectIssue(selfParent, 400, "groups[0].parentRef", "GROUP_CYCLE");

		const indirect = await previewDocument(
			validDocument({
				groups: [
					validGroup({ ref: "g1", name: "A", parentRef: "g2" }),
					validGroup({ ref: "g2", name: "B", parentRef: "g3" }),
					validGroup({ ref: "g3", name: "C", parentRef: "g1" }),
				],
			}),
		);
		expectIssue(indirect, 400, "groups", "GROUP_CYCLE");

		expect(await counts()).toEqual({ groups: 0, links: 0 });
	});

	it("refuses a link pointing at a group the document does not define", async () => {
		const answer = await previewDocument(
			validDocument({ groups: [validGroup({ ref: "g1" })], links: [validLink({ groupRef: "g2" })] }),
		);
		expectIssue(answer, 400, "links[0].groupRef", "DANGLING_GROUP_REF");
	});
});

describe("Phase 5, Gate 5.3: collisions with the destination", () => {
	beforeEach(async () => {
		resetRateLimitStore();
		await resetDatabase();
	});

	it("blocks the whole import when one slug is already reserved", async () => {
		await insertLink("existente");

		const document = validDocument({
			links: [validLink({ slug: "novo-um" }), validLink({ slug: "existente" }), validLink({ slug: "novo-dois" })],
		});

		const answer = await previewDocument(document);
		expect(answer.response.status, answer.text).toBe(409);
		expect(answer.payload?.code).toBe("SLUG_COLLISION");
		expect(answer.payload?.blockers).toEqual(["SLUG_COLLISION"]);
		expect(answer.payload?.conflicts).toEqual([{ slug: "existente" }]);
		expect(answer.payload?.summary).toEqual({ groups: 0, links: 3, disabledLinks: 0, protectedLinks: 0, abTests: 0, smartRouting: 0 });

		const applied = await applyDocument(document);
		expect(applied.response.status).toBe(409);
		expect(applied.payload?.code).toBe("SLUG_COLLISION");
		expect(await slugRows()).toEqual(["existente"]);
	});

	it("treats a tombstone as a reserved slug", async () => {
		await insertLink("desativado-na-origem", { disabled_at: "2026-01-01T00:00:00.000Z" });

		const answer = await previewDocument(validDocument({ links: [validLink({ slug: "desativado-na-origem" })] }));
		expect(answer.response.status).toBe(409);
		expect(answer.payload?.conflicts).toEqual([{ slug: "desativado-na-origem" }]);
		expect(await counts()).toEqual({ groups: 0, links: 1 });
	});

	it("reports the conflicting slugs in document order and bounds the list", async () => {
		const slugs = Array.from({ length: 30 }, (_, index) => `ocupado-${String(index).padStart(2, "0")}`);
		for (const slug of slugs) {
			await insertLink(slug);
		}

		const answer = await previewDocument(
			validDocument({ links: slugs.map((slug) => validLink({ slug })) }),
		);
		const conflicts = answer.payload?.conflicts as Array<{ slug: string }>;
		expect(conflicts.length).toBe(20);
		expect(conflicts[0]).toEqual({ slug: slugs[0] });
		expect(answer.payload?.conflictsTotal).toBe(30);
	});

	it("allows an import into a non-empty installation when nothing collides", async () => {
		const existingGroup = await insertGroup("Grupo existente");
		await insertLink("ja-existe", { group_id: existingGroup });

		const document = validDocument({
			groups: [validGroup({ ref: "g1", name: "Grupo existente" })],
			links: [validLink({ slug: "novo-link", groupRef: "g1" })],
		});

		const preview = await previewDocument(document);
		expect(preview.response.status, preview.text).toBe(200);

		const applied = await applyDocument(document);
		expect(applied.response.status, applied.text).toBe(200);
		expect(applied.payload).toEqual({ ok: true, groupsCreated: 1, linksCreated: 1 });

		// The group is created, never merged into the equally named one that was already
		// there: a logical ref from the file is a new group, not a name lookup.
		const groups = await groupRows();
		expect(groups.map((group) => group.name)).toEqual(["Grupo existente", "Grupo existente"]);
		expect(groups[1].parent_id).toBeNull();
	});

	it("refuses to import over a destination whose own tree is corrupt", async () => {
		// External SQL is how a corrupt graph appears; the product never writes one. Self
		// parenting is used because the `0002` foreign key refuses a dangling parent, while a
		// ring is accepted by it and is exactly the shape the reader must fail closed on.
		const group = await insertGroup("em-ciclo");
		await env.db_boltlink.prepare("UPDATE link_groups SET parent_id = ? WHERE id = ?").bind(group, group).run();

		const answer = await previewDocument(validDocument({ links: [validLink({ slug: "nao-entra" })] }));
		expect(answer.response.status).toBe(409);
		expect(answer.payload?.blockers).toEqual(["DESTINATION_HIERARCHY_CORRUPT"]);
		expect(await slugRows()).toEqual([]);
	});
});

describe("Phase 5, Gate 5.3: capability and depth blockers", () => {
	/**
	 * A shrunk schema is only visible to a handle that never cached the full one: readiness
	 * is positive-cached per handle by design, so every request here runs on a fresh
	 * identity, exactly like a Worker that started before the migration was applied.
	 */
	function freshHandle(): Partial<Env> {
		return { db_boltlink: cloneDbHandle(env.db_boltlink) } as Partial<Env>;
	}

	beforeEach(async () => {
		resetRateLimitStore();
		await resetDatabase();
	});

	it("blocks a document that uses A/B on a database before migration 0004", async () => {
		await installSchemaLevel(3);

		const document = validDocument({
			links: [validLink({ abTest: { enabled: true, variantBUrl: "https://example.com/b", weightB: 50 } })],
		});

		const answer = await previewDocument(document, freshHandle());
		expect(answer.response.status, answer.text).toBe(409);
		expect(answer.payload?.blockers).toEqual(["TARGET_CAPABILITY_MISSING"]);

		const applied = await applyDocument(document, undefined, freshHandle());
		expect(applied.response.status, applied.text).toBe(409);
		// No automatic migration: the columns of 0004 must not exist afterwards.
		const info = await env.db_boltlink.prepare("PRAGMA table_info(links)").all<{ name: string }>();
		expect((info.results ?? []).some((column) => column.name === "ab_enabled")).toBe(false);
		expect(await counts()).toEqual({ groups: 0, links: 0 });
	});

	it("accepts a default A/B block on the same database, because nothing would be lost", async () => {
		await installSchemaLevel(3);

		const document = validDocument({
			links: [validLink({ slug: "sem-split", abTest: { enabled: false, variantBUrl: null, weightB: 50 } })],
		});

		const preview = await previewDocument(document, freshHandle());
		expect(preview.response.status, preview.text).toBe(200);

		const applied = await applyDocument(document, undefined, freshHandle());
		expect(applied.response.status, applied.text).toBe(200);
		expect(await slugRows()).toEqual(["sem-split"]);
	});

	it("blocks a document that uses Smart Routing on a database before 0005", async () => {
		await installSchemaLevel(4);

		const answer = await previewDocument(
			validDocument({ links: [validLink({ smartRouting: [{ country: "BR", url: "https://example.com/brasil" }] })] }),
			freshHandle(),
		);
		expect(answer.response.status, answer.text).toBe(409);
		expect(answer.payload?.blockers).toEqual(["TARGET_CAPABILITY_MISSING"]);
	});

	it("blocks a document that uses the expired destination on a database before 0006", async () => {
		await installSchemaLevel(5);

		const answer = await previewDocument(
			validDocument({
				links: [validLink({ expiresAt: "2030-01-01T00:00:00.000Z", expiredRedirectUrl: "https://example.com/expirado" })],
			}),
			freshHandle(),
		);
		expect(answer.response.status, answer.text).toBe(409);
		expect(answer.payload?.blockers).toEqual(["TARGET_CAPABILITY_MISSING"]);
	});

	it("accepts a null capability value on an older database, and writes no column", async () => {
		await installSchemaLevel(3);

		const document = validDocument({
			links: [validLink({ slug: "sem-smart", smartRouting: null, expiredRedirectUrl: null })],
		});

		const applied = await applyDocument(document, undefined, freshHandle());
		expect(applied.response.status, applied.text).toBe(200);
		expect(await slugRows()).toEqual(["sem-smart"]);
	});

	it("blocks a legacy tree deeper than the current ceiling, with zero writes", async () => {
		const depth = 17;
		const groups = Array.from({ length: depth }, (_, index) =>
			validGroup({ ref: `g${index + 1}`, name: `Nivel ${index + 1}`, parentRef: index === 0 ? null : `g${index}` }),
		);
		const document = validDocument({ groups, links: [validLink({ slug: "fundo", groupRef: `g${depth}` })] });

		const answer = await previewDocument(document);
		expect(answer.response.status, answer.text).toBe(409);
		expect(answer.payload?.blockers).toEqual(["GROUP_DEPTH_EXCEEDED"]);
		expect(answer.payload?.summary).toEqual({ groups: depth, links: 1, disabledLinks: 0, protectedLinks: 0, abTests: 0, smartRouting: 0 });

		const applied = await applyDocument(document);
		expect(applied.response.status).toBe(409);
		expect(await counts()).toEqual({ groups: 0, links: 0 });
	});

	it("accepts a tree exactly at the ceiling", async () => {
		const depth = 16;
		const groups = Array.from({ length: depth }, (_, index) =>
			validGroup({ ref: `g${index + 1}`, name: `Nivel ${index + 1}`, parentRef: index === 0 ? null : `g${index}` }),
		);
		const document = validDocument({ groups, links: [validLink({ slug: "no-limite", groupRef: `g${depth}` })] });

		const applied = await applyDocument(document);
		expect(applied.response.status, applied.text).toBe(200);
		expect(await counts()).toEqual({ groups: depth, links: 1 });
	});
});

describe("Phase 5, Gate 5.3: cold database", () => {
	beforeEach(async () => {
		resetRateLimitStore();
		await env.db_boltlink.prepare("DROP TABLE IF EXISTS links").run();
		await env.db_boltlink.prepare("DROP TABLE IF EXISTS link_groups").run();
		await env.db_boltlink.prepare("DROP VIEW IF EXISTS boltlink_metric_fence").run();
	});

	it("fails closed with 503 and creates nothing", async () => {
		const before = await schemaObjectNames();
		const document = validDocument({ links: [validLink({ slug: "banco-frio" })] });
		// A handle that never validated a prepared database: readiness is positive-cached per
		// handle, so this is the only identity that observes "never prepared".
		const cold = { db_boltlink: cloneDbHandle(env.db_boltlink) } as Partial<Env>;

		const preview = await previewDocument(document, cold);
		expect(preview.response.status, preview.text).toBe(503);
		expect(preview.payload?.error).toMatch(/not initialized/i);

		const applied = await applyDocument(document, undefined, cold);
		expect(applied.response.status).toBe(503);

		expect(await schemaObjectNames()).toEqual(before);
	});
});

describe("Phase 5, Gate 5.3: atomicity", () => {
	beforeEach(async () => {
		resetRateLimitStore();
		await resetDatabase();
	});

	it("rolls the whole batch back when one statement fails", async () => {
		// The platform property the design relies on, pinned directly: a batch is one SQL
		// transaction, so a failure anywhere leaves nothing behind.
		await insertLink("tomado");
		let failed = false;
		try {
			await env.db_boltlink.batch([
				env.db_boltlink.prepare("INSERT INTO link_groups (id, name, parent_id) VALUES ((SELECT COALESCE(MAX(id), 0) + 1 FROM link_groups), ?, NULL)").bind("grupo do lote"),
				env.db_boltlink.prepare("INSERT INTO links (slug, target_url) VALUES (?, ?)").bind("primeiro", "https://example.com/1"),
				env.db_boltlink.prepare("INSERT INTO links (slug, target_url) VALUES (?, ?)").bind("tomado", "https://example.com/2"),
			]);
		} catch {
			failed = true;
		}

		expect(failed).toBe(true);
		expect(await counts()).toEqual({ groups: 0, links: 1 });
	});

	it("blocks the whole import when a slug is taken after the preview", async () => {
		const groups = [validGroup({ ref: "g1", name: "Importada" }), validGroup({ ref: "g2", name: "Filha", parentRef: "g1" })];
		const links = [
			validLink({ slug: "aaa-primeiro", groupRef: "g1" }),
			validLink({ slug: "bbb-segundo", groupRef: "g2" }),
			validLink({ slug: "zzz-ultimo", groupRef: "g2" }),
		];
		const document = validDocument({ groups, links });

		// The preview is honest, and it is also obsolete one line later.
		const preview = await previewDocument(document);
		expect(preview.response.status, preview.text).toBe(200);
		await insertLink("zzz-ultimo");

		const applied = await applyDocument(document);
		expect(applied.response.status, applied.text).toBe(409);
		expect(applied.payload?.code).toBe("SLUG_COLLISION");
		expect(applied.payload?.conflicts).toEqual([{ slug: "zzz-ultimo" }]);

		// No partial import: the two links that do not collide are not created either.
		expect(await counts()).toEqual({ groups: 0, links: 1 });
		expect(await slugRows()).toEqual(["zzz-ultimo"]);
		expect(await groupRows()).toEqual([]);
	});

	it("rolls the whole document back when the last statement of the batch fails", async () => {
		const groups = Array.from({ length: 3 }, (_, index) =>
			validGroup({ ref: `g${index + 1}`, name: `Grupo ${index + 1}`, parentRef: index === 0 ? null : `g${index}` }),
		);
		const links = [
			validLink({ slug: "aaa-primeiro", groupRef: "g1" }),
			validLink({ slug: "bbb-segundo", groupRef: "g2" }),
			validLink({ slug: "ccc-terceiro", groupRef: "g3" }),
		];
		const document = validDocument({ groups, links });

		const preview = await previewDocument(document);
		expect(preview.response.status, preview.text).toBe(200);

		// The race is injected where it actually hurts: *after* the apply's own collision
		// check read the table and *before* the batch runs, so the failure happens inside the
		// transaction, on the last statement, with every earlier statement already executed.
		const seams = { injected: 0 };
		const racing = injectSlugBeforeBatch(env.db_boltlink, "ccc-terceiro", seams);
		const applied = await applyDocument(document, undefined, { db_boltlink: racing } as Partial<Env>);

		expect(seams.injected).toBe(1);
		expect(applied.response.status, applied.text).toBe(409);
		expect(applied.payload?.code).toBe("SLUG_COLLISION");

		// Without a transaction the three groups and the two links written before the failing
		// statement would still be here; with one, the destination holds exactly what the
		// other operator wrote.
		expect(await counts()).toEqual({ groups: 0, links: 1 });
		expect(await slugRows()).toEqual(["ccc-terceiro"]);
		expect(await groupRows()).toEqual([]);
	});

	it("applies the maximum document — 50 groups and 100 links — in one batch", async () => {
		// A deep chain of 50 would be refused for depth, so the maximum document pairs its 50
		// groups with a shallow tree — the shape the limits are about is the *count*.
		const groups = Array.from({ length: PORTABILITY_MAX_GROUPS }, (_, index) =>
			validGroup({ ref: `g${index + 1}`, name: `Grupo ${String(index).padStart(2, "0")}`, parentRef: index === 0 || index === 1 ? null : "g2" }),
		);
		const links = Array.from({ length: PORTABILITY_MAX_LINKS }, (_, index) =>
			validLink({ slug: `link-${String(index).padStart(3, "0")}`, groupRef: `g${(index % PORTABILITY_MAX_GROUPS) + 1}` }),
		);
		const document = validDocument({ groups, links });

		const preview = await previewDocument(document);
		expect(preview.response.status, preview.text).toBe(200);

		const applied = await applyDocument(document);
		expect(applied.response.status, applied.text).toBe(200);
		expect(applied.payload).toEqual({ ok: true, groupsCreated: 50, linksCreated: 100 });
		expect(await counts()).toEqual({ groups: 50, links: 100 });

		// The mapping is the risky part of the arithmetic: every link must sit on the group
		// its ref named, including the first and the last group of the block.
		const first = await env.db_boltlink
			.prepare("SELECT group_id FROM links WHERE slug = ?")
			.bind("link-000")
			.first<{ group_id: number }>();
		const last = await env.db_boltlink
			.prepare("SELECT group_id FROM links WHERE slug = ?")
			.bind("link-099")
			.first<{ group_id: number }>();
		const groupNames = await groupRows();
		expect(groupNames[first!.group_id - 1].name).toBe("Grupo 00");
		expect(groupNames[last!.group_id - 1].name).toBe("Grupo 49");

		// The sequence keeps going after the explicit block.
		const created = await env.db_boltlink
			.prepare("INSERT INTO link_groups (name) VALUES ('depois') RETURNING id")
			.first<{ id: number }>();
		expect(created?.id).toBe(51);
	});

	it("keeps a failed import from advancing the id sequence", async () => {
		await insertGroup("origem");
		const before = await env.db_boltlink
			.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'link_groups'")
			.first<{ seq: number }>();

		const document = validDocument({ groups: [validGroup({ ref: "g1", name: "Nova" })], links: [validLink({ slug: "colide" })] });
		await insertLink("colide");

		const applied = await applyDocument(document);
		expect(applied.response.status).toBe(409);

		const after = await env.db_boltlink
			.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'link_groups'")
			.first<{ seq: number }>();
		expect(after?.seq).toBe(before?.seq);

		const created = await env.db_boltlink
			.prepare("INSERT INTO link_groups (name) VALUES ('seguinte') RETURNING id")
			.first<{ id: number }>();
		expect(created?.id).toBe(2);
	});
});

describe("Phase 5, Gate 5.3: group identity and target integrity", () => {
	beforeEach(async () => {
		resetRateLimitStore();
		await resetDatabase();
	});

	it("never reuses an id the AUTOINCREMENT sequence has already spent", async () => {
		await spendGroupIds(100, 10);
		const before = await groupIdentityState();
		// The shape this is about: the table's top id fell back to what survived the
		// cleanup, while the allocator's high-water mark still holds the ids it handed out.
		expect(before).toEqual({ maxId: 10, sequence: 100 });

		const document = validDocument({
			groups: [validGroup({ ref: "g1", name: "Importada" }), validGroup({ ref: "g2", name: "Filha", parentRef: "g1" })],
			links: [validLink({ slug: "link-importado", groupRef: "g2" })],
		});

		const applied = await applyDocument(document);
		expect(applied.response.status, applied.text).toBe(200);

		const imported = (await groupRows()).slice(10);
		expect(imported.map((group) => group.name)).toEqual(["Importada", "Filha"]);
		// The ids 11..100 the installation already spent stay unused: the block starts after
		// the high-water mark, so a reference left behind by a deleted group cannot be
		// adopted by an imported one.
		expect(imported.map((group) => group.id)).toEqual([before.sequence + 1, before.sequence + 2]);
		expect(imported[1].parent_id).toBe(imported[0].id);

		const link = await env.db_boltlink
			.prepare("SELECT group_id FROM links WHERE slug = 'link-importado'")
			.first<{ group_id: number }>();
		expect(link?.group_id).toBe(imported[1].id);

		// The normal write path continues from there, monotonically and with no collision
		// against anything the import created.
		expect(await insertGroup("depois")).toBe(before.sequence + 3);
	});

	it("keeps every link on its group when the destination has gaps and another writer adds a group", async () => {
		// A destination that is neither empty nor tidy: an id in the middle is gone, so the
		// imported block does not start after a contiguous table.
		const primeiro = await insertGroup("antigo-primeiro");
		const meio = await insertGroup("antigo-meio");
		const ultimo = await insertGroup("antigo-ultimo");
		await env.db_boltlink.prepare("DELETE FROM link_groups WHERE id = ?").bind(meio).run();
		expect([primeiro, ultimo]).toEqual([1, 3]);

		const document = validDocument({
			groups: [
				validGroup({ ref: "g1", name: "Raiz importada" }),
				validGroup({ ref: "g2", name: "Filha importada", parentRef: "g1" }),
				validGroup({ ref: "g3", name: "Neta importada", parentRef: "g2" }),
			],
			links: [
				validLink({ slug: "aaa-primeiro", groupRef: "g1" }),
				validLink({ slug: "bbb-meio", groupRef: "g2" }),
				validLink({ slug: "ccc-ultimo", groupRef: "g3" }),
			],
		});

		const preview = await previewDocument(document);
		expect(preview.response.status, preview.text).toBe(200);

		// Another operator creates a group between the preview and the batch: every imported
		// id shifts by one, and the mapping reads the table inside the transaction, so the
		// shift has to be absorbed instead of a value computed earlier.
		const seams = { injected: 0 };
		const applied = await applyDocument(document, undefined, {
			db_boltlink: injectGroupBeforeBatch(env.db_boltlink, "outro-operador", seams),
		} as Partial<Env>);

		expect(seams.injected).toBe(1);
		expect(applied.response.status, applied.text).toBe(200);

		const rows = await groupRows();
		expect(rows.map((row) => row.name)).toEqual([
			"antigo-primeiro",
			"antigo-ultimo",
			"outro-operador",
			"Raiz importada",
			"Filha importada",
			"Neta importada",
		]);
		const idByName = new Map(rows.map((row) => [row.name, row.id]));
		// The imported subtree is contiguous and its parents come before their children.
		expect(idByName.get("Filha importada")).toBe((idByName.get("Raiz importada") ?? 0) + 1);
		expect(idByName.get("Neta importada")).toBe((idByName.get("Filha importada") ?? 0) + 1);

		const linkRows = await env.db_boltlink
			.prepare("SELECT slug, group_id FROM links ORDER BY slug")
			.all<{ slug: string; group_id: number }>();
		expect(linkRows.results).toEqual([
			{ slug: "aaa-primeiro", group_id: idByName.get("Raiz importada") },
			{ slug: "bbb-meio", group_id: idByName.get("Filha importada") },
			{ slug: "ccc-ultimo", group_id: idByName.get("Neta importada") },
		]);
	});

	it("refuses a destination where a link points at a group that does not exist", async () => {
		// Groups 11..100 are gone, together with the group one link used to point at — the
		// exact state where a pre-fix allocation would hand id 11 to an imported group and
		// silently turn the leftover reference into a real relation.
		await spendGroupIds(100, 10);
		await insertLink("orfao", { group_id: 11 });

		const document = validDocument({
			groups: [validGroup({ ref: "g1", name: "Importada" })],
			links: [validLink({ slug: "novo-link" })],
		});

		// The blocked preview is still read-only, including the new destination check.
		const traced = tracedHandle(env.db_boltlink);
		const preview = await readAnswer(
			await fetchWorker(
				"http://localhost/api/import/preview",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ document }),
				},
				{ db_boltlink: traced.handle } as Partial<Env>,
			),
		);
		expect(preview.response.status, preview.text).toBe(409);
		expect(preview.payload?.blockers).toEqual(["TARGET_GROUP_REFERENCE_CORRUPT"]);
		expect(preview.payload?.summary).toEqual({ groups: 1, links: 1, disabledLinks: 0, protectedLinks: 0, abTests: 0, smartRouting: 0 });
		expect(
			traced.statements.filter((statement) => DDL_STATEMENT_PATTERN.test(statement) || DML_STATEMENT_PATTERN.test(statement)),
		).toEqual([]);

		const applied = await applyDocument(document);
		expect(applied.response.status, applied.text).toBe(409);
		expect(applied.payload?.blockers).toEqual(["TARGET_GROUP_REFERENCE_CORRUPT"]);
		expectControlledBody(applied);

		// Zero writes, and the leftover reference is left exactly as it was: nothing adopts
		// its id, nothing zeroes it and nothing reparents it.
		expect(await counts()).toEqual({ groups: 10, links: 1 });
		const orphan = await env.db_boltlink
			.prepare("SELECT group_id FROM links WHERE slug = 'orfao'")
			.first<{ group_id: number }>();
		expect(orphan?.group_id).toBe(11);
		const adopted = await env.db_boltlink.prepare("SELECT id FROM link_groups WHERE id = 11").first();
		expect(adopted).toBeNull();
	});

	it("blocks any import into a destination that holds a leftover reference", async () => {
		await insertGroup("sobrevivente");
		await insertLink("orfao", { group_id: 4242 });

		// Even a document that would create nothing: the destination is in a state the
		// product cannot interpret, and the answer is a refusal to write, never a repair.
		const answer = await previewDocument(validDocument());
		expect(answer.response.status, answer.text).toBe(409);
		expect(answer.payload?.blockers).toEqual(["TARGET_GROUP_REFERENCE_CORRUPT"]);
	});

	it("imports into a destination whose links all point at groups that exist", async () => {
		const grupo = await insertGroup("existente");
		await insertLink("com-grupo", { group_id: grupo });
		await insertLink("sem-grupo");

		const applied = await applyDocument(validDocument({ links: [validLink({ slug: "novo-link" })] }));
		expect(applied.response.status, applied.text).toBe(200);
		expect(await counts()).toEqual({ groups: 1, links: 3 });
	});
});

describe("Phase 5, Gate 5.3: batch failure classification", () => {
	beforeEach(async () => {
		resetRateLimitStore();
		await resetDatabase();
	});

	it("still reports the collision when the batch really failed on the slug constraint", async () => {
		const document = validDocument({ groups: [validGroup({ ref: "g1", name: "Grupo" })], links: [validLink({ slug: "vitima" })] });
		const preview = await previewDocument(document);
		expect(preview.response.status, preview.text).toBe(200);

		const seams = { injected: 0 };
		const applied = await applyDocument(document, undefined, {
			db_boltlink: injectSlugBeforeBatch(env.db_boltlink, "vitima", seams),
		} as Partial<Env>);

		expect(seams.injected).toBe(1);
		expect(applied.response.status, applied.text).toBe(409);
		expect(applied.payload?.code).toBe("SLUG_COLLISION");
		expect(applied.payload?.conflicts).toEqual([{ slug: "vitima" }]);
	});

	it("does not blame a collision for a failure the destination reported for another reason", async () => {
		// A trigger makes the batch fail on the first link, while another operator takes a
		// slug the document also wants. Reading the destination after the failure finds the
		// slug taken — but that is a consequence of the race, not the cause of the failure,
		// and answering `SLUG_COLLISION` would hide a real defect behind a plausible story.
		await env.db_boltlink
			.prepare(
				"CREATE TRIGGER import_failure_probe BEFORE INSERT ON links WHEN NEW.slug = 'gatilho' BEGIN SELECT RAISE(ABORT, 'falha do destino'); END",
			)
			.run();

		const document = validDocument({
			groups: [validGroup({ ref: "g1", name: "Grupo" })],
			links: [validLink({ slug: "gatilho" }), validLink({ slug: "vitima" })],
		});
		const preview = await previewDocument(document);
		expect(preview.response.status, preview.text).toBe(200);

		const seams = { injected: 0 };
		const applied = await applyDocument(document, undefined, {
			db_boltlink: injectSlugBeforeBatch(env.db_boltlink, "vitima", seams),
		} as Partial<Env>);

		expect(seams.injected).toBe(1);
		expect(applied.response.status, applied.text).toBe(500);
		expect(applied.payload).toEqual({ error: "Import could not be completed" });
		// The database's own words, the SQL and the trigger's message never reach the client.
		expectControlledBody(applied);
		expect(applied.text).not.toContain("gatilho");
		expect(applied.text).not.toContain("falha do destino");
		expect(applied.text).not.toMatch(/RAISE|TRIGGER|CONSTRAINT/);

		// Atomic all the same: the group inserted before the failing statement rolled back
		// with it, and the other operator's link is untouched.
		expect(await counts()).toEqual({ groups: 0, links: 1 });
		expect(await slugRows()).toEqual(["vitima"]);
	});

	it("answers a controlled 500 for a driver failure it cannot classify", async () => {
		const document = validDocument({ groups: [validGroup({ ref: "g1", name: "Grupo" })], links: [validLink({ slug: "vitima" })] });
		const preview = await previewDocument(document);
		expect(preview.response.status, preview.text).toBe(200);

		const seams = { injected: 0 };
		const handle = injectSlugBeforeBatch(
			failingBatchHandle(env.db_boltlink, new Error("D1_ERROR: database is locked: SQLITE_BUSY")),
			"vitima",
			seams,
		);
		const applied = await applyDocument(document, undefined, { db_boltlink: handle } as Partial<Env>);

		expect(seams.injected).toBe(1);
		expect(applied.response.status, applied.text).toBe(500);
		expect(applied.payload).toEqual({ error: "Import could not be completed" });
		expectControlledBody(applied);
		expect(applied.text).not.toContain("SQLITE_BUSY");
		expect(await counts()).toEqual({ groups: 0, links: 1 });
	});
});

describe("Phase 5, Gate 5.3: round trip", () => {
	beforeEach(async () => {
		resetRateLimitStore();
		await resetDatabase();
	});

	it("reproduces the logical configuration on a clean installation", async () => {
		const source = await buildSourceConfiguration();
		expect(source.groups.length).toBe(4);
		expect(source.links.length).toBe(8);

		// A new installation: the same schema, none of the data.
		await resetDatabase();
		expect(await counts()).toEqual({ groups: 0, links: 0 });

		const preview = await previewDocument(source);
		expect(preview.response.status, preview.text).toBe(200);
		expect(preview.payload?.summary).toEqual({
			groups: 4,
			links: 8,
			disabledLinks: 1,
			protectedLinks: 1,
			abTests: 1,
			smartRouting: 1,
		});
		expect(preview.payload?.requiresPasswords).toEqual([{ slug: "protected-link" }]);

		const applied = await applyDocument(source, { "protected-link": "senha-nova" });
		expect(applied.response.status, applied.text).toBe(200);
		expect(applied.payload).toEqual({ ok: true, groupsCreated: 4, linksCreated: 8 });

		const destination = await readExport();

		// The comparison is the *logical* configuration: `exportedAt` is a moment, refs are
		// regenerated by every export, and metrics, ids and internal generations are not part
		// of the format in either direction.
		expect(logicalConfiguration(destination)).toEqual(logicalConfiguration(source));

		// Metrics start over instead of being invented: the source had clicks, the
		// destination has none, and the document never carried them.
		const imported = await env.db_boltlink
			.prepare("SELECT clicks_total, metric_epoch, version FROM links WHERE slug = ?")
			.bind("plain-link")
			.first<{ clicks_total: number; metric_epoch: number; version: number }>();
		expect(imported).toEqual({ clicks_total: 0, metric_epoch: 0, version: 1 });

		// The tombstone travels as a state, not as a timestamp: the disabled link is still
		// disabled, still in the document, and still reserving its slug.
		const disabled = await env.db_boltlink
			.prepare("SELECT disabled_at FROM links WHERE slug = ?")
			.bind("disabled-link")
			.first<{ disabled_at: string | null }>();
		expect(disabled?.disabled_at).not.toBeNull();
	});

	it("carries no hash, no plaintext and no internal column in the document", async () => {
		const source = await buildSourceConfiguration();
		const serialized = JSON.stringify(source);

		for (const forbidden of [
			"password_hash",
			"senha-de-origem",
			"passwordHash",
			"clicks_total",
			"metric_epoch",
			"ab_generation",
			"has_qrcode",
			"created_at",
			"updated_at",
			"version",
		]) {
			expect(serialized, forbidden).not.toContain(forbidden);
		}

		const protectedLink = source.links.find((link) => link.slug === "protected-link");
		expect(protectedLink?.passwordProtected).toBe(true);
		expect(Object.keys(protectedLink ?? {})).not.toContain("password");
	});

	it("preserves hostile strings literally instead of interpreting them", async () => {
		const hostileName = `<script>alert("x")</script> & "aspas"`;
		const hostileTag = `<img src=x onerror=alert(1)>`;

		// Built through the API so the value is stored exactly as submitted, then exported
		// and imported: the format must carry it byte for byte, and the panel renders every
		// one of these through textContent.
		const groupResponse = await fetchWorker("http://localhost/api/groups", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: hostileName }),
		});
		const group = (await groupResponse.json()) as { group: { id: number } };
		await fetchWorker("http://localhost/api/links", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ slug: "hostil", targetUrl: "https://example.com/hostil", tags: [hostileTag], groupId: group.group.id }),
		});

		const document = await readExport();
		await resetDatabase();

		const applied = await applyDocument(document);
		expect(applied.response.status, applied.text).toBe(200);

		const reExported = await readExport();
		expect(reExported.groups[0].name).toBe(hostileName);
		expect(reExported.links[0].tags).toEqual([hostileTag]);
		expect(logicalConfiguration(reExported)).toEqual(logicalConfiguration(document));
	});
});

describe("Phase 5, Gate 5.3: protected links", () => {
	beforeEach(async () => {
		resetRateLimitStore();
		await resetDatabase();
	});

	it("requires a new password, refuses to write without one, and enforces it after import", async () => {
		const source = await buildSourceConfiguration();
		const document = JSON.parse(JSON.stringify(source)) as ExportDocument;

		// Only the boolean travels: the source's password is not in the file at all.
		const protectedEntry = document.links.find((link) => link.slug === "protected-link");
		expect(protectedEntry?.passwordProtected).toBe(true);
		expect(JSON.stringify(document)).not.toContain("senha-de-origem");
		expect(JSON.stringify(document)).not.toContain("password_hash");

		await resetDatabase();

		const preview = await previewDocument(document);
		expect(preview.response.status, preview.text).toBe(200);
		expect(preview.payload?.requiresPasswords).toEqual([{ slug: "protected-link" }]);

		// Without a replacement password nothing is written — not even the links that do not
		// need one, because the import is one transaction.
		const refused = await applyDocument(document);
		expect(refused.response.status, refused.text).toBe(409);
		expect(refused.payload?.code).toBe("PASSWORD_REQUIRED");
		expect(refused.payload?.errors).toEqual([{ path: "replacementPasswords.protected-link", code: "PASSWORD_REQUIRED" }]);
		expect(await counts()).toEqual({ groups: 0, links: 0 });

		const applied = await applyDocument(document, { "protected-link": "senha-nova-do-destino" });
		expect(applied.response.status, applied.text).toBe(200);
		expect(applied.text).not.toContain("senha-nova-do-destino");
		expect(applied.text).not.toMatch(/[0-9a-f]{32,}/);

		// The gate is active, the new password opens it, and the source's password does not:
		// it was never exported, so it cannot possibly work here.
		const gate = await fetchWorker("http://localhost/protected-link", { method: "GET" });
		expect(gate.status).toBe(200);
		expect(await gate.text()).toContain("Senha");

		const oldPassword = await fetchWorker("http://localhost/protected-link", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ password: "senha-de-origem" }).toString(),
		});
		expect(oldPassword.status).toBe(401);

		const newPassword = await fetchWorker("http://localhost/protected-link", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ password: "senha-nova-do-destino" }).toString(),
		});
		expect(newPassword.status).toBe(302);
		expect(newPassword.headers.get("Location")).toBe("https://example.com/protegido");
	});

	it("refuses a password for a link that is not protected, and an empty password", async () => {
		const document = validDocument({ links: [validLink({ slug: "aberto" })] });

		const unexpected = await applyDocument(document, { aberto: "senha-sem-efeito" });
		expect(unexpected.response.status).toBe(400);
		expect(unexpected.payload?.code).toBe("INVALID_PASSWORD");
		expect(unexpected.payload?.errors).toEqual([{ path: "replacementPasswords.aberto", code: "INVALID_PASSWORD" }]);

		const protectedDocument = validDocument({ links: [validLink({ slug: "fechado", passwordProtected: true })] });
		const empty = await applyDocument(protectedDocument, { fechado: "   " });
		expect(empty.response.status).toBe(400);
		expect(empty.payload?.code).toBe("INVALID_PASSWORD");

		expect(await counts()).toEqual({ groups: 0, links: 0 });
	});

	it("blocks a protected document when the installation has no session secret", async () => {
		const document = validDocument({ links: [validLink({ slug: "fechado", passwordProtected: true })] });
		const answer = await previewDocument(document, { PASSWORD_SESSION_SECRET: undefined } as Partial<Env>);

		expect(answer.response.status).toBe(409);
		expect(answer.payload?.blockers).toEqual(["PASSWORD_SESSION_SECRET_MISSING"]);
	});

	it("imports a protected link whose slug is __proto__, and enforces the new password", async () => {
		// `__proto__` is a valid slug under the current policy, which is what makes it the
		// case that separates a mapping built from own properties from one built by
		// assignment: `passwords["__proto__"] = "…"` on a plain object writes a prototype
		// rather than an entry, and the password would be silently lost on the way out.
		const document = validDocument({ links: [validLink({ slug: "__proto__", passwordProtected: true })] });

		const preview = await previewDocument(document);
		expect(preview.response.status, preview.text).toBe(200);
		expect(preview.payload?.requiresPasswords).toEqual([{ slug: "__proto__" }]);

		const refused = await applyDocument(document);
		expect(refused.response.status, refused.text).toBe(409);
		expect(refused.payload?.code).toBe("PASSWORD_REQUIRED");
		expect(await counts()).toEqual({ groups: 0, links: 0 });

		// The envelope the panel builds, serialized: an own `__proto__` key survives, which
		// is exactly the property the browser side has to preserve.
		const body = JSON.stringify({ document, replacementPasswords: JSON.parse('{"__proto__":"senha-do-proto"}') });
		expect(body).toContain('"__proto__":"senha-do-proto"');

		const applied = await postImport("/api/import/apply", body);
		expect(applied.response.status, applied.text).toBe(200);
		expect(applied.text).not.toContain("senha-do-proto");
		expect(await slugRows()).toEqual(["__proto__"]);

		// The gate is real, and the replacement password is the one that opens it.
		const gate = await fetchWorker("http://localhost/__proto__", { method: "GET" });
		expect(gate.status).toBe(200);
		expect(await gate.text()).toContain("Senha");

		const opened = await fetchWorker("http://localhost/__proto__", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ password: "senha-do-proto" }).toString(),
		});
		expect(opened.status).toBe(302);
	});

	it("accepts the other prototype names as slugs, with their own passwords", async () => {
		// The same class of name, checked so the `__proto__` fix cannot be a special case:
		// every name a plain object treats as inherited has to behave like any other slug.
		const document = validDocument({
			links: [
				validLink({ slug: "constructor", passwordProtected: true }),
				validLink({ slug: "prototype", passwordProtected: true }),
			],
		});

		const preview = await previewDocument(document);
		expect(preview.response.status, preview.text).toBe(200);
		expect(preview.payload?.requiresPasswords).toEqual([{ slug: "constructor" }, { slug: "prototype" }]);

		const applied = await applyDocument(document, { constructor: "senha-constructor", prototype: "senha-prototype" });
		expect(applied.response.status, applied.text).toBe(200);
		expect(applied.text).not.toContain("senha-constructor");
		expect(applied.text).not.toContain("senha-prototype");
		expect(await slugRows()).toEqual(["constructor", "prototype"]);
	});
});

describe("Phase 5, Gate 5.3: the imported configuration is live", () => {
	beforeEach(async () => {
		resetRateLimitStore();
		await resetDatabase();
	});

	it("serves the imported links through the public redirect without touching the hot path", async () => {
		const source = await buildSourceConfiguration();
		// A new installation holds none of the source's data, which is what makes the state
		// below the import's own instead of a leftover.
		await resetDatabase();

		const applied = await applyDocument(source, { "protected-link": "senha-nova" });
		expect(applied.response.status, applied.text).toBe(200);

		const plain = await fetchWorker("http://localhost/plain-link", { method: "GET" });
		expect(plain.status).toBe(302);
		expect(plain.headers.get("Location")).toBe("https://example.com/plain");

		// A permanent redirect keeps its status, and a Smart Routing link is dynamic.
		const permanent = await fetchWorker("http://localhost/grouped-link", { method: "GET" });
		expect(permanent.status).toBe(301);

		const smart = await fetchWorker("http://localhost/smart-link", { method: "GET" });
		expect(smart.status).toBe(302);
		expect(smart.headers.get("Cache-Control")).toBe("no-store");

		// The tombstone stays disabled, so its slug is reserved but unreachable.
		const disabled = await fetchWorker("http://localhost/disabled-link", { method: "GET" });
		expect(disabled.status).toBe(404);

		// The expired destination is lifecycle state, carried by the format as a moment and
		// by the destination as its own value.
		const expired = await env.db_boltlink
			.prepare("SELECT expires_at, expired_redirect_url FROM links WHERE slug = ?")
			.bind("lifecycle-link")
			.first<{ expires_at: string; expired_redirect_url: string }>();
		expect(expired).toEqual({
			expires_at: "2030-01-01T00:00:00.000Z",
			expired_redirect_url: "https://example.com/expirado",
		});

		// Metrics are the destination's own: an imported link starts at zero and counts from
		// there like any other.
		await env.db_boltlink.prepare("UPDATE links SET clicks_total = 0 WHERE slug = ?").bind("plain-link").run();
		await fetchWorker("http://localhost/plain-link", {
			method: "GET",
			headers: { "CF-Connecting-IP": "203.0.113.9", "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
		});
		const counted = await env.db_boltlink
			.prepare("SELECT clicks_total FROM links WHERE slug = ?")
			.bind("plain-link")
			.first<{ clicks_total: number }>();
		expect(counted?.clicks_total).toBe(1);
	});
});

describe("Phase 5, Gate 5.3: access boundary", () => {
	beforeEach(async () => {
		resetRateLimitStore();
		await resetDatabase();
	});

	it("keeps both routes behind the administrative boundary", async () => {
		const document = validDocument({ links: [validLink({ slug: "protegido-pelo-admin" })] });

		for (const path of ["/api/import/preview", "/api/import/apply"]) {
			const answer = await postImport(path, { document }, {}, "https://links.example.com");
			expect(answer.response.status, path).toBe(401);
			// The boundary answers before the document is even looked at.
			expect(answer.payload?.error).toBe("Authentication required");
		}

		expect(await counts()).toEqual({ groups: 0, links: 0 });
	});

	it("never stores the response of a plan, and marks both answers as no-store", async () => {
		const document = validDocument({ links: [validLink({ slug: "sem-cache" })] });
		const preview = await previewDocument(document);
		expect(preview.response.headers.get("Cache-Control")).toBe("no-store");

		const applied = await applyDocument(document);
		expect(applied.response.headers.get("Cache-Control")).toBe("no-store");
		expect(applied.response.status).toBe(200);
	});
});

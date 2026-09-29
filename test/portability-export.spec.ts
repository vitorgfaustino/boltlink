/*
 * Copyright (c) 2026 Vitor Faustino
 * AGPL-3.0 License — https://github.com/vitorgfaustino/boltlink
 *
 * Phase 5, Gate 5.2: portability export.
 *
 * The export is a *logical configuration* artifact, so this suite pins three things
 * and nothing else: the document contract (what travels and in which shape), the
 * refusal contract (what makes the whole export fail instead of degrading), and the
 * isolation of the feature from the public redirect.
 *
 * Fixtures are written with direct SQL on purpose: external SQL is exactly how the
 * invalid persisted states this gate must refuse are produced, and the API would
 * (correctly) reject them.
 */

import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetRateLimitStore } from "../src/rate-limit";
import worker from "../src/index";
import {
	PORTABILITY_MAX_BYTES,
	PORTABILITY_MAX_GROUPS,
	PORTABILITY_MAX_LINKS,
	buildPortabilityExport,
} from "../src/portability";
import type {
	PortabilityDocumentV1,
	PortabilityGroupRow,
	PortabilityLinkRow,
	PortabilityValidationPolicy,
} from "../src/portability";

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

/**
 * The migration level of the database selects which capability-backed properties the
 * format may carry. The export deliberately supports 0003 through 0006, so the shape it
 * emits is pinned per level instead of inferred from the newest schema.
 */
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

/** The `links` DDL as the given migration level leaves it. */
function schemaAt(migration: 3 | 4 | 5 | 6): string[] {
	const removed = CAPABILITY_COLUMNS[migration];
	return SCHEMA_STATEMENTS.map((statement) =>
		removed.reduce((sql, column) => sql.replace(column, ""), statement),
	);
}

/** The database as migration 0005 leaves it: no `expired_redirect_url` key. */
const PRE_0006_SCHEMA_STATEMENTS = schemaAt(5);

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

async function resetDatabase() {
	// A full rebuild, not an `IF NOT EXISTS` pass: a test that shrank the table to an
	// older migration level must not leak that shape into the next test.
	await env.db_boltlink.prepare("DROP TABLE IF EXISTS links").run();
	await env.db_boltlink.prepare("DROP TABLE IF EXISTS link_groups").run();
	await env.db_boltlink.prepare("DROP VIEW IF EXISTS boltlink_metric_fence").run();
	for (const statement of SCHEMA_STATEMENTS) {
		await env.db_boltlink.prepare(statement).run();
	}
}

/** Rebuilds `links` at an older migration level, leaving `link_groups` in place. */
async function installSchemaLevel(migration: 3 | 4 | 5 | 6) {
	await env.db_boltlink.prepare("DROP TABLE IF EXISTS links").run();
	await env.db_boltlink.prepare("DROP VIEW IF EXISTS boltlink_metric_fence").run();
	for (const statement of schemaAt(migration)) {
		await env.db_boltlink.prepare(statement).run();
	}
}

/** Reads a `sqlite_master` entry, so a projection the runtime created can be observed. */
async function schemaObject(name: string): Promise<{ name: string } | null> {
	return env.db_boltlink
		.prepare("SELECT name FROM sqlite_master WHERE type = 'view' AND name = ?")
		.bind(name)
		.first<{ name: string }>();
}

const EXPORT_URL = "http://localhost/api/export";

type ExportLink = Record<string, unknown> & { slug: string; groupRef: string | null };
type ExportGroup = { ref: string; name: string; parentRef: string | null };
type ExportDocument = {
	format: string;
	schemaVersion: number;
	exportedAt: string;
	groups: ExportGroup[];
	links: ExportLink[];
};

type ExportResponse = {
	response: Response;
	text: string;
	document: ExportDocument | null;
	error: string | null;
};

async function readExport(overrides?: Partial<Env>, url = EXPORT_URL): Promise<ExportResponse> {
	const response = await fetchWorker(url, undefined, overrides);
	const text = await response.text();

	let parsed: unknown = null;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = null;
	}

	if (response.ok) {
		return { response, text, document: parsed as ExportDocument, error: null };
	}

	const error = parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string"
		? (parsed as { error: string }).error
		: null;
	return { response, text, document: null, error };
}

/** Reads the export and fails loudly instead of returning a nullable document. */
async function readSuccessfulExport(overrides?: Partial<Env>): Promise<{ response: Response; text: string; document: ExportDocument }> {
	const result = await readExport(overrides);
	if (result.response.status !== 200 || !result.document) {
		throw new Error(`expected a 200 export, got ${result.response.status}: ${result.text}`);
	}
	return { response: result.response, text: result.text, document: result.document };
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

const LINK_DEFAULTS: Record<string, unknown> = {
	target_url: "https://example.com/destino",
	redirect_type: "302",
	tags: null,
	group_id: null,
	disabled_at: null,
	go_live_at: null,
	expires_at: null,
	expired_redirect_url: null,
	password_hash: null,
	ab_enabled: 0,
	ab_target_url: null,
	ab_weight_b: 50,
	ab_generation: 0,
	metric_epoch: 0,
	ab_clicks_a: 0,
	ab_clicks_b: 0,
	ab_started_at: null,
	smart_routing_rules: null,
	clicks_total: 0,
	has_qrcode: 0,
	version: 1,
};

async function insertLink(fixture: { slug: string } & Record<string, unknown>): Promise<void> {
	const provided = Object.fromEntries(Object.entries(fixture).filter(([, value]) => value !== undefined));
	const row = { ...LINK_DEFAULTS, ...provided };
	const columns = Object.keys(row);
	await env.db_boltlink
		.prepare(`INSERT INTO links (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
		.bind(...Object.values(row))
		.run();
}

/**
 * The row the export's SELECT returns, from a partial fixture. Capability-backed
 * columns are always present when the migration level provides them, so a module-level
 * test must supply them too: a missing `ab_enabled` is a malformed input, not a
 * database state, and the serializer refuses it.
 */
function linkRow(fixture: { slug: string } & Record<string, unknown>): PortabilityLinkRow {
	const provided = Object.fromEntries(Object.entries(fixture).filter(([, value]) => value !== undefined));
	const row = { ...LINK_DEFAULTS, ...provided };
	// `has_password` is what the export's SELECT computes, so a module-level row derives
	// it the same way: from the presence of a hash, never from the hash itself.
	const hasPassword = provided.has_password ?? (row.password_hash === null || row.password_hash === undefined ? 0 : 1);
	return { ...row, has_password: hasPassword } as unknown as PortabilityLinkRow;
}

function passThrough(target: object, prop: string | symbol) {
	const value = Reflect.get(target, prop);
	return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
}

/**
 * A distinct handle identity over the same database, modelling a second isolate. The
 * schema readiness cache is per handle and positive-only, so an unprepared database is
 * only observable through an identity that never saw the prepared one.
 */
function cloneDbHandle(db: D1Database): D1Database {
	return new Proxy(db, {
		get(target, prop) {
			return passThrough(target, prop);
		},
	}) as D1Database;
}

type TracedHandle = { handle: D1Database; statements: string[] };

/** A distinct handle identity that records every statement it runs. */
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

const WRITE_STATEMENT_PATTERN = /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/i;
/** Schema mutation, the class of statement `GET /api/export` must never run. */
const DDL_STATEMENT_PATTERN = /^\s*(CREATE|ALTER|DROP)\b/i;
/** Data mutation, the other class the read-only export must never run. */
const DML_STATEMENT_PATTERN = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i;

/**
 * Deterministic interleaving of the export race: the group disappears between the
 * group read and the link read. That is the exact window in which an unvalidated
 * reader would emit a dangling `groupRef`; `seams` proves the mutation ran, so a plan
 * that stopped issuing two ordered reads fails the test instead of passing on an
 * answer produced before the group was removed.
 */
function removeGroupBetweenReads(db: D1Database, groupId: number, seams: { count: number }): D1Database {
	return new Proxy(db, {
		get(target, prop) {
			if (prop !== "batch") {
				return passThrough(target, prop);
			}

			return async (statements: D1PreparedStatement[]) => {
				const results: D1Result<unknown>[] = [];
				for (const statement of statements) {
					if (results.length === 1) {
						seams.count += 1;
						await db.prepare("DELETE FROM link_groups WHERE id = ?").bind(groupId).run();
					}
					results.push(await (statement as unknown as { all: () => Promise<D1Result<unknown>> }).all());
				}
				return results;
			};
		},
	}) as D1Database;
}

/** The same seam, but the moved link is what changes: the group set no longer has it. */
function createGroupBetweenReads(db: D1Database, linkSlug: string, seams: { count: number }): D1Database {
	return new Proxy(db, {
		get(target, prop) {
			if (prop !== "batch") {
				return passThrough(target, prop);
			}

			return async (statements: D1PreparedStatement[]) => {
				const results: D1Result<unknown>[] = [];
				for (const statement of statements) {
					if (results.length === 1) {
						seams.count += 1;
						const created = await db
							.prepare("INSERT INTO link_groups (name) VALUES ('Tardio') RETURNING id")
							.first<{ id: number }>();
						await db
							.prepare("UPDATE links SET group_id = ? WHERE slug = ?")
							.bind(created?.id ?? -1, linkSlug)
							.run();
					}
					results.push(await (statement as unknown as { all: () => Promise<D1Result<unknown>> }).all());
				}
				return results;
			};
		},
	}) as D1Database;
}

/** The policy the runtime injects, reproduced so module-level tests need no worker. */
const POLICY: PortabilityValidationPolicy = {
	isValidSlug: (slug: string) => /^[A-Za-z0-9_-]{3,64}$/.test(slug),
	normalizeUrl: (candidate?: string) => {
		if (!candidate) {
			return null;
		}
		try {
			const parsed = new URL(candidate);
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
				return null;
			}
			if (!parsed.hostname.includes(".")) {
				return null;
			}
			return parsed.toString();
		} catch {
			return null;
		}
	},
};

const ALL_CAPABILITIES = { abTesting: true, smartRouting: true, expiredRedirect: true };

const FUTURE = () => new Date(Date.now() + 3_600_000).toISOString();
const PAST = () => new Date(Date.now() - 3_600_000).toISOString();

const VALID_SMART_RULES = JSON.stringify([{ country: "BR", device: "ios", url: "https://example.com/br-ios" }]);

/** Keys the format must never carry, wherever they would appear in the document. */
const FORBIDDEN_DOCUMENT_KEYS = [
	"password_hash",
	"passwordHash",
	'"password":',
	"clicks_total",
	"ab_clicks_a",
	"ab_clicks_b",
	"ab_generation",
	"metric_epoch",
	"has_qrcode",
	"group_id",
	"created_at",
	"updated_at",
	"ab_started_at",
	"metric_fence",
];

beforeEach(async () => {
	await resetDatabase();
	resetRateLimitStore();
});

describe("Phase 5, Gate 5.2: portability format", () => {
	it("exports an empty instance with valid identity metadata", async () => {
		const { response, document, text } = await readSuccessfulExport();

		expect(response.status).toBe(200);
		expect(document.format).toBe("boltlink-portability");
		expect(document.schemaVersion).toBe(1);
		expect(document.groups).toEqual([]);
		expect(document.links).toEqual([]);
		expect(Number.isNaN(Date.parse(document.exportedAt))).toBe(false);
		// The format version is its own identity, never the product version.
		expect(text).not.toContain("3.0.0");
	});

	it("carries only the format keys the contract defines", async () => {
		await insertLink({ slug: "contrato" });
		const { document } = await readSuccessfulExport();

		expect(Object.keys(document).sort()).toEqual([
			"exportedAt",
			"format",
			"groups",
			"links",
			"schemaVersion",
		]);
	});

	it("never carries an internal column name anywhere in the document", async () => {
		const groupId = await insertGroup("Equipe");
		await insertLink({
			slug: "sem-internos",
			group_id: groupId,
			password_hash: "sentinel-hash",
			clicks_total: 987_654_321,
			ab_clicks_a: 91_001,
			ab_clicks_b: 91_002,
			ab_generation: 91_003,
			metric_epoch: 91_004,
			ab_started_at: FUTURE(),
			has_qrcode: 1,
			version: 91_005,
		});

		const { text } = await readSuccessfulExport();

		for (const forbidden of FORBIDDEN_DOCUMENT_KEYS) {
			expect(text, `document leaked ${forbidden}`).not.toContain(forbidden);
		}
		for (const counter of ["987654321", "91001", "91002", "91003", "91004", "91005"]) {
			expect(text, `document leaked counter ${counter}`).not.toContain(counter);
		}
	});

	it("exposes exactly the link configuration keys, and no others", async () => {
		await insertLink({ slug: "chaves" });
		const { document } = await readSuccessfulExport();

		expect(document.links).toHaveLength(1);
		expect(Object.keys(document.links[0])).toEqual([
			"slug",
			"targetUrl",
			"redirectType",
			"tags",
			"groupRef",
			"disabled",
			"goLiveAt",
			"expiresAt",
			"expiredRedirectUrl",
			"passwordProtected",
			"abTest",
			"smartRouting",
		]);
	});

	it("omits capability-backed properties the migration level does not provide", async () => {
		try {
			await env.db_boltlink.prepare("DROP TABLE links").run();
			for (const statement of PRE_0006_SCHEMA_STATEMENTS) {
				await env.db_boltlink.prepare(statement).run();
			}
			await env.db_boltlink.prepare("DELETE FROM link_groups").run();

			// A fresh handle identity models a Worker that never saw migration 0006: the
			// capability caches are per handle and positive-only.
			const traced = tracedHandle(env.db_boltlink);
			await env.db_boltlink
				.prepare("INSERT INTO links (slug, target_url) VALUES (?, ?)")
				.bind("sem-coluna", "https://example.com/x")
				.run();

			const response = await fetchWorker(EXPORT_URL, undefined, { db_boltlink: traced.handle });
			const document = (await response.json()) as ExportDocument;

			expect(response.status).toBe(200);
			// Absence means "this database has no such feature", never "configured as null".
			expect(Object.keys(document.links[0])).not.toContain("expiredRedirectUrl");
			// The feature that does exist at this level stays present.
			expect(Object.keys(document.links[0])).toContain("abTest");
		} finally {
			await env.db_boltlink.prepare("DROP TABLE links").run();
		}
	});
});

describe("Phase 5, Gate 5.2: group references", () => {
	it("carries a tree through document-local refs and no database id", async () => {
		const clientes = await insertGroup("Clientes");
		const brasil = await insertGroup("Brasil", clientes);
		const campinas = await insertGroup("Campinas", brasil);
		const portugal = await insertGroup("Portugal", clientes);

		await insertLink({ slug: "link-clientes", group_id: clientes });
		await insertLink({ slug: "link-brasil", group_id: brasil });
		await insertLink({ slug: "link-campinas", group_id: campinas });
		await insertLink({ slug: "link-portugal", group_id: portugal });
		await insertLink({ slug: "link-solto" });

		const { document, text } = await readSuccessfulExport();

		const byName = new Map(document.groups.map((group) => [group.name, group]));
		expect(byName.size).toBe(4);

		const refs = document.groups.map((group) => group.ref);
		expect(new Set(refs).size).toBe(refs.length);
		expect(byName.get("Clientes")?.parentRef).toBeNull();
		expect(byName.get("Brasil")?.parentRef).toBe(byName.get("Clientes")?.ref);
		expect(byName.get("Campinas")?.parentRef).toBe(byName.get("Brasil")?.ref);
		expect(byName.get("Portugal")?.parentRef).toBe(byName.get("Clientes")?.ref);

		const linkBySlug = new Map(document.links.map((link) => [link.slug, link]));
		expect(linkBySlug.get("link-clientes")?.groupRef).toBe(byName.get("Clientes")?.ref);
		expect(linkBySlug.get("link-campinas")?.groupRef).toBe(byName.get("Campinas")?.ref);
		expect(linkBySlug.get("link-solto")?.groupRef).toBeNull();

		// Reconstructing the tree needs the refs alone: no id of this database appears.
		for (const id of [clientes, brasil, campinas, portugal]) {
			expect(text).not.toMatch(new RegExp(`"group_id":\\s*${id}\\b`));
		}
		expect(JSON.stringify(document)).not.toContain("group_id");
	});

	it("keeps two groups with the same name apart", async () => {
		const first = await insertGroup("Clientes");
		const second = await insertGroup("Clientes");
		const child = await insertGroup("Brasil", second);

		await insertLink({ slug: "link-a", group_id: first });
		await insertLink({ slug: "link-b", group_id: child });

		const { document } = await readSuccessfulExport();

		const clientes = document.groups.filter((group) => group.name === "Clientes");
		expect(clientes).toHaveLength(2);
		expect(clientes[0].ref).not.toBe(clientes[1].ref);
		// No de-duplication by name, and both hierarchies survive.
		const brasil = document.groups.find((group) => group.name === "Brasil");
		expect(brasil?.parentRef).toBe(clientes[1].ref);
		expect(document.links.find((link) => link.slug === "link-b")?.groupRef).toBe(brasil?.ref);
		expect(document.links.find((link) => link.slug === "link-a")?.groupRef).toBe(clientes[0].ref);
	});

	it("exports a legacy tree deeper than the move ceiling", async () => {
		// The write ceiling is a rule for new moves; a structurally valid legacy tree
		// that already exceeds it must stay transportable.
		let parent: number | null = null;
		for (let depth = 1; depth <= PORTABILITY_MAX_GROUPS - 4; depth += 1) {
			parent = await insertGroup(`Nivel ${depth}`, parent);
		}
		await insertLink({ slug: "link-fundo", group_id: parent ?? undefined });

		const { document } = await readSuccessfulExport();

		expect(document.groups.length).toBe(PORTABILITY_MAX_GROUPS - 4);
		expect(document.groups.filter((group) => group.parentRef === null)).toHaveLength(1);
		expect(document.links[0].groupRef).not.toBeNull();
	});
});

describe("Phase 5, Gate 5.2: link configuration", () => {
	it("exports an ungrouped link with the single null contract", async () => {
		await insertLink({ slug: "sem-grupo" });
		const { document } = await readSuccessfulExport();

		expect(document.links[0].groupRef).toBeNull();
		// `groupRef: null` and not an omitted key: one contract, no variance.
		expect(Object.prototype.hasOwnProperty.call(document.links[0], "groupRef")).toBe(true);
	});

	it("exports a disabled link as an explicit tombstone", async () => {
		await insertLink({ slug: "reservado", disabled_at: PAST(), target_url: "https://example.com/antigo" });
		await insertLink({ slug: "ativo" });

		const { document } = await readSuccessfulExport();

		const disabled = document.links.find((link) => link.slug === "reservado");
		expect(disabled?.disabled).toBe(true);
		// The slug stays reserved, so the tombstone travels instead of disappearing.
		expect(disabled?.targetUrl).toBe("https://example.com/antigo");
		expect(document.links.find((link) => link.slug === "ativo")?.disabled).toBe(false);
	});

	it("reports password protection as a flag and never as material", async () => {
		const sentinel = "BOLTLINK_TEST_SECRET_HASH_12345";
		await insertLink({ slug: "protegido", password_hash: sentinel });
		await insertLink({ slug: "aberto" });

		const { document, text } = await readSuccessfulExport();

		expect(document.links.find((link) => link.slug === "protegido")?.passwordProtected).toBe(true);
		expect(document.links.find((link) => link.slug === "aberto")?.passwordProtected).toBe(false);

		expect(text).not.toContain(sentinel);
		expect(text).not.toContain("password_hash");
		expect(text).not.toContain("passwordHash");
	});

	it("exports the A/B configuration and none of its counters", async () => {
		await insertLink({
			slug: "teste-ab",
			ab_enabled: 1,
			ab_target_url: "https://example.com/variante-b",
			ab_weight_b: 30,
			ab_clicks_a: 71_001,
			ab_clicks_b: 71_002,
			ab_generation: 71_003,
		});

		const { document, text } = await readSuccessfulExport();

		expect(document.links[0].abTest).toEqual({
			enabled: true,
			variantBUrl: "https://example.com/variante-b",
			weightB: 30,
		});
		for (const counter of ["71001", "71002", "71003"]) {
			expect(text).not.toContain(counter);
		}
	});

	it("keeps a retained variant B destination when the split is off", async () => {
		// The API stores exactly this shape when an operator disables A/B without
		// clearing the destination, so dropping it would be a silent rewrite.
		await insertLink({
			slug: "ab-pausado",
			ab_enabled: 0,
			ab_target_url: "https://example.com/guardada",
			ab_weight_b: 80,
		});

		const { document } = await readSuccessfulExport();

		expect(document.links[0].abTest).toEqual({
			enabled: false,
			variantBUrl: "https://example.com/guardada",
			weightB: 80,
		});
	});

	it("exports Smart Routing rules in their stored order", async () => {
		const rules = [
			{ country: "BR", device: "ios", url: "https://example.com/primeira" },
			{ country: "PT", url: "https://example.com/segunda" },
			{ device: "desktop", url: "https://example.com/terceira" },
		];
		await insertLink({ slug: "roteado", smart_routing_rules: JSON.stringify(rules) });
		await insertLink({ slug: "sem-rota" });

		const { document } = await readSuccessfulExport();

		// First-match-wins makes the order semantic: it is never sorted or grouped.
		expect(document.links.find((link) => link.slug === "roteado")?.smartRouting).toEqual(rules);
		expect(document.links.find((link) => link.slug === "sem-rota")?.smartRouting).toBeNull();
	});

	it("exports lifecycle values as canonical instants and preserves tags order", async () => {
		const goLive = FUTURE();
		const expires = new Date(Date.now() + 7_200_000).toISOString();
		await insertLink({
			slug: "ciclo",
			go_live_at: goLive,
			expires_at: expires,
			expired_redirect_url: "https://example.com/depois",
			tags: JSON.stringify(["zeta", "alfa", "meio"]),
		});

		const { document } = await readSuccessfulExport();

		expect(document.links[0].goLiveAt).toBe(goLive);
		expect(document.links[0].expiresAt).toBe(expires);
		expect(document.links[0].expiredRedirectUrl).toBe("https://example.com/depois");
		// Tags are stored in the operator's order and the product never sorts them.
		expect(document.links[0].tags).toEqual(["zeta", "alfa", "meio"]);
	});

	it("exports an empty tag list as an empty array", async () => {
		await insertLink({ slug: "sem-tags", tags: null });
		const { document } = await readSuccessfulExport();

		expect(document.links[0].tags).toEqual([]);
	});

	it("canonicalizes a valid but non-canonical stored destination", async () => {
		await insertLink({ slug: "canonico", target_url: "https://example.com" });
		const { document } = await readSuccessfulExport();

		// The same normalization every write path applies, so the document holds what
		// BoltLink would store today.
		expect(document.links[0].targetUrl).toBe("https://example.com/");
	});
});

describe("Phase 5, Gate 5.2: corrupt persisted state", () => {
	it("refuses the whole export for a corrupt Smart Routing configuration", async () => {
		await insertLink({ slug: "saudavel", smart_routing_rules: VALID_SMART_RULES });
		await insertLink({ slug: "corrompido", smart_routing_rules: "{not json" });

		const { response, document, error } = await readExport();

		expect(response.status).toBe(409);
		expect(error).toMatch(/Smart Routing/);
		// No partial document: a corrupt row is never converted into "disabled".
		expect(document).toBeNull();
	});

	it("refuses a Smart Routing configuration that is valid JSON but not a rules array", async () => {
		await insertLink({ slug: "meio-json", smart_routing_rules: "null" });

		const { response, error } = await readExport();

		expect(response.status).toBe(409);
		expect(error).toMatch(/Smart Routing/);
	});

	it("refuses a stored expired destination without an expiration", async () => {
		await insertLink({ slug: "dormente", expired_redirect_url: "https://example.com/depois" });

		const { response, error } = await readExport();

		expect(response.status).toBe(409);
		expect(error).toMatch(/expired destination/i);
	});

	it("refuses an invalid expired destination URL", async () => {
		await insertLink({
			slug: "destino-invalido",
			expires_at: PAST(),
			expired_redirect_url: "javascript:alert(1)",
		});

		const { response, error } = await readExport();

		expect(response.status).toBe(409);
		expect(error).toMatch(/expired destination/i);
	});

	it("refuses an invalid stored destination URL", async () => {
		await insertLink({ slug: "alvo-invalido", target_url: "ftp://example.com/arquivo" });

		const { response, error } = await readExport();

		expect(response.status).toBe(409);
		expect(error).toMatch(/destination URL/i);
	});

	it("refuses a redirect type the product would not accept", async () => {
		await insertLink({ slug: "tipo-invalido", redirect_type: "307" });

		const { response, error } = await readExport();

		expect(response.status).toBe(409);
		expect(error).toMatch(/redirect type/i);
	});

	it("refuses a reserved or malformed stored slug", async () => {
		for (const slug of ["admin", "ab"]) {
			await resetDatabase();
			await insertLink({ slug });
			const { response, error } = await readExport();
			expect(response.status, slug).toBe(409);
			expect(error).toMatch(/slug/i);
		}
	});

	it("refuses tags that are not the stored contract", async () => {
		for (const tags of ["[1,2]", "{\"a\":1}", "[\"ok\",\"  \"]", "[\"ok\""]) {
			await resetDatabase();
			await insertLink({ slug: "tags-invalidas", tags });
			const { response, error } = await readExport();
			expect(response.status, tags).toBe(409);
			expect(error).toMatch(/tags/i);
		}
	});

	it("refuses an unparseable persisted lifecycle timestamp", async () => {
		await insertLink({ slug: "data-invalida", expires_at: "31/12/2026" });

		const { response, error } = await readExport();

		expect(response.status).toBe(409);
		expect(error).toMatch(/lifecycle/i);
	});

	it("refuses a lifecycle where expiration precedes go-live", async () => {
		await insertLink({ slug: "ordem-invalida", go_live_at: FUTURE(), expires_at: PAST() });

		const { response, error } = await readExport();

		expect(response.status).toBe(409);
		expect(error).toMatch(/lifecycle/i);
	});

	it("refuses a link pointing at a group that does not exist", async () => {
		await insertLink({ slug: "orfao", group_id: 4242 });

		const { response, error } = await readExport();

		expect(response.status).toBe(409);
		expect(error).toMatch(/missing group/i);
	});

	it("refuses a group graph with a cycle", async () => {
		const first = await insertGroup("A");
		const second = await insertGroup("B", first);
		// External SQL is the only way to reach this state; the API refuses it.
		await env.db_boltlink.prepare("UPDATE link_groups SET parent_id = ? WHERE id = ?").bind(second, first).run();
		await insertLink({ slug: "em-ciclo", group_id: first });

		const { response, error } = await readExport();

		expect(response.status).toBe(409);
		expect(error).toMatch(/hierarchy is corrupt/i);
	});

	it("refuses a group graph with a dangling parent", async () => {
		// The `0002` foreign key uses ON DELETE SET NULL, so a dangling parent cannot be
		// produced by an ordinary delete. The table is rebuilt without the constraint to
		// model a database restored by hand, which is the only way to reach this state.
		await env.db_boltlink.prepare("DROP TABLE link_groups").run();
		await env.db_boltlink.prepare(`CREATE TABLE link_groups (
		  id INTEGER PRIMARY KEY AUTOINCREMENT,
		  name TEXT NOT NULL,
		  parent_id INTEGER,
		  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		)`).run();

		const parent = await insertGroup("Pai");
		const child = await insertGroup("Filho", parent);
		await env.db_boltlink.prepare("DELETE FROM link_groups WHERE id = ?").bind(parent).run();

		const { response, error } = await readExport();

		expect(response.status).toBe(409);
		expect(error).toMatch(/hierarchy is corrupt/i);
		// The orphan is never promoted to a root, and nothing is written back.
		const stored = await env.db_boltlink
			.prepare("SELECT parent_id FROM link_groups WHERE id = ?")
			.bind(child)
			.first<{ parent_id: number | null }>();
		expect(stored?.parent_id).toBe(parent);
	});

	it("refuses a nameless group row", async () => {
		await env.db_boltlink.prepare("INSERT INTO link_groups (name) VALUES ('   ')").run();

		const { response, error } = await readExport();

		expect(response.status).toBe(409);
		expect(error).toMatch(/group row/i);
	});

	it("refuses a hybrid A/B plus Smart Routing row", async () => {
		await insertLink({
			slug: "hibrido",
			ab_enabled: 1,
			ab_target_url: "https://example.com/b",
			smart_routing_rules: VALID_SMART_RULES,
		});

		const { response, error } = await readExport();

		expect(response.status).toBe(409);
		expect(error).toMatch(/cannot both be active/i);
	});

	it("refuses an active A/B split on a permanent redirect", async () => {
		await insertLink({
			slug: "ab-301",
			redirect_type: "301",
			ab_enabled: 1,
			ab_target_url: "https://example.com/b",
		});

		const { response, error } = await readExport();

		expect(response.status).toBe(409);
		expect(error).toMatch(/A\/B/);
	});

	it("never exposes raw storage failures in a refusal", async () => {
		await insertLink({ slug: "corrompido", smart_routing_rules: "{not json" });

		const { text } = await readExport();

		for (const forbidden of ["SELECT", "SQLITE", "sqlite", "at Object.", "stack", "{not json", "smart_routing_rules"]) {
			expect(text, `refusal leaked ${forbidden}`).not.toContain(forbidden);
		}
	});
});

describe("Phase 5, Gate 5.2 fix round 1: canonical group names", () => {
	const NON_CANONICAL = ["  Group", "Group  ", "  Group  ", "   "];

	it("refuses a persisted name the write path would have normalized", async () => {
		for (const name of NON_CANONICAL) {
			await resetDatabase();
			await env.db_boltlink.prepare("INSERT INTO link_groups (name) VALUES (?)").bind(name).run();

			const { response, document, error } = await readExport();

			expect(response.status, JSON.stringify(name)).toBe(409);
			expect(error, JSON.stringify(name)).toMatch(/group row/i);
			expect(document).toBeNull();
		}
	});

	it("leaves the non-canonical row untouched when it refuses", async () => {
		await env.db_boltlink.prepare("INSERT INTO link_groups (name) VALUES ('  Group  ')").run();
		const before = await env.db_boltlink.prepare("SELECT id, name, parent_id FROM link_groups ORDER BY id").all();

		const { response } = await readExport();

		expect(response.status).toBe(409);
		const after = await env.db_boltlink.prepare("SELECT id, name, parent_id FROM link_groups ORDER BY id").all();
		expect(after.results).toEqual(before.results);
	});

	it("exports a name exactly at the write ceiling", async () => {
		const name = "G".repeat(120);
		await env.db_boltlink.prepare("INSERT INTO link_groups (name) VALUES (?)").bind(name).run();

		const { document } = await readSuccessfulExport();

		expect(document.groups).toHaveLength(1);
		expect(document.groups[0].name).toBe(name);
		expect(document.groups[0].name.length).toBe(120);
	});

	it("refuses a name one character above the write ceiling", async () => {
		await env.db_boltlink.prepare("INSERT INTO link_groups (name) VALUES (?)").bind("G".repeat(121)).run();

		const { response, error } = await readExport();

		expect(response.status).toBe(409);
		expect(error).toMatch(/group row/i);
	});

	it("uses the API's own ceiling, so a truncated API write exports", async () => {
		// The boundary is not invented for the export: the write path truncates at 120,
		// and the value it stores is exported unchanged.
		const created = await fetchWorker("http://localhost/api/groups", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "G".repeat(121) }),
		});
		expect(created.status).toBe(201);

		const stored = await env.db_boltlink.prepare("SELECT name FROM link_groups").all<{ name: string }>();
		expect(stored.results?.[0].name).toBe("G".repeat(120));

		const { document } = await readSuccessfulExport();
		expect(document.groups[0].name).toBe("G".repeat(120));
	});

	it("stores a padded submitted name trimmed, so it exports unchanged", async () => {
		const created = await fetchWorker("http://localhost/api/groups", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "  Equipe  " }),
		});
		expect(created.status).toBe(201);

		const stored = await env.db_boltlink.prepare("SELECT name FROM link_groups").all<{ name: string }>();
		expect(stored.results?.[0].name).toBe("Equipe");

		const { document } = await readSuccessfulExport();
		expect(document.groups[0].name).toBe("Equipe");
	});
});

/**
 * The exact key sets the format defines. Comparing `Object.keys(...).sort()` for every
 * entry is what makes an extra property — an internal `id`, a counter, a timestamp —
 * fail the suite instead of travelling unnoticed.
 */
const LINK_KEYS_BASE = [
	"slug",
	"targetUrl",
	"redirectType",
	"tags",
	"groupRef",
	"disabled",
	"goLiveAt",
	"expiresAt",
	"passwordProtected",
];
const LINK_KEYS_BY_MIGRATION: Record<3 | 4 | 5 | 6, string[]> = {
	3: LINK_KEYS_BASE,
	4: [...LINK_KEYS_BASE, "abTest"],
	5: [...LINK_KEYS_BASE, "abTest", "smartRouting"],
	6: [...LINK_KEYS_BASE, "abTest", "smartRouting", "expiredRedirectUrl"],
};
const GROUP_KEYS = ["name", "parentRef", "ref"];

describe("Phase 5, Gate 5.2 fix round 1: exact document keys", () => {
	it("emits exactly the group contract keys for every group", async () => {
		const clientes = await insertGroup("Clientes");
		const brasil = await insertGroup("Brasil", clientes);
		await insertGroup("Campinas", brasil);
		await insertGroup("Portugal", clientes);

		const { document } = await readSuccessfulExport();

		expect(document.groups.length).toBe(4);
		for (const group of document.groups) {
			expect(Object.keys(group).sort()).toEqual([...GROUP_KEYS].sort());
		}
		const serialized = JSON.stringify(document.groups);
		expect(serialized).not.toContain("\"id\"");
		expect(serialized).not.toContain("\"parent_id\"");
	});

	it("emits exactly the link contract keys for every link on a full schema", async () => {
		await insertLink({ slug: "a-um", ab_enabled: 1, ab_target_url: "https://example.com/b" });
		await insertLink({ slug: "b-dois", smart_routing_rules: VALID_SMART_RULES });
		await insertLink({ slug: "c-tres" });

		const { document } = await readSuccessfulExport();

		expect(document.links.length).toBe(3);
		for (const link of document.links) {
			expect(Object.keys(link).sort()).toEqual([...LINK_KEYS_BY_MIGRATION[6]].sort());
		}
	});
});

describe("Phase 5, Gate 5.2 fix round 1: supported migration levels", () => {
	for (const migration of [3, 4, 5, 6] as const) {
		it(`follows exactly the capabilities migration 000${migration} provides`, async () => {
			await installSchemaLevel(migration);
			await env.db_boltlink
				.prepare("INSERT INTO links (slug, target_url) VALUES (?, ?)")
				.bind("nivel", "https://example.com/x")
				.run();

			const response = await fetchWorker(EXPORT_URL, undefined, {
				db_boltlink: cloneDbHandle(env.db_boltlink),
			});
			const document = (await response.json()) as ExportDocument;

			expect(response.status).toBe(200);
			expect(Object.keys(document.links[0]).sort()).toEqual([...LINK_KEYS_BY_MIGRATION[migration]].sort());
		});
	}
});

describe("Phase 5, Gate 5.2 fix round 1: export is read-only from the first request", () => {
	it("validates a 0003 database without creating the metric fence projection", async () => {
		await installSchemaLevel(3);
		await env.db_boltlink
			.prepare("INSERT INTO links (slug, target_url) VALUES (?, ?)")
			.bind("legado", "https://example.com/x")
			.run();
		expect(await schemaObject("boltlink_metric_fence")).toBeNull();

		const traced = tracedHandle(cloneDbHandle(env.db_boltlink));
		const response = await fetchWorker(EXPORT_URL, undefined, { db_boltlink: traced.handle });
		const document = (await response.json()) as ExportDocument;

		// 0003 stays a supported level: the finding was that answering it created the
		// projection as a side effect, not that it answered.
		expect(response.status).toBe(200);
		expect(document.links[0].slug).toBe("legado");

		// The whole request, on a handle that never bootstrapped, ran zero DDL and zero
		// DML: the projection the bootstrapping readiness installs was never created.
		expect(await schemaObject("boltlink_metric_fence")).toBeNull();
		expect(traced.statements.some((sql) => DDL_STATEMENT_PATTERN.test(sql))).toBe(false);
		expect(traced.statements.some((sql) => DML_STATEMENT_PATTERN.test(sql))).toBe(false);
	});

	it("stays read-only on the second request over the same cold handle", async () => {
		await installSchemaLevel(6);

		const traced = tracedHandle(cloneDbHandle(env.db_boltlink));
		const first = await fetchWorker(EXPORT_URL, undefined, { db_boltlink: traced.handle });
		expect(first.status).toBe(200);
		traced.statements.length = 0;

		const second = await fetchWorker(EXPORT_URL, undefined, { db_boltlink: traced.handle });
		expect(second.status).toBe(200);

		// Warm: like the bootstrapping readiness, the read-only one is cached, so not even
		// a PRAGMA is issued — and still nothing is written.
		expect(traced.statements.some((sql) => /PRAGMA/i.test(sql))).toBe(false);
		expect(traced.statements.some((sql) => DDL_STATEMENT_PATTERN.test(sql))).toBe(false);
		expect(traced.statements.some((sql) => DML_STATEMENT_PATTERN.test(sql))).toBe(false);
		expect(await schemaObject("boltlink_metric_fence")).toBeNull();
	});

	it("keeps the bootstrapping readiness for every other administrative route", async () => {
		await installSchemaLevel(3);
		expect(await schemaObject("boltlink_metric_fence")).toBeNull();

		// Read-only is specific to the export: an ordinary route still installs the
		// projection, which the delay-fenced click update reads through.
		const traced = tracedHandle(cloneDbHandle(env.db_boltlink));
		const response = await fetchWorker("http://localhost/api/capabilities", undefined, {
			db_boltlink: traced.handle,
		});

		expect(response.status).toBe(200);
		expect(traced.statements.some((sql) => /CREATE VIEW IF NOT EXISTS boltlink_metric_fence/i.test(sql))).toBe(true);
		expect(await schemaObject("boltlink_metric_fence")).not.toBeNull();
	});
});

describe("Phase 5, Gate 5.2: limits and determinism", () => {
	it("exports exactly at the group and link limits", async () => {
		for (let index = 0; index < PORTABILITY_MAX_GROUPS; index += 1) {
			await insertGroup(`Grupo ${String(index).padStart(2, "0")}`);
		}
		for (let index = 0; index < PORTABILITY_MAX_LINKS; index += 1) {
			await insertLink({ slug: `link-${String(index).padStart(3, "0")}` });
		}

		const { document } = await readSuccessfulExport();

		expect(document.groups).toHaveLength(PORTABILITY_MAX_GROUPS);
		expect(document.links).toHaveLength(PORTABILITY_MAX_LINKS);
	});

	it("refuses one group above the limit instead of truncating", async () => {
		for (let index = 0; index <= PORTABILITY_MAX_GROUPS; index += 1) {
			await insertGroup(`Grupo ${String(index).padStart(2, "0")}`);
		}

		const { response, document, error } = await readExport();

		expect(response.status).toBe(413);
		expect(error).toMatch(/group limit/i);
		expect(document).toBeNull();
	});

	it("refuses one link above the limit instead of returning the first N", async () => {
		for (let index = 0; index <= PORTABILITY_MAX_LINKS; index += 1) {
			await insertLink({ slug: `link-${String(index).padStart(3, "0")}` });
		}

		const { response, document, error } = await readExport();

		expect(response.status).toBe(413);
		expect(error).toMatch(/link limit/i);
		expect(document).toBeNull();
	});

	it("counts tombstones towards the limit, unlike the administrative listing", async () => {
		for (let index = 0; index < PORTABILITY_MAX_LINKS; index += 1) {
			await insertLink({
				slug: `link-${String(index).padStart(3, "0")}`,
				// The listing filters these out; the export must not, or a reserved slug
				// would silently vanish from the artifact.
				disabled_at: index % 2 === 0 ? PAST() : null,
			});
		}

		const { document } = await readSuccessfulExport();
		expect(document.links).toHaveLength(PORTABILITY_MAX_LINKS);

		const listing = await fetchWorker("http://localhost/api/links");
		const listed = (await listing.json()) as { links: unknown[] };
		expect(listed.links.length).toBeLessThan(PORTABILITY_MAX_LINKS);
	});

	it("measures the size limit in UTF-8 bytes, not in JavaScript string length", () => {
		// 20 000 CJK characters are 20 000 JavaScript units but 60 000 bytes. Five such
		// tags put the serialized document under the ceiling in string length and over it
		// in bytes, which is exactly the difference between the correct measurement and
		// a `body.length` one.
		const tag = "漢".repeat(20_000);
		const slugs = ["a", "b", "c", "d", "e"].map((letter) => `link-${letter}`);
		const rows: PortabilityLinkRow[] = slugs.map((slug) => linkRow({ slug, tags: JSON.stringify([tag]) }));

		// The document the module would serialize, reconstructed exactly.
		const document: PortabilityDocumentV1 = {
			format: "boltlink-portability",
			schemaVersion: 1,
			exportedAt: "2026-01-01T00:00:00.000Z",
			groups: [],
			links: slugs.map((slug) => ({
				slug,
				targetUrl: "https://example.com/destino",
				redirectType: "302",
				tags: [tag],
				groupRef: null,
				disabled: false,
				goLiveAt: null,
				expiresAt: null,
				expiredRedirectUrl: null,
				passwordProtected: false,
				abTest: { enabled: false, variantBUrl: null, weightB: 50 },
				smartRouting: null,
			})),
		};

		const serialized = JSON.stringify(document);
		expect(serialized.length).toBeLessThan(PORTABILITY_MAX_BYTES);
		expect(new TextEncoder().encode(serialized).byteLength).toBeGreaterThan(PORTABILITY_MAX_BYTES);

		const built = buildPortabilityExport({
			counts: { groups: 0, links: rows.length },
			groups: [],
			links: rows,
			capabilities: ALL_CAPABILITIES,
			policy: POLICY,
			exportedAt: "2026-01-01T00:00:00.000Z",
		});

		expect(built.ok).toBe(false);
		if (!built.ok) {
			expect(built.status).toBe(413);
			expect(built.code).toBe("TOO_LARGE");
			expect(built.error).toContain(String(PORTABILITY_MAX_BYTES));
		}
	});

	it("serializes exactly the reconstructed document shape", () => {
		// Proves the hand-authored document above is the real serialization, so the byte
		// measurement is taken on the document the module would actually produce.
		const rows: PortabilityLinkRow[] = [
			linkRow({ slug: "link-a", tags: JSON.stringify(["um"]), has_password: 1 }),
		];

		const built = buildPortabilityExport({
			counts: { groups: 0, links: 1 },
			groups: [],
			links: rows,
			capabilities: ALL_CAPABILITIES,
			policy: POLICY,
			exportedAt: "2026-01-01T00:00:00.000Z",
		});

		expect(built.ok).toBe(true);
		if (built.ok) {
			expect(built.body).toBe(JSON.stringify({
				format: "boltlink-portability",
				schemaVersion: 1,
				exportedAt: "2026-01-01T00:00:00.000Z",
				groups: [],
				links: [
					{
						slug: "link-a",
						targetUrl: "https://example.com/destino",
						redirectType: "302",
						tags: ["um"],
						groupRef: null,
						disabled: false,
						goLiveAt: null,
						expiresAt: null,
						expiredRedirectUrl: null,
						passwordProtected: true,
						abTest: { enabled: false, variantBUrl: null, weightB: 50 },
						smartRouting: null,
					},
				],
			}));
			expect(built.bytes).toBe(new TextEncoder().encode(built.body).byteLength);
		}
	});

	it("refuses an oversized document at the endpoint instead of truncating it", async () => {
		const tag = "漢".repeat(6000);
		for (let index = 0; index < 20; index += 1) {
			await insertLink({ slug: `unicode-${String(index).padStart(2, "0")}`, tags: JSON.stringify([tag]) });
		}

		const { response, document, error } = await readExport();

		expect(response.status).toBe(413);
		expect(error).toMatch(/size limit/i);
		// The refusal carries no partial document.
		expect(document).toBeNull();
	});

	it("produces the same functional document for the same configuration", async () => {
		const groupId = await insertGroup("Estável");
		await insertLink({ slug: "b-link", group_id: groupId, tags: JSON.stringify(["um"]) });
		await insertLink({ slug: "a-link" });

		const first = await readSuccessfulExport();
		const second = await readSuccessfulExport();

		const strip = (value: string) => value.replace(/"exportedAt":"[^"]*"/, '"exportedAt":"<variável>"');
		expect(strip(first.text)).toBe(strip(second.text));
		expect(first.document.groups).toEqual(second.document.groups);
		expect(first.document.links.map((link) => link.slug)).toEqual(["a-link", "b-link"]);
	});

	it("derives the same refs from the same configuration in any insertion order", () => {
		const groups: PortabilityGroupRow[] = [
			{ id: 30, name: "Portugal", parent_id: 10 },
			{ id: 10, name: "Clientes", parent_id: null },
			{ id: 20, name: "Brasil", parent_id: 10 },
		];
		const links: PortabilityLinkRow[] = [
			linkRow({ slug: "z-link", target_url: "https://example.com/z", group_id: 20 }),
			linkRow({ slug: "a-link", target_url: "https://example.com/a" }),
		];

		const shuffledGroups = [groups[2], groups[0], groups[1]];
		const shuffledLinks = [links[1], links[0]];

		const build = (inputGroups: PortabilityGroupRow[], inputLinks: PortabilityLinkRow[]) => {
			const result = buildPortabilityExport({
				counts: { groups: inputGroups.length, links: inputLinks.length },
				groups: inputGroups,
				links: inputLinks,
				capabilities: ALL_CAPABILITIES,
				policy: POLICY,
				exportedAt: "2026-01-01T00:00:00.000Z",
			});
			if (!result.ok) {
				throw new Error(`expected a successful build, got ${result.error}`);
			}
			return result.body;
		};

		expect(build(shuffledGroups, shuffledLinks)).toBe(build(groups, links));
	});

	it("refuses an oversized count before touching the link rows", () => {
		const built = buildPortabilityExport({
			counts: { groups: 0, links: PORTABILITY_MAX_LINKS + 1 },
			groups: [],
			links: [],
			capabilities: ALL_CAPABILITIES,
			policy: POLICY,
			exportedAt: "2026-01-01T00:00:00.000Z",
		});

		expect(built.ok).toBe(false);
		if (!built.ok) {
			expect(built.code).toBe("TOO_MANY_LINKS");
			expect(built.status).toBe(413);
		}
	});
});

describe("Phase 5, Gate 5.2: export endpoint", () => {
	it("sets the download headers with a static filename", async () => {
		const { response } = await readSuccessfulExport();

		expect(response.headers.get("Content-Type")).toContain("application/json");
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="boltlink-export.json"');
		expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
		// Nothing derived from the request or from persisted data can steer the name.
		await insertLink({ slug: "nome-no-filename" });
		const again = await readSuccessfulExport();
		expect(again.response.headers.get("Content-Disposition")).toBe('attachment; filename="boltlink-export.json"');
	});

	it("requires the same administrative boundary as every other API route", async () => {
		const remote = "https://links.example.com/api/export";

		const unauthenticated = await readExport(undefined, remote);
		expect(unauthenticated.response.status).toBe(401);
		expect(unauthenticated.error).toBe("Authentication required");

		const withKey = await readExport({ API_KEY: "export-api-key" } as Partial<Env>, remote);
		expect(withKey.response.status).toBe(401);

		const authorized = await fetchWorker(remote, { headers: { Authorization: "Bearer export-api-key" } }, {
			API_KEY: "export-api-key",
		} as Partial<Env>);
		expect(authorized.status).toBe(200);
	});

	it("shares the existing administrative rate limiter", async () => {
		for (let index = 0; index < 30; index += 1) {
			await fetchWorker(EXPORT_URL);
		}

		const limited = await fetchWorker(EXPORT_URL);

		expect(limited.status).toBe(429);
		expect(await limited.json()).toEqual({ error: "Rate limit exceeded" });
	});

	it("fails closed with 503 when the database was never prepared", async () => {
		// Nothing special for this route: it inherits the same schema readiness gate as
		// every other `/api/*` request instead of reading an unprepared database. The
		// fresh handle identity is what makes the missing schema observable, because the
		// readiness cache is per handle.
		await env.db_boltlink.prepare("DROP TABLE links").run();
		await env.db_boltlink.prepare("DROP TABLE link_groups").run();

		const response = await fetchWorker(EXPORT_URL, undefined, {
			db_boltlink: cloneDbHandle(env.db_boltlink),
		});

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: "Database schema is not initialized" });
	});

	it("writes nothing to the database", async () => {
		const groupId = await insertGroup("Somente leitura");
		await insertLink({ slug: "nao-escrito", group_id: groupId, clicks_total: 12, version: 4 });

		const before = await env.db_boltlink
			.prepare("SELECT clicks_total, version, updated_at FROM links WHERE slug = ?")
			.bind("nao-escrito")
			.first<{ clicks_total: number; version: number; updated_at: string }>();

		const traced = tracedHandle(env.db_boltlink);
		// Warm the identity first: the first request on a handle validates the schema, and
		// this test measures a steady-state export.
		await fetchWorker(EXPORT_URL, undefined, { db_boltlink: traced.handle });
		traced.statements.length = 0;

		const response = await fetchWorker(EXPORT_URL, undefined, { db_boltlink: traced.handle });
		expect(response.status).toBe(200);

		const after = await env.db_boltlink
			.prepare("SELECT clicks_total, version, updated_at FROM links WHERE slug = ?")
			.bind("nao-escrito")
			.first<{ clicks_total: number; version: number; updated_at: string }>();

		expect(after).toEqual(before);
		// Only reads, and no probing of a schema that was already validated.
		expect(traced.statements.some((sql) => WRITE_STATEMENT_PATTERN.test(sql))).toBe(false);
		expect(traced.statements.some((sql) => /PRAGMA/i.test(sql))).toBe(false);
		expect(traced.statements.some((sql) => /boltlink_metric_fence/i.test(sql))).toBe(false);
	});

	it("never leaks configured secrets into the document or the headers", async () => {
		const passwordSentinel = "BOLTLINK_TEST_SECRET_HASH_12345";
		await insertLink({ slug: "com-senha", password_hash: passwordSentinel });
		await insertGroup("Grupo");

		const { response, text } = await readSuccessfulExport({
			API_KEY: "EXPORT_SECRET_DO_NOT_LEAK",
			PASSWORD_SESSION_SECRET: "SESSION_SECRET_DO_NOT_LEAK",
		} as Partial<Env>);

		expect(text).not.toContain("EXPORT_SECRET_DO_NOT_LEAK");
		expect(text).not.toContain("SESSION_SECRET_DO_NOT_LEAK");
		expect(text).not.toContain(passwordSentinel);

		const headerDump = Array.from(response.headers.entries()).map(([key, value]) => `${key}: ${value}`).join("\n");
		expect(headerDump).not.toContain("EXPORT_SECRET_DO_NOT_LEAK");
		expect(headerDump).not.toContain("SESSION_SECRET_DO_NOT_LEAK");
	});

	it("keeps visitor data out of the document by construction", async () => {
		await insertLink({ slug: "visitado", clicks_total: 3 });
		await fetchWorker("https://example.com/visitado", {
			headers: {
				"CF-Connecting-IP": "203.0.113.9",
				"User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
				Referer: "https://origem.example.com/pagina",
			},
		});

		const { text } = await readSuccessfulExport();

		for (const visitorValue of ["203.0.113.9", "iPhone", "origem.example.com", "Mozilla"]) {
			expect(text, `document leaked ${visitorValue}`).not.toContain(visitorValue);
		}
	});
});

describe("Phase 5, Gate 5.2: read consistency", () => {
	it("keeps the document internally consistent when a group is removed mid-read", async () => {
		const groupId = await insertGroup("Some");
		await insertLink({ slug: "some-link", group_id: groupId });

		const seams = { count: 0 };
		const proxied = removeGroupBetweenReads(env.db_boltlink, groupId, seams);

		const response = await fetchWorker(EXPORT_URL, undefined, { db_boltlink: proxied });
		const document = (await response.json()) as ExportDocument;

		// The seam fired: the group was removed between the two ordered reads.
		expect(seams.count).toBe(1);

		// The group read is the snapshot the refs come from, so the membership still
		// resolves inside the document: the removal cannot manufacture a dangling
		// `groupRef`. No snapshot isolation is claimed — the two reads may disagree
		// about which groups exist, and the contract is only that the artifact never
		// contradicts itself.
		expect(response.status).toBe(200);
		const refs = new Set(document.groups.map((group) => group.ref));
		expect(refs.has("g1")).toBe(true);
		for (const link of document.links) {
			if (link.groupRef !== null) {
				expect(refs.has(link.groupRef), `dangling groupRef ${link.groupRef}`).toBe(true);
			}
			expect(Object.prototype.hasOwnProperty.call(link, "groupRef")).toBe(true);
		}
	});

	it("refuses instead of emitting a dangling reference when a membership outruns the snapshot", async () => {
		await insertLink({ slug: "movido" });

		const seams = { count: 0 };
		const proxied = createGroupBetweenReads(env.db_boltlink, "movido", seams);

		const response = await fetchWorker(EXPORT_URL, undefined, { db_boltlink: proxied });
		const payload = (await response.json()) as { error?: string };

		// A link moved to a group the snapshot never saw cannot be rendered as a valid
		// membership, and dropping it would be a silent rewrite: the export fails whole.
		expect(seams.count).toBe(1);
		expect(response.status).toBe(409);
		expect(payload.error).toMatch(/missing group/i);
		expect(payload).not.toHaveProperty("groups");
		expect(payload).not.toHaveProperty("links");
	});

	it("refuses when a link is moved to a group created after the group read", async () => {
		await insertLink({ slug: "movido" });

		const seams = { count: 0 };
		const proxied = createGroupBetweenReads(env.db_boltlink, "movido", seams);

		const response = await fetchWorker(EXPORT_URL, undefined, { db_boltlink: proxied });
		const payload = (await response.json()) as { error?: string };

		expect(seams.count).toBe(1);
		expect(response.status).toBe(409);
		expect(payload.error).toMatch(/missing group/i);
	});

	it("keeps the public redirect free of the export, groups and validation", async () => {
		const groupId = await insertGroup("Roteado");
		await insertLink({
			slug: "hot-path",
			group_id: groupId,
			smart_routing_rules: VALID_SMART_RULES,
			expires_at: FUTURE(),
			expired_redirect_url: "https://example.com/depois",
			tags: JSON.stringify(["campanha"]),
		});

		const traced = tracedHandle(env.db_boltlink);
		// Warm the handle: the first request on an isolate validates the schema, and
		// this test measures the steady-state redirect.
		await fetchWorker("https://example.com/hot-path", undefined, { db_boltlink: traced.handle });

		traced.statements.length = 0;
		const response = await fetchWorker("https://example.com/hot-path", undefined, { db_boltlink: traced.handle });

		expect(response.status).toBe(302);
		const selects = traced.statements.filter((sql) => sql.trimStart().startsWith("SELECT"));
		expect(selects).toHaveLength(1);
		expect(selects[0]).toBe("SELECT * FROM links WHERE slug = ? AND disabled_at IS NULL");
		expect(
			traced.statements.some((sql) => /link_groups|JOIN|PRAGMA|WITH RECURSIVE|smart_routing_rules|expired_redirect_url/i.test(sql)),
		).toBe(false);
	});
});

/*
 * Copyright (c) 2026 Vitor Faustino
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * ---
 * DISCLAIMER / ISENÇÃO DE RESPONSABILIDADE:
 * This software is provided "as is", without warranty of any kind.
 * Vitor Faustino (vitorfaustino.com.br) is not liable for any damages, 
 * losses, or inaccurate results arising from the use of this software.
 * 
 * Este software é fornecido "como está", sem garantias de qualquer tipo.
 * Vitor Faustino (vitorfaustino.com.br) não se responsabiliza por quaisquer
 * danos, perdas ou resultados imprecisos decorrentes do uso deste software.
 */

import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { createRemoteJWKSet, jwtVerify } from "jose";
import QRCode from "qrcode";
import packageJson from "../package.json";
import { consumePublicRedirectBudget, rateLimitMiddleware } from "./rate-limit";
import { isCountableClick, isCountablePasswordSubmission } from "./click-filter";
import { randomPercent } from "./ab-random";
import {
	classifyDevice,
	normalizeRequestCountry,
	parsePersistedSmartRoutingRules,
	parseSmartRoutingRules,
	selectSmartRoutingTarget,
} from "./smart-routing";
import type { SmartRoutingPersistedResult, SmartRoutingRule } from "./smart-routing";
import {
	GROUP_DELETE_SQL,
	GROUP_INSERT_SQL,
	GROUP_MOVE_SQL,
	MAX_GROUP_DEPTH,
	analyzeGroupHierarchy,
	groupDeleteBindings,
	groupInsertBindings,
	groupMoveBindings,
	normalizeGroupName,
	isWithinSubtree,
} from "./group-hierarchy";
import type { GroupHierarchyRow } from "./group-hierarchy";
import { PORTABILITY_EXPORT_FILENAME, PORTABILITY_MAX_BYTES, buildPortabilityExport } from "./portability";
import type { PortabilityGroupRow, PortabilityLinkRow } from "./portability";
import {
	PORTABILITY_IMPORT_ENVELOPE_KEYS,
	PORTABILITY_IMPORT_ENVELOPE_SLACK_BYTES,
	buildPortabilityImportStatements,
	findPortabilityImportBlockers,
	isPortabilityImportSlugCollisionError,
	parsePortabilityImportDocument,
	portabilityImportDocumentBytes,
	portabilityImportRefusal,
} from "./portability-import";
import type {
	PortabilityImportBlockerCode,
	PortabilityImportEnvelope,
	PortabilityImportFeatureFlags,
	PortabilityImportPlan,
	PortabilityImportPolicy,
	PortabilityImportRefusal,
	PortabilityImportWarningCode,
} from "./portability-import";

/** Persisted-state classification exposed to the Admin: disabled ≠ corrupt. */
type SmartRoutingStatus = SmartRoutingPersistedResult["status"];

type Bindings = {
	db_boltlink: D1Database;
	ASSETS: Fetcher;
	TEAM_DOMAIN: string;
	POLICY_AUD: string;
	APP_TIMEZONE?: string;
	/**
	 * Optional operational override for `GET /`. It is deliberately not a
	 * database setting and has no Admin UI: the operator sets it per
	 * environment (dashboard var or `wrangler.local.jsonc`). Absent, empty and
	 * invalid all keep serving the bundled landing page.
	 */
	ROOT_REDIRECT_URL?: string;
	API_KEY?: string;
	PASSWORD_SESSION_SECRET?: string;
};

type AppContext = {
	Bindings: Bindings;
};

type LinkRow = {
	id: number;
	slug: string;
	target_url: string;
	clicks_total: number;
	created_at: string;
	updated_at: string;
	disabled_at: string | null;
	expires_at: string | null;
	go_live_at: string | null;
	redirect_type: "301" | "302";
	tags: string | null;
	has_qrcode: number;
	group_id: number | null;
	group_name?: string | null;
	has_password: number;
	ab_enabled: number;
	ab_target_url: string | null;
	ab_weight_b: number;
	ab_generation: number;
	metric_epoch: number;
	ab_clicks_a: number;
	ab_clicks_b: number;
	ab_started_at: string | null;
	smart_routing_rules?: string | null;
	expired_redirect_url?: string | null;
	version: number;
};

/**
 * Row of the public redirect `SELECT *`. Every feature column is optional
 * because presence depends on the migration level of the database: the row
 * shape is what tells the runtime which features exist.
 */
type RedirectRow = {
	id: number;
	slug: string;
	target_url: string;
	expires_at: string | null;
	go_live_at: string | null;
	redirect_type: "301" | "302";
	password_hash: string | null;
	ab_enabled?: number;
	ab_target_url?: string | null;
	ab_weight_b?: number;
	ab_generation?: number;
	metric_epoch?: number;
	ab_clicks_a?: number;
	ab_clicks_b?: number;
	ab_started_at?: string | null;
	smart_routing_rules?: string | null;
	expired_redirect_url?: string | null;
};

type CreateLinkPayload = {
	slug?: string;
	targetUrl?: string;
	url?: string;
	redirectType?: "301" | "302";
	tags?: string[];
	expiresAt?: string;
	goLiveAt?: string;
	groupId?: number | null;
	password?: string;
	abEnabled?: boolean;
	abTargetUrl?: string | null;
	abWeightB?: number;
	smartRoutingRules?: unknown;
	expiredRedirectUrl?: string | null;
};

type UpdateLinkPayload = {
	targetUrl?: string;
	url?: string;
	slug?: string;
	redirectType?: "301" | "302";
	tags?: string[];
	expiresAt?: string | null;
	goLiveAt?: string | null;
	groupId?: number | null;
	password?: string | null;
	abEnabled?: boolean;
	abTargetUrl?: string | null;
	abWeightB?: number;
	smartRoutingRules?: unknown;
	expiredRedirectUrl?: string | null;
};

type LinkGroupRow = {
	id: number;
	name: string;
	parent_id: number | null;
	created_at: string;
};

/**
 * Dotless fixed routes that would otherwise be captured by `/:slug`.
 * Keep this list next to route registration: a slug is never reusable after
 * soft deletion, so accepting one of these names would consume it forever.
 */
const FIXED_ROUTE_SLUGS = ["admin", "api", "health", "healt", "privacidade", "version"] as const;
const RESERVED_SLUGS = new Set([
	...FIXED_ROUTE_SLUGS,
	"admin.css",
	"admin.html",
	"admin.js",
	"favicon.ico",
	"robots.txt",
]);
const SLUG_PATTERN = /^[A-Za-z0-9_-]{3,64}$/;
const SLUG_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const accessJwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const databaseSchemaBootstrap = new WeakMap<D1Database, Promise<void>>();
/**
 * Positive-only cache of the read-only schema *validation* (no fence projection).
 * It exists so a steady-state `GET /api/export` runs no `PRAGMA` at all, exactly like
 * the bootstrapping path; a failed validation is never cached, so an unprepared
 * database keeps reporting `503`.
 */
const databaseSchemaValidated = new WeakMap<D1Database, Promise<void>>();
const databaseAbReady = new WeakMap<D1Database, boolean>();
const databaseSmartRoutingReady = new WeakMap<D1Database, boolean>();
const databaseExpiredRedirectReady = new WeakMap<D1Database, boolean>();
const SMART_ROUTING_COLUMN = "smart_routing_rules";
const SMART_ROUTING_MIGRATION_HINT = "Smart Routing requires migration 0005_smart_routing.sql to be applied";
const EXPIRED_REDIRECT_COLUMN = "expired_redirect_url";
const EXPIRED_REDIRECT_MIGRATION_HINT = "Expired redirect requires migration 0006_expired_redirect.sql to be applied";
/**
 * Administrative invariant of the expired destination. The destination is only
 * ever reachable after `expires_at` elapses, so storing one on a link without an
 * expiration would persist a dormant configuration nobody can observe.
 */
const EXPIRED_REDIRECT_REQUIRES_EXPIRATION = "expiredRedirectUrl requires expiresAt";
/**
 * Administrative invariants of the group hierarchy (published in 3.0.0; origin Phase 5). The
 * tree columns come from `0002`; everything below is write-time policy, so Gate
 * 5.1 adds no migration and no capability flag.
 */
const GROUP_HIERARCHY_CORRUPT_MESSAGE = "Group hierarchy is corrupt";
const GROUP_SELF_PARENT_MESSAGE = "Group cannot be its own parent";
const GROUP_PARENT_REQUIRED_MESSAGE = "expectedParentId is required when parentId changes";
const GROUP_PARENT_CHANGED_MESSAGE = "Group parent changed. Reload the tree and try again";
const GROUP_SUBTREE_MESSAGE = "Group cannot be moved into its own subtree";
const GROUP_HAS_CHILDREN_MESSAGE = "Group has child groups";
const GROUP_HAS_LINKS_MESSAGE = "Group still has links";
/**
 * Primary (and only) public redirect read. The wildcard projection is what makes
 * the redirect schema-neutral: it names no feature column, so it is valid on
 * every migration level, and whatever the migration added shows up in the row
 * on the next request of *any* handle. That removes the need for a capability
 * cache on this path, so a handle warmed before a migration can never stay
 * stuck on a stale negative. Row shape is read by `readPublicRowCapabilities`.
 */
const PUBLIC_REDIRECT_SQL = "SELECT * FROM links WHERE slug = ? AND disabled_at IS NULL";
const AB_SCHEMA_COLUMNS = [
	"ab_enabled",
	"ab_target_url",
	"ab_weight_b",
	"ab_generation",
	"metric_epoch",
	"ab_clicks_a",
	"ab_clicks_b",
	"ab_started_at",
] as const;
/**
 * Columns the runtime needs to operate. They are created exclusively by the
 * versioned migrations; the runtime validates their presence and fails closed
 * when the database was never prepared instead of evolving the schema itself.
 */
const REQUIRED_LINK_COLUMNS = [
	"id",
	"slug",
	"target_url",
	"clicks_total",
	"created_at",
	"updated_at",
	"disabled_at",
	"expires_at",
	"go_live_at",
	"redirect_type",
	"tags",
	"has_qrcode",
	"group_id",
	"password_hash",
	"version",
] as const;
const DATABASE_SCHEMA_NOT_INITIALIZED_MESSAGE = "Database schema is not initialized";
let databaseSchemaWarningLogged = false;
const METRIC_FENCE_VIEW = "boltlink_metric_fence";
const METRIC_FENCE_VIEW_REAL_SQL = `CREATE VIEW IF NOT EXISTS ${METRIC_FENCE_VIEW} AS SELECT id, metric_epoch FROM links`;
const METRIC_FENCE_VIEW_LEGACY_SQL = `CREATE VIEW IF NOT EXISTS ${METRIC_FENCE_VIEW} AS SELECT id, 0 AS metric_epoch FROM links`;
const APP_VERSION = packageJson.version;
const DEFAULT_APP_TIMEZONE = "America/Sao_Paulo";
const PASSWORD_RATE_LIMIT_MAX_ATTEMPTS = 5;
const PASSWORD_RATE_LIMIT_WINDOW_MS = 60_000;
const PASSWORD_SESSION_MAX_AGE_SECONDS = 300;
const DEFAULT_AB_WEIGHT_B = 50;
const AB_WEIGHT_MIN = 1;
const AB_WEIGHT_MAX = 99;
const passwordAttempts = new Map<string, { count: number; resetAt: number }>();
let passwordRateLimitSalt: string | null = null;

const app = new Hono<AppContext>();

app.onError((error, c) => {
	if (error instanceof DatabaseSchemaNotInitializedError) {
		if (!databaseSchemaWarningLogged) {
			databaseSchemaWarningLogged = true;
			console.error(`${DATABASE_SCHEMA_NOT_INITIALIZED_MESSAGE}. Apply the versioned migrations before serving requests.`);
		}
		if (isApiPath(c.req.path)) {
			return applySecurityHeaders(c.json({ error: DATABASE_SCHEMA_NOT_INITIALIZED_MESSAGE }, 503), c.req.path, c.req.url);
		}

		return applySecurityHeaders(c.text(DATABASE_SCHEMA_NOT_INITIALIZED_MESSAGE, 503), c.req.path, c.req.url);
	}

	console.error("Unhandled application error", error);
	if (isApiPath(c.req.path)) {
		return applySecurityHeaders(c.json({ error: "Internal server error" }, 500), c.req.path, c.req.url);
	}

	return applySecurityHeaders(c.text("Internal server error", 500), c.req.path, c.req.url);
});

app.notFound((c) => {
	if (isApiPath(c.req.path)) {
		return applySecurityHeaders(c.json({ error: "Not found" }, 404), c.req.path, c.req.url);
	}

	return applySecurityHeaders(c.text("Not found", 404), c.req.path, c.req.url);
});

app.use("*", async (c, next) => {
	await next();
	c.res = applySecurityHeaders(c.res, c.req.path, c.req.url);
});

const requireAdmin: MiddlewareHandler<AppContext> = async (c, next) => {
	if (isLocalRequest(c.req.url)) {
		await next();
		return;
	}

	const hasApiKeyAccess = isApiPath(c.req.path) && hasValidApiKey(c.req.raw, c.env.API_KEY);
	if (hasApiKeyAccess || (await hasValidAccessSession(c.req.raw, c.env))) {
		await next();
		return;
	}

	return rejectUnauthorized(c);
};

/**
 * Administrative routes that must not run the bootstrapping schema step. `GET /api/export`
 * is there because it advertises a zero-write artifact, so the fence projection the
 * runtime installs on every other administrative request must not be created as a side
 * effect of asking for it. The two import routes are there for the same reason from the
 * other direction: they validate a document and write rows, and a portability operation
 * must never execute DDL — implicit or otherwise — so they validate the schema with the
 * read-only readiness and refuse a database that was never prepared with the same `503`.
 * The preview route additionally writes nothing at all, which is why its whole request
 * stays read-only. Every one of them still runs through the same rate limiter, the same
 * `requireAdmin` boundary and the same schema validation.
 */
const NON_BOOTSTRAPPING_DATABASE_PATHS = new Set(["/api/export", "/api/import/preview", "/api/import/apply"]);

/**
 * `GET /api/links/:slug/qrcode` renders the short URL and reads nothing but the link's
 * existence, so answering it cannot justify installing the metric fence projection — the
 * whole request is a read. The exemption is decided per request rather than per pathname
 * because the `POST` on the same route writes `has_qrcode` and keeps the bootstrapping
 * readiness, exactly like every other administrative write.
 */
const READ_ONLY_QRCODE_GET_PATH = /^\/api\/links\/[^/]+\/qrcode$/;

function usesReadOnlyDatabaseReadiness(c: Context<AppContext>) {
	if (NON_BOOTSTRAPPING_DATABASE_PATHS.has(c.req.path)) {
		return true;
	}
	return c.req.method === "GET" && READ_ONLY_QRCODE_GET_PATH.test(c.req.path);
}

const ensureDatabaseReady: MiddlewareHandler<AppContext> = async (c, next) => {
	if (usesReadOnlyDatabaseReadiness(c)) {
		await inspectDatabaseSchema(c.env.db_boltlink);
	} else {
		await ensurePreparedDatabase(c.env.db_boltlink);
	}
	await next();
};

app.use("/admin", requireAdmin);
app.use("/admin/*", requireAdmin);
app.use("/admin.html", requireAdmin);
app.use("/api", rateLimitMiddleware);
app.use("/api/*", rateLimitMiddleware);
app.use("/api", requireAdmin);
app.use("/api/*", requireAdmin);
app.use("/api/*", ensureDatabaseReady);

/**
 * Root entry point. `ROOT_REDIRECT_URL` is optional operational configuration,
 * not a database setting and not a secret.
 *
 * The redirect is decided before touching anything else, which is what keeps the
 * root path free of D1: a configured deployment runs zero `prepare` calls, no
 * schema detection, no capability probe, no cookie and no click metric on `GET /`.
 * The landing page stays the fallback for every value that cannot be honored, so
 * a typo in the environment degrades the site instead of failing it.
 */
app.get("/", (c) => {
	const rootRedirect = resolveRootRedirectUrl(c.env.ROOT_REDIRECT_URL, c.req.url);
	if (!rootRedirect) {
		return c.html(renderHomePage());
	}

	// Always 302, never 301: this is mutable per-environment configuration, so a
	// permanent redirect retained by a client or intermediary cache would outlive
	// the value that produced it.
	const response = c.redirect(rootRedirect, 302);
	response.headers.set("Cache-Control", "no-store");
	return response;
});

app.get("/health", (c) => {
	return serveHealth(c);
});

app.get("/version", (c) => {
	return c.json({ version: APP_VERSION, timezone: getAppTimeZone(c.env) });
});

app.get("/healt", (c) => {
	return serveHealth(c);
});

app.get("/admin", serveAdminAsset);
app.get("/admin/", serveAdminAsset);
app.get("/admin.html", serveAdminAsset);
app.get("/privacidade", servePrivacyAsset);

app.get("/api/capabilities", async (c) => {
	const schema = await ensureDatabaseSchema(c.env.db_boltlink);
	const smartRouting = await ensureSmartRoutingCapability(c.env.db_boltlink);
	const expiredRedirect = await ensureExpiredRedirectCapability(c.env.db_boltlink);
	return c.json({ abTesting: schema.abReady, smartRouting, expiredRedirect });
});

app.get("/api/links", async (c) => {
	const search = c.req.query("search")?.trim() ?? "";
	const searchPattern = search ? `%${escapeLikePattern(search)}%` : null;
	const tag = c.req.query("tag")?.trim() ?? "";
	const tagPattern = tag ? `%\"${escapeLikePattern(tag)}\"%` : null;
	const hasQrcode = c.req.query("has_qrcode");
	const groupIdRaw = c.req.query("group_id");
	const filters: string[] = ["disabled_at IS NULL"];
	const bindings: Array<string | number> = [];

	if (searchPattern) {
		filters.push("(slug LIKE ? OR target_url LIKE ? OR tags LIKE ?)");
		bindings.push(searchPattern, searchPattern, searchPattern);
	}

	if (tagPattern) {
		filters.push("tags LIKE ?");
		bindings.push(tagPattern);
	}

	if (hasQrcode === "1") {
		filters.push("has_qrcode = 1");
	} else if (hasQrcode === "0") {
		filters.push("has_qrcode = 0");
	}

	if (groupIdRaw !== undefined) {
		if (groupIdRaw === "null" || groupIdRaw === "none") {
			filters.push("group_id IS NULL");
		} else {
			const groupId = Number.parseInt(groupIdRaw, 10);
			if (!Number.isNaN(groupId)) {
				filters.push("group_id = ?");
				bindings.push(groupId);
			}
		}
	}

	const schema = await ensureDatabaseSchema(c.env.db_boltlink);
	const smartRouting = await ensureSmartRoutingCapability(c.env.db_boltlink);
	const expiredRedirect = await ensureExpiredRedirectCapability(c.env.db_boltlink);
	const abColumns = schema.abReady
		? `,
				links.ab_enabled,
				links.ab_target_url,
				links.ab_weight_b,
				links.ab_generation,
				links.metric_epoch,
				links.ab_clicks_a,
				links.ab_clicks_b,
				links.ab_started_at`
		: "";
	const smartColumns = smartRouting ? ", links.smart_routing_rules" : "";
	const expiredColumns = expiredRedirect ? ", links.expired_redirect_url" : "";

	const baseSql = `SELECT
				links.id,
				links.slug,
				links.target_url,
				links.clicks_total,
				links.created_at,
				links.updated_at,
				links.disabled_at,
				links.expires_at,
				links.go_live_at,
				links.redirect_type,
				links.tags,
				links.has_qrcode,
				links.group_id,
				link_groups.name AS group_name,
				CASE WHEN links.password_hash IS NOT NULL THEN 1 ELSE 0 END AS has_password${abColumns}${smartColumns}${expiredColumns},
				links.version
			FROM links
			LEFT JOIN link_groups ON link_groups.id = links.group_id
			WHERE ${filters.join(" AND ")}
			ORDER BY links.created_at DESC
			LIMIT 100`;
	const statement = bindings.length
		? c.env.db_boltlink.prepare(baseSql).bind(...bindings)
		: c.env.db_boltlink.prepare(baseSql);
	const result = await statement.all<LinkRow>();

	const links = (result.results ?? []).map((row) => exposeLinkRow(row));
	return c.json({ links, search });
});

app.post("/api/links", async (c) => {
	const payload = await parseJsonBody<CreateLinkPayload>(c);
	if (!payload) {
		return c.json({ error: "Invalid JSON body" }, 400);
	}

	const targetUrl = normalizeTargetUrl(payload.targetUrl ?? payload.url);
	if (!targetUrl) {
		return c.json({ error: "Invalid target URL" }, 400);
	}

	const redirectType = normalizeRedirectType(payload.redirectType);
	if (!redirectType) {
		return c.json({ error: "Invalid redirect type. Use '301' or '302'" }, 400);
	}

	const tags = normalizeTags(payload.tags);
	if (payload.tags !== undefined && tags === null) {
		return c.json({ error: "Invalid tags. Provide an array of strings" }, 400);
	}

	const appTimeZone = getAppTimeZone(c.env);
	const expiresAt = normalizeDateTime(payload.expiresAt, appTimeZone);
	const goLiveAt = normalizeDateTime(payload.goLiveAt, appTimeZone);
	if ((payload.expiresAt && !expiresAt) || (payload.goLiveAt && !goLiveAt)) {
		return c.json({ error: `Invalid date format. Use ISO-8601 or yyyy-MM-ddTHH:mm in timezone ${appTimeZone}` }, 400);
	}

	if (expiresAt && goLiveAt && new Date(expiresAt).getTime() < new Date(goLiveAt).getTime()) {
		return c.json({ error: "expiresAt cannot be earlier than goLiveAt" }, 400);
	}

	const groupId = normalizeGroupId(payload.groupId);
	if (payload.groupId !== undefined && groupId === undefined) {
		return c.json({ error: "Invalid groupId" }, 400);
	}

	if (groupId !== null && groupId !== undefined && !(await groupExists(c.env.db_boltlink, groupId))) {
		return c.json({ error: "Group not found" }, 404);
	}

	const password = normalizePassword(payload.password);
	if (password.kind === "invalid") {
		return c.json({ error: "Invalid password. Provide a non-empty string or null" }, 400);
	}
	if (password.kind === "set" && !hasConfiguredPasswordSessionSecret(c.env)) {
		return c.json({ error: "PASSWORD_SESSION_SECRET is required to create password-protected links" }, 400);
	}
	const passwordHash = password.kind === "set" ? await hashPassword(password.value) : null;

	const schema = await ensureDatabaseSchema(c.env.db_boltlink);
	const smartReady = await ensureSmartRoutingCapability(c.env.db_boltlink);
	const hasSmartPayload = payload.smartRoutingRules !== undefined;
	if (hasSmartPayload && !smartReady) {
		return c.json({ error: SMART_ROUTING_MIGRATION_HINT }, 400);
	}

	const smartConfig = resolveSmartRoutingPayload(payload.smartRoutingRules);
	if (!smartConfig.ok) {
		return c.json({ error: smartConfig.error }, 400);
	}

	const expiredReady = await ensureExpiredRedirectCapability(c.env.db_boltlink);
	const hasExpiredPayload = payload.expiredRedirectUrl !== undefined;
	if (hasExpiredPayload && !expiredReady) {
		return c.json({ error: EXPIRED_REDIRECT_MIGRATION_HINT }, 400);
	}

	const expiredRedirect = resolveExpiredRedirectUrl(payload.expiredRedirectUrl);
	if (!expiredRedirect.ok) {
		return c.json({ error: expiredRedirect.error }, 400);
	}

	// Final-state invariant: a freshly created row has no other source for
	// `expires_at`, so the payload alone decides whether the destination is dormant.
	if (expiredRedirect.value !== null && !expiresAt) {
		return c.json({ error: EXPIRED_REDIRECT_REQUIRES_EXPIRATION }, 400);
	}

	if (!schema.abReady && (payload.abEnabled !== undefined || payload.abTargetUrl !== undefined || payload.abWeightB !== undefined)) {
		return c.json({ error: "A/B testing requires migration 0004_ab_testing.sql to be applied" }, 400);
	}

	const abConfig = resolveAbConfig(payload, null);
	if (!abConfig.ok) {
		return c.json({ error: abConfig.error }, 400);
	}
	if (abConfig.enabled && redirectType === "301") {
		return c.json({ error: "A/B testing requires a temporary redirect (302)" }, 400);
	}
	if (smartConfig.configured && abConfig.enabled) {
		return c.json({ error: "A/B testing and Smart Routing are mutually exclusive" }, 400);
	}
	if (smartConfig.configured && redirectType === "301") {
		return c.json({ error: "Smart Routing requires a temporary redirect (302)" }, 400);
	}

	const requestedSlug = payload.slug?.trim();
	let slug = requestedSlug ?? "";

	if (requestedSlug) {
		const slugError = validateSlug(requestedSlug);
		if (slugError) {
			return c.json({ error: slugError }, 400);
		}

		if (await slugExists(c.env.db_boltlink, requestedSlug)) {
			return c.json({ error: "Slug already exists" }, 409);
		}

		slug = requestedSlug;
	} else {
		slug = await generateUniqueSlug(c.env.db_boltlink);
	}

	const abStartedAt = abConfig.enabled ? isoNow() : null;
	const smartColumns = smartReady ? ", smart_routing_rules" : "";
	const smartPlaceholders = smartReady ? ", ?" : "";
	const smartReturning = smartReady ? ", smart_routing_rules" : "";
	const smartValue = smartConfig.serialized;
	const expiredColumns = expiredReady ? ", expired_redirect_url" : "";
	const expiredPlaceholders = expiredReady ? ", ?" : "";
	const expiredReturning = expiredReady ? ", expired_redirect_url" : "";

	const createdLink = schema.abReady
		? await c.env.db_boltlink
			.prepare(
				`INSERT INTO links (
					slug,
					target_url,
					expires_at,
					go_live_at,
					redirect_type,
					tags,
					group_id,
					password_hash,
					ab_enabled,
					ab_target_url,
					ab_weight_b,
					ab_generation,
					ab_started_at${smartColumns}${expiredColumns}
				)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${smartPlaceholders}${expiredPlaceholders})
				RETURNING
					id,
					slug,
					target_url,
					clicks_total,
					created_at,
					updated_at,
					disabled_at,
					expires_at,
					go_live_at,
					redirect_type,
					tags,
					has_qrcode,
					group_id,
					CASE WHEN password_hash IS NOT NULL THEN 1 ELSE 0 END AS has_password,
					ab_enabled,
					ab_target_url,
					ab_weight_b,
					ab_generation,
					metric_epoch,
					ab_clicks_a,
					ab_clicks_b,
					ab_started_at${smartReturning}${expiredReturning},
					version`,
			)
			.bind(
				slug,
				targetUrl,
				expiresAt,
				goLiveAt,
				redirectType,
				tags,
				groupId ?? null,
				passwordHash,
				abConfig.enabled ? 1 : 0,
				abConfig.targetUrl,
				abConfig.weightB,
				abConfig.enabled ? 1 : 0,
				abStartedAt,
				...(smartReady ? [smartValue] : []),
				...(expiredReady ? [expiredRedirect.value] : []),
			)
			.first<LinkRow>()
		: await c.env.db_boltlink
			.prepare(
				`INSERT INTO links (
					slug,
					target_url,
					expires_at,
					go_live_at,
					redirect_type,
					tags,
					group_id,
					password_hash${smartColumns}${expiredColumns}
				)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?${smartPlaceholders}${expiredPlaceholders})
				RETURNING
					id,
					slug,
					target_url,
					clicks_total,
					created_at,
					updated_at,
					disabled_at,
					expires_at,
					go_live_at,
					redirect_type,
					tags,
					has_qrcode,
					group_id,
					CASE WHEN password_hash IS NOT NULL THEN 1 ELSE 0 END AS has_password${smartReturning}${expiredReturning},
					version`,
			)
			.bind(
				slug,
				targetUrl,
				expiresAt,
				goLiveAt,
				redirectType,
				tags,
				groupId ?? null,
				passwordHash,
				...(smartReady ? [smartValue] : []),
				...(expiredReady ? [expiredRedirect.value] : []),
			)
			.first<LinkRow>();

	return c.json({ link: createdLink ? exposeLinkRow(createdLink) : createdLink }, 201);
});

app.patch("/api/links/:slug", updateLink);
app.put("/api/links/:slug", updateLink);

app.delete("/api/links/:slug", async (c) => {
	const slug = c.req.param("slug");
	if (isReservedSlug(slug)) {
		return c.json({ error: "Reserved slug cannot be deleted" }, 400);
	}

	const now = isoNow();
	const deletedLink = await c.env.db_boltlink
		.prepare(
			`UPDATE links
			SET disabled_at = ?, updated_at = ?, version = version + 1
			WHERE slug = ? AND disabled_at IS NULL
			RETURNING id, slug`,
		)
		.bind(now, now, slug)
		.first<{ id: number; slug: string }>();

	if (!deletedLink) {
		return c.json({ error: "Link not found" }, 404);
	}

	// The group is left alone. Removing or moving the last link never deletes a
	// group: it may still hold child groups or disabled links, and only the
	// operator, through a deliberate DELETE, decides that a group is gone.
	return c.json({ ok: true, slug: deletedLink.slug });
});

app.post("/api/links/:slug/reset-clicks", async (c) => {
	const slug = c.req.param("slug");
	if (isReservedSlug(slug)) {
		return c.json({ error: "Reserved slug cannot reset clicks" }, 400);
	}

	const schema = await ensureDatabaseSchema(c.env.db_boltlink);
	const now = isoNow();
	const resetLink = schema.abReady
		? await c.env.db_boltlink
			.prepare(
				`UPDATE links
				SET clicks_total = 0,
					ab_clicks_a = 0,
					ab_clicks_b = 0,
					ab_started_at = CASE WHEN ab_enabled = 1 THEN ? ELSE ab_started_at END,
					metric_epoch = metric_epoch + 1,
					ab_generation = ab_generation + 1,
					updated_at = ?,
					version = version + 1
				WHERE slug = ? AND disabled_at IS NULL
				RETURNING slug, clicks_total, ab_clicks_a, ab_clicks_b, ab_started_at`,
			)
			.bind(now, now, slug)
			.first<{ slug: string; clicks_total: number; ab_clicks_a: number; ab_clicks_b: number; ab_started_at: string | null }>()
		: await c.env.db_boltlink
			.prepare(
				`UPDATE links
				SET clicks_total = 0, updated_at = ?, version = version + 1
				WHERE slug = ? AND disabled_at IS NULL
				RETURNING slug, clicks_total`,
			)
			.bind(now, slug)
			.first<{ slug: string; clicks_total: number }>();

	if (!resetLink) {
		return c.json({ error: "Link not found" }, 404);
	}

	return c.json({ ok: true, link: resetLink });
});

app.post("/api/links/:slug/qrcode", async (c) => {
	const slug = c.req.param("slug");
	if (isReservedSlug(slug)) {
		return c.json({ error: "Reserved slug cannot be marked with a QR code" }, 400);
	}
	const now = isoNow();
	const updated = await c.env.db_boltlink
		.prepare(
			`UPDATE links
			SET has_qrcode = 1, updated_at = ?, version = version + 1
			WHERE slug = ? AND disabled_at IS NULL
			RETURNING slug, has_qrcode`,
		)
		.bind(now, slug)
		.first<{ slug: string; has_qrcode: number }>();

	if (!updated) {
		return c.json({ error: "Link not found" }, 404);
	}

	return c.json({ link: updated });
});

app.get("/api/links/:slug/qrcode", async (c) => {
	const slug = c.req.param("slug");
	if (isReservedSlug(slug)) {
		return c.json({ error: "Reserved slug cannot generate a QR code" }, 400);
	}
	const link = await c.env.db_boltlink
		.prepare("SELECT slug FROM links WHERE slug = ? AND disabled_at IS NULL")
		.bind(slug)
		.first<{ slug: string }>();

	if (!link) {
		return c.json({ error: "Link not found" }, 404);
	}

	const shortUrl = new URL(`/${link.slug}`, c.req.url).toString();
	let svg: string;
	try {
		// The SVG carries an explicit intrinsic size so the browser can rasterize it into
		// the PNG the operator downloads instead of guessing one from the viewBox alone.
		svg = await QRCode.toString(shortUrl, {
			type: "svg",
			margin: 2,
			errorCorrectionLevel: "M",
			width: 512,
		});
	} catch {
		// A generation failure must surface as a controlled API error, never as a raw
		// Worker exception with stack details.
		return c.json({ error: "QR code generation failed" }, 500);
	}

	return new Response(svg, {
		status: 200,
		headers: {
			"Content-Type": "image/svg+xml; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
});

app.post("/api/links/:slug/duplicate", async (c) => {
	const slug = c.req.param("slug");
	const schema = await ensureDatabaseSchema(c.env.db_boltlink);
	const smartReady = await ensureSmartRoutingCapability(c.env.db_boltlink);
	const expiredReady = await ensureExpiredRedirectCapability(c.env.db_boltlink);
	const abSelect = schema.abReady ? ", ab_enabled, ab_target_url, ab_weight_b" : "";
	const smartSelect = smartReady ? ", smart_routing_rules" : "";
	const source = await c.env.db_boltlink
		.prepare(
			`SELECT target_url, redirect_type, tags, group_id${abSelect}${smartSelect}
			FROM links
			WHERE slug = ? AND disabled_at IS NULL`,
		)
		.bind(slug)
		.first<{
			target_url: string;
			redirect_type: "301" | "302";
			tags: string | null;
			group_id: number | null;
			ab_enabled?: number;
			ab_target_url?: string | null;
			ab_weight_b?: number;
			smart_routing_rules?: string | null;
		}>();

	if (!source) {
		return c.json({ error: "Link not found" }, 404);
	}

	const abEnabled = schema.abReady && source.ab_enabled === 1 && Boolean(source.ab_target_url);
	const copiedSmartRules = smartReady ? copyPersistedSmartRoutingRules(source.smart_routing_rules ?? null) : null;
	// Duplicate is not exempt from the administrative invariant: never create a
	// row that is simultaneously A/B-active and Smart-Routing-configured. The
	// source is left untouched; the operator must resolve it explicitly.
	if (abEnabled && copiedSmartRules !== null) {
		return c.json({ error: "Source link has incompatible routing configuration" }, 409);
	}
	const redirectType = abEnabled || copiedSmartRules ? "302" : source.redirect_type;
	const smartColumns = smartReady ? ", smart_routing_rules" : "";
	const smartPlaceholders = smartReady ? ", ?" : "";
	const smartReturning = smartReady ? ", smart_routing_rules" : "";
	const expiredReturning = expiredReady ? ", expired_redirect_url" : "";
	// Closed decision: a duplicate is born active, so it never inherits the
	// lifecycle configuration. Copying `expired_redirect_url` without `expires_at`
	// would persist a dormant destination and break the final-state invariant, so
	// the source value is not copied and the source row stays untouched.
	const duplicateSlug = await suggestDuplicateSlug(c.env.db_boltlink, slug);
	const created = schema.abReady
		? await c.env.db_boltlink
			.prepare(
				`INSERT INTO links (slug, target_url, redirect_type, tags, group_id, ab_enabled, ab_target_url, ab_weight_b, ab_generation, ab_started_at${smartColumns})
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?${smartPlaceholders})
				RETURNING id, slug, target_url, clicks_total, created_at, updated_at, disabled_at,
					expires_at, go_live_at, redirect_type, tags, has_qrcode, group_id,
					CASE WHEN password_hash IS NOT NULL THEN 1 ELSE 0 END AS has_password,
					ab_enabled, ab_target_url, ab_weight_b, ab_generation, metric_epoch, ab_clicks_a, ab_clicks_b, ab_started_at${smartReturning}${expiredReturning}, version`,
			)
			.bind(
				duplicateSlug,
				source.target_url,
				redirectType,
				source.tags,
				source.group_id,
				abEnabled ? 1 : 0,
				source.ab_target_url ?? null,
				source.ab_weight_b ?? DEFAULT_AB_WEIGHT_B,
				abEnabled ? 1 : 0,
				abEnabled ? isoNow() : null,
				...(smartReady ? [copiedSmartRules] : []),
			)
			.first<LinkRow>()
		: await c.env.db_boltlink
			.prepare(
				`INSERT INTO links (slug, target_url, redirect_type, tags, group_id${smartColumns})
				VALUES (?, ?, ?, ?, ?${smartPlaceholders})
				RETURNING id, slug, target_url, clicks_total, created_at, updated_at, disabled_at,
					expires_at, go_live_at, redirect_type, tags, has_qrcode, group_id,
					CASE WHEN password_hash IS NOT NULL THEN 1 ELSE 0 END AS has_password${smartReturning}${expiredReturning}, version`,
			)
			.bind(
				duplicateSlug,
				source.target_url,
				redirectType,
				source.tags,
				source.group_id,
				...(smartReady ? [copiedSmartRules] : []),
			)
			.first<LinkRow>();

	return c.json({ link: created ? exposeLinkRow(created) : created }, 201);
});

app.get("/api/groups", async (c) => {
	const groups = await c.env.db_boltlink
		.prepare("SELECT id, name, parent_id, created_at FROM link_groups ORDER BY name COLLATE NOCASE ASC")
		.all<LinkGroupRow>();

	const rows = groups.results ?? [];
	// The response stays flat with `parent_id`: the Admin assembles the tree. A
	// graph the reader cannot interpret is refused whole, never partially rendered
	// and never silently repaired into roots.
	if (!analyzeGroupHierarchy(rows).ok) {
		return c.json({ error: GROUP_HIERARCHY_CORRUPT_MESSAGE }, 409);
	}

	return c.json({ groups: rows });
});

app.post("/api/groups", async (c) => {
	const payload = await parseJsonBody<{ name?: string; parentId?: number | null }>(c);
	// The name contract lives in `group-hierarchy` so the export validates against
	// exactly the rule this path applies, instead of keeping a second copy.
	const name = normalizeGroupName(payload?.name);
	if (name === null) {
		return c.json({ error: "Group name is required" }, 400);
	}

	const parentId = normalizeGroupId(payload?.parentId);
	if (payload?.parentId !== undefined && parentId === undefined) {
		return c.json({ error: "Invalid parentId" }, 400);
	}

	if (parentId !== null && parentId !== undefined) {
		// A requested parent must exist, and the graph must be interpretable. Both
		// are preconditions of *describing* the write, and both are re-decided by the
		// guarded insert below: a parent deleted after this read makes that statement
		// match nothing instead of reaching the foreign key, and a parent moved
		// meanwhile cannot produce a group past the depth ceiling. This read is
		// therefore never the authority for integrity, only the fast path that keeps
		// the common rejection cheap.
		const rows = await readGroupRows(c.env.db_boltlink);
		if (!rows.some((row) => row.id === parentId)) {
			return c.json({ error: "Parent group not found" }, 404);
		}
		if (!analyzeGroupHierarchy(rows).ok) {
			return c.json({ error: GROUP_HIERARCHY_CORRUPT_MESSAGE }, 409);
		}
	}

	const created = await c.env.db_boltlink
		.prepare(GROUP_INSERT_SQL)
		.bind(...groupInsertBindings(name, parentId ?? null))
		.first<LinkGroupRow>();

	if (!created) {
		// The guarded insert refused. Which condition it was is decided read-only,
		// never by a second attempt.
		const failure = await classifyGroupInsertFailure(c.env.db_boltlink, parentId ?? null);
		return c.json({ error: failure.error }, failure.status);
	}

	return c.json({ group: created }, 201);
});

app.patch("/api/groups/:id", async (c) => {
	const id = Number.parseInt(c.req.param("id"), 10);
	if (Number.isNaN(id) || id <= 0) {
		return c.json({ error: "Invalid group id" }, 400);
	}

	const payload = await parseJsonBody<{ name?: string; parentId?: number | null; expectedParentId?: number | null }>(c);
	if (!payload) {
		return c.json({ error: "Invalid JSON body" }, 400);
	}

	let name: string | null = null;
	if (payload.name !== undefined) {
		const normalizedName = normalizeGroupName(payload.name);
		if (normalizedName === null) {
			return c.json({ error: "Group name cannot be empty" }, 400);
		}
		name = normalizedName;
	}

	if (payload.parentId === undefined) {
		// Rename only. Simultaneous renames stay last-write-wins: Gate 5.1 adds no
		// version column to groups, so this path keeps the existing behaviour rather
		// than inventing optimistic locking the tree does not need.
		if (name === null) {
			return c.json({ error: "No updatable fields provided" }, 400);
		}

		const renamed = await c.env.db_boltlink
			.prepare("UPDATE link_groups SET name = ? WHERE id = ? RETURNING id, name, parent_id, created_at")
			.bind(name, id)
			.first<LinkGroupRow>();

		if (!renamed) {
			return c.json({ error: "Group not found" }, 404);
		}

		return c.json({ group: renamed });
	}

	const targetParentId = normalizeGroupId(payload.parentId);
	if (targetParentId === undefined) {
		return c.json({ error: "Invalid parentId" }, 400);
	}
	if (targetParentId === id) {
		// Equality on the request, not a graph read: this creates no TOCTOU window
		// and gives self-parenting its own explicit answer.
		return c.json({ error: GROUP_SELF_PARENT_MESSAGE }, 409);
	}
	if (payload.expectedParentId === undefined) {
		return c.json({ error: GROUP_PARENT_REQUIRED_MESSAGE }, 400);
	}
	const expectedParentId = normalizeGroupId(payload.expectedParentId);
	if (expectedParentId === undefined) {
		return c.json({ error: "Invalid expectedParentId" }, 400);
	}

	// Every move interprets the tree, so a corrupt graph fails closed before the
	// statement is attempted.
	const rows = await readGroupRows(c.env.db_boltlink);
	if (targetParentId !== null && !rows.some((row) => row.id === targetParentId)) {
		return c.json({ error: "Parent group not found" }, 404);
	}
	if (!analyzeGroupHierarchy(rows).ok) {
		return c.json({ error: GROUP_HIERARCHY_CORRUPT_MESSAGE }, 409);
	}

	// One statement: cycle refusal, observed-parent precondition and write are a
	// single atomic unit, so no concurrent move can be silently overwritten.
	const moved = await c.env.db_boltlink
		.prepare(GROUP_MOVE_SQL)
		.bind(...groupMoveBindings(id, targetParentId, expectedParentId, name))
		.first<LinkGroupRow>();

	if (!moved) {
		const failure = await classifyGroupMoveFailure(c.env.db_boltlink, id, targetParentId, expectedParentId);
		return c.json({ error: failure.error }, failure.status);
	}

	return c.json({ group: moved });
});

app.delete("/api/groups/:id", async (c) => {
	const id = Number.parseInt(c.req.param("id"), 10);
	if (Number.isNaN(id) || id <= 0) {
		return c.json({ error: "Invalid group id" }, 400);
	}

	// One conditional statement: a group cannot lose its last child or its last
	// link between the check and the removal, because there is no earlier check.
	const deleted = await c.env.db_boltlink
		.prepare(GROUP_DELETE_SQL)
		.bind(...groupDeleteBindings(id))
		.first<{ id: number; name: string }>();

	if (deleted) {
		return c.json({ ok: true });
	}

	const usage = await c.env.db_boltlink
		.prepare(
			`SELECT
				(SELECT COUNT(1) FROM link_groups AS child WHERE child.parent_id = ?) AS children,
				(SELECT COUNT(1) FROM links AS link WHERE link.group_id = ?) AS links,
				(SELECT COUNT(1) FROM link_groups AS self WHERE self.id = ?) AS present`,
		)
		.bind(id, id, id)
		.first<{ children: number; links: number; present: number }>();

	// Read only to explain an already-refused removal, never to authorize it.
	if (!usage?.present) {
		return c.json({ error: "Group not found" }, 404);
	}
	if (usage.children > 0) {
		return c.json({ error: GROUP_HAS_CHILDREN_MESSAGE }, 409);
	}
	if (usage.links > 0) {
		return c.json({ error: GROUP_HAS_LINKS_MESSAGE }, 409);
	}

	return c.json({ error: "Group could not be removed" }, 409);
});

/**
 * Portability export (published in 3.0.0; origin Phase 5, Gate 5.2).
 *
 * Administrative, on demand and read-only: it is protected by the same boundary as
 * every other `/api` route (`requireAdmin` plus Cloudflare Access, with the API key
 * as the existing alternative) and shares the existing administrative rate limiter.
 * There is no parallel authentication and no dedicated limiter.
 *
 * The artifact is the logical configuration, not a database backup: hashes, metrics
 * and internal identifiers are excluded by projection, not by filtering afterwards.
 * The `password_hash` column is never selected — the statement computes a boolean —
 * so the hash cannot leak through a later mistake in the serializer.
 *
 * Reads are ordered groups-then-links and the document is only emitted when every
 * `groupRef` and `parentRef` resolves inside that snapshot. A group created, moved or
 * removed meanwhile therefore produces a controlled `409`, never a document with
 * dangling references. No snapshot isolation is claimed; internal consistency is
 * enforced by validation. Zero writes: no `version`, timestamp, counter, epoch or
 * audit table is touched — and the *whole request* is read-only, `GET /api/export`
 * included the middleware stack, which is why this route validates the schema with
 * the read-only readiness instead of the bootstrapping one that installs the metric
 * fence projection.
 */
app.get("/api/export", async (c) => {
	const schema = await inspectDatabaseSchema(c.env.db_boltlink);
	const smartRouting = await resolveSmartRoutingCapability(c.env.db_boltlink, schema);
	const expiredRedirect = await resolveExpiredRedirectCapability(c.env.db_boltlink, schema);

	// Cheap pre-count so an oversized instance is refused before its rows are loaded.
	const counts = await c.env.db_boltlink
		.prepare("SELECT (SELECT COUNT(1) FROM link_groups) AS groups, (SELECT COUNT(1) FROM links) AS links")
		.first<{ groups: number; links: number }>();

	const abColumns = schema.abReady ? ", ab_enabled, ab_target_url, ab_weight_b" : "";
	const smartColumn = smartRouting ? ", smart_routing_rules" : "";
	const expiredColumn = expiredRedirect ? ", expired_redirect_url" : "";

	// Both statements are explicit projections: `GET /api/links` is not reused as the
	// read model, because that listing filters tombstones out and caps itself at 100
	// rows. GROUP BY nothing and no LIMIT here — the export either carries everything
	// or refuses.
	const [groupResult, linkResult] = await c.env.db_boltlink.batch<unknown>([
		c.env.db_boltlink.prepare(
			"SELECT id, name, parent_id FROM link_groups ORDER BY name COLLATE NOCASE ASC, id ASC",
		),
		c.env.db_boltlink.prepare(`SELECT
				slug,
				target_url,
				redirect_type,
				tags,
				group_id,
				disabled_at,
				go_live_at,
				expires_at,
				CASE WHEN password_hash IS NOT NULL THEN 1 ELSE 0 END AS has_password${abColumns}${smartColumn}${expiredColumn}
			FROM links
			ORDER BY slug ASC`),
	]);

	const exported = buildPortabilityExport({
		counts: { groups: counts?.groups ?? 0, links: counts?.links ?? 0 },
		groups: (groupResult.results ?? []) as PortabilityGroupRow[],
		links: (linkResult.results ?? []) as PortabilityLinkRow[],
		capabilities: { abTesting: schema.abReady, smartRouting, expiredRedirect },
		// The runtime's own validators are the authority for what BoltLink accepts, so
		// the export cannot drift from the write paths it has to match.
		policy: { isValidSlug: (slug: string) => validateSlug(slug) === null, normalizeUrl: normalizeTargetUrl },
		exportedAt: isoNow(),
	});

	if (!exported.ok) {
		// Controlled message: no raw SQL, no SQLite error, no stack and no stored value.
		return c.json({ error: exported.error }, exported.status);
	}

	return new Response(exported.body, {
		status: 200,
		headers: {
			"Content-Type": "application/json",
			// Also set by the global header middleware for `/api/*`; repeated here so the
			// export contract holds on its own.
			"Cache-Control": "no-store",
			// Static, constant filename: no persisted or request value can reach it.
			"Content-Disposition": `attachment; filename="${PORTABILITY_EXPORT_FILENAME}"`,
		},
	});
});

/**
 * Portability import (published in 3.0.0; origin Phase 5, Gate 5.3).
 *
 * The counterpart of the export, on the same administrative boundary: `requireAdmin`
 * plus Cloudflare Access, with the API key as the existing alternative, and the shared
 * administrative rate limiter. There is no parallel authentication and no public route.
 *
 * The two endpoints exist because the operation has two steps with different
 * consequences. `preview` answers "what would this file create, and can it be applied
 * here?" and is *read-only in the whole request* — it validates, measures, checks the
 * destination and reports, and never writes a row or a schema object. `apply` writes
 * nothing until every one of those checks has been repeated from scratch, because a
 * preview is a description of an intent the operator saw, never an authorization: there
 * is no plan id, no token and no server-side session to trust, so the browser's state is
 * worth exactly nothing here.
 *
 * The format is the export's own artifact and nothing else: no second schema, no
 * coercion, no repair. What the document cannot carry (hashes, metrics, internal ids and
 * timestamps) the destination generates, exactly as if an operator had typed the
 * configuration into the Admin.
 */
app.post("/api/import/preview", async (c) => {
	const envelope = await readPortabilityImportEnvelope(c);
	if (!envelope.ok) {
		return respondPortabilityImportRefusal(c, envelope.refusal);
	}

	const parsed = parsePortabilityImportDocument(envelope.envelope.document, portabilityImportPolicy());
	if (!parsed.ok) {
		return respondPortabilityImportRefusal(c, parsed);
	}

	const destination = await readPortabilityImportDestination(c.env.db_boltlink, parsed.plan);
	const blockers = findPortabilityImportBlockers({
		plan: parsed.plan,
		capabilities: destination.capabilities,
		conflicts: destination.conflicts,
		destinationHierarchyValid: destination.hierarchyValid,
		destinationGroupReferencesValid: destination.groupReferencesValid,
		passwordSecretConfigured: hasConfiguredPasswordSessionSecret(c.env),
	});

	if (blockers.length > 0) {
		return respondPortabilityImportBlocked(c, parsed.plan, destination.conflicts, blockers);
	}

	return c.json(
		{
			ok: true,
			summary: parsed.plan.summary,
			conflicts: [],
			requiresPasswords: parsed.plan.protectedSlugs.map((slug) => ({ slug })),
			warnings: PORTABILITY_IMPORT_WARNINGS,
		},
		200,
		{ "Cache-Control": "no-store" },
	);
});

app.post("/api/import/apply", async (c) => {
	const envelope = await readPortabilityImportEnvelope(c);
	if (!envelope.ok) {
		return respondPortabilityImportRefusal(c, envelope.refusal);
	}

	const parsed = parsePortabilityImportDocument(envelope.envelope.document, portabilityImportPolicy());
	if (!parsed.ok) {
		return respondPortabilityImportRefusal(c, parsed);
	}

	const plan = parsed.plan;
	const destination = await readPortabilityImportDestination(c.env.db_boltlink, plan);
	const blockers = findPortabilityImportBlockers({
		plan,
		capabilities: destination.capabilities,
		conflicts: destination.conflicts,
		destinationHierarchyValid: destination.hierarchyValid,
		destinationGroupReferencesValid: destination.groupReferencesValid,
		passwordSecretConfigured: hasConfiguredPasswordSessionSecret(c.env),
	});

	if (blockers.length > 0) {
		return respondPortabilityImportBlocked(c, plan, destination.conflicts, blockers);
	}

	// Passwords are validated as a strict mapping and hashed before anything is built:
	// no plaintext is ever persisted, logged, echoed or placed in an error message.
	const passwords = resolvePortabilityImportPasswords(plan, envelope.envelope.replacementPasswords);
	if (!passwords.ok) {
		return respondPortabilityImportRefusal(c, passwords.refusal);
	}

	const passwordHashes = new Map<string, string>();
	for (const [slug, value] of passwords.values) {
		passwordHashes.set(slug, await hashPassword(value) ?? "");
	}

	const statements = buildPortabilityImportStatements({
		plan,
		capabilities: destination.capabilities,
		passwordHashes,
		now: isoNow(),
	});

	try {
		await c.env.db_boltlink.batch(
			statements.map((statement) => c.env.db_boltlink.prepare(statement.sql).bind(...statement.bindings)),
		);
	} catch (error) {
		// A batch is one SQL transaction: the failing statement aborts the sequence, so
		// the destination is exactly as it was, however far the import had progressed.
		console.error("Portability import batch failed", error instanceof Error ? error.message : String(error));

		// The one failure with a meaningful explanation is the slug reservation, and it has
		// to *be* that failure: the error names the constraint SQLite refused. Anything else
		// stays an unexpected server error — reading the destination afterwards would find a
		// conflicting slug in any installation that already holds one of the document's
		// slugs, and would report an unrelated defect as a collision.
		if (!isPortabilityImportSlugCollisionError(error)) {
			return c.json({ error: "Import could not be completed" }, 500, { "Cache-Control": "no-store" });
		}

		// Read only to say *which* slugs the transaction tripped over, never to decide that
		// it tripped over a slug at all: the error already said so.
		const lateConflicts = await findPortabilityImportSlugConflicts(c.env.db_boltlink, plan.links.map((link) => link.slug));
		return respondPortabilityImportBlocked(c, plan, lateConflicts, ["SLUG_COLLISION"]);
	}

	return c.json(
		{ ok: true, groupsCreated: plan.groups.length, linksCreated: plan.links.length },
		200,
		{ "Cache-Control": "no-store" },
	);
});

app.get("/api/preview", async (c) => {
	const rawUrl = c.req.query("url")?.trim();
	const normalized = normalizeTargetUrl(rawUrl);
	if (!normalized) {
		return c.json({ error: "Invalid target URL" }, 400);
	}

	try {
		const response = await fetch(normalized, {
			method: "GET",
			headers: {
				"User-Agent": `BoltLinkPreview/${APP_VERSION}`,
				Accept: "text/html,application/xhtml+xml",
			},
		});

		if (!response.ok) {
			return c.json({ preview: { url: normalized, domain: new URL(normalized).hostname } });
		}

		const contentType = response.headers.get("content-type") ?? "";
		if (!contentType.includes("text/html")) {
			return c.json({ preview: { url: normalized, domain: new URL(normalized).hostname } });
		}

		const html = (await response.text()).slice(0, 150_000);
		const preview = extractPreviewMetadata(html, normalized);
		return c.json({ preview });
	} catch {
		return c.json({ preview: { url: normalized, domain: new URL(normalized).hostname } });
	}
});

app.get("/:slug", async (c) => {
	const slug = c.req.param("slug");
	if (!isPublicSlugCandidate(slug)) {
		return c.notFound();
	}

	if (!(await consumePublicRedirectBudget(c.req.raw))) {
		return c.text("Too many requests", 429);
	}

	await ensurePreparedDatabase(c.env.db_boltlink);

	const link = await c.env.db_boltlink.prepare(PUBLIC_REDIRECT_SQL).bind(slug).first<RedirectRow>();

	if (!link) {
		return c.notFound();
	}

	if (link.go_live_at && new Date(link.go_live_at).getTime() > Date.now()) {
		return c.notFound();
	}

	if (link.expires_at && new Date(link.expires_at).getTime() <= Date.now()) {
		const capabilities = readPublicRowCapabilities(link);
		return respondExpiredLifecycle(c, resolveExpiredLifecycle(link, capabilities, c.req.raw));
	}

	if (link.password_hash) {
		if (!hasConfiguredPasswordSessionSecret(c.env)) {
			return c.text("Password protection is unavailable", 503);
		}
		if (!(await hasValidPasswordSession(c.req.raw, c.env, link.slug))) {
			return c.html(renderPasswordGate(link.slug));
		}
	}

	const capabilities = readPublicRowCapabilities(link);
	const countable = isCountableClick(c.req.raw);
	const decision = resolvePublicRedirectDecision(link, capabilities, countable, c.req.raw);
	const response = c.redirect(decision.destination, decision.status);
	if (decision.noStore) {
		response.headers.set("Cache-Control", "no-store");
	}

	if (countable) {
		c.executionCtx.waitUntil(recordClick(c.env.db_boltlink, link.id, {
			variant: decision.variant,
			generation: link.ab_generation ?? 0,
			epoch: capabilities.abReady ? (link.metric_epoch ?? 0) : null,
		}));
	}

	return response;
});

app.post("/:slug", async (c) => {
	const slug = c.req.param("slug");
	if (!isPublicSlugCandidate(slug)) {
		return c.notFound();
	}

	if (!(await consumePublicRedirectBudget(c.req.raw))) {
		return c.text("Too many requests", 429);
	}

	await ensurePreparedDatabase(c.env.db_boltlink);

	const link = await c.env.db_boltlink.prepare(PUBLIC_REDIRECT_SQL).bind(slug).first<RedirectRow>();

	if (!link) {
		return c.notFound();
	}

	if (link.go_live_at && new Date(link.go_live_at).getTime() > Date.now()) {
		return c.notFound();
	}

	if (link.expires_at && new Date(link.expires_at).getTime() <= Date.now()) {
		const expiredCapabilities = readPublicRowCapabilities(link);
		return respondExpiredLifecycle(c, resolveExpiredLifecycle(link, expiredCapabilities, c.req.raw));
	}

	const capabilities = readPublicRowCapabilities(link);

	if (!link.password_hash) {
		// This legacy POST path never counts a click and never chooses a target.
		// It still refuses a permanent redirect when a dynamic configuration is
		// present, matching the GET fail-safe for corrupted rows.
		const smartRoutingConfigured = capabilities.smartRoutingReady && (link.smart_routing_rules ?? null) !== null;
		const activeAb = capabilities.abReady && isActiveAbLink(link);
		const status = smartRoutingConfigured || activeAb ? 302 : Number.parseInt(link.redirect_type, 10) === 301 ? 301 : 302;
		const response = c.redirect(link.target_url, status);
		if (smartRoutingConfigured || activeAb) {
			response.headers.set("Cache-Control", "no-store");
		}
		return response;
	}

	if (!hasConfiguredPasswordSessionSecret(c.env)) {
		return c.text("Password protection is unavailable", 503);
	}

	if (!(await consumePasswordAttempt(slug, c.req.raw.headers.get("CF-Connecting-IP")))) {
		return c.text("Too many attempts. Try again in 1 minute.", 429);
	}

	const form = await c.req.raw.formData().catch(() => null);
	const candidate = String(form?.get("password") ?? "");
	if (!(await verifyPassword(candidate, link.password_hash))) {
		return c.html(renderPasswordGate(link.slug, "Senha inválida."), 401);
	}

	const countable = isCountablePasswordSubmission(c.req.raw);
	const decision = resolvePublicRedirectDecision(link, capabilities, countable, c.req.raw);
	const token = await createPasswordSessionToken(c.env, link.slug);
	const response = c.redirect(decision.destination, decision.status);
	if (decision.noStore) {
		response.headers.set("Cache-Control", "no-store");
	}
	const cookieSecure = new URL(c.req.url).protocol === "https:" ? "; Secure" : "";
	response.headers.append(
		"Set-Cookie",
		`${passwordCookieName(link.slug)}=${token}; Path=/${slug}; HttpOnly; SameSite=Lax; Max-Age=${PASSWORD_SESSION_MAX_AGE_SECONDS}${cookieSecure}`,
	);

	if (countable) {
		c.executionCtx.waitUntil(recordClick(c.env.db_boltlink, link.id, {
			variant: decision.variant,
			generation: link.ab_generation ?? 0,
			epoch: capabilities.abReady ? (link.metric_epoch ?? 0) : null,
		}));
	}

	return response;
});

async function updateLink(c: Context<AppContext>) {
	const slug = c.req.param("slug");
	if (!slug) {
		return c.json({ error: "Missing slug" }, 400);
	}

	if (isReservedSlug(slug)) {
		return c.json({ error: "Reserved slug cannot be updated" }, 400);
	}

	const payload = await parseJsonBody<UpdateLinkPayload>(c);
	if (!payload) {
		return c.json({ error: "Invalid JSON body" }, 400);
	}

	if (payload.slug && payload.slug !== slug) {
		return c.json({ error: "Slug is immutable after creation" }, 400);
	}

	const schema = await ensureDatabaseSchema(c.env.db_boltlink);
	const hasSmartPayload = payload.smartRoutingRules !== undefined;
	const smartReady = await ensureSmartRoutingCapability(c.env.db_boltlink);
	if (hasSmartPayload && !smartReady) {
		return c.json({ error: SMART_ROUTING_MIGRATION_HINT }, 400);
	}

	const smartConfig = resolveSmartRoutingPayload(payload.smartRoutingRules);
	if (!smartConfig.ok) {
		return c.json({ error: smartConfig.error }, 400);
	}

	const expiredReady = await ensureExpiredRedirectCapability(c.env.db_boltlink);
	const hasExpiredPayload = payload.expiredRedirectUrl !== undefined;
	if (hasExpiredPayload && !expiredReady) {
		return c.json({ error: EXPIRED_REDIRECT_MIGRATION_HINT }, 400);
	}

	const expiredRedirect = resolveExpiredRedirectUrl(payload.expiredRedirectUrl);
	if (!expiredRedirect.ok) {
		return c.json({ error: expiredRedirect.error }, 400);
	}

	const hasAbPayload = payload.abEnabled !== undefined || payload.abTargetUrl !== undefined || payload.abWeightB !== undefined;
	if (!schema.abReady && hasAbPayload) {
		return c.json({ error: "A/B testing requires migration 0004_ab_testing.sql to be applied" }, 400);
	}

	const password = normalizePassword(payload.password);
	if (password.kind === "invalid") {
		return c.json({ error: "Invalid password. Provide a non-empty string or null" }, 400);
	}
	if (password.kind === "set" && !hasConfiguredPasswordSessionSecret(c.env)) {
		return c.json({ error: "PASSWORD_SESSION_SECRET is required to add password protection" }, 400);
	}

	const targetUrlInput = payload.targetUrl ?? payload.url;
	const targetUrl = targetUrlInput ? normalizeTargetUrl(targetUrlInput) : undefined;
	if (targetUrlInput && !targetUrl) {
		return c.json({ error: "Invalid target URL" }, 400);
	}

	const redirectType = payload.redirectType ? normalizeRedirectType(payload.redirectType) : undefined;
	if (payload.redirectType && !redirectType) {
		return c.json({ error: "Invalid redirect type. Use '301' or '302'" }, 400);
	}

	const tags = payload.tags !== undefined ? normalizeTags(payload.tags) : undefined;
	if (payload.tags !== undefined && tags === null) {
		return c.json({ error: "Invalid tags. Provide an array of strings" }, 400);
	}

	const appTimeZone = getAppTimeZone(c.env);
	const expiresAt = payload.expiresAt === null ? null : payload.expiresAt ? normalizeDateTime(payload.expiresAt, appTimeZone) : undefined;
	const goLiveAt = payload.goLiveAt === null ? null : payload.goLiveAt ? normalizeDateTime(payload.goLiveAt, appTimeZone) : undefined;
	if ((payload.expiresAt && expiresAt === null) || (payload.goLiveAt && goLiveAt === null)) {
		return c.json({ error: `Invalid date format. Use ISO-8601 or yyyy-MM-ddTHH:mm in timezone ${appTimeZone}` }, 400);
	}

	const groupId = payload.groupId !== undefined ? normalizeGroupId(payload.groupId) : undefined;
	if (payload.groupId !== undefined && groupId === undefined) {
		return c.json({ error: "Invalid groupId" }, 400);
	}

	if (groupId !== null && groupId !== undefined && !(await groupExists(c.env.db_boltlink, groupId))) {
		return c.json({ error: "Group not found" }, 404);
	}

	const abReadColumns = schema.abReady ? ", ab_enabled, ab_target_url, ab_weight_b, ab_generation, metric_epoch" : "";
	const smartReadColumns = smartReady ? ", smart_routing_rules" : "";
	const expiredReadColumns = expiredReady ? ", expired_redirect_url" : "";
	const existingLink = await c.env.db_boltlink
		.prepare(`SELECT target_url, group_id, expires_at, go_live_at, redirect_type, version${abReadColumns}${smartReadColumns}${expiredReadColumns} FROM links WHERE slug = ? AND disabled_at IS NULL`)
		.bind(slug)
		.first<{
			target_url: string;
			group_id: number | null;
			expires_at: string | null;
			go_live_at: string | null;
			redirect_type: "301" | "302";
			version: number;
			ab_enabled?: number;
			ab_target_url?: string | null;
			ab_weight_b?: number;
			ab_generation?: number;
			metric_epoch?: number;
			smart_routing_rules?: string | null;
			expired_redirect_url?: string | null;
		}>();

	if (!existingLink) {
		return c.json({ error: "Link not found" }, 404);
	}

	const existingAb: ExistingAbConfig | null = schema.abReady
		? {
			ab_enabled: existingLink.ab_enabled ?? 0,
			ab_target_url: existingLink.ab_target_url ?? null,
			ab_weight_b: existingLink.ab_weight_b ?? DEFAULT_AB_WEIGHT_B,
		}
		: null;

	const abConfig = resolveAbConfig(payload, existingAb);
	if (!abConfig.ok) {
		return c.json({ error: abConfig.error }, 400);
	}

	const finalRedirectType = redirectType ?? existingLink.redirect_type;
	if (abConfig.enabled && finalRedirectType === "301") {
		return c.json({ error: "A/B testing requires a temporary redirect (302)" }, 400);
	}

	// Final-state validation: Smart Routing and A/B are mutually exclusive, and
	// active Smart Routing requires a temporary redirect. Any non-null persisted
	// value counts as configured, even if corrupt, so a broken row cannot be
	// silently overwritten by enabling A/B on top of it.
	const existingSmartRaw = smartReady ? (existingLink.smart_routing_rules ?? null) : null;
	const finalSmartConfigured = hasSmartPayload ? smartConfig.configured : existingSmartRaw !== null;
	const finalSmartSerialized = hasSmartPayload ? smartConfig.serialized : existingSmartRaw;
	const existingSmartHybrid = schema.abReady && existingLink.ab_enabled === 1 && existingSmartRaw !== null;
	if (finalSmartConfigured && finalRedirectType === "301") {
		return c.json({ error: "Smart Routing requires a temporary redirect (302)" }, 400);
	}
	const abRoutingChanged =
		existingAb !== null &&
		hasEffectiveAbConfigurationChange(
			{ enabled: existingAb.ab_enabled === 1, targetUrl: existingAb.ab_target_url, weightB: existingAb.ab_weight_b },
			{ enabled: abConfig.enabled, targetUrl: abConfig.targetUrl, weightB: abConfig.weightB },
		);
	const smartRoutingChanged = hasSmartPayload && finalSmartSerialized !== existingSmartRaw;
	// The exclusivity check rejects a hybrid that the request would introduce or
	// rewrite. A row that is already hybrid and is being edited somewhere else
	// (tags, target, lifecycle) must stay accepted: refusing it would make the row
	// uneditable, and accepting it preserves the exact persisted bytes, so the
	// public fail-safe keeps working and no new hybrid is ever created. The
	// comparison is between the persisted values and the normalized final ones, so
	// the Admin re-sending identical A/B fields during an unrelated edit is not a
	// routing change; editing a routing value while the row stays hybrid is.
	if (abConfig.enabled && finalSmartConfigured && (!existingSmartHybrid || abRoutingChanged || smartRoutingChanged)) {
		return c.json({ error: "A/B testing and Smart Routing are mutually exclusive" }, 400);
	}

	const passwordHash = password.kind === "absent"
		? undefined
		: password.kind === "remove"
			? null
			: await hashPassword(password.value);

	if (
		(expiresAt || payload.expiresAt === null || goLiveAt || payload.goLiveAt === null)
	) {
		const finalExpires = expiresAt === undefined ? existingLink.expires_at : expiresAt;
		const finalGoLive = goLiveAt === undefined ? existingLink.go_live_at : goLiveAt;
		if (finalExpires && finalGoLive && new Date(finalExpires).getTime() < new Date(finalGoLive).getTime()) {
			return c.json({ error: "expiresAt cannot be earlier than goLiveAt" }, 400);
		}
	}

	// Final-state invariant for the expired destination: the row that would exist
	// after this request is what has to satisfy it, so clearing `expiresAt` while a
	// stored destination survives is refused, while clearing both in the same
	// request is a legitimate repair and is accepted.
	const finalExpiresAt = expiresAt === undefined ? existingLink.expires_at : expiresAt;
	const finalExpiredRedirectUrl = hasExpiredPayload
		? expiredRedirect.value
		: expiredReady
			? existingLink.expired_redirect_url ?? null
			: null;
	if (finalExpiredRedirectUrl !== null && finalExpiresAt === null) {
		return c.json({ error: EXPIRED_REDIRECT_REQUIRES_EXPIRATION }, 400);
	}

	const updates: string[] = [];
	const values: Array<string | number | null> = [];
	const now = isoNow();

	if (targetUrl !== undefined) {
		updates.push("target_url = ?");
		values.push(targetUrl);
	}
	if (redirectType !== undefined) {
		updates.push("redirect_type = ?");
		values.push(redirectType);
	}
	if (tags !== undefined) {
		updates.push("tags = ?");
		values.push(tags);
	}
	if (expiresAt !== undefined) {
		updates.push("expires_at = ?");
		values.push(expiresAt);
	}
	if (goLiveAt !== undefined) {
		updates.push("go_live_at = ?");
		values.push(goLiveAt);
	}
	if (groupId !== undefined) {
		updates.push("group_id = ?");
		values.push(groupId ?? null);
	}
	if (passwordHash !== undefined) {
		updates.push("password_hash = ?");
		values.push(passwordHash);
	}

	const abReset =
		schema.abReady &&
		abConfig.enabled &&
		(
			existingLink.ab_enabled !== 1 ||
			(targetUrl !== undefined && targetUrl !== existingLink.target_url) ||
			(payload.abTargetUrl !== undefined && abConfig.targetUrl !== (existingLink.ab_target_url ?? null)) ||
			(payload.abWeightB !== undefined && abConfig.weightB !== existingLink.ab_weight_b)
		);

	if (payload.abEnabled !== undefined) {
		updates.push("ab_enabled = ?");
		values.push(abConfig.enabled ? 1 : 0);
	}
	if (payload.abTargetUrl !== undefined) {
		updates.push("ab_target_url = ?");
		values.push(abConfig.targetUrl);
	}
	if (payload.abWeightB !== undefined) {
		updates.push("ab_weight_b = ?");
		values.push(abConfig.weightB);
	}
	if (abReset) {
		updates.push("ab_clicks_a = ?", "ab_clicks_b = ?", "ab_started_at = ?", "ab_generation = ab_generation + 1");
		values.push(0, 0, now);
	}
	if (hasSmartPayload) {
		updates.push("smart_routing_rules = ?");
		values.push(finalSmartSerialized);
	}
	if (hasExpiredPayload) {
		updates.push("expired_redirect_url = ?");
		values.push(expiredRedirect.value);
	}

	if (!updates.length) {
		return c.json({ error: "No updatable fields provided" }, 400);
	}

	updates.push("updated_at = ?", "version = version + 1");
	values.push(now);
	const abReturning = schema.abReady
		? `,
				ab_enabled,
				ab_target_url,
				ab_weight_b,
				ab_generation,
				metric_epoch,
				ab_clicks_a,
				ab_clicks_b,
				ab_started_at`
		: "";
	const smartReturning = smartReady ? ", smart_routing_rules" : "";
	const expiredReturning = expiredReady ? ", expired_redirect_url" : "";
	const updatedLink = await c.env.db_boltlink
		.prepare(
			`UPDATE links
			SET ${updates.join(", ")}
			WHERE slug = ? AND disabled_at IS NULL AND version = ?
			RETURNING
				id,
				slug,
				target_url,
				clicks_total,
				created_at,
				updated_at,
				disabled_at,
				expires_at,
				go_live_at,
				redirect_type,
				tags,
				has_qrcode,
				group_id,
				CASE WHEN password_hash IS NOT NULL THEN 1 ELSE 0 END AS has_password${abReturning}${smartReturning}${expiredReturning},
				version`,
		)
		.bind(...values, slug, existingLink.version)
		.first<LinkRow>();

	if (!updatedLink) {
		return c.json({ error: "Link was modified concurrently. Reload it and try again" }, 409);
	}

	// Moving this link away never removes the group it left behind, even when it
	// held nothing else. Groups outlive their links.
	return c.json({ link: updatedLink ? exposeLinkRow(updatedLink) : updatedLink });
}

async function serveAdminAsset(c: Context<AppContext>) {
	const assetUrl = new URL(c.req.url);
	assetUrl.pathname = "/admin.html";

	const response = await c.env.ASSETS.fetch(
		new Request(assetUrl.toString(), {
			method: "GET",
			headers: c.req.raw.headers,
		}),
	);

	if (response.status === 404) {
		return c.text("Admin UI not found", 404);
	}

	return applySecurityHeaders(response, c.req.path, c.req.url);
}

async function servePrivacyAsset(c: Context<AppContext>) {
	const assetUrl = new URL(c.req.url);
	assetUrl.pathname = "/privacidade.html";

	const response = await c.env.ASSETS.fetch(
		new Request(assetUrl.toString(), {
			method: "GET",
			headers: c.req.raw.headers,
		}),
	);

	if (response.status === 404) {
		return c.text("Privacy policy not found", 404);
	}

	return applySecurityHeaders(response, c.req.path, c.req.url);
}

function serveHealth(c: Context<AppContext>) {
	return c.json({ ok: true, service: "boltlink" });
}

/**
 * Validates that the database was prepared and installs the metric fence
 * projection, reusing the per-handle bootstrap promise when it already ran.
 * This is the whole public-redirect schema dependency: it runs no PRAGMA in
 * steady state and never reads a capability, because the public path derives
 * what exists from the row shape instead of from a cache.
 */
async function ensurePreparedDatabase(database: D1Database): Promise<void> {
	const cachedBootstrap = databaseSchemaBootstrap.get(database);
	if (cachedBootstrap) {
		await cachedBootstrap;
		return;
	}

	const bootstrap = initializeDatabaseSchema(database).catch((error) => {
		databaseSchemaBootstrap.delete(database);
		throw error;
	});
	databaseSchemaBootstrap.set(database, bootstrap);
	await bootstrap;
}

async function ensureDatabaseSchema(database: D1Database): Promise<SchemaCapabilities> {
	await ensurePreparedDatabase(database);
	return resolveSchemaCapabilities(database);
}

/**
 * Read-only counterpart of {@link ensureDatabaseSchema}, for the routes whose whole
 * request must not mutate the schema. It performs the same validation — the same
 * `sqlite_master` probe and the same required-column check, failing closed with `503`
 * when the database was never prepared — and reports the same capabilities, but it
 * never installs the metric fence projection.
 */
async function inspectDatabaseSchema(database: D1Database): Promise<SchemaCapabilities> {
	await ensureDatabaseValidated(database);
	return resolveSchemaCapabilities(database);
}

/**
 * Validates that the database was prepared, reusing the per-handle result when it
 * already ran. Read-only by construction: it calls {@link readInitializedLinkColumns}
 * and nothing else, so unlike {@link ensurePreparedDatabase} it cannot create a view.
 */
async function ensureDatabaseValidated(database: D1Database): Promise<void> {
	const cachedValidation = databaseSchemaValidated.get(database);
	if (cachedValidation) {
		await cachedValidation;
		return;
	}

	const validation = readInitializedLinkColumns(database).then(() => undefined).catch((error) => {
		databaseSchemaValidated.delete(database);
		throw error;
	});
	databaseSchemaValidated.set(database, validation);
	await validation;
}

/**
 * Capability resolution shared by both readiness levels, so the read-only route and
 * the bootstrapping one can never disagree about what the database supports. Positive
 * results are cached per handle; negative results are never cached, so a Worker started
 * before migration 0004 can discover the migration once it is applied. The same schema
 * read also classifies Smart Routing.
 */
async function resolveSchemaCapabilities(database: D1Database): Promise<SchemaCapabilities> {
	if (databaseAbReady.get(database)) {
		return {
			abReady: true,
			smartRoutingReady: databaseSmartRoutingReady.get(database) === true,
			expiredRedirectReady: databaseExpiredRedirectReady.get(database) === true,
		};
	}

	const capabilities = await detectSchemaCapabilities(database);
	if (capabilities.abReady) {
		databaseAbReady.set(database, true);
	}
	return capabilities;
}

type SchemaCapabilities = {
	abReady: boolean;
	smartRoutingReady: boolean;
	expiredRedirectReady: boolean;
};

class DatabaseSchemaNotInitializedError extends Error {
	constructor() {
		super(DATABASE_SCHEMA_NOT_INITIALIZED_MESSAGE);
		this.name = "DatabaseSchemaNotInitializedError";
	}
}

/**
 * Schema ownership: versioned migrations are the only authority for creating
 * or evolving tables and columns. The runtime validates that the database was
 * prepared and fails closed otherwise; it never runs `schema.sql`, never adds
 * feature columns and never rebuilds tables. Legacy extra columns
 * (`last_clicked_at`, `notes`, `stats`) are ignored and can stay until an
 * explicit migration removes them.
 */
async function initializeDatabaseSchema(database: D1Database) {
	const columns = await readInitializedLinkColumns(database);
	await ensureMetricFenceView(database, columns);
}

async function readInitializedLinkColumns(database: D1Database): Promise<Set<string>> {
	const linksTable = await database
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'links'")
		.first<{ name: string }>();

	if (!linksTable) {
		throw new DatabaseSchemaNotInitializedError();
	}

	const info = await database.prepare("PRAGMA table_info(links)").all<{ name: string }>();
	const columns = new Set((info.results ?? []).map((column) => column.name));
	if (!REQUIRED_LINK_COLUMNS.every((column) => columns.has(column))) {
		throw new DatabaseSchemaNotInitializedError();
	}

	return columns;
}

/**
 * The legacy click UPDATE reads the reset epoch through this projection so the
 * fence is evaluated by the same statement that writes `clicks_total`. Before
 * migration 0004 the projection reports the implicit initial epoch 0; migration
 * 0004 promotes it to the real `metric_epoch`, so a delayed pre-migration write
 * sees a reset that landed after the SQL was chosen. The view never creates
 * A/B columns: `metric_epoch` remains owned by the migration.
 *
 * The runtime path is intentionally non-destructive and monotonic
 * (absent -> shim, absent -> real). It uses `CREATE VIEW IF NOT EXISTS` and
 * never drops the projection, so a bootstrap that read a pre-0004 schema and
 * resumes after the migration can only no-op against the real view. Promotion
 * SHIM -> REAL is owned exclusively by migration 0004.
 */
async function ensureMetricFenceView(database: D1Database, columns: Set<string>) {
	const sql = columns.has("metric_epoch") ? METRIC_FENCE_VIEW_REAL_SQL : METRIC_FENCE_VIEW_LEGACY_SQL;
	await database.prepare(sql).run();
}

/**
 * A/B columns are owned by migration 0004. The runtime never creates them,
 * otherwise `wrangler d1 migrations apply` would fail with "duplicate column
 * name". Until the migration is applied, normal links keep working and A/B
 * configuration is rejected with a clear operational error.
 */
async function detectSchemaCapabilities(database: D1Database): Promise<SchemaCapabilities> {
	const info = await database.prepare("PRAGMA table_info(links)").all<{ name: string }>();
	const columns = new Set((info.results ?? []).map((column) => column.name));
	const smartRoutingReady = columns.has(SMART_ROUTING_COLUMN);
	if (smartRoutingReady) {
		databaseSmartRoutingReady.set(database, true);
	}
	const expiredRedirectReady = columns.has(EXPIRED_REDIRECT_COLUMN);
	if (expiredRedirectReady) {
		databaseExpiredRedirectReady.set(database, true);
	}
	return {
		abReady: AB_SCHEMA_COLUMNS.every((column) => columns.has(column)),
		smartRoutingReady,
		expiredRedirectReady,
	};
}

/**
 * Administrative Smart Routing capability. Positive results are cached;
 * negative results are revalidated so applying migration 0005 needs no restart.
 * The public redirect does not use this helper: it is schema-neutral and reads
 * the column from the row it already fetched.
 */
async function ensureSmartRoutingCapability(database: D1Database): Promise<boolean> {
	return resolveSmartRoutingCapability(database, await ensureDatabaseSchema(database));
}

/**
 * Read-only resolution of the Smart Routing capability from an already-validated
 * schema, for the routes that must not run the bootstrapping write. The negative
 * re-probe is a `PRAGMA` read, never a mutation.
 */
async function resolveSmartRoutingCapability(database: D1Database, schema: SchemaCapabilities): Promise<boolean> {
	if (schema.smartRoutingReady || databaseSmartRoutingReady.get(database) === true) {
		return true;
	}

	const info = await database.prepare("PRAGMA table_info(links)").all<{ name: string }>();
	const columns = new Set((info.results ?? []).map((column) => column.name));
	const ready = columns.has(SMART_ROUTING_COLUMN);
	if (ready) {
		databaseSmartRoutingReady.set(database, true);
	}
	return ready;
}

/**
 * Administrative expired-destination capability. Positive results are cached;
 * negative results are revalidated so applying migration 0006 needs no restart.
 * This helper answers administrative requests only: the public redirect never
 * calls it and never probes the schema, because it derives the same answer from
 * the shape of the row it already fetched.
 */
async function ensureExpiredRedirectCapability(database: D1Database): Promise<boolean> {
	return resolveExpiredRedirectCapability(database, await ensureDatabaseSchema(database));
}

/** Read-only counterpart of {@link ensureExpiredRedirectCapability}. */
async function resolveExpiredRedirectCapability(database: D1Database, schema: SchemaCapabilities): Promise<boolean> {
	if (schema.expiredRedirectReady || databaseExpiredRedirectReady.get(database) === true) {
		return true;
	}

	const info = await database.prepare("PRAGMA table_info(links)").all<{ name: string }>();
	const columns = new Set((info.results ?? []).map((column) => column.name));
	const ready = columns.has(EXPIRED_REDIRECT_COLUMN);
	if (ready) {
		databaseExpiredRedirectReady.set(database, true);
	}
	return ready;
}

function renderHomePage() {
	const currentYear = new Date().getFullYear();
	return `<!doctype html>
<html lang="pt-BR">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<meta name="theme-color" content="#09090b" />
	<title>BoltLink</title>
	<style>
		:root {
			color-scheme: dark;
			--bg: #09090b;
			--bg-mesh-1: rgba(0, 161, 245, 0.12);
			--bg-mesh-2: rgba(14, 165, 233, 0.08);
			--surface: rgba(255, 255, 255, 0.03);
			--surface-hover: rgba(255, 255, 255, 0.05);
			--line: rgba(255, 255, 255, 0.08);
			--line-hover: rgba(0, 161, 245, 0.3);
			--text: #f4f4f5;
			--text-secondary: #e4e4e7;
			--muted: #a1a1aa;
			--accent: #00A1F5;
			--accent-hover: #008cd6;
			--accent-soft: rgba(0, 161, 245, 0.15);
			--accent-glow: rgba(0, 161, 245, 0.2);
			--danger: #ef4444;
			--shadow: 0 20px 40px rgba(0, 0, 0, 0.4);
			--radius: 12px;
			--radius-sm: 8px;
			--radius-xs: 6px;
			--motion-fast: 150ms cubic-bezier(0.16, 1, 0.3, 1);
			--motion-medium: 250ms cubic-bezier(0.16, 1, 0.3, 1);
			--font: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
		}

		* { box-sizing: border-box; }

		html { scroll-behavior: smooth; }

		body {
			margin: 0;
			min-height: 100vh;
			font-family: var(--font);
			color: var(--text);
			background-color: var(--bg);
			background-image:
				radial-gradient(circle at top, var(--bg-mesh-1), transparent 32%),
				radial-gradient(circle at 85% 15%, var(--bg-mesh-2), transparent 28%),
				linear-gradient(180deg, #030406, var(--bg) 50%, #050608);
			-webkit-font-smoothing: antialiased;
			-moz-osx-font-smoothing: grayscale;
		}

		::selection {
			background: rgba(0, 161, 245, 0.24);
			color: #ffffff;
		}

		.bg-glow {
			position: fixed;
			inset: 0;
			pointer-events: none;
			overflow: hidden;
		}

		.bg-glow > div {
			position: absolute;
			border-radius: 9999px;
			filter: blur(64px);
			opacity: 0.4;
		}

		.bg-glow .glow-1 {
			left: 50%;
			top: 0;
			width: 18rem;
			height: 18rem;
			transform: translateX(-50%);
			background: var(--bg-mesh-1);
		}

		.bg-glow .glow-2 {
			right: 0;
			bottom: 2.5rem;
			width: 16rem;
			height: 16rem;
			background: var(--bg-mesh-2);
		}

		main {
			position: relative;
			z-index: 1;
			min-height: 100vh;
			display: grid;
			place-items: center;
			padding: 24px;
		}

		.shell {
			width: min(680px, 100%);
			padding: 40px;
			border: 1px solid var(--line);
			border-radius: var(--radius);
			background: var(--surface);
			box-shadow:
				inset 0 1px 0 rgba(255, 255, 255, 0.05),
				var(--shadow);
			backdrop-filter: blur(24px);
			-webkit-backdrop-filter: blur(24px);
			text-align: center;
			transition: transform var(--motion-medium), border-color var(--motion-medium), background-color var(--motion-medium), box-shadow var(--motion-medium);
		}

		.shell:hover {
			transform: translateY(-2px);
			border-color: var(--line-hover);
			background: var(--surface-hover);
			box-shadow:
				inset 0 1px 0 rgba(255, 255, 255, 0.08),
				0 20px 48px rgba(0, 0, 0, 0.45);
		}

		.logo {
			display: inline-flex;
			justify-content: center;
			margin-bottom: 28px;
		}

		.logo img {
			display: block;
			width: auto;
			height: 48px;
			max-width: 200px;
			object-fit: contain;
		}

		h1 {
			margin: 0;
			font-size: clamp(2rem, 5vw, 2.6rem);
			font-weight: 800;
			line-height: 1.1;
			letter-spacing: -0.04em;
			color: #ffffff;
			text-shadow: 0 0 30px rgba(0, 161, 245, 0.15);
		}

		.accent {
			color: var(--accent);
		}

		p {
			margin: 18px auto 0;
			max-width: 80ch;
			color: var(--muted);
			line-height: 1.6;
			font-size: 0.975rem;
		}

		.actions {
			margin-top: 32px;
			display: flex;
			justify-content: center;
			gap: 12px;
			flex-wrap: wrap;
		}

		a.button {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			min-height: 48px;
			padding: 12px 24px;
			border-radius: var(--radius-sm);
			border: 1px solid transparent;
			text-decoration: none;
			font-weight: 700;
			font-size: 0.92rem;
			color: #09090b;
			background: var(--accent);
			transition: transform var(--motion-fast), background-color var(--motion-fast), box-shadow var(--motion-fast), border-color var(--motion-fast);
			box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.2);
		}

		a.button:hover {
			transform: translateY(-1px);
			background: var(--accent-hover);
			box-shadow: 0 0 20px var(--accent-soft);
		}

		a.button:focus-visible {
			outline: none;
			border-color: rgba(255, 255, 255, 0.22);
			box-shadow: 0 0 0 4px var(--accent-soft);
		}

		a.button:active {
			transform: scale(0.98);
		}

		.footnote {
			margin-top: 36px;
			font-size: 0.82rem;
			color: var(--muted);
			max-width: 100%;
		}
		
		.footnote a {
			color: var(--muted);
			text-decoration: underline;
			text-underline-offset: 2px;
			transition: color var(--motion-fast);
		}
		
		.footnote a:hover {
			color: var(--text);
		}

		@media (prefers-reduced-motion: reduce) {
			html {
				scroll-behavior: auto;
			}

			*, *::before, *::after {
				animation-duration: 0.01ms !important;
				animation-iteration-count: 1 !important;
				scroll-behavior: auto !important;
				transition-duration: 0.01ms !important;
			}
		}

		@media (max-width: 480px) {
			.shell {
				padding: 28px 20px;
			}
		}
	</style>
</head>
<body>
	<div class="bg-glow" aria-hidden="true">
		<div class="glow-1"></div>
		<div class="glow-2"></div>
	</div>

	<main>
		<section class="shell">
			<div class="logo">
				<img src="/logo.png" alt="BoltLink" />
			</div>
			<h1><span class="accent">Gerenciador</span> de Links</h1>
			<p>
				Um encurtador de links privado, 100% serverless, com redirecionamento instantâneo na borda e dashboard protegido por Zero Trust.
			</p>
			<p class="footnote">&copy; ${currentYear} &bull; v${APP_VERSION} &bull; <a href="/privacidade">Privacidade</a> &bull; Criado por: <a href="https://github.com/vitorgfaustino/boltlink" target="_blank" rel="noopener">Vitor Faustino</a></p>
			<a href="/admin" style="display: none;" aria-hidden="true">Painel</a>
		</section>
	</main>
</body>
</html>`;
}

function isLocalRequest(url: string) {
	const hostname = new URL(url).hostname;
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function isApiPath(path: string) {
	return path === "/api" || path.startsWith("/api/");
}

function isAccessConfigured(env: Bindings) {
	return Boolean(env.TEAM_DOMAIN?.trim() && env.POLICY_AUD?.trim());
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) {
		return false;
	}
	let result = 0;
	for (let i = 0; i < a.length; i++) {
		result |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return result === 0;
}

function hasValidApiKey(request: Request, apiKey?: string) {
	if (!apiKey) {
		return false;
	}

	const authorization = request.headers.get("Authorization");
	if (!authorization) {
		return false;
	}

	return timingSafeEqual(authorization, `Bearer ${apiKey}`);
}

function rejectUnauthorized(c: Context<AppContext>) {
	if (isApiPath(c.req.path)) {
		return c.json({ error: "Authentication required" }, 401);
	}

	return c.text("Authentication required", 401);
}

async function hasValidAccessSession(request: Request, env: Bindings) {
	const token = extractAccessToken(request);
	if (!token) {
		return false;
	}

	if (!isAccessConfigured(env)) {
		return false;
	}

	const teamDomain = normalizeTeamDomain(env.TEAM_DOMAIN);
	if (!teamDomain || !env.POLICY_AUD?.trim()) {
		console.error("Cloudflare Access configuration is invalid for admin protection");
		return false;
	}

	try {
		const jwks = getAccessJwks(teamDomain);
		await jwtVerify(token, jwks, {
			issuer: teamDomain,
			audience: env.POLICY_AUD,
		});
		return true;
	} catch (error) {
		console.error("Cloudflare Access token validation failed", error);
		return false;
	}
}

function extractAccessToken(request: Request) {
	const accessHeader = request.headers.get("Cf-Access-Jwt-Assertion") ?? request.headers.get("cf-access-jwt-assertion");
	if (accessHeader) {
		return accessHeader;
	}

	const accessTokenHeader = request.headers.get("cf-access-token");
	if (accessTokenHeader) {
		return accessTokenHeader;
	}

	return parseCookie(request.headers.get("Cookie"))?.CF_Authorization ?? null;
}

function getAccessJwks(teamDomain: string) {
	const cached = accessJwksCache.get(teamDomain);
	if (cached) {
		return cached;
	}

	const jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
	accessJwksCache.set(teamDomain, jwks);
	return jwks;
}

function normalizeTeamDomain(teamDomain: string | undefined) {
	const trimmed = teamDomain?.trim() ?? "";
	if (!trimmed) {
		return null;
	}

	try {
		const parsed = new URL(trimmed.startsWith("http://") || trimmed.startsWith("https://") ? trimmed : `https://${trimmed}`);
		if (parsed.protocol !== "https:") {
			return null;
		}

		return `${parsed.protocol}//${parsed.hostname}`;
	} catch {
		return null;
	}
}

function parseCookie(cookieHeader: string | null) {
	if (!cookieHeader) {
		return null;
	}

	const cookies: Record<string, string> = {};
	for (const chunk of cookieHeader.split(";")) {
		const [rawName, ...rawValueParts] = chunk.split("=");
		const name = rawName.trim();
		if (!name) {
			continue;
		}

		cookies[name] = rawValueParts.join("=").trim();
	}

	return cookies;
}

function normalizeRedirectType(value?: string) {
	if (!value) {
		return "302" as const;
	}

	if (value === "301" || value === "302") {
		return value;
	}

	return null;
}

function normalizeTags(tags?: string[]) {
	if (tags === undefined) {
		return null;
	}

	if (!Array.isArray(tags)) {
		return null;
	}

	const sanitized = tags
		.map((tag) => (typeof tag === "string" ? tag.trim() : ""))
		.filter(Boolean)
		.slice(0, 50);

	if (!sanitized.length) {
		return null;
	}

	return JSON.stringify(sanitized);
}

function normalizeDateTime(value?: string, timeZone = DEFAULT_APP_TIMEZONE) {
	if (!value) {
		return null;
	}

	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}

	if (isNaiveLocalDateTime(trimmed)) {
		return localDateTimeToIsoInTimeZone(trimmed, timeZone);
	}

	const timestamp = new Date(trimmed).getTime();
	if (Number.isNaN(timestamp)) {
		return null;
	}

	return new Date(timestamp).toISOString();
}

function isNaiveLocalDateTime(value: string) {
	return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value);
}

function getAppTimeZone(env: Pick<Bindings, "APP_TIMEZONE">) {
	const candidate = env.APP_TIMEZONE?.trim();
	if (!candidate) {
		return DEFAULT_APP_TIMEZONE;
	}

	try {
		new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
		return candidate;
	} catch {
		return DEFAULT_APP_TIMEZONE;
	}
}

function localDateTimeToIsoInTimeZone(value: string, timeZone: string) {
	const match = value.match(
		/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/,
	);
	if (!match) {
		return null;
	}

	const year = Number.parseInt(match[1], 10);
	const month = Number.parseInt(match[2], 10);
	const day = Number.parseInt(match[3], 10);
	const hour = Number.parseInt(match[4], 10);
	const minute = Number.parseInt(match[5], 10);
	const second = Number.parseInt(match[6] ?? "0", 10);

	if (
		month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59
	) {
		return null;
	}

	const desiredUtc = Date.UTC(year, month - 1, day, hour, minute, second);
	let guessUtc = desiredUtc;

	for (let i = 0; i < 4; i += 1) {
		const zoned = getZonedParts(guessUtc, timeZone);
		if (!zoned) {
			return null;
		}

		const zonedAsUtc = Date.UTC(
			zoned.year,
			zoned.month - 1,
			zoned.day,
			zoned.hour,
			zoned.minute,
			zoned.second,
		);
		const delta = desiredUtc - zonedAsUtc;
		guessUtc += delta;

		if (delta === 0) {
			break;
		}
	}

	const finalZoned = getZonedParts(guessUtc, timeZone);
	if (
		!finalZoned
		|| finalZoned.year !== year
		|| finalZoned.month !== month
		|| finalZoned.day !== day
		|| finalZoned.hour !== hour
		|| finalZoned.minute !== minute
		|| finalZoned.second !== second
	) {
		return null;
	}

	return new Date(guessUtc).toISOString();
}

function getZonedParts(timestamp: number, timeZone: string) {
	try {
		const formatter = new Intl.DateTimeFormat("en-US", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hour12: false,
			hourCycle: "h23",
		});
		const parts = formatter.formatToParts(new Date(timestamp));
		const map = new Map(parts.map((part) => [part.type, part.value]));
		return {
			year: Number.parseInt(map.get("year") ?? "", 10),
			month: Number.parseInt(map.get("month") ?? "", 10),
			day: Number.parseInt(map.get("day") ?? "", 10),
			hour: Number.parseInt(map.get("hour") ?? "", 10),
			minute: Number.parseInt(map.get("minute") ?? "", 10),
			second: Number.parseInt(map.get("second") ?? "", 10),
		};
	} catch {
		return null;
	}
}

function normalizeGroupId(value: number | null | undefined) {
	if (value === undefined) {
		return undefined;
	}

	if (value === null) {
		return null;
	}

	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		return undefined;
	}

	return value;
}

function groupDepthLimitMessage(resultingDepth?: number) {
	return typeof resultingDepth === "number"
		? `Group depth limit of ${MAX_GROUP_DEPTH} exceeded (resulting depth ${resultingDepth})`
		: `Group depth limit of ${MAX_GROUP_DEPTH} exceeded`;
}

/**
 * The whole group adjacency list. Every operation that has to interpret the tree
 * reads it in one statement: no recursion on the read path, no auxiliary table
 * and, above all, no extra work on the public redirect.
 */
async function readGroupRows(database: D1Database) {
	const result = await database.prepare("SELECT id, parent_id FROM link_groups").all<GroupHierarchyRow>();
	return result.results ?? [];
}

/**
 * Explains a move that matched nothing. The write was already refused by
 * `GROUP_MOVE_SQL`, so this is read-only classification and can never authorize a
 * move. The checks follow that statement's `WHERE` clause, which is why the
 * observed-parent precondition is reported before the subtree and depth reasons.
 */
async function classifyGroupMoveFailure(
	database: D1Database,
	groupId: number,
	targetParentId: number | null,
	expectedParentId: number | null,
): Promise<{ status: 404 | 409; error: string }> {
	const rows = await readGroupRows(database);
	const current = rows.find((row) => row.id === groupId);
	if (!current) {
		return { status: 404, error: "Group not found" };
	}

	if (targetParentId !== null && !rows.some((row) => row.id === targetParentId)) {
		return { status: 404, error: "Parent group not found" };
	}

	const hierarchy = analyzeGroupHierarchy(rows);
	if (!hierarchy.ok) {
		return { status: 409, error: GROUP_HIERARCHY_CORRUPT_MESSAGE };
	}

	if ((current.parent_id ?? null) !== expectedParentId) {
		return { status: 409, error: GROUP_PARENT_CHANGED_MESSAGE };
	}

	if (isWithinSubtree(hierarchy.snapshot.parentById, groupId, targetParentId)) {
		return { status: 409, error: GROUP_SUBTREE_MESSAGE };
	}

	const targetDepth = targetParentId === null ? 0 : (hierarchy.snapshot.depthById.get(targetParentId) ?? 0);
	const resultingDepth = targetDepth + (hierarchy.snapshot.heightById.get(groupId) ?? 1);
	return { status: 409, error: groupDepthLimitMessage(resultingDepth) };
}

/**
 * Explains an insert that wrote nothing. The write was already refused by
 * `GROUP_INSERT_SQL`, so this is read-only classification: it can never authorize
 * an insert, never retries one and cannot produce a partial row. The order follows
 * that statement's `WHERE` clause, which is why a parent that stopped existing
 * during the request is reported as missing before the ceiling is blamed.
 */
async function classifyGroupInsertFailure(
	database: D1Database,
	parentId: number | null,
): Promise<{ status: 404 | 409; error: string }> {
	if (parentId === null) {
		// A parent-less insert carries no condition left to refuse; kept so this
		// classifier stays total.
		return { status: 409, error: groupDepthLimitMessage() };
	}

	const rows = await readGroupRows(database);
	if (!rows.some((row) => row.id === parentId)) {
		return { status: 404, error: "Parent group not found" };
	}

	const hierarchy = analyzeGroupHierarchy(rows);
	if (!hierarchy.ok) {
		return { status: 409, error: GROUP_HIERARCHY_CORRUPT_MESSAGE };
	}

	const resultingDepth = (hierarchy.snapshot.depthById.get(parentId) ?? 0) + 1;
	return { status: 409, error: groupDepthLimitMessage(resultingDepth) };
}

async function groupExists(database: D1Database, groupId: number) {
	const group = await database
		.prepare("SELECT 1 AS present FROM link_groups WHERE id = ? LIMIT 1")
		.bind(groupId)
		.first<{ present: number }>();

	return Boolean(group);
}

async function suggestDuplicateSlug(database: D1Database, baseSlug: string) {
	for (let suffix = 2; suffix < 1000; suffix += 1) {
		const candidate = `${baseSlug}-${suffix}`;
		if (!(await slugExists(database, candidate))) {
			return candidate;
		}
	}

	throw new Error("Unable to generate duplicate slug");
}

function passwordCookieName(slug: string) {
	return `boltlink_gate_${slug}`;
}

function getPasswordSessionSecret(env: Bindings) {
	const configuredSecret = env.PASSWORD_SESSION_SECRET?.trim();
	if (!configuredSecret) {
		throw new Error("PASSWORD_SESSION_SECRET is not configured. Password protection feature requires a static secret.");
	}
	return configuredSecret;
}

function hasConfiguredPasswordSessionSecret(env: Bindings) {
	return Boolean(env.PASSWORD_SESSION_SECRET?.trim());
}

async function createPasswordSessionToken(env: Bindings, slug: string) {
	const exp = Math.floor(Date.now() / 1000) + PASSWORD_SESSION_MAX_AGE_SECONDS;
	const payload = `${slug}:${exp}`;
	const secret = getPasswordSessionSecret(env);
	const signature = await hmacSha256Hex(payload, secret);
	return `${exp}.${signature}`;
}

async function hasValidPasswordSession(request: Request, env: Bindings, slug: string) {
	const cookies = parseCookie(request.headers.get("Cookie"));
	const token = cookies?.[passwordCookieName(slug)];
	if (!token) {
		return false;
	}

	const [expRaw, signature] = token.split(".");
	if (!expRaw || !signature) {
		return false;
	}

	const exp = Number.parseInt(expRaw, 10);
	if (Number.isNaN(exp) || exp < Math.floor(Date.now() / 1000)) {
		return false;
	}

	const expected = await hmacSha256Hex(`${slug}:${exp}`, getPasswordSessionSecret(env));
	return constantTimeEqual(expected, signature);
}

async function consumePasswordAttempt(slug: string, clientIp: string | null) {
	if (!passwordRateLimitSalt) {
		passwordRateLimitSalt = crypto.randomUUID();
	}
	const key = await sha256Hex(`${passwordRateLimitSalt}:${slug}:${clientIp?.trim() || "unknown"}`);
	const now = Date.now();
	const current = passwordAttempts.get(key);
	if (!current || current.resetAt <= now) {
		passwordAttempts.set(key, { count: 1, resetAt: now + PASSWORD_RATE_LIMIT_WINDOW_MS });
		return true;
	}

	if (current.count >= PASSWORD_RATE_LIMIT_MAX_ATTEMPTS) {
		return false;
	}

	current.count += 1;
	passwordAttempts.set(key, current);
	return true;
}

async function hashPassword(password?: unknown) {
	if (!hasPasswordValue(password)) {
		return null;
	}

	const salt = Array.from(crypto.getRandomValues(new Uint8Array(12)), (value) => value.toString(16).padStart(2, "0")).join("");
	const digest = await sha256Hex(`${salt}:${password.trim()}`);
	return `${salt}:${digest}`;
}

function hasPasswordValue(password: unknown): password is string {
	return typeof password === "string" && Boolean(password.trim());
}

type NormalizedPassword =
	| { kind: "absent" }
	| { kind: "remove" }
	| { kind: "set"; value: string }
	| { kind: "invalid" };

/**
 * Normalizes the `password` field before any mutation. Only a non-empty string
 * adds or replaces a password. `null` (the documented representation) is the
 * only way to remove it. Empty strings, whitespace-only strings and any other
 * JSON type are rejected so an invalid value can never be mistaken for a
 * removal request.
 */
function normalizePassword(value: unknown): NormalizedPassword {
	if (value === undefined) {
		return { kind: "absent" };
	}

	if (value === null) {
		return { kind: "remove" };
	}

	if (typeof value === "string") {
		return value.trim() ? { kind: "set", value } : { kind: "invalid" };
	}

	return { kind: "invalid" };
}

type AbConfigResult =
	| { ok: true; enabled: boolean; targetUrl: string | null; weightB: number }
	| { ok: false; error: string };

type ExistingAbConfig = {
	ab_enabled: number;
	ab_target_url: string | null;
	ab_weight_b: number;
};

/**
 * Routing-significant comparison between the persisted A/B configuration and the
 * normalized final one. Compares values instead of field presence, because the
 * Admin re-sends every A/B field it loaded during an unrelated edit; comparing
 * the effective values keeps that resend a no-op while a real change to the
 * split is still detected. Metrics (`ab_clicks_*`, `ab_generation`,
 * `ab_started_at`) are deliberately excluded: they are outcomes, not operator
 * configuration.
 */
function hasEffectiveAbConfigurationChange(
	existing: { enabled: boolean; targetUrl: string | null; weightB: number },
	final: { enabled: boolean; targetUrl: string | null; weightB: number },
): boolean {
	return (
		existing.enabled !== final.enabled ||
		existing.targetUrl !== final.targetUrl ||
		existing.weightB !== final.weightB
	);
}

/**
 * Validates and normalizes the A/B test configuration. Control A is always the
 * link's main `target_url`; only Variant B needs extra storage. All checks
 * happen before any mutation so an invalid payload never partially updates.
 */
function resolveAbConfig(
	payload: { abEnabled?: unknown; abTargetUrl?: unknown; abWeightB?: unknown },
	existing: ExistingAbConfig | null,
): AbConfigResult {
	let enabled = existing ? existing.ab_enabled === 1 : false;
	if (payload.abEnabled !== undefined) {
		if (typeof payload.abEnabled !== "boolean") {
			return { ok: false, error: "Invalid abEnabled. Use true or false" };
		}
		enabled = payload.abEnabled;
	}

	let targetUrl = existing ? existing.ab_target_url : null;
	if (payload.abTargetUrl !== undefined) {
		if (payload.abTargetUrl === null || (typeof payload.abTargetUrl === "string" && payload.abTargetUrl.trim() === "")) {
			targetUrl = null;
		} else if (typeof payload.abTargetUrl === "string") {
			const normalized = normalizeTargetUrl(payload.abTargetUrl);
			if (!normalized) {
				return { ok: false, error: "Invalid abTargetUrl" };
			}
			targetUrl = normalized;
		} else {
			return { ok: false, error: "Invalid abTargetUrl" };
		}
	}

	let weightB = existing ? existing.ab_weight_b : DEFAULT_AB_WEIGHT_B;
	if (payload.abWeightB !== undefined) {
		if (
			typeof payload.abWeightB !== "number" ||
			!Number.isInteger(payload.abWeightB) ||
			payload.abWeightB < AB_WEIGHT_MIN ||
			payload.abWeightB > AB_WEIGHT_MAX
		) {
			return { ok: false, error: "Invalid abWeightB. Use an integer between 1 and 99" };
		}
		weightB = payload.abWeightB;
	}

	if (enabled && !targetUrl) {
		return { ok: false, error: "abTargetUrl is required when A/B testing is enabled" };
	}

	return { ok: true, enabled, targetUrl, weightB };
}

type ResolvedSmartRoutingPayload =
	| { ok: true; configured: boolean; serialized: string | null; rules: SmartRoutingRule[] | null }
	| { ok: false; error: string };

/**
 * Validates an administrative `smartRoutingRules` value with the approved pure
 * domain. `undefined`/`null` mean disabled; `[]` and any semantic error are
 * rejected. Storage always receives the canonical JSON produced by the domain,
 * never the raw client input.
 */
function resolveSmartRoutingPayload(value: unknown): ResolvedSmartRoutingPayload {
	if (value === undefined || value === null) {
		return { ok: true, configured: false, serialized: null, rules: null };
	}

	const parsed = parseSmartRoutingRules(value);
	if (!parsed.ok) {
		return { ok: false, error: `Invalid smartRoutingRules (${parsed.code})` };
	}

	return { ok: true, configured: true, serialized: JSON.stringify(parsed.rules), rules: parsed.rules };
}

/** Administrative view of the persisted Smart Routing state. */
type SerializedSmartRoutingRules = {
	smartRoutingRules?: SmartRoutingRule[] | null;
	smartRoutingStatus?: SmartRoutingStatus;
};

/**
 * Administrative response mapping: exposes the persisted rules as a canonical
 * array (or `null`), never as the raw JSON string. Invalid persisted content is
 * reported without throwing and without repairing the database. When the column
 * was not selected (pre-0005), both properties are omitted entirely.
 *
 * `smartRoutingRules: null` alone is ambiguous: it means "disabled" for a NULL
 * column but also "unreadable" for a corrupt non-null value. `smartRoutingStatus`
 * removes the ambiguity so a client can tell an intentionally disabled link from
 * one whose configuration must be preserved instead of overwritten. The status
 * is metadata only: it never mutates or normalizes the stored bytes.
 */
function exposeSmartRoutingRules<T extends { smart_routing_rules?: string | null }>(
	row: T,
): Omit<T, "smart_routing_rules"> & SerializedSmartRoutingRules {
	if (!Object.prototype.hasOwnProperty.call(row, "smart_routing_rules")) {
		return row as Omit<T, "smart_routing_rules">;
	}

	const { smart_routing_rules: raw, ...rest } = row;
	const persisted = parsePersistedSmartRoutingRules(raw ?? null);
	return {
		...rest,
		smartRoutingRules: persisted.status === "valid" ? persisted.rules : null,
		smartRoutingStatus: persisted.status,
	};
}

/** Duplicate copies only a valid canonical configuration; corrupt content becomes disabled. */
function copyPersistedSmartRoutingRules(raw: string | null): string | null {
	const persisted = parsePersistedSmartRoutingRules(raw);
	return persisted.status === "valid" ? JSON.stringify(persisted.rules) : null;
}

type ResolvedExpiredRedirectUrl =
	| { ok: true; value: string | null }
	| { ok: false; error: string };

/**
 * Normalizes the administrative `expiredRedirectUrl` field. Absence and `null`
 * both mean "no expired destination"; telling them apart is the caller's job
 * (field presence), because a database without migration 0006 must reject any
 * request that mentions the field. The URL policy is exactly the one used by
 * `targetUrl` and `abTargetUrl`: a non-empty absolute http/https URL with a
 * registrable hostname. Empty strings, wrong JSON types and every other scheme
 * are rejected, so this field can never carry executable or relative content.
 */
function resolveExpiredRedirectUrl(value: unknown): ResolvedExpiredRedirectUrl {
	if (value === undefined || value === null) {
		return { ok: true, value: null };
	}

	if (typeof value !== "string") {
		return { ok: false, error: "Invalid expiredRedirectUrl" };
	}

	const normalized = normalizeTargetUrl(value);
	if (!normalized) {
		return { ok: false, error: "Invalid expiredRedirectUrl" };
	}

	return { ok: true, value: normalized };
}

/** Administrative mapping for the expired destination; omitted when not selected. */
function exposeExpiredRedirectUrl<T extends { expired_redirect_url?: string | null }>(
	row: T,
): Omit<T, "expired_redirect_url"> & { expiredRedirectUrl?: string | null } {
	if (!Object.prototype.hasOwnProperty.call(row, "expired_redirect_url")) {
		return row as Omit<T, "expired_redirect_url">;
	}

	const { expired_redirect_url: value, ...rest } = row;
	return { ...rest, expiredRedirectUrl: value ?? null };
}

/**
 * Administrative row mapping shared by every link response. A capability-backed
 * property is only present when its column was selected, so a pre-migration
 * database never fakes support by reporting a `null` value.
 */
function exposeLinkRow<T extends { smart_routing_rules?: string | null; expired_redirect_url?: string | null }>(
	row: T,
) {
	return exposeExpiredRedirectUrl(exposeSmartRoutingRules(row));
}

/**
 * Pure split decision: returns true when the request should go to Variant B.
 * `roll` is an integer in [0, 100). No cryptographic requirement here, only a
 * uniform distribution for a simple percentage split.
 */
export function isVariantB(weightB: number, roll: number): boolean {
	return roll < weightB;
}

/** Bots/previews never enter the split: they always receive Control A. */
function resolveRedirectTarget(
	link: RedirectRow,
	roll: number | null,
): { destination: string; variant: "a" | "b" | null } {
	if (!isActiveAbLink(link)) {
		return { destination: link.target_url, variant: null };
	}

	if (roll === null) {
		return { destination: link.target_url, variant: null };
	}

	if (isVariantB(link.ab_weight_b ?? DEFAULT_AB_WEIGHT_B, roll)) {
		return { destination: link.ab_target_url as string, variant: "b" };
	}

	return { destination: link.target_url, variant: "a" };
}

function isActiveAbLink(link: RedirectRow): boolean {
	return link.ab_enabled === 1 && Boolean(link.ab_target_url);
}

type PublicRedirectDecision = {
	destination: string;
	variant: "a" | "b" | null;
	status: 301 | 302;
	noStore: boolean;
};

/**
 * Public capability read derived from the row that was just fetched. `SELECT *`
 * returns every existing column, so presence of a column is the schema answer
 * for *this* request; nothing is cached and no isolate can hold a stale belief
 * about the migration level. A handle warmed before migration 0005 therefore
 * converges on its next public request even when no admin/API request ever
 * reaches it, and a non-null `smart_routing_rules` is never hidden by a cache.
 * The same rule answers for the expired destination: a database at 0005 returns
 * a row without the key at all, which is the feature being unavailable rather
 * than configured as `null`.
 */
function readPublicRowCapabilities(
	link: RedirectRow,
): Pick<SchemaCapabilities, "abReady" | "smartRoutingReady" | "expiredRedirectReady"> {
	return {
		abReady: AB_SCHEMA_COLUMNS.every((column) => Object.prototype.hasOwnProperty.call(link, column)),
		smartRoutingReady: Object.prototype.hasOwnProperty.call(link, SMART_ROUTING_COLUMN),
		expiredRedirectReady: Object.prototype.hasOwnProperty.call(link, EXPIRED_REDIRECT_COLUMN),
	};
}

type ExpiredLifecycleDecision =
	| { kind: "redirect"; destination: string }
	| { kind: "gone" };

/**
 * Direct self-loop guard: a destination equal to the URL being served would send
 * the visitor back to the very slug it came from. Query string and fragment are
 * ignored because they do not break the loop. Only the current request is
 * compared — `slug A -> slug B -> slug A` is a chain, not a self-loop, and
 * resolving it would need a second query, a fetch or a traversal, all of which
 * this path must not do. Origin comparison uses URL semantics, so it is never a
 * string-prefix accident, and the request origin is whatever host is serving the
 * slug instead of an invented list of custom domains.
 *
 * A destination that cannot be parsed is reported as a loop so the caller falls
 * back to the fail-closed answer.
 */
function isDirectSelfLoop(destination: string, requestUrl: string): boolean {
	try {
		const target = new URL(destination);
		const current = new URL(requestUrl);
		return target.origin === current.origin && target.pathname === current.pathname;
	} catch {
		return true;
	}
}

/**
 * Operational destination for `GET /`.
 *
 * Validation reuses the shared destination policy (`normalizeTargetUrl`), so a
 * relative value, `javascript:`, `data:` or any other non-http(s) scheme is
 * rejected by the same rule that already governs link destinations; there is no
 * root-only exception. Returning `null` means "serve the landing page", never an
 * error and never an echo of the rejected value.
 *
 * The direct self-loop guard is the one the expired lifecycle already uses:
 * origin plus pathname, so `https://<current-host>/` is a fallback regardless of
 * query string or fragment, while another path on the same origin is a normal
 * redirect. No network probe is performed to detect it.
 */
function resolveRootRedirectUrl(candidate: string | undefined, requestUrl: string): string | null {
	const destination = normalizeTargetUrl(candidate);
	if (!destination || isDirectSelfLoop(destination, requestUrl)) {
		return null;
	}

	return destination;
}

/**
 * Public expired lifecycle, evaluated after the future gate and before password,
 * click classification, Smart Routing, A/B and the metric write. Because it runs
 * first, an expired link never shows a password gate, never rolls the A/B RNG,
 * never classifies country/device and never writes a counter — the same answer
 * for bots, previews, prefetch and browsers.
 *
 * The destination is revalidated at read time instead of trusted: the column can
 * be written by hand, so a value that is not a string, not parseable under the
 * shared destination policy (the one `targetUrl` and `abTargetUrl` already use)
 * or that loops back to the current URL answers 410. `target_url` is never a
 * fallback in any of those cases: once a link has expired it does not return to
 * normal routing. The stored value is only read, never rewritten, and it is never
 * echoed in a body or a log.
 */
function resolveExpiredLifecycle(
	link: RedirectRow,
	capabilities: Pick<SchemaCapabilities, "expiredRedirectReady">,
	request: Request,
): ExpiredLifecycleDecision {
	if (!capabilities.expiredRedirectReady) {
		return { kind: "gone" };
	}

	const destination = normalizeTargetUrl(
		typeof link.expired_redirect_url === "string" ? link.expired_redirect_url : undefined,
	);
	if (!destination || isDirectSelfLoop(destination, request.url)) {
		return { kind: "gone" };
	}

	return { kind: "redirect", destination };
}

/**
 * Expired lifecycle response, shared by GET and POST so both handles answer
 * identically. The status is always 302: the displayed `redirect_type` describes
 * the main destination, and an expiration is mutable configuration that must not
 * be pinned permanently in a client or intermediary cache.
 *
 * `Cache-Control: no-store` is a deliberate contract, not a defensive extra.
 * Expiration is state that changes with `expires_at` and with the stored
 * destination, so a retained 410 could outlive the fix and a retained 302 could
 * outlive the destination it points to. The header is added here only; 404 for
 * missing, future and disabled slugs is untouched.
 */
function respondExpiredLifecycle(c: Context<AppContext>, decision: ExpiredLifecycleDecision) {
	if (decision.kind === "redirect") {
		const response = c.redirect(decision.destination, 302);
		response.headers.set("Cache-Control", "no-store");
		return response;
	}

	const response = c.text("Link expired", 410);
	response.headers.set("Cache-Control", "no-store");
	return response;
}


/**
 * Public redirect decision shared by GET and authenticated POST.
 *
 * A non-null persisted `smart_routing_rules` marks the row as dynamic even when
 * the configuration is corrupt: it always answers with 302 + no-store and never
 * falls back to a permanent redirect. Bots/prefetch and the ambiguous hybrid
 * state (A/B enable flag present + routing configured) receive `target_url`
 * without parsing rules, classifying country/device or running the A/B RNG.
 * The normal A/B path is reached only when Smart Routing is absent and keeps its
 * exact previous behavior.
 *
 * Hybrid detection uses the persisted `ab_enabled` flag, not `isActiveAbLink()`:
 * the latter answers "is the split operationally executable?" and requires a
 * variant B target. A row with `ab_enabled = 1` and a missing/empty variant B is
 * still an ambiguous persisted state and must not run Smart Routing either.
 *
 * `capabilities` comes from `readPublicRowCapabilities(link)`, never from a
 * cache: a request that can see the column always sees its value, so the
 * no-store treatment cannot be lost to a stale negative.
 */
function resolvePublicRedirectDecision(
	link: RedirectRow,
	capabilities: Pick<SchemaCapabilities, "abReady" | "smartRoutingReady">,
	countable: boolean,
	request: Request,
): PublicRedirectDecision {
	const smartRaw = capabilities.smartRoutingReady ? link.smart_routing_rules ?? null : null;
	const smartRoutingConfigured = smartRaw !== null;

	if (smartRoutingConfigured) {
		// Fail-safe for corrupted rows: the persisted A/B enable flag alone is
		// already ambiguous, even when the variant B target is missing or empty.
		// It must never run either engine. Non-navigational requests never reach
		// the parser or the classifiers either.
		const abEnabledFlag = capabilities.abReady && link.ab_enabled === 1;
		if (abEnabledFlag || !countable) {
			return { destination: link.target_url, variant: null, status: 302, noStore: true };
		}

		const persisted = parsePersistedSmartRoutingRules(smartRaw);
		if (persisted.status !== "valid") {
			return { destination: link.target_url, variant: null, status: 302, noStore: true };
		}

		const context = {
			country: normalizeRequestCountry(request.cf?.country),
			device: classifyDevice(request.headers.get("user-agent")),
		};
		return {
			destination: selectSmartRoutingTarget(persisted.rules, context, link.target_url),
			variant: null,
			status: 302,
			noStore: true,
		};
	}

	if (capabilities.abReady && isActiveAbLink(link)) {
		const roll = countable ? randomPercent() : null;
		const { destination, variant } = resolveRedirectTarget(link, roll);
		return { destination, variant, status: 302, noStore: true };
	}

	return {
		destination: link.target_url,
		variant: null,
		status: Number.parseInt(link.redirect_type, 10) === 301 ? 301 : 302,
		noStore: false,
	};
}

async function verifyPassword(candidate: string, storedHash: string) {
	const [salt, expected] = storedHash.split(":");
	if (!salt || !expected) {
		return false;
	}

	const digest = await sha256Hex(`${salt}:${candidate ?? ""}`);
	return constantTimeEqual(digest, expected);
}

async function sha256Hex(content: string) {
	const data = new TextEncoder().encode(content);
	const digest = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256Hex(content: string, secret: string) {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(content));
	return Array.from(new Uint8Array(signature), (value) => value.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string) {
	if (left.length !== right.length) {
		return false;
	}

	let diff = 0;
	for (let index = 0; index < left.length; index += 1) {
		diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
	}
	return diff === 0;
}

function renderPasswordGate(slug: string, errorMessage = "") {
	const message = errorMessage ? `<p style="color:#fda4af;margin:4px 0 0;font-size:0.88rem;font-weight:600;">${escapeHtml(errorMessage)}</p>` : "";
	return `<!doctype html>
<html lang="pt-BR">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>Link protegido</title>
	<style>
		:root {
			color-scheme: dark;
			--bg: #09090b;
			--bg-mesh: rgba(0, 161, 245, 0.12);
			--surface: rgba(255, 255, 255, 0.03);
			--surface-hover: rgba(255, 255, 255, 0.05);
			--line: rgba(255, 255, 255, 0.08);
			--line-hover: rgba(0, 161, 245, 0.3);
			--text: #f4f4f5;
			--text-secondary: #e4e4e7;
			--muted: #a1a1aa;
			--accent: #00A1F5;
			--accent-hover: #008cd6;
			--accent-soft: rgba(0, 161, 245, 0.15);
			--danger: #ef4444;
			--shadow: 0 20px 40px rgba(0, 0, 0, 0.4);
			--radius: 12px;
			--radius-sm: 8px;
			--radius-xs: 6px;
			--motion-fast: 150ms cubic-bezier(0.16, 1, 0.3, 1);
			--font: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
		}

		* { box-sizing: border-box; }

		body {
			margin: 0;
			min-height: 100vh;
			display: grid;
			place-items: center;
			padding: 24px;
			background-color: var(--bg);
			background-image:
				radial-gradient(circle at top, var(--bg-mesh), transparent 35%),
				linear-gradient(180deg, #030406, var(--bg) 50%, #050608);
			color: var(--text);
			font-family: var(--font);
			-webkit-font-smoothing: antialiased;
			-moz-osx-font-smoothing: grayscale;
		}

		.card {
			width: min(400px, 100%);
			display: grid;
			gap: 20px;
			padding: 32px 28px;
			border: 1px solid var(--line);
			border-radius: var(--radius);
			background: var(--surface);
			box-shadow:
				inset 0 1px 0 rgba(255, 255, 255, 0.05),
				var(--shadow);
			backdrop-filter: blur(24px);
			-webkit-backdrop-filter: blur(24px);
			text-align: center;
			transition: border-color var(--motion-medium), box-shadow var(--motion-medium);
		}

		.card:hover {
			border-color: rgba(0, 161, 245, 0.2);
			box-shadow:
				inset 0 1px 0 rgba(255, 255, 255, 0.08),
				0 24px 48px rgba(0, 0, 0, 0.45);
		}

		.card h1 {
			margin: 0;
			font-size: 1.25rem;
			font-weight: 700;
			letter-spacing: -0.02em;
			line-height: 1.2;
			color: #ffffff;
		}

		.card p {
			margin: -10px 0 0;
			color: var(--muted);
			font-size: 0.92rem;
			line-height: 1.5;
		}

		.card input {
			width: 100%;
			min-height: 48px;
			border-radius: var(--radius-sm);
			border: 1px solid var(--line);
			padding: 10px 16px;
			font: inherit;
			font-size: 0.94rem;
			background: rgba(0, 0, 0, 0.25);
			color: #ffffff;
			text-align: center;
			transition: border-color var(--motion-fast), box-shadow var(--motion-fast);
		}

		.card input::placeholder {
			color: #52525b;
		}

		.card input:focus {
			outline: none;
			border-color: var(--accent);
			box-shadow: 0 0 0 4px var(--accent-soft);
		}

		.card button {
			width: 100%;
			min-height: 48px;
			border-radius: var(--radius-sm);
			border: 1px solid transparent;
			padding: 10px 16px;
			font: inherit;
			font-size: 0.94rem;
			font-weight: 700;
			background: var(--accent);
			color: #09090b;
			cursor: pointer;
			transition: transform var(--motion-fast), background-color var(--motion-fast), box-shadow var(--motion-fast);
			box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.2);
		}

		.card button:hover {
			background: var(--accent-hover);
			box-shadow: 0 0 16px var(--accent-soft);
			transform: translateY(-1px);
		}

		.card button:focus-visible {
			outline: none;
			border-color: rgba(255, 255, 255, 0.2);
			box-shadow: 0 0 0 4px var(--accent-soft);
		}

		.card button:active {
			transform: scale(0.98);
		}

		@media (prefers-reduced-motion: reduce) {
			*, *::before, *::after {
				transition-duration: 0.01ms !important;
				animation-duration: 0.01ms !important;
				scroll-behavior: auto !important;
			}
			.card button:hover {
				transform: none;
			}
		}

		@media (max-width: 480px) {
			.card {
				padding: 24px 20px;
			}
		}
	</style>
</head>
<body>
	<form class="card" method="post" action="/${encodeURIComponent(slug)}">
		<h1>Link protegido por senha</h1>
		<p>Digite a senha para continuar.</p>
		${message}
		<input type="password" name="password" autocomplete="current-password" placeholder="Senha de acesso" required />
		<button type="submit">Acessar</button>
	</form>
</body>
</html>`;
}

function escapeHtml(value: string) {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function validateSlug(slug: string) {
	if (!SLUG_PATTERN.test(slug)) {
		return "Slug must be 3-64 chars using only letters, numbers, underscore, or hyphen";
	}

	if (isReservedSlug(slug)) {
		return "Slug is reserved";
	}

	return null;
}

function isReservedSlug(slug: string) {
	return RESERVED_SLUGS.has(slug.toLowerCase());
}

function isPublicSlugCandidate(slug: string) {
	return SLUG_PATTERN.test(slug) && !isReservedSlug(slug);
}

function normalizeTargetUrl(candidate?: string) {
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
}

function extractPreviewMetadata(html: string, sourceUrl: string) {
	const getMeta = (property: string) => {
		const patterns = [
			new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`, "i"),
			new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`, "i"),
			new RegExp(`<meta[^>]+name=["']${property}["'][^>]+content=["']([^"']+)["']`, "i"),
			new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${property}["']`, "i"),
		];

		for (const pattern of patterns) {
			const match = html.match(pattern);
			if (match?.[1]) {
				return decodeHtmlEntities(match[1].trim());
			}
		}
		return null;
	};

	const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
	const title = getMeta("og:title") ?? (titleMatch?.[1] ? decodeHtmlEntities(titleMatch[1].trim()) : null);
	const description = getMeta("og:description") ?? getMeta("description");
	const image = getMeta("og:image");
	const url = getMeta("og:url") ?? sourceUrl;
	const domain = new URL(sourceUrl).hostname;

	return { title, description, image, url, domain };
}

function decodeHtmlEntities(value: string) {
	return value
		.replaceAll("&amp;", "&")
		.replaceAll("&quot;", '"')
		.replaceAll("&#39;", "'")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.trim();
}

function escapeLikePattern(value: string) {
	return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

async function slugExists(database: D1Database, slug: string) {
	const existing = await database
		.prepare("SELECT 1 AS present FROM links WHERE slug = ? LIMIT 1")
		.bind(slug)
		.first<{ present: number }>();

	return Boolean(existing);
}

async function generateUniqueSlug(database: D1Database) {
	for (let attempt = 0; attempt < 8; attempt += 1) {
		const slug = generateSlug();
		if (!(await slugExists(database, slug))) {
			return slug;
		}
	}

	throw new Error("Failed to generate a unique slug");
}

function generateSlug() {
	const bytes = new Uint8Array(7);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => SLUG_ALPHABET[byte % SLUG_ALPHABET.length]).join("");
}

type ClickCapture = {
	variant: "a" | "b" | null;
	generation: number;
	epoch: number | null;
};

/**
 * Single aggregate row write. `clicks_total` is the historical counter and is
 * fenced by `metric_epoch` so a delayed write cannot resurrect a manual reset.
 * Variant counters are additionally fenced by `ab_generation` so a delayed
 * write can never contaminate a newer A/B definition.
 *
 * A request captured before migration 0004 (`epoch === null`) cannot rely on
 * the capability read made before the write: the migration (and a reset) can
 * land between that read and the UPDATE. Both statements below therefore carry
 * the fence inside the write itself. Once the migration is visible the write
 * compares the real `metric_epoch` against the implicit initial epoch 0. During
 * the transition it reads the same value through `boltlink_metric_fence`, a
 * projection that reports 0 before 0004 and the real column afterwards, so the
 * fence is evaluated atomically with the write in both worlds.
 */
async function recordClick(database: D1Database, linkId: number, capture: ClickCapture) {
	if (capture.epoch === null) {
		const capabilities = await ensureDatabaseSchema(database).catch((error) => {
			console.error("Failed to revalidate schema for delayed click", error);
			return null;
		});
		const sql = capabilities?.abReady
			? "UPDATE links SET clicks_total = clicks_total + CASE WHEN metric_epoch = 0 THEN 1 ELSE 0 END WHERE id = ?"
			: `UPDATE links SET clicks_total = clicks_total + (SELECT CASE WHEN metric_epoch = 0 THEN 1 ELSE 0 END FROM ${METRIC_FENCE_VIEW} WHERE ${METRIC_FENCE_VIEW}.id = links.id) WHERE id = ?`;
		try {
			await database.prepare(sql).bind(linkId).run();
		} catch (error) {
			console.error("Failed to record click", error);
		}
		return;
	}

	try {
		if (capture.variant === "a") {
			await database
				.prepare(
					`UPDATE links
					SET clicks_total = clicks_total + CASE WHEN metric_epoch = ? THEN 1 ELSE 0 END,
						ab_clicks_a = ab_clicks_a + CASE WHEN metric_epoch = ? AND ab_generation = ? THEN 1 ELSE 0 END
					WHERE id = ?`,
				)
				.bind(capture.epoch, capture.epoch, capture.generation, linkId)
				.run();
			return;
		}

		if (capture.variant === "b") {
			await database
				.prepare(
					`UPDATE links
					SET clicks_total = clicks_total + CASE WHEN metric_epoch = ? THEN 1 ELSE 0 END,
						ab_clicks_b = ab_clicks_b + CASE WHEN metric_epoch = ? AND ab_generation = ? THEN 1 ELSE 0 END
					WHERE id = ?`,
				)
				.bind(capture.epoch, capture.epoch, capture.generation, linkId)
				.run();
			return;
		}

		await database
			.prepare("UPDATE links SET clicks_total = clicks_total + CASE WHEN metric_epoch = ? THEN 1 ELSE 0 END WHERE id = ?")
			.bind(capture.epoch, linkId)
			.run();
	} catch (error) {
		console.error("Failed to record click", error);
	}
}

async function parseJsonBody<T>(c: Context<AppContext>) {
	const maxJsonBodyBytes = 10 * 1024;
	const contentLength = c.req.header("Content-Length");
	if (contentLength) {
		const size = parseInt(contentLength, 10);
		if (!Number.isNaN(size) && size > maxJsonBodyBytes) {
			return null;
		}
	}

	try {
		const body = await c.req.text();
		if (new TextEncoder().encode(body).byteLength > maxJsonBodyBytes) {
			return null;
		}

		return JSON.parse(body) as T;
	} catch {
		return null;
	}
}

function isoNow() {
	return new Date().toISOString();
}

/** Warnings the panel renders as copy of its own: the API never sends user-facing text. */
const PORTABILITY_IMPORT_WARNINGS: PortabilityImportWarningCode[] = ["METRICS_NOT_EXPORTED"];

/** Bounded conflict report: the panel lists slugs compactly and never needs all of them. */
const PORTABILITY_IMPORT_MAX_CONFLICTS = 20;

/**
 * Transport cap of the envelope, on top of the document ceiling. The document's own
 * limit is measured after parsing against the format's limit — the same number the
 * export applies to what it produces — so the two limits can never be confused: this
 * one only keeps an oversized body from being buffered before it is refused.
 */
const PORTABILITY_IMPORT_BODY_MAX_BYTES = PORTABILITY_MAX_BYTES + PORTABILITY_IMPORT_ENVELOPE_SLACK_BYTES;

/**
 * The runtime's own validators are the authority for what BoltLink accepts, exactly as
 * the export uses them: slug syntax and reservation, URL normalization, the tag storage
 * form and the default A/B weight all come from the write paths, so a document can never
 * be importable here and unapplicable through the administrative API.
 */
function portabilityImportPolicy(): PortabilityImportPolicy {
	return {
		isValidSlug: (slug: string) => validateSlug(slug) === null,
		normalizeUrl: (candidate: string) => normalizeTargetUrl(candidate),
		serializeTags: (tags: string[]) => normalizeTags(tags),
		defaultAbWeightB: DEFAULT_AB_WEIGHT_B,
	};
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads the request body with a hard byte ceiling, so a hostile or accidental upload is
 * refused while it is being read instead of after it was buffered. The declared
 * `Content-Length` is only a fast path: the streamed count is what decides.
 */
async function readPortabilityImportBody(
	c: Context<AppContext>,
	maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false; refusal: PortabilityImportRefusal }> {
	const declared = Number.parseInt(c.req.header("Content-Length") ?? "", 10);
	if (!Number.isNaN(declared) && declared > maxBytes) {
		return { ok: false, refusal: portabilityImportRefusal(413, "TOO_LARGE") };
	}

	const stream = c.req.raw.body;
	if (!stream) {
		return { ok: false, refusal: portabilityImportRefusal(400, "INVALID_BODY") };
	}

	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			if (!value) {
				continue;
			}
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel();
				return { ok: false, refusal: portabilityImportRefusal(413, "TOO_LARGE") };
			}
			chunks.push(value);
		}
	} catch {
		return { ok: false, refusal: portabilityImportRefusal(400, "INVALID_BODY") };
	}

	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}

	// Strict UTF-8. The default decoder *repairs* a malformed sequence by substituting
	// U+FFFD, which would turn a corrupt file into a different document that still
	// validates: the operator would import text that is not the text in the file, and the
	// only sign of it would be a replacement character somewhere in a name. A body that is
	// not UTF-8 is refused as unreadable instead of being guessed at.
	try {
		// `ignoreBOM: false` is the default and is named because the runtime's type for the
		// options object requires it: a byte order mark is still a byte order mark.
		return { ok: true, text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(merged) };
	} catch {
		return { ok: false, refusal: portabilityImportRefusal(400, "INVALID_BODY") };
	}
}

/**
 * Reads the `{ document, replacementPasswords }` envelope. Both endpoints take the same
 * shape, so the panel has exactly one body to build and one envelope rule to satisfy,
 * and the passwords for the protected links travel next to the document they belong to
 * instead of inside it — the format stays free of secrets.
 */
async function readPortabilityImportEnvelope(c: Context<AppContext>): Promise<
	{ ok: true; envelope: PortabilityImportEnvelope } | { ok: false; refusal: PortabilityImportRefusal }
> {
	const body = await readPortabilityImportBody(c, PORTABILITY_IMPORT_BODY_MAX_BYTES);
	if (!body.ok) {
		return body;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(body.text) as unknown;
	} catch {
		return { ok: false, refusal: portabilityImportRefusal(400, "INVALID_BODY") };
	}

	if (!isJsonObject(parsed)) {
		return { ok: false, refusal: portabilityImportRefusal(400, "INVALID_BODY") };
	}

	const unknownKeys = Object.keys(parsed).filter((key) => !PORTABILITY_IMPORT_ENVELOPE_KEYS.has(key));
	if (unknownKeys.length > 0) {
		return {
			ok: false,
			refusal: portabilityImportRefusal(
				400,
				"INVALID_BODY",
				unknownKeys.map((key) => ({ path: `envelope.${key}`, code: "INVALID_BODY" as const })),
			),
		};
	}
	if (!Object.prototype.hasOwnProperty.call(parsed, "document")) {
		return { ok: false, refusal: portabilityImportRefusal(400, "INVALID_BODY", [{ path: "document", code: "INVALID_BODY" }]) };
	}

	// The format's own ceiling, measured on the document that would be applied — the same
	// rule, and the same `413`, in both directions.
	if (portabilityImportDocumentBytes(parsed.document) > PORTABILITY_MAX_BYTES) {
		return { ok: false, refusal: portabilityImportRefusal(413, "TOO_LARGE") };
	}

	const rawPasswords = parsed.replacementPasswords;
	if (rawPasswords === undefined || rawPasswords === null) {
		return { ok: true, envelope: { document: parsed.document, replacementPasswords: null } };
	}
	if (!isJsonObject(rawPasswords)) {
		return { ok: false, refusal: portabilityImportRefusal(400, "INVALID_PASSWORD") };
	}

	return { ok: true, envelope: { document: parsed.document, replacementPasswords: rawPasswords } };
}

/**
 * Everything the destination decides: which feature columns exist, whether its own group
 * tree is interpretable, and which of the document's slugs already reserve a slug here.
 * All of it is read-only, so the same helper serves the preview and the apply — the
 * apply simply runs it again instead of trusting the answer the preview produced.
 */
async function readPortabilityImportDestination(
	database: D1Database,
	plan: PortabilityImportPlan,
): Promise<{
	capabilities: PortabilityImportFeatureFlags;
	hierarchyValid: boolean;
	groupReferencesValid: boolean;
	conflicts: string[];
}> {
	const schema = await inspectDatabaseSchema(database);
	const capabilities = {
		abTesting: schema.abReady,
		smartRouting: await resolveSmartRoutingCapability(database, schema),
		expiredRedirect: await resolveExpiredRedirectCapability(database, schema),
	};

	// A destination whose own tree cannot be interpreted refuses the import instead of
	// compounding the problem: the imported groups would be readable, but the panel could
	// not render the result, and no repair is ever implicit.
	const hierarchyValid = analyzeGroupHierarchy(await readGroupRows(database)).ok;

	// The second way a destination tree can be unreadable: a link that belongs to a group
	// that does not exist. Nothing in D1 enforces `links.group_id` as a foreign key, so a
	// row deleted by external SQL leaves the reference behind — and it is precisely the
	// state an id reuse would silently repair, by giving that id to an imported group.
	const orphan = await database.prepare(ORPHAN_GROUP_REFERENCE_SQL).first();

	return {
		capabilities,
		hierarchyValid,
		groupReferencesValid: !orphan,
		conflicts: plan.links.length ? await findPortabilityImportSlugConflicts(database, plan.links.map((link) => link.slug)) : [],
	};
}

/**
 * Whether the destination holds any link pointing at a group that is not there. One row is
 * enough: the check answers a yes/no question, so it stops at the first one and never walks
 * the whole table. Read-only, like everything else the preview does.
 */
const ORPHAN_GROUP_REFERENCE_SQL = `SELECT 1 AS present FROM links AS candidate
	WHERE candidate.group_id IS NOT NULL
	  AND NOT EXISTS (SELECT 1 FROM link_groups WHERE link_groups.id = candidate.group_id)
	LIMIT 1`;

/**
 * Slugs the document wants that the destination already reserves. *Any* row counts —
 * active, disabled or tombstone — because the `slug` column is unique across all of them
 * and the product never reuses a slug after soft deletion. Chunked so the parameter count
 * of each statement stays far below the platform ceiling, and reported in document order
 * so the panel's list is stable.
 */
async function findPortabilityImportSlugConflicts(database: D1Database, slugs: string[]): Promise<string[]> {
	const unique = [...new Set(slugs)];
	const conflicts = new Set<string>();

	for (let offset = 0; offset < unique.length; offset += 50) {
		const chunk = unique.slice(offset, offset + 50);
		const placeholders = chunk.map(() => "?").join(", ");
		const rows = await database
			.prepare(`SELECT slug FROM links WHERE slug IN (${placeholders})`)
			.bind(...chunk)
			.all<{ slug: string }>();

		for (const row of rows.results ?? []) {
			conflicts.add(String(row.slug));
		}
	}

	return unique.filter((slug) => conflicts.has(slug));
}

/**
 * Replacement passwords for the protected links of the document, validated as a strict
 * mapping: one non-empty password for every `passwordProtected: true` link, nothing for
 * any other slug and nothing in a shape that is not a string. A missing entry is the
 * import requirement not being met (`409`); a malformed one is a bad request (`400`).
 * The values never leave this function except as hashes.
 */
function resolvePortabilityImportPasswords(
	plan: PortabilityImportPlan,
	provided: Record<string, unknown> | null,
): { ok: true; values: Map<string, string> } | { ok: false; refusal: PortabilityImportRefusal } {
	const entries = Object.entries(provided ?? {});
	const required = new Set(plan.protectedSlugs);
	const values = new Map<string, string>();
	const issues: Array<{ path: string; code: "INVALID_PASSWORD" }> = [];

	for (let index = 0; index < entries.length; index += 1) {
		const [slug, value] = entries[index];
		if (!required.has(slug)) {
			// Strict on purpose: a password that would have no effect must be visible
			// instead of silently dropped. Only a slug-shaped key is named back, so the
			// report never republishes an arbitrary key from the request.
			const label = validateSlug(slug) === null ? `replacementPasswords.${slug}` : `replacementPasswords[${index}]`;
			issues.push({ path: label, code: "INVALID_PASSWORD" });
			continue;
		}

		const password = normalizePassword(value);
		if (password.kind !== "set") {
			issues.push({ path: `replacementPasswords.${slug}`, code: "INVALID_PASSWORD" });
			continue;
		}
		values.set(slug, password.value);
	}

	if (issues.length > 0) {
		return { ok: false, refusal: portabilityImportRefusal(400, "INVALID_PASSWORD", issues) };
	}

	const missing = plan.protectedSlugs.filter((slug) => !values.has(slug));
	if (missing.length > 0) {
		return {
			ok: false,
			refusal: portabilityImportRefusal(409, "PASSWORD_REQUIRED", missing.map((slug) => ({ path: `replacementPasswords.${slug}`, code: "PASSWORD_REQUIRED" as const }))),
		};
	}

	return { ok: true, values };
}

function respondPortabilityImportRefusal(c: Context<AppContext>, refusal: PortabilityImportRefusal) {
	// Controlled message: no raw SQL, no SQLite error, no stack and no document value.
	return c.json({ ok: false, error: refusal.error, code: refusal.code, errors: refusal.errors }, refusal.status, {
		"Cache-Control": "no-store",
	});
}

/**
 * The valid-document-cannot-be-applied answer. Every reason is reported together, so the
 * operator fixes them in one pass, and the summary still travels: knowing that the file
 * holds 7 groups and 42 links is what makes a refusal actionable.
 */
function respondPortabilityImportBlocked(
	c: Context<AppContext>,
	plan: PortabilityImportPlan,
	conflicts: string[],
	blockers: PortabilityImportBlockerCode[],
) {
	return c.json(
		{
			ok: false,
			error: "Portability import blocked",
			code: blockers[0] ?? "SLUG_COLLISION",
			blockers,
			summary: plan.summary,
			conflicts: conflicts.slice(0, PORTABILITY_IMPORT_MAX_CONFLICTS).map((slug) => ({ slug })),
			conflictsTotal: conflicts.length,
			requiresPasswords: plan.protectedSlugs.map((slug) => ({ slug })),
			warnings: PORTABILITY_IMPORT_WARNINGS,
		},
		409,
		{ "Cache-Control": "no-store" },
	);
}

function applySecurityHeaders(response: Response, path: string, requestUrl?: string) {
	const securedResponse = new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: new Headers(response.headers),
	});
	const isAdminPath = path === "/admin" || path === "/admin/" || path === "/admin.html" || path.startsWith("/admin/");
	const isSensitivePath = isAdminPath || isApiPath(path);
	const isRedirectResponse = response.status === 301 || response.status === 302;

	securedResponse.headers.set("X-Content-Type-Options", "nosniff");
	securedResponse.headers.set("X-Frame-Options", "DENY");
	
	if (isRedirectResponse && !isSensitivePath) {
		securedResponse.headers.set("Referrer-Policy", "strict-origin");
	} else {
		securedResponse.headers.set("Referrer-Policy", "no-referrer");
	}
	
	securedResponse.headers.set("Permissions-Policy", "camera=(), geolocation=(), microphone=()");

	if (requestUrl?.startsWith("https://")) {
		securedResponse.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
	}

	if (isSensitivePath) {
		securedResponse.headers.set("Cache-Control", "no-store");
	}

	if (isAdminPath) {
		securedResponse.headers.set(
			"Content-Security-Policy",
			"default-src 'none'; img-src 'self' data:; script-src 'unsafe-inline' 'self'; style-src 'unsafe-inline' 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; manifest-src 'self'",
		);
	}

	return securedResponse;
}

export default app;

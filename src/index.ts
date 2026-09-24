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

const ensureDatabaseReady: MiddlewareHandler<AppContext> = async (c, next) => {
	await ensureDatabaseSchema(c.env.db_boltlink);
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

	const existingLink = await c.env.db_boltlink
		.prepare("SELECT group_id FROM links WHERE slug = ? AND disabled_at IS NULL")
		.bind(slug)
		.first<{ group_id: number | null }>();

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

	if (existingLink?.group_id !== null && existingLink?.group_id !== undefined) {
		await cleanupEmptyGroup(c.env.db_boltlink, existingLink.group_id);
	}

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
	const link = await c.env.db_boltlink
		.prepare("SELECT slug FROM links WHERE slug = ? AND disabled_at IS NULL")
		.bind(slug)
		.first<{ slug: string }>();

	if (!link) {
		return c.json({ error: "Link not found" }, 404);
	}

	const shortUrl = new URL(`/${link.slug}`, c.req.url).toString();
	const svg = await QRCode.toString(shortUrl, {
		type: "svg",
		margin: 2,
		errorCorrectionLevel: "M",
	});

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

	return c.json({ groups: groups.results ?? [] });
});

app.post("/api/groups", async (c) => {
	const payload = await parseJsonBody<{ name?: string; parentId?: number | null }>(c);
	if (!payload?.name?.trim()) {
		return c.json({ error: "Group name is required" }, 400);
	}

	const name = payload.name.trim().slice(0, 120);
	const parentId = normalizeGroupId(payload.parentId);
	if (payload.parentId !== undefined && parentId === undefined) {
		return c.json({ error: "Invalid parentId" }, 400);
	}

	if (parentId !== null && parentId !== undefined && !(await groupExists(c.env.db_boltlink, parentId))) {
		return c.json({ error: "Parent group not found" }, 404);
	}

	const created = await c.env.db_boltlink
		.prepare("INSERT INTO link_groups (name, parent_id) VALUES (?, ?) RETURNING id, name, parent_id, created_at")
		.bind(name, parentId ?? null)
		.first<LinkGroupRow>();

	return c.json({ group: created }, 201);
});

app.patch("/api/groups/:id", async (c) => {
	const id = Number.parseInt(c.req.param("id"), 10);
	if (Number.isNaN(id) || id <= 0) {
		return c.json({ error: "Invalid group id" }, 400);
	}

	const payload = await parseJsonBody<{ name?: string; parentId?: number | null }>(c);
	if (!payload) {
		return c.json({ error: "Invalid JSON body" }, 400);
	}

	const updates: string[] = [];
	const values: Array<string | number | null> = [];
	if (payload.name !== undefined) {
		const name = payload.name.trim();
		if (!name) {
			return c.json({ error: "Group name cannot be empty" }, 400);
		}
		updates.push("name = ?");
		values.push(name.slice(0, 120));
	}

	if (payload.parentId !== undefined) {
		const parentId = normalizeGroupId(payload.parentId);
		if (parentId === undefined || parentId === id) {
			return c.json({ error: "Invalid parentId" }, 400);
		}
		if (parentId !== null && !(await groupExists(c.env.db_boltlink, parentId))) {
			return c.json({ error: "Parent group not found" }, 404);
		}
		updates.push("parent_id = ?");
		values.push(parentId);
	}

	if (!updates.length) {
		return c.json({ error: "No updatable fields provided" }, 400);
	}

	const updated = await c.env.db_boltlink
		.prepare(`UPDATE link_groups SET ${updates.join(", ")} WHERE id = ? RETURNING id, name, parent_id, created_at`)
		.bind(...values, id)
		.first<LinkGroupRow>();

	if (!updated) {
		return c.json({ error: "Group not found" }, 404);
	}

	return c.json({ group: updated });
});

app.delete("/api/groups/:id", async (c) => {
	const id = Number.parseInt(c.req.param("id"), 10);
	if (Number.isNaN(id) || id <= 0) {
		return c.json({ error: "Invalid group id" }, 400);
	}

	const usage = await c.env.db_boltlink
		.prepare("SELECT COUNT(1) AS total FROM links WHERE group_id = ? AND disabled_at IS NULL")
		.bind(id)
		.first<{ total: number }>();
	if ((usage?.total ?? 0) > 0) {
		return c.json({ error: "Group is not empty" }, 409);
	}

	const deleted = await c.env.db_boltlink
		.prepare("DELETE FROM link_groups WHERE id = ? RETURNING id")
		.bind(id)
		.first<{ id: number }>();

	if (!deleted) {
		return c.json({ error: "Group not found" }, 404);
	}

	return c.json({ ok: true });
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

	if (groupId !== undefined && existingLink.group_id !== null && existingLink.group_id !== groupId) {
		await cleanupEmptyGroup(c.env.db_boltlink, existingLink.group_id);
	}

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

	if (databaseAbReady.get(database)) {
		return {
			abReady: true,
			smartRoutingReady: databaseSmartRoutingReady.get(database) === true,
			expiredRedirectReady: databaseExpiredRedirectReady.get(database) === true,
		};
	}

	// Negative capabilities are never cached: a Worker started before migration
	// 0004 must be able to discover the migration once it is applied. The same
	// schema read also classifies Smart Routing.
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
	const schema = await ensureDatabaseSchema(database);
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
	const schema = await ensureDatabaseSchema(database);
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

async function groupExists(database: D1Database, groupId: number) {
	const group = await database
		.prepare("SELECT 1 AS present FROM link_groups WHERE id = ? LIMIT 1")
		.bind(groupId)
		.first<{ present: number }>();

	return Boolean(group);
}

async function cleanupEmptyGroup(database: D1Database, groupId: number) {
	const usage = await database
		.prepare("SELECT COUNT(1) AS total FROM links WHERE group_id = ? AND disabled_at IS NULL")
		.bind(groupId)
		.first<{ total: number }>();

	if ((usage?.total ?? 0) > 0) {
		return false;
	}

	const deleted = await database
		.prepare("DELETE FROM link_groups WHERE id = ? RETURNING id")
		.bind(groupId)
		.first<{ id: number }>();

	return Boolean(deleted);
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

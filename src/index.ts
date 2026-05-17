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
import { rateLimitMiddleware } from "./rate-limit";
import { isCountableClick, isCountablePasswordSubmission } from "./click-filter";
import databaseSchema from "../schema.sql";

type Bindings = {
	db_boltlink: D1Database;
	ASSETS: Fetcher;
	TEAM_DOMAIN: string;
	POLICY_AUD: string;
	APP_TIMEZONE?: string;
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
	version: number;
};

type RedirectRow = {
	id: number;
	slug: string;
	target_url: string;
	expires_at: string | null;
	go_live_at: string | null;
	redirect_type: "301" | "302";
	password_hash: string | null;
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
};

type LinkGroupRow = {
	id: number;
	name: string;
	parent_id: number | null;
	created_at: string;
};

const RESERVED_SLUGS = new Set([
	"admin",
	"admin.html",
	"api",
	"healt",
	"favicon.ico",
	"health",
	"robots.txt",
]);
const SLUG_PATTERN = /^[A-Za-z0-9_-]{3,64}$/;
const SLUG_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const accessJwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const databaseSchemaStatements = databaseSchema
	.replace(/\/\*[\s\S]*?\*\//g, '')
	.split(";")
	.map((statement) => statement.trim())
	.filter(Boolean);
const databaseSchemaBootstrap = new WeakMap<D1Database, Promise<void>>();
const LINK_INDEX_STATEMENTS = [
	"CREATE INDEX IF NOT EXISTS idx_links_slug ON links(slug)",
	"CREATE INDEX IF NOT EXISTS idx_links_created_at ON links(created_at DESC)",
	"CREATE INDEX IF NOT EXISTS idx_links_has_qrcode ON links(has_qrcode)",
	"CREATE INDEX IF NOT EXISTS idx_links_tags ON links(tags)",
	"CREATE INDEX IF NOT EXISTS idx_links_group_id ON links(group_id)",
];
const APP_VERSION = packageJson.version;
const DEFAULT_APP_TIMEZONE = "America/Sao_Paulo";
const PASSWORD_RATE_LIMIT_MAX_ATTEMPTS = 5;
const PASSWORD_RATE_LIMIT_WINDOW_MS = 60_000;
const PASSWORD_SESSION_MAX_AGE_SECONDS = 300;
const passwordSessionFallbackSecret = crypto.randomUUID();
const passwordAttempts = new Map<string, { count: number; resetAt: number }>();

const app = new Hono<AppContext>();

app.onError((error, c) => {
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

app.get("/", (c) => {
	return c.html(renderHomePage());
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
				CASE WHEN links.password_hash IS NOT NULL THEN 1 ELSE 0 END AS has_password,
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

	return c.json({ links: result.results ?? [], search });
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

	const passwordHash = await hashPassword(payload.password);

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

	const createdLink = await c.env.db_boltlink
		.prepare(
			`INSERT INTO links (
				slug,
				target_url,
				expires_at,
				go_live_at,
				redirect_type,
				tags,
				group_id,
				password_hash
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
		)
		.first<LinkRow>();

	return c.json({ link: createdLink }, 201);
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
	const source = await c.env.db_boltlink
		.prepare(
			`SELECT target_url, redirect_type, tags, group_id
			FROM links
			WHERE slug = ? AND disabled_at IS NULL`,
		)
		.bind(slug)
		.first<{ target_url: string; redirect_type: "301" | "302"; tags: string | null; group_id: number | null }>();

	if (!source) {
		return c.json({ error: "Link not found" }, 404);
	}

	const duplicateSlug = await suggestDuplicateSlug(c.env.db_boltlink, slug);
	const created = await c.env.db_boltlink
		.prepare(
			`INSERT INTO links (slug, target_url, redirect_type, tags, group_id)
			VALUES (?, ?, ?, ?, ?)
			RETURNING id, slug, target_url, clicks_total, created_at, updated_at, disabled_at,
				expires_at, go_live_at, redirect_type, tags, has_qrcode, group_id,
				CASE WHEN password_hash IS NOT NULL THEN 1 ELSE 0 END AS has_password, version`,
		)
		.bind(duplicateSlug, source.target_url, source.redirect_type, source.tags, source.group_id)
		.first<LinkRow>();

	return c.json({ link: created }, 201);
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
	if (isReservedSlug(slug)) {
		return c.notFound();
	}

	await ensureDatabaseSchema(c.env.db_boltlink);

	const link = await c.env.db_boltlink
		.prepare(
			`SELECT id, slug, target_url, expires_at, go_live_at, redirect_type, password_hash
			FROM links
			WHERE slug = ? AND disabled_at IS NULL`,
		)
		.bind(slug)
		.first<RedirectRow>();

	if (!link) {
		return c.notFound();
	}

	if (link.go_live_at && new Date(link.go_live_at).getTime() > Date.now()) {
		return c.notFound();
	}

	if (link.expires_at && new Date(link.expires_at).getTime() <= Date.now()) {
		return c.text("Link expired", 410);
	}

	if (link.password_hash && !(await hasValidPasswordSession(c.req.raw, c.env, link.slug))) {
		return c.html(renderPasswordGate(link.slug));
	}

	const response = c.redirect(link.target_url, Number.parseInt(link.redirect_type, 10) === 301 ? 301 : 302);

	if (isCountableClick(c.req.raw)) {
		c.executionCtx.waitUntil(recordClick(c.env.db_boltlink, link.id));
	}

	return response;
});

app.post("/:slug", async (c) => {
	const slug = c.req.param("slug");
	if (isReservedSlug(slug)) {
		return c.notFound();
	}

	await ensureDatabaseSchema(c.env.db_boltlink);
	const link = await c.env.db_boltlink
		.prepare(
			`SELECT id, slug, target_url, expires_at, go_live_at, redirect_type, password_hash
			FROM links
			WHERE slug = ? AND disabled_at IS NULL`,
		)
		.bind(slug)
		.first<RedirectRow>();

	if (!link) {
		return c.notFound();
	}

	if (!link.password_hash) {
		return c.redirect(link.target_url, Number.parseInt(link.redirect_type, 10) === 301 ? 301 : 302);
	}

	if (link.go_live_at && new Date(link.go_live_at).getTime() > Date.now()) {
		return c.notFound();
	}

	if (link.expires_at && new Date(link.expires_at).getTime() <= Date.now()) {
		return c.text("Link expired", 410);
	}

	if (!(await consumePasswordAttempt(slug, c.req.raw.headers.get("CF-Connecting-IP")))) {
		return c.text("Too many attempts. Try again in 1 minute.", 429);
	}

	const form = await c.req.raw.formData().catch(() => null);
	const candidate = String(form?.get("password") ?? "");
	if (!(await verifyPassword(candidate, link.password_hash))) {
		return c.html(renderPasswordGate(link.slug, "Senha inválida."), 401);
	}

	const token = await createPasswordSessionToken(c.env, link.slug);
	const response = c.redirect(link.target_url, Number.parseInt(link.redirect_type, 10) === 301 ? 301 : 302);
	const cookieSecure = new URL(c.req.url).protocol === "https:" ? "; Secure" : "";
	response.headers.append(
		"Set-Cookie",
		`${passwordCookieName(link.slug)}=${token}; Path=/${slug}; HttpOnly; SameSite=Lax; Max-Age=${PASSWORD_SESSION_MAX_AGE_SECONDS}${cookieSecure}`,
	);

	if (isCountablePasswordSubmission(c.req.raw)) {
		c.executionCtx.waitUntil(recordClick(c.env.db_boltlink, link.id));
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

	let previousGroupId: number | null | undefined;
	if (groupId !== undefined) {
		const currentLink = await c.env.db_boltlink
			.prepare("SELECT group_id FROM links WHERE slug = ? AND disabled_at IS NULL")
			.bind(slug)
			.first<{ group_id: number | null }>();

		if (!currentLink) {
			return c.json({ error: "Link not found" }, 404);
		}

		previousGroupId = currentLink.group_id;
	}

	const passwordHash = payload.password !== undefined
		? await hashPassword(payload.password === null ? undefined : payload.password)
		: undefined;

	if (
		(expiresAt || payload.expiresAt === null || goLiveAt || payload.goLiveAt === null)
	) {
		const existing = await c.env.db_boltlink
			.prepare("SELECT expires_at, go_live_at FROM links WHERE slug = ? AND disabled_at IS NULL")
			.bind(slug)
			.first<{ expires_at: string | null; go_live_at: string | null }>();

		if (!existing) {
			return c.json({ error: "Link not found" }, 404);
		}

		const finalExpires = expiresAt === undefined ? existing.expires_at : expiresAt;
		const finalGoLive = goLiveAt === undefined ? existing.go_live_at : goLiveAt;
		if (finalExpires && finalGoLive && new Date(finalExpires).getTime() < new Date(finalGoLive).getTime()) {
			return c.json({ error: "expiresAt cannot be earlier than goLiveAt" }, 400);
		}
	}

	const updates: string[] = [];
	const values: Array<string | number | null> = [];

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

	if (!updates.length) {
		return c.json({ error: "No updatable fields provided" }, 400);
	}

	const now = isoNow();
	updates.push("updated_at = ?", "version = version + 1");
	values.push(now);
	const updatedLink = await c.env.db_boltlink
		.prepare(
			`UPDATE links
			SET ${updates.join(", ")}
			WHERE slug = ? AND disabled_at IS NULL
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
				version`,
		)
		.bind(...values, slug)
		.first<LinkRow>();

	if (!updatedLink) {
		return c.json({ error: "Link not found" }, 404);
	}

	if (groupId !== undefined && previousGroupId !== undefined && previousGroupId !== groupId && previousGroupId !== null) {
		await cleanupEmptyGroup(c.env.db_boltlink, previousGroupId);
	}

	return c.json({ link: updatedLink });
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

function ensureDatabaseSchema(database: D1Database) {
	const cachedBootstrap = databaseSchemaBootstrap.get(database);
	if (cachedBootstrap) {
		return cachedBootstrap;
	}

	const bootstrap = initializeDatabaseSchema(database).catch((error) => {
		databaseSchemaBootstrap.delete(database);
		throw error;
	});

	databaseSchemaBootstrap.set(database, bootstrap);
	return bootstrap;
}

async function initializeDatabaseSchema(database: D1Database) {
	await reconcileLegacySchema(database);
	for (const statement of databaseSchemaStatements) {
		await database.prepare(statement).run();
	}
}

async function reconcileLegacySchema(database: D1Database) {
	const linksTable = await database
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'links'")
		.first<{ name: string }>();

	if (!linksTable) {
		return;
	}

	const info = await database.prepare("PRAGMA table_info(links)").all<{ name: string }>();
	const existingColumns = new Set((info.results ?? []).map((column) => column.name));
	const hasLegacyLinksColumns = existingColumns.has("last_clicked_at") || existingColumns.has("notes");
	const statsTable = await database
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'stats'")
		.first<{ name: string }>();

	if (hasLegacyLinksColumns || statsTable) {
		await rebuildLinksTable(database, existingColumns, Boolean(statsTable));
		return;
	}

	const addColumnStatements: Array<[string, string]> = [
		["expires_at", "ALTER TABLE links ADD COLUMN expires_at TEXT"],
		["go_live_at", "ALTER TABLE links ADD COLUMN go_live_at TEXT"],
		["redirect_type", "ALTER TABLE links ADD COLUMN redirect_type TEXT NOT NULL DEFAULT '302'"],
		["tags", "ALTER TABLE links ADD COLUMN tags TEXT"],
		["has_qrcode", "ALTER TABLE links ADD COLUMN has_qrcode INTEGER NOT NULL DEFAULT 0"],
		["group_id", "ALTER TABLE links ADD COLUMN group_id INTEGER"],
		["password_hash", "ALTER TABLE links ADD COLUMN password_hash TEXT"],
	];

	for (const [columnName, statement] of addColumnStatements) {
		if (!existingColumns.has(columnName)) {
			await database.prepare(statement).run();
		}
	}
}

async function rebuildLinksTable(database: D1Database, existingColumns: Set<string>, hasStatsTable: boolean) {
	if (hasStatsTable) {
		await database.prepare("DROP TABLE IF EXISTS stats").run();
	}

	await database.prepare("ALTER TABLE links RENAME TO links_legacy").run();
	await database.prepare(
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
			version INTEGER NOT NULL DEFAULT 1
		)`,
	).run();

	await database.prepare(
		`INSERT INTO links (
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
			password_hash,
			version
		)
		SELECT
			${selectLegacyColumn(existingColumns, "id", "NULL")},
			${selectLegacyColumn(existingColumns, "slug", "''")},
			${selectLegacyColumn(existingColumns, "target_url", "''")},
			${selectLegacyColumn(existingColumns, "clicks_total", "0")},
			${selectLegacyColumn(existingColumns, "created_at", "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")},
			${selectLegacyColumn(existingColumns, "updated_at", "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")},
			${selectLegacyColumn(existingColumns, "disabled_at", "NULL")},
			${selectLegacyColumn(existingColumns, "expires_at", "NULL")},
			${selectLegacyColumn(existingColumns, "go_live_at", "NULL")},
			${selectLegacyColumn(existingColumns, "redirect_type", "'302'")},
			${selectLegacyColumn(existingColumns, "tags", "NULL")},
			${selectLegacyColumn(existingColumns, "has_qrcode", "0")},
			${selectLegacyColumn(existingColumns, "group_id", "NULL")},
			${selectLegacyColumn(existingColumns, "password_hash", "NULL")},
			${selectLegacyColumn(existingColumns, "version", "1")}
		FROM links_legacy`,
	).run();

	await database.prepare("DROP TABLE links_legacy").run();
	for (const statement of LINK_INDEX_STATEMENTS) {
		await database.prepare(statement).run();
	}
}

function selectLegacyColumn(existingColumns: Set<string>, columnName: string, fallbackSql: string) {
	return existingColumns.has(columnName) ? columnName : fallbackSql;
}

function renderHomePage() {
	const currentYear = new Date().getFullYear();
	return `<!doctype html>
<html lang="pt-BR">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<meta name="theme-color" content="#0a0a0a" />
	<title>BoltLink</title>
	<style>
		:root {
			color-scheme: dark;
			--bg: #0a0a0a;
			--bg-mesh-1: rgba(68, 217, 255, 0.18);
			--bg-mesh-2: rgba(14, 165, 233, 0.14);
			--surface: rgba(255, 255, 255, 0.06);
			--surface-hover: rgba(255, 255, 255, 0.075);
			--surface-strong: rgba(0, 0, 0, 0.22);
			--line: rgba(255, 255, 255, 0.1);
			--line-hover: rgba(68, 217, 255, 0.34);
			--text: #f1f5f9;
			--muted: #94a3b8;
			--accent: #44d9ff;
			--accent-hover: #0ea5e9;
			--accent-soft: rgba(68, 217, 255, 0.14);
			--accent-glow: rgba(68, 217, 255, 0.28);
			--shadow: 0 18px 40px rgba(0, 0, 0, 0.28);
			--radius: 18px;
			--radius-sm: 12px;
			--motion-fast: 140ms ease;
			--motion-medium: 220ms ease;
			--font: "JetBrains Mono", "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", monospace;
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
				radial-gradient(circle at top, var(--bg-mesh-1), transparent 28%),
				radial-gradient(circle at 85% 15%, var(--bg-mesh-2), transparent 24%),
				linear-gradient(180deg, #040608, var(--bg) 48%, #06080d);
			-webkit-font-smoothing: antialiased;
			-moz-osx-font-smoothing: grayscale;
			font-feature-settings: "liga" 1, "calt" 1;
		}

		::selection {
			background: rgba(68, 217, 255, 0.24);
			color: #f8fafc;
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
			width: min(720px, 100%);
			padding: 28px;
			border: 1px solid var(--line);
			border-radius: var(--radius);
			background: var(--surface);
			box-shadow: var(--shadow);
			backdrop-filter: blur(24px);
			-webkit-backdrop-filter: blur(24px);
			text-align: center;
			transition: transform var(--motion-medium), border-color var(--motion-medium), background-color var(--motion-medium), box-shadow var(--motion-medium);
		}

		.shell:hover {
			transform: translateY(-2px);
			border-color: var(--line-hover);
			background: var(--surface-hover);
			box-shadow: 0 0 0 1px rgba(125, 211, 252, 0.03), var(--shadow);
		}

		.logo {
			display: inline-flex;
			justify-content: center;
			margin-bottom: 24px;
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
			font-size: clamp(2rem, 5vw, 3rem);
			line-height: 1.04;
			letter-spacing: -0.04em;
			text-shadow: 0 0 16px var(--accent-glow);
		}

		.accent {
			color: var(--accent);
		}

		p {
			margin: 18px auto 0;
			max-width: 58ch;
			color: var(--muted);
			line-height: 1.7;
			font-size: 1rem;
		}

		.actions {
			margin-top: 28px;
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
			padding: 12px 18px;
			border-radius: var(--radius-sm);
			border: 1px solid transparent;
			text-decoration: none;
			font-weight: 700;
			color: var(--bg);
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
			transform: translateY(0);
		}

		.footnote {
			margin-top: 18px;
			font-size: 0.84rem;
			color: rgba(148, 163, 184, 0.82);
			max-width: 100%;
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
			<div class="actions">
				<a class="button" href="/admin">Acessar painel</a>
			</div>
			<p class="footnote">&copy; ${currentYear} &bull; v${APP_VERSION} &bull; <a href="/privacidade">Política de privacidade</a> &bull; <a href="https://github.com/vitorgfaustino/boltlink" target="_blank" rel="noopener">Código-fonte AGPL-3.0</a></p>
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
	return env.PASSWORD_SESSION_SECRET?.trim() || env.API_KEY?.trim() || passwordSessionFallbackSecret;
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
	const key = await sha256Hex(`${slug}:${clientIp?.trim() || "unknown"}`);
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

async function hashPassword(password?: string) {
	if (!password?.trim()) {
		return null;
	}

	const salt = Array.from(crypto.getRandomValues(new Uint8Array(12)), (value) => value.toString(16).padStart(2, "0")).join("");
	const digest = await sha256Hex(`${salt}:${password.trim()}`);
	return `${salt}:${digest}`;
}

async function verifyPassword(candidate: string, storedHash: string) {
	const [salt, expected] = storedHash.split(":");
	if (!salt || !expected) {
		return false;
	}

	const digest = await sha256Hex(`${salt}:${candidate ?? ""}`);
	return digest === expected;
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
	const message = errorMessage ? `<p style="color:#fda4af;">${escapeHtml(errorMessage)}</p>` : "";
	return `<!doctype html>
<html lang="pt-BR">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>Link protegido</title>
	<style>
		:root { color-scheme: dark; }
		* { box-sizing: border-box; }
		body {
			margin: 0;
			min-height: 100vh;
			display: grid;
			place-items: center;
			padding: 24px;
			background: radial-gradient(circle at top, rgba(68, 217, 255, 0.16), transparent 30%), linear-gradient(180deg, #040608, #0a0a0a 48%, #06080d);
			color: #f1f5f9;
			font-family: ui-monospace, Menlo, Monaco, Consolas, monospace;
		}
		.card {
			width: min(420px, 100%);
			display: grid;
			gap: 14px;
			padding: 24px;
			border: 1px solid rgba(255,255,255,.12);
			border-radius: 16px;
			background: rgba(255,255,255,.05);
			box-shadow: 0 18px 40px rgba(0,0,0,.28);
			text-align: center;
		}
		.card h1,
		.card p {
			margin: 0;
		}
		.card p {
			color: #94a3b8;
			line-height: 1.55;
		}
		.card input,
		.card button {
			width: 100%;
			min-height: 46px;
			border-radius: 12px;
			border: 1px solid rgba(255,255,255,.15);
			padding: 10px 12px;
			font: inherit;
		}
		.card input {
			background: rgba(0,0,0,.24);
			color: #f1f5f9;
			text-align: center;
		}
		.card input::placeholder {
			color: #64748b;
		}
		.card button {
			background: #44d9ff;
			color: #0a0a0a;
			font-weight: 700;
			cursor: pointer;
			transition: transform 140ms ease, background-color 140ms ease, box-shadow 140ms ease;
		}
		.card button:hover,
		.card button:focus-visible {
			background: #67e8f9;
			box-shadow: 0 0 0 3px rgba(68, 217, 255, 0.18);
			transform: translateY(-1px);
		}
	</style>
</head>
<body>
	<form class="card" method="post" action="/${encodeURIComponent(slug)}">
		<h1 style="margin:0; font-size:1.2rem; line-height:1.2;">Link protegido por senha</h1>
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

async function recordClick(database: D1Database, linkId: number) {
	try {
		await database
			.prepare("UPDATE links SET clicks_total = clicks_total + 1 WHERE id = ?")
			.bind(linkId)
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
			"default-src 'none'; img-src 'self' data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; manifest-src 'self'",
		);
	}

	return securedResponse;
}

export default app;

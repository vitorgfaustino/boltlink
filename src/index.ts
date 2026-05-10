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
import packageJson from "../package.json";
import { rateLimitMiddleware } from "./rate-limit";
import databaseSchema from "../schema.sql";

type Bindings = {
	db_boltlink: D1Database;
	ASSETS: Fetcher;
	TEAM_DOMAIN: string;
	POLICY_AUD: string;
	API_KEY?: string;
	IP_HASH_SECRET?: string;
};

type AppContext = {
	Bindings: Bindings;
};

type LinkRow = {
	id: number;
	slug: string;
	target_url: string;
	clicks_total: number;
	last_clicked_at: string | null;
	created_at: string;
	updated_at: string;
	disabled_at: string | null;
	version: number;
};

type RedirectRow = {
	id: number;
	slug: string;
	target_url: string;
};

type StatsRow = {
	clicked_at: string;
	country: string | null;
};

type CreateLinkPayload = {
	slug?: string;
	targetUrl?: string;
	url?: string;
};

type UpdateLinkPayload = {
	targetUrl?: string;
	url?: string;
	slug?: string;
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
const APP_VERSION = packageJson.version;

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
	return c.json({ version: APP_VERSION });
});

app.get("/healt", (c) => {
	return serveHealth(c);
});

app.get("/admin", serveAdminAsset);
app.get("/admin/", serveAdminAsset);
app.get("/admin.html", serveAdminAsset);

app.get("/api/links", async (c) => {
	const search = c.req.query("search")?.trim() ?? "";
	const searchPattern = search ? `%${escapeLikePattern(search)}%` : null;
	const baseSql = `SELECT
				id,
				slug,
				target_url,
				clicks_total,
				last_clicked_at,
				created_at,
				updated_at,
				disabled_at,
				version
			FROM links
			WHERE disabled_at IS NULL`;
	const sql = searchPattern
		? `${baseSql}
			AND (slug LIKE ? ESCAPE '\\' OR target_url LIKE ? ESCAPE '\\')
			ORDER BY created_at DESC
			LIMIT 100`
		: `${baseSql}
			ORDER BY created_at DESC
			LIMIT 100`;
	const statement = searchPattern
		? c.env.db_boltlink.prepare(sql).bind(searchPattern, searchPattern)
		: c.env.db_boltlink.prepare(sql);
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
			`INSERT INTO links (slug, target_url)
			VALUES (?, ?)
			RETURNING
				id,
				slug,
				target_url,
				clicks_total,
				last_clicked_at,
				created_at,
				updated_at,
				disabled_at,
				version`,
		)
		.bind(slug, targetUrl)
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

	return c.json({ ok: true, slug: deletedLink.slug });
});

app.get("/api/links/:slug/stats", async (c) => {
	const slug = c.req.param("slug");
	const recentStats = await c.env.db_boltlink
		.prepare(
			`SELECT clicked_at, country
			FROM stats
			WHERE slug_snapshot = ?
			ORDER BY clicked_at DESC
			LIMIT 50`,
		)
		.bind(slug)
		.all<StatsRow>();

	const summary = await c.env.db_boltlink
		.prepare(
			`SELECT
				id,
				slug,
				target_url,
				clicks_total,
				last_clicked_at,
				created_at,
				updated_at,
				disabled_at,
				version
			FROM links
			WHERE slug = ?`,
		)
		.bind(slug)
		.first<LinkRow>();

	if (!summary) {
		return c.json({ error: "Link not found" }, 404);
	}

	return c.json({ link: summary, stats: recentStats.results ?? [] });
});

app.get("/:slug", async (c) => {
	const slug = c.req.param("slug");
	if (isReservedSlug(slug)) {
		return c.notFound();
	}

	await ensureDatabaseSchema(c.env.db_boltlink);

	const link = await c.env.db_boltlink
		.prepare(
			`SELECT id, slug, target_url
			FROM links
			WHERE slug = ? AND disabled_at IS NULL`,
		)
		.bind(slug)
		.first<RedirectRow>();

	if (!link) {
		return c.notFound();
	}

	const response = c.redirect(link.target_url, 302);
	c.executionCtx.waitUntil(recordClick(c.env.db_boltlink, c.req.raw, link, c.env.IP_HASH_SECRET));
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

	const targetUrl = normalizeTargetUrl(payload.targetUrl ?? payload.url);
	if (!targetUrl) {
		return c.json({ error: "Invalid target URL" }, 400);
	}

	const now = isoNow();
	const updatedLink = await c.env.db_boltlink
		.prepare(
			`UPDATE links
			SET target_url = ?, updated_at = ?, version = version + 1
			WHERE slug = ? AND disabled_at IS NULL
			RETURNING
				id,
				slug,
				target_url,
				clicks_total,
				last_clicked_at,
				created_at,
				updated_at,
				disabled_at,
				version`,
		)
		.bind(targetUrl, now, slug)
		.first<LinkRow>();

	if (!updatedLink) {
		return c.json({ error: "Link not found" }, 404);
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
	for (const statement of databaseSchemaStatements) {
		await database.prepare(statement).run();
	}
}

function renderHomePage() {
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
			<h1><span class="accent">BoltLink</span> URL shortener</h1>
			<p>
				Um encurtador de links privado, 100% serverless, com redirecionamento instantâneo na borda e dashboard protegido por Zero Trust.
			</p>
			<div class="actions">
				<a class="button" href="/admin">Acessar painel</a>
			</div>
			<p class="footnote">Versão atual: v${APP_VERSION} &bull; Desenvolvido por Vitor Faustino &bull; Licença AGPL-3.0</p>
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

async function recordClick(database: D1Database, request: Request, link: RedirectRow, ipHashSecret?: string) {
	try {
		const clickedAt = isoNow();
		const ipHash = await hashIp(request.headers.get("CF-Connecting-IP"), ipHashSecret);
		const country = request.headers.get("CF-IPCountry");

		await database.batch([
			database
				.prepare(
					`INSERT INTO stats (link_id, slug_snapshot, clicked_at, ip_hash, country)
					VALUES (?, ?, ?, ?, ?)`,
				)
				.bind(link.id, link.slug, clickedAt, ipHash, country),
			database
				.prepare(
					`UPDATE links
					SET clicks_total = clicks_total + 1, last_clicked_at = ?
					WHERE id = ?`,
				)
				.bind(clickedAt, link.id),
		]);
	} catch (error) {
		console.error("Failed to record click", error);
	}
}

async function hashIp(ipAddress: string | null, ipHashSecret?: string) {
	if (!ipAddress || !ipHashSecret?.trim()) {
		return null;
	}

	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(ipHashSecret.trim()),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(ipAddress.trim()));
	return Array.from(new Uint8Array(signature), (value) => value.toString(16).padStart(2, "0")).join("");
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

	securedResponse.headers.set("X-Content-Type-Options", "nosniff");
	securedResponse.headers.set("X-Frame-Options", "DENY");
	securedResponse.headers.set("Referrer-Policy", "no-referrer");
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

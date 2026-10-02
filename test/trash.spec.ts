/* Copyright (c) 2026 Vitor Faustino — AGPL-3.0 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { resetRateLimitStore } from "../src/rate-limit";
import { trashCutoff, TRASH_RETENTION_DAYS } from "../src/trash";
import m0 from "../migrations/0000_initial_schema.sql";
import m1 from "../migrations/0001_link_management.sql";
import m2 from "../migrations/0002_advanced_features.sql";
import m3 from "../migrations/0003_lgpd_minimization.sql";
import m4 from "../migrations/0004_ab_testing.sql";
import m5 from "../migrations/0005_smart_routing.sql";
import m6 from "../migrations/0006_expired_redirect.sql";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const CUTOFF = "2026-07-03T12:00:00.000Z";
async function fetchApi(path: string, method = "GET", body?: unknown, overrides?: Partial<Env>) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request("https://example.com" + path, {
    method, headers: { "Content-Type": "application/json", Authorization: "Bearer trash-test-key" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }), { ...env, API_KEY: "trash-test-key", PASSWORD_SESSION_SECRET: "test-secret", ...overrides }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
async function create(slug: string, extra: Record<string, unknown> = {}) {
  const response = await fetchApi("/api/links", "POST", { slug, targetUrl: "https://example.com/target", ...extra });
  expect(response.status, await response.clone().text()).toBe(201);
}
async function row(slug: string) {
  return env.db_boltlink.prepare("SELECT * FROM links WHERE slug = ?").bind(slug).first<Record<string, any>>();
}
async function insert(slug: string, date: string | null, extra: Record<string, any> = {}) {
  const fields = { slug, target_url: "https://example.com/target", disabled_at: date, ...extra };
  await env.db_boltlink.prepare(`INSERT INTO links (${Object.keys(fields).join(",")}) VALUES (${Object.keys(fields).map(() => "?").join(",")})`)
    .bind(...Object.values(fields)).run();
}
function proxyDb(before: (sql: string) => Promise<void> | void) {
  return new Proxy(env.db_boltlink, {
    get(target, property) {
      if (property !== "prepare") {
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (sql: string) => {
        const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
          get(targetStatement, method) {
            if (method === "bind") return (...values: any[]) => wrap(targetStatement.bind(...values));
            if (["first", "run", "all"].includes(String(method))) return async (...args: any[]) => {
              await before(sql);
              return (targetStatement as any)[method](...args);
            };
            const value = Reflect.get(targetStatement, method);
            return typeof value === "function" ? value.bind(targetStatement) : value;
          },
        });
        return wrap(target.prepare(sql));
      };
    },
  }) as D1Database;
}

beforeEach(async () => {
  resetRateLimitStore();
  await env.db_boltlink.prepare("DROP VIEW IF EXISTS boltlink_metric_fence").run();
  await env.db_boltlink.prepare("DROP TABLE IF EXISTS links").run();
  await env.db_boltlink.prepare("DROP TABLE IF EXISTS link_groups").run();
  for (const migration of [m0, m1, m2, m3, m4, m5, m6]) {
    for (const sql of migration.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((line: string) => !line.trim().startsWith("--")).join("\n").split(";").map((s: string) => s.trim()).filter(Boolean)) {
      await env.db_boltlink.prepare(sql).run();
    }
  }
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("Phase 8: trash lifecycle", () => {
  it("soft deletes, reserves the slug, hides it from active/public and exposes safe trash metadata", async () => {
    await create("trash-me", { password: "secret", tags: ["campaign"] });
    expect((await fetchApi("/api/links/trash-me", "DELETE")).status).toBe(200);
    expect((await fetchApi("/trash-me")).status).toBe(404);
    const active = await (await fetchApi("/api/links")).json() as any;
    expect(active.links).toEqual([]);
    const trash = await (await fetchApi("/api/trash?search=campaign")).json() as any;
    expect(trash.total).toBe(1);
    expect(trash.links[0]).toMatchObject({ slug: "trash-me", disabled_at: NOW.toISOString(), has_password: 1 });
    expect(JSON.stringify(trash)).not.toContain("password_hash");
    const collision = await fetchApi("/api/links", "POST", { slug: "trash-me", targetUrl: "https://example.com/new" });
    expect(collision.status).toBe(409);
    expect(await collision.json()).toMatchObject({ code: "SLUG_IN_TRASH", error: expect.stringMatching(/Lixeira.*Restaure/) });
  });
  it("restores without resetting configuration, hashes, counters, epochs, QR or creation time", async () => {
    const group = await env.db_boltlink.prepare("INSERT INTO link_groups (name) VALUES ('Campaign') RETURNING id").first<{ id: number }>();
    await create("restore-me", { password: "secret", groupId: group!.id, tags: ["campaign"], expiresAt: "2099-01-01T00:00:00.000Z", expiredRedirectUrl: "https://example.com/expired", abEnabled: true, abTargetUrl: "https://example.com/b", abWeightB: 30 });
    await env.db_boltlink.prepare("UPDATE links SET clicks_total=17, ab_clicks_a=10, ab_clicks_b=7, has_qrcode=1, metric_epoch=4 WHERE slug='restore-me'").run();
    await fetchApi("/api/links/restore-me", "DELETE");
    const before = await row("restore-me");
    vi.setSystemTime(new Date(NOW.getTime() + 1000));
    const response = await fetchApi("/api/trash/restore-me/restore", "POST");
    expect(response.status).toBe(200);
    const after = await row("restore-me");
    expect(after).toEqual({ ...before, disabled_at: null, updated_at: new Date(NOW.getTime() + 1000).toISOString(), version: before!.version + 1 });
    expect((await fetchApi("/api/trash")).status).toBe(200);
    expect((await fetchApi("/api/trash/restore-me/restore", "POST")).status).toBe(404);
    expect((await fetchApi("/api/groups/" + group!.id, "DELETE")).status).toBe(409);
  });
  it.each([
    { target_url: "https://sem-ponto/" },
    { redirect_type: "307" },
    { tags: "not-json" },
    { go_live_at: "invalid" },
    { go_live_at: "2099-01-01T00:00:00.000Z", expires_at: "2001-01-01T00:00:00.000Z" },
    { expired_redirect_url: "https://example.com/expired" },
    { expired_redirect_url: "javascript:alert(1)", expires_at: "2099-01-01T00:00:00.000Z" },
    { ab_enabled: 1 },
    { ab_weight_b: 100 },
    { smart_routing_rules: "not-json" },
    { smart_routing_rules: JSON.stringify([{ country: "BR", url: "https://example.com/br" }]), ab_enabled: 1, ab_target_url: "https://example.com/b" },
    { group_id: 999 },
  ])("refuses corrupt persisted configuration %j without writing", async (corrupt) => {
    await insert("invalid-restore", CUTOFF, corrupt);
    const before = await row("invalid-restore");
    const response = await fetchApi("/api/trash/invalid-restore/restore", "POST");
    expect(response.status).toBe(409);
    expect(await row("invalid-restore")).toEqual(before);
  });
  it("refuses group corruption and missing password secret", async () => {
    await create("protected", { password: "secret" });
    await fetchApi("/api/links/protected", "DELETE");
    expect((await fetchApi("/api/trash/protected/restore", "POST", undefined, { PASSWORD_SESSION_SECRET: undefined })).status).toBe(409);
    await env.db_boltlink.prepare("INSERT INTO link_groups (id,name,parent_id) VALUES (1,'Cycle',1)").run();
    expect((await fetchApi("/api/trash/protected/restore", "POST")).status).toBe(409);
  });
  it("hard deletes only tombstones, frees slug and leaves the group under operator control", async () => {
    const group = await env.db_boltlink.prepare("INSERT INTO link_groups (name) VALUES ('Group') RETURNING id").first<{ id: number }>();
    await create("reuse-me", { groupId: group!.id });
    expect((await fetchApi("/api/trash/reuse-me", "DELETE")).status).toBe(404);
    expect(await row("reuse-me")).not.toBeNull();
    await fetchApi("/api/links/reuse-me", "DELETE");
    expect((await fetchApi("/api/groups/" + group!.id, "DELETE")).status).toBe(409);
    expect((await fetchApi("/api/trash/reuse-me", "DELETE")).status).toBe(200);
    expect(await row("reuse-me")).toBeNull();
    expect(await env.db_boltlink.prepare("SELECT id FROM link_groups WHERE id=?").bind(group!.id).first()).not.toBeNull();
    await create("reuse-me");
  });
  it("fences changed configuration even when external SQL does not increment version", async () => {
    await insert("race-restore", CUTOFF);
    let injected = 0;
    const db = proxyDb(async (sql) => {
      if (sql.startsWith("UPDATE links\n") && !injected++) {
        await env.db_boltlink.prepare("UPDATE links SET target_url='https://invalid/' WHERE slug='race-restore'").run();
      }
    });
    expect((await fetchApi("/api/trash/race-restore/restore", "POST", undefined, { db_boltlink: db })).status).toBe(409);
    expect((await row("race-restore"))!.disabled_at).toBe(CUTOFF);
  });
  it("fences group graph changes made after validation", async () => {
    await insert("race-group", CUTOFF);
    let injected = false;
    const db = proxyDb(async (sql) => {
      if (sql.startsWith("UPDATE links\n") && !injected) {
        injected = true;
        await env.db_boltlink.prepare("INSERT INTO link_groups (id,name,parent_id) VALUES(1,'Cycle',1)").run();
      }
    });
    expect((await fetchApi("/api/trash/race-group/restore", "POST", undefined, { db_boltlink: db })).status).toBe(409);
    expect((await row("race-group"))!.disabled_at).toBe(CUTOFF);
  });
  it("refuses an invalid version rather than coercing it on recovery", async () => {
    await insert("invalid-version", CUTOFF, { version: "invalid" });
    expect((await fetchApi("/api/trash/invalid-version/restore", "POST")).status).toBe(409);
    expect((await row("invalid-version"))!.version).toBe("invalid");
  });
  it("does not restore a same-slug replacement with a different row identity", async () => {
    await insert("race-reuse", CUTOFF);
    let injected = false;
    const db = proxyDb(async (sql) => {
      if (sql.startsWith("UPDATE links\n") && !injected) {
        injected = true;
        await env.db_boltlink.prepare("DELETE FROM links WHERE slug='race-reuse'").run();
        await insert("race-reuse", CUTOFF);
      }
    });
    expect((await fetchApi("/api/trash/race-reuse/restore", "POST", undefined, { db_boltlink: db })).status).toBe(409);
    expect((await row("race-reuse"))!.disabled_at).toBe(CUTOFF);
  });
  it("classifies a raced create UNIQUE collision by its signature and reports trash", async () => {
    let injected = false;
    const db = proxyDb(async (sql) => {
      if (sql.startsWith("INSERT INTO links") && !injected) {
        injected = true;
        await insert("race-create", CUTOFF);
      }
    });
    const response = await fetchApi("/api/links", "POST", { slug: "race-create", targetUrl: "https://example.com/" }, { db_boltlink: db });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "SLUG_IN_TRASH" });
  });
  it("paginates beyond 100 tombstones and searches destination/slug/tags", async () => {
    await env.db_boltlink.batch(Array.from({ length: 103 }, (_, index) => env.db_boltlink.prepare("INSERT INTO links(slug,target_url,disabled_at,tags) VALUES(?,?,?,?)").bind("paged-" + index, "https://example.com/search-destination", CUTOFF, '["search-tag"]')));
    const first = await (await fetchApi("/api/trash")).json() as any;
    const second = await (await fetchApi("/api/trash?page=2")).json() as any;
    expect(first.links.length).toBe(100); expect(first.hasMore).toBe(true);
    expect(second.links.length).toBe(3); expect(second.hasMore).toBe(false);
    expect(new Set([...first.links, ...second.links].map((r: any) => r.slug)).size).toBe(103);
    for (const term of ["paged", "search-destination", "search-tag"]) {
      expect((await (await fetchApi("/api/trash?search=" + term)).json() as any).total).toBe(103);
    }
    expect((await fetchApi("/api/trash?page=-1")).status).toBe(400);
  });
});

describe("Phase 8: manual retention", () => {
  it("pins UTC 90-day cutoff and inclusive eligibility, ignoring active/recent/unreadable dates", async () => {
    expect(TRASH_RETENTION_DAYS).toBe(90);
    expect(trashCutoff(NOW)).toBe(CUTOFF);
    await insert("eligible", CUTOFF);
    await insert("older", "2001-01-01T00:00:00.000Z");
    await insert("recent", "2026-07-03T12:00:00.001Z");
    await insert("invalid-date", "not-a-date");
    await insert("active", null);
    const preview = await (await fetchApi("/api/trash/purge-preview")).json();
    expect(preview).toEqual({ total: 4, eligible: 2, cutoff: CUTOFF, retentionDays: 90 });
    const response = await fetchApi("/api/trash/purge", "POST");
    expect(await response.json()).toEqual({ ok: true, removed: 2, cutoff: CUTOFF, retentionDays: 90 });
    for (const slug of ["active", "recent", "invalid-date"]) expect(await row(slug)).not.toBeNull();
    for (const slug of ["eligible", "older"]) { expect(await row(slug)).toBeNull(); await create(slug); }
    expect((await fetchApi("/api/trash/purge", "GET")).status).toBe(404);
  });
  it("keeps ambiguous or impossible deletion dates and compares legacy offsets as instants", async () => {
    const invalid = ["1", "2001-01-01T00:00:00", "2026-02-31T00:00:00.000Z", "2026-00-01T00:00:00.000Z", "not-a-date"];
    for (let index = 0; index < invalid.length; index++) await insert("date-" + index, invalid[index]);
    await insert("offset-eligible", "2026-07-03T09:00:00-03:00");
    await insert("offset-recent", "2026-07-03T09:00:01-03:00");
    expect((await (await fetchApi("/api/trash/purge-preview")).json() as any).eligible).toBe(1);
    expect((await (await fetchApi("/api/trash/purge", "POST")).json() as any).removed).toBe(1);
    for (let index = 0; index < invalid.length; index++) expect(await row("date-" + index)).not.toBeNull();
    expect(await row("offset-recent")).not.toBeNull();
  });
  it("preview is read-only on a cold handle without installing the metric fence", async () => {
    await insert("old", CUTOFF);
    await env.db_boltlink.prepare("DROP VIEW boltlink_metric_fence").run();
    const before = await row("old");
    const statements: string[] = [];
    const db = proxyDb((sql) => { statements.push(sql); });
    expect((await fetchApi("/api/trash/purge-preview", "GET", undefined, { db_boltlink: db })).status).toBe(200);
    expect(statements.join("\n")).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|REPLACE)\b/i);
    expect(await env.db_boltlink.prepare("SELECT name FROM sqlite_master WHERE name='boltlink_metric_fence'").first()).toBeNull();
    expect(await row("old")).toEqual(before);
  });
  it("recomputes the cutoff and keeps an item restored after preview", async () => {
    await insert("restored-first", CUTOFF);
    await insert("newly-eligible", "2026-07-03T12:00:01.000Z");
    expect((await (await fetchApi("/api/trash/purge-preview")).json() as any).eligible).toBe(1);
    expect((await fetchApi("/api/trash/restored-first/restore", "POST")).status).toBe(200);
    vi.setSystemTime(new Date(NOW.getTime() + 1000));
    expect((await (await fetchApi("/api/trash/purge", "POST")).json() as any).removed).toBe(1);
    expect((await row("restored-first"))!.disabled_at).toBeNull();
    expect(await row("newly-eligible")).toBeNull();
  });
  it("a restore immediately before the DELETE is protected by the statement condition", async () => {
    await insert("raced-purge", CUTOFF);
    let injected = false;
    const db = proxyDb(async (sql) => {
      if (sql.startsWith("DELETE FROM links WHERE disabled_at") && !injected) {
        injected = true;
        await env.db_boltlink.prepare("UPDATE links SET disabled_at=NULL WHERE slug='raced-purge'").run();
      }
    });
    expect((await (await fetchApi("/api/trash/purge", "POST", undefined, { db_boltlink: db })).json() as any).removed).toBe(0);
    expect((await row("raced-purge"))!.disabled_at).toBeNull();
  });
});

describe("Phase 8: portability and legacy invalid tombstone", () => {
  it("reproduces SbEgchM end to end: visible in trash, excluded from export, unrestorable, deletable and reusable", async () => {
    await insert("SbEgchM", "2026-05-07T12:14:40.969Z", { target_url: "https://s0f90s9f0s/" });
    expect((await (await fetchApi("/api/links")).json() as any).links).toEqual([]);
    expect((await (await fetchApi("/api/trash")).json() as any).links[0].slug).toBe("SbEgchM");
    expect((await (await fetchApi("/api/export")).json() as any).links).toEqual([]);
    const refused = await fetchApi("/api/trash/SbEgchM/restore", "POST");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "INVALID_TARGET_URL" });
    expect((await fetchApi("/api/trash/SbEgchM", "DELETE")).status).toBe(200);
    await create("SbEgchM");
  });
  it("active invalid rows still fail closed with a safe code and trash does not consume export limits", async () => {
    await env.db_boltlink.batch(Array.from({ length: 101 }, (_, index) => env.db_boltlink.prepare("INSERT INTO links(slug,target_url,disabled_at) VALUES(?,?,?)").bind("trash-limit-" + index, "https://invalid/", CUTOFF)));
    await create("valid-active");
    const exported = await fetchApi("/api/export");
    expect(exported.status).toBe(200);
    expect((await exported.json() as any).links).toHaveLength(1);
    await insert("invalid-active", null, { target_url: "https://invalid/" });
    const refused = await fetchApi("/api/export");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: 'Portability export refused: invalid destination URL: link "invalid-active"', code: "INVALID_TARGET_URL" });
  });
  it("imports legacy v1 disabled:true documents into trash without changing the format", async () => {
    const document = { format: "boltlink-portability", schemaVersion: 1, exportedAt: NOW.toISOString(), groups: [], links: [{ slug: "legacy-disabled", targetUrl: "https://example.com/", redirectType: "302", tags: [], groupRef: null, disabled: true, goLiveAt: null, expiresAt: null, passwordProtected: false }] };
    expect((await fetchApi("/api/import/preview", "POST", { document })).status).toBe(200);
    expect((await fetchApi("/api/import/apply", "POST", { document })).status).toBe(200);
    expect((await row("legacy-disabled"))!.disabled_at).not.toBeNull();
    expect((await (await fetchApi("/api/export")).json() as any).links).toEqual([]);
    expect((await fetchApi("/api/trash/legacy-disabled/restore", "POST")).status).toBe(200);
  });
});

const BAD_URLS = ["https://sem-ponto/", "http://localhost/", "ftp://example.com/", "javascript:alert(1)", "example.com", "", "https://["];
const GOOD_URLS = ["https://example.com/", "https://sub.example.com/path", "http://example.com/"];
describe("Phase 8: the shared URL policy", () => {
  it.each(BAD_URLS)("refuses %s on create, PATCH, PUT and import", async (url) => {
    expect((await fetchApi("/api/links", "POST", { slug: "bad-url", targetUrl: url })).status).toBe(400);
    await create("update-url");
    const before = await row("update-url");
    for (const method of ["PATCH", "PUT"]) {
      expect((await fetchApi("/api/links/update-url", method, { targetUrl: url })).status).toBe(400);
      expect(await row("update-url")).toEqual(before);
    }
    const document = { format: "boltlink-portability", schemaVersion: 1, exportedAt: NOW.toISOString(), groups: [], links: [{ slug: "import-url", targetUrl: url, redirectType: "302", tags: [], groupRef: null, disabled: false, goLiveAt: null, expiresAt: null, passwordProtected: false }] };
    for (const operation of ["preview", "apply"]) expect((await fetchApi("/api/import/" + operation, "POST", { document })).status).toBe(400);
  });
  it.each(GOOD_URLS)("accepts %s on create, PATCH, PUT and import", async (url) => {
    await create("good-url", { targetUrl: url });
    for (const method of ["PATCH", "PUT"]) expect((await fetchApi("/api/links/good-url", method, { targetUrl: url })).status).toBe(200);
    const document = { format: "boltlink-portability", schemaVersion: 1, exportedAt: NOW.toISOString(), groups: [], links: [{ slug: "import-good-url", targetUrl: url, redirectType: "302", tags: [], groupRef: null, disabled: false, goLiveAt: null, expiresAt: null, passwordProtected: false }] };
    for (const operation of ["preview", "apply"]) expect((await fetchApi("/api/import/" + operation, "POST", { document })).status).toBe(200);
  });
});

describe("Phase 8: administrative boundary", () => {
  it.each([["/api/trash", "GET"], ["/api/trash/purge-preview", "GET"], ["/api/trash/purge", "POST"], ["/api/trash/missing/restore", "POST"], ["/api/trash/missing", "DELETE"]])("fails closed on an unprepared database: %s %s", async (path, method) => {
    await env.db_boltlink.prepare("DROP VIEW IF EXISTS boltlink_metric_fence").run();
    await env.db_boltlink.prepare("DROP TABLE links").run();
    const db = proxyDb(() => {});
    expect((await fetchApi(path, method, undefined, { db_boltlink: db })).status).toBe(503);
    expect(await env.db_boltlink.prepare("SELECT name FROM sqlite_master WHERE name='links'").first()).toBeNull();
  });

  it.each([["/api/trash", "GET"], ["/api/trash/purge-preview", "GET"], ["/api/trash/purge", "POST"], ["/api/trash/missing/restore", "POST"], ["/api/trash/missing", "DELETE"]])("protects %s %s before touching D1", async (path, method) => {
    const statements: string[] = [];
    const response = await fetchApi(path, method, undefined, { API_KEY: "required-test-key", TEAM_DOMAIN: "https://test.cloudflareaccess.com", POLICY_AUD: "test", db_boltlink: proxyDb((sql) => { statements.push(sql); }) });
    expect(response.status).toBe(401);
    expect(statements).toEqual([]);
  });
});

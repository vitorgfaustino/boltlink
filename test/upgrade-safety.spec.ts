// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { buildLocalConfig, ensureLocalConfigSynced, parseJsoncConfig } from "../scripts/config-utils.mjs";
import { compareInstallationConfigs, runUpgradeConfigCheck } from "../scripts/config-safety.mjs";
import { runWranglerCli } from "../scripts/wrangler.mjs";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const migration = ["d1", "migrations", "apply", "db_boltlink", "--remote"];
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const directories: string[] = [];
const config = (id: string | undefined = UUID_A) => ({
  name: "cliente-boltlink", routes: [{ pattern: "links.example.com", custom_domain: true }],
  d1_databases: [{ binding: "db_boltlink", database_name: "cliente-db", database_id: id, migrations_dir: "migrations" }],
});
function fixture(publicConfig: unknown = config(), localConfig?: unknown) {
  const rootDir = realpathSync(mkdtempSync(resolve(tmpdir(), "boltlink-upgrade-safety-")));
  directories.push(rootDir);
  writeFileSync(resolve(rootDir, "wrangler.jsonc"), JSON.stringify(publicConfig));
  if (localConfig) writeFileSync(resolve(rootDir, "wrangler.local.jsonc"), JSON.stringify(localConfig));
  return rootDir;
}
function run(rootDir: string, args = migration, env: Record<string, string> = { WORKERS_CI: "1" }) {
  const spawn = vi.fn(() => ({ status: 0 }));
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const logs = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const status = runWranglerCli({ rootDir, args, env, spawn });
  return { status, spawn, errors: errors.mock.calls.flat().join("\n"), logs: logs.mock.calls.flat().join("\n") };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Gate 10.1 deploy preflight with synthetic configs and subprocess mocks", () => {
  it("T01/T13 blocks the build before spawning Wrangler when the ID is missing", () => {
    const c = config(); delete (c.d1_databases[0] as any).database_id;
    const root = fixture(c);
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.spawn).not.toHaveBeenCalled();
    expect(result.errors).toContain("REMOTE_D1_DATABASE_ID_MISSING");
    expect(result.errors).toContain(resolve(root, "wrangler.jsonc"));
    expect(result.errors).toContain("Changing wrangler.local.jsonc on your computer will not fix");
  });
  it("T02 permits a provisioned build with a valid UUID", () => {
    const root = fixture(); const result = run(root);
    expect(result.status).toBe(0);
    expect(result.spawn).toHaveBeenCalledWith("wrangler", [...migration, "--config", resolve(root, "wrangler.jsonc")], expect.objectContaining({ cwd: root }));
  });
  it("T03 uses and preserves the local config for local Wrangler", () => {
    const root = fixture({ name: "boltlink", d1_databases: [{ binding: "db_boltlink", migrations_dir: "migrations" }] }, config());
    const result = run(root, migration, {});
    expect(result.status).toBe(0);
    expect(result.spawn.mock.calls[0][1]).toContain(resolve(root, "wrangler.local.jsonc"));
    expect(parseJsoncConfig(resolve(root, "wrangler.local.jsonc"))).toMatchObject(config());
  });
  it.each(["--config", "-c", "--config=", "-c="])("T04 respects explicit config %s", (flag) => {
    const root = fixture({}); writeFileSync(resolve(root, "custom.jsonc"), JSON.stringify(config()));
    const args = [...migration, ...(flag.endsWith("=") ? [flag + "custom.jsonc"] : [flag, "custom.jsonc"])];
    const result = run(root, args);
    expect(result.status).toBe(0); expect(result.spawn.mock.calls[0][1]).toEqual(args);
  });
  it("T05 keeps the real distributed template UUID-free and usable before provisioning", () => {
    const template = parseJsoncConfig(resolve("wrangler.jsonc"));
    expect(template.d1_databases[0]).not.toHaveProperty("database_id");
    const root = fixture(template);
    for (const args of [["types"], ["deploy", "--dry-run"], ["d1", "create", "new-db", "--config", "wrangler.jsonc"]]) {
      expect(run(root, args).status).toBe(0);
    }
    expect(run(root).status).toBe(1);
    template.d1_databases[0].database_id = UUID_A;
    writeFileSync(resolve(root, "wrangler.jsonc"), JSON.stringify(template));
    expect(run(root).status).toBe(0);
  });
  it.each(["invalid", "00000000-0000-0000-0000-000000000000", " " + UUID_A, 123])("T06 rejects invalid ID %s without spawning", (id) => {
    const c = config(); (c.d1_databases[0] as any).database_id = id;
    const result = run(fixture(c));
    expect(result.errors).toContain("REMOTE_D1_DATABASE_ID_INVALID"); expect(result.spawn).not.toHaveBeenCalled();
  });
  it.each([[[]], [[config().d1_databases[0], config().d1_databases[0]]]])("T07 rejects absent/ambiguous binding %j", (bindings) => {
    const result = run(fixture({ d1_databases: bindings }));
    expect(result.errors).toContain(bindings.length ? "REMOTE_D1_BINDING_AMBIGUOUS" : "REMOTE_D1_BINDING_MISSING");
    expect(result.spawn).not.toHaveBeenCalled();
  });
  it.each(["database_name", "migrations_dir"])("rejects missing %s before migration", (field) => {
    const c = config(); delete (c.d1_databases[0] as any)[field];
    const result = run(fixture(c)); expect(result.status).toBe(1); expect(result.spawn).not.toHaveBeenCalled();
  });
  it("rejects a migrations directory targeting another chain", () => {
    const c = config(); c.d1_databases[0].migrations_dir = "other";
    expect(run(fixture(c)).errors).toContain("REMOTE_D1_MIGRATIONS_DIR_INVALID");
  });
  it("T14 never logs secrets or parser source errors", () => {
    const secret = "SYNTHETIC_SECRET_DO_NOT_LOG";
    const c = { ...config(), vars: { API_KEY: secret, PASSWORD_SESSION_SECRET: secret } };
    delete (c.d1_databases[0] as any).database_id;
    const root = fixture(c);
    expect(run(root).errors).not.toContain(secret);
    writeFileSync(resolve(root, "wrangler.jsonc"), `{ "vars": { "API_KEY": "${secret}" }, broken }`);
    const result = run(root);
    expect(result.errors).not.toContain(secret); expect(result.spawn).not.toHaveBeenCalled();
  });
  it("reproduces the reported fixture: Builds ignores a valid local ID until the build config is fixed", () => {
    const c = config(); delete (c.d1_databases[0] as any).database_id;
    const root = fixture(c, config());
    for (const args of [migration, ["deploy"], ["versions", "upload"]]) {
      const failed = run(root, args); expect(failed.status).toBe(1); expect(failed.spawn).not.toHaveBeenCalled();
      expect(failed.errors).toContain(resolve(root, "wrangler.jsonc"));
    }
    writeFileSync(resolve(root, "wrangler.jsonc"), JSON.stringify(config()));
    expect(run(root).status).toBe(0);
    expect(parseJsoncConfig(resolve(root, "wrangler.local.jsonc"))).toEqual(config());
  });
  it("offers a read-only preflight using the exact routing without writes or subprocesses", () => {
    const root = fixture(config(), config(UUID_B));
    const before = readFileSync(resolve(root, "wrangler.local.jsonc"), "utf8");
    const result = run(root, ["boltlink-preflight"], {});
    expect(result.status).toBe(0); expect(result.spawn).not.toHaveBeenCalled();
    expect(result.logs).toContain(resolve(root, "wrangler.local.jsonc"));
    expect(readFileSync(resolve(root, "wrangler.local.jsonc"), "utf8")).toBe(before);
    expect(existsSync(resolve(root, ".wrangler"))).toBe(false);
  });
  it.each(["--env", "-e", "--env="])("validates the actual named environment %s, never inheriting top-level D1", (flag) => {
    const root = fixture({ ...config(), env: { staging: {} } });
    const args = [...migration, ...(flag.endsWith("=") ? [flag + "staging"] : [flag, "staging"])];
    expect(run(root, args).errors).toContain("REMOTE_D1_BINDING_MISSING");
    writeFileSync(resolve(root, "wrangler.jsonc"), JSON.stringify({ ...config(), env: { staging: config(UUID_B) } }));
    expect(run(root, args).status).toBe(0);
  });
  it.each([[["--config"]], [["--config", "a", "-c", "b"]], [["--cwd", "elsewhere"]]])("fails closed on ambiguous config resolution %j", (options) => {
    const result = run(fixture(), [...migration, ...options]); expect(result.status).toBe(1); expect(result.spawn).not.toHaveBeenCalled();
  });
  it("honors CLOUDFLARE_ENV, with CLI --env taking priority", () => {
    const root = fixture({ ...config(), env: { staging: {} } });
    expect(run(root, migration, { WORKERS_CI: "1", CLOUDFLARE_ENV: "staging" }).errors).toContain("REMOTE_D1_BINDING_MISSING");
    writeFileSync(resolve(root, "wrangler.jsonc"), JSON.stringify({ ...config(), env: { staging: {}, production: config() } }));
    expect(run(root, [...migration, "--env", "production"], { WORKERS_CI: "1", CLOUDFLARE_ENV: "staging" }).status).toBe(0);
  });
  it.each([["--dry-run", "--no-dry-run"], ["--dry-run=false"]])("negated/mixed dry-run flags cannot bypass publication preflight %j", (...flags) => {
    const root = fixture({}); const result = run(root, ["deploy", ...flags]);
    expect(result.status).toBe(1); expect(result.spawn).not.toHaveBeenCalled();
  });
  it("JSONC parsing handles comments, commas, escaped strings and never executes code", () => {
    const root = fixture(); const file = resolve(root, "input.jsonc");
    writeFileSync(file, '\uFEFF{/*comment*/"url":"https://example.com/a,}", "quote":"\\\"",//comment\n"list":[1,],}');
    expect(parseJsoncConfig(file)).toEqual({ url: "https://example.com/a,}", quote: '"', list: [1] });
    writeFileSync(file, `({ name: (globalThis.CONFIG_EXECUTED = true) })`);
    expect(() => parseJsoncConfig(file)).toThrow("CONFIG_INVALID_JSONC");
    expect((globalThis as any).CONFIG_EXECUTED).toBeUndefined();
  });
});

describe("Gate 10.1 installation comparison and semantic binding merge", () => {
  it("T08 blocks removed ID even with confirmation", () => {
    const after = config(); delete (after.d1_databases[0] as any).database_id;
    expect(compareInstallationConfigs(config(), after, ["d1_databases"]).status).toBe("BLOCKED");
    expect(compareInstallationConfigs(config(), { ...config(), d1_databases: [] }).status).toBe("BLOCKED");
  });
  it("T09 requires explicit confirmation for changed ID", () => {
    expect(compareInstallationConfigs(config(), config(UUID_B)).status).toBe("REQUIRES_EXPLICIT_CONFIRMATION");
    expect(compareInstallationConfigs(config(), config(UUID_B), ["d1_databases"]).status).toBe("PASSED");
  });
  it("T10 requires explicit confirmation when Worker identity reverts to the template", () => {
    const after = { ...config(), name: "boltlink" };
    expect(compareInstallationConfigs(config(), after).status).toBe("REQUIRES_EXPLICIT_CONFIRMATION");
    expect(compareInstallationConfigs(config(), after, ["name"]).status).toBe("PASSED");
  });
  it.each(["routes", "vars", "kv_namespaces", "r2_buckets", "services", "queues", "durable_objects", "custom_setting", "workers_dev"])("guards changes to %s without logging values", (key) => {
    const before = { ...config(), [key]: "SYNTHETIC_OLD" }; const after = { ...config(), [key]: "SYNTHETIC_NEW" };
    const result = compareInstallationConfigs(before, after);
    expect(result.status).toBe("REQUIRES_EXPLICIT_CONFIRMATION"); expect(JSON.stringify(result)).not.toContain("SYNTHETIC");
  });
  it("guards environment identity and ID removal", () => {
    const before = { ...config(), env: { production: config() } };
    const after = { ...config(), env: { production: { name: "boltlink" } } };
    expect(compareInstallationConfigs(before, after).status).toBe("BLOCKED");
  });
  it("allows changes only to distributed code fields", () => {
    expect(compareInstallationConfigs({ ...config(), main: "old.ts", compatibility_date: "2025-01-01" }, { ...config(), main: "new.ts", compatibility_date: "2026-01-01" }).status).toBe("PASSED");
  });
  it("the read-only comparison CLI exits nonzero until an operator confirms the exact field", () => {
    const root = fixture(); const before = resolve(root, "before.jsonc"); const after = resolve(root, "wrangler.jsonc");
    writeFileSync(before, JSON.stringify(config(UUID_B)));
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(runUpgradeConfigCheck(["--before", before, "--after", after])).toBe(1);
    expect(runUpgradeConfigCheck(["--before", before, "--after", after, "--confirm-field", "name"])).toBe(1);
    expect(runUpgradeConfigCheck(["--before", before, "--after", after, "--confirm-field", "d1_databases"])).toBe(0);
  });
  it("T11 preserves Worker, UUID, vars, routes, and custom bindings through real filesystem sync", () => {
    const template = { name: "boltlink", d1_databases: [{ binding: "db_boltlink", migrations_dir: "migrations" }] };
    const local = { ...config(), vars: { CUSTOM: "local" }, kv_namespaces: [{ binding: "CUSTOM_KV", id: "local-kv" }] };
    const root = fixture(template, local); ensureLocalConfigSynced(root);
    expect(parseJsoncConfig(resolve(root, "wrangler.local.jsonc"))).toMatchObject(local);
  });
  it.each([false, true])("T12 merges by binding with reordered arrays, template addition=%s", (added) => {
    const template = { d1_databases: [
      { binding: "other", database_id: UUID_B, migrations_dir: "other-chain" },
      { binding: "db_boltlink", migrations_dir: "migrations" },
      ...(added ? [{ binding: "upstream-new", database_id: UUID_B }] : []),
    ] };
    const local = { d1_databases: [
      { binding: "db_boltlink", database_id: UUID_A, database_name: "cliente-db" },
      { binding: "other", database_id: UUID_B, database_name: "other-db" },
      { binding: "custom", database_id: UUID_B },
    ] };
    expect(buildLocalConfig(template, local).d1_databases).toEqual([
      { ...local.d1_databases[0], migrations_dir: "migrations" },
      { ...local.d1_databases[1], migrations_dir: "other-chain" }, local.d1_databases[2],
    ]);
  });
  it("does not graft an upstream ID onto a renamed binding", () => {
    expect(buildLocalConfig({ d1_databases: [{ binding: "old", database_id: UUID_A }] }, { d1_databases: [{ binding: "new" }] }).d1_databases).toEqual([{ binding: "new" }]);
  });
  it("refuses ambiguous bindings instead of choosing a positional identity", () => {
    expect(() => buildLocalConfig({ d1_databases: [{ binding: "a" }] }, { d1_databases: [{ binding: "a" }, { binding: "a" }] })).toThrow("CONFIG_BINDING_AMBIGUOUS");
  });
});

describe("T15/T16 real npm deploy chain, real wrapper, isolated fake Wrangler executable", () => {
  it.each(["missing", "valid", "no-pending", "migration-fails"])("reproduces the build end to end: %s", (scenario) => {
    const c = config(); if (scenario === "missing") delete (c.d1_databases[0] as any).database_id;
    const root = fixture(c, config(UUID_B));
    mkdirSync(resolve(root, "scripts")); mkdirSync(resolve(root, "node_modules/.bin"), { recursive: true });
    for (const file of ["wrangler.mjs", "wrangler-routing.mjs", "config-utils.mjs", "config-safety.mjs"]) cpSync(resolve("scripts", file), resolve(root, "scripts", file));
    writeFileSync(resolve(root, "package.json"), JSON.stringify({ scripts: pkg.scripts }));
    // No Wrangler dependency in the fixture. This executable only logs args;
    // it contains no network code and never invokes real Wrangler.
    const fake = resolve(root, "node_modules/.bin/wrangler");
    writeFileSync(fake, `#!${process.execPath}\nimport { appendFileSync } from "node:fs";\nconst args = process.argv.slice(2);\nappendFileSync("calls.jsonl", JSON.stringify(args) + "\\n");\nif (args[0] === "d1" && process.env.MOCK_NO_PENDING === "1") console.log("No migrations to apply!");\nprocess.exit(args[0] === "d1" ? Number(process.env.MOCK_MIGRATION_EXIT) : 0);\n`);
    chmodSync(fake, 0o755);
    const result = spawnSync("npm", ["run", "deploy"], { cwd: root, encoding: "utf8", timeout: 20000,
      env: { ...process.env, WORKERS_CI: "1", MOCK_NO_PENDING: scenario === "no-pending" ? "1" : "0", MOCK_MIGRATION_EXIT: scenario === "migration-fails" ? "23" : "0" } });
    expect(result.error).toBeUndefined();
    if (scenario === "no-pending") expect(result.stdout).toContain("No migrations to apply!");
    const log = resolve(root, "calls.jsonl");
    const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
    if (scenario === "missing") {
      expect(result.status).toBe(1); expect(calls).toEqual([]);
      expect(result.stderr).toContain("REMOTE_D1_DATABASE_ID_MISSING"); expect(result.stderr).toContain(resolve(root, "wrangler.jsonc"));
    } else {
      expect(result.status).toBe(scenario === "migration-fails" ? 23 : 0);
      expect(calls).toEqual(scenario !== "migration-fails" ? [
        [...migration, "--config", resolve(root, "wrangler.jsonc")], ["deploy", "--config", resolve(root, "wrangler.jsonc")],
      ] : [[...migration, "--config", resolve(root, "wrangler.jsonc")]]);
    }
  });
});

describe("Gate 10.2 adversarial release-readiness regressions", () => {
  it.each([
    ["d1", "migrations", "apply", "db_boltlink", "--remote=true", "-c", "wrangler.jsonc"],
    ["-c", "wrangler.jsonc", "d1", "migrations", "apply", "db_boltlink", "--remote"],
    ["--config=wrangler.jsonc", "--env=production", "deploy"],
    ["--env", "production", "versions", "upload", "--config", "wrangler.jsonc"],
  ])("global flags/boolean forms cannot bypass preflight: %j", (...args) => {
    const c = config(); delete (c.d1_databases[0] as any).database_id;
    const result = run(fixture({ ...c, env: { production: c } }), args);
    expect(result.status).toBe(1); expect(result.spawn).not.toHaveBeenCalled();
    expect(result.errors).toContain("REMOTE_D1_DATABASE_ID_MISSING");
  });
  it.each(["--remote=true", "--remote"])("routes the Builds migration variant %s to public config even with local present", (flag) => {
    const root = fixture(config(), config(UUID_B));
    const args = ["--env", "production", "d1", "migrations", "apply", "db_boltlink", flag];
    writeFileSync(resolve(root, "wrangler.jsonc"), JSON.stringify({ ...config(), env: { production: config() } }));
    const result = run(root, args);
    expect(result.status).toBe(0);
    expect(result.spawn.mock.calls[0][1]).toEqual([...args, "--config", resolve(root, "wrangler.jsonc")]);
  });
  it.each([["--remote=invalid"], ["--remote", "--remote=false"], ["--config", "wrangler.jsonc", "--", "deploy"]])("ambiguous flags fail before subprocess: %j", (...flags) => {
    const result = run(fixture(), ["d1", "migrations", "apply", "db_boltlink", ...flags]);
    expect(result.status).toBe(1); expect(result.spawn).not.toHaveBeenCalled();
  });
  it("a database_name alias cannot hijack Wrangler's binding lookup", () => {
    const c = config(); c.d1_databases.unshift({ ...c.d1_databases[0], binding: "OTHER", database_name: "db_boltlink", database_id: UUID_B });
    const result = run(fixture(c)); expect(result.errors).toContain("REMOTE_D1_BINDING_AMBIGUOUS"); expect(result.spawn).not.toHaveBeenCalled();
  });
  it.each(["name", "database_id", "n\\u0061me"])("duplicate JSONC property %s is rejected without source disclosure", (key) => {
    const root = fixture(); const file = resolve(root, "wrangler.jsonc");
    const canonical = key.includes("\\") ? "name" : key;
    writeFileSync(file, `{ "${canonical}": "SYNTHETIC_SECRET_A", "${key}": "SYNTHETIC_SECRET_B" }`);
    const result = run(root);
    expect(result.status).toBe(1); expect(result.spawn).not.toHaveBeenCalled();
    expect(result.errors).not.toContain("SYNTHETIC_SECRET");
  });
  it("explicit config directories and missing files block without subprocess or config writes", () => {
    const root = fixture();
    for (const path of [root, resolve(root, "missing.jsonc")]) {
      const result = run(root, [...migration, "--config", path]);
      expect(result.status).toBe(1); expect(result.spawn).not.toHaveBeenCalled();
    }
    expect(existsSync(resolve(root, ".wrangler"))).toBe(false);
  });
  it("prototype-like data keys remain data and cannot make merge/comparison skip a change", () => {
    const local = JSON.parse('{"__proto__":{"operational":"custom"}}');
    const merged = buildLocalConfig({}, local);
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(Object.hasOwn(merged, "__proto__")).toBe(true);
    expect(({} as any).operational).toBeUndefined();
    expect(compareInstallationConfigs(local, {}).status).toBe("BLOCKED");
  });
  it.each(["kv_namespaces", "r2_buckets", "services", "d1_databases"])("duplicate local %s blocks even when no upstream list exists", (field) => {
    const duplicated = { [field]: [{ binding: "CUSTOM", id: "A" }, { binding: "CUSTOM", id: "B" }] };
    expect(() => buildLocalConfig({}, duplicated)).toThrow("CONFIG_BINDING_AMBIGUOUS");
    expect(compareInstallationConfigs(duplicated, duplicated, [field]).status).toBe("BLOCKED");
  });
  it("duplicate Durable Objects names block without positional merging", () => {
    expect(() => buildLocalConfig({}, { durable_objects: { bindings: [{ name: "OBJECT", class_name: "A" }, { name: "OBJECT", class_name: "B" }] } })).toThrow("CONFIG_BINDING_AMBIGUOUS");
  });
  it("reorders mixed D1/KV/R2 resources by their own identities and preserves local membership", () => {
    const publicConfig = {
      d1_databases: [{ binding: "db_boltlink", database_id: UUID_B, migrations_dir: "migrations" }, { binding: "OTHER", database_id: UUID_A }],
      kv_namespaces: [{ binding: "CACHE", id: "UPSTREAM" }, { binding: "EXTRA", id: "EXTRA" }],
      r2_buckets: [{ binding: "MEDIA", bucket_name: "upstream-media" }],
    };
    const local = { d1_databases: [config().d1_databases[0]], kv_namespaces: [{ binding: "EXTRA", id: "local-extra" }, { binding: "CACHE", id: "local-cache" }], r2_buckets: [{ binding: "MEDIA", bucket_name: "local-media" }] };
    expect(buildLocalConfig(publicConfig, local)).toMatchObject(local);
    expect(buildLocalConfig(publicConfig, local).d1_databases).toHaveLength(1);
  });
  it("does not silently adopt an upstream target ID/name for an existing incomplete local entry", () => {
    const local = { name: "cliente-boltlink", d1_databases: [{ binding: "db_boltlink", database_name: "local-db", migrations_dir: "migrations" }] };
    const merged = buildLocalConfig(config(UUID_B), local);
    expect(merged.d1_databases[0]).not.toHaveProperty("database_id");
    const result = run(fixture(config(UUID_B), local), migration, {});
    expect(result.errors).toContain("REMOTE_D1_DATABASE_ID_MISSING"); expect(result.spawn).not.toHaveBeenCalled();
  });
  it.each([undefined, "", "   ", null])("missing Worker identity %s cannot be confirmed away", (name) => {
    expect(compareInstallationConfigs(config(), { ...config(), name }, ["name"]).status).toBe("BLOCKED");
  });
  it("a missing D1 name and a removed operational resource require correction rather than confirmation", () => {
    const after = config(); delete (after.d1_databases[0] as any).database_name;
    expect(compareInstallationConfigs(config(), after, ["d1_databases"]).status).toBe("BLOCKED");
    expect(compareInstallationConfigs({ ...config(), kv_namespaces: [{ binding: "CUSTOM", id: "A" }] }, config(), ["kv_namespaces"]).status).toBe("BLOCKED");
  });
  it("the actual CLI denies a missing baseline with explicit reconciliation diagnostics", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = fixture();
    expect(runUpgradeConfigCheck(["--after", resolve(root, "wrangler.jsonc")])).toBe(1);
    expect(runUpgradeConfigCheck(["--before", resolve(root, "missing.jsonc"), "--after", resolve(root, "wrangler.jsonc")])).toBe(1);
    const output = errors.mock.calls.flat().join("\n");
    expect(output).toContain("UPGRADE_BASELINE = MISSING");
    expect(output).toContain("AUTOMATIC_APPROVAL = DENIED");
    expect(output).toContain("MANUAL_RECONCILIATION = REQUIRED");
  });
  it("confirmed changes produce an explicit CONFIRMED status rather than a pending warning", () => {
    const root = fixture(config(UUID_B)); const before = resolve(root, "before.jsonc");
    writeFileSync(before, JSON.stringify(config()));
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(runUpgradeConfigCheck(["--before", before, "--after", resolve(root, "wrangler.jsonc"), "--confirm-field=d1_databases"])).toBe(0);
    expect(logs.mock.calls.flat().join("\n")).toContain('"d1_databases": CONFIRMED');
  });
});

describe("Gate 10.2 explicit identity and registered command contract", () => {
  it("an unchanged operational UUID/name/binding passes without confirmation", () => {
    expect(compareInstallationConfigs(config(), config()).status).toBe("PASSED");
    const after = config(); after.d1_databases[0].database_name = "intentional-db-name";
    expect(compareInstallationConfigs(config(), after).status).toBe("REQUIRES_EXPLICIT_CONFIRMATION");
    expect(compareInstallationConfigs(config(), after, ["d1_databases"]).status).toBe("PASSED");
  });
  it("compact -c/-e options select the same actual config and environment", () => {
    const root = fixture({});
    writeFileSync(resolve(root, "custom.jsonc"), JSON.stringify({ env: { production: config() } }));
    const args = ["-ccustom.jsonc", "-eproduction", ...migration];
    const result = run(root, args);
    expect(result.status).toBe(0); expect(result.spawn.mock.calls[0][1]).toEqual(args);
  });
  it("registered npm upgrade:check and deploy:preflight work in isolated fixtures without Wrangler", () => {
    const root = fixture(); mkdirSync(resolve(root, "scripts"));
    for (const file of ["wrangler.mjs", "wrangler-routing.mjs", "config-utils.mjs", "config-safety.mjs"]) cpSync(resolve("scripts", file), resolve(root, "scripts", file));
    writeFileSync(resolve(root, "package.json"), JSON.stringify({ scripts: { "upgrade:check": pkg.scripts["upgrade:check"], "deploy:preflight": pkg.scripts["deploy:preflight"] } }));
    writeFileSync(resolve(root, "before.jsonc"), JSON.stringify(config()));
    const commands = [
      ["run", "upgrade:check", "--", "--before", "before.jsonc", "--after", "wrangler.jsonc"],
      ["run", "deploy:preflight", "--", "--config=wrangler.jsonc"],
    ];
    const before = readFileSync(resolve(root, "wrangler.jsonc"), "utf8");
    for (const args of commands) {
      const result = spawnSync("npm", args, { cwd: root, encoding: "utf8", timeout: 15000, env: { ...process.env, WORKERS_CI: "1" } });
      expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0); expect(result.stdout).toContain("PASSED");
    }
    expect(readFileSync(resolve(root, "wrangler.jsonc"), "utf8")).toBe(before);
    expect(existsSync(resolve(root, "wrangler.local.jsonc"))).toBe(false);
    expect(existsSync(resolve(root, ".wrangler"))).toBe(false);
  });
});

describe("Gate 10.2 local preparation uses the safe config parser and canonical binding", () => {
  it.each(["reordered", "ambiguous", "javascript"])("dev-prepare fixture %s cannot select or execute arbitrary configuration", (scenario) => {
    const c = config();
    c.d1_databases.unshift({ ...c.d1_databases[0], binding: "OTHER", database_name: scenario === "ambiguous" ? "db_boltlink" : "other-db" });
    const root = fixture(config(), c); mkdirSync(resolve(root, "scripts")); mkdirSync(resolve(root, "node_modules/.bin"), { recursive: true });
    for (const file of ["dev-prepare.mjs", "wrangler.mjs", "wrangler-routing.mjs", "config-utils.mjs", "config-safety.mjs"]) cpSync(resolve("scripts", file), resolve(root, "scripts", file));
    if (scenario === "javascript") writeFileSync(resolve(root, "wrangler.local.jsonc"), '({name: (() => { throw new Error("SYNTHETIC_CODE_EXECUTED"); })()})');
    const fake = resolve(root, "node_modules/.bin/wrangler");
    writeFileSync(fake, `#!${process.execPath}\nimport { appendFileSync } from "node:fs";\nappendFileSync("calls.jsonl", JSON.stringify(process.argv.slice(2)) + "\\n");\n`); chmodSync(fake, 0o755);
    const result = spawnSync(process.execPath, [resolve(root, "scripts/dev-prepare.mjs")], { cwd: root, encoding: "utf8", timeout: 10000,
      env: { ...process.env, CLOUDFLARE_ENV: "", WORKERS_CI: "", PATH: resolve(root, "node_modules/.bin") + ":" + process.env.PATH } });
    expect(result.error).toBeUndefined(); expect(result.stderr).not.toContain("SYNTHETIC_CODE_EXECUTED");
    const log = resolve(root, "calls.jsonl");
    if (scenario === "reordered") {
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(log, "utf8").trim())).toEqual(["d1", "migrations", "apply", "db_boltlink", "--local", "--config", resolve(root, "wrangler.local.jsonc")]);
    } else { expect(result.status).not.toBe(0); expect(existsSync(log)).toBe(false); }
  });
});

describe("Gate 10.2 dotenv cannot change the environment after validation", () => {
  it("a private .env selecting CLOUDFLARE_ENV needs explicit operator context without leaking values", () => {
    const root = fixture({ ...config(), env: { production: {} } });
    writeFileSync(resolve(root, ".env"), 'API_KEY=SYNTHETIC_PRIVATE_SECRET\nCLOUDFLARE_ENV=production\n');
    const blocked = run(root);
    expect(blocked.status).toBe(1); expect(blocked.spawn).not.toHaveBeenCalled();
    expect(blocked.errors).toContain("CONFIG_ENVIRONMENT_MUST_BE_EXPLICIT");
    expect(blocked.errors).not.toContain("SYNTHETIC_PRIVATE_SECRET");
    expect(run(root, [...migration, "--env=production"]).errors).toContain("REMOTE_D1_BINDING_MISSING");
    expect(run(root, [...migration, "--env="]).status).toBe(0);
  });
  it("an ordinary .env without environment selection preserves the normal flow", () => {
    const root = fixture(); writeFileSync(resolve(root, ".env"), 'API_KEY=SYNTHETIC_PRIVATE_SECRET\n');
    const result = run(root); expect(result.status).toBe(0); expect(result.errors).not.toContain("SYNTHETIC_PRIVATE_SECRET");
  });
  it("--env-file requires an explicit environment, including an explicit top-level selection", () => {
    const root = fixture(); writeFileSync(resolve(root, "private.env"), 'CLOUDFLARE_ENV=production\n');
    const args = [...migration, "--env-file", "private.env"];
    const result = run(root, args); expect(result.status).toBe(1); expect(result.spawn).not.toHaveBeenCalled();
    expect(run(root, [...args, "--env="]).status).toBe(0);
  });
  it("process-level CLOUDFLARE_ENV is validated even with dotenv present", () => {
    const root = fixture({ ...config(), env: { production: config(), incorrect: {} } });
    writeFileSync(resolve(root, ".env"), 'CLOUDFLARE_ENV=incorrect\n');
    expect(run(root, migration, { WORKERS_CI: "1", CLOUDFLARE_ENV: "production" }).status).toBe(0);
  });
});

describe("Gate 10.3 freeze closes partial identity removal and default dotenv bypasses", () => {
  it.each([["--envFile", "private.env"], ["--envFile=private.env"]])("camel-case dotenv option %j requires an explicit validated environment", (...flags) => {
    const root = fixture({ ...config(), env: { production: {} } });
    writeFileSync(resolve(root, "private.env"), 'CLOUDFLARE_ENV=production\n');
    const result = run(root, ["deploy", ...flags]);
    expect(result.status).toBe(1); expect(result.spawn).not.toHaveBeenCalled();
    expect(result.errors).toContain("CONFIG_ENVIRONMENT_MUST_BE_EXPLICIT");
    expect(run(root, ["deploy", ...flags, "--env=production"]).errors).toContain("REMOTE_D1_BINDING_MISSING");
    expect(run(root, ["deploy", ...flags, "--env="]).status).toBe(0);
  });
  it.each([["--e", "production"], ["--e=production"]])("long environment alias %j cannot bypass effective binding validation", (...flags) => {
    const root = fixture({ ...config(), env: { production: {} } });
    for (const args of [[...flags, "deploy"], ["deploy", ...flags]]) {
      const result = run(root, args);
      expect(result.status).toBe(1); expect(result.spawn).not.toHaveBeenCalled();
      expect(result.errors).toContain("REMOTE_D1_BINDING_MISSING");
    }
  });
  it.each([["--c", "custom.jsonc"], ["--c=custom.jsonc"]])("long config alias %j validates the same file Wrangler consumes", (...flags) => {
    const root = fixture(); writeFileSync(resolve(root, "custom.jsonc"), JSON.stringify({}));
    const result = run(root, ["deploy", ...flags]);
    expect(result.status).toBe(1); expect(result.spawn).not.toHaveBeenCalled();
    expect(result.errors).toContain("REMOTE_D1_BINDING_MISSING");
    expect(result.errors).toContain(resolve(root, "custom.jsonc"));
    expect(run(root, ["deploy", ...flags, "--config=wrangler.jsonc"]).spawn).not.toHaveBeenCalled();
  });
  it.each([["--dry-run", "--dryRun=false"], ["--dry-run", "--no-dryRun"], ["--dryRun=false"]])("Wrangler camel-case boolean aliases %j cannot negate a validated dry-run", (...flags) => {
    const result = run(fixture({}), ["deploy", ...flags]);
    expect(result.status).toBe(1); expect(result.spawn).not.toHaveBeenCalled();
  });
  it.each(["delete", "insights"])("D1 %s is remote even without --remote and cannot bypass ID validation", (command) => {
    const c = config(); delete (c.d1_databases[0] as any).database_id;
    const root = fixture(c);
    const result = run(root, ["d1", command, "db_boltlink", "--config=wrangler.jsonc"]);
    expect(result.status).toBe(1); expect(result.spawn).not.toHaveBeenCalled();
    expect(result.errors).toContain("REMOTE_D1_DATABASE_ID_MISSING");
  });
  it.each(["kv_namespaces", "r2_buckets", "services", "d1_databases"])("a removed member of %s cannot be confirmed away while another binding remains", (field) => {
    const before = { ...config(), [field]: [{ binding: "A", id: "synthetic-a" }, { binding: "B", id: "synthetic-b" }] };
    const after = { ...config(), [field]: [{ binding: "A", id: "synthetic-a" }] };
    expect(compareInstallationConfigs(before, after, [field]).status).toBe("BLOCKED");
    expect(compareInstallationConfigs(before, { ...after, [field]: [...after[field], { binding: "NEW", id: "synthetic-new" }] }, [field]).status).toBe("BLOCKED");
  });
  it.each([
    ["kv_namespaces", "id"], ["r2_buckets", "bucket_name"], ["services", "service"],
    ["d1_databases", "database_name"], ["d1_databases", "database_id"],
  ])("a removed identifier %s.%s requires correction even with category confirmation", (field, identifier) => {
    const before = { ...config(), [field]: [{ binding: "CUSTOM", [identifier]: "synthetic-target" }] };
    for (const missing of [undefined, "", "   ", null]) {
      const after = { ...config(), [field]: [{ binding: "CUSTOM", [identifier]: missing }] };
      expect(compareInstallationConfigs(before, after, [field]).status).toBe("BLOCKED");
    }
  });
  it("removed nested resources and environment bindings cannot be confirmed away", () => {
    const before = { ...config(), durable_objects: { bindings: [{ name: "OBJECT", class_name: "Custom" }] }, env: { production: config() } };
    const after = { ...before, durable_objects: { bindings: [] }, env: { production: { ...config(), d1_databases: [] } } };
    expect(compareInstallationConfigs(before, after, ["durable_objects", "env.production.d1_databases"]).status).toBe("BLOCKED");
  });
  it("resource reordering and an intentional target change still support explicit confirmation", () => {
    const before = { ...config(), kv_namespaces: [{ binding: "A", id: "old-a" }, { binding: "B", id: "old-b" }] };
    const after = { ...config(), kv_namespaces: [{ binding: "B", id: "old-b" }, { binding: "A", id: "new-a" }] };
    expect(compareInstallationConfigs(before, after).status).toBe("REQUIRES_EXPLICIT_CONFIRMATION");
    expect(compareInstallationConfigs(before, after, ["kv_namespaces"]).status).toBe("PASSED");
  });
  it("the comparison CLI rejects partial binding removal without logging identifiers", () => {
    const root = fixture({ ...config(), kv_namespaces: [{ binding: "A", id: "SYNTHETIC_PRIVATE_ID_A" }] });
    const before = resolve(root, "before.jsonc");
    writeFileSync(before, JSON.stringify({ ...config(), kv_namespaces: [{ binding: "A", id: "SYNTHETIC_PRIVATE_ID_A" }, { binding: "B", id: "SYNTHETIC_PRIVATE_ID_B" }] }));
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(runUpgradeConfigCheck(["--before", before, "--after", resolve(root, "wrangler.jsonc"), "--confirm-field=kv_namespaces"])).toBe(1);
    const output = logs.mock.calls.flat().join("\n");
    expect(output).toContain("BLOCKED"); expect(output).not.toContain("SYNTHETIC_PRIVATE_ID");
  });
  it.each([".env", ".env.local"])("%s cannot select an unvalidated environment after preflight", (filename) => {
    const root = fixture({ ...config(), env: { production: {} } });
    writeFileSync(resolve(root, filename), 'API_KEY=SYNTHETIC_PRIVATE_SECRET\nCLOUDFLARE_ENV=production\n');
    const blocked = run(root);
    expect(blocked.status).toBe(1); expect(blocked.spawn).not.toHaveBeenCalled();
    expect(blocked.errors).toContain("CONFIG_ENVIRONMENT_MUST_BE_EXPLICIT");
    expect(blocked.errors).not.toContain("SYNTHETIC_PRIVATE_SECRET");
    expect(run(root, [...migration, "--env=production"]).errors).toContain("REMOTE_D1_BINDING_MISSING");
    expect(run(root, [...migration, "--env="]).status).toBe(0);
  });
  it(".env.local precedence cannot hide its selector behind a normal .env", () => {
    const root = fixture();
    writeFileSync(resolve(root, ".env"), 'API_KEY=SYNTHETIC_PRIVATE_SECRET\n');
    writeFileSync(resolve(root, ".env.local"), 'CLOUDFLARE_ENV=production\n');
    const blocked = run(root); expect(blocked.status).toBe(1); expect(blocked.spawn).not.toHaveBeenCalled();
    expect(run(root, migration, { WORKERS_CI: "1", CLOUDFLARE_ENV: "" }).status).toBe(1);
    expect(run(root, migration, { WORKERS_CI: "1", CLOUDFLARE_ENV: "production" }).errors).toContain("CONFIG_ENVIRONMENT_MISSING");
  });
  it("ordinary .env.local values remain allowed and are never printed", () => {
    const root = fixture(); writeFileSync(resolve(root, ".env.local"), 'API_KEY=SYNTHETIC_PRIVATE_SECRET\n');
    const result = run(root); expect(result.status).toBe(0);
    expect(result.errors + result.logs).not.toContain("SYNTHETIC_PRIVATE_SECRET");
  });
});

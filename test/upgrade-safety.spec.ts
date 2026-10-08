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
  it.each(["missing", "valid", "migration-fails"])("reproduces the build end to end: %s", (scenario) => {
    const c = config(); if (scenario === "missing") delete (c.d1_databases[0] as any).database_id;
    const root = fixture(c, config(UUID_B));
    mkdirSync(resolve(root, "scripts")); mkdirSync(resolve(root, "node_modules/.bin"), { recursive: true });
    for (const file of ["wrangler.mjs", "wrangler-routing.mjs", "config-utils.mjs", "config-safety.mjs"]) cpSync(resolve("scripts", file), resolve(root, "scripts", file));
    writeFileSync(resolve(root, "package.json"), JSON.stringify({ scripts: pkg.scripts }));
    // No Wrangler dependency in the fixture. This executable only logs args;
    // it contains no network code and never invokes real Wrangler.
    const fake = resolve(root, "node_modules/.bin/wrangler");
    writeFileSync(fake, `#!${process.execPath}\nimport { appendFileSync } from "node:fs";\nconst args = process.argv.slice(2);\nappendFileSync("calls.jsonl", JSON.stringify(args) + "\\n");\nprocess.exit(args[0] === "d1" ? Number(process.env.MOCK_MIGRATION_EXIT) : 0);\n`);
    chmodSync(fake, 0o755);
    const result = spawnSync("npm", ["run", "deploy"], { cwd: root, encoding: "utf8", timeout: 20000,
      env: { ...process.env, WORKERS_CI: "1", MOCK_MIGRATION_EXIT: scenario === "migration-fails" ? "23" : "0" } });
    expect(result.error).toBeUndefined();
    const log = resolve(root, "calls.jsonl");
    const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
    if (scenario === "missing") {
      expect(result.status).toBe(1); expect(calls).toEqual([]);
      expect(result.stderr).toContain("REMOTE_D1_DATABASE_ID_MISSING"); expect(result.stderr).toContain(resolve(root, "wrangler.jsonc"));
    } else {
      expect(result.status).toBe(scenario === "valid" ? 0 : 23);
      expect(calls).toEqual(scenario === "valid" ? [
        [...migration, "--config", resolve(root, "wrangler.jsonc")], ["deploy", "--config", resolve(root, "wrangler.jsonc")],
      ] : [[...migration, "--config", resolve(root, "wrangler.jsonc")]]);
    }
  });
});

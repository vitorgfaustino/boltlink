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

// @vitest-environment node

import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { buildLocalConfig } from "../scripts/config-utils.mjs";
import { isWorkersBuildEnvironment, resolveWranglerExecution } from "../scripts/wrangler-routing.mjs";

const rootDir = "/workspace/boltlink";
const publicConfigPath = resolve(rootDir, "wrangler.jsonc");
const localConfigPath = resolve(rootDir, "wrangler.local.jsonc");

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const remoteMigrationArgs = ["d1", "migrations", "apply", "db_boltlink", "--remote"];

describe("3.1.1 deployment migration contract", () => {
	it("uses the binding and wrapper, and applies migrations before deployment with fail-closed chaining", () => {
		expect(pkg.scripts["db:migrations:apply"]).toBe("node scripts/wrangler.mjs d1 migrations apply db_boltlink --remote");
		expect(pkg.scripts.deploy).toBe("npm run db:migrations:apply && node scripts/wrangler.mjs deploy");
	});

	it("preserves the D1 migration directory and the complete frozen 0000–0006 chain", () => {
		const config = Function(`"use strict"; return (${readFileSync("wrangler.jsonc", "utf8")});`)();
		const binding = config.d1_databases.find((entry: { binding: string }) => entry.binding === "db_boltlink");
		expect(binding.migrations_dir).toBe("migrations");
		expect(pkg.scripts["db:migrations:apply"]).not.toContain(binding.database_name);
		expect(readdirSync("migrations").sort()).toEqual([
			"0000_initial_schema.sql", "0001_link_management.sql", "0002_advanced_features.sql",
			"0003_lgpd_minimization.sql", "0004_ab_testing.sql", "0005_smart_routing.sql", "0006_expired_redirect.sql",
		]);
	});

	it("keeps package and both lockfile versions at 3.2.0 and derives APP_VERSION from the package", () => {
		const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
		expect([pkg.version, lock.version, lock.packages[""].version]).toEqual(["3.2.0", "3.2.0", "3.2.0"]);
		expect(readFileSync("src/index.ts", "utf8")).toContain("const APP_VERSION = packageJson.version;");
	});

	it.each([0, 23])("runs the real npm chain with an isolated mock runner (migration exit %s)", (migrationExit) => {
		const directory = mkdtempSync(resolve(tmpdir(), "boltlink-deploy-test-"));
		try {
			mkdirSync(resolve(directory, "scripts"));
			writeFileSync(resolve(directory, "package.json"), JSON.stringify({ scripts: pkg.scripts }));
			// This fixture has no Wrangler dependency and cannot contact Cloudflare.
			writeFileSync(resolve(directory, "scripts/wrangler.mjs"), `
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync("calls.jsonl", JSON.stringify(args) + "\\n");
process.exit(args[0] === "d1" ? Number(process.env.MOCK_MIGRATION_EXIT) : 0);
`);
			const result = spawnSync("npm", ["run", "deploy"], {
				cwd: directory,
				env: { ...process.env, MOCK_MIGRATION_EXIT: String(migrationExit) },
				encoding: "utf8",
				timeout: 15_000,
				shell: process.platform === "win32",
			});
			expect(result.error).toBeUndefined();
			expect(result.status).toBe(migrationExit);
			const calls = readFileSync(resolve(directory, "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
			expect(calls).toEqual(migrationExit === 0 ? [remoteMigrationArgs, ["deploy"]] : [remoteMigrationArgs]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("wrangler wrapper routing", () => {
	it("detects Workers Builds via WORKERS_CI", () => {
		expect(isWorkersBuildEnvironment({ WORKERS_CI: "1" })).toBe(true);
		expect(isWorkersBuildEnvironment({ CI: "true" })).toBe(false);
	});

	it("uses the public template for type generation", () => {
		const result = resolveWranglerExecution({
			args: ["types"],
			rootDir,
			hasLocalConfig: true,
		});

		expect(result).toMatchObject({
			configPath: publicConfigPath,
			shouldSyncLocalConfig: false,
			args: ["types", "--config", publicConfigPath],
		});
	});

	it("uses the local config for deploy when it exists", () => {
		const result = resolveWranglerExecution({
			args: ["deploy"],
			rootDir,
			hasLocalConfig: true,
		});

		expect(result).toMatchObject({
			configPath: localConfigPath,
			shouldSyncLocalConfig: true,
			args: ["deploy", "--config", localConfigPath],
		});
	});

	it("uses the public template for deploy in Workers Builds when local config is absent", () => {
		const result = resolveWranglerExecution({
			args: ["deploy"],
			rootDir,
			hasLocalConfig: false,
			env: { WORKERS_CI: "1" },
		});

		expect(result).toMatchObject({
			configPath: publicConfigPath,
			shouldSyncLocalConfig: false,
			args: ["deploy", "--config", publicConfigPath],
		});
		expect(result.warningMessage).toContain("WORKERS_CI=1");
	});

	it("keeps local deploy protected when local config is absent", () => {
		const result = resolveWranglerExecution({
			args: ["deploy"],
			rootDir,
			hasLocalConfig: false,
			env: {},
		});

		expect(result.errorMessage).toContain("wrangler.local.jsonc");
		expect(result.errorMessage).toContain("--config wrangler.jsonc");
	});

	it("keeps D1 commands bound to the local config", () => {
		const result = resolveWranglerExecution({
			args: ["d1", "list"],
			rootDir,
			hasLocalConfig: false,
			env: { WORKERS_CI: "1" },
		});

		expect(result.errorMessage).toContain("before using D1 commands");
	});

	it("routes remote migration apply to the provisioned public binding in Workers Builds", () => {
		const result = resolveWranglerExecution({ args: remoteMigrationArgs, rootDir, hasLocalConfig: false, env: { WORKERS_CI: "1" } });
		expect(result).toMatchObject({ configPath: publicConfigPath, shouldSyncLocalConfig: false, args: [...remoteMigrationArgs, "--config", publicConfigPath] });
	});

	it("uses the same local configuration for remote migrations and deploy", () => {
		for (const args of [remoteMigrationArgs, ["deploy"]]) {
			const result = resolveWranglerExecution({ args, rootDir, hasLocalConfig: true, env: {} });
			expect(result).toMatchObject({ configPath: localConfigPath, shouldSyncLocalConfig: true, args: [...args, "--config", localConfigPath] });
		}
	});

	it.each([{}, { CI: "true" }])("requires private config for remote migration apply outside Workers Builds (%j)", (env) => {
		const result = resolveWranglerExecution({ args: remoteMigrationArgs, rootDir, hasLocalConfig: false, env });
		expect(result.errorMessage).toContain("wrangler.local.jsonc");
	});

	it.each([
		["d1", "execute", "db_boltlink", "--remote"],
		["d1", "migrations", "apply", "db_boltlink", "--local"],
		[...remoteMigrationArgs, "--local"],
		[...remoteMigrationArgs, "--preview"],
		["d1", "migrations", "apply", "another-binding", "--remote"],
	])("keeps unrelated D1 commands protected in Workers Builds: %j", (...args) => {
		const result = resolveWranglerExecution({ args, rootDir, hasLocalConfig: false, env: { WORKERS_CI: "1" } });
		expect(result.errorMessage).toContain("wrangler.local.jsonc");
	});

	it("preserves explicit config on remote migration apply", () => {
		const args = [...remoteMigrationArgs, "-c", "custom.jsonc"];
		const result = resolveWranglerExecution({ args, rootDir, hasLocalConfig: false, env: { WORKERS_CI: "1" } });
		expect(result).toMatchObject({ args, configPath: resolve(rootDir, "custom.jsonc"), shouldSyncLocalConfig: false });
	});

	it("does not override an explicit --config argument", () => {
		const result = resolveWranglerExecution({
			args: ["deploy", "--config", "wrangler.jsonc"],
			rootDir,
			hasLocalConfig: false,
		});

		expect(result).toMatchObject({
			configPath: publicConfigPath,
			shouldSyncLocalConfig: false,
			args: ["deploy", "--config", "wrangler.jsonc"],
		});
	});

	it("supports preview uploads in Workers Builds without local config", () => {
		const result = resolveWranglerExecution({
			args: ["versions", "upload"],
			rootDir,
			hasLocalConfig: false,
			env: { WORKERS_CI: "1" },
		});

		expect(result).toMatchObject({
			configPath: publicConfigPath,
			args: ["versions", "upload", "--config", publicConfigPath],
		});
	});
});

describe("wrangler local config sync", () => {
	it("enables keep_vars by default in the local config to preserve dashboard values", () => {
		const localConfig = buildLocalConfig({
			name: "boltlink",
			keep_vars: true,
			vars: { TEAM_DOMAIN: "", POLICY_AUD: "" },
		});

		expect(localConfig.keep_vars).toBe(true);
	});

	it("preserves an explicit local keep_vars override", () => {
		const localConfig = buildLocalConfig(
			{ name: "boltlink", keep_vars: true, vars: { TEAM_DOMAIN: "", POLICY_AUD: "" } },
			{ keep_vars: true, vars: { TEAM_DOMAIN: "https://team.example.com", POLICY_AUD: "aud" } },
		);

		expect(localConfig.keep_vars).toBe(true);
		expect(localConfig.vars).toEqual({ TEAM_DOMAIN: "https://team.example.com", POLICY_AUD: "aud" });
	});

	it("preserves project-specific local worker settings like name and routes", () => {
		const localConfig = buildLocalConfig(
			{
				name: "boltlink",
				workers_dev: true,
				routes: [],
				keep_vars: true,
			},
			{
				name: "encurtador-url",
				workers_dev: false,
				routes: [{ pattern: "links.example.com", custom_domain: true }],
			},
		);

		expect(localConfig.name).toBe("encurtador-url");
		expect(localConfig.workers_dev).toBe(false);
		expect(localConfig.routes).toEqual([{ pattern: "links.example.com", custom_domain: true }]);
	});

	it("preserves custom D1 bindings and database names during local sync", () => {
		const localConfig = buildLocalConfig(
			{
				d1_databases: [
					{
						binding: "db_boltlink",
						database_name: "boltlink-db",
						migrations_dir: "migrations",
						database_id: "00000000-0000-0000-0000-000000000000",
					},
				],
			},
			{
				d1_databases: [
					{
						binding: "db-encurtador-url",
						database_name: "encurtador-url-db",
						migrations_dir: "migrations",
						database_id: "11111111-1111-1111-1111-111111111111",
					},
				],
			},
		);

		expect(localConfig.d1_databases).toEqual([
			{
				binding: "db-encurtador-url",
				database_name: "encurtador-url-db",
				migrations_dir: "migrations",
				database_id: "11111111-1111-1111-1111-111111111111",
			},
		]);
	});
});

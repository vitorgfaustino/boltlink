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
import { buildLocalConfig } from "../scripts/config-utils.mjs";
import { isWorkersBuildEnvironment, resolveWranglerExecution } from "../scripts/wrangler-routing.mjs";

const rootDir = "/workspace/boltlink";
const publicConfigPath = resolve(rootDir, "wrangler.jsonc");
const localConfigPath = resolve(rootDir, "wrangler.local.jsonc");

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

	it("does not override an explicit --config argument", () => {
		const result = resolveWranglerExecution({
			args: ["deploy", "--config", "wrangler.jsonc"],
			rootDir,
			hasLocalConfig: false,
		});

		expect(result).toMatchObject({
			configPath: null,
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
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
 */

import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { buildLocalConfig, ensureLocalConfigSynced, parseJsoncConfig, resolveProjectPaths } from "./config-utils.mjs";
import { resolveWranglerExecution } from "./wrangler-routing.mjs";
import { formatPreflightFailure, requiresRemoteD1Preflight, validateRemoteD1Config } from "./config-safety.mjs";

export function runWranglerCli({
	args = process.argv.slice(2),
	rootDir = process.cwd(),
	env = process.env,
	spawn = spawnSync,
} = {}) {
	const checkOnly = args[0] === "boltlink-preflight";
	if (checkOnly) args = ["d1", "migrations", "apply", "db_boltlink", "--remote", ...args.slice(1)];
	const { publicConfigPath, localConfigPath } = resolveProjectPaths(rootDir);
	const execution = resolveWranglerExecution({
		args,
		rootDir,
		env,
		hasLocalConfig: existsSync(localConfigPath),
		publicConfigPath,
		localConfigPath,
	});

	if (execution.errorMessage) {
		console.error(execution.errorMessage);
		return 1;
	}

	try {
		if (requiresRemoteD1Preflight(execution)) {
			let config = parseJsoncConfig(execution.configPath);
			if (execution.shouldSyncLocalConfig) config = buildLocalConfig(parseJsoncConfig(publicConfigPath), config);
			const reason = validateRemoteD1Config({ config, configPath: execution.configPath, rootDir, args, env });
			if (reason) {
				console.error(formatPreflightFailure(reason, execution.configPath, env));
				return 1;
			}
		}
		if (checkOnly) {
			console.log(`BOLTLINK DEPLOY PREFLIGHT PASSED\nConfig used: ${execution.configPath}`);
			return 0;
		}
		if (execution.shouldSyncLocalConfig) ensureLocalConfigSynced(rootDir);
	} catch {
		console.error(formatPreflightFailure("CONFIG_UNREADABLE_OR_INVALID", execution.configPath, env));
		return 1;
	}

	if (execution.warningMessage) {
		console.warn(execution.warningMessage);
	}

	const result = spawn("wrangler", execution.args, {
		stdio: "inherit",
		cwd: rootDir,
		shell: process.platform === "win32",
		env,
	});

	return result.status ?? 1;
}

const isMainModule = process.argv[1]
	? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
	: false;

if (isMainModule) {
	process.exit(runWranglerCli());
}

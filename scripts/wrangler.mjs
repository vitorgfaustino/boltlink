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
import { ensureLocalConfigSynced, resolveProjectPaths } from "./config-utils.mjs";
import { resolveWranglerExecution } from "./wrangler-routing.mjs";

export function runWranglerCli({
	args = process.argv.slice(2),
	rootDir = process.cwd(),
	env = process.env,
} = {}) {
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

	if (execution.shouldSyncLocalConfig) {
		ensureLocalConfigSynced(rootDir);
	}

	if (execution.warningMessage) {
		console.warn(execution.warningMessage);
	}

	const result = spawnSync("wrangler", execution.args, {
		stdio: "inherit",
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

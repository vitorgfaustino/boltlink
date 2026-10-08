/**
 * Copyright (c) 2026 Vitor Faustino
 *
 * This file is part of BoltLink.
 *
 * BoltLink is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * BoltLink is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with BoltLink. If not, see <https://www.gnu.org/licenses/>.
 */

import { resolve } from "node:path";
import { parseJsoncConfig } from "./config-utils.mjs";

export function isWorkersBuildEnvironment(env = process.env) {
	return env.WORKERS_CI === "1";
}

export function readOption(args, names) {
	const values = [];
	for (let i = 0; i < args.length; i++) {
		const name = names.find((n) => args[i] === n || args[i].startsWith(`${n}=`));
		if (!name) continue;
		const value = args[i] === name ? args[++i] : args[i].slice(name.length + 1);
		if (!value || value.startsWith("-")) throw new Error("CONFIG_OPTION_INVALID");
		values.push(value);
	}
	if (values.length > 1) throw new Error("CONFIG_OPTION_AMBIGUOUS");
	return values[0];
}

function validateLocalConfig(localConfigPath) {
	const warnings = [];
	let config;
	try {
		config = parseJsoncConfig(localConfigPath);
	} catch {
		return warnings;
	}

	if (!config) {
		return warnings;
	}

	// Check for empty vars that would overwrite dashboard values
	if (config.vars && typeof config.vars === "object") {
		const emptyVars = Object.entries(config.vars)
			.filter(([, value]) => value === "" || value === null || value === undefined)
			.map(([key]) => key);

		if (emptyVars.length > 0) {
			warnings.push(
				`WARNING: wrangler.local.jsonc has empty vars: ${emptyVars.join(", ")}. ` +
				`These will overwrite dashboard values during local deploy. ` +
				`Remove them from the local config if you use GitHub auto-deploy, ` +
				`or fill them with real values if you deploy locally.`
			);
		}
	}

	// Check keep_vars
	if (config.keep_vars === false) {
		warnings.push(
			`WARNING: keep_vars is false in wrangler.local.jsonc. ` +
			`Local deploys will OVERWRITE dashboard variables. ` +
			`Set keep_vars to true to preserve dashboard values.`
		);
	}

	return warnings;
}

export function resolveWranglerExecution({
	args,
	rootDir,
	env = process.env,
	hasLocalConfig,
	publicConfigPath,
	localConfigPath,
}) {
	if (args.length === 0) {
		return {
			errorMessage: "Usage: npm run wrangler -- <wrangler arguments>",
		};
	}

	const command = args[0];
	let explicitConfig;
	try {
		explicitConfig = readOption(args, ["--config", "-c"]);
		// A different working directory would change config/path resolution.
		// Require callers to run in that directory instead of guessing.
		if (readOption(args, ["--cwd"])) throw new Error("CONFIG_CWD_UNSUPPORTED");
	} catch (error) {
		return { errorMessage: error.message };
	}
	const hasExplicitConfig = explicitConfig !== undefined;
	const resolvedPublicConfigPath = publicConfigPath ?? `${rootDir}/wrangler.jsonc`;
	const resolvedLocalConfigPath = localConfigPath ?? `${rootDir}/wrangler.local.jsonc`;

	if (hasExplicitConfig) {
		return {
			args,
			command,
			hasExplicitConfig,
			configPath: resolve(rootDir, explicitConfig),
			shouldSyncLocalConfig: false,
		};
	}

	if (command === "types") {
		return {
			args: [...args, "--config", resolvedPublicConfigPath],
			command,
			hasExplicitConfig,
			configPath: resolvedPublicConfigPath,
			shouldSyncLocalConfig: false,
		};
	}

	if (command === "d1") {
		const isRemoteMigrationApply = args[1] === "migrations"
			&& args[2] === "apply" && args[3] === "db_boltlink"
			&& args.includes("--remote") && !args.includes("--local") && !args.includes("--preview");
		if (isWorkersBuildEnvironment(env) && isRemoteMigrationApply) {
			return { args: [...args, "--config", resolvedPublicConfigPath], command, hasExplicitConfig,
				configPath: resolvedPublicConfigPath, shouldSyncLocalConfig: false };
		}
		if (!hasLocalConfig) {
			// The Deploy Button provisions D1 before running the deploy script.
			// Permit only its remote migration apply in Workers Builds; local
			// development and other D1 operations still require private config.
			return {
				errorMessage:
					"Missing wrangler.local.jsonc. Run `npm run wrangler:init` first before using D1 commands.",
			};
		}

		return {
			args: [...args, "--config", resolvedLocalConfigPath],
			command,
			hasExplicitConfig,
			configPath: resolvedLocalConfigPath,
			shouldSyncLocalConfig: true,
		};
	}

	if (command === "deploy" || command === "versions") {
		if (hasLocalConfig && !isWorkersBuildEnvironment(env)) {
			const validationWarnings = validateLocalConfig(resolvedLocalConfigPath);
			return {
				args: [...args, "--config", resolvedLocalConfigPath],
				command,
				hasExplicitConfig,
				configPath: resolvedLocalConfigPath,
				shouldSyncLocalConfig: true,
				warningMessage: validationWarnings.length > 0 ? validationWarnings.join("\n") : undefined,
			};
		}

		if (isWorkersBuildEnvironment(env)) {
			return {
				args: [...args, "--config", resolvedPublicConfigPath],
				command,
				hasExplicitConfig,
				configPath: resolvedPublicConfigPath,
				shouldSyncLocalConfig: false,
				warningMessage:
					"Using wrangler.jsonc because WORKERS_CI=1. Private local config does not select the build target.",
			};
		}

		return {
			errorMessage:
				"Missing wrangler.local.jsonc. Run `npm run wrangler:init` first, or pass `--config wrangler.jsonc` for an explicit public-template deploy.",
		};
	}

	if (hasLocalConfig) {
		return {
			args: [...args, "--config", resolvedLocalConfigPath],
			command,
			hasExplicitConfig,
			configPath: resolvedLocalConfigPath,
			shouldSyncLocalConfig: true,
		};
	}

	return {
		args: [...args, "--config", resolvedPublicConfigPath],
		command,
		hasExplicitConfig,
		configPath: resolvedPublicConfigPath,
		shouldSyncLocalConfig: false,
	};
}

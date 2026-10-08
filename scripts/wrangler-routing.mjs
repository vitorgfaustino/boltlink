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
import { existsSync, readFileSync, statSync } from "node:fs";
import { parseJsoncConfig } from "./config-utils.mjs";

export function isWorkersBuildEnvironment(env = process.env) {
	return env.WORKERS_CI === "1";
}

export function readOption(args, names, { allowEmpty = false } = {}) {
	const values = [];
	for (let i = 0; i < args.length; i++) {
		const name = names.find((n) => args[i] === n || args[i].startsWith(`${n}=`) || (n.length === 2 && args[i].startsWith(n)));
		if (!name) continue;
		const value = args[i] === name ? args[++i] : args[i].slice(name.length + (args[i][name.length] === "=" ? 1 : 0));
		if (value === undefined || (!allowEmpty && value === "") || value.startsWith("-")) throw new Error("CONFIG_OPTION_INVALID");
		values.push(value);
	}
	if (values.length > 1) throw new Error("CONFIG_OPTION_AMBIGUOUS");
	return values[0];
}

function requireExplicitEnvironmentWhenNeeded(args, rootDir, env) {
	if (readOption(args, ["--env", "-e", "--e"], { allowEmpty: true }) !== undefined || env.CLOUDFLARE_ENV) return;
	// Wrangler loads dotenv before selecting its environment. Do not guess an
	// operational target from private files or duplicate Wrangler's expansion.
	if (args.some((arg) => ["--env-file", "--envFile"].some((option) => arg === option || arg.startsWith(`${option}=`)))) throw new Error("CONFIG_ENVIRONMENT_MUST_BE_EXPLICIT");
	// Wrangler loads both default files before resolving CLOUDFLARE_ENV.
	for (const filename of [".env", ".env.local"]) {
		const dotenv = resolve(rootDir, filename);
		if (!existsSync(dotenv)) continue;
		if (!statSync(dotenv).isFile()) throw new Error("CONFIG_ENVIRONMENT_FILE_INVALID");
		if (/^\s*(?:export\s+)?CLOUDFLARE_ENV\s*(?:=|:\s)/m.test(readFileSync(dotenv, "utf8"))) throw new Error("CONFIG_ENVIRONMENT_MUST_BE_EXPLICIT");
	}
}

export function readBooleanOption(args, name) {
	const values = [];
	const spellings = new Set([name, name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())]);
	for (let i = 0; i < args.length; i++) {
		const spelling = [...spellings].find((value) => args[i] === `--no-${value}` || args[i] === `--${value}` || args[i].startsWith(`--${value}=`));
		if (!spelling) continue;
		if (args[i] === `--no-${spelling}`) values.push(false);
		else if (args[i] === `--${spelling}`) {
			const next = args[i + 1];
			values.push(next === "false" ? false : true);
			if (next === "true" || next === "false") i++;
		} else if (args[i].startsWith(`--${spelling}=`)) {
			const value = args[i].slice(spelling.length + 3);
			if (!["true", "false"].includes(value)) throw new Error("CONFIG_BOOLEAN_OPTION_INVALID");
			values.push(value === "true");
		}
	}
	if (values.length > 1) throw new Error("CONFIG_BOOLEAN_OPTION_AMBIGUOUS");
	return values[0];
}

function inspectWranglerArguments(args) {
	const commandArgs = [];
	const valueOptions = ["--config", "-c", "--c", "--env", "-e", "--e", "--cwd", "--log-level", "--env-file", "--envFile"];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") throw new Error("CONFIG_ARGUMENT_SEPARATOR_UNSUPPORTED");
		if (valueOptions.includes(arg)) { i++; continue; }
		if (valueOptions.some((name) => arg.startsWith(`${name}=`))) continue;
		if (valueOptions.some((name) => name.length === 2 && arg.startsWith(name))) continue;
		if (/^--(?:no-)?(?:remote|local|preview|dry-run|dryRun)(?:=|$)/.test(arg)) {
			if (["true", "false"].includes(args[i + 1]) && !arg.includes("=")) i++;
			continue;
		}
		if (arg.startsWith("-")) {
			if (!commandArgs.length && !["--help", "-h", "--version", "-v"].includes(arg)) throw new Error("CONFIG_GLOBAL_OPTION_UNSUPPORTED");
			continue;
		}
		commandArgs.push(arg);
	}
	return {
		commandArgs,
		command: commandArgs[0],
		remote: readBooleanOption(args, "remote"),
		local: readBooleanOption(args, "local"),
		preview: readBooleanOption(args, "preview"),
		dryRun: readBooleanOption(args, "dry-run"),
	};
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

	let inspection;
	let explicitConfig;
	try {
		inspection = inspectWranglerArguments(args);
		explicitConfig = readOption(args, ["--config", "-c", "--c"]);
		readOption(args, ["--env", "-e", "--e"], { allowEmpty: true });
		requireExplicitEnvironmentWhenNeeded(args, rootDir, env);
		// A different working directory would change config/path resolution.
		// Require callers to run in that directory instead of guessing.
		if (readOption(args, ["--cwd"])) throw new Error("CONFIG_CWD_UNSUPPORTED");
	} catch (error) {
		return { errorMessage: `${error.message}\nUse unambiguous Wrangler flags from the project root. See docs/upgrading.md.` };
	}
	const { command, commandArgs, remote, local, preview } = inspection;
	const routed = (result) => ({ ...inspection, ...result });
	const hasExplicitConfig = explicitConfig !== undefined;
	const resolvedPublicConfigPath = publicConfigPath ?? `${rootDir}/wrangler.jsonc`;
	const resolvedLocalConfigPath = localConfigPath ?? `${rootDir}/wrangler.local.jsonc`;

	if (hasExplicitConfig) {
		return routed({
			args,
			command,
			hasExplicitConfig,
			configPath: resolve(rootDir, explicitConfig),
			shouldSyncLocalConfig: false,
		});
	}

	if (command === "types") {
		return routed({
			args: [...args, "--config", resolvedPublicConfigPath],
			command,
			hasExplicitConfig,
			configPath: resolvedPublicConfigPath,
			shouldSyncLocalConfig: false,
		});
	}

	if (command === "d1") {
		const isRemoteMigrationApply = commandArgs[1] === "migrations"
			&& commandArgs[2] === "apply" && commandArgs[3] === "db_boltlink"
			&& remote === true && local !== true && preview !== true;
		if (isWorkersBuildEnvironment(env) && isRemoteMigrationApply) {
			return routed({ args: [...args, "--config", resolvedPublicConfigPath], command, hasExplicitConfig,
				configPath: resolvedPublicConfigPath, shouldSyncLocalConfig: false });
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

		return routed({
			args: [...args, "--config", resolvedLocalConfigPath],
			command,
			hasExplicitConfig,
			configPath: resolvedLocalConfigPath,
			shouldSyncLocalConfig: true,
		});
	}

	if (command === "deploy" || command === "versions") {
		if (hasLocalConfig && !isWorkersBuildEnvironment(env)) {
			const validationWarnings = validateLocalConfig(resolvedLocalConfigPath);
			return routed({
				args: [...args, "--config", resolvedLocalConfigPath],
				command,
				hasExplicitConfig,
				configPath: resolvedLocalConfigPath,
				shouldSyncLocalConfig: true,
				warningMessage: validationWarnings.length > 0 ? validationWarnings.join("\n") : undefined,
			});
		}

		if (isWorkersBuildEnvironment(env)) {
			return routed({
				args: [...args, "--config", resolvedPublicConfigPath],
				command,
				hasExplicitConfig,
				configPath: resolvedPublicConfigPath,
				shouldSyncLocalConfig: false,
				warningMessage:
					"Using wrangler.jsonc because WORKERS_CI=1. Private local config does not select the build target.",
			});
		}

		return routed({
			errorMessage:
				"Missing wrangler.local.jsonc. Run `npm run wrangler:init` first, or pass `--config wrangler.jsonc` for an explicit public-template deploy.",
		});
	}

	if (hasLocalConfig) {
		return routed({
			args: [...args, "--config", resolvedLocalConfigPath],
			command,
			hasExplicitConfig,
			configPath: resolvedLocalConfigPath,
			shouldSyncLocalConfig: true,
		});
	}

	return routed({
		args: [...args, "--config", resolvedPublicConfigPath],
		command,
		hasExplicitConfig,
		configPath: resolvedPublicConfigPath,
		shouldSyncLocalConfig: false,
	});
}

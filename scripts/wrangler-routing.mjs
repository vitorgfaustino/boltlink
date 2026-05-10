import { readFileSync } from "node:fs";

export function isWorkersBuildEnvironment(env = process.env) {
	return env.WORKERS_CI === "1";
}

function parseJsoncConfig(filePath) {
	const source = readFileSync(filePath, "utf8");
	try {
		return Function(`"use strict"; return (${source});`)();
	} catch {
		return null;
	}
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
	const hasExplicitConfig = args.includes("--config") || args.includes("-c");
	const resolvedPublicConfigPath = publicConfigPath ?? `${rootDir}/wrangler.jsonc`;
	const resolvedLocalConfigPath = localConfigPath ?? `${rootDir}/wrangler.local.jsonc`;

	if (hasExplicitConfig) {
		return {
			args,
			command,
			hasExplicitConfig,
			configPath: null,
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
		if (!hasLocalConfig) {
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
		if (hasLocalConfig) {
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
					"Using wrangler.jsonc because WORKERS_CI=1 and wrangler.local.jsonc is not available in this build environment.",
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

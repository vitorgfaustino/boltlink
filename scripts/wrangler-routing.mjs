export function isWorkersBuildEnvironment(env = process.env) {
	return env.WORKERS_CI === "1";
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
			return {
				args: [...args, "--config", resolvedLocalConfigPath],
				command,
				hasExplicitConfig,
				configPath: resolvedLocalConfigPath,
				shouldSyncLocalConfig: true,
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
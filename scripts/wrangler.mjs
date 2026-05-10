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
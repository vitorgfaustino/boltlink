import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function isPlainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsoncConfig(filePath) {
	const source = readFileSync(filePath, "utf8");
	try {
		return Function(`"use strict"; return (${source});`)();
	} catch (error) {
		throw new Error(`Failed to parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function mergeConfigValue(baseValue, overrideValue) {
	if (overrideValue === undefined) {
		return baseValue;
	}

	if (Array.isArray(baseValue) && Array.isArray(overrideValue)) {
		if (
			baseValue.length === overrideValue.length &&
			baseValue.every(isPlainObject) &&
			overrideValue.every(isPlainObject)
		) {
			return overrideValue.map((value, index) => mergeConfigValue(baseValue[index], value));
		}

		return overrideValue;
	}

	if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
		const merged = { ...baseValue };
		for (const [key, value] of Object.entries(overrideValue)) {
			merged[key] = mergeConfigValue(baseValue[key], value);
		}
		return merged;
	}

	return overrideValue;
}

export function resolveProjectPaths(rootDir) {
	return {
		publicConfigPath: resolve(rootDir, "wrangler.jsonc"),
		localConfigPath: resolve(rootDir, "wrangler.local.jsonc"),
		redirectPath: resolve(rootDir, ".wrangler/deploy/config.json"),
	};
}

export function buildLocalConfig(publicConfig, localConfig = {}) {
	const mergedConfig = Object.keys(localConfig).length > 0
		? mergeConfigValue(publicConfig, localConfig)
		: { ...publicConfig };

	if (localConfig.keep_vars === undefined) {
		mergedConfig.keep_vars = false;
	}

	return mergedConfig;
}

export function ensureLocalConfigSynced(rootDir) {
	const { publicConfigPath, localConfigPath, redirectPath } = resolveProjectPaths(rootDir);

	if (!existsSync(publicConfigPath)) {
		throw new Error("Missing wrangler.jsonc in the project root.");
	}

	const publicConfig = parseJsoncConfig(publicConfigPath);
	const hadLocalConfig = existsSync(localConfigPath);
	const localConfig = hadLocalConfig ? parseJsoncConfig(localConfigPath) : {};
	const mergedConfig = buildLocalConfig(publicConfig, localConfig);

	mkdirSync(dirname(localConfigPath), { recursive: true });
	writeFileSync(localConfigPath, `${JSON.stringify(mergedConfig, null, "\t")}\n`);

	mkdirSync(dirname(redirectPath), { recursive: true });
	writeFileSync(redirectPath, `${JSON.stringify({ configPath: "../../wrangler.local.jsonc" }, null, 2)}\n`);

	return {
		created: !hadLocalConfig,
		localConfigPath,
	};
}
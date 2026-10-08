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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function isPlainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseJsoncConfig(filePath) {
	// JSONC is data, never executable JavaScript. Keep quoted URLs and secrets
	// intact while removing comments and trailing commas outside strings.
	const source = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
	let json = "";
	let inString = false;
	let escaped = false;
	for (let i = 0; i < source.length; i++) {
		const char = source[i];
		if (inString) {
			json += char;
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
		} else if (char === '"') {
			inString = true;
			json += char;
		} else if (char === "/" && source[i + 1] === "/") {
			while (i < source.length && source[i] !== "\n") i++;
			json += "\n";
		} else if (char === "/" && source[i + 1] === "*") {
			const end = source.indexOf("*/", i + 2);
			if (end < 0) throw new Error("CONFIG_INVALID_JSONC");
			i = end + 1;
			json += " ";
		} else json += char;
	}
	inString = false;
	escaped = false;
	let cleaned = "";
	for (let i = 0; i < json.length; i++) {
		const char = json[i];
		if (!inString && char === "," && /^\s*[}\]]/.test(json.slice(i + 1))) continue;
		cleaned += char;
		if (escaped) escaped = false;
		else if (inString && char === "\\") escaped = true;
		else if (char === '"') inString = !inString;
	}
	try {
		const config = JSON.parse(cleaned);
		if (!isPlainObject(config)) throw new Error();
		return config;
	} catch {
		// Parser errors can contain config values, including secrets.
		throw new Error("CONFIG_INVALID_JSONC");
	}
}

function mergeConfigValue(baseValue, overrideValue) {
	if (overrideValue === undefined) {
		return baseValue;
	}

	if (Array.isArray(baseValue) && Array.isArray(overrideValue)) {
		// Only inherit defaults from the SAME binding. Local membership/order is
		// authoritative: never add an upstream resource or merge by position.
		if ([...baseValue, ...overrideValue].every((v) => isPlainObject(v) && typeof v.binding === "string")) {
			for (const entries of [baseValue, overrideValue]) {
				if (new Set(entries.map((v) => v.binding)).size !== entries.length) {
					throw new Error("CONFIG_BINDING_AMBIGUOUS");
				}
			}
			return overrideValue.map((value) => mergeConfigValue(baseValue.find((base) => base.binding === value.binding), value));
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
		mergedConfig.keep_vars = true;
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

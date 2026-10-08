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

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function isPlainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseJsoncConfig(filePath) {
	// JSONC is data, never executable JavaScript. Keep quoted URLs and secrets
	// intact while removing comments and trailing commas outside strings.
	if (!statSync(filePath).isFile()) throw new Error("CONFIG_NOT_REGULAR_FILE");
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
		// JSON.parse would silently keep the last duplicate key. Reject that
		// ambiguity, including escaped spellings of the same property name.
		const stack = [];
		for (const token of cleaned.match(/"(?:\\.|[^"\\])*"|[{}\[\],:]/g) ?? []) {
			const current = stack.at(-1);
			if (token === "{") stack.push({ keys: new Set(), expectingKey: true });
			else if (token === "[") stack.push({});
			else if (token === "}" || token === "]") stack.pop();
			else if (token === "," && current?.keys) current.expectingKey = true;
			else if (token === ":" && current?.keys) current.expectingKey = false;
			else if (token.startsWith('"') && current?.expectingKey) {
				const key = JSON.parse(token);
				if (current.keys.has(key)) throw new Error();
				current.keys.add(key);
			}
		}
		const config = JSON.parse(cleaned);
		if (!isPlainObject(config)) throw new Error();
		return config;
	} catch {
		// Parser errors can contain config values, including secrets.
		throw new Error("CONFIG_INVALID_JSONC");
	}
}

export function validateConfigBindings(config) {
	function visit(value, path = "") {
		if (Array.isArray(value)) {
			const key = path.endsWith("durable_objects.bindings") ? "name" : "binding";
			if (value.some((entry) => isPlainObject(entry) && Object.hasOwn(entry, key))
				&& !value.every((entry) => isPlainObject(entry) && typeof entry[key] === "string" && entry[key].trim())) throw new Error("CONFIG_BINDING_INVALID");
			if (value.length && value.every((entry) => isPlainObject(entry) && typeof entry[key] === "string")) {
				if (new Set(value.map((entry) => entry[key])).size !== value.length) throw new Error("CONFIG_BINDING_AMBIGUOUS");
			}
			for (const entry of value) visit(entry, path);
		} else if (isPlainObject(value)) {
			for (const [key, entry] of Object.entries(value)) {
				// Variables/defines are application data rather than resource lists.
				if (key !== "vars" && key !== "define") visit(entry, `${path ? path + "." : ""}${key}`);
			}
		}
	}
	visit(config);
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
			return overrideValue.map((value) => {
				const base = baseValue.find((entry) => entry.binding === value.binding);
				if (!base) return value;
				const defaults = { ...base };
				// A matching binding is not proof of the same remote resource. An
				// existing local entry must carry its own target identifiers/names.
				for (const key of ["database_id", "database_name", "preview_database_id", "id", "preview_id", "bucket_name", "preview_bucket_name", "jurisdiction", "service", "environment", "queue", "class_name", "script_name", "namespace_id", "index_name"]) {
					if (!Object.hasOwn(value, key)) delete defaults[key];
				}
				return mergeConfigValue(defaults, value);
			});
		}

		return overrideValue;
	}

	if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
		const merged = { ...baseValue };
		for (const [key, value] of Object.entries(overrideValue)) {
			Object.defineProperty(merged, key, { value: mergeConfigValue(baseValue[key], value), enumerable: true, writable: true, configurable: true });
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
	validateConfigBindings(publicConfig);
	validateConfigBindings(localConfig);
	const mergedConfig = Object.keys(localConfig).length > 0
		? mergeConfigValue(publicConfig, localConfig)
		: { ...publicConfig };

	if (localConfig.keep_vars === undefined) {
		mergedConfig.keep_vars = true;
	}
	validateConfigBindings(mergedConfig);

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

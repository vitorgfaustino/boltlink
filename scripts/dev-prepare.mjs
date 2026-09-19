#!/usr/bin/env node

/**
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
 * DISCLAIMER / ISENÇÃO DE RESPONSABILIDADE:
 * This software is provided "as is", without warranty of any kind.
 * Vitor Faustino (vitorfaustino.com.br) is not liable for any damages,
 * losses, or inaccurate results arising from the use of this software.
 *
 * ---
 * Prepares the LOCAL D1 database used by `wrangler dev` by applying the
 * versioned migrations. The auxiliary SQLite database at .dev-env/db.sqlite3 is
 * a separate artifact prepared by `npm run dev-init` and is NOT used by the
 * Worker.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureLocalConfigSynced, resolveProjectPaths } from "./config-utils.mjs";
import { runWranglerCli } from "./wrangler.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");

function readConfiguredDatabaseName() {
	const { publicConfigPath, localConfigPath } = resolveProjectPaths(rootDir);
	const configPath = existsSync(localConfigPath) ? localConfigPath : publicConfigPath;
	const source = readFileSync(configPath, "utf8");
	const config = Function(`"use strict"; return (${source});`)();
	const database = Array.isArray(config.d1_databases) ? config.d1_databases[0] : null;
	return database?.database_name ?? database?.binding ?? null;
}

const { localConfigPath } = resolveProjectPaths(rootDir);
if (!existsSync(localConfigPath)) {
	console.log("wrangler.local.jsonc not found. Running `npm run setup` equivalent first.");
	ensureLocalConfigSynced(rootDir);
}

const databaseName = readConfiguredDatabaseName();
if (!databaseName) {
	console.error("Could not determine the D1 database from wrangler.jsonc / wrangler.local.jsonc.");
	process.exit(1);
}

console.log(`Applying migrations to the local D1 "${databaseName}" used by \`wrangler dev\`...`);
const status = runWranglerCli({
	args: ["d1", "migrations", "apply", databaseName, "--local"],
	rootDir,
});

if (status !== 0) {
	process.exit(status);
}

console.log("Local D1 ready. Start the Worker with `npm run dev`.");

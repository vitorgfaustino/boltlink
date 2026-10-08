/** Local operational checks only. No Cloudflare calls or config writes. */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parseJsoncConfig, validateConfigBindings } from "./config-utils.mjs";
import { readOption } from "./wrangler-routing.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateRemoteD1Config({ config, configPath, rootDir, args = [], env = {} }) {
	const environment = readOption(args, ["--env", "-e"], { allowEmpty: true }) ?? env.CLOUDFLARE_ENV;
	// D1 bindings are non-inheritable in named Wrangler environments.
	const effective = environment ? config.env?.[environment] : config;
	if (!effective) return "CONFIG_ENVIRONMENT_MISSING";
	const entries = Array.isArray(effective.d1_databases) ? effective.d1_databases : [];
	const matches = entries.filter((entry) => entry?.binding === "db_boltlink");
	if (matches.length === 0) return "REMOTE_D1_BINDING_MISSING";
	if (matches.length !== 1) return "REMOTE_D1_BINDING_AMBIGUOUS";
	// Wrangler resolves by database_name OR binding, in array order. A name
	// alias must not redirect the canonical migration command to another D1.
	if (entries.filter((entry) => entry?.binding === "db_boltlink" || entry?.database_name === "db_boltlink").length !== 1) return "REMOTE_D1_BINDING_AMBIGUOUS";
	try { validateConfigBindings(config); } catch (error) { return error.message; }
	const binding = matches[0];
	if (typeof binding.database_name !== "string" || !binding.database_name.trim()) return "REMOTE_D1_DATABASE_NAME_MISSING";
	if (binding.database_id === undefined || binding.database_id === null || binding.database_id === "") return "REMOTE_D1_DATABASE_ID_MISSING";
	if (typeof binding.database_id !== "string" || !UUID.test(binding.database_id) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(binding.database_id)) return "REMOTE_D1_DATABASE_ID_INVALID";
	if (typeof binding.migrations_dir !== "string" || resolve(dirname(configPath), binding.migrations_dir) !== resolve(rootDir, "migrations")) return "REMOTE_D1_MIGRATIONS_DIR_INVALID";
	return null;
}

export function requiresRemoteD1Preflight(execution) {
	const { command, commandArgs, remote, dryRun } = execution;
	if (command === "deploy") return dryRun !== true;
	if (command === "versions") return commandArgs[1] === "upload";
	return command === "d1" && (remote === true || ["info", "time-travel"].includes(commandArgs[1]))
		&& !["create", "list"].includes(commandArgs[1]);
}

export function formatPreflightFailure(reason, configPath, env) {
	const build = env.WORKERS_CI === "1";
	return [
		"BOLTLINK DEPLOY PREFLIGHT FAILED",
		`Reason: ${reason}`,
		reason === "REMOTE_D1_DATABASE_ID_MISSING" ? "Missing database_id for D1 binding: db_boltlink" : "Check D1 binding: db_boltlink",
		`Environment: ${build ? "Cloudflare Workers Builds" : "Local Wrangler"}`,
		`Config used: ${configPath}`,
		"This operation requires the D1 database ID associated with the existing installation.",
		"Do not create a new database. Restore the existing installation fields in the config used above.",
		...(build ? ["Normally this is wrangler.jsonc in this installation's Git repository.",
			"Changing wrangler.local.jsonc on your computer will not fix this Workers Build."] : []),
		"See: docs/upgrading.md",
	].join("\n");
}

// Compare all installation settings, except fields describing distributed code.
// Report field categories only: no IDs, routes, variables or secret values.
const CODE_FIELDS = new Set(["$schema", "main", "compatibility_date", "compatibility_flags", "rules", "build"]);
function operationalConfig(config) {
	const result = Object.create(null);
	for (const [key, value] of Object.entries(config)) {
		if (CODE_FIELDS.has(key)) continue;
		if (key === "env") result.env = Object.fromEntries(Object.entries(value).map(([name, v]) => [name, operationalConfig(v)]));
		else if (key === "assets") {
			const { directory, ...settings } = value;
			result.assets = settings;
		} else result[key] = value;
	}
	return result;
}

export function compareInstallationConfigs(before, after, confirmedFields = []) {
	const issues = [];
	try { validateConfigBindings(before); validateConfigBindings(after); } catch (error) {
		return { status: "BLOCKED", issues: [{ field: "bindings", status: "BLOCKED", reason: error.message }] };
	}
	function compareLevel(previous, next, prefix = "") {
		for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
			const field = `${prefix}${key}`;
			if (key === "env") {
				for (const name of new Set([...Object.keys(previous.env ?? {}), ...Object.keys(next.env ?? {})])) {
					compareLevel(previous.env?.[name] ?? {}, next.env?.[name] ?? {}, `${field}.${name}.`);
				}
				continue;
			}
			if (isDeepStrictEqual(previous[key], next[key])) continue;
			const removedId = key === "d1_databases" && (previous[key] ?? []).some((binding) => {
				if (!binding.database_id) return false;
				const current = (next[key] ?? []).filter((v) => v.binding === binding.binding);
				return current.length !== 1 || !current[0].database_id || (binding.database_name && !current[0].database_name);
			});
			const removedIdentity = previous[key] !== undefined && (next[key] === undefined || next[key] === null || next[key] === "" || (key === "name" && (typeof next[key] !== "string" || !next[key].trim())));
			const blocked = removedId || removedIdentity;
			issues.push({ field, status: blocked ? "BLOCKED" : "REQUIRES_EXPLICIT_CONFIRMATION",
				reason: removedId ? "D1_IDENTITY_REMOVED" : removedIdentity ? "INSTALLATION_FIELD_REMOVED" : "INSTALLATION_CONFIG_CHANGED" });
		}
	}
	compareLevel(operationalConfig(before), operationalConfig(after));
	const pending = issues.filter((v) => v.status === "BLOCKED" || !confirmedFields.includes(v.field));
	return { status: pending.some((v) => v.status === "BLOCKED") ? "BLOCKED" : pending.length ? "REQUIRES_EXPLICIT_CONFIRMATION" : "PASSED", issues };
}

export function runUpgradeConfigCheck(args = process.argv.slice(2)) {
	try {
		const beforePath = readOption(args, ["--before"]);
		const afterPath = readOption(args, ["--after"]);
		if (!beforePath || !existsSync(beforePath)) {
			console.error("UPGRADE_BASELINE = MISSING\nAUTOMATIC_APPROVAL = DENIED\nMANUAL_RECONCILIATION = REQUIRED\nUsage: npm run upgrade:check -- --before <snapshot.jsonc> --after <config.jsonc> [--confirm-field <field>]");
			return 1;
		}
		if (!afterPath) throw new Error("CONFIG_OPTION_INVALID");
		const confirmed = [];
		for (let i = 0; i < args.length; i++) {
			if (args[i] === "--confirm-field") {
				if (!args[i + 1] || args[i + 1].startsWith("-")) throw new Error("CONFIG_OPTION_INVALID");
				confirmed.push(args[++i]);
			} else if (args[i].startsWith("--confirm-field=")) confirmed.push(args[i].slice(16));
			else if (["--before", "--after"].includes(args[i])) i++;
			else if (!args[i].startsWith("--before=") && !args[i].startsWith("--after=")) throw new Error("CONFIG_OPTION_UNKNOWN");
		}
		const result = compareInstallationConfigs(parseJsoncConfig(beforePath), parseJsoncConfig(afterPath), confirmed);
		// Values are deliberately never serialized.
		console.log(`UPGRADE_CONFIG = ${result.status}`);
		for (const issue of result.issues) {
			const status = issue.status === "REQUIRES_EXPLICIT_CONFIRMATION" && confirmed.includes(issue.field) ? "CONFIRMED" : issue.status;
			console.log(`${JSON.stringify(issue.field)}: ${status} (${issue.reason})`);
		}
		return result.status === "PASSED" ? 0 : 1;
	} catch {
		console.error("UPGRADE_CONFIG = BLOCKED. Check JSONC inputs and --before/--after options. See docs/upgrading.md.");
		console.error("AUTOMATIC_APPROVAL = DENIED\nMANUAL_RECONCILIATION = REQUIRED");
		return 1;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	process.exit(runUpgradeConfigCheck());
}

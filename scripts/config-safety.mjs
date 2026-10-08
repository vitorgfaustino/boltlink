/** Local operational checks only. No Cloudflare calls or config writes. */
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parseJsoncConfig } from "./config-utils.mjs";
import { readOption } from "./wrangler-routing.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateRemoteD1Config({ config, configPath, rootDir, args = [], env = {} }) {
	const environment = readOption(args, ["--env", "-e"]) ?? env.CLOUDFLARE_ENV;
	// D1 bindings are non-inheritable in named Wrangler environments.
	const effective = environment ? config.env?.[environment] : config;
	if (!effective) return "CONFIG_ENVIRONMENT_MISSING";
	const entries = Array.isArray(effective.d1_databases) ? effective.d1_databases : [];
	const matches = entries.filter((entry) => entry?.binding === "db_boltlink");
	if (matches.length === 0) return "REMOTE_D1_BINDING_MISSING";
	if (matches.length !== 1) return "REMOTE_D1_BINDING_AMBIGUOUS";
	const binding = matches[0];
	if (typeof binding.database_name !== "string" || !binding.database_name.trim()) return "REMOTE_D1_DATABASE_NAME_MISSING";
	if (binding.database_id === undefined || binding.database_id === null || binding.database_id === "") return "REMOTE_D1_DATABASE_ID_MISSING";
	if (typeof binding.database_id !== "string" || !UUID.test(binding.database_id) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(binding.database_id)) return "REMOTE_D1_DATABASE_ID_INVALID";
	if (typeof binding.migrations_dir !== "string" || resolve(dirname(configPath), binding.migrations_dir) !== resolve(rootDir, "migrations")) return "REMOTE_D1_MIGRATIONS_DIR_INVALID";
	return null;
}

export function requiresRemoteD1Preflight(args) {
	if (args[0] === "deploy") {
		// Exempt only an unambiguous dry-run; mixed/negated flags must not
		// accidentally bypass the guard on an actual deployment.
		const dryRun = args.filter((arg) => arg === "--dry-run" || arg.startsWith("--dry-run=") || arg === "--no-dry-run");
		return !(dryRun.length === 1 && ["--dry-run", "--dry-run=true"].includes(dryRun[0]) && !args.includes("false"));
	}
	if (args[0] === "versions") return args[1] === "upload";
	return args[0] === "d1" && (args.includes("--remote") || ["info", "time-travel"].includes(args[1]))
		&& !["create", "list"].includes(args[1]);
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
	const result = {};
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
				return current.length !== 1 || !current[0].database_id;
			});
			issues.push({ field, status: removedId ? "BLOCKED" : "REQUIRES_EXPLICIT_CONFIRMATION",
				reason: removedId ? "D1_ID_REMOVED" : "INSTALLATION_CONFIG_CHANGED" });
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
		if (!beforePath || !afterPath) throw new Error("Usage: npm run upgrade:check -- --before <snapshot.jsonc> --after <config.jsonc> [--confirm-field <field>]");
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
		for (const issue of result.issues) console.log(`${JSON.stringify(issue.field)}: ${issue.status} (${issue.reason})`);
		return result.status === "PASSED" ? 0 : 1;
	} catch {
		console.error("UPGRADE_CONFIG = BLOCKED. Check JSONC inputs and --before/--after options. See docs/upgrading.md.");
		return 1;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	process.exit(runUpgradeConfigCheck());
}

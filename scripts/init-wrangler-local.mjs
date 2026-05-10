import { ensureLocalConfigSynced } from "./config-utils.mjs";

const rootDir = process.cwd();

try {
	const result = ensureLocalConfigSynced(rootDir);

	if (result.created) {
		console.log("Created wrangler.local.jsonc from the public template.");
	} else {
		console.log("Updated wrangler.local.jsonc with the latest public template keys while preserving local overrides.");
	}

	console.log("Created .wrangler/deploy/config.json to redirect Wrangler to the local config.");
	console.log("Next: set the real D1, Access and optional API key values in your local or dashboard configuration.");
	console.log("Keep API_KEY in .dev.vars or in Cloudflare secret storage.");
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
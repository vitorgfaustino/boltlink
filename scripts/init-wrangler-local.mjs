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
	console.log("");
	console.log("IMPORTANT: wrangler.local.jsonc is your private operational config.");
	console.log("- keep_vars is now set to true by default so dashboard values are preserved during local deploys.");
	console.log("- If you use GitHub auto-deploy or the Cloudflare Deploy Button, leave TEAM_DOMAIN and POLICY_AUD");
	console.log("  OUT of this file; they should be set only in the Cloudflare dashboard.");
	console.log("- If you use npm run deploy locally, you MAY add TEAM_DOMAIN and POLICY_AUD here, but only with real values.");
	console.log("- Never commit wrangler.local.jsonc or .dev.vars to Git.");
	console.log("- Keep API_KEY in .dev.vars or in Cloudflare secret storage.");
	console.log("");
	console.log("Next: set the real D1, Access and optional API key values in your local or dashboard configuration.");
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}

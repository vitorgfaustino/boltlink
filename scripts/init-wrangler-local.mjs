/*
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
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

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
	console.log("  OUT of this file; they should be set in the Cloudflare dashboard.");
	console.log("- If you use npm run deploy locally, you MAY add TEAM_DOMAIN and POLICY_AUD here, but only with real values.");
	console.log("- Never commit wrangler.local.jsonc or .dev.vars to Git.");
	console.log("- Keep API_KEY and PASSWORD_SESSION_SECRET in .dev.vars for local development.");
	console.log("- For deployed Workers, set API_KEY and PASSWORD_SESSION_SECRET as Cloudflare secrets.");
	console.log("");
	console.log("Next: set the real D1, Access and optional secret values in your local or dashboard configuration.");
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}

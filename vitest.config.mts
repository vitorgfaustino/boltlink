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

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		projects: [
			{
				plugins: [
					cloudflareTest({
						wrangler: { configPath: "./wrangler.jsonc" },
					}),
				],
				test: {
					name: "workers",
					include: ["test/**/*.spec.ts"],
					exclude: [
						"test/ab-display.spec.ts",
						"test/smart-routing-admin.spec.ts",
						"test/expired-redirect-admin.spec.ts",
						"test/group-hierarchy-admin.spec.ts",
						"test/portability-export-admin.spec.ts",
						"test/portability-import-admin.spec.ts",
						"test/qrcode-admin.spec.ts",
					],
				},
			},
			{
				test: {
					name: "node",
					environment: "node",
					include: [
						"test/ab-display.spec.ts",
						"test/smart-routing-admin.spec.ts",
						"test/expired-redirect-admin.spec.ts",
						"test/group-hierarchy-admin.spec.ts",
						"test/portability-export-admin.spec.ts",
						"test/portability-import-admin.spec.ts",
						"test/qrcode-admin.spec.ts",
					],
				},
			},
		],
	},
});

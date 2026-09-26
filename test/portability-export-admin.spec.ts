/*
 * Copyright (c) 2026 Vitor Faustino
 * AGPL-3.0 License — https://github.com/vitorgfaustino/boltlink
 *
 * Phase 5, Gate 5.2: portability export admin UX coverage.
 *
 * The helper module is pure and DOM-free, so the filename policy and the error
 * mapping are verified in Node. Source scans prove the panel keeps the API as the
 * authority and stays a download-only surface: nothing persisted reaches an HTML sink,
 * the download name never comes from stored data, and no import affordance exists yet.
 */

// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type PortabilityApi = {
	EXPORT_PATH: string;
	FALLBACK_FILENAME: string;
	safeFilename: (candidate: unknown) => string;
	filenameFromDisposition: (header: unknown) => string;
	exportErrorMessage: (status: number, rawMessage?: unknown) => string;
};

function readPublic(file: string) {
	return readFileSync(resolve(process.cwd(), `public/${file}`), "utf8");
}

function loadPortabilityApi(): PortabilityApi {
	const sandbox: { window: { BoltLinkPortability?: PortabilityApi } } = { window: {} };
	vm.createContext(sandbox);
	vm.runInContext(readPublic("portability-ui.js"), sandbox);
	const api = sandbox.window.BoltLinkPortability;
	if (!api) {
		throw new Error("BoltLinkPortability not registered");
	}
	return api;
}

function functionBody(source: string, name: string) {
	const start = source.indexOf(`function ${name}(`);
	expect(start, `missing function ${name}`).toBeGreaterThan(-1);
	const next = source.indexOf("\nfunction ", start + 1);
	return source.slice(start, next === -1 ? source.length : next);
}

describe("Phase 5, Gate 5.2: export download helpers", () => {
	it("accepts the constant name the API sends", () => {
		const api = loadPortabilityApi();

		expect(api.safeFilename("boltlink-export.json")).toBe("boltlink-export.json");
		expect(api.filenameFromDisposition('attachment; filename="boltlink-export.json"')).toBe("boltlink-export.json");
		expect(api.filenameFromDisposition("attachment; filename=boltlink-export.json")).toBe("boltlink-export.json");
	});

	it("falls back whenever the header is missing or unusable", () => {
		const api = loadPortabilityApi();

		expect(api.filenameFromDisposition(null)).toBe(api.FALLBACK_FILENAME);
		expect(api.filenameFromDisposition("")).toBe(api.FALLBACK_FILENAME);
		expect(api.filenameFromDisposition("attachment")).toBe(api.FALLBACK_FILENAME);
		expect(api.filenameFromDisposition('attachment; filename=""')).toBe(api.FALLBACK_FILENAME);
		expect(api.filenameFromDisposition(undefined)).toBe(api.FALLBACK_FILENAME);
	});

	it("never lets a path, a quote or a control character steer the download", () => {
		const api = loadPortabilityApi();

		for (const hostile of [
			'filename="../../etc/passwd"',
			'filename="/absolute/path.json"',
			'filename="sub/dir.json"',
			'filename=".."',
			'filename=".hidden"',
			'filename="back\\slash.json"',
			'filename="semi;colon.json"',
			'filename="jav\tascript.json"',
			'filename="espaco nome.json"',
			`filename="${"a".repeat(80)}.json"`,
			'filename="<script>.json"',
		]) {
			expect(api.filenameFromDisposition(`attachment; ${hostile}`), hostile).toBe(api.FALLBACK_FILENAME);
		}

		expect(api.safeFilename(42)).toBe(api.FALLBACK_FILENAME);
		expect(api.safeFilename(null)).toBe(api.FALLBACK_FILENAME);
	});

	it("reads the RFC 5987 form and validates it the same way", () => {
		const api = loadPortabilityApi();

		expect(api.filenameFromDisposition("attachment; filename*=UTF-8''boltlink-export.json")).toBe("boltlink-export.json");
		// An encoded traversal is refused after decoding, not before.
		expect(api.filenameFromDisposition("attachment; filename*=UTF-8''..%2Fescape.json")).toBe(api.FALLBACK_FILENAME);
		// Broken percent-encoding cannot throw its way out of the panel.
		expect(api.filenameFromDisposition("attachment; filename*=UTF-8''%E0%A4%A")).toBe(api.FALLBACK_FILENAME);
	});

	it("points at the administrative export route", () => {
		const api = loadPortabilityApi();
		expect(api.EXPORT_PATH).toBe("/api/export");
	});
});

describe("Phase 5, Gate 5.2: export error mapping", () => {
	it("maps the boundary and infrastructure statuses", () => {
		const api = loadPortabilityApi();

		expect(api.exportErrorMessage(401, "Authentication required")).toMatch(/Sessão administrativa/);
		expect(api.exportErrorMessage(403, "")).toMatch(/Sessão administrativa/);
		expect(api.exportErrorMessage(429, "Rate limit exceeded")).toMatch(/Muitas exportações/);
		expect(api.exportErrorMessage(503, "Database schema is not initialized")).toMatch(/migrations/);
		expect(api.exportErrorMessage(404, "Not found")).toMatch(/não está disponível/);
	});

	it("separates the three 413 limits without echoing the raw value", () => {
		const api = loadPortabilityApi();

		expect(api.exportErrorMessage(413, "Portability export refused: group limit exceeded")).toMatch(/mais grupos/);
		expect(api.exportErrorMessage(413, "Portability export refused: link limit exceeded")).toMatch(/mais links/);
		expect(api.exportErrorMessage(413, "Portability export refused: document exceeds the size limit")).toMatch(/tamanho/);

		for (const message of [
			"Portability export refused: group limit exceeded",
			"Portability export refused: link limit exceeded",
			"Portability export refused: document exceeds the size limit",
		]) {
			const mapped = api.exportErrorMessage(413, message);
			expect(mapped).not.toContain(message);
			expect(mapped).not.toMatch(/Portability export refused/);
		}
	});

	it("explains a 409 as unexportable persisted state, in pt-BR", () => {
		const api = loadPortabilityApi();
		const mapped = api.exportErrorMessage(409, 'Portability export refused: invalid slug: link "admin"');

		expect(mapped).toMatch(/estado persistido não é válido/);
		expect(mapped).toMatch(/Nada foi alterado no banco/);
		// The refused row is named by the API response, not republished by the panel.
		expect(mapped).not.toContain("admin");
	});

	it("falls back to the generic message for anything unmapped", () => {
		const api = loadPortabilityApi();

		expect(api.exportErrorMessage(500, "")).toMatch(/Não foi possível exportar/);
		expect(api.exportErrorMessage(418, "I am a teapot")).toBe("I am a teapot");
		expect(api.exportErrorMessage(500, null)).toMatch(/Não foi possível exportar/);
	});

	it("keeps the helper module free of DOM access and dynamic code", () => {
		const ui = readPublic("portability-ui.js");

		expect(ui).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
		expect(ui).not.toMatch(/\beval\(|new Function\(/);
		expect(ui).not.toMatch(/document\./);
		// A filename is never assembled from a value the API could not have sent.
		expect(ui).not.toMatch(/filename\s*\+=|`\$\{.*\}\.json`/);
	});
});

describe("Phase 5, Gate 5.2: admin wiring", () => {
	it("loads the portability helper before the admin script", () => {
		const html = readPublic("admin.html");
		const scripts = Array.from(html.matchAll(/<script src="([^"]+)"/g)).map((match) => match[1]);

		expect(scripts).toContain("/portability-ui.js");
		expect(scripts.indexOf("/portability-ui.js")).toBeLessThan(scripts.indexOf("/admin.js"));
	});

	it("registers the export control with a unique id and a live status", () => {
		const html = readPublic("admin.html");
		const ids = Array.from(html.matchAll(/\sid="([^"]+)"/g)).map((match) => match[1]);
		expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);

		expect(ids).toContain("export-button");
		expect(ids).toContain("export-status");
		// Gate 5.3 renamed the control: it now names what it produces (a configuration
		// document) instead of the generic "dados", and it sits next to the import one.
		expect(html).toMatch(/<button type="button"[^>]*id="export-button"[^>]*>Exportar configuração<\/button>/);
		expect(html).toMatch(/id="export-status" role="status" aria-live="polite"/);
	});

	it("requests the route through the authenticated panel fetch and downloads a blob", () => {
		const admin = readPublic("admin.js");
		const body = functionBody(admin, "exportConfiguration");

		expect(body).toContain("fetch(portabilityUi.EXPORT_PATH");
		expect(body).toContain('credentials: "same-origin"');
		expect(body).toContain("new Blob([body]");
		expect(body).toContain("URL.createObjectURL");
		expect(body).toContain("URL.revokeObjectURL");
		// The download name comes from the helper, never from the response body or from
		// persisted data.
		expect(body).toContain('portabilityUi.filenameFromDisposition(response.headers.get("Content-Disposition"))');
		expect(body).not.toMatch(/link\.|group\.|\.slug/);
	});

	it("reports failures through the panel status instead of navigating to the endpoint", () => {
		const admin = readPublic("admin.js");
		const body = functionBody(admin, "exportConfiguration");

		expect(body).toContain("setStatus(exportStatus, portabilityUi.exportErrorMessage(response.status, apiMessage), \"error\")");
		expect(body).toContain("setBusy(exportButton, true)");
		expect(body).toContain("setBusy(exportButton, false)");
		expect(body).toContain("anchor.download = filename");
		// No navigation, no raw JSON on screen.
		expect(body).not.toMatch(/location\.(href|assign|replace)|window\.open\(/);
		expect(admin).toContain('exportButton.addEventListener("click"');
	});

	it("keeps persisted data away from every HTML sink in the panel", () => {
		const admin = readPublic("admin.js");
		const dangerousLines = admin
			.split("\n")
			.filter((line) => /innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(line));

		for (const line of dangerousLines) {
			expect(line).not.toMatch(/exportStatus|exportButton|portabilityUi|filename/i);
		}
	});

	/**
	 * Gate 5.2 pinned "there is no import yet" here. Gate 5.3 delivers the import, so the
	 * claim moves to the other half of the boundary: the export stays a download-only
	 * surface, and the file-reading, reviewing and applying live in their own module and
	 * their own drawer. What was unexportable data staying out of an HTML sink is asserted
	 * above, and the import surface has its own suite (`portability-import-admin.spec.ts`).
	 */
	it("keeps the export surface download-only now that import exists", () => {
		const admin = readPublic("admin.js");
		const ui = readPublic("portability-ui.js");
		const exportBody = functionBody(admin, "exportConfiguration");

		// The export path reads no file, posts nothing and opens nothing.
		expect(exportBody).not.toMatch(/FileReader|\.text\(\)\s*;?\s*$|\/api\/import|importApply|importPreview/);
		expect(exportBody).not.toMatch(/type="file"|FormData|enctype/i);
		// The export helper module stays free of DOM access and of import vocabulary.
		expect(ui).not.toMatch(/FileReader|\bupload\b|type="file"/);
		expect(ui).not.toMatch(/IMPORT_/);

		// The import affordance exists, and it is not the export button.
		expect(readPublic("admin.html")).toContain('id="import-drawer-open"');
		expect(admin).toContain("handleImportFileSelection");
	});
});

/*
 * Copyright (c) 2026 Vitor Faustino
 * AGPL-3.0 License — https://github.com/vitorgfaustino/boltlink
 *
 * Phase 5, Gate 5.3: portability import admin coverage.
 *
 * The helper module is pure and DOM-free, so the copy, the size policy and the state
 * mapping are verified in Node. Source scans then prove the properties that cannot be
 * observed without a browser: nothing from a file reaches an HTML sink, no password is
 * stored or transmitted anywhere but the apply request, and the two drawers can never be
 * open at the same time.
 */

// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type ImportSelection = {
	generation: number;
	previewGeneration: number | null;
	invalidate: () => number;
	isCurrent: (generation: unknown) => boolean;
	markPreview: (generation: unknown) => boolean;
	revokePreview: () => void;
	canApply: () => boolean;
};

type PasswordEntry = { slug: unknown; value: unknown };

type ApplyVerdict = {
	verdict: string;
	status: number;
	payload: Record<string, unknown> | null;
};

type UnknownOutcomePlan = {
	discardPasswords: boolean;
	allowAnotherApply: boolean;
	stateUnknown: boolean;
	message: string;
};

type ImportApi = {
	PREVIEW_PATH: string;
	APPLY_PATH: string;
	MAX_BYTES: number;
	MAX_GROUPS: number;
	MAX_LINKS: number;
	FORMAT: string;
	SCHEMA_VERSION: number;
	STATE_VALID: string;
	STATE_BLOCKED: string;
	STATE_INVALID: string;
	VERDICT_SUCCESS: string;
	VERDICT_REFUSED: string;
	VERDICT_UNKNOWN: string;
	formatBytes: (bytes: unknown) => string;
	fileTooLarge: (size: unknown) => boolean;
	localDocumentProblem: (parsed: unknown) => string | null;
	envelopeFor: (document: unknown, passwords?: Record<string, string>) => Record<string, unknown>;
	responseState: (payload: unknown) => string;
	requiresPasswordSlugs: (payload: unknown) => string[];
	conflictSlugs: (payload: unknown) => string[];
	summaryLines: (summary: unknown) => Array<{ label: string; value: string }>;
	planText: (summary: unknown) => string;
	successText: (result: unknown) => string;
	warningMessages: (payload: unknown) => string[];
	errorMessage: (code: unknown) => string;
	blockerMessages: (payload: unknown) => string[];
	previewErrorMessage: (status: number, code?: unknown) => string;
	applyErrorMessage: (status: number, code?: unknown) => string;
	createImportSelection: () => ImportSelection;
	passwordMap: (entries: unknown) => Record<string, string>;
	clearPasswordInputs: (inputs: unknown) => number;
	applyFailureDisposition: (kind: unknown) => { discardPasswords: boolean; allowAnotherApply: boolean; stateUnknown: boolean };
	readApplyResponse: (status: unknown, bodyText: unknown) => ApplyVerdict;
	unknownOutcomePlan: (detail: unknown) => UnknownOutcomePlan;
};

function readPublic(file: string) {
	return readFileSync(resolve(process.cwd(), `public/${file}`), "utf8");
}

function loadImportApi(): ImportApi {
	const sandbox: { window: { BoltLinkPortabilityImport?: ImportApi } } = { window: {} };
	vm.createContext(sandbox);
	vm.runInContext(readPublic("portability-import-ui.js"), sandbox);
	const api = sandbox.window.BoltLinkPortabilityImport;
	if (!api) {
		throw new Error("BoltLinkPortabilityImport not registered");
	}
	return api;
}

function functionBody(source: string, name: string) {
	const start = source.indexOf(`function ${name}(`);
	expect(start, `missing function ${name}`).toBeGreaterThan(-1);
	const next = source.indexOf("\nfunction ", start + 1);
	return source.slice(start, next === -1 ? source.length : next);
}

const IMPORT_FUNCTIONS = [
	"clearImportNode",
	"appendImportLine",
	"appendImportIssue",
	"renderImportList",
	"resetImportReview",
	"resetImportDrawer",
	"renderImportSummary",
	"renderImportWarnings",
	"renderImportPasswords",
	"collectImportPasswords",
	"discardImportPasswords",
	"endImportAttempt",
	"syncImportApplyState",
	"renderImportResult",
	"requestImportPreview",
	"handleImportFileSelection",
	"applyImport",
	"renderImportFailure",
	"renderImportUnknownOutcome",
	"renderImportSuccess",
	"importDrawerFocusables",
	"keepImportDrawerFocus",
	"onImportDrawerKeydown",
	"openImportDrawer",
	"closeImportDrawer",
];

describe("Phase 5, Gate 5.3: import helpers are pure and bounded", () => {
	it("points at the two administrative import routes", () => {
		const api = loadImportApi();

		expect(api.PREVIEW_PATH).toBe("/api/import/preview");
		expect(api.APPLY_PATH).toBe("/api/import/apply");
		expect(api.FORMAT).toBe("boltlink-portability");
		expect(api.SCHEMA_VERSION).toBe(1);
	});

	it("states the format's own limits", () => {
		const api = loadImportApi();

		expect(api.MAX_BYTES).toBe(256 * 1024);
		expect(api.MAX_GROUPS).toBe(50);
		expect(api.MAX_LINKS).toBe(100);
		expect(api.formatBytes(api.MAX_BYTES)).toBe("256 KiB");
		expect(api.formatBytes(2 * 1024 * 1024)).toBe("2 MiB");
		// Anything that is not a byte count falls back to the format's ceiling.
		expect(api.formatBytes(undefined)).toBe("256 KiB");
		expect(api.formatBytes(-1)).toBe("256 KiB");

		expect(api.fileTooLarge(api.MAX_BYTES)).toBe(false);
		expect(api.fileTooLarge(api.MAX_BYTES + 1)).toBe(true);
		expect(api.fileTooLarge(undefined)).toBe(false);
		expect(api.fileTooLarge("grande")).toBe(false);
	});

	it("recognizes a foreign file before spending a round trip", () => {
		const api = loadImportApi();

		expect(api.localDocumentProblem({ format: "outro", schemaVersion: 1, groups: [], links: [] })).toMatch(/Exportar configuração/);
		expect(api.localDocumentProblem({ format: api.FORMAT, schemaVersion: 2, groups: [], links: [] })).toMatch(/versão/);
		expect(api.localDocumentProblem({ format: api.FORMAT, schemaVersion: 1, links: [] })).toMatch(/estrutura/);
		expect(api.localDocumentProblem(null)).toMatch(/não contém/);
		expect(api.localDocumentProblem([])).toMatch(/não contém/);
		expect(api.localDocumentProblem({ format: api.FORMAT, schemaVersion: 1, groups: [], links: [] })).toBeNull();
	});

	it("builds the envelope the API expects, and only carries passwords when asked", () => {
		const api = loadImportApi();
		const document = { format: api.FORMAT, schemaVersion: 1, groups: [], links: [] };

		const preview = api.envelopeFor(document);
		expect(Object.keys(preview)).toEqual(["document"]);
		expect(preview.document).toBe(document);

		const apply = api.envelopeFor(document, { "cliente-x": "segredo" });
		expect(Object.keys(apply)).toEqual(["document", "replacementPasswords"]);
		expect(apply.replacementPasswords).toEqual({ "cliente-x": "segredo" });

		// An empty mapping is the same as none: a document without protected links sends no
		// password field at all.
		expect(Object.keys(api.envelopeFor(document, {}))).toEqual(["document"]);
	});

	it("maps the three answers the API can give", () => {
		const api = loadImportApi();

		expect(api.responseState({ ok: true, summary: {} })).toBe(api.STATE_VALID);
		expect(api.responseState({ ok: false, blockers: ["SLUG_COLLISION"] })).toBe(api.STATE_BLOCKED);
		expect(api.responseState({ ok: false, code: "INVALID_DOCUMENT", errors: [] })).toBe(api.STATE_INVALID);
		expect(api.responseState(null)).toBe(api.STATE_INVALID);
	});

	it("reads slugs defensively, dropping anything that is not one", () => {
		const api = loadImportApi();

		expect(api.requiresPasswordSlugs({ requiresPasswords: [{ slug: "a" }, { slug: "b" }] })).toEqual(["a", "b"]);
		expect(api.requiresPasswordSlugs({ requiresPasswords: [{ slug: "a" }, { slug: 7 }, null, "b"] })).toEqual(["a"]);
		expect(api.requiresPasswordSlugs({})).toEqual([]);
		expect(api.requiresPasswordSlugs(null)).toEqual([]);
		expect(api.conflictSlugs({ conflicts: [{ slug: "ocupado" }] })).toEqual(["ocupado"]);
		expect(api.conflictSlugs(undefined)).toEqual([]);
	});

	it("summarizes in a fixed order and states the plan in counts", () => {
		const api = loadImportApi();
		const lines = api.summaryLines({ groups: 7, links: 42, disabledLinks: 3, protectedLinks: 2, abTests: 4, smartRouting: 1 });

		expect(lines.map((line) => line.label)).toEqual([
			"Grupos",
			"Links",
			"Links desativados",
			"Links protegidos",
			"Testes A/B",
			"Smart Routing",
		]);
		expect(lines.map((line) => line.value)).toEqual(["7", "42", "3", "2", "4", "1"]);
		// A missing or hostile count is shown as zero instead of being echoed.
		expect(api.summaryLines({ groups: "<script>" }).map((line) => line.value)).toContain("0");
		expect(api.summaryLines(undefined).length).toBe(6);

		expect(api.planText({ groups: 7, links: 42 })).toBe("Serão criados 7 grupos e 42 links.");
		// The success copy is the sentence the gate asks for, followed by what was created.
		expect(api.successText({ groupsCreated: 7, linksCreated: 42 })).toBe("Configuração importada com sucesso: 7 grupos e 42 links.");
		expect(api.successText(undefined)).toContain("Configuração importada com sucesso");
	});

	it("warns that metrics are not part of the format", () => {
		const api = loadImportApi();

		expect(api.warningMessages({ warnings: ["METRICS_NOT_EXPORTED"] })).toEqual([
			"As métricas não são importadas. Os links criados começam com zero cliques.",
		]);
		expect(api.warningMessages({ warnings: ["DESCONHECIDO"] })).toEqual([]);
		expect(api.warningMessages({})).toEqual([]);
	});
});

describe("Phase 5, Gate 5.3: import copy and error mapping", () => {
	it("explains every document problem in pt-BR, without echoing the API text", () => {
		const api = loadImportApi();
		const codes = [
			"INVALID_BODY",
			"INVALID_DOCUMENT",
			"UNKNOWN_FIELD",
			"UNSUPPORTED_FORMAT",
			"UNSUPPORTED_SCHEMA_VERSION",
			"TOO_MANY_GROUPS",
			"TOO_MANY_LINKS",
			"TOO_LARGE",
			"INVALID_GROUP_ENTRY",
			"INVALID_GROUP_NAME",
			"INVALID_GROUP_REF",
			"DUPLICATE_GROUP_REF",
			"DANGLING_PARENT_REF",
			"GROUP_CYCLE",
			"INVALID_LINK_ENTRY",
			"DUPLICATE_LINK_SLUG",
			"INVALID_SLUG",
			"INVALID_TARGET_URL",
			"INVALID_REDIRECT_TYPE",
			"INVALID_TAGS",
			"DANGLING_GROUP_REF",
			"INVALID_LIFECYCLE",
			"INVALID_EXPIRED_REDIRECT",
			"INVALID_AB_CONFIG",
			"INVALID_SMART_ROUTING",
			"CONFLICTING_ROUTING_CONFIG",
			"INVALID_PASSWORD",
			"PASSWORD_REQUIRED",
		];

		for (const code of codes) {
			const message = api.errorMessage(code);
			expect(message.length, code).toBeGreaterThan(10);
			expect(message, code).not.toContain(code);
			expect(message, code).not.toMatch(/Portability import refused/);
			expect(message, code).not.toMatch(/^[A-Z_]+$/);
		}

		// An unknown or absent code still produces something the panel can show.
		expect(api.errorMessage("NAO_EXISTE")).toMatch(/não pôde ser validado/);
		expect(api.errorMessage(undefined)).toMatch(/não pôde ser validado/);
	});

	it("explains why a valid document cannot be imported here", () => {
		const api = loadImportApi();
		const messages = api.blockerMessages({
			blockers: [
				"SLUG_COLLISION",
				"GROUP_DEPTH_EXCEEDED",
				"TARGET_CAPABILITY_MISSING",
				"DESTINATION_HIERARCHY_CORRUPT",
				"TARGET_GROUP_REFERENCE_CORRUPT",
				"PASSWORD_SESSION_SECRET_MISSING",
			],
		});

		expect(messages.length).toBe(6);
		// The collision message is the exact sentence the gate asks for.
		expect(messages[0]).toBe("Não é possível importar porque alguns slugs já existem nesta instalação.");
		// The legacy-depth limit is explained as a portability limit, not as a corrupt file.
		expect(messages[1]).toMatch(/16 níveis/);
		expect(messages[1]).toMatch(/nada foi importado/i);
		expect(messages[2]).toMatch(/migrações/);
		// A destination holding a link whose group is gone is explained as something to fix
		// in the installation, never as a broken file.
		expect(messages[4]).toMatch(/não existem mais/);
		expect(messages[4]).toMatch(/não importa/);
		expect(messages[5]).toMatch(/PASSWORD_SESSION_SECRET/);

		// Unknown codes and duplicates collapse to one generic line each.
		expect(api.blockerMessages({ blockers: ["DESCONHECIDO", "SLUG_COLLISION", "SLUG_COLLISION"] }).length).toBe(2);
		expect(api.blockerMessages({})).toEqual([]);
	});

	it("separates the boundary statuses from the document ones", () => {
		const api = loadImportApi();

		expect(api.previewErrorMessage(401)).toMatch(/Sessão administrativa/);
		expect(api.previewErrorMessage(403)).toMatch(/Sessão administrativa/);
		expect(api.previewErrorMessage(429)).toMatch(/Muitas operações/);
		expect(api.previewErrorMessage(503)).toMatch(/migrações/);
		expect(api.previewErrorMessage(404)).toMatch(/não está disponível/);
		expect(api.previewErrorMessage(413, "TOO_LARGE")).toMatch(/256 KiB/);
		expect(api.previewErrorMessage(400, "UNSUPPORTED_FORMAT")).toMatch(/não é uma exportação/);
		expect(api.previewErrorMessage(500)).toMatch(/Não foi possível validar/);

		expect(api.applyErrorMessage(409, "SLUG_COLLISION")).toMatch(/já existem/);
		expect(api.applyErrorMessage(500)).toMatch(/Nenhuma alteração foi aplicada/);
		expect(api.applyErrorMessage(503)).toMatch(/migrações/);
	});

	it("mentions neither Backup nor Restaurar for this phase", () => {
		const api = loadImportApi();
		const messages = [
			api.errorMessage("INVALID_DOCUMENT"),
			api.errorMessage("TOO_LARGE"),
			api.planText({ groups: 1, links: 1 }),
			api.successText({ groupsCreated: 1, linksCreated: 1 }),
			api.applyErrorMessage(500),
			...api.blockerMessages({ blockers: ["SLUG_COLLISION", "GROUP_DEPTH_EXCEEDED", "TARGET_CAPABILITY_MISSING", "DESTINATION_HIERARCHY_CORRUPT", "TARGET_GROUP_REFERENCE_CORRUPT", "PASSWORD_SESSION_SECRET_MISSING"] }),
			...api.warningMessages({ warnings: ["METRICS_NOT_EXPORTED"] }),
		];

		for (const message of messages) {
			expect(message).not.toMatch(/\bbackup\b/i);
			expect(message).not.toMatch(/\brestaurar\b/i);
		}
	});

	it("keeps the helper module free of DOM access and dynamic code", () => {
		const ui = readPublic("portability-import-ui.js");

		expect(ui).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
		expect(ui).not.toMatch(/\beval\(|new Function\(/);
		expect(ui).not.toMatch(/document\./);
		expect(ui).not.toMatch(/localStorage|sessionStorage/);
		expect(ui).not.toMatch(/console\.log/);
	});
});

describe("Phase 5, Gate 5.3: the panel only reviews the document it would send", () => {
	it("ignores a preview answer that arrives after the file it described was replaced", () => {
		const api = loadImportApi();
		const selection = api.createImportSelection();

		// Selecting A and then B, before either answer arrives.
		const a = selection.invalidate();
		const b = selection.invalidate();

		// B answers first, then A. The late answer describes a document the operator can no
		// longer see, so it must not reach the panel in any way.
		expect(selection.isCurrent(b)).toBe(true);
		expect(selection.markPreview(b)).toBe(true);
		expect(selection.isCurrent(a)).toBe(false);
		expect(selection.markPreview(a)).toBe(false);

		expect(selection.generation).toBe(b);
		expect(selection.previewGeneration).toBe(b);
		expect(selection.canApply()).toBe(true);
	});

	it("keeps apply unavailable between a new selection and its own preview", () => {
		const api = loadImportApi();
		const selection = api.createImportSelection();

		const a = selection.invalidate();
		expect(selection.markPreview(a)).toBe(true);
		expect(selection.canApply()).toBe(true);

		// The operator picks another file: the approved preview stopped describing what an
		// apply would send, so the control is unavailable until the new file is approved.
		selection.invalidate();
		expect(selection.canApply()).toBe(false);
		expect(selection.previewGeneration).toBeNull();
	});

	it("withdraws the approval of a finished attempt without changing the selection", () => {
		const api = loadImportApi();
		const selection = api.createImportSelection();

		const a = selection.invalidate();
		expect(selection.markPreview(a)).toBe(true);
		expect(selection.canApply()).toBe(true);

		// An attempt ended — refused, failed or succeeded — so the approval it ran under is
		// gone while the document on screen stays the current one.
		selection.revokePreview();
		expect(selection.canApply()).toBe(false);
		expect(selection.previewGeneration).toBeNull();
		expect(selection.isCurrent(a)).toBe(true);
		expect(selection.generation).toBe(a);
	});

	it("never reactivates the panel after the drawer was closed, re-opened or reset", () => {
		const api = loadImportApi();
		const selection = api.createImportSelection();

		const a = selection.invalidate();
		// The drawer closes, re-opens and its reset button runs, all while the request for A
		// is still in flight.
		selection.invalidate();
		selection.invalidate();
		selection.invalidate();
		selection.invalidate();

		expect(selection.isCurrent(a)).toBe(false);
		expect(selection.markPreview(a)).toBe(false);
		expect(selection.canApply()).toBe(false);
		expect(selection.previewGeneration).toBeNull();
	});

	it("denies every ticket before the first selection", () => {
		const api = loadImportApi();
		const selection = api.createImportSelection();

		// Nothing has been selected, so no ticket is current — including the zero a
		// forgotten default could produce.
		expect(selection.isCurrent(0)).toBe(false);
		expect(selection.isCurrent(undefined)).toBe(false);
		expect(selection.isCurrent("1")).toBe(false);
		expect(selection.markPreview(0)).toBe(false);
		expect(selection.canApply()).toBe(false);
	});

	it("ties every preview answer to the selection that asked for it, in the panel", () => {
		const admin = readPublic("admin.js");
		const handle = functionBody(admin, "handleImportFileSelection");

		// The ticket is taken before the first await, so two selections interleaving inside
		// the file read cannot borrow each other's identity.
		const capture = handle.indexOf("state.importSelection.generation");
		const firstAwait = handle.indexOf("await ");
		expect(capture).toBeGreaterThan(-1);
		expect(firstAwait).toBeGreaterThan(-1);
		expect(capture).toBeLessThan(firstAwait);

		// Every step that follows an await asks whether its ticket is still the current one
		// before it writes to the panel or to the state, and the guard is the generation
		// check itself.
		expect((handle.match(/importSelectionStale\(generation\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
		expect(functionBody(admin, "importSelectionStale")).toContain("isCurrent(generation)");

		// The answer is guarded where it is rendered and where it is requested, and the
		// request cancels the one it replaced — a cancellation can always arrive late, so
		// the ticket stays the authority and the abort is only what saves the round trip.
		expect(functionBody(admin, "renderImportResult")).toContain("importSelectionStale(generation)");
		const preview = functionBody(admin, "requestImportPreview");
		expect((preview.match(/importSelectionStale\(generation\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
		expect(preview).toContain("AbortController");
		expect(preview).toContain(".abort()");
		expect(preview).toContain("signal: controller.signal");

		// Apply is bound to an approved preview of the current selection, not to the fact
		// that some preview was answered once.
		expect(functionBody(admin, "syncImportApplyState")).toContain("canApply()");
		expect(functionBody(admin, "applyImport")).toContain("canApply()");
	});
});

describe("Phase 5, Gate 5.3: the password mapping survives every slug", () => {
	it("keeps a __proto__ password as an own property of the mapping", () => {
		const api = loadImportApi();
		const passwords = api.passwordMap([
			{ slug: "__proto__", value: "segredo-do-proto" },
			{ slug: "normal", value: "segredo-normal" },
			{ slug: "vazio", value: "   " },
		]);

		// A mapping built by assignment loses the entry: `obj.__proto__ = "…"` writes a
		// prototype instead of a property, and neither `Object.keys` nor `JSON.stringify`
		// would ever see the password again.
		expect(Object.prototype.hasOwnProperty.call(passwords, "__proto__")).toBe(true);
		expect(Object.keys(passwords)).toEqual(["__proto__", "normal"]);
		// A blank value is not a password.
		expect(Object.prototype.hasOwnProperty.call(passwords, "vazio")).toBe(false);

		const body = JSON.stringify(
			api.envelopeFor({ format: api.FORMAT, schemaVersion: 1, groups: [], links: [] }, passwords),
		);
		expect(body).toContain('"__proto__":"segredo-do-proto"');
		expect(body).toContain('"normal":"segredo-normal"');
	});

	it("handles the other inherited names the same way, and never pollutes a prototype", () => {
		const api = loadImportApi();
		const passwords = api.passwordMap([
			{ slug: "constructor", value: "um" },
			{ slug: "prototype", value: "dois" },
			{ slug: "toString", value: "tres" },
			{ slug: null, value: "quatro" },
			{ slug: "sem-valor", value: 7 },
		]);

		expect(Object.keys(passwords)).toEqual(["constructor", "prototype", "toString"]);
		expect(api.envelopeFor({}, passwords).replacementPasswords).toBe(passwords);

		// The mapping is the only object the values touch: no other object, and no prototype
		// anywhere in the realm, gained a property.
		expect(Object.getPrototypeOf({})).toBe(Object.prototype);
		expect(({} as Record<string, unknown>).um).toBeUndefined();
		expect(typeof ({} as Record<string, unknown>).constructor).toBe("function");

		// Nothing to carry is still nothing to carry: the minimal body stays minimal.
		expect(Object.keys(api.envelopeFor({}, api.passwordMap([])))).toEqual(["document"]);
		expect(Object.keys(api.envelopeFor({}, api.passwordMap(null)))).toEqual(["document"]);
	});
});

describe("Phase 5, Gate 5.3: no typed password outlives its attempt", () => {
	it("empties every password field, whatever it is handed", () => {
		const api = loadImportApi();
		const inputs = [{ value: "senha-um" }, { value: "senha-dois" }];

		expect(api.clearPasswordInputs(inputs)).toBe(2);
		expect(inputs.map((input) => input.value)).toEqual(["", ""]);

		expect(api.clearPasswordInputs([])).toBe(0);
		expect(api.clearPasswordInputs(null)).toBe(0);
		expect(api.clearPasswordInputs("senha")).toBe(0);
		// A field that is already gone is skipped instead of throwing.
		expect(api.clearPasswordInputs([null, undefined, { value: "senha-tres" }])).toBe(1);
	});

	it("discards the passwords and requires a new preview for every terminal failure", () => {
		const api = loadImportApi();

		// Every status an apply can end on, after the request was actually made.
		for (const status of [400, 409, 413, 500, 503]) {
			expect(api.applyFailureDisposition(status), String(status)).toEqual({
				discardPasswords: true,
				allowAnotherApply: false,
				stateUnknown: false,
			});
		}

		// A request that never produced an answer cannot claim any outcome, and it discards
		// the passwords too: a retry starts from a fresh review and a fresh entry.
		expect(api.applyFailureDisposition("network")).toEqual({
			discardPasswords: true,
			allowAnotherApply: false,
			stateUnknown: true,
		});
	});

	it("wires the cleanup into every terminal path of the drawer", () => {
		const admin = readPublic("admin.js");
		const discard = functionBody(admin, "discardImportPasswords");
		const end = functionBody(admin, "endImportAttempt");

		// One function ends an attempt: the passwords go through the helper's field emptier,
		// the review state is cleared and the approval is withdrawn, so an apply cannot run
		// under a review that already produced an outcome.
		expect(end).toContain("discardImportPasswords()");
		expect(end).toContain("state.importState = null");
		expect(end).toContain("state.importSelection.revokePreview()");
		expect(discard).toContain("clearPasswordInputs");
		expect(discard).toContain("querySelectorAll");
		expect(discard).toContain("importPasswords.hidden = true");

		// The reset that a new file, a close and the reset button all share empties the
		// fields directly; the attempt paths do it through `endImportAttempt`.
		expect(functionBody(admin, "resetImportReview")).toContain("discardImportPasswords()");
		expect(functionBody(admin, "renderImportSuccess")).toContain("endImportAttempt()");

		// The refusal and the unanswered request both end the attempt because the helper's
		// rule says every terminal failure does, not because a branch happens to be taken: a
		// branch that was disabled — or a rule that stopped discarding — breaks this pin.
		const failure = functionBody(admin, "renderImportFailure");
		expect(failure).toContain("ui.applyFailureDisposition(status).discardPasswords");
		expect(failure).toContain("endImportAttempt()");
		// The unanswered request and the unreadable answer share one ending, and it is that
		// one that ends the attempt.
		const unknown = functionBody(admin, "renderImportUnknownOutcome");
		expect(unknown).toContain("unknownOutcomePlan(");
		expect(unknown).toContain("endImportAttempt()");
		expect(functionBody(admin, "applyImport")).toContain("renderImportUnknownOutcome(");
		expect(functionBody(admin, "applyImport")).not.toContain("applyFailureDisposition");

		// Both terminal paths leave an apply that is unavailable until a new preview, and
		// the control's final state is derived instead of asserted by the path that ran.
		expect(failure).toContain("importApplyButton.hidden = true");
		expect(failure).toContain("importApplyButton.disabled = true");
		expect(unknown).toContain("importApplyButton.hidden = true");
		expect(functionBody(admin, "applyImport")).toContain("syncImportApplyState()");
	});
});

/**
 * The bodies `POST /api/import/apply` really answers with, copied from `src/index.ts`:
 * the success envelope (`c.json({ ok: true, groupsCreated, linksCreated })`), the document
 * refusal (`respondPortabilityImportRefusal`), the blocked envelope
 * (`respondPortabilityImportBlocked`) and the controlled internal error. A client test that
 * invents its own shapes would prove nothing about the contract it has to recognize.
 */
const APPLY_SUCCESS_BODY = JSON.stringify({ ok: true, groupsCreated: 1, linksCreated: 2 });
const APPLY_BLOCKED_BODY = JSON.stringify({
	ok: false,
	error: "Portability import blocked",
	code: "SLUG_COLLISION",
	blockers: ["SLUG_COLLISION"],
	summary: { groups: 1, links: 1, disabledLinks: 0, protectedLinks: 0, abTests: 0, smartRouting: 0 },
	conflicts: [{ slug: "ocupado" }],
	conflictsTotal: 1,
	requiresPasswords: [],
	warnings: ["METRICS_NOT_EXPORTED"],
});
const APPLY_PASSWORD_REQUIRED_BODY = JSON.stringify({
	ok: false,
	error: "Portability import refused: a replacement password is required for every protected link",
	code: "PASSWORD_REQUIRED",
	errors: [{ path: "replacementPasswords.protegido", code: "PASSWORD_REQUIRED" }],
});
const APPLY_TARGET_REFERENCE_BODY = JSON.stringify({
	ok: false,
	error: "Portability import blocked",
	code: "TARGET_GROUP_REFERENCE_CORRUPT",
	blockers: ["TARGET_GROUP_REFERENCE_CORRUPT"],
	conflicts: [],
	conflictsTotal: 0,
	requiresPasswords: [],
	warnings: ["METRICS_NOT_EXPORTED"],
});
const APPLY_DOCUMENT_REFUSAL_BODY = JSON.stringify({
	ok: false,
	error: "Portability import refused: invalid request body",
	code: "INVALID_BODY",
	errors: [],
});
const APPLY_INTERNAL_ERROR_BODY = JSON.stringify({ error: "Import could not be completed" });

describe("Phase 5, Gate 5.3: an apply answer the panel cannot read", () => {
	it("reads the verdict from the body, never from the status alone", () => {
		const api = loadImportApi();

		// A body the panel cannot read at all is no answer, so the verdict is the same whatever
		// the status said. A `200` with a truncated body is the case that matters: the import
		// may have run and committed, and the panel has no evidence either way.
		const unreadable = [
			"",
			"   ",
			'{"ok":true,"groupsCrea',
			"<html><body>502 Bad Gateway</body></html>",
			'{"ok":true}{"ok":false}',
			"null",
			"7",
			'"sucesso"',
			"[1,2]",
			undefined,
			null,
		];

		for (const status of [200, 204, 400, 409, 413, 500, 502, 503]) {
			for (const body of unreadable) {
				const verdict = api.readApplyResponse(status, body);
				expect(verdict.verdict, `${status} ${String(body)}`).toBe(api.VERDICT_UNKNOWN);
				expect(verdict.payload, `${status} ${String(body)}`).toBeNull();
				expect(verdict.status, `${status} ${String(body)}`).toBe(status);
			}
		}
	});

	it("accepts only the contract shapes the apply route really answers with", () => {
		const api = loadImportApi();

		const success = api.readApplyResponse(200, APPLY_SUCCESS_BODY);
		expect(success.verdict).toBe(api.VERDICT_SUCCESS);
		expect(success.payload).toEqual(JSON.parse(APPLY_SUCCESS_BODY));

		for (const [status, body] of [
			[409, APPLY_BLOCKED_BODY],
			[409, APPLY_PASSWORD_REQUIRED_BODY],
			[409, APPLY_TARGET_REFERENCE_BODY],
			[400, APPLY_DOCUMENT_REFUSAL_BODY],
		] as Array<[number, string]>) {
			const verdict = api.readApplyResponse(status, body);
			expect(verdict.verdict, `${status} ${body}`).toBe(api.VERDICT_REFUSED);
			expect(verdict.payload, `${status} ${body}`).toEqual(JSON.parse(body));
		}

		// The controlled internal error is the one answer whose contract is the status that
		// produces it plus a single `error` field: the route answers that after the batch
		// failed, and the batch is one transaction, so nothing was applied.
		const internal = api.readApplyResponse(500, APPLY_INTERNAL_ERROR_BODY);
		expect(internal.verdict).toBe(api.VERDICT_REFUSED);
		expect(internal.payload).toEqual({ error: "Import could not be completed" });

		// A benign extra field does not invalidate an envelope whose required fields are there.
		expect(api.readApplyResponse(200, JSON.stringify({ ok: true, groupsCreated: 0, linksCreated: 0, note: "x" })).verdict).toBe(api.VERDICT_SUCCESS);
	});

	it("treats a JSON object that is not the contract as no answer at all", () => {
		const api = loadImportApi();

		// Parsing is not the contract. Every one of these is valid JSON, and none of them is an
		// answer the route can produce, so none of them may authorize the panel to say what
		// happened to the destination.
		const notTheContract = [
			"{}",
			'{"foo":"bar"}',
			'{"ok":"yes"}',
			'{"ok":"false"}',
			'{"ok":1}',
			'{"ok":0}',
			'{"ok":null}',
			'{"ok":[]}',
			'{"ok":true}',
			'{"ok":false}',
			'{"groupsCreated":1}',
			'{"linksCreated":2}',
			'{"code":"SLUG_COLLISION"}',
			'{"error":"Import could not be completed","detail":"extra"}',
			'{"ok":true,"groupsCreated":"1","linksCreated":2}',
			'{"ok":true,"groupsCreated":1.5,"linksCreated":2}',
			'{"ok":true,"groupsCreated":-1,"linksCreated":0}',
			'{"ok":true,"groupsCreated":1}',
			'{"ok":false,"error":"x","code":"NAO_EXISTE","errors":[]}',
			'{"ok":false,"error":"","code":"SLUG_COLLISION","errors":[]}',
			'{"ok":false,"error":"x","code":"SLUG_COLLISION"}',
			'{"ok":false,"code":"SLUG_COLLISION","blockers":["SLUG_COLLISION"]}',
			'{"ok":false,"error":"x","code":"SLUG_COLLISION","errors":"nenhum"}',
		];

		// The two mandatory cases are inside this sweep: `200` with `{}` and `500` with `{}`.
		for (const status of [200, 400, 409, 413, 500]) {
			for (const body of notTheContract) {
				const verdict = api.readApplyResponse(status, body);
				expect(verdict.verdict, `${status} ${body}`).toBe(api.VERDICT_UNKNOWN);
				expect(verdict.payload, `${status} ${body}`).toBeNull();
				expect(verdict.status, `${status} ${body}`).toBe(status);
			}
		}

		// A lone `error` field is the internal-error envelope only on the status that produces
		// it: anywhere else it is a JSON object, not an answer.
		for (const status of [200, 400, 409, 413]) {
			expect(api.readApplyResponse(status, APPLY_INTERNAL_ERROR_BODY).verdict, String(status)).toBe(api.VERDICT_UNKNOWN);
		}
	});

	it("recognizes the controlled internal error only by its exact contract", () => {
		const api = loadImportApi();

		// The route writes exactly one sentence for this failure, and that sentence is part of
		// the contract. A `500` whose lone `error` field says anything else is a body the route
		// never produces, so the panel has no evidence about the destination and must not claim
		// that nothing was applied.
		const internal = api.readApplyResponse(500, APPLY_INTERNAL_ERROR_BODY);
		expect(internal.verdict).toBe(api.VERDICT_REFUSED);
		expect(internal.payload).toEqual({ error: "Import could not be completed" });

		// Every other lone message on a `500` is an unknown answer — including messages that
		// read like the right one, the exact sentence with padding and the exact sentence in
		// another casing. The comparison is exact; nothing is normalized on the way in.
		for (const body of [
			'{"error":"x"}',
			'{"error":"Internal error"}',
			'{"error":"Import failed"}',
			'{"error":""}',
			'{"error":" Import could not be completed "}',
			'{"error":"Import could not be completed."}',
			'{"error":"import could not be completed"}',
			'{"error":"Import could not be completed","detail":"extra"}',
		]) {
			const verdict = api.readApplyResponse(500, body);
			expect(verdict.verdict, body).toBe(api.VERDICT_UNKNOWN);
			expect(verdict.payload, body).toBeNull();
		}

		// The sentence alone is not the contract either: the status that produces it is.
		for (const status of [200, 204, 400, 409, 413, 502, 503]) {
			const verdict = api.readApplyResponse(status, APPLY_INTERNAL_ERROR_BODY);
			expect(verdict.verdict, String(status)).toBe(api.VERDICT_UNKNOWN);
			expect(verdict.payload, String(status)).toBeNull();
		}
	});

	it("plans a conservative ending for an outcome nobody can confirm", () => {
		const api = loadImportApi();

		// The chain the panel runs: status + raw body -> verdict -> terminal plan. The truncated
		// body, the well-formed object that is not the contract, and a `500` whose lone message
		// is not the one the route writes all end here.
		for (const [status, body] of [
			[200, '{"ok":true,"groupsCrea'],
			[500, '{"ok":true,"groupsCrea'],
			[200, "{}"],
			[500, "{}"],
			[500, '{"error":"x"}'],
			[500, '{"error":"Import failed"}'],
		] as Array<[number, string]>) {
			const verdict = api.readApplyResponse(status, body);
			expect(verdict.verdict, `${status} ${body}`).toBe(api.VERDICT_UNKNOWN);

			const plan = api.unknownOutcomePlan(null);
			expect(plan.discardPasswords, `${status} ${body}`).toBe(true);
			expect(plan.allowAnotherApply, `${status} ${body}`).toBe(false);
			expect(plan.stateUnknown, `${status} ${body}`).toBe(true);
			expect(plan.message, `${status} ${body}`).toContain("estado final é desconhecido");
			expect(plan.message, `${status} ${body}`).toContain("recarregue a lista de links e revise antes de tentar novamente");
			// It never claims what happened to the destination: not a rollback, not a success.
			expect(plan.message, `${status} ${body}`).not.toContain("Nenhuma alteração foi aplicada");
			expect(plan.message, `${status} ${body}`).not.toMatch(/sucesso/i);
		}

		// The transport's own words are kept as context for the retry, never as a claim.
		expect(api.unknownOutcomePlan("Failed to fetch").message).toContain("Failed to fetch");
		expect(api.unknownOutcomePlan("   ").message).toContain("Não foi possível importar a configuração.");
		expect(api.unknownOutcomePlan(undefined).message).toContain("Não foi possível importar a configuração.");
	});

	it("keeps a readable refusal a known outcome", () => {
		const api = loadImportApi();

		const refusal = api.readApplyResponse(409, APPLY_BLOCKED_BODY);
		expect(refusal.verdict).toBe(api.VERDICT_REFUSED);
		expect(refusal.payload).toEqual(JSON.parse(APPLY_BLOCKED_BODY));
		// The known-outcome treatment is unchanged: the transaction is what makes the claim
		// "nothing was applied" true, and the panel says it only for an answer it could read.
		expect(api.applyFailureDisposition(refusal.status).stateUnknown).toBe(false);
		expect(api.applyFailureDisposition(refusal.status).discardPasswords).toBe(true);
	});

	it("routes an unreadable answer through the unknown path in the panel", () => {
		const admin = readPublic("admin.js");
		const apply = functionBody(admin, "applyImport");

		// The body is interpreted by the helper — where the rule is tested — and the verdict is
		// what the panel branches on. The status alone decides nothing, which is what keeps the
		// old shape (`payload = null` on a parse failure, then a known-failure renderer) from
		// coming back: it would have to stop consulting the helper to do it.
		expect(apply).toContain("readApplyResponse(response.status, await response.text())");
		expect(apply).toContain("VERDICT_UNKNOWN");
		expect(apply).toContain("VERDICT_REFUSED");
		expect(apply).toContain("renderImportUnknownOutcome(");
		expect(apply).not.toContain("!payload?.ok");
		expect(apply).not.toContain("!response.ok");

		// An answer nobody can read and a request that never answered end the same way.
		const unknown = functionBody(admin, "renderImportUnknownOutcome");
		expect(unknown).toContain("unknownOutcomePlan(");
		expect(unknown).toContain("endImportAttempt()");
		expect(unknown).toContain("importApplyButton.hidden = true");
		// No success is claimed and nothing is refreshed as if it had been confirmed.
		expect(unknown).not.toMatch(/loadLinks|loadGroups|loadCapabilities/);
		expect(unknown).not.toContain("applyErrorMessage");

		// The known-refusal renderer stays the only place that makes that claim.
		expect(functionBody(admin, "renderImportFailure")).toContain("Nenhuma alteração foi aplicada.");
		expect(apply).not.toContain("Nenhuma alteração foi aplicada.");
	});
});

describe("Phase 5, Gate 5.3: import drawer markup and wiring", () => {
	it("loads the import helper before the admin script", () => {
		const html = readPublic("admin.html");
		const scripts = Array.from(html.matchAll(/<script src="([^"]+)"/g)).map((match) => match[1]);

		expect(scripts).toContain("/portability-import-ui.js");
		expect(scripts.indexOf("/portability-import-ui.js")).toBeLessThan(scripts.indexOf("/admin.js"));
		expect(scripts.indexOf("/portability-ui.js")).toBeLessThan(scripts.indexOf("/portability-import-ui.js"));
	});

	it("renames the export action and adds the import one next to it", () => {
		const html = readPublic("admin.html");

		expect(html).toMatch(/>Exportar configuração<\/button>/);
		expect(html).toMatch(/<button type="button"[^>]*id="import-drawer-open"[^>]*aria-haspopup="dialog"[^>]*aria-expanded="false"[^>]*aria-controls="import-drawer"[^>]*>Importar \/ Exportar<\/button>/);
		expect(html).not.toMatch(/>Exportar dados<\/button>/);
	});

	it("declares the drawer as a labelled dialog that starts closed", () => {
		const html = readPublic("admin.html");
		const drawer = html.slice(html.indexOf('id="import-drawer"') - 400, html.indexOf('id="import-status"') + 200);

		expect(drawer).toMatch(/role="dialog"/);
		expect(drawer).toMatch(/aria-modal="true"/);
		expect(drawer).toMatch(/aria-labelledby="import-drawer-title"/);
		expect(drawer).toMatch(/aria-hidden="true"/);
		expect(drawer).toMatch(/\binert\b/);
		expect(drawer).toContain('<h2 id="import-drawer-title">Importar / Exportar configuração</h2>');
		expect(drawer).toContain("Importe links e grupos de uma exportação do BoltLink.");
		expect(drawer).toMatch(/id="import-drawer-close"[^>]*aria-label="[^"]+"/);
	});

	it("takes a JSON file through a real label and states the limit", () => {
		const html = readPublic("admin.html");

		expect(html).toMatch(/<label for="import-file">Selecionar arquivo<\/label>/);
		expect(html).toMatch(/<input id="import-file" type="file" accept="application\/json,\.json" \/>/);
		expect(html).toContain('Use um arquivo gerado por "Exportar configuração". Limite: 256 KiB.');
		// No drag-and-drop surface was added: the scope of this gate is the picker.
		expect(html).not.toMatch(/ondrop|dragenter|drag-over/i);
	});

	it("keeps every control the drawer needs, and starts with apply disabled", () => {
		const html = readPublic("admin.html");
		const ids = Array.from(html.matchAll(/\sid="([^"]+)"/g)).map((match) => match[1]);

		for (const id of [
			"import-drawer",
			"import-drawer-open",
			"import-drawer-close",
			"import-drawer-backdrop",
			"import-file",
			"import-file-name",
			"import-review",
			"import-summary",
			"import-warnings",
			"import-conflicts",
			"import-blockers",
			"import-errors",
			"import-passwords",
			"import-password-fields",
			"import-plan",
			"import-apply-button",
			"import-reset-button",
			"import-done-button",
			"import-status",
		]) {
			expect(ids, id).toContain(id);
		}
		expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
		expect(html).toMatch(/id="import-apply-button" disabled>Importar configuração<\/button>/);
		expect(html).toMatch(/id="import-done-button" hidden>Concluir<\/button>/);
		expect(html).toMatch(/id="import-status" role="status" aria-live="polite"/);
		expect(html).toMatch(/id="import-passwords" hidden/);
	});

	it("renders every imported value through textContent, never through an HTML sink", () => {
		const admin = readPublic("admin.js");

		for (const name of IMPORT_FUNCTIONS) {
			const body = functionBody(admin, name);
			expect(body, name).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
			expect(body, name).not.toMatch(/\beval\(|new Function\(/);
		}

		expect(functionBody(admin, "appendImportLine")).toContain("item.textContent = text");
		expect(functionBody(admin, "appendImportIssue")).toContain("label.textContent = path");
		expect(functionBody(admin, "appendImportIssue")).toContain("copy.textContent = message");
		expect(functionBody(admin, "renderImportPasswords")).toContain("input.type = \"password\"");
		expect(functionBody(admin, "renderImportPasswords")).toContain('input.autocomplete = "new-password"');
		expect(functionBody(admin, "renderImportPasswords")).toContain("label.setAttribute(\"for\", inputId)");
	});

	it("never stores a password, in the browser or in the request line", () => {
		const admin = readPublic("admin.js");

		expect(admin).not.toMatch(/localStorage|sessionStorage/);
		for (const name of IMPORT_FUNCTIONS) {
			const body = functionBody(admin, name);
			expect(body, name).not.toMatch(/localStorage|sessionStorage/);
			// The only place a password travels is the JSON body of the apply request.
			expect(body, name).not.toMatch(/location\.(href|assign|replace)|URLSearchParams|\?senha=|&password=/);
		}

		const collect = functionBody(admin, "collectImportPasswords");
		expect(collect).toContain("input.value.trim()");
		expect(collect).not.toMatch(/console\./);

		// The apply is the only request that carries them, and it sends them in the body.
		const apply = functionBody(admin, "applyImport");
		expect(apply).toContain("envelopeFor(state.importDocument, collectImportPasswords())");
		expect(apply).toContain("JSON.stringify");
		expect(apply).not.toMatch(/console\./);
	});

	it("asks the API for the preview and revalidates by applying the same document", () => {
		const admin = readPublic("admin.js");

		const preview = functionBody(admin, "requestImportPreview");
		expect(preview).toContain("fetch(portabilityImportUi.PREVIEW_PATH");
		expect(preview).toContain('credentials: "same-origin"');
		expect(preview).toContain("envelopeFor(document)");

		const apply = functionBody(admin, "applyImport");
		expect(apply).toContain("fetch(portabilityImportUi.APPLY_PATH");
		expect(apply).toContain('credentials: "same-origin"');
		// The document that is applied is the one the preview described, held in state.
		expect(apply).toContain("state.importDocument");
		expect(admin).toContain("state.importDocument = parsed");
	});

	it("reads the file locally only to size it and to parse it", () => {
		const admin = readPublic("admin.js");
		const body = functionBody(admin, "handleImportFileSelection");

		expect(body).toContain("portabilityImportUi.fileTooLarge(file.size)");
		expect(body).toContain("await file.text()");
		expect(body).toContain("JSON.parse");
		expect(body).toContain("localDocumentProblem(parsed)");
		// A broken file is answered with copy, not with a stack trace.
		expect(body).toContain("Não foi possível ler o arquivo como JSON");
		expect(body).not.toMatch(/console\.|error\.stack/);
	});

	it("discards the review whenever the file changes", () => {
		const admin = readPublic("admin.js");
		const body = functionBody(admin, "handleImportFileSelection");

		expect(body).toContain("resetImportReview()");
		expect(admin).toContain('importFileInput.addEventListener("change"');
		expect(admin).toContain("handleImportFileSelection()");
		expect(admin).toContain('importResetButton.addEventListener("click"');
		expect(admin).toContain("resetImportDrawer()");
	});

	it("shows the summary for a valid preview as well as for a refused one", () => {
		const admin = readPublic("admin.js");
		const body = functionBody(admin, "renderImportResult");

		// The panel reviews a plan through its counts, so the summary cannot be conditional on
		// the answer being a refusal. A real browser found the inverted guard this pins.
		expect(body).toContain("renderImportSummary(payload?.summary);");
		expect(body).not.toMatch(/if \(responseState !== ui\.STATE_VALID\) \{\s*renderImportSummary/);
		expect(functionBody(admin, "renderImportSummary")).toContain("importSummary.hidden = false");
	});

	it("enables apply only for a valid, unblocked, fully supplied plan", () => {
		const admin = readPublic("admin.js");
		const body = functionBody(admin, "syncImportApplyState");

		expect(body).toContain("state.importState === portabilityImportUi.STATE_VALID");
		expect(body).toContain('querySelectorAll("input[data-slug]")');
		expect(body).toContain("importApplyButton.disabled = !enabled");
		// A collision or a blocker leaves the state at BLOCKED, so apply stays disabled and
		// no overwrite is ever offered.
		expect(admin).toContain("importReview.hidden = false");
		expect(admin).not.toMatch(/sobrescrever|overwrite|forçar importação/i);
	});

	it("never leaves apply clickable before a reviewed preview", () => {
		const admin = readPublic("admin.js");
		const reset = functionBody(admin, "resetImportReview");

		// The reset must end with `disabled = true`: `setBusy` writes `disabled` itself, so a
		// reset that cleared the flag afterwards would enable the button on an empty drawer.
		// A real browser caught exactly that, which is why the order is pinned here.
		const busyIndex = reset.indexOf("setBusy(importApplyButton, false)");
		const disabledIndex = reset.indexOf("importApplyButton.disabled = true");
		expect(busyIndex).toBeGreaterThan(-1);
		expect(disabledIndex).toBeGreaterThan(busyIndex);

		expect(functionBody(admin, "openImportDrawer")).toContain("resetImportDrawer()");
		expect(functionBody(admin, "closeImportDrawer")).toContain("resetImportDrawer()");
		expect(functionBody(admin, "applyImport")).toContain("!state.importDocument");
	});

	it("prevents a double submission and reports an honest failure", () => {
		const admin = readPublic("admin.js");
		const apply = functionBody(admin, "applyImport");

		expect(apply).toContain("state.importApplying");
		expect(apply).toContain("setBusy(importApplyButton, true)");
		expect(apply).toContain("Importando configuração...");
		expect(apply).not.toMatch(/%|progress/i);
		// The failure path says nothing was applied, and it is true because the API applies
		// the document as one transaction.
		expect(functionBody(admin, "renderImportFailure")).toContain("Nenhuma alteração foi aplicada.");
		// A request that never answered cannot claim any outcome, so it says so instead and
		// asks for a reload and a fresh review before the next attempt. That ending lives in
		// the unknown-outcome renderer, which the apply reaches by verdict, not by status.
		expect(apply).toContain("renderImportUnknownOutcome(");
		expect(apply).not.toContain("Nenhuma alteração foi aplicada.");
		expect(functionBody(admin, "renderImportUnknownOutcome")).not.toContain("Nenhuma alteração foi aplicada.");
	});

	it("refreshes the panel after success without reloading the page", () => {
		const admin = readPublic("admin.js");
		const body = functionBody(admin, "renderImportSuccess");

		expect(body).toContain("loadCapabilities()");
		expect(body).toContain("loadLinks()");
		expect(body).toContain("loadGroups()");
		expect(body).not.toMatch(/location\.reload|window\.location/);
		expect(admin).not.toMatch(/location\.reload/);
	});
});

describe("Phase 5, Gate 5.3: the two drawers coexist", () => {
	it("closes the other drawer when one opens, in both directions", () => {
		const admin = readPublic("admin.js");

		expect(functionBody(admin, "openImportDrawer")).toContain("closeGroupDrawer()");
		expect(functionBody(admin, "openGroupDrawer")).toContain("closeImportDrawer()");
	});

	it("keeps the modal contract on both drawers", () => {
		const admin = readPublic("admin.js");

		for (const [open, close, keydown] of [
			["openImportDrawer", "closeImportDrawer", "onImportDrawerKeydown"],
			["openGroupDrawer", "closeGroupDrawer", "onGroupDrawerKeydown"],
		]) {
			const openBody = functionBody(admin, open);
			expect(openBody, open).toContain("lockBodyScroll()");
			expect(openBody, open).toContain('setAttribute("aria-expanded", "true")');
			expect(openBody, open).toContain("removeAttribute(\"inert\")");
			expect(openBody, open).toContain(`document.addEventListener("keydown", ${keydown})`);
			expect(openBody, open).toContain("CloseButton.focus()");

			const closeBody = functionBody(admin, close);
			expect(closeBody, close).toContain("unlockBodyScroll()");
			expect(closeBody, close).toContain('setAttribute("inert", "")');
			expect(closeBody, close).toContain('setAttribute("aria-expanded", "false")');
			expect(closeBody, close).toContain(`document.removeEventListener("keydown", ${keydown})`);
			expect(closeBody, close).toContain("OpenButton.focus()");
		}
	});

	it("closes the import drawer on Escape and traps Tab inside it", () => {
		const admin = readPublic("admin.js");

		expect(functionBody(admin, "onImportDrawerKeydown")).toContain('event.key === "Escape"');
		expect(functionBody(admin, "onImportDrawerKeydown")).toContain("closeImportDrawer()");
		expect(functionBody(admin, "onImportDrawerKeydown")).toContain("keepImportDrawerFocus(event)");

		expect(functionBody(admin, "keepImportDrawerFocus")).toContain("keepDrawerFocus(event, importDrawer)");
		const trap = functionBody(admin, "keepDrawerFocus");
		expect(trap).toContain('event.key !== "Tab"');
		expect(trap).toContain("event.preventDefault()");
		expect(trap).toContain("first.focus()");
		expect(trap).toContain("last.focus()");

		expect(admin).toContain('importDrawerBackdrop.addEventListener("click"');
		expect(admin).toContain('importDrawerCloseButton.addEventListener("click"');
		expect(admin).toContain('importDrawerOpenButton.addEventListener("click"');
	});

	it("leaves the group drawer's own contract untouched", () => {
		const admin = readPublic("admin.js");
		const groupOpen = functionBody(admin, "openGroupDrawer");

		// The frozen Gate 5.1 controls and behaviour are all still there.
		expect(groupOpen).toContain('selectGroupTab("tree")');
		expect(groupOpen).toContain('setStatus(groupStatus, "")');
		expect(groupOpen).toContain('groupDrawer.classList.add("is-open")');
		// The only statement the import added to the frozen drawer is the interop call: the
		// drawer's own rendering, tabs and focus handling are untouched.
		const importStatements = groupOpen
			.split("\n")
			.filter((line) => /import/i.test(line) && !line.trim().startsWith("*") && !line.trim().startsWith("//"));
		expect(importStatements.length).toBe(1);
		expect(importStatements[0]).toContain("closeImportDrawer()");
	});

	it("stacks the drawers the same way and reports the same accessibility contract", () => {
		const css = readPublic("admin.css");

		expect(css).toMatch(/\.trash-drawer-backdrop\s*\{[^}]*position: fixed;/);
		expect(css).toMatch(/\.trash-drawer\s*\{[^}]*width: min\(30rem, 100%\);/);
		expect(css).toMatch(/\.trash-drawer-body\s*\{[^}]*overflow-y: auto;/);
		// The reduced-motion rule the group drawer needs applies to this drawer too.
		expect(css).toMatch(/\.group-drawer, \.import-drawer, \.trash-drawer,[\s\S]*?transition: none;/);
	});
});

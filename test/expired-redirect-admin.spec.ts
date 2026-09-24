/*
 * Copyright (c) 2026 Vitor Faustino
 * AGPL-3.0 License — https://github.com/vitorgfaustino/boltlink
 *
 * Gate 4.3: expired-destination admin UX coverage.
 *
 * The helpers are pure and DOM-free so the form state, the atomic clearing rule
 * and the final payload can be verified in Node, through the same payload
 * authority the real submit uses. Source scans prove the persisted destination is
 * never rendered as HTML and that the field is mentioned only when the database
 * capability allows it.
 */

// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type ExpiredSelection = { mode: string; url: string };

type ExpiredFields = {
	ok: boolean;
	code?: string;
	mode: string;
	url: string;
	value?: string | null;
};

type ExpiredApi = {
	MODE_RESPONSE: string;
	MODE_REDIRECT: string;
	MISSING_DESTINATION_CODE: string;
	isExpiredRedirectMode: (value: unknown) => boolean;
	resolveExpiredRedirectFields: (values: Record<string, unknown>) => ExpiredFields;
	expiredRedirectFromLink: (link: unknown, capability: boolean) => ExpiredSelection;
	canRedirectAfterExpiration: (values: Record<string, unknown>) => boolean;
	expiredRedirectErrorMessage: (code: unknown) => string;
};

type SubmissionApi = {
	buildLinkSubmissionPayload: (input: Record<string, unknown>) => {
		ok: boolean;
		code?: string;
		payload?: Record<string, unknown>;
		path?: string;
		method?: string;
	};
	submitLinkForm: (
		input: Record<string, unknown>,
		options?: { fetchImpl?: typeof fetch },
	) => Promise<{ ok: boolean; code?: string; requestCount: number; payload?: Record<string, unknown> }>;
};

type Sandbox = {
	window: { BoltLinkExpiredRedirect?: ExpiredApi; BoltLinkSmartRouting?: SubmissionApi };
	URL: typeof URL;
};

type FetchRecorder = { calls: Array<{ url: string; init: RequestInit }>; fetchImpl: typeof fetch };

const EXPIRATION = "2026-12-01T12:00:00.000Z";
const DESTINATION = "https://exemplo.com/expirado";

function readPublic(file: string) {
	return readFileSync(resolve(process.cwd(), `public/${file}`), "utf8");
}

/** The whole `fieldset`, including the opening tag that carries its attributes. */
function expiredRedirectMarkup(html: string) {
	const id = html.indexOf('id="expired-redirect-section"');
	return html.slice(html.lastIndexOf("<fieldset", id), html.indexOf('id="expired-redirect-unavailable"'));
}

function createSandbox(): Sandbox {
	const sandbox: Sandbox = { window: {}, URL };
	vm.createContext(sandbox);
	return sandbox;
}

function loadExpiredApi(): ExpiredApi {
	const sandbox = createSandbox();
	vm.runInContext(readPublic("expired-redirect-ui.js"), sandbox);
	const api = sandbox.window.BoltLinkExpiredRedirect;
	if (!api) {
		throw new Error("BoltLinkExpiredRedirect not registered");
	}
	return api;
}

/**
 * Loads the single payload authority. `withExpiredHelper: false` models a page
 * where the helper module failed to load, which must abort the submission instead
 * of dropping the field.
 */
function loadSubmissionApi(options: { withExpiredHelper?: boolean } = {}): SubmissionApi {
	const sandbox = createSandbox();
	if (options.withExpiredHelper !== false) {
		vm.runInContext(readPublic("expired-redirect-ui.js"), sandbox);
	}
	vm.runInContext(readPublic("smart-routing-ui.js"), sandbox);
	const api = sandbox.window.BoltLinkSmartRouting;
	if (!api) {
		throw new Error("BoltLinkSmartRouting not registered");
	}
	return api;
}

function recordFetch(responseBody: unknown, ok = true, status = 200): FetchRecorder {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
		calls.push({ url: String(url), init: init || {} });
		return { ok, status, json: async () => responseBody } as Response;
	}) as typeof fetch;
	return { calls, fetchImpl };
}

function submissionInput(overrides: Record<string, unknown> = {}) {
	return {
		mode: "create",
		editingSlug: null,
		capabilities: { abTesting: true, smartRouting: true, expiredRedirect: true },
		slug: "nova",
		targetUrl: "https://example.com/fallback",
		redirectType: "302",
		tags: ["a"],
		groupId: null,
		goLiveAt: undefined,
		expiresAt: undefined,
		password: undefined,
		ab: { enabled: false, targetUrl: null, weightB: 50 },
		smart: { enabled: false, rules: [] },
		expired: { mode: "410", url: "" },
		...overrides,
	};
}

describe("Phase 4: expired destination form state (Gate 4.3)", () => {
	it("resolves the default response for a link without an expiration", () => {
		const api = loadExpiredApi();

		expect(api.resolveExpiredRedirectFields({ mode: api.MODE_RESPONSE, url: "", expiresAt: undefined })).toEqual({
			ok: true,
			mode: api.MODE_RESPONSE,
			url: "",
			value: null,
		});
		expect(api.resolveExpiredRedirectFields({})).toEqual({
			ok: true,
			mode: api.MODE_RESPONSE,
			url: "",
			value: null,
		});
	});

	it("resolves the destination only when an expiration exists", () => {
		const api = loadExpiredApi();

		expect(
			api.resolveExpiredRedirectFields({
				mode: api.MODE_REDIRECT,
				url: DESTINATION,
				expiresAt: EXPIRATION,
			}),
		).toEqual({ ok: true, mode: api.MODE_REDIRECT, url: DESTINATION, value: DESTINATION });
	});

	it("switching back to the default response clears the destination and keeps the expiration", () => {
		const api = loadExpiredApi();

		expect(
			api.resolveExpiredRedirectFields({
				mode: api.MODE_RESPONSE,
				url: DESTINATION,
				expiresAt: EXPIRATION,
			}),
		).toEqual({ ok: true, mode: api.MODE_RESPONSE, url: "", value: null });
	});

	it("clearing the expiration clears the destination in the same resolution", () => {
		const api = loadExpiredApi();

		for (const expiresAt of [undefined, null, "", "   "]) {
			expect(
				api.resolveExpiredRedirectFields({ mode: api.MODE_REDIRECT, url: DESTINATION, expiresAt }),
				`expiresAt ${JSON.stringify(expiresAt)}`,
			).toEqual({ ok: true, mode: api.MODE_RESPONSE, url: "", value: null });
		}
	});

	it("treats a redirect selected without an expiration as the default response", () => {
		const api = loadExpiredApi();

		const resolved = api.resolveExpiredRedirectFields({ mode: api.MODE_REDIRECT, url: DESTINATION, expiresAt: "" });

		expect(resolved.ok).toBe(true);
		expect(resolved.value).toBeNull();
		expect(resolved.mode).toBe(api.MODE_RESPONSE);
	});

	it("rejects an empty destination in redirect mode instead of submitting a contradiction", () => {
		const api = loadExpiredApi();

		for (const url of ["", "   "]) {
			expect(api.resolveExpiredRedirectFields({ mode: api.MODE_REDIRECT, url, expiresAt: EXPIRATION })).toEqual({
				ok: false,
				code: api.MISSING_DESTINATION_CODE,
				mode: api.MODE_REDIRECT,
				url: "",
			});
		}
	});

	it("only accepts the two known modes", () => {
		const api = loadExpiredApi();

		expect(api.isExpiredRedirectMode("410")).toBe(true);
		expect(api.isExpiredRedirectMode("redirect")).toBe(true);
		expect(api.isExpiredRedirectMode("301")).toBe(false);
		expect(api.isExpiredRedirectMode(undefined)).toBe(false);
	});

	it("populates the persisted destination of a link without loss", () => {
		const api = loadExpiredApi();

		expect(api.expiredRedirectFromLink({ expiredRedirectUrl: DESTINATION }, true)).toEqual({
			mode: api.MODE_REDIRECT,
			url: DESTINATION,
		});
		expect(api.expiredRedirectFromLink({ expiredRedirectUrl: null }, true)).toEqual({ mode: api.MODE_RESPONSE, url: "" });
		expect(api.expiredRedirectFromLink({}, true)).toEqual({ mode: api.MODE_RESPONSE, url: "" });
		expect(api.expiredRedirectFromLink({ expiredRedirectUrl: "   " }, true)).toEqual({ mode: api.MODE_RESPONSE, url: "" });
	});

	it("ignores a persisted destination when the capability is absent", () => {
		const api = loadExpiredApi();

		expect(api.expiredRedirectFromLink({ expiredRedirectUrl: DESTINATION }, false)).toEqual({
			mode: api.MODE_RESPONSE,
			url: "",
		});
		expect(api.expiredRedirectFromLink(null, true)).toEqual({ mode: api.MODE_RESPONSE, url: "" });
	});

	it("offers the redirect option only with the capability and a filled expiration", () => {
		const api = loadExpiredApi();

		expect(api.canRedirectAfterExpiration({ capability: true, expiresAt: EXPIRATION })).toBe(true);
		expect(api.canRedirectAfterExpiration({ capability: true, expiresAt: "" })).toBe(false);
		expect(api.canRedirectAfterExpiration({ capability: false, expiresAt: EXPIRATION })).toBe(false);
		expect(api.canRedirectAfterExpiration({})).toBe(false);
	});

	it("keeps a hostile destination as a literal value, never as markup", () => {
		const api = loadExpiredApi();
		const hostile = `https://exemplo.com/x"><img src=x onerror=alert(1)>`;

		const resolved = api.resolveExpiredRedirectFields({
			mode: api.MODE_REDIRECT,
			url: hostile,
			expiresAt: EXPIRATION,
		});

		expect(resolved.ok).toBe(true);
		expect(resolved.value).toBe(hostile);
		expect(resolved.value).not.toContain("&lt;");
	});

	it("uses static copy for the local failure message", () => {
		const api = loadExpiredApi();

		expect(api.expiredRedirectErrorMessage(api.MISSING_DESTINATION_CODE)).toBe("Informe o destino após a expiração.");
		expect(api.expiredRedirectErrorMessage("SOMETHING_ELSE")).not.toContain("undefined");
	});
});

describe("Phase 4: expired destination payload authority (Gate 4.3)", () => {
	it("omits expiredRedirectUrl entirely when the capability is absent", () => {
		const api = loadSubmissionApi();
		const cases = [
			{ abTesting: true, smartRouting: true },
			{ abTesting: true, smartRouting: true, expiredRedirect: false },
		];

		for (const capabilities of cases) {
			const built = api.buildLinkSubmissionPayload(
				submissionInput({
					capabilities,
					expiresAt: EXPIRATION,
					expired: { mode: "redirect", url: DESTINATION },
				}),
			);

			expect(built.ok).toBe(true);
			expect(Object.prototype.hasOwnProperty.call(built.payload, "expiredRedirectUrl")).toBe(false);
		}
	});

	it("sends an explicit null for the default response when the capability is present", async () => {
		const api = loadSubmissionApi();
		const recorder = recordFetch({ link: { slug: "nova" } });

		const result = await api.submitLinkForm(
			submissionInput({ capabilities: { abTesting: true, smartRouting: true, expiredRedirect: true } }),
			{ fetchImpl: recorder.fetchImpl },
		);

		expect(result.ok).toBe(true);
		const body = JSON.parse(String(recorder.calls[0].init.body)) as Record<string, unknown>;
		expect(body.expiredRedirectUrl).toBeNull();
		expect(body.expiresAt).toBeUndefined();
	});

	it("sends the destination when an expiration and a redirect are configured", async () => {
		const api = loadSubmissionApi();
		const recorder = recordFetch({ link: { slug: "nova" } });

		await api.submitLinkForm(
			submissionInput({
				expiresAt: EXPIRATION,
				expired: { mode: "redirect", url: DESTINATION },
			}),
			{ fetchImpl: recorder.fetchImpl },
		);

		const body = JSON.parse(String(recorder.calls[0].init.body)) as Record<string, unknown>;
		expect(body.expiredRedirectUrl).toBe(DESTINATION);
		expect(body.expiresAt).toBe(EXPIRATION);
	});

	it("preserves a configured destination on an unrelated edit", async () => {
		const api = loadExpiredApi();
		const submission = loadSubmissionApi();
		const link = { expiredRedirectUrl: DESTINATION, expires_at: EXPIRATION };
		const recorder = recordFetch({ link: { slug: "promo" } });

		await submission.submitLinkForm(
			submissionInput({
				mode: "edit",
				editingSlug: "promo",
				tags: ["renomeado"],
				expiresAt: EXPIRATION,
				expired: api.expiredRedirectFromLink(link, true),
			}),
			{ fetchImpl: recorder.fetchImpl },
		);

		const body = JSON.parse(String(recorder.calls[0].init.body)) as Record<string, unknown>;
		expect(body.tags).toEqual(["renomeado"]);
		expect(body.expiredRedirectUrl).toBe(DESTINATION);
	});

	it("never sends expiresAt: null while keeping a destination", async () => {
		const api = loadExpiredApi();
		const submission = loadSubmissionApi();
		const recorder = recordFetch({ link: { slug: "promo" } });

		// The operator cleared "Expira em" but left the redirect selected: the
		// resolution has to drop the destination in the same request.
		await submission.submitLinkForm(
			submissionInput({
				mode: "edit",
				editingSlug: "promo",
				expiresAt: null,
				expired: { mode: api.MODE_REDIRECT, url: DESTINATION },
			}),
			{ fetchImpl: recorder.fetchImpl },
		);

		const body = JSON.parse(String(recorder.calls[0].init.body)) as Record<string, unknown>;
		expect(body.expiresAt).toBeNull();
		expect(body.expiredRedirectUrl).toBeNull();
	});

	it("fails closed with zero requests on an empty redirect destination", async () => {
		const api = loadSubmissionApi();
		const recorder = recordFetch({ link: { slug: "nova" } });

		const result = await api.submitLinkForm(
			submissionInput({ expiresAt: EXPIRATION, expired: { mode: "redirect", url: "  " } }),
			{ fetchImpl: recorder.fetchImpl },
		);

		expect(result).toMatchObject({ ok: false, code: "MISSING_EXPIRED_DESTINATION", requestCount: 0 });
		expect(recorder.calls).toHaveLength(0);
	});

	it("fails closed when the helper module is missing instead of dropping the field", async () => {
		const api = loadSubmissionApi({ withExpiredHelper: false });
		const recorder = recordFetch({ link: { slug: "promo" } });

		const result = await api.submitLinkForm(
			submissionInput({
				mode: "edit",
				editingSlug: "promo",
				expiresAt: EXPIRATION,
				expired: { mode: "redirect", url: DESTINATION },
			}),
			{ fetchImpl: recorder.fetchImpl },
		);

		expect(result).toMatchObject({ ok: false, code: "EXPIRED_REDIRECT_UNAVAILABLE", requestCount: 0 });
		expect(recorder.calls).toHaveLength(0);
	});

	it("keeps the pre-0006 request shape unchanged", async () => {
		const api = loadSubmissionApi();
		const recorder = recordFetch({ link: { slug: "nova" } });

		const result = await api.submitLinkForm(
			submissionInput({ capabilities: undefined }),
			{ fetchImpl: recorder.fetchImpl },
		);

		expect(result.ok).toBe(true);
		const body = JSON.parse(String(recorder.calls[0].init.body)) as Record<string, unknown>;
		expect(body).toEqual({
			slug: "nova",
			targetUrl: "https://example.com/fallback",
			redirectType: "302",
			tags: ["a"],
			groupId: null,
			goLiveAt: undefined,
			expiresAt: undefined,
			password: undefined,
		});
	});
});

describe("Phase 4: expired destination admin wiring (Gate 4.3)", () => {
	it("registers the expired destination controls with unique ids", () => {
		const html = readPublic("admin.html");
		const ids = Array.from(html.matchAll(/\sid="([^"]+)"/g)).map((match) => match[1]);
		expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);

		for (const expected of [
			"expired-redirect-section",
			"expired-redirect-unavailable",
			"expired-redirect-mode-response",
			"expired-redirect-mode-url",
			"expired-redirect-url-field",
			"expired-redirect-url",
		]) {
			expect(ids, `missing ${expected}`).toContain(expected);
		}
	});

	it("labels the group and pairs each radio with its own text", () => {
		const html = readPublic("admin.html");
		const section = expiredRedirectMarkup(html);

		expect(section).toContain("<fieldset");
		expect(section).toMatch(/<legend>[^<]*Após expirar/);
		expect(section).toMatch(/Após expirar[\s\S]*Resposta padrão \(410\)/);
		expect(section).toMatch(/Redirecionar para URL/);
		expect(section).toMatch(/Destino após expiração/);
		// The browser hint is not the gate, but the field is a real URL input.
		expect(section).toMatch(/<input id="expired-redirect-url"[^>]*type="url"/);
		// Only the default response starts enabled in the markup, and the whole
		// block starts hidden: the feature is revealed by the capability, never
		// by the markup.
		expect(section).toMatch(/id="expired-redirect-mode-response"[^>]*checked/);
		expect(section).toMatch(/<fieldset[^>]*id="expired-redirect-section"[^>]*hidden/);
	});

	it("loads the helper module before the admin script", () => {
		const html = readPublic("admin.html");
		const scripts = Array.from(html.matchAll(/<script src="([^"]+)"/g)).map((match) => match[1]);

		expect(scripts).toContain("/expired-redirect-ui.js");
		expect(scripts.indexOf("/expired-redirect-ui.js")).toBeLessThan(scripts.indexOf("/admin.js"));
	});

	it("gates the whole feature on the expiredRedirect capability", () => {
		const admin = readPublic("admin.js");

		expect(admin).toContain("state.expiredRedirect = payload?.expiredRedirect === true");
		expect(admin).toContain("state.expiredRedirect = false");
		expect(admin).toContain("applyExpiredRedirectCapabilityToUi()");
		expect(admin).toContain("expiredRedirect: state.expiredRedirect");
		expect(admin).toContain("expiredRedirectSection.hidden = !available");
		expect(admin).toContain("expiredRedirectUnavailable.hidden = available");
		// The redirect option and the destination are unusable without the capability.
		expect(admin).toContain("expiredRedirectModeResponse.disabled = !available");
		expect(admin).toContain("expiredRedirectModeUrl.disabled = !canRedirect");
	});

	it("clears the destination when the expiration is cleared and on form reset", () => {
		const admin = readPublic("admin.js");
		const sync = admin.slice(admin.indexOf("function syncExpiredRedirectConstraint"));
		const reset = admin.slice(admin.indexOf("function resetForm"), admin.indexOf("function beginEdit"));

		expect(sync).toContain("expiredRedirectUrlInput.value = \"\"");
		expect(sync).toContain("expiredRedirectUrlInput.disabled = !isRedirect");
		expect(sync).toContain("expiredRedirectUrlField.hidden = !isRedirect");
		expect(admin).toContain('expiresAtInput.addEventListener("input", syncExpiredRedirectConstraint)');
		expect(admin).toContain('expiresAtInput.addEventListener("change", syncExpiredRedirectConstraint)');
		expect(reset).toContain("setExpiredRedirectMode");
		expect(reset).toContain("syncExpiredRedirectConstraint()");
	});

	it("populates the persisted destination on edit and re-syncs on submit", () => {
		const admin = readPublic("admin.js");
		const beginEdit = admin.slice(admin.indexOf("function beginEdit"), admin.indexOf("function createClientSlug"));
		const selection = admin.slice(
			admin.indexOf("function applyExpiredRedirectSelection"),
			admin.indexOf("function applyExpiredRedirectCapabilityToUi"),
		);
		const submit = admin.slice(admin.indexOf('linkForm.addEventListener("submit"'));

		expect(beginEdit).toContain("applyExpiredRedirectSelection(link)");
		expect(selection).toContain("expiredRedirectUrlInput.value = selection.url");
		expect(selection).toContain("expiredRedirectUi.expiredRedirectFromLink(link, state.expiredRedirect)");
		expect(beginEdit.indexOf("applyExpiredRedirectSelection(link)")).toBeGreaterThan(
			beginEdit.indexOf("expiresAtInput.value"),
		);
		expect(submit).toContain("syncExpiredRedirectConstraint()");
		expect(submit).toContain("mode: selectedExpiredRedirectMode()");
		expect(submit).toContain("url: expiredRedirectUrlInput.value.trim()");
	});

	it("announces the local destination failure once, through the polite status", () => {
		const admin = readPublic("admin.js");

		expect(admin).toContain("expiredRedirectUi.MISSING_DESTINATION_CODE");
		expect(admin).toContain("setStatus(formStatus, expiredRedirectUi.expiredRedirectErrorMessage(result.code), \"error\")");
		expect(admin).not.toMatch(/formStatus\.innerHTML/);
	});

	it("sends an emptied expiration as an explicit null so the repair path is reachable", async () => {
		const api = loadExpiredApi();
		const submission = loadSubmissionApi();
		const admin = readPublic("admin.js");
		const recorder = recordFetch({ link: { slug: "promo" } });

		// An omitted field would preserve the stored expiration while the destination
		// is cleared, which is exactly the combination the API refuses.
		expect(admin).toContain("expiresAt: toIsoDateTime(expiresAtInput.value) ?? null");

		// The composition the form produces after "Expira em" is emptied: the
		// constraint has already selected the default response.
		await submission.submitLinkForm(
			submissionInput({
				mode: "edit",
				editingSlug: "promo",
				expiresAt: null,
				expired: { mode: api.MODE_RESPONSE, url: "" },
			}),
			{ fetchImpl: recorder.fetchImpl },
		);

		const body = JSON.parse(String(recorder.calls[0].init.body)) as Record<string, unknown>;
		expect(body.expiresAt).toBeNull();
		expect(body.expiredRedirectUrl).toBeNull();
	});

	it("never renders expired destination data through an HTML sink", () => {
		const admin = readPublic("admin.js");
		const dangerousLines = admin
			.split("\n")
			.filter((line) => /innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(line));

		for (const line of dangerousLines) {
			expect(line).not.toMatch(/expiredRedirect|expired-redirect/i);
		}
		expect(admin).toMatch(/expiredRedirectUrlInput\.value = /);
		expect(admin).not.toMatch(/expiredRedirectUrlInput\.(outerHTML|innerHTML)/);
	});

	it("uses the single payload authority and no duplicate composer for the new field", () => {
		const admin = readPublic("admin.js");

		expect(admin).toContain("submitLinkForm(input)");
		expect(admin).not.toContain("buildExpiredRedirectFields");
	});

	it("keeps the helper module free of HTML sinks and dynamic code", () => {
		const ui = readPublic("expired-redirect-ui.js");

		expect(ui).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
		expect(ui).not.toMatch(/\beval\(|new Function\(/);
		expect(ui).not.toMatch(/document\./);
	});

	it("inherits the attribute and value routing from the shared form markup", () => {
		const html = readPublic("admin.html");
		const section = html.slice(
			html.indexOf('id="expired-redirect-section"'),
			html.indexOf('id="expired-redirect-unavailable"'),
		);

		// Both radios share one name so they stay a single mutually exclusive group.
		const names = Array.from(section.matchAll(/name="([^"]+)"/g)).map((match) => match[1]);
		expect(names).toEqual(["expired-redirect-mode", "expired-redirect-mode"]);
		// The destination field is a wrapping label, so the association is implicit.
		expect(section).toMatch(/<label id="expired-redirect-url-field" hidden>/);
	});
});

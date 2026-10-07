/*
 * Copyright (c) 2026 Vitor Faustino
 * AGPL-3.0 License — https://github.com/vitorgfaustino/boltlink
 *
 * Gate 3.4: Smart Routing admin UX coverage. The helpers are pure and DOM-free
 * so payload building, ordering, validation and error mapping can be verified
 * in Node. A source scan proves rule data never reaches innerHTML.
 */

// @vitest-environment node

import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import ts from "typescript";

type Rule = { country?: string; device?: string; url: string };
type Validation = { ok: boolean; code?: string };

type SmartRoutingApi = {
	MAX_RULES: number;
	ISO_COUNTRIES: string[];
	countryLabel: (code: unknown, locale?: string) => string;
	countryOptions: (locale?: string) => Array<{ value: string; label: string }>;
	deviceOptions: () => Array<{ value: string; label: string }>;
	validateRule: (rule: unknown) => Validation;
	validateRules: (rules: unknown) => Validation;
	toPayloadRule: (rule: Rule) => Record<string, unknown>;
	toPayloadRules: (rules: Rule[]) => Array<Record<string, unknown>>;
	moveRule: (rules: Rule[], index: number, direction: string) => Rule[];
	normalizeLoadedRules: (raw: unknown) => Rule[];
	isSmartRoutingEnabled: (raw: unknown) => boolean;
	isSmartRoutingCorrupt: (link: unknown) => boolean;
	smartInvalidNotice: (link: unknown) => string;
	isAbsoluteHttpUrl: (value: unknown) => boolean;
	extractErrorCode: (message: unknown) => string | null;
	smartErrorMessage: (message: unknown) => string;
	smartBadge: (link: Record<string, unknown>, smartRouting: boolean) => { conflict?: boolean; count?: number; label: string } | null;
	isRuleValidationCode: (code: unknown) => boolean;
	findFirstInvalidRuleIndex: (rules: unknown) => number;
	firstInvalidField: (rule: Rule) => "country" | "device" | "url";
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
	) => Promise<{ ok: boolean; code?: string; requestCount: number; payload?: Record<string, unknown>; method?: string; error?: string }>;
	resolveSubmissionFeedback: (result: Record<string, unknown>) => {
		smartError: string | null;
		formStatus: string | null;
		focusRules: boolean;
	};
};

type FetchRecorder = {
	calls: Array<{ url: string; init: RequestInit }>;
	fetchImpl: typeof fetch;
};

function recordFetch(responseBody: unknown, ok = true, status = 200): FetchRecorder {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
		calls.push({ url: String(url), init: init || {} });
		return {
			ok,
			status,
			json: async () => responseBody,
		} as Response;
	}) as typeof fetch;
	return { calls, fetchImpl };
}

function bodyOf(call: { init: RequestInit }): Record<string, unknown> {
	return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

function submissionInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		mode: "create",
		editingSlug: null,
		capabilities: { abTesting: true, smartRouting: true },
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
		...overrides,
	};
}

function loadApi(): SmartRoutingApi {
	const source = readFileSync(resolve(process.cwd(), "public/smart-routing-ui.js"), "utf8");
	const sandbox: { window: { BoltLinkSmartRouting?: SmartRoutingApi }; URL: typeof URL } = { window: {}, URL };
	vm.createContext(sandbox);
	vm.runInContext(source, sandbox);
	const api = sandbox.window.BoltLinkSmartRouting;
	if (!api) {
		throw new Error("BoltLinkSmartRouting not registered");
	}
	return api;
}

function readPublic(file: string) {
	return readFileSync(resolve(process.cwd(), `public/${file}`), "utf8");
}

const RULE = (country: string | undefined, device: string | undefined, url: string): Rule => ({
	...(country ? { country } : {}),
	...(device ? { device } : {}),
	url,
});

type PublishedTag = { migrations: string[]; scripts: string[]; version: string; files: string[] };

type GitOutcome = { status: number; stdout: string; stderr: string };

const PUBLISHED_TAG_REF = "refs/tags/v2.2.1";

/** Artifacts that only exist after the published tag: finding any one is a failure. */
const POST_PUBLISHED_ARTIFACTS = [
	"src/smart-routing.ts",
	"public/smart-routing-ui.js",
	"public/expired-redirect-ui.js",
	"migrations/0005_smart_routing.sql",
	"migrations/0004_ab_testing.sql",
	"migrations/0006_expired_redirect.sql",
];

/**
 * An ambient `GIT_DIR`/`GIT_WORK_TREE` would point the probe at a different
 * repository than the directory under test, so they are dropped; the locale is
 * pinned because the diagnostics below are compared as text.
 */
function gitEnvironment(): NodeJS.ProcessEnv {
	const env = { ...process.env, LC_ALL: "C", LANG: "C" };
	delete env.GIT_DIR;
	delete env.GIT_WORK_TREE;
	delete env.GIT_INDEX_FILE;
	delete env.GIT_COMMON_DIR;
	return env;
}

/**
 * Runs Git and hands back status/stdout/stderr instead of throwing, because the
 * caller has to tell a ref that does not exist apart from a Git that failed.
 * A process that never started (ENOENT, permissions, signal) is not a lookup
 * result at all, so it throws here.
 */
function probeGit(args: string[], directory: string): GitOutcome {
	const result = spawnSync("git", args, { cwd: directory, env: gitEnvironment(), encoding: "utf8" });
	if (result.error) {
		throw new Error(`git ${args.join(" ")} could not run in ${directory}: ${result.error.message}`);
	}
	if (result.status === null) {
		throw new Error(`git ${args.join(" ")} was terminated by ${result.signal ?? "an unknown signal"} in ${directory}`);
	}
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Diagnostic for a propagated Git failure: the operation, the status and the first stderr lines. */
function describeGitFailure(args: string[], directory: string, outcome: GitOutcome): string {
	const stderr = outcome.stderr.trim().split("\n").slice(0, 3).join(" | ");
	return `git ${args.join(" ")} failed in ${directory} (exit ${outcome.status}${stderr ? `: ${stderr}` : ""})`;
}

/**
 * Filesystem-level question asked before any Git diagnostic is interpreted: does
 * this tree have Git metadata at all?
 *
 * A `.git` directory, the `.git` file a worktree or submodule uses and a
 * symlinked `.git` all count as present. Only a measured absence (`ENOENT`,
 * `ENOTDIR`) means "source archive"; any other error leaves the answer unknown,
 * so metadata is assumed present and Git is left to decide. Ancestors are
 * searched because Git discovers repositories that way — a tree nested inside a
 * repository is not a source archive — and the walk stops at the filesystem root.
 */
function hasGitMetadata(directory: string): boolean {
	let current = resolve(directory);
	for (;;) {
		try {
			lstatSync(join(current, ".git"));
			return true;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") {
				return true;
			}
		}
		const parent = resolve(current, "..");
		if (parent === current) {
			return false;
		}
		current = parent;
	}
}

/** Content reads only happen after the ref resolved, so any failure here is broken evidence. */
function readTagContent(args: string[], directory: string): string {
	const outcome = probeGit(args, directory);
	if (outcome.status !== 0) {
		throw new Error(describeGitFailure(args, directory, outcome));
	}
	return outcome.stdout;
}

/**
 * Reads the real published tag through Git so documentation claims about it can
 * be checked against the artifact instead of against prose.
 *
 * `null` means "there is no v2.2.1 tag here to check" and is returned for
 * exactly two measured outcomes:
 *
 * - a repository proven usable whose tag is absent — `rev-parse --verify --quiet`
 *   exits 1 and writes nothing, which is the only result Git gives for a ref that
 *   does not exist;
 * - a tree with no Git metadata in its ancestry, where Git reports
 *   `fatal: not a git repository` and there is no repository to check.
 *
 * Metadata presence is decided from the filesystem *before* any Git diagnostic is
 * read, because `fatal: not a git repository` is produced by two unrelated
 * situations: a source archive with no `.git`, and metadata that exists but is
 * unusable — a corrupt `.git/HEAD` gives exactly that message. With metadata
 * present the repository is probed first (`rev-parse --git-dir`), so "the tag is
 * not here" is only ever concluded about a repository Git has shown it can read.
 *
 * Every other outcome propagates out of collection and fails the suite: a bad
 * config line, a corrupt HEAD, a `.git` marker pointing at metadata that is not
 * there, a Git that cannot be spawned, and one killed by a signal. Exit 128 is
 * deliberately not mapped to `null` on its own — a blanket rule would report a
 * broken repository as a skip.
 *
 * This is defense-in-depth on top of the Markdown scope scanner, which needs no
 * Git history and keeps rejecting published sections naming later artifacts.
 */
function readPublishedTag(directory: string = process.cwd()): PublishedTag | null {
	const metadataPresent = hasGitMetadata(directory);
	if (metadataPresent) {
		// Repository health before tag lookup: the missing-ref result below is only
		// meaningful about a repository Git can read at all.
		const healthArgs = ["rev-parse", "--git-dir"];
		const health = probeGit(healthArgs, directory);
		if (health.status !== 0) {
			throw new Error(`${directory} carries Git metadata that Git cannot use: ${describeGitFailure(healthArgs, directory, health)}`);
		}
	}
	const lookupArgs = ["rev-parse", "--verify", "--quiet", PUBLISHED_TAG_REF];
	const lookup = probeGit(lookupArgs, directory);
	if (lookup.status !== 0) {
		if (lookup.status === 1 && lookup.stderr.trim() === "") {
			return null;
		}
		// The same message without metadata means an archive Git found no repository
		// for; with metadata present it is the corrupt-repository case above.
		if (!metadataPresent && lookup.status === 128 && /not a git repository/.test(lookup.stderr)) {
			return null;
		}
		throw new Error(describeGitFailure(lookupArgs, directory, lookup));
	}
	const migrations = readTagContent(["ls-tree", "-r", "--name-only", PUBLISHED_TAG_REF, "--", "migrations"], directory)
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const pkg = JSON.parse(readTagContent(["show", `${PUBLISHED_TAG_REF}:package.json`], directory)) as {
		version: string;
		scripts: Record<string, string>;
	};
	const files = POST_PUBLISHED_ARTIFACTS.map((file) =>
		readTagContent(["ls-tree", "-r", "--name-only", PUBLISHED_TAG_REF, "--", file], directory).trim(),
	).filter(Boolean);
	return { migrations, scripts: Object.keys(pkg.scripts), version: pkg.version, files };
}

/**
 * The historical contract of the published tag. Shared with the bad-tag control
 * so the control proves the very assertions the evidence test runs, and not a
 * paraphrase of them.
 */
function assertPublishedTagContract(tag: PublishedTag): void {
	expect(tag.version).toBe("2.2.1");
	expect(tag.migrations).toContain("migrations/0003_lgpd_minimization.sql");
	expect(tag.migrations.filter((file) => /000[4-9]/.test(file))).toEqual([]);
	// Neither baseline artifact exists in the tag named by the docs.
	expect(tag.files).toEqual([]);
	expect(tag.scripts).not.toContain("dev-prepare");
}

/** `null` means "this checkout has no v2.2.1 tag" — never "the check passed". */
const publishedTag = readPublishedTag();

describe("Phase 3: Smart Routing admin helpers", () => {
	it("exposes the frozen limits and the Any sentinels", () => {
		const api = loadApi();
		expect(api.MAX_RULES).toBe(20);
		expect(api.countryOptions()[0]).toEqual({ value: "", label: "Qualquer país" });
		expect(api.deviceOptions()[0]).toEqual({ value: "", label: "Qualquer dispositivo" });
		expect(api.deviceOptions().map((option) => option.value)).toEqual(["", "ios", "android", "desktop", "other"]);
		expect(api.countryOptions().some((option) => option.value === "BR")).toBe(true);
		expect(api.ISO_COUNTRIES).toHaveLength(249);
	});

	it("never requires manual ISO typing while falling back to the code", () => {
		const api = loadApi();
		expect(api.countryLabel("BR")).not.toBe("");
		expect(api.countryLabel("not-a-code")).toBe("not-a-code");
		expect(api.countryLabel(null)).toBe("");
	});

	it("omits the Smart Routing field entirely when the capability is absent", () => {
		const api = loadApi();
		const built = api.buildLinkSubmissionPayload(
			submissionInput({
				capabilities: { abTesting: false, smartRouting: false },
				smart: { enabled: true, rules: [RULE("BR", undefined, "https://example.com/br")] },
			}),
		);
		expect(built.ok).toBe(true);
		expect(Object.keys(built.payload || {})).not.toContain("smartRoutingRules");
	});

	it("sends null when the capability is present but Smart Routing is off", () => {
		const api = loadApi();
		const built = api.buildLinkSubmissionPayload(submissionInput());
		expect(built.payload?.smartRoutingRules).toBeNull();
	});

	it("builds canonical payload rules and drops UI-only values", () => {
		const api = loadApi();
		const withUiFields = { id: "row-1", name: "x", priority: 3, country: "BR", device: "android", url: "https://example.com/br" } as unknown as Rule;
		expect(api.toPayloadRule(withUiFields)).toEqual({ country: "BR", device: "android", url: "https://example.com/br" });

		const built = api.buildLinkSubmissionPayload(
			submissionInput({
				smart: {
					enabled: true,
					rules: [RULE("BR", "android", "https://example.com/br"), RULE(undefined, "ios", "https://example.com/ios")],
				},
			}),
		);
		expect(built.payload?.smartRoutingRules).toEqual([
			{ country: "BR", device: "android", url: "https://example.com/br" },
			{ device: "ios", url: "https://example.com/ios" },
		]);
		expect("country" in (api.toPayloadRule(RULE(undefined, undefined, "https://example.com/any")))).toBe(false);
	});

	it("exposes no second payload composer for smartRoutingRules", () => {
		const api = loadApi() as unknown as Record<string, unknown>;
		expect("buildSmartRoutingFields" in api).toBe(false);
	});

	/**
	 * `smartRoutingRules: null` means "disabled" but also "unreadable". The
	 * status is what keeps a corrupt row from being silently turned into an
	 * ordinary off row by the next unrelated save.
	 */
	it("treats only the explicit invalid status as a preserved corrupt value", () => {
		const api = loadApi();
		expect(api.isSmartRoutingCorrupt({ smartRoutingStatus: "invalid" })).toBe(true);
		expect(api.isSmartRoutingCorrupt({ smartRoutingStatus: "disabled" })).toBe(false);
		expect(api.isSmartRoutingCorrupt({ smartRoutingStatus: "valid" })).toBe(false);
		expect(api.isSmartRoutingCorrupt({ smartRoutingRules: null })).toBe(false);
		expect(api.isSmartRoutingCorrupt(null)).toBe(false);
	});

	it("returns a fixed notice for the corrupt state and nothing otherwise", () => {
		const api = loadApi();
		const notice = api.smartInvalidNotice({ smartRoutingStatus: "invalid", smartRoutingRules: "INVALID RAW VALUE" });
		expect(notice).toBeTruthy();
		expect(notice).not.toContain("INVALID RAW VALUE");
		expect(api.smartInvalidNotice({ smartRoutingStatus: "disabled" })).toBe("");
		expect(api.smartInvalidNotice(null)).toBe("");
	});

	it("preserves a corrupt value on an unrelated edit and only clears it on request", () => {
		const api = loadApi();
		const corrupt = { enabled: false, rules: [], preserveInvalid: true, clearInvalid: false };

		const preserved = api.buildLinkSubmissionPayload(submissionInput({ mode: "edit", editingSlug: "edit", tags: ["x"], smart: corrupt }));
		expect(preserved.ok).toBe(true);
		expect(Object.keys(preserved.payload || {})).not.toContain("smartRoutingRules");

		const cleared = api.buildLinkSubmissionPayload(
			submissionInput({ mode: "edit", editingSlug: "edit", smart: { ...corrupt, clearInvalid: true } }),
		);
		expect(cleared.ok).toBe(true);
		expect(cleared.payload?.smartRoutingRules).toBeNull();
		expect(Object.keys(cleared.payload || {})).toContain("smartRoutingRules");
	});

	/**
	 * End-to-end chain of the Admin decision: the API classification is what
	 * decides whether the routing field is sent. A hybrid corrupt row must not
	 * lose its stored value when the operator edits something else.
	 */
	it("keeps an API-reported corrupt row untouched when only unrelated fields change", () => {
		const api = loadApi();
		const loadedFromApi = { smartRoutingRules: null, smartRoutingStatus: "invalid", ab_enabled: 1 };
		expect(api.isSmartRoutingCorrupt(loadedFromApi)).toBe(true);
		expect(api.smartInvalidNotice(loadedFromApi)).toBeTruthy();

		const built = api.buildLinkSubmissionPayload(
			submissionInput({
				mode: "edit",
				editingSlug: "corrupt-hybrid",
				tags: ["editada"],
				ab: { enabled: true, targetUrl: "https://example.com/variant-b", weightB: 50 },
				smart: { enabled: false, rules: [], preserveInvalid: api.isSmartRoutingCorrupt(loadedFromApi), clearInvalid: false },
			}),
		);
		expect(built.ok).toBe(true);
		expect(built.method).toBe("PATCH");
		expect(Object.keys(built.payload || {})).not.toContain("smartRoutingRules");
	});

	it("repairs a corrupt value with valid rules and never produces a new hybrid", () => {
		const api = loadApi();
		const built = api.buildLinkSubmissionPayload(
			submissionInput({
				mode: "edit",
				editingSlug: "edit",
				smart: { enabled: true, rules: [RULE("BR", undefined, "https://example.com/br")], preserveInvalid: true, clearInvalid: false },
			}),
		);
		expect(built.ok).toBe(true);
		expect(built.payload?.smartRoutingRules).toEqual([{ country: "BR", url: "https://example.com/br" }]);

		// A repair with A/B still on cannot leave a hybrid: the shared builder
		// fails closed, so the only path is the explicit mode transition that
		// turns A/B off in the same atomic PATCH.
		const hybrid = api.buildLinkSubmissionPayload(
			submissionInput({
				mode: "edit",
				editingSlug: "edit",
				ab: { enabled: true, targetUrl: "https://example.com/b", weightB: 50 },
				smart: { enabled: true, rules: [RULE("BR", undefined, "https://example.com/br")] },
			}),
		);
		expect(hybrid.ok).toBe(false);
		expect(hybrid.code).toBe("MODE_CONFLICT");
	});

	it("rejects non-absolute and non-http(s) rule URLs locally", () => {
		const api = loadApi();
		for (const url of ["javascript:alert(1)", "data:text/html,hi", "ftp://example.com/x", "not-a-url", "/relative", "foo/bar", "", "   "]) {
			expect(api.validateRule({ country: "BR", url })).toEqual({ ok: false, code: "INVALID_URL" });
			expect(api.isAbsoluteHttpUrl(url)).toBe(false);
		}
		expect(api.isAbsoluteHttpUrl("https://example.com/x")).toBe(true);
		expect(api.isAbsoluteHttpUrl("http://example.com/x")).toBe(true);
	});

	it("preserves the exact order received from the API", () => {
		const api = loadApi();
		const loaded = api.normalizeLoadedRules([
			{ country: "BR", url: "https://example.com/1" },
			{ device: "ios", url: "https://example.com/2" },
			{ country: "US", device: "desktop", url: "https://example.com/3" },
		]);
		expect(loaded).toEqual([
			{ country: "BR", device: "", url: "https://example.com/1" },
			{ country: "", device: "ios", url: "https://example.com/2" },
			{ country: "US", device: "desktop", url: "https://example.com/3" },
		]);
		expect(api.normalizeLoadedRules(null)).toEqual([]);
		expect(api.normalizeLoadedRules("nope")).toEqual([]);
	});
});

describe("Phase 3: Smart Routing admin ordering", () => {
	it("moves rules up and down while preserving the rest of the order", () => {
		const api = loadApi();
		const rules = [RULE("BR", undefined, "a"), RULE("US", undefined, "b"), RULE("DE", undefined, "c")];
		expect(api.moveRule(rules, 2, "up").map((rule) => rule.url)).toEqual(["a", "c", "b"]);
		expect(api.moveRule(rules, 0, "down").map((rule) => rule.url)).toEqual(["b", "a", "c"]);
	});

	it("treats out-of-range moves as no-ops and does not mutate the input", () => {
		const api = loadApi();
		const rules = [RULE("BR", undefined, "a"), RULE("US", undefined, "b")];
		expect(api.moveRule(rules, 0, "up").map((rule) => rule.url)).toEqual(["a", "b"]);
		expect(api.moveRule(rules, 1, "down").map((rule) => rule.url)).toEqual(["a", "b"]);
		expect(api.moveRule(rules, -1, "up").map((rule) => rule.url)).toEqual(["a", "b"]);
		expect(rules.map((rule) => rule.url)).toEqual(["a", "b"]);
	});
});

describe("Phase 3: Smart Routing admin validation", () => {
	it("rejects an empty rule set", () => {
		const api = loadApi();
		expect(api.validateRules([])).toEqual({ ok: false, code: "EMPTY_RULES" });
	});

	it("accepts twenty rules and rejects twenty-one", () => {
		const api = loadApi();
		const codes = "BR US GB DE FR JP CA AU IT ES NL SE NO FI DK PT PL IE AT BE".split(" ");
		const rules = codes.map((country) => RULE(country, undefined, `https://example.com/${country}`));
		expect(api.validateRules(rules)).toEqual({ ok: true });
		expect(api.validateRules(rules.concat([RULE("AR", undefined, "https://example.com/ar")]))).toEqual({ ok: false, code: "TOO_MANY_RULES" });
	});

	it("rejects Any/Any rules and empty destinations", () => {
		const api = loadApi();
		expect(api.validateRule(RULE(undefined, undefined, "https://example.com/x"))).toEqual({ ok: false, code: "MISSING_MATCHER" });
		expect(api.validateRule(RULE("BR", undefined, ""))).toEqual({ ok: false, code: "INVALID_URL" });
		expect(api.validateRule(RULE("BR", undefined, "   "))).toEqual({ ok: false, code: "INVALID_URL" });
		expect(api.validateRule(RULE("BR", undefined, "https://example.com/x"))).toEqual({ ok: true });
	});

	it("detects duplicate matchers", () => {
		const api = loadApi();
		expect(api.validateRules([
			RULE("BR", undefined, "https://example.com/1"),
			RULE("BR", undefined, "https://example.com/2"),
		])).toEqual({ ok: false, code: "DUPLICATE_MATCHER" });
	});
});

describe("Phase 3: Smart Routing admin error UX", () => {
	it("maps backend codes to friendly messages without reflecting raw payloads", () => {
		const api = loadApi();
		for (const [code, expected] of [
			["DUPLICATE_MATCHER", "Já existe uma regra com o mesmo país e dispositivo."],
			["SHADOWED_RULE", "Uma regra anterior já cobre completamente esta regra."],
			["INVALID_URL", "Informe uma URL de destino HTTP ou HTTPS válida."],
			["RULES_TOO_LARGE", "O conjunto de regras excede o tamanho máximo permitido."],
		] as Array<[string, string]>) {
			const message = api.smartErrorMessage(`Invalid smartRoutingRules (${code})`);
			expect(message).toBe(expected);
			expect(message).not.toContain(code);
		}
	});

	it("never reflects the raw backend message and falls back safely", () => {
		const api = loadApi();
		const raw = "Invalid smartRoutingRules (<img src=x onerror=alert(1)>)";
		const message = api.smartErrorMessage(raw);
		expect(message).not.toContain("<img");
		expect(message).not.toContain("onerror");
		expect(api.extractErrorCode(raw)).toBeNull();
	});
});

describe("Phase 3: Smart Routing admin card badge", () => {
	it("is absent without capability or without rules", () => {
		const api = loadApi();
		expect(api.smartBadge({ smartRoutingRules: [{ country: "BR", url: "x" }] }, false)).toBeNull();
		expect(api.smartBadge({ smartRoutingRules: null }, true)).toBeNull();
		expect(api.smartBadge({ smartRoutingRules: [] }, true)).toBeNull();
	});

	it("summarizes the configured rules and flags ambiguous persisted state", () => {
		const api = loadApi();
		const single = api.smartBadge({ ab_enabled: 0, smartRoutingRules: [{ country: "BR", url: "x" }] }, true);
		expect(single).toMatchObject({ conflict: false, count: 1, label: "1 regra" });

		const many = api.smartBadge({ ab_enabled: 0, smartRoutingRules: [{ country: "BR", url: "x" }, { device: "ios", url: "y" }] }, true);
		expect(many).toMatchObject({ conflict: false, count: 2, label: "2 regras" });

		const conflict = api.smartBadge({ ab_enabled: 1, smartRoutingRules: [{ country: "BR", url: "x" }] }, true);
		expect(conflict).toMatchObject({ conflict: true, label: "configuração ambígua" });
	});
});

describe("Phase 3: Smart Routing admin mode transitions", () => {
	it("keeps A/B and Smart Routing mutually exclusive in one transition", () => {
		const api = loadApi();
		const enablingSmart = api.resolveModeTransition({ abEnabled: true, smartEnabled: true }, "smart");
		expect(enablingSmart).toMatchObject({ abEnabled: false, smartEnabled: true });
		expect(enablingSmart.notice).not.toBe("");

		const enablingAb = api.resolveModeTransition({ abEnabled: true, smartEnabled: true }, "ab");
		expect(enablingAb).toMatchObject({ abEnabled: true, smartEnabled: false });
		expect(enablingAb.notice).not.toBe("");
	});

	it("does not disturb a single active mode", () => {
		const api = loadApi();
		expect(api.resolveModeTransition({ abEnabled: true, smartEnabled: false }, "ab")).toMatchObject({ abEnabled: true, smartEnabled: false, notice: "" });
		expect(api.resolveModeTransition({ abEnabled: false, smartEnabled: true }, "smart")).toMatchObject({ abEnabled: false, smartEnabled: true, notice: "" });
	});
});

describe("Phase 3: Smart Routing admin redirect constraint", () => {
	it("requires 302 while either dynamic mode is active", () => {
		const api = loadApi();
		expect(api.requiresTemporaryRedirect({ abEnabled: false, smartEnabled: false })).toBe(false);
		expect(api.requiresTemporaryRedirect({ abEnabled: true, smartEnabled: false })).toBe(true);
		expect(api.requiresTemporaryRedirect({ abEnabled: false, smartEnabled: true })).toBe(true);
	});

	it("forces 302 for Smart Routing and lets 301 return after disabling", () => {
		const api = loadApi();
		expect(api.resolveRedirectType("301", true)).toBe("302");
		expect(api.resolveRedirectType("302", true)).toBe("302");
		expect(api.resolveRedirectType("301", false)).toBe("301");
		expect(api.resolveRedirectType("302", false)).toBe("302");
	});
});

describe("Phase 3: Smart Routing admin integrated submit", () => {
	it("sends no Smart field when the capability is false", async () => {
		const api = loadApi();
		const recorder = recordFetch({ link: { slug: "nova" } });
		const result = await api.submitLinkForm(
			submissionInput({
				capabilities: { abTesting: false, smartRouting: false },
				smart: { enabled: true, rules: [{ country: "BR", url: "https://example.com/br" }] },
			}),
			{ fetchImpl: recorder.fetchImpl },
		);

		expect(result.ok).toBe(true);
		expect(recorder.calls).toHaveLength(1);
		expect(recorder.calls[0].url).toBe("/api/links");
		expect(recorder.calls[0].init.method).toBe("POST");
		expect("smartRoutingRules" in bodyOf(recorder.calls[0])).toBe(false);
	});

	it("sends null when the capability is present and Smart is off", async () => {
		const api = loadApi();
		const recorder = recordFetch({ link: { slug: "nova" } });
		await api.submitLinkForm(submissionInput(), { fetchImpl: recorder.fetchImpl });

		expect(recorder.calls).toHaveLength(1);
		expect(bodyOf(recorder.calls[0]).smartRoutingRules).toBeNull();
	});

	it("sends the current ordered rules when Smart is on", async () => {
		const api = loadApi();
		const recorder = recordFetch({ link: { slug: "nova" } });
		await api.submitLinkForm(
			submissionInput({
				smart: {
					enabled: true,
					rules: [
						{ country: "BR", device: "android", url: "https://example.com/br" },
						{ device: "ios", url: "https://example.com/ios" },
					],
				},
			}),
			{ fetchImpl: recorder.fetchImpl },
		);

		expect(bodyOf(recorder.calls[0]).smartRoutingRules).toEqual([
			{ country: "BR", device: "android", url: "https://example.com/br" },
			{ device: "ios", url: "https://example.com/ios" },
		]);
	});

	it("normalizes redirectType to 302 when Smart is on and 301 was selected", async () => {
		const api = loadApi();
		const recorder = recordFetch({ link: { slug: "nova" } });
		await api.submitLinkForm(
			submissionInput({
				redirectType: "301",
				smart: { enabled: true, rules: [{ country: "BR", url: "https://example.com/br" }] },
			}),
			{ fetchImpl: recorder.fetchImpl },
		);

		expect(bodyOf(recorder.calls[0]).redirectType).toBe("302");
		expect(Array.isArray(bodyOf(recorder.calls[0]).smartRoutingRules)).toBe(true);
	});

	it("uses PATCH for edit and preserves loaded rules on unrelated edits", async () => {
		const api = loadApi();
		const loaded = [
			{ country: "BR", url: "https://example.com/a" },
			{ country: "US", url: "https://example.com/b" },
			{ country: "DE", url: "https://example.com/c" },
		];

		for (const targetUrl of ["https://example.com/fallback", "https://example.com/changed"]) {
			const recorder = recordFetch({ link: { slug: "edit" } });
			await api.submitLinkForm(
				submissionInput({
					mode: "edit",
					editingSlug: "edit",
					targetUrl,
					smart: { enabled: true, rules: loaded },
				}),
				{ fetchImpl: recorder.fetchImpl },
			);
			expect(recorder.calls).toHaveLength(1);
			expect(recorder.calls[0].init.method).toBe("PATCH");
			expect(recorder.calls[0].url).toBe("/api/links/edit");
			expect(bodyOf(recorder.calls[0]).smartRoutingRules).toEqual(loaded);
		}
	});

	it("preserves the loaded rules on a tags-only edit with exactly one PATCH", async () => {
		const api = loadApi();
		const loaded = [
			{ country: "BR", url: "https://example.com/a" },
			{ country: "US", url: "https://example.com/b" },
			{ country: "DE", url: "https://example.com/c" },
		];
		const recorder = recordFetch({ link: { slug: "tags-only" } });

		await api.submitLinkForm(
			submissionInput({
				mode: "edit",
				editingSlug: "tags-only",
				targetUrl: "https://example.com/fallback",
				redirectType: "302",
				tags: ["nova-tag"],
				smart: { enabled: true, rules: loaded },
			}),
			{ fetchImpl: recorder.fetchImpl },
		);

		expect(recorder.calls).toHaveLength(1);
		expect(recorder.calls[0].init.method).toBe("PATCH");
		const body = bodyOf(recorder.calls[0]);
		expect(body.tags).toEqual(["nova-tag"]);
		expect(body.smartRoutingRules).toEqual(loaded);
	});

	it("sends the reordered rules after a move", async () => {
		const api = loadApi();
		const loaded: Rule[] = [
			{ country: "BR", url: "https://example.com/a" },
			{ country: "US", url: "https://example.com/b" },
			{ country: "DE", url: "https://example.com/c" },
		];
		const reordered = api.moveRule(loaded, 2, "up");
		const recorder = recordFetch({ link: { slug: "edit" } });

		await api.submitLinkForm(
			submissionInput({ mode: "edit", editingSlug: "edit", smart: { enabled: true, rules: reordered } }),
			{ fetchImpl: recorder.fetchImpl },
		);

		expect(bodyOf(recorder.calls[0]).smartRoutingRules).toEqual([
			{ country: "BR", url: "https://example.com/a" },
			{ country: "DE", url: "https://example.com/c" },
			{ country: "US", url: "https://example.com/b" },
		]);
	});

	it("performs one atomic request for A/B -> Smart", async () => {
		const api = loadApi();
		const recorder = recordFetch({ link: { slug: "edit" } });
		const result = await api.submitLinkForm(
			submissionInput({
				mode: "edit",
				editingSlug: "edit",
				ab: { enabled: false, targetUrl: "https://example.com/b", weightB: 50 },
				smart: { enabled: true, rules: [{ country: "BR", url: "https://example.com/br" }] },
			}),
			{ fetchImpl: recorder.fetchImpl },
		);

		expect(result.ok).toBe(true);
		expect(recorder.calls).toHaveLength(1);
		const body = bodyOf(recorder.calls[0]);
		expect(body.abEnabled).toBe(false);
		expect(Array.isArray(body.smartRoutingRules)).toBe(true);
		expect(body.redirectType).toBe("302");
	});

	it("performs one atomic request for Smart -> A/B", async () => {
		const api = loadApi();
		const recorder = recordFetch({ link: { slug: "edit" } });
		const result = await api.submitLinkForm(
			submissionInput({
				mode: "edit",
				editingSlug: "edit",
				ab: { enabled: true, targetUrl: "https://example.com/b", weightB: 50 },
				smart: { enabled: false, rules: [] },
			}),
			{ fetchImpl: recorder.fetchImpl },
		);

		expect(result.ok).toBe(true);
		expect(recorder.calls).toHaveLength(1);
		const body = bodyOf(recorder.calls[0]);
		expect(body.smartRoutingRules).toBeNull();
		expect(body.abEnabled).toBe(true);
		expect(body.redirectType).toBe("302");
	});

	it("fails closed with zero requests on a hybrid A/B + Smart state", async () => {
		const api = loadApi();
		const recorder = recordFetch({ link: { slug: "edit" } });
		const result = await api.submitLinkForm(
			submissionInput({
				mode: "edit",
				editingSlug: "edit",
				ab: { enabled: true, targetUrl: "https://example.com/b", weightB: 50 },
				smart: { enabled: true, rules: [{ country: "BR", url: "https://example.com/br" }] },
			}),
			{ fetchImpl: recorder.fetchImpl },
		);

		expect(result).toMatchObject({ ok: false, code: "MODE_CONFLICT", requestCount: 0 });
		expect(recorder.calls).toHaveLength(0);
	});

	it("fails closed with zero requests on invalid/rules-empty Smart states", async () => {
		const api = loadApi();
		const cases: Array<[Rule[], string]> = [
			[[], "EMPTY_RULES"],
			[[{ url: "https://example.com/any" } as Rule], "MISSING_MATCHER"],
			[[{ country: "BR", url: "   " }], "INVALID_URL"],
			[[{ country: "BR", url: "javascript:alert(1)" }], "INVALID_URL"],
			[[{ country: "BR", url: "not-a-url" }], "INVALID_URL"],
			[[{ country: "BR", url: "ftp://example.com/x" }], "INVALID_URL"],
			[[{ country: "BR", url: "/relative" }], "INVALID_URL"],
			[[{ country: "BR", url: "https://example.com/a" }, { country: "BR", url: "https://example.com/b" }], "DUPLICATE_MATCHER"],
		];

		for (const [rules, code] of cases) {
			const recorder = recordFetch({ link: { slug: "nova" } });
			const result = await api.submitLinkForm(
				submissionInput({ smart: { enabled: true, rules } }),
				{ fetchImpl: recorder.fetchImpl },
			);
			expect(result).toMatchObject({ ok: false, code, requestCount: 0 });
			expect(recorder.calls).toHaveLength(0);
		}
	});

	it("surfaces backend errors without a second request", async () => {
		const api = loadApi();
		const recorder = recordFetch({ error: "Invalid smartRoutingRules (SHADOWED_RULE)" }, false, 400);
		const result = await api.submitLinkForm(
			submissionInput({ smart: { enabled: true, rules: [{ country: "BR", url: "https://example.com/br" }] } }),
			{ fetchImpl: recorder.fetchImpl },
		);

		expect(result).toMatchObject({ ok: false, code: "HTTP_ERROR", status: 400, requestCount: 1 });
		expect(recorder.calls).toHaveLength(1);
	});

	it("exposes the first invalid rule for focus handling", () => {
		const api = loadApi();
		expect(api.findFirstInvalidRuleIndex([
			{ country: "BR", url: "https://example.com/ok" },
			{ country: "", device: "", url: "https://example.com/bad" },
		])).toBe(1);
		expect(api.findFirstInvalidRuleIndex([{ country: "BR", url: "https://example.com/ok" }])).toBe(-1);
		expect(api.firstInvalidField({ country: "", device: "", url: "https://example.com/x" })).toBe("country");
		expect(api.firstInvalidField({ country: "BR", device: "", url: "" })).toBe("url");
	});
});

describe("Phase 3: Smart Routing admin accessibility", () => {
	it("marks the Smart error as an assertive alert and the conflict as a polite status", () => {
		const html = readPublic("admin.html");
		const errorTag = html.match(/<p[^>]*id="smart-routing-error"[^>]*>/)?.[0] || "";
		expect(errorTag).toContain('role="alert"');
		expect(errorTag).toContain('aria-live="assertive"');
		expect(errorTag).toContain('aria-atomic="true"');

		const conflictTag = html.match(/<p[^>]*id="smart-routing-conflict"[^>]*>/)?.[0] || "";
		expect(conflictTag).toContain('role="status"');
		expect(conflictTag).toContain('aria-live="polite"');
		expect(conflictTag).toContain('aria-atomic="true"');

		const formStatusTag = html.match(/<div[^>]*id="form-status"[^>]*>/)?.[0] || "";
		expect(formStatusTag).toContain('role="status"');
		expect(formStatusTag).toContain('aria-live="polite"');
	});

	it("wires describedby, aria-invalid and first-invalid focus in the real admin code", () => {
		const admin = readPublic("admin.js");
		expect(admin).toContain('aria-describedby", "smart-routing-error"');
		expect(admin).toContain('setAttribute("aria-invalid", "true")');
		expect(admin).toContain("focusFirstInvalidSmartRule");
		expect(admin).toContain("submitLinkForm(input)");
	});

	it("announces the preserved corrupt state through a live region built from static copy", () => {
		const html = readPublic("admin.html");
		const noticeTag = html.match(/<p[^>]*id="smart-routing-invalid"[^>]*>/)?.[0] || "";
		expect(noticeTag).toContain('role="status"');
		expect(noticeTag).toContain('aria-live="polite"');
		expect(noticeTag).toContain('aria-atomic="true"');
		expect(html).toContain('id="clear-smart-invalid-button"');

		const admin = readPublic("admin.js");
		// textContent only: the notice can never echo the raw persisted value.
		expect(admin).toContain("smartRoutingInvalid.textContent = notice");
		expect(admin).toContain("smartRoutingUi.smartInvalidNotice(link)");
	});

	it("clears a corrupt value only from the explicit action, through the shared submit", () => {
		const admin = readPublic("admin.js");
		const listener = admin.slice(admin.indexOf("clearSmartInvalidButton.addEventListener"));
		expect(listener).toContain("state.smartClearInvalid = true");
		expect(listener).toContain("linkForm.requestSubmit()");
		// The flag is passed to the single payload authority, so no second
		// request path can discard the persisted value.
		expect(admin).toContain("preserveInvalid: state.smartRoutingCorrupt");
		expect(admin).toContain("clearInvalid: state.smartClearInvalid");
		expect(admin).toContain("setSmartRoutingInvalidState(state.smartRouting ? link : null)");
	});
});

describe("Phase 3: Smart Routing documentation regression guard", () => {
	it("parses every heading level and reports ancestry", () => {
		const doc = [
			"# Doc",
			"## Published setup",
			"### Fluxo A",
			"#### Notes",
			"##### Deep",
			"###### Deeper",
			"tail",
			"## Unreleased / Fase 3",
			"### Fluxo B",
		].join("\n");

		const sections = parseMarkdownSections(doc);
		expect(sections.map((section) => section.level)).toEqual([1, 2, 3, 4, 5, 6, 2, 3]);

		const deeper = sections.find((section) => section.title === "Deeper")!;
		expect(deeper.ancestors.map((entry) => entry.title)).toEqual(["Doc", "Published setup", "Fluxo A", "Notes", "Deep"]);

		const publishedSetup = sections.find((section) => section.title === "Published setup")!;
		expect(publishedSetup.body).not.toContain("Fluxo A");

		const fluxoA = sections.find((section) => section.title === "Fluxo A")!;
		expect(fluxoA.ancestors.map((entry) => entry.title)).toEqual(["Doc", "Published setup"]);
		expect(fluxoA.level).toBe(3);
	});

	it("ignores Markdown headings fenced inside code blocks (BL-SR-007-P2-01)", () => {
		const doc = [
			"# Documentation",
			"",
			"## Published setup",
			"",
			"```md",
			"### Unreleased / Fase 3",
			"smartRouting: true",
			"```",
		].join("\n");

		const sections = parseMarkdownSections(doc);
		expect(sections.map((section) => section.heading)).toEqual(["# Documentation", "## Published setup"]);

		const published = sections.find((section) => section.title === "Published setup")!;
		expect(classifySectionScope(published)).toBe("published");
		expect(published.body).toContain("### Unreleased / Fase 3");
		expect(findForbiddenTokens(published.text)).toContain("Smart Routing");
	});

	it("stays fenced-code-aware for tilde fences and resumes after closing", () => {
		const doc = [
			"## Published setup",
			"~~~bash",
			"smart_routing_rules",
			"### Fenced marker",
			"~~~",
			"### Real child",
			"smartRoutingRules",
		].join("\n");

		const sections = parseMarkdownSections(doc);
		expect(sections.map((section) => section.title)).toEqual(["Published setup", "Real child"]);
		expect(classifySectionScope(sections[0])).toBe("published");
		expect(findForbiddenTokens(sections[0].text)).toContain("smart_routing_rules");
		expect(findForbiddenTokens(sections[1].text)).toContain("smartRoutingRules");
	});

	it("rejects a backtick opener whose info string contains a backtick (BL-SR-007-P2-01)", () => {
		const doc = [
			"# Documentation",
			"",
			"```md`not-a-valid-info-string",
			"## Published setup",
			"smartRouting: true",
		].join("\n");

		const sections = parseMarkdownSections(doc);
		expect(sections.map((section) => section.heading)).toEqual(["# Documentation", "## Published setup"]);

		const published = sections.find((section) => section.title === "Published setup")!;
		expect(classifySectionScope(published)).toBe("published");
		expect(findForbiddenTokens(published.text)).toContain("Smart Routing");
	});

	it("still accepts a tilde opener whose info string contains a backtick", () => {
		const doc = [
			"## Published setup",
			"~~~sh`label",
			"### Fenced marker",
			"smartRouting: true",
			"~~~",
		].join("\n");

		const sections = parseMarkdownSections(doc);
		expect(sections.map((section) => section.title)).toEqual(["Published setup"]);
		expect(sections[0].body).toContain("### Fenced marker");
		expect(findForbiddenTokens(sections[0].text)).toContain("Smart Routing");
	});

	it("inherits published scope into children and lets the nearest marker win", () => {
		const doc = [
			"# Doc",
			"## Published setup",
			"### Fluxo A",
			"Use migration 0005",
			"### Unreleased / Fase 3",
			"Use migration 0005",
		].join("\n");

		const sections = parseMarkdownSections(doc);
		const fluxoA = sections.find((section) => section.title === "Fluxo A")!;
		const fluxoB = sections.find((section) => section.title === "Unreleased / Fase 3")!;

		expect(classifySectionScope(fluxoA)).toBe("published");
		expect(classifySectionScope(fluxoB)).toBe("unreleased");
		expect(findForbiddenTokens(fluxoA.text)).toContain("0005");
		expect(findForbiddenTokens(fluxoB.text)).toEqual(expect.arrayContaining(["0005"]));
	});

	it("detects camelCase, snake_case and explicit feature artifacts", () => {
		const camel = parseMarkdownSections(["## Published setup", "smartRouting: true"].join("\n"))[0];
		expect(findForbiddenTokens(camel.text)).toContain("Smart Routing");

		const snake = parseMarkdownSections(["## Published setup", "smart_routing_rules"].join("\n"))[0];
		expect(findForbiddenTokens(snake.text)).toContain("smart_routing_rules");

		const rules = parseMarkdownSections(["## Published setup", "smartRoutingRules"].join("\n"))[0];
		expect(findForbiddenTokens(rules.text)).toContain("smartRoutingRules");

		const artifact = parseMarkdownSections(["## Published setup", "public/smart-routing-ui.js"].join("\n"))[0];
		expect(findForbiddenTokens(artifact.text)).toContain("public/smart-routing-ui.js");
	});

	it("allows every unreleased token inside an unprotected scope", () => {
		const section = parseMarkdownSections([
			"# Doc",
			"## Unreleased / Fase 3",
			"0005 smartRouting smartRoutingRules smart_routing_rules Smart Routing public/smart-routing-ui.js",
		].join("\n")).find((entry) => entry.title === "Unreleased / Fase 3")!;

		expect(classifySectionScope(section)).toBe("unreleased");
	});

	it("scans the whole documentation tree and finds no scope violation", () => {
		const files = collectDocumentationFiles(process.cwd());
		expect(files.some((file) => file.endsWith("docs/architecture.md"))).toBe(true);
		expect(files.some((file) => file.endsWith("README.md"))).toBe(true);
		expect(files.some((file) => file.endsWith("docs/cloudflare-setup.md"))).toBe(true);

		const violations = files.flatMap((file) => scanPublishedDocumentation(file));
		expect(violations, violations.join("\n")).toEqual([]);
	});

	/**
	 * Negative controls for the three release boundaries. Each fragment is a
	 * section that would be wrong for its declared scope.
	 */
	it("rejects a Phase 2 artifact inside a published section", () => {
		const doc = ["# Doc", "## Upgrade para a versão publicada (v2.2.1)", "Aplique a migration `0004` (`0004_ab_testing.sql`) e use Split Test A/B."].join("\n");
		const section = parseMarkdownSections(doc).find((entry) => entry.title.startsWith("Upgrade"))!;

		expect(classifySectionScope(section)).toBe("published");
		expect(findScopeViolations(section)).toEqual(expect.arrayContaining(["0004", "0004_ab_testing", "Split Test A/B"]));
	});

	it("rejects an A/B column or the dev-prepare helper inside a published section", () => {
		const columns = parseMarkdownSections(["## Fluxo A: Wrangler local (release publicada v2.2.1)", "`ab_enabled` e `ab_target_url`"].join("\n"))[0];
		expect(findScopeViolations(columns)).toEqual(expect.arrayContaining(["ab_enabled", "ab_target_url"]));

		const prepare = parseMarkdownSections(["## Fluxo A: Wrangler local (release publicada v2.2.1)", "npm run dev-prepare"].join("\n"))[0];
		expect(findScopeViolations(prepare)).toContain("dev-prepare");
	});

	it("allows Phase 2 artifacts and rejects Phase 3 artifacts in a Phase 2 section", () => {
		const allowed = parseMarkdownSections([
			"# Doc",
			"## Split Test A/B e migration 0004 (Phase 2 local, não publicado)",
			"0004_ab_testing.sql ab_enabled ab_target_url Split Test A/B npm run dev-prepare",
		].join("\n")).find((entry) => entry.title.startsWith("Split Test"))!;
		expect(classifySectionScope(allowed)).toBe("phase2");
		expect(findScopeViolations(allowed)).toEqual([]);

		const rejected = parseMarkdownSections([
			"# Doc",
			"## Split Test A/B e migration 0004 (Phase 2 local, não publicado)",
			"Aplique também a `0005_smart_routing.sql` para usar Smart Routing.",
		].join("\n")).find((entry) => entry.title.startsWith("Split Test"))!;
		expect(classifySectionScope(rejected)).toBe("phase2");
		expect(findScopeViolations(rejected)).toEqual(expect.arrayContaining(["0005_smart_routing", "Smart Routing"]));
	});

	it("allows both baselines inside a Phase 3 section", () => {
		const section = parseMarkdownSections([
			"# Doc",
			"## Unreleased / Fase 3 (próxima release)",
			"0004 0005 Split Test A/B Smart Routing smart_routing_rules ab_enabled dev-prepare",
		].join("\n")).find((entry) => entry.title.startsWith("Unreleased"))!;
		expect(classifySectionScope(section)).toBe("unreleased");
		expect(findScopeViolations(section)).toEqual([]);
	});

	/**
	 * The attribution guard exists because the scope classifier alone was a total
	 * bypass: a `current` section is allowed to name 0004-0006, so it could also
	 * state that those artifacts belong to the published v2.2.1 tag and pass every
	 * scope check. A Phase 3 marker must not rescue such a claim either — where the
	 * feature was developed says nothing about which release shipped it.
	 */
	it("rejects a post-v2.2.1 artifact attributed to the v2.2.1 tag inside a current section", () => {
		const section = parseMarkdownSections([
			"# Doc",
			"## Release atual 3.0.0",
			"Migration 0005 pertence à v2.2.1.",
		].join("\n")).find((entry) => entry.title === "Release atual 3.0.0")!;
		expect(classifySectionScope(section)).toBe("current");
		expect(findScopeViolations(section)).toEqual(["v2.2.1 cannot contain 0005"]);
	});

	it("does not accept a Phase 3 marker as proof that 0005 is not content of v2.2.1", () => {
		const section = parseMarkdownSections([
			"# Doc",
			"## Release atual 3.0.0",
			"Migration 0005 pertence à v2.2.1. Foi criada na Fase 3.",
		].join("\n")).find((entry) => entry.title === "Release atual 3.0.0")!;
		expect(classifySectionScope(section)).toBe("current");
		expect(findCrossVersionAttributionViolations(section.text)).toContain("v2.2.1 cannot contain 0005");
		expect(findScopeViolations(section)).toContain("v2.2.1 cannot contain 0005");
	});

	it("rejects every false attribution of a later artifact to the v2.2.1 tag", () => {
		const claims: Array<[string, string]> = [
			["Migration 0005 pertence à v2.2.1.", "0005"],
			["A v2.2.1 inclui a migration `0005_smart_routing.sql`.", "0005_smart_routing"],
			["A migration `0006` faz parte da v2.2.1.", "0006"],
			["`expired_redirect_url` está na v2.2.1.", "expired_redirect_url"],
			["Smart Routing está disponível na v2.2.1.", "Smart Routing"],
			["O Split Test A/B está presente na v2.2.1.", "Split Test A/B"],
			["A v2.2.1 tem `ROOT_REDIRECT_URL`.", "ROOT_REDIRECT_URL"],
		];
		for (const [claim, artifact] of claims) {
			expect(findCrossVersionAttributionViolations(claim), claim).toContain(`v2.2.1 cannot contain ${artifact}`);
		}
	});

	/**
	 * BL-65B2-01: naming two releases in one sentence used to make the whole
	 * fragment invisible to the guard, so an upgrade path and a false attribution
	 * looked alike. A release that is cited explicitly opens the context of the
	 * claim next to it; the second release cannot rescue the first proposition, and
	 * only a clause carrying an upgrade construction is read as a transition.
	 */
	it("rejects a false attribution that a second release in the same sentence would hide", () => {
		const falseAttributions: Array<[string, string]> = [
			["v2.2.1 inclui 0006 e v3.0.0 adiciona outras melhorias.", "0006"],
			["Na v2.2.1 a migration 0005 já existia; na v3.0.0 ela continuou disponível.", "0005"],
		];
		for (const [claim, artifact] of falseAttributions) {
			expect(findCrossVersionAttributionViolations(claim), claim).toContain(`v2.2.1 cannot contain ${artifact}`);
		}

		// The transition the shipped docs write, and two release statements that are
		// each true, stay valid: the guard splits the claims, it does not ban them.
		const valid: string[] = [
			"Para atualizar da v2.2.1 para a v3.0.0, aplique 0004, 0005 e 0006.",
			"v2.2.1 contém até 0003 e v3.0.0 contém até 0006.",
			"v2.2.1 não contém 0005; v3.0.0 contém 0005.",
		];
		for (const claim of valid) {
			expect(findCrossVersionAttributionViolations(claim), claim).toEqual([]);
		}
	});

	it("rejects an artifact stated to already exist in the v2.2.1 tag", () => {
		const claim = "Na v2.2.1 a migration 0005 já existia.";
		expect(findCrossVersionAttributionViolations(claim), claim).toContain("v2.2.1 cannot contain 0005");
	});

	/**
	 * BL-65B2-02: a negation used to be read on the whole fragment, so "não possui
	 * 0004, mas possui 0005" hid the positive claim behind the denial. Negation is
	 * bound to the construction of its own proposition now, while a coordinated
	 * negation ("não contém 0005 nem 0006") still covers the whole list it denies.
	 */
	it("rejects a membership claim that a coordinated negation does not cover", () => {
		const falseAttributions: Array<[string, string]> = [
			["A v2.2.1 não possui 0004, mas possui 0005.", "0005"],
			["A v2.2.1 não possui 0004, porém possui 0006.", "0006"],
			["A v2.2.1 não inclui Smart Routing completo, mas inclui a migration 0005.", "0005"],
		];
		for (const [claim, artifact] of falseAttributions) {
			expect(findCrossVersionAttributionViolations(claim), claim).toContain(`v2.2.1 cannot contain ${artifact}`);
		}

	const denials: string[] = [
		"A v2.2.1 não contém 0005 nem 0006.",
		"A v2.2.1 não possui 0005.",
		"A v2.2.1 contém apenas até 0003, enquanto a v3.0.0 contém 0004-0006.",
	];
	for (const claim of denials) {
		expect(findCrossVersionAttributionViolations(claim), claim).toEqual([]);
	}
});

/**
 * BL-65B2-02, reopened: the guard used to split fragments on every line break,
 * so the release named on the first line of a wrapped sentence never reached
 * the second one — "A v2.2.1 não inclui Smart Routing completo,\nmas inclui a
 * migration 0005." read as two unrelated fragments and the false attribution
 * passed. A single line break that only wraps the sentence is a Markdown soft
 * line break: it is normalized to a space before the claim is split, so the
 * wrapped sentence keeps one release context.
 */
it("rejects a false attribution wrapped across a soft line break", () => {
	const claim = "A v2.2.1 não inclui Smart Routing completo,\nmas inclui a migration 0005.";
	expect(findCrossVersionAttributionViolations(claim), claim).toContain("v2.2.1 cannot contain 0005");

	const section = parseMarkdownSections([
		"# Doc",
		"## Release atual 3.0.0",
		"A v2.2.1 não inclui Smart Routing completo,",
		"mas inclui a migration 0005.",
	].join("\n")).find((entry) => entry.title === "Release atual 3.0.0")!;
	expect(findScopeViolations(section)).toContain("v2.2.1 cannot contain 0005");
});

it("rejects a positive claim after every adversative connector wrapped to the next line", () => {
	const wrappedAdversatives: Array<[string, string]> = [
		["mas", "0005"],
		["porém", "0006"],
		["contudo", "0005"],
		["entretanto", "0006"],
		["todavia", "0005"],
		["enquanto", "0006"],
	];
	for (const [connector, artifact] of wrappedAdversatives) {
		const claim = `A v2.2.1 não possui 0004,\n${connector} possui ${artifact}.`;
		expect(findCrossVersionAttributionViolations(claim), claim).toContain(`v2.2.1 cannot contain ${artifact}`);
	}
});

it("keeps a wrapped denial and a wrapped upgrade instruction valid", () => {
	const valid: string[] = [
		"A v2.2.1 não contém\n0005 nem 0006.",
		"Para atualizar da v2.2.1\npara a v3.0.0,\naplique 0004, 0005 e 0006.",
	];
	for (const claim of valid) {
		expect(findCrossVersionAttributionViolations(claim), claim).toEqual([]);
	}
});

/**
 * Soft line breaks join, structural ones do not: a blank line starts a new
 * paragraph, a heading and a list item open their own blocks, and none of them
 * hands its release context to the text after it.
 */
it("does not carry release context across a real paragraph, heading or bullet boundary", () => {
	const reset: string[] = [
		"A v2.2.1 não contém 0005.\n\nA migration 0005 faz parte da v3.0.0.",
		"## v2.2.1\nA migration 0005 faz parte desta release.",
		"- v2.2.1 contém até 0003.\n- v3.0.0 contém até 0006.",
	];
	for (const claim of reset) {
		expect(findCrossVersionAttributionViolations(claim), claim).toEqual([]);
	}

	// Each bullet is read on its own: the second bullet's release cannot
	// rescue the first bullet's claim, and the first bullet's release cannot
	// frame the second one.
	const bullets = "- v2.2.1 inclui 0005.\n- v3.0.0 inclui 0005.";
	expect(findCrossVersionAttributionViolations(bullets), bullets).toEqual(["v2.2.1 cannot contain 0005"]);
});

	it("rejects the post-expiry destination inside a historical v2.2.1 section", () => {
		const section = parseMarkdownSections([
			"# Doc",
			"## Procedimento histórico: upgrade para a v2.2.1",
			"A migration `0006` adiciona a coluna `expired_redirect_url`; veja `0006_expired_redirect.sql`.",
		].join("\n")).find((entry) => entry.title.startsWith("Procedimento histórico"))!;
		expect(classifySectionScope(section)).toBe("published");
		const expected = expect.arrayContaining(["0006", "0006_expired_redirect", "expired_redirect_url"]);
		expect(findForbiddenTokens(section.text)).toEqual(expected);
		expect(findScopeViolations(section)).toEqual(expected);
	});

	/**
	 * Positive controls: the guard must not block the documentation the shipped
	 * release legitimately needs — the current release naming 0004-0006, and an
	 * upgrade procedure instructing a reader to apply them while leaving the older
	 * tag.
	 */
	it("accepts the current release and the upgrade path naming 0004-0006", () => {
		const current = parseMarkdownSections([
			"# Doc",
			"## Release atual 3.0.0",
			"A release 3.0.0 inclui a `0005` (Smart Routing) e a `0006` (`expired_redirect_url`).",
		].join("\n")).find((entry) => entry.title === "Release atual 3.0.0")!;
		expect(classifySectionScope(current)).toBe("current");
		expect(findScopeViolations(current)).toEqual([]);

		const upgrade = parseMarkdownSections([
			"# Doc",
			"## Upgrade v2.2.1 -> v3.0.0",
			"Aplique as migrations `0004`, `0005` e `0006`.",
		].join("\n")).find((entry) => entry.title.startsWith("Upgrade"))!;
		expect(classifySectionScope(upgrade)).toBe("upgrade");
		expect(findScopeViolations(upgrade)).toEqual([]);

		const historical = parseMarkdownSections([
			"# Doc",
			"## Procedimento histórico: upgrade para a v2.2.1",
			"A tag termina na migration `0003_lgpd_minimization.sql`.",
		].join("\n")).find((entry) => entry.title.startsWith("Procedimento histórico"))!;
		expect(classifySectionScope(historical)).toBe("published");
		expect(findScopeViolations(historical)).toEqual([]);
	});

	/**
	 * The GLOBAL-003 root cause was documentation disagreeing with the artifact.
	 * This test reads the real tag so the published boundary stays checkable
	 * instead of being taken from prose. It is evidence validation, not the
	 * primary guard: a checkout without the tag skips it and the Markdown scope
	 * scanner above still enforces the boundary.
	 */
	it.skipIf(publishedTag === null)("documents a published tag that really ends at migration 0003", () => {
		assertPublishedTagContract(publishedTag!);
	});

	/**
	 * The name keeps "Phase 2" because `dev-validate-phase-2` selects tests by
	 * name and this one still verifies the Phase 2 boundary: 0004 and its A/B
	 * surface belong to the baseline that introduced them, and the migration chains
	 * above it are declared by the release this checkout ships. A test name is a
	 * gate label, not user-facing documentation, so it is allowed to name the phase
	 * even though no section heading does.
	 */
	it("attributes 0003 to the published line, 0004 to the Phase 2 baseline and 0005/0006 to the current release", () => {
		const upgrading = readDoc("docs/upgrading.md");
		const scope = parseMarkdownSections(upgrading).find((entry) => entry.title.startsWith("Escopo das bases"))!;
		expect(classifySectionScope(scope)).toBe("current");
		expect(scope.body).toContain("`0000` a `0003`");
		expect(scope.body).toContain("`0000` a `0004`");
		expect(scope.body).toContain("`0000` a `0005`");
		expect(scope.body).toContain("`0000` a `0006`");

		// The historical v2.2.1 procedure never sends a reader to a later migration.
		const published = parseMarkdownSections(upgrading).find((entry) => entry.title.startsWith("Procedimento histórico"))!;
		expect(classifySectionScope(published)).toBe("published");
		expect(published.body).toContain("0003");
		expect(findScopeViolations(published)).toEqual([]);
	});

	it("reads a development Phase 2 heading as Phase 2, not Phase 3", () => {
		const section = parseMarkdownSections([
			"# Doc",
			"## Baseline local da development Phase 2",
			"0004 ab_enabled dev-prepare",
		].join("\n")).find((entry) => entry.title.includes("Phase 2"))!;
		expect(classifySectionScope(section)).toBe("phase2");
		expect(findScopeViolations(section)).toEqual([]);
	});
});

/**
 * Evidence that is unavailable, evidence that contradicts the docs, and Git that
 * failed outright are three different outcomes. A single `catch { return null }`
 * used to collapse all of them into a skip, which reported a broken Git as "no
 * tag here". Text is not enough to tell them apart either: a corrupt `.git/HEAD`
 * makes Git answer `fatal: not a git repository`, word for word what a source
 * archive produces, so presence of metadata is asked of the filesystem first.
 *
 * These tests drive the helper through each outcome in a throwaway repository
 * under the OS temp directory: the checkout whose tag is under audit is never
 * mutated, and every corruption used by a regression is restored in a `finally`.
 */
const gitIsRunnable = spawnSync("git", ["--version"], { encoding: "utf8" }).error === undefined;

const PUBLISHED_MIGRATIONS = [
	"0000_initial_schema.sql",
	"0001_link_management.sql",
	"0002_advanced_features.sql",
	"0003_lgpd_minimization.sql",
];

function runFixtureGit(directory: string, args: string[]): void {
	const result = spawnSync("git", args, { cwd: directory, env: gitEnvironment(), encoding: "utf8" });
	if (result.error || result.status !== 0) {
		throw new Error(`fixture git ${args.join(" ")} failed: ${result.error?.message ?? result.stderr}`);
	}
}

/**
 * `published-tag` mirrors the real published artifact, `later-baseline-tag` puts
 * the same tag name on Phase 2/3 content, and `no-tag` keeps a valid history
 * without it.
 */
function fixtureRepository(mode: "published-tag" | "later-baseline-tag" | "no-tag"): string {
	const directory = mkdtempSync(join(tmpdir(), "boltlink-tag-evidence-"));
	runFixtureGit(directory, ["init", "-q", "."]);
	runFixtureGit(directory, ["config", "user.email", "fixture@example.com"]);
	runFixtureGit(directory, ["config", "user.name", "Fixture"]);
	runFixtureGit(directory, ["config", "commit.gpgsign", "false"]);
	runFixtureGit(directory, ["config", "tag.gpgsign", "false"]);
	mkdirSync(join(directory, "migrations"), { recursive: true });
	for (const file of PUBLISHED_MIGRATIONS) {
		writeFileSync(join(directory, "migrations", file), "-- fixture migration\n");
	}
	const scripts: Record<string, string> = { dev: "wrangler dev", test: "vitest run" };
	if (mode === "later-baseline-tag") {
		for (const file of ["0004_ab_testing.sql", "0005_smart_routing.sql"]) {
			writeFileSync(join(directory, "migrations", file), "-- later baseline\n");
		}
		mkdirSync(join(directory, "src"), { recursive: true });
		writeFileSync(join(directory, "src", "smart-routing.ts"), "export {};\n");
		mkdirSync(join(directory, "public"), { recursive: true });
		writeFileSync(join(directory, "public", "smart-routing-ui.js"), "\n");
		scripts["dev-prepare"] = "node scripts/dev-prepare.mjs";
	}
	writeFileSync(join(directory, "package.json"), `${JSON.stringify({ name: "boltlink", version: "2.2.1", scripts }, null, 2)}\n`);
	runFixtureGit(directory, ["add", "-A"]);
	runFixtureGit(directory, ["commit", "-q", "--no-verify", "-m", "fixture"]);
	if (mode !== "no-tag") {
		runFixtureGit(directory, ["tag", "v2.2.1"]);
	}
	return directory;
}

describe("Phase 3: published tag evidence discrimination", () => {
	it.skipIf(!gitIsRunnable)("reads a published tag that matches the docs as evidence", () => {
		const directory = fixtureRepository("published-tag");
		try {
			const tag = readPublishedTag(directory);
			expect(tag).not.toBeNull();
			expect(tag!.migrations).toEqual(PUBLISHED_MIGRATIONS.map((file) => `migrations/${file}`));
			assertPublishedTagContract(tag!);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it.skipIf(!gitIsRunnable)("treats an absent tag in a valid repository as unavailable evidence", () => {
		const directory = fixtureRepository("no-tag");
		try {
			// The repository is real and tagged with nothing: the `null` below comes
			// from the missing-ref lookup, not from a directory Git cannot read.
			expect(probeGit(["rev-parse", "--git-dir"], directory).status).toBe(0);
			expect(probeGit(["tag", "--list"], directory).stdout.trim()).toBe("");
			expect(readPublishedTag(directory)).toBeNull();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it.skipIf(!gitIsRunnable)("treats a source tree without Git metadata as unavailable evidence", () => {
		const directory = mkdtempSync(join(tmpdir(), "boltlink-no-metadata-"));
		try {
			expect(spawnSync("git", ["rev-parse", "--git-dir"], { cwd: directory }).status).not.toBe(0);
			expect(hasGitMetadata(directory)).toBe(false);
			// A subdirectory of that archive has no metadata either.
			expect(hasGitMetadata(join(directory, "not-created"))).toBe(false);
			expect(readPublishedTag(directory)).toBeNull();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it.skipIf(!gitIsRunnable)("tells metadata that exists apart from metadata Git can use", () => {
		const repository = fixtureRepository("published-tag");
		const worktreeLike = mkdtempSync(join(tmpdir(), "boltlink-gitdir-file-"));
		try {
			expect(hasGitMetadata(repository)).toBe(true);
			expect(hasGitMetadata(join(repository, "migrations"))).toBe(true);
			// `.git` as a file, the layout worktrees and submodules use, is metadata
			// even when the path it names is unreachable.
			writeFileSync(join(worktreeLike, ".git"), `gitdir: ${join(worktreeLike, "missing-git-dir")}\n`);
			expect(hasGitMetadata(worktreeLike)).toBe(true);
			expect(probeGit(["rev-parse", "--git-dir"], worktreeLike).status).not.toBe(0);
			expect(() => readPublishedTag(worktreeLike)).toThrow(/carries Git metadata/);
		} finally {
			rmSync(repository, { recursive: true, force: true });
			rmSync(worktreeLike, { recursive: true, force: true });
		}
	});

	it.skipIf(!gitIsRunnable)("fails instead of skipping when `.git` exists but HEAD is corrupt", () => {
		const directory = fixtureRepository("published-tag");
		const headPath = join(directory, ".git", "HEAD");
		const head = readFileSync(headPath);
		const tagRefPath = join(directory, ".git", "refs", "tags", "v2.2.1");
		const tagRef = readFileSync(tagRefPath, "utf8");
		try {
			try {
				// Same repository, same tag and intact refs: only HEAD changes below.
				expect(readPublishedTag(directory)).not.toBeNull();
				writeFileSync(headPath, "invalid HEAD\n");
				const broken = probeGit(["rev-parse", "--verify", "--quiet", PUBLISHED_TAG_REF], directory);
				// The collision this regression exists for: Git answers with the text a
				// source archive produces, so stderr alone cannot decide this.
				expect(broken.status).toBe(128);
				expect(broken.stderr).toMatch(/not a git repository/);
				// Nothing else was touched: the tag ref and the object store survive.
				expect(readFileSync(tagRefPath, "utf8")).toBe(tagRef);
				expect(readdirSync(join(directory, ".git", "objects")).length).toBeGreaterThan(0);
				expect(hasGitMetadata(directory)).toBe(true);
				expect(() => readPublishedTag(directory)).toThrow(/carries Git metadata/);
			} finally {
				writeFileSync(headPath, head);
			}
			// HEAD restored and the tag resolves again, so the failure above came from
			// the corruption and not from a repository this test left destroyed.
			expect(probeGit(["rev-parse", "--verify", "--quiet", PUBLISHED_TAG_REF], directory).status).toBe(0);
			expect(readPublishedTag(directory)).not.toBeNull();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it.skipIf(!gitIsRunnable)("fails instead of skipping when Git cannot be spawned", () => {
		const directory = fixtureRepository("published-tag");
		const emptyPath = mkdtempSync(join(tmpdir(), "boltlink-empty-path-"));
		const savedPath = process.env.PATH;
		try {
			// Nothing executable named `git` is reachable, so the process never starts.
			process.env.PATH = emptyPath;
			expect(() => readPublishedTag(directory)).toThrow(/could not run/);
		} finally {
			if (savedPath === undefined) {
				delete process.env.PATH;
			} else {
				process.env.PATH = savedPath;
			}
			rmSync(directory, { recursive: true, force: true });
			rmSync(emptyPath, { recursive: true, force: true });
		}
	});

	it.skipIf(!gitIsRunnable)("fails instead of skipping when Git itself is broken", () => {
		const directory = fixtureRepository("published-tag");
		const configPath = join(directory, ".git", "config");
		const config = readFileSync(configPath, "utf8");
		try {
			// Same directory and same tag: only the health of Git changes below.
			expect(readPublishedTag(directory)).not.toBeNull();
			writeFileSync(configPath, `${config}this line is not valid git config\n`);
			expect(() => readPublishedTag(directory)).toThrow(/bad config/);
		} finally {
			writeFileSync(configPath, config);
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it.skipIf(!gitIsRunnable)("fails the historical assertions when the tag points at a later baseline", () => {
		const directory = fixtureRepository("later-baseline-tag");
		try {
			const tag = readPublishedTag(directory);
			expect(tag).not.toBeNull();
			expect(tag!.files).not.toEqual([]);
			expect(() => assertPublishedTagContract(tag!)).toThrow();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it.skipIf(publishedTag === null)("resolves the live checkout tag to the commit the docs name", () => {
		// AGENTS.md pins v2.2.1 to 8b3895e; a re-tagged checkout must fail here
		// instead of quietly redefining what "published" means.
		expect(readTagContent(["rev-parse", "--verify", PUBLISHED_TAG_REF], process.cwd()).trim()).toMatch(/^8b3895e/);
	});
});

describe("Phase 3: CommonMark fenced opener contract (BL-SR-007-P2-01)", () => {
	it("parses valid backtick openers and rejects a backtick inside the info string", () => {
		expect(parseOpeningFence("```")).toEqual({ char: "`", length: 3 });
		expect(parseOpeningFence("```markdown")).toEqual({ char: "`", length: 3 });
		expect(parseOpeningFence("```js")).toEqual({ char: "`", length: 3 });
		expect(parseOpeningFence("``` markdown")).toEqual({ char: "`", length: 3 });
		expect(parseOpeningFence("````typescript")).toEqual({ char: "`", length: 4 });

		expect(parseOpeningFence("```md`")).toBeNull();
		expect(parseOpeningFence("```foo`bar")).toBeNull();
		expect(parseOpeningFence("````abc`def")).toBeNull();
		expect(parseOpeningFence("```md`not-a-valid-info-string")).toBeNull();
	});

	it("allows a backtick in the info string of a tilde opener only", () => {
		expect(parseOpeningFence("~~~md")).toEqual({ char: "~", length: 3 });
		expect(parseOpeningFence("~~~foo`bar")).toEqual({ char: "~", length: 3 });
		expect(parseOpeningFence("~~~~sh`label")).toEqual({ char: "~", length: 4 });
	});

	it("only allows 0-3 ASCII spaces before an opener", () => {
		expect(parseOpeningFence("```")).toEqual({ char: "`", length: 3 });
		expect(parseOpeningFence(" ```")).toEqual({ char: "`", length: 3 });
		expect(parseOpeningFence("  ```")).toEqual({ char: "`", length: 3 });
		expect(parseOpeningFence("   ```")).toEqual({ char: "`", length: 3 });
		expect(parseOpeningFence("    ```")).toBeNull();
		expect(parseOpeningFence("\t```")).toBeNull();
		expect(parseOpeningFence("\t~~~")).toBeNull();
	});

	it("does not mask an invalid backtick opener as fenced content", () => {
		expect(fencedCodeMask(["```md`foo", "## Published setup", "smartRouting: true"])).toEqual([false, false, false]);
		expect(fencedCodeMask(["```foo`bar", "## Published setup"])).toEqual([false, false]);
	});

	it("keeps the finding reproducer visible to the section scanner", () => {
		const doc = [
			"# Documentation",
			"",
			"```md`not-a-valid-info-string",
			"## Published setup",
			"smartRouting: true",
		].join("\n");

		const sections = parseMarkdownSections(doc);
		expect(sections.map((section) => section.heading)).toEqual(["# Documentation", "## Published setup"]);

		const published = sections.find((section) => section.title === "Published setup")!;
		expect(classifySectionScope(published)).toBe("published");
		expect(findForbiddenTokens(published.text)).toContain("Smart Routing");
	});

	it("flags the finding reproducer through the whole documentation scanner", () => {
		const directory = mkdtempSync(join(tmpdir(), "boltlink-doc-scan-"));
		const file = join(directory, "reproducer.md");
		try {
			writeFileSync(file, [
				"# Documentation",
				"",
				"```md`not-a-valid-info-string",
				"## Published setup",
				"smartRouting: true",
				"",
			].join("\n"));
			const violations = scanPublishedDocumentation(file);
			const report = violations.join("\n");
			expect(report, report).toContain(file);
			expect(report).toContain("Smart Routing");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("still masks fake headings inside a valid backtick fence without hiding tokens", () => {
		const doc = [
			"## Published setup",
			"```md",
			"### Unreleased / Fase 3",
			"smartRouting: true",
			"```",
		].join("\n");

		const sections = parseMarkdownSections(doc);
		expect(sections.map((section) => section.title)).toEqual(["Published setup"]);
		expect(sections[0].body).toContain("### Unreleased / Fase 3");
		expect(classifySectionScope(sections[0])).toBe("published");
		expect(findForbiddenTokens(sections[0].text)).toContain("Smart Routing");
	});

	it("still masks fake headings inside a valid tilde fence and keeps tokens visible", () => {
		const doc = [
			"## Published setup",
			"~~~",
			"### Unreleased / Fase 3",
			"smartRoutingRules",
			"~~~",
		].join("\n");

		const sections = parseMarkdownSections(doc);
		expect(sections.map((section) => section.title)).toEqual(["Published setup"]);
		expect(classifySectionScope(sections[0])).toBe("published");
		expect(findForbiddenTokens(sections[0].text)).toContain("smartRoutingRules");
	});

	it("treats a tilde opener with a backtick in the info string as a real fence", () => {
		const doc = [
			"## Published setup",
			"~~~sh`label",
			"### Unreleased / Fase 3",
			"smartRouting: true",
			"~~~",
		].join("\n");

		const sections = parseMarkdownSections(doc);
		expect(sections.map((section) => section.title)).toEqual(["Published setup"]);
		expect(sections[0].body).toContain("### Unreleased / Fase 3");
		expect(findForbiddenTokens(sections[0].text)).toContain("Smart Routing");
	});

	it("does not open a fence indented by four spaces", () => {
		const doc = ["    ```md", "## Published setup", "smartRouting: true"].join("\n");

		const sections = parseMarkdownSections(doc);
		// The indented ```md is not a fence, so it is real content before the
		// first heading: under BL-73-02 that content is the "(preamble)"
		// section instead of vanishing from every scanner.
		expect(sections.map((section) => section.heading)).toEqual([PREAMBLE_SECTION_TITLE, "## Published setup"]);
		expect(sections[0].body).toContain("```md");
		const published = sections.find((section) => section.heading === "## Published setup")!;
		expect(classifySectionScope(published)).toBe("published");
		expect(findForbiddenTokens(published.text)).toContain("Smart Routing");
	});

	it("does not treat a tab-indented fence as an opener", () => {
		expect(parseOpeningFence("\t```")).toBeNull();
		expect(fencedCodeMask(["\t```", "## Published setup"])).toEqual([false, false]);
	});

	it("requires the closing run to match character and length", () => {
		expect(fencedCodeMask(["````", "~~~", "```", "## Real"])).toEqual([true, true, true, true]);
		expect(fencedCodeMask(["````", "````", "## Real"])).toEqual([true, true, false]);
		expect(fencedCodeMask(["```", "~~~", "## Real"])).toEqual([true, true, true]);
		expect(fencedCodeMask(["~~~", "```", "## Real"])).toEqual([true, true, true]);
	});

	it("does not close a fence when trailing content follows the closing run", () => {
		expect(fencedCodeMask(["```", "```foo", "## Real"])).toEqual([true, true, true]);
		expect(fencedCodeMask(["```", "```   ", "## Real"])).toEqual([true, true, false]);
	});

	it("keeps an unterminated valid fence structural to EOF", () => {
		const doc = [
			"## Published setup",
			"```md",
			"### Unreleased / Fase 3",
			"smartRouting: true",
		].join("\n");

		const sections = parseMarkdownSections(doc);
		expect(sections.map((section) => section.title)).toEqual(["Published setup"]);
		expect(findForbiddenTokens(sections[0].text)).toContain("Smart Routing");
	});

	it("resumes real headings across multiple closed fences", () => {
		const doc = [
			"## Doc",
			"```",
			"## Fenced One",
			"```",
			"### Real One",
			"~~~",
			"## Fenced Two",
			"~~~",
			"### Real Two",
		].join("\n");

		const sections = parseMarkdownSections(doc);
		expect(sections.map((section) => section.title)).toEqual(["Doc", "Real One", "Real Two"]);
	});

	it("shares fence awareness with markdownSection and the v2.2.1 loop", () => {
		const text = [
			"## Published setup",
			"```md",
			"## v2.2.1 fenced decoy",
			"smartRouting: true",
			"```",
			"## Tail",
		].join("\n");

		expect(markdownSection(text, "## v2.2.1 fenced decoy")).toBeNull();

		const section = markdownSection(text, "## Published setup");
		expect(section).not.toBeNull();
		expect(section).toContain("smartRouting: true");

		const lines = text.split(/\r?\n/);
		const fenced = fencedCodeMask(lines);
		const decoy = lines.findIndex((line) => line === "## v2.2.1 fenced decoy");
		expect(decoy).toBeGreaterThan(-1);
		expect(fenced[decoy]).toBe(true);
	});

	it("keeps fenced code tokens visible to the forbidden token scanner", () => {
		const doc = ["## Published setup", "```json", '{"smartRouting": true}', "```"].join("\n");

		const sections = parseMarkdownSections(doc);
		expect(classifySectionScope(sections[0])).toBe("published");
		expect(findForbiddenTokens(sections[0].text)).toContain("Smart Routing");
	});

	it("proves a permissive opener would let the reproducer escape (negative control)", () => {
		const permissiveMask = (lines: string[]): boolean[] => {
			const masked = new Array<boolean>(lines.length).fill(false);
			let open = false;
			for (let index = 0; index < lines.length; index += 1) {
				masked[index] = open;
				if (/^\s{0,3}(`{3,}|~{3,})/.test(lines[index])) {
					open = !open;
					masked[index] = true;
				}
			}
			return masked;
		};

		const lines = ["```md`not-a-valid-info-string", "## Published setup", "smartRouting: true"];

		expect(fencedCodeMask(lines)).toEqual([false, false, false]);
		expect(permissiveMask(lines)).toEqual([true, true, true]);
	});
});

describe("Phase 3: Smart Routing admin feedback channel", () => {
	it("routes Smart errors to the assertive Smart region only", () => {
		const api = loadApi();

		const localRule = api.resolveSubmissionFeedback({ ok: false, code: "INVALID_URL" });
		expect(localRule.smartError).toBeTruthy();
		expect(localRule.formStatus).toBeNull();
		expect(localRule.focusRules).toBe(true);

		const hybrid = api.resolveSubmissionFeedback({ ok: false, code: "MODE_CONFLICT" });
		expect(hybrid.smartError).toBeTruthy();
		expect(hybrid.formStatus).toBeNull();

		const backend = api.resolveSubmissionFeedback({ ok: false, code: "HTTP_ERROR", error: "Invalid smartRoutingRules (SHADOWED_RULE)" });
		expect(backend.smartError).toBeTruthy();
		expect(backend.formStatus).toBeNull();
	});

	it("routes unrelated and successful outcomes to the general status", () => {
		const api = loadApi();

		const general = api.resolveSubmissionFeedback({ ok: false, code: "HTTP_ERROR", error: "Slug already exists" });
		expect(general.smartError).toBeNull();
		expect(general.formStatus).toBe("Slug already exists");

		const success = api.resolveSubmissionFeedback({ ok: true, requestCount: 1 });
		expect(success.smartError).toBeNull();
		expect(success.formStatus).toBeNull();
	});

	it("never announces the same Smart message in both regions", () => {
		const api = loadApi();
		const messages = ["Any/Any", "INVALID_URL", "MODE_CONFLICT", "SHADOWED_RULE"];
		for (const code of messages) {
			const feedback = api.resolveSubmissionFeedback({ ok: false, code, error: `Invalid smartRoutingRules (${code})` });
			if (feedback.smartError) {
				expect(feedback.formStatus).toBeNull();
			}
		}
	});
});

function readDoc(file: string) {
	return readFileSync(resolve(process.cwd(), file), "utf8");
}

type Fence = { char: "`" | "~"; length: number };

/**
 * Parses a minimal CommonMark opening code fence: 0–3 ASCII spaces, a run of at
 * least three backticks or at least three tildes (never mixed), followed by an
 * optional info string. A backtick fence is invalid when its info string
 * contains a backtick; the same info string is allowed on a tilde fence.
 * Returns null when the line is not a valid opener, so it opens no fence.
 */
function parseOpeningFence(line: string): Fence | null {
	const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
	if (!match) {
		return null;
	}
	const char = match[2][0] as "`" | "~";
	const info = match[3];
	if (char === "`" && info.includes("`")) {
		return null;
	}
	return { char, length: match[2].length };
}

/**
 * Reports whether a line closes the given opening fence: 0–3 ASCII spaces, the
 * same fence character, a run at least as long as the opener, then only spaces
 * or tabs. A different character or trailing content never closes it.
 */
function isClosingFence(line: string, open: Fence): boolean {
	const match = /^( {0,3})(`{3,}|~{3,})[ \t]*$/.exec(line);
	return Boolean(match && match[2][0] === open.char && match[2].length >= open.length);
}

/**
 * Marks every line that belongs to a CommonMark fenced code block (``` or ~~~).
 * Headings inside fences are documentation examples, not real structure, so the
 * scanners must ignore them to stay fenced-code-aware. Fenced content itself is
 * preserved for forbidden-token scanning.
 */
function fencedCodeMask(lines: string[]): boolean[] {
	const masked = new Array<boolean>(lines.length).fill(false);
	let fence: Fence | null = null;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (fence) {
			masked[index] = true;
			if (isClosingFence(line, fence)) {
				fence = null;
			}
			continue;
		}
		const open = parseOpeningFence(line);
		if (open) {
			fence = open;
			masked[index] = true;
		}
	}
	return masked;
}

/** Extracts a section by exact heading, up to the next heading of same or higher level. */
function markdownSection(text: string, heading: string): string | null {
	const lines = text.split(/\r?\n/);
	const fenced = fencedCodeMask(lines);
	const start = lines.findIndex((line, index) => !fenced[index] && line.trim() === heading);
	if (start === -1) {
		return null;
	}
	const level = (lines[start].match(/^#+/) || [""])[0].length;
	let end = lines.length;
	for (let index = start + 1; index < lines.length; index += 1) {
		if (fenced[index]) {
			continue;
		}
		const match = lines[index].match(/^(#+)\s/);
		if (match && match[1].length <= level) {
			end = index;
			break;
		}
	}
	return lines.slice(start, end).join("\n");
}

type MarkdownSection = {
	level: number;
	title: string;
	heading: string;
	body: string;
	ancestors: Array<{ level: number; title: string }>;
	text: string;
};

/**
 * The documentation describes five different code states, and each section is
 * scoped to exactly one of them. The published tag is the smallest: it ends at
 * migration 0003. Phase 2 (the local baseline) adds 0004 and A/B. Phase 3 (the
 * working tree) adds 0005 and Smart Routing. The current release is the state
 * this checkout ships: 0004 through 0006 plus every Phase 5 surface, all
 * released together as 3.0.0. `upgrade` is the transition between two releases.
 */
type SectionScope = "published" | "phase2" | "unreleased" | "current" | "upgrade" | "neutral";

const PUBLISHED_SCOPE_PATTERNS = [
	/v2\.2\.1/i,
	/\bpublished\b/i,
	/vers[ãa]o publicada/i,
	/release publicada/i,
	/baseline publicada/i,
	/current published/i,
	/vers[ãa]o est[áa]vel/i,
];

const PHASE2_SCOPE_PATTERNS = [
	/phase\s*2/i,
	/fase\s*2/i,
	/local phase 2/i,
];

const UNRELEASED_SCOPE_PATTERNS = [
	/unreleased/i,
	/fase\s*3/i,
	/phase\s*3/i,
	/\bdevelopment\b/i,
	/development tree/i,
	/\bworking tree\b/i,
	/pr[óo]xima release/i,
	/next release/i,
];

/**
 * The release this checkout ships (3.0.0). Every artifact added after the
 * published v2.2.1 tag belongs here once it is shipped, so a section about a
 * released feature is resolved as `current` instead of inheriting the published
 * scope of a historical parent. It is matched after the published patterns so a
 * heading that names both keeps the stricter historical scope.
 */
const CURRENT_SCOPE_PATTERNS = [
	/\bv?3\.(?:0\.0|1\.[01])\b/i,
	/release atual/i,
	/vers[ãa]o atual/i,
];

/**
 * A documented artifact that did not exist in the v2.2.1 tag, together with the
 * migration that introduced it. The number is what makes an attribution checkable:
 * an artifact cannot be content of a release whose migration ceiling is lower.
 */
type FeatureArtifact = { label: string; pattern: RegExp; introducedIn: number };

/** Phase 3 artifacts: absent from both the published tag and the Phase 2 baseline. */
const UNRELEASED_FEATURE_TOKENS: FeatureArtifact[] = [
	{ label: "0005", pattern: /\b0005\b/, introducedIn: 5 },
	{ label: "0005_smart_routing", pattern: /0005_smart_routing/i, introducedIn: 5 },
	{ label: "Smart Routing", pattern: /smart[\s-]?routing/i, introducedIn: 5 },
	{ label: "smartRoutingRules", pattern: /smartRoutingRules/i, introducedIn: 5 },
	{ label: "smart_routing_rules", pattern: /smart_routing_rules/i, introducedIn: 5 },
	{ label: "src/smart-routing.ts", pattern: /src\/smart-routing\.ts/i, introducedIn: 5 },
	{ label: "public/smart-routing-ui.js", pattern: /public\/smart-routing-ui\.js/i, introducedIn: 5 },
];

/** Phase 2 artifacts: present in the local baseline, absent from the published tag. */
const PHASE2_FEATURE_TOKENS: FeatureArtifact[] = [
	{ label: "0004", pattern: /\b0004\b/, introducedIn: 4 },
	{ label: "0004_ab_testing", pattern: /0004_ab_testing/i, introducedIn: 4 },
	{ label: "Split Test A/B", pattern: /split\s*test\s*a\/b/i, introducedIn: 4 },
	{ label: "A/B testing", pattern: /a\/b\s*testing/i, introducedIn: 4 },
	{ label: "ab_enabled", pattern: /\bab_enabled\b/i, introducedIn: 4 },
	{ label: "ab_target_url", pattern: /\bab_target_url\b/i, introducedIn: 4 },
	{ label: "dev-prepare", pattern: /dev-prepare/i, introducedIn: 4 },
];

/**
 * Phase 4 artifacts: absent from the published tag too, and the half of the
 * boundary the published forbidden list used to leave open — a published section
 * could describe the post-expiry destination and `ROOT_REDIRECT_URL` and pass.
 * The generic word `expiration` is deliberately not a token: it predates the
 * published tag, so only identifiers of the new feature are listed.
 */
const PHASE4_FEATURE_TOKENS: FeatureArtifact[] = [
	{ label: "0006", pattern: /\b0006\b/, introducedIn: 6 },
	{ label: "0006_expired_redirect", pattern: /0006_expired_redirect/i, introducedIn: 6 },
	{ label: "expired_redirect_url", pattern: /expired_redirect_url/i, introducedIn: 6 },
	{ label: "expiredRedirectUrl", pattern: /expiredRedirectUrl/, introducedIn: 6 },
	{ label: "ROOT_REDIRECT_URL", pattern: /ROOT_REDIRECT_URL/, introducedIn: 6 },
];

/** Everything the published v2.2.1 tag does not contain. */
const POST_PUBLISHED_FEATURE_TOKENS: FeatureArtifact[] = [
	...PHASE2_FEATURE_TOKENS,
	...UNRELEASED_FEATURE_TOKENS,
	...PHASE4_FEATURE_TOKENS,
];

const PUBLISHED_FORBIDDEN_TOKENS = POST_PUBLISHED_FEATURE_TOKENS;

/** Title given to the implicit section that holds content before the first heading. */
const PREAMBLE_SECTION_TITLE = "(preamble)";

/** Parses Markdown headings (#..######) into sections with ancestry. */
function parseMarkdownSections(markdown: string): MarkdownSection[] {
	const lines = markdown.split(/\r?\n/);
	const fenced = fencedCodeMask(lines);
	const headings: Array<{ index: number; level: number; title: string; heading: string }> = [];
	for (let index = 0; index < lines.length; index += 1) {
		if (fenced[index]) {
			continue;
		}
		const match = /^(#{1,6})\s+(.*\S)\s*$/.exec(lines[index]);
		if (match) {
			headings.push({ index, level: match[1].length, title: match[2].trim(), heading: lines[index].trim() });
		}
	}

	const sections: MarkdownSection[] = [];

	// BL-73-02: content before the first heading used to escape every scanner
	// because it belonged to no section. It is now the "(preamble)" section —
	// scope-neutral, but fully visible to the stale-marker and framing scans.
	// A preamble that is nothing but fenced code produces no section: there is
	// nothing outside fences to scan.
	const firstHeadingIndex = headings.length > 0 ? headings[0].index : lines.length;
	const preambleLines = lines.slice(0, firstHeadingIndex);
	if (preambleLines.some((line, index) => !fenced[index] && line.trim().length > 0)) {
		const body = preambleLines.join("\n");
		sections.push({
			level: 0,
			title: PREAMBLE_SECTION_TITLE,
			heading: PREAMBLE_SECTION_TITLE,
			body,
			ancestors: [],
			text: body,
		});
	}

	const stack: Array<{ level: number; title: string }> = [];
	for (let position = 0; position < headings.length; position += 1) {
		const current = headings[position];
		while (stack.length && stack[stack.length - 1].level >= current.level) {
			stack.pop();
		}
		const ancestors = stack.map((entry) => ({ level: entry.level, title: entry.title }));
		stack.push({ level: current.level, title: current.title });

		// Direct content only: stop at the next heading of any level so a child
		// section is classified and scanned on its own scope.
		const end = position + 1 < headings.length ? headings[position + 1].index : lines.length;
		const body = lines.slice(current.index + 1, end).join("\n");
		sections.push({
			level: current.level,
			title: current.title,
			heading: current.heading,
			body,
			ancestors,
			text: `${current.heading}\n${body}`,
		});
	}
	return sections;
}

/**
 * A heading that names both the published tag and the release this checkout ships
 * describes the transition between them ("Upgrade v2.2.1 -> v3.0.0"). Forcing it
 * to `published` flags the upgrade procedure for naming 0004-0006, which is
 * exactly what an upgrade document has to name; reading it as `current` would let
 * it rewrite history. The attribution guard still applies, so a transition written
 * as if the older tag already contained the newer artifacts is rejected.
 */
const UPGRADE_SCOPE_PATTERN = /\bv2\.2\.1\b[\s\S]*\bv?3\.0\.0\b|\bv?3\.0\.0\b[\s\S]*\bv2\.2\.1\b/i;

/**
 * Resolves the effective scope from the nearest heading/ancestor marker. The
 * nearest marker wins, so a Phase 3 child of a published parent is scanned as
 * Phase 3. An upgrade heading naming both releases is matched first, then Phase 2
 * before the generic `development` marker so a "development Phase 2" heading is
 * not read as Phase 3, and the published tag before the current release so a
 * heading naming the historical tag keeps the stricter scope.
 */
function classifySectionScope(section: MarkdownSection): SectionScope {
	const chain = [...section.ancestors.map((entry) => entry.title), section.title];
	for (let index = chain.length - 1; index >= 0; index -= 1) {
		const title = chain[index];
		if (UPGRADE_SCOPE_PATTERN.test(title)) {
			return "upgrade";
		}
		if (PHASE2_SCOPE_PATTERNS.some((pattern) => pattern.test(title))) {
			return "phase2";
		}
		if (UNRELEASED_SCOPE_PATTERNS.some((pattern) => pattern.test(title))) {
			return "unreleased";
		}
		// Explicit current-version identity supersedes generic published wording.
		// A heading naming v2.2.1 still retains its strict historical ceiling.
		if (/\bv?3\.1\.[01]\b/i.test(title) && !/v2\.2\.1/i.test(title)) return "current";
		if (PUBLISHED_SCOPE_PATTERNS.some((pattern) => pattern.test(title))) {
			return "published";
		}
		if (CURRENT_SCOPE_PATTERNS.some((pattern) => pattern.test(title))) {
			return "current";
		}
	}
	return "neutral";
}

/** Tokens that must not appear in a published-tag section. */
function findForbiddenTokens(text: string): string[] {
	return PUBLISHED_FORBIDDEN_TOKENS.filter((token) => token.pattern.test(text)).map((token) => token.label);
}

/** Phase 3 tokens, still forbidden inside a Phase 2 (local baseline) section. */
function findPhase3Tokens(text: string): string[] {
	return UNRELEASED_FEATURE_TOKENS.filter((token) => token.pattern.test(text)).map((token) => token.label);
}

/**
 * A release the documentation has to keep apart, with the last migration it
 * contains. `v2.2.1` is the published tag (ceiling `0003`); `3.0.0` is the release
 * this checkout ships (ceiling `0006`). The ceiling is the fact a false
 * attribution contradicts, and this map is the only place the version/migration
 * numbers live.
 */
type ReleaseLine = { release: string; through: number; pattern: RegExp };

const RELEASE_LINES: ReleaseLine[] = [
	{ release: "v2.2.1", through: 3, pattern: /v2\.2\.1|vers[ãa]o publicada|release publicada/i },
	{ release: "3.0.0", through: 6, pattern: /\bv?3\.0\.0\b/i },
];

/**
 * Constructions that link an artifact to a release as content of it. The list is
 * closed on purpose: an upgrade instruction ("aplique `0004`") is not membership,
 * so every pattern states a claim of belonging instead of matching any verb.
 */
const MEMBERSHIP_CLAIM_PATTERNS = [
	/\bpertence(?:m)?\b/i,
	/\bfaz(?:em)?\s+parte\b/i,
	/\bintegra(?:m|va|r)?\b/i,
	/\bsuporta(?:m|va|r)?\b/i,
	/\b(?:inclui|incluem|cont[ée]m|cont[êe]m|possui|possuem|traz|trazem|tem|t[êe]m|adiciona|adicionam|introduz|introduzem|chega|chegam)\b/i,
	/\best[áa]\s+(?:na|no|em|presente)/i,
	/\b(?:dispon[íi]vel|presente|existe)\s+(?:n[ao]|em)\b/i,
	/\bj[áa]\s+(?:existia|existiam|estava|estavam)\b/i,
	/\b(?:belongs?|includes?|contains?|ships?|introduces?|adds?)\b/i,
];

/**
 * The same constructions denying membership, bound to the proposition it sits in.
 * "Um checkout da tag `v2.2.1` não contém a `0005`" states the boundary instead of
 * breaking it, so a negated proposition is never a false attribution. Emphasis
 * markers are allowed between the words because the docs bold the negation:
 * `**não** contém`.
 */
const NEGATED_MEMBERSHIP_PATTERN =
	/\b(?:n[ãa]o|nunca|sem)\b[\s*_]*(?:\w+[\s*_]+){0,2}?(?:pertence|faz(?:em)?\s+parte|integra|suporta|inclui|incluem|cont[ée]m|cont[êe]m|possui|possuem|traz|trazem|tem|t[êe]m|est[áa]|dispon[íi]vel|presente|existe|existia|estava)/i;

/**
 * Lines that open a context of their own instead of wrapping the running
 * sentence: a heading, a bullet, a numbered item, a table row or a thematic
 * break. Together with a blank line (a new paragraph) they are the boundaries
 * the attribution guard resets on.
 */
const STRUCTURAL_LINE_PATTERN =
	/^ {0,3}(?:#{1,6}(?:\s|$)|[-*+](?:\s|$)|\d+[.)]\s|\||-{3,}\s*$|\*{3,}\s*$|_{3,}\s*$)/;

/**
 * Groups a section into paragraph blocks. Markdown calls a single line break
 * inside one paragraph a soft line break: it only wraps the sentence visually,
 * so consecutive prose lines join into one block and the wrap reads as a space.
 * Every structural line — and every fenced-code line, through the same mask the
 * heading parser uses — stands as a block of its own, so its context never
 * blends with a neighbor's.
 */
function splitAttributionBlocks(text: string): string[] {
	const lines = text.split(/\r?\n/);
	const fenced = fencedCodeMask(lines);
	const blocks: string[] = [];
	let paragraph: string[] = [];
	const flushParagraph = () => {
		if (paragraph.length > 0) {
			blocks.push(paragraph.join(" "));
			paragraph = [];
		}
	};
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (fenced[index] || line.trim().length === 0 || STRUCTURAL_LINE_PATTERN.test(line)) {
			flushParagraph();
			if (line.trim().length > 0) {
				blocks.push(line.trim());
			}
			continue;
		}
		paragraph.push(line.trim());
	}
	flushParagraph();
	return blocks;
}

/**
 * Splits a section into claim-sized fragments: a sentence end or a semicolon
 * separates them inside a block, and the block boundaries (a real paragraph, a
 * heading, a list item, a code line) separate them too. A period inside
 * `v2.2.1` or `0006_expired.sql` is followed by a non-space, so release names
 * and file names survive intact. A line break that only wraps the sentence is
 * normalized to a space first: "…não inclui X,\nmas inclui Y" is one sentence
 * with two clauses, not two fragments that forgot each other's release.
 */
function splitAttributionFragments(text: string): string[] {
	return splitAttributionBlocks(text)
		.flatMap((block) => block.split(/(?<=[.;!?])\s+/))
		.map((fragment) => fragment.trim())
		.filter((fragment) => fragment.length > 0);
}

/**
 * Adversative connectors start a new proposition. In "não possui 0004, mas possui
 * 0005" one artifact is denied and another is claimed, so the negation of the
 * first must not reach the second. Requiring the comma keeps the split on the
 * adversative clause the docs write instead of on any textual "mas".
 */
const ADVERSATIVE_CLAUSE_BOUNDARY = /,\s*(?:mas|por[ée]m|contudo|entretanto|todavia|enquanto)\s+/i;

/** Release names, derived from `RELEASE_LINES` so the map is never duplicated. */
const RELEASE_REFERENCE_SOURCE = RELEASE_LINES.map((line) => `(?:${line.pattern.source})`).join("|");

/**
 * A conjunction that puts a release back in front starts a new proposition: in
 * "v2.2.1 inclui 0006 e v3.0.0 adiciona outras melhorias" the two releases carry
 * two claims, and the first has to be read on its own.
 */
const CONJUNCTION_BEFORE_RELEASE = new RegExp(
	`\\s+e\\s+(?=(?:[ao]s?\\s+)?(?:${RELEASE_REFERENCE_SOURCE}))`,
	"i",
);

/**
 * A clause naming two releases is an upgrade path only when it says so. The docs
 * and the fixtures write it as an arrow ("`v2.2.1` → `3.0.0`"), with the upgrade
 * vocabulary, or with "de X para Y". Two releases merely mentioned together are
 * two release claims, not a transition.
 */
const TRANSITION_CONSTRUCTION_PATTERNS = [
	/→|->|⇒|➜/,
	/\b(?:atualiz\w+|upgrade|migra\w+)\b/i,
	/\b(?:de|da|do)\b[^.;]{0,80}?\bpara\b/i,
];

/** Splits one fragment into the propositions the guard decides on. */
function splitAttributionClauses(fragment: string): string[] {
	const clauses: string[] = [];
	for (const part of fragment.split(ADVERSATIVE_CLAUSE_BOUNDARY)) {
		for (const clause of part.split(CONJUNCTION_BEFORE_RELEASE)) {
			const trimmed = clause.trim();
			if (trimmed.length > 0) {
				clauses.push(trimmed);
			}
		}
	}
	return clauses;
}

/**
 * The cross-version attribution guard. Scope classification resolves which code
 * state a section *documents*; it says nothing about what that section *claims*
 * about other releases, so a `current` section could still state that migration
 * 0005 belongs to the v2.2.1 tag and pass every scope check.
 *
 * The decision is per proposition, never per fragment. A release named in a
 * sentence carries its context to the following clause of that same sentence
 * ("… não possui 0004, mas possui 0005") and never across a sentence boundary, so
 * a scope note cannot leak its release into the next claim. Negation is read on
 * the clause that carries the construction, so denying one artifact does not deny
 * another. A clause naming two releases is an upgrade path only when it carries an
 * upgrade construction; otherwise each named release has to contain the artifact
 * on its own.
 */
function findCrossVersionAttributionViolations(text: string): string[] {
	const violations: string[] = [];
	for (const fragment of splitAttributionFragments(text)) {
		let context: ReleaseLine | null = null;
		for (const clause of splitAttributionClauses(fragment)) {
			const named = RELEASE_LINES.filter((line) => line.pattern.test(clause));
			const isTransition = named.length > 1 && TRANSITION_CONSTRUCTION_PATTERNS.some((pattern) => pattern.test(clause));
			context = named.length === 1 ? named[0] : named.length > 1 ? null : context;
			if (isTransition) {
				continue;
			}
			const releases = named.length > 0 ? named : context ? [context] : [];
			if (!releases.length) {
				continue;
			}
			const artifacts = POST_PUBLISHED_FEATURE_TOKENS.filter((artifact) => artifact.pattern.test(clause));
			if (!artifacts.length) {
				continue;
			}
			const claimsMembership = MEMBERSHIP_CLAIM_PATTERNS.some((pattern) => pattern.test(clause));
			if (!claimsMembership || NEGATED_MEMBERSHIP_PATTERN.test(clause)) {
				continue;
			}
			for (const release of releases) {
				for (const artifact of artifacts) {
					if (artifact.introducedIn > release.through) {
						violations.push(`${release.release} cannot contain ${artifact.label}`);
					}
				}
			}
		}
	}
	return violations;
}

/**
 * Scope-aware violation report for one section: what the section's own code state
 * excludes, plus the attribution guard that applies to every scope.
 */
function findScopeViolations(section: MarkdownSection): string[] {
	const scope = classifySectionScope(section);
	if (scope === "published") {
		return [...findForbiddenTokens(section.text), ...findCrossVersionAttributionViolations(section.text)];
	}
	if (scope === "phase2") {
		return [...findPhase3Tokens(section.text), ...findCrossVersionAttributionViolations(section.text)];
	}
	return findCrossVersionAttributionViolations(section.text);
}

const EXCLUDED_DOC_DIRECTORIES = new Set([
	"node_modules",
	".git",
	"coverage",
	"dist",
	"tmp",
	".wrangler",
	".dev-env",
	".github",
	".vscode",
]);

function collectDocumentationFiles(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (EXCLUDED_DOC_DIRECTORIES.has(entry.name)) {
				continue;
			}
			files.push(...collectDocumentationFiles(resolve(directory, entry.name)));
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			files.push(resolve(directory, entry.name));
		}
	}
	return files;
}

/**
 * Scans one file for scope violations: published sections may not mention any
 * Phase 2 or Phase 3 artifact, and Phase 2 sections may not mention Phase 3.
 */
function scanPublishedDocumentation(file: string): string[] {
	const sections = parseMarkdownSections(readFileSync(file, "utf8"));
	const violations: string[] = [];
	for (const section of sections) {
		const hits = findScopeViolations(section);
		if (hits.length) {
			violations.push(`${file} > [${classifySectionScope(section)}] ${section.heading}: ${hits.join(", ")}`);
		}
	}
	return violations;
}

describe("Phase 3: Smart Routing documentation scope", () => {
	it("keeps Smart Routing under Unreleased in RELEASE_NOTES", () => {
		const notes = readDoc("RELEASE_NOTES.md");
		const smartIndex = notes.indexOf("Smart Routing");
		const versionIndex = notes.indexOf("## BoltLink 2.2.1");
		expect(smartIndex).toBeGreaterThan(-1);
		expect(versionIndex).toBeGreaterThan(-1);
		expect(smartIndex).toBeLessThan(versionIndex);
	});

	it("keeps the historical README upgrade section free of Smart Routing and 0005", () => {
		const readme = readDoc("README.md");
		const published = markdownSection(readme, "## Procedimento histórico: upgrade para a v2.2.1");
		expect(published).not.toBeNull();
		expect(published).not.toMatch(/0005|Smart Routing/i);

		const current = markdownSection(readme, "## Smart Routing e migration 0005 (release 3.0.0)");
		expect(current).not.toBeNull();
		expect(current).toMatch(/0005/);
		expect(current).toMatch(/Smart Routing/i);
	});

	it("keeps the README usage section led by the shipped release", () => {
		const readme = readDoc("README.md");
		const section = parseMarkdownSections(readme).find((entry) => entry.title.startsWith("1. Wrangler local"))!;
		expect(section).toBeTruthy();
		// The main installation path is the release this checkout ships, and it
		// carries both the clean-install helper and the pending-migration step.
		expect(classifySectionScope(section)).toBe("current");
		expect(findScopeViolations(section)).toEqual([]);
		expect(section.body).toMatch(/dev-prepare/);
		expect(section.body).toMatch(/migrations apply/);

		// The previous release stays documented, in a child section whose heading
		// says it is historical; that child is where the published boundary applies.
		const historical = parseMarkdownSections(readme).find(
			(entry) => entry.ancestors.some((ancestor) => ancestor.title.startsWith("1. Wrangler local")) && /v2\.2\.1/.test(entry.title),
		)!;
		expect(historical).toBeTruthy();
		expect(classifySectionScope(historical)).toBe("published");
		expect(historical.body).toMatch(/migrations apply/);
		expect(findScopeViolations(historical)).toEqual([]);
	});

	/**
	 * The ambiguity BL-65B1-01 named was positional, not textual: the previous
	 * release was the first procedure a reader met, with the shipped release
	 * nested under it. This asserts the structure instead of the copy, so the
	 * lineage can stay as long as it is never the leading path.
	 */
	it("keeps the previous release out of the leading position of the README usage section", () => {
		const readme = readDoc("README.md");
		const usage = parseMarkdownSections(readme).filter((entry) =>
			entry.ancestors.some((ancestor) => ancestor.title === "Três formas de usar"),
		);
		expect(usage.length).toBeGreaterThan(0);

		const leading = usage.filter((entry) => entry.level === 3);
		expect(leading.length).toBeGreaterThan(0);
		expect(leading[0].title, "the first usage path must be the shipped release").toMatch(/3\.1\.1/);
		expect(leading[0].title, "the first usage path must not be the previous release").not.toMatch(/v2\.2\.1/);

		// Lineage is preserved, but every heading naming the previous release has to
		// say that it is historical.
		const previousRelease = usage.filter((entry) => /v2\.2\.1/.test(entry.title));
		expect(previousRelease.length).toBeGreaterThan(0);
		for (const entry of previousRelease) {
			expect(entry.title, `${entry.heading} must be framed as historical`).toMatch(/hist[óo]ric|anterior|legacy|antig/i);
		}
	});

	/**
	 * The 3.0.0 transition renamed what "later than v2.2.1" is called, so the docs
	 * no longer agree on a single marker, and asking the whole file was the wrong
	 * unit twice over: a file naming 3.0.0 somewhere used to license every mention
	 * of 0005 in it, and a bare "Fase 3" marker used to count as proof of the
	 * release boundary — where a feature was developed does not say which release
	 * shipped it. The invariant is asked of the section that mentions the migration
	 * and needs no marker at all: the section must not be scoped to the historical
	 * tag or to the Phase 2 baseline, and it must not claim that v2.2.1 contains
	 * the migration. A section that names the migration as a schema capability,
	 * without any release framing, is not making a release claim and passes.
	 */
	it("never presents migration 0005 as content of the v2.2.1 tag in any doc section", () => {
		const files = [
			"README.md",
			"AI-START.md",
			"AGENTS.md",
			"docs/architecture.md",
			"docs/upgrading.md",
			"docs/cloudflare-setup.md",
			"docs/local-development.md",
			"docs/ai-guided-operations.md",
			"docs/privacy.md",
			"docs/click-policy.md",
			"docs/free-plan-traffic.md",
			"docs/privacy-template.md",
		];

		for (const file of files) {
			for (const section of parseMarkdownSections(readDoc(file))) {
				// The migration is what a release boundary is about. A constraints page
				// that names the feature without the migration is describing behavior,
				// not the content of a release, so it is out of scope here.
				if (!/\b0005\b|0005_smart_routing|smart_routing_rules/.test(section.text)) {
					continue;
				}
				const scope = classifySectionScope(section);
				expect(scope, `${file} > ${section.heading} must not scope Smart Routing to the v2.2.1 tag`).not.toBe("published");
				expect(scope, `${file} > ${section.heading} must not scope Smart Routing to the Phase 2 baseline`).not.toBe("phase2");
				expect(
					findCrossVersionAttributionViolations(section.text),
					`${file} > ${section.heading} must not claim 0005 for the v2.2.1 tag`,
				).toEqual([]);
			}
		}
	});

	it("keeps the historical README v2.2.1 upgrade section free of Smart Routing and 0005", () => {
		const readme = readDoc("README.md");
		const published = markdownSection(readme, "## Procedimento histórico: upgrade para a v2.2.1");
		expect(published).not.toBeNull();
		expect(published).not.toMatch(/0005|Smart Routing|smartRouting|smart_routing_rules/i);
	});

	it("keeps the upgrading Phase 2 A/B section free of Phase 3 artifacts", () => {
		const upgrading = readDoc("docs/upgrading.md");
		const section = parseMarkdownSections(upgrading).find((entry) => entry.title.startsWith("Split Test A/B e migration 0004"))!;
		expect(section).toBeTruthy();
		expect(classifySectionScope(section)).toBe("current");
		// The A/B section stays about A/B: Smart Routing belongs to the 0005 section.
		expect(findPhase3Tokens(section.text)).toEqual([]);
		expect(section.body).toMatch(/0004/);
	});

	it("keeps the cloudflare Fluxo A led by the shipped release with a historical v2.2.1 child", () => {
		const setup = readDoc("docs/cloudflare-setup.md");
		const sections = parseMarkdownSections(setup);

		// The leading flow is the shipped release and carries its full chain.
		const fluxoA = markdownSection(setup, "## Fluxo A: Wrangler local (candidata v3.1.1)");
		expect(fluxoA).not.toBeNull();
		expect(fluxoA).toMatch(/dev-prepare/);
		expect(fluxoA).toMatch(/0006/);

		// The previous release stays documented as an explicitly historical child
		// section; the published boundary applies there.
		const historical = sections.find((section) => section.heading === "### Procedimento histórico: checkout da release histórica (v2.2.1)")!;
		expect(historical).toBeTruthy();
		expect(classifySectionScope(historical)).toBe("published");
		expect(findScopeViolations(historical)).toEqual([]);

		const smart = markdownSection(setup, "### Smart Routing e migration 0005 (origem Fase 3)");
		expect(smart).not.toBeNull();
		expect(smart).toMatch(/0005/);
		expect(smart).toMatch(/Smart Routing/i);
	});

	it("keeps the historical upgrading section free of Smart Routing and 0005", () => {
		const upgrading = readDoc("docs/upgrading.md");
		const published = markdownSection(upgrading, "## Procedimento histórico: upgrade para a v2.2.1");
		expect(published).not.toBeNull();
		expect(published).not.toMatch(/0005|Smart Routing/i);

		const current = markdownSection(upgrading, "## Smart Routing e migration 0005 (release 3.0.0)");
		expect(current).not.toBeNull();
		expect(current).toMatch(/0005/);
	});

	it("keeps each migration attributed to its own origin in cloudflare-setup", () => {
		const setup = readDoc("docs/cloudflare-setup.md");
		const lines = setup.split("\n");

		// The previous release's chain ends at 0003, and the historical procedure
		// for that release must not import a later migration.
		const previousEnd = lines.find((line) => line.includes("é a última daquela release"));
		expect(previousEnd).toBeTruthy();
		expect(previousEnd).toContain("0003");

		// Every shipped migration names where it came from and where it shipped.
		const abLine = lines.find((line) => line.includes("`0004_ab_testing.sql` habilita"));
		expect(abLine).toBeTruthy();
		expect(abLine).toMatch(/origem Fase 2/);

		const smartLine = lines.find((line) => line.includes("`0005_smart_routing.sql` habilita"));
		expect(smartLine).toBeTruthy();
		expect(smartLine).toMatch(/origem Fase 3/);

		const expiredLine = lines.find((line) => line.includes("`0006_expired_redirect.sql` habilita"));
		expect(expiredLine).toBeTruthy();
		expect(expiredLine).toMatch(/origem Fase 4/);
		expect(expiredLine).toMatch(/publicadas? na `3\.0\.0`|publicada na `3\.0\.0`/);
	});

	it("keeps the architecture clean-install scope separated", () => {
		const sections = parseMarkdownSections(readDoc("docs/architecture.md"));

		// The main runtime section documents the shipped release and its full chain.
		const currentSection = sections.find((section) => section.heading === "### Migrações e runtime (release 3.0.0)");
		expect(currentSection).toBeTruthy();
		expect(classifySectionScope(currentSection!)).toBe("current");
		expect(currentSection!.text).toContain("`0000` até `0006`");

		// The previous release stays documented as an explicitly historical child
		// section, and the published boundary applies there.
		const historical = sections.find((section) => section.heading === "#### Procedimento histórico: instalação da release histórica (v2.2.1)");
		expect(historical).toBeTruthy();
		expect(classifySectionScope(historical!)).toBe("published");
		expect(findForbiddenTokens(historical!.text)).toEqual([]);

		// Each shipped migration keeps its own origin subsection.
		const smartSection = sections.find((section) => section.heading === "#### Instalação limpa e upgrade com a 0005 (origem Fase 3)");
		expect(smartSection).toBeTruthy();
		expect(findForbiddenTokens(smartSection!.text)).toContain("0005_smart_routing");
	});

	it("never lists Smart Routing under a published v2.2.1 heading", () => {
		const files = [
			"README.md",
			"AI-START.md",
			"AGENTS.md",
			"docs/upgrading.md",
			"docs/cloudflare-setup.md",
			"docs/local-development.md",
			"docs/ai-guided-operations.md",
		];

		for (const file of files) {
			const text = readDoc(file);
			const lines = text.split(/\r?\n/);
			const fenced = fencedCodeMask(lines);
			for (let index = 0; index < lines.length; index += 1) {
				const line = lines[index];
				if (fenced[index] || !/^##\s/.test(line) || !/v2\.2\.1/i.test(line)) {
					continue;
				}
				if (/Unreleased|Fase 3|working tree/i.test(line)) {
					continue;
				}
				let end = lines.length;
				for (let next = index + 1; next < lines.length; next += 1) {
					if (!fenced[next] && /^##\s/.test(lines[next])) {
						end = next;
						break;
					}
				}
				const body = lines.slice(index, end).join("\n");
				expect(body, `${file} published section "${line.trim()}" must not mention Smart Routing/0005`).not.toMatch(/0005|Smart Routing/i);
			}
		}
	});

	/**
	 * The counterpart of the scope scanner for the shipped release: the sections
	 * that document 0004-0006 belong to the current release, so they must not be
	 * framed as upcoming (the pre-3.0.0 wording) nor inherit the historical
	 * v2.2.1 scope of a parent section.
	 */
	it("frames the shipped release as current in README and upgrading", () => {
		for (const file of ["README.md", "docs/upgrading.md"]) {
			const text = readDoc(file);
			expect(text, `${file} must not frame the shipped release as upcoming`).not.toMatch(/pr[óo]xima release|next release/i);
			expect(text, `${file} must not send readers of shipped features to a development branch`).not.toMatch(/branch de desenvolvimento|development branch/i);
			expect(text, `${file} must name the current release`).toMatch(/3\.1\.0/);
		}
	});

	it("keeps every 3.0.0 artifact out of the historical v2.2.1 scope", () => {
		for (const file of ["README.md", "docs/upgrading.md"]) {
			for (const section of parseMarkdownSections(readDoc(file))) {
				if (!/\b000[456]\b|smart_routing_rules|Smart Routing|expired_redirect_url|api\/export|api\/import/.test(section.text)) {
					continue;
				}
				const scope = classifySectionScope(section);
				expect(scope, `${file} > ${section.heading} must not be historical or pre-release`).not.toBe("published");
				expect(scope, `${file} > ${section.heading} must not be historical or pre-release`).not.toBe("unreleased");
			}
		}
	});
});

/**
 * BL-66-01 (Gate 7.2): before the v3.0.0 publication the documentation framed
 * every shipped feature as "Unreleased / Fase N" and described the release as
 * pending ("NOT TAGGED / NOT PUSHED", "Next: GitHub publication"). Gate 6.6
 * initially published the release (tag `v3.0.0` on `60c8575`, push and GitHub Release),
 * which turned those framings into stale current-state claims. The guards below
 * keep the reconciled state checkable: a manifest of current-scope docs that
 * must name the current release, a stale-marker scan with a structural
 * (explicitly-historical section) allowlist, a feature release map, and
 * metadata guards for `package.json`, for the runtime-variable matrix and for
 * the inventoried src/public comments.
 *
 * Gate 7.4 (BL-73-01..04) hardened the same scans without changing what they
 * protect: the historical bypass is an explicit file+heading allowlist instead
 * of any heading containing "histórico" (BL-73-02), the preamble before the
 * first heading is scanned (BL-73-02), feature framing is decided per
 * section/clause with an alias map so one feature's publication cannot
 * sanitize another (BL-73-03), and comment extraction is lexical so strings
 * and templates are never comments (BL-73-04).
 */
describe("Gate 7.2: current-state release documentation guard (BL-66-01)", () => {
	const CURRENT_RELEASE = "3.1.0";
	const CURRENT_TAG = "v3.1.0";

	/**
	 * Append-only histories keep their pre-publication wording on purpose: the
	 * 3.0.0 blocks of CHANGELOG and RELEASE_NOTES legitimately carry phase-origin
	 * markers, and the RELEASE_NOTES work blocks are declared historical records
	 * of the development gates. Everything else is current-scope documentation.
	 */
	const MANIFEST_STRUCTURAL_EXCEPTIONS = new Set(["CHANGELOG.md", "RELEASE_NOTES.md"]);

	const CURRENT_RELEASE_DOC_MANIFEST = collectDocumentationFiles(process.cwd())
		.map((file) => relative(process.cwd(), file))
		.filter((file) => !MANIFEST_STRUCTURAL_EXCEPTIONS.has(file))
		.sort();

	/**
	 * Markers that describe a pre-publication world as if it were the current
	 * one. "Fase N" alone is not here: naming where a feature originated is
	 * lineage, not a release-state claim. The `Unreleased` marker is
	 * case-insensitive (BL-73-03): "UNRELEASED" and "unreleased" are the same
	 * stale claim.
	 */
	const STALE_CURRENT_STATE_MARKERS: Array<{ label: string; pattern: RegExp }> = [
		{ label: "v2.2.1 presented as the published release", pattern: /release\s+publicada(?:\s*\/\s*baseline)?\s*=\s*\*{0,2}\s*`?v2\.2\.1/i },
		{ label: "v2.2.1 presented as the published release", pattern: /release\s+publicada\s+`?v2\.2\.1/i },
		{ label: "publication described as pending", pattern: /NOT\s+TAGGED/i },
		{ label: "publication described as pending", pattern: /NOT\s+PUSHED/i },
		{ label: "publication described as pending", pattern: /Next:\s*GitHub\s+publication/i },
		{ label: "shipped release framed as upcoming", pattern: /pr[óo]xima\s+release/i },
		{ label: "shipped release framed as upcoming", pattern: /next\s+release/i },
		{ label: "shipped feature sent to a development branch", pattern: /branch\s+de\s+desenvolvimento|development\s+branch/i },
		{ label: "checkout described as the working tree", pattern: /(?:working\s+tree|working-tree)\s+atual|esta\s+working\s+tree/i },
		{ label: "shipped feature framed as unreleased", pattern: /\bunreleased\b/i },
	];

	/**
	 * BL-73-02: the historical bypass is an explicit allowlist of file +
	 * controlled heading — never a keyword. The sanctioned shapes are the
	 * "Procedimento histórico:"/"Referência histórica:" procedure headings in
	 * the real docs (each a frozen record of how an older release was
	 * operated), plus retention's single exact legacy-bases heading.
	 * CHANGELOG.md and RELEASE_NOTES.md are covered by their own rule: they
	 * are append-only histories and sit outside the current-scope manifest
	 * (`MANIFEST_STRUCTURAL_EXCEPTIONS`). A heading that merely contains
	 * "histórico" — "Estado atual (contexto histórico)" — is NOT historical.
	 */
	const HISTORICAL_HEADING_ALLOWLIST: Array<{ file: string; title: RegExp }> = [
		{ file: "README.md", title: /^Procedimento histórico:/ },
		{ file: "docs/upgrading.md", title: /^Procedimento histórico:/ },
		{ file: "docs/cloudflare-setup.md", title: /^Procedimento histórico:/ },
		{ file: "docs/architecture.md", title: /^Procedimento histórico:/ },
		{ file: "docs/local-development.md", title: /^Referência histórica:/ },
		{ file: "docs/retention.md", title: /^Bases anteriores à migration 0004 \(histórico\)$/ },
	];

	/** A section whose own heading or an ancestor is allowlisted as historical for this file. */
	function isHistoricalSection(file: string, section: MarkdownSection): boolean {
		return HISTORICAL_HEADING_ALLOWLIST.some(
			(entry) =>
				entry.file === file &&
				(entry.title.test(section.title) || section.ancestors.some((ancestor) => entry.title.test(ancestor.title))),
		);
	}

	/** Stale current-state markers of one document, skipping allowlisted historical sections. */
	function staleCurrentStateViolationsIn(file: string, markdown: string): string[] {
		const sections = parseMarkdownSections(markdown);
		const violations: string[] = [];
		for (const section of sections) {
			if (isHistoricalSection(file, section)) {
				continue;
			}
			// `text` includes the heading: a stale claim can be the section title
			// itself ("## QR Code (Unreleased / Fase 5)"), not only body prose.
			const lines = section.text.split(/\r?\n/);
			const fenced = fencedCodeMask(lines);
			for (let index = 0; index < lines.length; index += 1) {
				if (fenced[index]) {
					continue;
				}
				for (const marker of STALE_CURRENT_STATE_MARKERS) {
					if (marker.pattern.test(lines[index])) {
						violations.push(`${file} > ${section.heading} [${marker.label}]: ${lines[index].trim()}`);
					}
				}
			}
		}
		return violations;
	}

	function findStaleCurrentStateViolations(file: string): string[] {
		return staleCurrentStateViolationsIn(file, readDoc(file));
	}

	/**
	 * The feature release map (BL-73-03): every artifact the 3.0.0 release
	 * shipped, paired with the release that contains it, with the aliases the
	 * docs actually use — PT and EN, column names, migration numbers and file
	 * identifiers. A clause that names one of these features together with an
	 * unreleased/local-only qualifier contradicts the map.
	 */
	const FEATURE_RELEASE_MAP: Array<{ label: string; pattern: RegExp; shippedIn: string }> = [
		{ label: "0004 / Split Test A/B", pattern: /\b0004\b|0004_ab_testing|split\s*test\s*a\/b|a\/b\s*test(?:ing)?|\bab_enabled\b|\bab_target_url\b/i, shippedIn: CURRENT_RELEASE },
		{ label: "0005 / Smart Routing", pattern: /\b0005\b|0005_smart_routing|smart[\s-]?routing|smart_routing_rules|smartRoutingRules/i, shippedIn: CURRENT_RELEASE },
		{ label: "0006 / destino de expiração", pattern: /\b0006\b|0006_expired_redirect|expired_redirect_url|expiredRedirectUrl|expired\s+redirect|destino\s+de\s+expira[çc][ãa]o/i, shippedIn: CURRENT_RELEASE },
		{ label: "ROOT_REDIRECT_URL / redirect da raiz", pattern: /ROOT_REDIRECT_URL|root\s+redirect|redirect\s+da\s+raiz/i, shippedIn: CURRENT_RELEASE },
		{ label: "hierarquia de grupos", pattern: /group[\s-]?hierarchy|hierarquia\s+de\s+grupos|\bgrupos\b|\bGroups\b|\bparent_id\b/i, shippedIn: CURRENT_RELEASE },
		{ label: "portabilidade", pattern: /api\/export|api\/import|boltlink-portability|portabilidade|\bportability\b|export\s+(?:configuration|configura[çc][ãa]o)|import\s+(?:configuration|configura[çc][ãa]o)/i, shippedIn: CURRENT_RELEASE },
		{ label: "QR / PNG / SVG", pattern: /\bqr\b|qr\s*code|\bqrcode\b|PNG\/SVG|download\s+(?:PNG|SVG)|di[áa]logo\s+de\s+QR/i, shippedIn: CURRENT_RELEASE },
	];

	/**
	 * Stale qualifiers, case-insensitive (BL-73-03): "UNRELEASED", "unreleased",
	 * "local only", "somente local", "branch de desenvolvimento" and "working
	 * tree" all frame a shipped feature as not yet published.
	 */
	const UNRELEASED_QUALIFIER_PATTERN =
		/\bunreleased\b|n[ãa]o\s+publicad|local[-\s]only|somente\s+local|pr[óo]xima\s+release|branch\s+de\s+desenvolvimento|development\s+branch|\bworking\s+tree\b/i;

	/**
	 * The sanctioned refutation: the docs deny the qualifier in the same breath
	 * ("não são experimentais nem local-only", "not local-only"). A qualifier
	 * the sentence itself rejects is not framing.
	 */
	const REFUTED_UNRELEASED_PATTERN =
		/n[ãa]o\s+s[ãa]o?\s+[^,;]{0,60}?\s(?:e|nem)\s+(?:local[-\s]only|unreleased|experimental)|n[ãa]o\s+(?:s[ãa]o?|é|e)\s+(?:experimental|unreleased|local[-\s]only)|not\s+(?:experimental|unreleased|local[-\s]only)/i;

	/**
	 * Claim-sized fragments of a section for the framing scan: paragraphs join
	 * their soft-wrapped lines, structural lines (headings, bullets, table
	 * rows) stand alone, and sentence/semicolon ends split each block. Fenced
	 * code never yields a fragment — it is documentation example, not prose.
	 */
	function framingFragments(text: string): string[] {
		const lines = text.split(/\r?\n/);
		const fenced = fencedCodeMask(lines);
		const fragments: string[] = [];
		let paragraph: string[] = [];
		const flushParagraph = () => {
			if (paragraph.length > 0) {
				fragments.push(...paragraph.join(" ").split(/(?<=[.;!?])\s+/));
				paragraph = [];
			}
		};
		for (let index = 0; index < lines.length; index += 1) {
			if (fenced[index]) {
				flushParagraph();
				continue;
			}
			const line = lines[index];
			if (line.trim().length === 0 || STRUCTURAL_LINE_PATTERN.test(line)) {
				flushParagraph();
				if (line.trim().length > 0) {
					fragments.push(...line.trim().split(/(?<=[.;!?])\s+/));
				}
				continue;
			}
			paragraph.push(line.trim());
		}
		flushParagraph();
		return fragments.map((fragment) => fragment.trim()).filter((fragment) => fragment.length > 0);
	}

	/**
	 * BL-73-03: framing is decided per clause, never per line. A fragment that
	 * carries an unreleased qualifier flags every feature the SAME fragment
	 * names — publication of `ROOT_REDIRECT_URL` in one clause does not
	 * sanitize Smart Routing in another, and a bare publication statement
	 * elsewhere on the line rescues nothing. A feature named in the section
	 * heading is framed by any stale qualifier in that section's body: the
	 * heading and its body are one claim.
	 */
	function featureFramingViolationsIn(file: string, markdown: string): string[] {
		const violations: string[] = [];
		for (const section of parseMarkdownSections(markdown)) {
			if (isHistoricalSection(file, section)) {
				continue;
			}
			for (const fragment of framingFragments(section.text)) {
				if (!UNRELEASED_QUALIFIER_PATTERN.test(fragment) || REFUTED_UNRELEASED_PATTERN.test(fragment)) {
					continue;
				}
				for (const feature of FEATURE_RELEASE_MAP.filter((entry) => entry.pattern.test(fragment))) {
					violations.push(
						`${file} > ${section.heading}: ${feature.label} framed as unreleased (shipped in ${feature.shippedIn}): ${fragment}`,
					);
				}
			}
			const headingFeatures = FEATURE_RELEASE_MAP.filter((feature) => feature.pattern.test(section.title));
			if (headingFeatures.length === 0) {
				continue;
			}
			const bodyLines = section.body.split(/\r?\n/);
			const fenced = fencedCodeMask(bodyLines);
			for (let index = 0; index < bodyLines.length; index += 1) {
				const line = bodyLines[index];
				if (fenced[index] || !UNRELEASED_QUALIFIER_PATTERN.test(line) || REFUTED_UNRELEASED_PATTERN.test(line)) {
					continue;
				}
				for (const feature of headingFeatures) {
					violations.push(
						`${file} > ${section.heading}: ${feature.label} framed as unreleased via section body: ${line.trim()}`,
					);
				}
			}
		}
		return violations;
	}

	function findFeatureFramingViolations(file: string): string[] {
		return featureFramingViolationsIn(file, readDoc(file));
	}

	/**
	 * BL-77-01: a versioned document cannot stably name its own release commit:
	 * committing a SHA correction changes that SHA again. Identity is version,
	 * tag and published state. main SHA == tag v3.0.0 SHA is an external
	 * publication invariant, checked through Git/GitHub API in the publication
	 * gate and post-publication audit, never through versioned text.
	 *
	 * Scan claim-sized fragments, including soft wraps and current headings.
	 * BL-79-01: the historical exception is clause-local, never fragment-wide. A
	 * fragment can hold several independent claims, so it is split before
	 * classification — a history marker in one claim cannot sanitize the next.
	 */
	const CLAIM_SEPARATOR_PATTERN =
		/\s*[,;]?\s*\b(?:mas|por[ée]m|contudo|entretanto|todavia|but|however|while)\b\s*|\s*;\s*/i;

	function currentReleaseShaViolationsIn(file: string, markdown: string): string[] {
		// Current-state scope: the release/tag a reader is in now, plus the
		// markers that flip an otherwise historical sentence to the present
		// ("hoje", "now"). A marker alone is not a violation; it only scopes a
		// claim that also names a SHA as current-state.
		const currentState =
			/release\s+(?:atual|publicada(?:\s+atual)?)|current\s+(?:published\s+)?(?:release|tag)|tag\s+atual|\bhoje\b|\batualmente\b|\bagora\b|\btoday\b|\bcurrently\b|\bnow\b/i;
		// A claim that points at the current tag/branch, in PT or EN.
		const releaseTarget = /tag\s+v3\.(?:0|1)\.0|v3\.(?:0|1)\.0\s+tag|publicada\s+sobre|published\s+(?:on|at)|\bmain\b/i;
		const historicalEvent =
			/publica[çc][ãa]o\s+inicial|initial\s+publication|\binicialmente\b|\binitially\b|gate\s+hist[óo]rico\s+usou|gate\s+\d+(?:\.\d+)+[a-z]?\s+(?:finalizou|produziu|usou)|na\s+[ée]poca|historicamente|historical\s+gate|^Os checkpoints hist[óo]ricos de desenvolvimento aplicavam cadeias mais curtas/i;
		// A historical checkpoint list only excuses inherited heading context,
		// never an explicit tag/main target in that same claim.
		const historicalCheckpoint = /^Os checkpoints hist[óo]ricos de desenvolvimento/i;
		const violations: string[] = [];
		for (const section of parseMarkdownSections(markdown)) {
			const currentHeading = [section.title, ...section.ancestors.map((ancestor) => ancestor.title)]
				.some((title) => currentState.test(title.replace(/[`*]/g, "")));
			for (const fragment of framingFragments(section.text)) {
				for (const clause of fragment.split(CLAIM_SEPARATOR_PATTERN)) {
					const claim = clause.replace(/[`*]/g, "");
					if (!/\b[0-9a-f]{7,40}\b/i.test(claim)) {
						continue;
					}
					const historical = historicalEvent.test(claim);
					if (currentState.test(claim) || (releaseTarget.test(claim) && (!historical || historicalCheckpoint.test(claim))) ||
						(currentHeading && !historical)) {
						violations.push(`${file} > ${section.heading}: current release SHA literal: ${clause.trim()}`);
					}
				}
			}
		}
		return violations;
	}

	it("manifests every current-scope documentation file and names the current release", () => {
		// The manifest is structural: root docs plus docs/, minus the append-only
		// histories, and it must keep covering the BL-66-01 surfaces.
		expect(CURRENT_RELEASE_DOC_MANIFEST).toEqual(expect.arrayContaining([
			"README.md",
			"AGENTS.md",
			"AI-START.md",
			"PRODUCT.md",
			"DESIGN.md",
			"SECURITY.md",
			"CONTRIBUTING.md",
			"docs/upgrading.md",
			"docs/cloudflare-setup.md",
			"docs/local-development.md",
			"docs/ai-guided-operations.md",
			"docs/ai-accepted-requests.md",
		]));
		expect(CURRENT_RELEASE_DOC_MANIFEST).not.toContain("CHANGELOG.md");
		expect(CURRENT_RELEASE_DOC_MANIFEST).not.toContain("RELEASE_NOTES.md");

		for (const file of CURRENT_RELEASE_DOC_MANIFEST) {
			expect(readDoc(file), `${file} must name the current release`).toMatch(/3\.1\.0/);
		}
	});

	it("keeps stale pre-publication state markers out of current-scope docs", () => {
		const violations = CURRENT_RELEASE_DOC_MANIFEST.flatMap((file) => findStaleCurrentStateViolations(file));
		expect(violations, violations.join("\n")).toEqual([]);
	});

	it("never frames a 3.0.0 feature as unreleased in current-scope docs", () => {
		const violations = CURRENT_RELEASE_DOC_MANIFEST.flatMap((file) => findFeatureFramingViolations(file));
		expect(violations, violations.join("\n")).toEqual([]);
	});

	it("keeps AGENTS.md and AI-START.md on the published post-Gate-6.6 state", () => {
		for (const file of ["AGENTS.md", "AI-START.md"]) {
			const text = readDoc(file);
			const identity = framingFragments(text).map((fragment) => fragment.replace(/[`*]/g, ""))
				.find((fragment) => /release\s+atual\s+publicada/i.test(fragment) && fragment.includes(CURRENT_RELEASE) && fragment.includes(CURRENT_TAG));
			expect(identity, `${file} must identify the current published release and tag`).toBeDefined();
				expect(identity, `${file} must identify the current branch`).toMatch(/branch\s+main/i);
				expect(text, `${file} must describe tag/main equality as externally verified`).toMatch(/tag publicada e `main` devem convergir[^.]+verificado externamente por Git\/GitHub API/);
			expect(text, `${file} must record Gate 6.6 as passed`).toMatch(/Gate\s+6\.6[^.\n]*PASSED/);
			expect(text, `${file} must record Phase 6 as complete`).toMatch(/Phase 6[^.\n]*COMPLETE/);
			expect(text, `${file} must not describe the release as pending`).not.toMatch(/NOT\s+TAGGED|NOT\s+PUSHED|Next:\s*GitHub\s+publication/);
		}
	});

	it("keeps current release SHA literals out of current-scope documentation (BL-77-01)", () => {
		const violations = CURRENT_RELEASE_DOC_MANIFEST.flatMap((file) => currentReleaseShaViolationsIn(file, readDoc(file)));
		expect(violations, violations.join("\n")).toEqual([]);
	});

	it.each([
		"Release atual publicada:\nv3.0.0, commit 3d98f13.",
		"Release atual v3.0.0, commit deadbee",
		"tag v3.0.0 -> 3d98f13",
		"tag `v3.0.0` → `60c8575`",
		"Release publicada sobre abc1234.",
		"## Release atual publicada\nCommit: abc1234",
		"## Release atual publicada\n### Target\nCommit: 0123456789abcdef0123456789abcdef01234567",
		"Gate histórico usou commit deadbee; Release atual v3.0.0, commit abc1234.",
		"## Estado atual (contexto histórico)\ntag v3.0.0 -> abc1234",
		"Na publicação inicial, Gate 6.6 usou o commit deadbee. tag v3.0.0 -> abc1234",
		"Os checkpoints históricos de desenvolvimento aplicavam cadeias mais curtas, tag v3.0.0 -> abc1234",
		"A release publicada está no commit deadbee.",
		"Current release commit: deadbee.",
		// BL-79-01: the historical exception is clause-local, so a valid
		// historical claim never sanitizes a current claim in the same fragment.
		"A publicação inicial usou commit cafe123,\nmas hoje tag v3.0.0 -> deadbee.",
		"Gate 6.6 publicou inicialmente no commit cafe123,\nporém a release atual v3.0.0 está no commit deadbee.",
		"A publicação inicial usou commit cafe123;\ntag v3.0.0 -> deadbee.",
		"The initial publication used commit cafe123,\nbut the current v3.0.0 tag points to deadbee.",
		"Hoje tag v3.0.0 -> deadbee,\nmas a publicação inicial usou commit cafe123.",
	])("rejects a current release SHA claim: %s (BL-77-01)", (fixture) => {
		expect(currentReleaseShaViolationsIn("AGENTS.md", fixture)).not.toEqual([]);
	});

	it.each([
		"Na publicação inicial, Gate 6.6 usou o commit 60c8575.",
		"Gate 6.5B finalizou metadata no commit 60c8575.",
		"Gate histórico usou commit deadbee",
		"Na publicação inicial, a tag v3.0.0 foi criada sobre 60c8575.",
		"## Release atual publicada\nNa publicação inicial, Gate 6.6 usou o commit 60c8575.",
		"Release atual publicada: 3.0.0, tag v3.0.0, branch main. Gate histórico usou commit deadbee.",
		"## Fluxo rápido (release atual v3.0.0)\nOs checkpoints históricos de desenvolvimento aplicavam cadeias mais curtas: a Fase 2 (23353a1) parava na 0004.",
		// BL-79-01: a pure historical claim stays legal, and a current claim
		// without a SHA names no commit, so it is out of this scanner's scope.
		"A publicação inicial usou commit cafe123.",
		"Gate 6.5B produziu o commit cafe123.",
		"Na publicação inicial,\na tag foi criada no commit cafe123.",
		"A release atual é v3.0.0.",
		"A tag atual é v3.0.0.",
		"A release está publicada.",
		"main e v3.0.0 devem convergir,\nverificados externamente.",
	])("accepts an explicit historical SHA claim: %s (BL-77-01)", (fixture) => {
		expect(currentReleaseShaViolationsIn("AI-START.md", fixture)).toEqual([]);
	});

	it("isolates the historical exception to the clause that carries it (BL-79-01)", () => {
		const mixed = currentReleaseShaViolationsIn(
			"AGENTS.md",
			"A publicação inicial usou commit cafe123,\nmas hoje tag v3.0.0 -> deadbee.",
		);
		expect(mixed).toHaveLength(1);
		// The violation is the current clause, not the historical one.
		expect(mixed[0]).toContain("tag v3.0.0 -> deadbee");
		expect(mixed[0]).not.toContain("publicação inicial");
	});

	it("does not let an allowlisted historical section mask an explicit current clause (BL-79-01)", () => {
		const fixture = [
			"# Doc",
			"## Procedimento histórico: v2.2.1",
			"Na época a tag apontava para cafe123,",
			"mas hoje a tag v3.0.0 aponta para deadbee.",
		].join("\n");

		const violations = currentReleaseShaViolationsIn("docs/upgrading.md", fixture);

		expect(violations).toHaveLength(1);
		expect(violations[0]).toContain("hoje a tag v3.0.0 aponta para deadbee");
	});

	it("does not let a 'contexto histórico' heading release a current clause (BL-79-01 / BL-73-02)", () => {
		const fixture = [
			"# Doc",
			"## Estado atual (contexto histórico)",
			"A publicação inicial usou commit cafe123,",
			"mas hoje tag v3.0.0 -> deadbee.",
		].join("\n");

		const violations = currentReleaseShaViolationsIn("AGENTS.md", fixture);

		expect(violations.some((entry) => entry.includes("tag v3.0.0 -> deadbee"))).toBe(true);
	});

	/**
	 * Supersedes the Gate 7.2 fixture (generic "histórico" keyword bypass):
	 * under the BL-73-02 allowlist a "Registro histórico" heading that is not
	 * in the file+heading allowlist is NOT historical, so its pre-publication
	 * wording is a violation like any other.
	 */
	it("flags pre-publication state claims outside allowlisted historical sections", () => {
		const fixture = [
			"# Doc",
			"## Status",
			"Estado da release: **NOT TAGGED / NOT PUSHED**. Next: GitHub publication.",
			"",
			"## Smart Routing (Unreleased / Fase 3)",
			"Escopo: release publicada = **v2.2.1**. Feature da branch de desenvolvimento.",
			"",
			"## Registro histórico",
			"A release já foi descrita como NOT TAGGED aqui; o bloco é histórico.",
		].join("\n");

		const violations = staleCurrentStateViolationsIn("docs/fixture.md", fixture);

		expect(violations.some((entry) => entry.includes("Status") && entry.includes("publication described as pending"))).toBe(true);
		expect(violations.some((entry) => entry.includes("Smart Routing (Unreleased / Fase 3)") && entry.includes("shipped feature framed as unreleased"))).toBe(true);
		expect(violations.some((entry) => entry.includes("Smart Routing (Unreleased / Fase 3)") && entry.includes("v2.2.1 presented as the published release"))).toBe(true);
		expect(violations.some((entry) => entry.includes("Smart Routing (Unreleased / Fase 3)") && entry.includes("shipped feature sent to a development branch"))).toBe(true);
		// The keyword-only heading no longer bypasses: its stale wording is flagged.
		expect(violations.some((entry) => entry.includes("Registro histórico"))).toBe(true);
	});

	it("rejects a generic 'histórico' heading as a historical bypass (BL-73-02)", () => {
		const contextFixture = [
			"# Doc",
			"## Estado atual (contexto histórico)",
			"Smart Routing (Unreleased / Fase 3)",
			"",
			"## Estado corrente — histórico operacional",
			"NOT TAGGED / NOT PUSHED",
			"",
			"## Situação histórica atual",
			"Next: GitHub publication",
		].join("\n");

		const violations = staleCurrentStateViolationsIn("docs/fixture.md", contextFixture);
		expect(violations.some((entry) => entry.includes("Estado atual (contexto histórico)"))).toBe(true);
		expect(violations.some((entry) => entry.includes("Estado corrente — histórico operacional"))).toBe(true);
		expect(violations.some((entry) => entry.includes("Situação histórica atual"))).toBe(true);
	});

	it("keeps allowlisted historical procedure sections accepted, scoped to their file (BL-73-02)", () => {
		const historicalFixture = [
			"# Doc",
			"## Procedimento histórico: upgrade para a v2.2.1",
			"Estado antigo da publicação: NOT TAGGED / NOT PUSHED.",
		].join("\n");

		// In the file the allowlist names, the frozen historical record is legal…
		expect(staleCurrentStateViolationsIn("docs/upgrading.md", historicalFixture)).toEqual([]);
		// …and the same heading in any other document is not.
		expect(staleCurrentStateViolationsIn("docs/outro.md", historicalFixture).length).toBeGreaterThan(0);
	});

	it("scans the preamble before the first heading (BL-73-02)", () => {
		const stalePreamble = "Smart Routing (Unreleased / Fase 3)\n\n# BoltLink\n";
		const violations = staleCurrentStateViolationsIn("docs/fixture.md", stalePreamble);
		expect(violations.length).toBeGreaterThan(0);
		expect(violations[0]).toContain(PREAMBLE_SECTION_TITLE);

		// A neutral preamble is not a violation, and documents are not required
		// to open with a heading.
		expect(staleCurrentStateViolationsIn("docs/fixture.md", "Texto introdutório neutro.\n\n# BoltLink\n")).toEqual([]);
	});

	it("flags a shipped feature named next to an unreleased qualifier", () => {
		const fixture = [
			"# Doc",
			"## Release atual",
			"Smart Routing (Unreleased) pertence à próxima release.",
			"Split Test A/B (não publicado) fica em uma branch de desenvolvimento.",
		].join("\n");
		const violations = featureFramingViolationsIn("docs/fixture.md", fixture);
		expect(violations.some((entry) => entry.includes("0005 / Smart Routing"))).toBe(true);
		expect(violations.some((entry) => entry.includes("0004 / Split Test A/B"))).toBe(true);
	});

	it("binds a publication qualifier to the feature it publishes, not the whole line (BL-73-03)", () => {
		const fixture = [
			"# Doc",
			"## Release atual",
			"Smart Routing não publicado; ROOT_REDIRECT_URL publicado na 3.0.0.",
		].join("\n");
		const violations = featureFramingViolationsIn("docs/fixture.md", fixture);
		expect(violations.some((entry) => entry.includes("0005 / Smart Routing"))).toBe(true);
		expect(violations.some((entry) => entry.includes("ROOT_REDIRECT_URL / redirect da raiz"))).toBe(false);
	});

	it("flags a feature framed by its own section body (BL-73-03)", () => {
		const abFixture = "# Doc\n\n## Split Test A/B\n\nDisponível somente local-only.\n";
		expect(featureFramingViolationsIn("docs/fixture.md", abFixture).some((entry) => entry.includes("0004 / Split Test A/B"))).toBe(true);

		const smartFixture = "# Doc\n\n## Smart Routing\n\nAinda não publicado.\n";
		expect(featureFramingViolationsIn("docs/fixture.md", smartFixture).some((entry) => entry.includes("0005 / Smart Routing"))).toBe(true);
	});

	it("reports every feature of a multi-feature stale claim, case-insensitive (BL-73-03)", () => {
		const fixture = "# Doc\n\n## Grupos\n\nGroups e QR: unreleased.\n";
		const violations = featureFramingViolationsIn("docs/fixture.md", fixture);
		expect(violations.some((entry) => entry.includes("hierarquia de grupos"))).toBe(true);
		expect(violations.some((entry) => entry.includes("QR / PNG / SVG"))).toBe(true);

		const shoutingFixture = "# Doc\n\n## Release atual\n\nO SMART ROUTING está UNRELEASED.\n";
		expect(featureFramingViolationsIn("docs/fixture.md", shoutingFixture).some((entry) => entry.includes("0005 / Smart Routing"))).toBe(true);
	});

	it("keeps sanctioned published-origin framings legal (BL-73-03)", () => {
		const fixture = [
			"# Doc",
			"## Release atual",
			"Smart Routing foi publicado na v3.0.0.",
			"ROOT_REDIRECT_URL foi introduzido na v3.0.0.",
			"Groups e QR foram publicados na v3.0.0.",
			"A tag anterior v2.2.1 não contém Smart Routing.",
			"Smart Routing foi originalmente desenvolvido na Fase 3 e publicado na v3.0.0.",
			"Os recursos da Fase 5 estão publicados na 3.0.0 — não são experimentais nem local-only.",
		].join("\n");
		expect(featureFramingViolationsIn("docs/fixture.md", fixture)).toEqual([]);
	});

	/** The package.json Cloudflare descriptions must not be release-state stale. */
	function packageMetadataViolations(bindings: Record<string, unknown>): string[] {
		const violations: string[] = [];
		for (const [name, value] of Object.entries(bindings)) {
			const description = String((value as { description?: string })?.description ?? "");
			if (/unreleased|development[- ]only|future\s+release|pr[óo]xima\s+release/i.test(description)) {
				violations.push(`${name}: description frames content as unreleased`);
			}
		}
		return violations;
	}

	it("keeps package.json Cloudflare metadata reconciled with the shipped release", () => {
		const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as {
			cloudflare?: { bindings?: Record<string, unknown> };
		};
		const bindings = pkg.cloudflare?.bindings ?? {};
		expect(packageMetadataViolations(bindings), "package.json descriptions must not frame shipped features as unreleased").toEqual([]);

		// The mandatory case: ROOT_REDIRECT_URL keeps its operational semantics
		// without any release qualifier.
		const rootRedirect = String((bindings.ROOT_REDIRECT_URL as { description?: string })?.description ?? "");
		expect(rootRedirect).toMatch(/optional/i);
		expect(rootRedirect).toMatch(/non-secret/);
		expect(rootRedirect).toMatch(/302/);
		expect(rootRedirect).toMatch(/no-store/);
		expect(rootRedirect).toMatch(/landing/);
		expect(rootRedirect).toMatch(/dashboard|wrangler\.local\.jsonc/);
	});

	it("flags stale package metadata (negative control)", () => {
		const violations = packageMetadataViolations({
			ROOT_REDIRECT_URL: { description: "Optional, non-secret operational variable (Unreleased / Phase 4). GET / answers 302." },
			FUTURE_THING: { description: "development-only flag for a future release" },
			CLEAN: { description: "Optional secret for internal API automation only." },
		});
		expect(violations).toContain("ROOT_REDIRECT_URL: description frames content as unreleased");
		expect(violations).toContain("FUTURE_THING: description frames content as unreleased");
		expect(violations).not.toContain("CLEAN: description frames content as unreleased");
	});

	/**
	 * Comment drift guard: the inventory is the explicit list of src/public
	 * files the reconciliation touched. Comment lines only — functional strings
	 * are deliberately not scanned.
	 */
	const COMMENT_DRIFT_FILES = [
		"src/group-hierarchy.ts",
		"src/index.ts",
		"src/portability.ts",
		"src/portability-import.ts",
		"public/group-hierarchy-ui.js",
		"public/portability-ui.js",
		"public/portability-import-ui.js",
		"public/admin.js",
		"public/admin.css",
		"public/admin.html",
	];

	const STALE_COMMENT_PATTERN = /\bUnreleased\b|working\s+tree\s+atual|esta\s+working\s+tree|pr[óo]xima\s+release|branch\s+de\s+desenvolvimento|NOT\s+TAGGED|NOT\s+PUSHED/i;

	/**
	 * BL-73-04: comment extraction is lexical, never line-prefix-based. The
	 * TypeScript scanner (already a devDependency) separates trivia from code
	 * for .ts/.js — string, template and regex literals are tokens, so their
	 * contents are never comments — while CSS and HTML get small deterministic
	 * state machines that honor quoted strings and real comment delimiters.
	 */
	function tsJsCommentTexts(source: string): string[] {
		const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source);
		const comments: string[] = [];
		let token = scanner.scan();
		while (token !== ts.SyntaxKind.EndOfFileToken) {
			if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) {
				comments.push(scanner.getTokenText());
			}
			token = scanner.scan();
		}
		return comments;
	}

	function cssCommentTexts(source: string): string[] {
		const comments: string[] = [];
		let index = 0;
		let quote: string | null = null;
		while (index < source.length) {
			const char = source[index];
			if (quote) {
				if (char === "\\") {
					index += 2;
					continue;
				}
				if (char === quote) {
					quote = null;
				}
				index += 1;
				continue;
			}
			if (char === '"' || char === "'") {
				quote = char;
				index += 1;
				continue;
			}
			if (char === "/" && source[index + 1] === "*") {
				const end = source.indexOf("*/", index + 2);
				const stop = end === -1 ? source.length : end + 2;
				comments.push(source.slice(index, stop));
				index = stop;
				continue;
			}
			index += 1;
		}
		return comments;
	}

	function htmlCommentTexts(source: string): string[] {
		const comments: string[] = [];
		let index = 0;
		while (index < source.length) {
			const open = source.indexOf("<!--", index);
			if (open === -1) {
				break;
			}
			const end = source.indexOf("-->", open + 4);
			const stop = end === -1 ? source.length : end + 3;
			comments.push(source.slice(open, stop));
			index = stop;
		}
		return comments;
	}

	function extractComments(source: string, file: string): string[] {
		if (file.endsWith(".html")) {
			return htmlCommentTexts(source);
		}
		if (file.endsWith(".css")) {
			return cssCommentTexts(source);
		}
		return tsJsCommentTexts(source);
	}

	it("keeps inventoried src/public comments free of stale release framing", () => {
		for (const file of COMMENT_DRIFT_FILES) {
			const comments = extractComments(readFileSync(resolve(process.cwd(), file), "utf8"), file);
			expect(comments.length, `${file} must still have comments to guard`).toBeGreaterThan(0);
			for (const comment of comments) {
				expect(comment.trim(), `${file} comment carries stale release framing`).not.toMatch(STALE_COMMENT_PATTERN);
			}
		}
	});

	/**
	 * Supersedes the Gate 7.2 negative control (one block comment and one
	 * line-prefixed `//`): the BL-73-04 battery proves real comments are
	 * detected wherever they sit and that strings, templates and regexes never
	 * masquerade as comments.
	 */
	it("detects stale framing in real comments and only in comments (BL-73-04)", () => {
		const tsSource = [
			"const x = 1; // Unreleased / Phase 5",
			"const masked = \"// Unreleased / Phase 5\";",
			"const templated = `",
			" // Unreleased / Phase 5",
			"`;",
			"const blockString = \"/* Unreleased / Phase 5 */\";",
			"const regex = /\\/\\/ Unreleased/;",
			"/*",
			"Unreleased / Phase 5",
			"*/",
			"const y = 2;",
			"/*",
			"  qualquer linha",
			"  Unreleased / Phase 5",
			"*/",
			"// published in 3.0.0; origin Phase 5",
		].join("\n");
		const tsComments = tsJsCommentTexts(tsSource);
		expect(tsComments.join("\\n")).toContain("// Unreleased / Phase 5");
		expect(tsComments.join("\\n")).toContain("/*\nUnreleased / Phase 5\n*/");
		expect(tsComments.join("\\n")).toContain("qualquer linha\n  Unreleased / Phase 5");
		const tsStale = tsComments.filter((comment) => STALE_COMMENT_PATTERN.test(comment));
		expect(tsStale.length, `expected exactly the 3 real comments to be stale: ${tsComments.join("\\n")}`).toBe(3);
		expect(tsComments.some((comment) => comment.includes("masked") || comment.includes("templated") || comment.includes("blockString") || comment.includes("regex"))).toBe(false);
		expect(tsComments.some((comment) => comment.includes("published in 3.0.0"))).toBe(true);

		const cssComments = cssCommentTexts([
			".rule { content: \"/* Unreleased / Phase 5 */\"; color: red; }",
			"/* Unreleased / Phase 5 */",
			".other { background: url(\"data:image/svg+xml;utf8,<svg></svg>\"); }",
		].join("\n"));
		expect(cssComments.length).toBe(1);
		expect(cssComments[0]).toMatch(STALE_COMMENT_PATTERN);

		const htmlComments = htmlCommentTexts([
			"<div>// Unreleased / Phase 5</div>",
			"<!-- Unreleased / Phase 5 -->",
		].join("\n"));
		expect(htmlComments.length).toBe(1);
		expect(htmlComments[0]).toMatch(STALE_COMMENT_PATTERN);
	});

	/**
	 * Runtime variable matrix: the upgrade must answer "do I need a new
	 * variable?" with "no globally-required one", and the six variables must be
	 * documented with their required-ness. Wording is not pinned; the semantics
	 * of each row are.
	 */
	it("documents the runtime variable matrix in README and upgrading", () => {
		const readmeSection = parseMarkdownSections(readDoc("README.md")).find((section) => /^Runtime Variables/i.test(section.title))!;
		expect(readmeSection).toBeTruthy();
		const readmeMatrix = readmeSection.body;

		const upgradingSection = parseMarkdownSections(readDoc("docs/upgrading.md")).find((section) => section.title.startsWith("Upgrade para a versão 3.0.0"))!;
		expect(upgradingSection).toBeTruthy();
		const upgradingMatrix = upgradingSection.body;

		const variableSemantics: Array<{ name: RegExp; expectation: RegExp }> = [
			{ name: /TEAM_DOMAIN/, expectation: /Access/i },
			{ name: /POLICY_AUD/, expectation: /Access/i },
			{ name: /APP_TIMEZONE/, expectation: /opcional|default|fallback/i },
			{ name: /PASSWORD_SESSION_SECRET/, expectation: /senha/ },
			{ name: /API_KEY/, expectation: /opcional|automa/i },
			{ name: /ROOT_REDIRECT_URL/, expectation: /opcional/i },
		];

		for (const { name, expectation } of variableSemantics) {
			for (const [file, matrix] of [["README.md", readmeMatrix], ["docs/upgrading.md", upgradingMatrix]] as const) {
				// Anchored on the table-row opening so the PASSWORD_SESSION_SECRET
				// row (which mentions `API_KEY` in passing) cannot answer for it.
				const rowPattern = new RegExp(`^\\s*\\|\\s*\`${name.source}\``);
				const line = matrix.split("\n").find((entry) => rowPattern.test(entry));
				expect(line, `${file} must list ${name.source} in the runtime variable matrix`).toBeTruthy();
				expect(line, `${file} ${name.source} row must state its required-ness`).toMatch(expectation);
			}
		}

		// ROOT_REDIRECT_URL is the only new variable, and it is optional.
		const rootLine = readmeMatrix.split("\n").find((entry) => /ROOT_REDIRECT_URL/.test(entry))!;
		expect(rootLine).toMatch(/\bsim\b|\bnovo\b|NEW/i);

		// The headline claim: no new globally-required variable for the upgrade.
		const NO_NEW_REQUIRED_VARIABLE_CLAIM = /(?:nenhum|nenhuma|n[ãa]o\s+existe)[^.]{0,200}?obrigat[óo]ri/i;
		for (const [file, text] of [["README.md", readmeSection.text], ["docs/upgrading.md", upgradingSection.text]] as const) {
			expect(
				text,
				`${file} must state that no new variable is globally required for v2.2.1 -> 3.0.0`,
			).toMatch(NO_NEW_REQUIRED_VARIABLE_CLAIM);
		}
	});
});

/**
 * BL-73-01 (Gate 7.4): the runtime-variable matrix used to present
 * `PASSWORD_SESSION_SECRET` as a "pre-existing requirement, nothing changed".
 * The variable did exist in v2.2.1 — but there the session secret resolved as
 * `PASSWORD_SESSION_SECRET || API_KEY`, and 3.0.0 removed the `API_KEY`
 * fallback. Password-link installations that relied on `API_KEY` alone must
 * configure the dedicated secret before deploying 3.0.0;
 * already-configured installations must preserve their value; installations
 * without password links gain no new requirement. The guard checks the
 * semantics of each matrix row and of the upgrade prose — never exact wording.
 */
describe("Gate 7.4: PASSWORD_SESSION_SECRET upgrade semantics guard (BL-73-01)", () => {
	const MATRIX_FILES = ["README.md", "docs/upgrading.md", "docs/cloudflare-setup.md"] as const;

	/** A "still the fallback" claim — the opposite of the removed-fallback fact. */
	const FALLBACK_KEEPS_PATTERN =
		/(?:remains|continua(?:\s+a\s+ser)?|segue)\s+(?:a\s+)?(?:sendo\s+|como\s+|as\s+|the\s+)?(?:password[- ]session\s+)?\s*fallback/i;
	const FALLBACK_REMOVED_PATTERN =
		/(?:fallback[^.;|\n]{0,80}(?:foi\s+removido|removido|removeu|removed)|(?:foi\s+)?remov\w+[^.;|\n]{0,80}fallback|removeu[^.;|\n]{0,80}fallback|n[ãa]o\s+(?:é|aceita|serve)\s+(?:mais\s+)?(?:um\s+)?fallback)/i;
	const EXISTED_BEFORE_PATTERN = /j[áa]\s+existia|existed\s+(?:before|in\s+v2)|antes\s+da\s*`?3\.0\.0|existia\s+na\s*`?v2\.2\.1/i;
	const INTRODUCED_IN_300_PATTERN =
		/(?:nov[ao]\s+(?:na|in)\s*`?3\.0\.0|new\s+in\s+`?3\.0\.0|introduced\s+in\s+(?:the\s+)?`?3\.0\.0|introduzid[oa]\s+(?:na|em)\s*`?3\.0\.0)/i;
	const CREATE_BEFORE_DEPLOY_PATTERN =
		/\*{0,2}antes\*{0,2}\s+de\s+(?:publicar|fazer\s+o\s+deploy|publicar\s+o\s+Worker)|\*{0,2}antes\*{0,2}\s+do\s+(?:upgrade|deploy)|before\s+(?:deploying|publishing)/i;

	function passwordSecretRowViolations(row: string): string[] {
		const violations: string[] = [];
		const cells = row.split("|").map((cell) => cell.trim().replace(/^`|`$/g, ""));
		const typeCell = cells[2] ?? "";
		if (!/^Secret$/.test(typeCell)) {
			violations.push(`type must be Secret, not "${typeCell}"`);
		}
		if (/\b(?:opcional|optional)\b/i.test(row)) {
			violations.push("must not be presented as optional — it is required for password-protected links");
		}
		if (INTRODUCED_IN_300_PATTERN.test(row)) {
			violations.push("variable existed before 3.0.0 — it is not new");
		}
		if (!EXISTED_BEFORE_PATTERN.test(row)) {
			violations.push("must state the variable existed before 3.0.0");
		}
		if (!FALLBACK_REMOVED_PATTERN.test(row)) {
			violations.push("must state the API_KEY fallback was removed in 3.0.0");
		}
		if (FALLBACK_KEEPS_PATTERN.test(row)) {
			violations.push("API_KEY must not be presented as remaining the fallback");
		}
		if (!/(?:n[ãa]o\s+(?:gere|rotacione|regenere)\s+um\s+novo|preserve\s+(?:the\s+)?(?:existing\s+)?value|preserv\w+|mantenha\s+o\s+valor)/i.test(row)) {
			violations.push("must tell already-configured installations to preserve the existing value");
		}
		return violations;
	}

	function passwordSecretClaimViolations(text: string): string[] {
		const violations: string[] = [];
		if (/(?:todas\s+(?:as\s+)?instala[çc][õo]es|all\s+[^;\n]{0,60}?installations)[^.;\n]{0,160}(?:j[áa]\s+)?(?:satisfeit|atendid|cobert|cumprem|satisfied|comply|covered)/i.test(text)) {
			violations.push("must not claim every v2.2.1 installation already satisfies the dedicated-secret requirement");
		}
		if (/PASSWORD_SESSION_SECRET[^.;\n]{0,200}?\b(?:opcional|optional)\b/i.test(text)) {
			violations.push("must not present the secret as optional");
		}
		if (new RegExp(`PASSWORD_SESSION_SECRET[^.;\\n]{0,160}?${INTRODUCED_IN_300_PATTERN.source}`, "i").test(text)) {
			violations.push("variable existed before 3.0.0 — it is not new");
		}
		if (FALLBACK_KEEPS_PATTERN.test(text)) {
			violations.push("API_KEY fallback must be stated as removed, not kept");
		}
		return violations;
	}

	function passwordSecretRequirementGaps(text: string): string[] {
		const gaps: string[] = [];
		if (!/(?:dependia(?:m)?[^.;\n]{0,120}`?API_KEY`?|relied[^.;\n]{0,80}on\s+`?API_KEY`?)/i.test(text)) {
			gaps.push("case B: name the installations that relied on API_KEY alone in v2.2.1");
		}
		if (!/(?:crie|criar|cria|configure|configurar|gere|gerar)[^.;\n]{0,40}`?PASSWORD_SESSION_SECRET`?/i.test(text)) {
			gaps.push("case B: create the dedicated secret");
		}
		if (!CREATE_BEFORE_DEPLOY_PATTERN.test(text)) {
			gaps.push("case B: the before-deploy ordering");
		}
		if (!/(?:preserve|preserv\w+|mantenha\s+o\s+valor|n[ãa]o\s+(?:gere|rotacione|regenere))/i.test(text)) {
			gaps.push("case A: preserve an already-configured value");
		}
		if (!/(?:sem\s+links\s+protegidos|n[ãa]o\s+usa(?:m)?\s+links\s+protegidos|without\s+password[- ]protected\s+links)/i.test(text)) {
			gaps.push("case C: no requirement for installations without password links");
		}
		if (!/(?:n[ãa]o\s+(?:copie|reutilize)|jamais\s+use|never\s+(?:copy|reuse))\s+(?:o\s+)?valor\s+d[oae]\s+`?API_KEY`?|never\s+(?:copy|reuse)\s+the\s+`?API_KEY`?/i.test(text)) {
			gaps.push("never reuse the API_KEY value as the secret");
		}
		return gaps;
	}

	it("documents the PASSWORD_SESSION_SECRET rows with the corrected history", () => {
		for (const file of MATRIX_FILES) {
			const rows = readDoc(file).split("\n").filter((line) => /^\s*\|\s*`?PASSWORD_SESSION_SECRET`?\s*\|/.test(line));
			expect(rows.length, `${file} must list PASSWORD_SESSION_SECRET in its variable matrix`).toBeGreaterThan(0);
			for (const row of rows) {
				expect(passwordSecretRowViolations(row), `${file} row: ${row}`).toEqual([]);
			}
		}
	});

	it("keeps the conditional requirement and the three upgrade cases explicit", () => {
		for (const file of MATRIX_FILES) {
			const text = readDoc(file);
			expect(passwordSecretClaimViolations(text), `${file} claim semantics`).toEqual([]);
			expect(passwordSecretRequirementGaps(text), `${file} must cover cases A/B/C`).toEqual([]);
		}

		// The global claim stays true and global: no NEW variable is required
		// for every installation — the password-secret requirement is conditional.
		for (const file of ["README.md", "docs/upgrading.md", "docs/cloudflare-setup.md"] as const) {
			expect(readDoc(file), `${file} must keep the no-new-global-variable claim`).toMatch(
				/(?:nenhum|nenhuma|n[ãa]o\s+existe)[^.]{0,200}?obrigat[óo]ri/i,
			);
		}
	});

	it("flags wrong PASSWORD_SESSION_SECRET semantics (negative controls)", () => {
		const rowMutants: Array<{ label: string; row: string }> = [
			{ label: "presented as Text", row: "| `PASSWORD_SESSION_SECRET` | Text | quando usa links protegidos | assinar sessões | mudou |" },
			{ label: "optional for password links", row: "| `PASSWORD_SESSION_SECRET` | Secret | optional when password links are used | signs sessions | changed |" },
			{ label: "new in 3.0.0", row: "| `PASSWORD_SESSION_SECRET` | Secret | required for password links | signs sessions; new in 3.0.0 |" },
			{ label: "API_KEY remains fallback", row: "| `PASSWORD_SESSION_SECRET` | Secret | required for password links | existed before 3.0.0; preserve the existing value; API_KEY remains the password session fallback |" },
		];
		for (const mutant of rowMutants) {
			expect(passwordSecretRowViolations(mutant.row).length, mutant.label).toBeGreaterThan(0);
		}
		expect(passwordSecretRowViolations(rowMutants[0].row).join(" ")).toContain("Secret");
		expect(passwordSecretRowViolations(rowMutants[1].row).join(" ")).toContain("optional");
		expect(passwordSecretRowViolations(rowMutants[2].row).join(" ")).toContain("existed before");
		expect(passwordSecretRowViolations(rowMutants[3].row).join(" ")).toContain("removed");

		const claimMutants: Array<{ label: string; text: string }> = [
			{ label: "all installations already satisfied", text: "All existing v2.2.1 installations already satisfied the dedicated secret requirement." },
			{ label: "optional when password links are used", text: "PASSWORD_SESSION_SECRET is optional when password links are used." },
			{ label: "introduced in 3.0.0", text: "PASSWORD_SESSION_SECRET was introduced in 3.0.0." },
			{ label: "API_KEY remains fallback", text: "API_KEY remains password session fallback in 3.0.0." },
		];
		for (const mutant of claimMutants) {
			expect(passwordSecretClaimViolations(mutant.text).length, mutant.label).toBeGreaterThan(0);
		}

		// The corrected history, stated plainly, passes.
		expect(passwordSecretClaimViolations("PASSWORD_SESSION_SECRET existed before 3.0.0, but the API_KEY fallback was removed in 3.0.0.")).toEqual([]);
	});
});

describe("Phase 3: Smart Routing admin safety", () => {
	it("never renders rule, country, fallback or error data through innerHTML", () => {
		const admin = readPublic("admin.js");
		const dangerousLines = admin.split("\n").filter((line) => /innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(line));
		for (const line of dangerousLines) {
			expect(line).not.toMatch(/\brule\b|smartRouting|countryOptions|fallback|errorMessage|smartRule/i);
		}
		expect(admin).not.toMatch(/\beval\(|new Function\(/);
	});

	it("uses the single submit authority and no duplicate payload composer", () => {
		const admin = readPublic("admin.js");
		expect(admin).toContain("submitLinkForm(input)");
		expect(admin).not.toContain("buildSmartRoutingFields");
	});

	it("never echoes a Smart error into the general form status", () => {
		const admin = readPublic("admin.js");
		expect(admin).not.toMatch(/setStatus\(formStatus,\s*feedback\.smartError/);
		expect(admin).not.toMatch(/setStatus\(formStatus,\s*smartRoutingUi\.smartErrorMessage/);
	});

	it("keeps the Smart Routing helper module free of HTML sinks and dynamic code", () => {
		const ui = readPublic("smart-routing-ui.js");
		expect(ui).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
		expect(ui).not.toMatch(/\beval\(|new Function\(/);
	});

	it("registers unique ids for the Smart Routing form section", () => {
		const html = readPublic("admin.html");
		const ids = Array.from(html.matchAll(/\sid="([^"]+)"/g)).map((match) => match[1]);
		const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
		expect(duplicates).toEqual([]);
		for (const expected of [
			"smart-routing-section",
			"smart-routing-enabled",
			"smart-routing-rules",
			"smart-routing-count",
			"smart-routing-fallback",
			"smart-routing-error",
			"smart-routing-invalid",
			"clear-smart-invalid-button",
			"add-smart-rule-button",
		]) {
			expect(ids).toContain(expected);
		}
	});
});

describe("Gate 7.12: localized country ordering", () => {
	function countryApi(intl: unknown = Intl): SmartRoutingApi {
		const sandbox = { window: {} as { BoltLinkSmartRouting: SmartRoutingApi }, URL, Intl: intl };
		vm.runInNewContext(readPublic("smart-routing-ui.js"), sandbox);
		return sandbox.window.BoltLinkSmartRouting;
	}

	function expectOrdered(options: Array<{ value: string; label: string }>, locale = "pt-BR") {
		const compare = new Intl.Collator(locale, { usage: "sort", sensitivity: "base" }).compare;
		for (let index = 1; index < options.length; index += 1) {
			const previous = options[index - 1];
			const current = options[index];
			expect(compare(previous.label, current.label), `${previous.label} <= ${current.label}`).toBeLessThanOrEqual(0);
			if (compare(previous.label, current.label) === 0) {
				expect(previous.value < current.value).toBe(true);
			}
		}
	}

	it.each([undefined, "pt-BR", "en-US"])("sorts displayed labels in locale %s without changing any ISO value", (locale) => {
		const api = countryApi();
		const options = api.countryOptions(locale);
		expect(options[0]).toEqual({ value: "", label: "Qualquer país" });
		expect(options.filter((option) => option.value === "")).toHaveLength(1);
		const countries = options.slice(1);
		expect(countries).toHaveLength(249);
		expect(new Set(countries.map((option) => option.value)).size).toBe(249);
		expect(countries.map((option) => option.value).sort()).toEqual([...api.ISO_COUNTRIES].sort());
		// Independent authority: the backend's unchanged country set.
		const backend = readFileSync(resolve(process.cwd(), "src/smart-routing.ts"), "utf8");
		const list = backend.slice(backend.indexOf("export const ISO_3166_ALPHA2_COUNTRIES"), backend.indexOf("export function", backend.indexOf("export const ISO_3166_ALPHA2_COUNTRIES")));
		const backendCodes = [...list.matchAll(/"([A-Z]{2}(?: [A-Z]{2})* ?)"/g)].flatMap((match) => match[1].trim().split(" "));
		expect(countries.map((option) => option.value).sort()).toEqual(backendCodes.sort());
		expect(countries.find((option) => option.value === "BR")?.label).toBe(api.countryLabel("BR", locale));
		for (const option of countries) {
			expect(option.label).toBe(api.countryLabel(option.value, locale));
			expect(api.toPayloadRule({ country: option.value, url: "https://example.com/" }).country).toBe(option.value);
		}
		expectOrdered(countries, locale);
	});

	it("rejects the previous ISO ordering and places AF before AE in pt-BR", () => {
		const api = countryApi();
		const old = api.ISO_COUNTRIES.map((value) => ({ value, label: api.countryLabel(value, "pt-BR") }));
		const compare = new Intl.Collator("pt-BR", { usage: "sort", sensitivity: "base" }).compare;
		expect(compare(api.countryLabel("AE"), api.countryLabel("AF"))).toBeGreaterThan(0);
		expect(() => expectOrdered(old)).toThrow();
		const current = api.countryOptions("pt-BR");
		expect(current.findIndex((option) => option.value === "AF")).toBeLessThan(current.findIndex((option) => option.value === "AE"));
		expectOrdered(current.slice(1));
	});

	it("uses ISO labels deterministically when DisplayNames is unavailable", () => {
		const api = countryApi({ Collator: Intl.Collator });
		const options = api.countryOptions().slice(1);
		expect(options.every((option) => option.label === option.value)).toBe(true);
		expect(options.map((option) => option.value)).toEqual([...api.ISO_COUNTRIES].sort());
		expectOrdered(options);
	});

	it("collates accented labels and breaks equivalent labels by ISO code", () => {
		const labels: Record<string, string> = { AD: "Éclair", AE: "ábaco", AF: "Abaco", AG: "Çedro", AI: "Àrvore" };
		class DisplayNames {
			of(code: string) { return labels[code] || "Zulu"; }
		}
		const api = countryApi({ Collator: Intl.Collator, DisplayNames });
		const options = api.countryOptions("pt-BR").slice(1);
		expect(options.slice(0, 5).map((option) => option.value)).toEqual(["AE", "AF", "AI", "AG", "AD"]);
		expectOrdered(options);
	});

	it("keeps a deterministic fallback without Intl and leaves the exported ISO list intact", () => {
		const api = countryApi(undefined);
		const before = [...api.ISO_COUNTRIES];
		api.countryOptions();
		expect(api.ISO_COUNTRIES).toEqual(before);
		const noIntl = countryApi(null);
		expect(noIntl.countryOptions().slice(1).map((option) => option.value)).toEqual([...noIntl.ISO_COUNTRIES].sort());
	});
});

describe("Gate 7.12: Admin pt-BR copy", () => {
	const stale = /Control A|Variant B|Traffic Allocation|Split Test A\/B|Split A\/B|redirect temporário|visitor ID|fingerprint|Fallback:|destination mismatch|plataformas de ads|\bmigrations?\b/i;
	const files = ["admin.js", "smart-routing-ui.js", "ab-display.js", "expired-redirect-ui.js", "group-hierarchy-ui.js", "portability-ui.js", "portability-import-ui.js"];

	function presentationStrings(source: string) {
		const parsed = ts.createSourceFile("copy.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
		const strings: string[] = [];
		function visit(node: ts.Node) {
			if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) {
				// Literal keys compare server messages; they are never displayed.
				if (!(ts.isPropertyAssignment(node.parent) && node.parent.name === node)) strings.push(node.text);
			}
			ts.forEachChild(node, visit);
		}
		visit(parsed);
		return strings;
	}

	function errorCopy() {
		const source = ts.createSourceFile("admin.js", readPublic("admin.js"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
		const declaration = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "adminErrorCopy")!;
		const sandbox = {} as { adminErrorCopy: (message: unknown) => string };
		vm.runInNewContext(declaration.getText(source), sandbox);
		return sandbox.adminErrorCopy;
	}

	it("has no stale terms in visible HTML, ARIA, titles or helper copy", () => {
		const html = readPublic("admin.html").replace(/<!--[\s\S]*?-->/g, "");
		const visible = html.replace(/<[^>]*>/g, " ");
		const accessibility = [...html.matchAll(/(?:aria-label|title|placeholder)="([^"]*)"/g)].map((match) => match[1]);
		expect(visible).not.toMatch(stale);
		expect(accessibility.join(" ")).not.toMatch(stale);
		for (const file of files) {
			for (const text of presentationStrings(readPublic(file))) expect(text, `${file}: ${text}`).not.toMatch(stale);
		}
	});

	it("detects stale user copy but permits internal message keys and comments", () => {
		expect(presentationStrings('/* Split Test A/B */ var x = { "requires migration": "Aplique a migração" };').some((text) => stale.test(text))).toBe(false);
		expect(presentationStrings('var x = "Variant B";').some((text) => stale.test(text))).toBe(true);
	});

	it("retains A/B labels, privacy meaning and matching accessible help", () => {
		const html = readPublic("admin.html");
		const block = html.slice(html.indexOf('<details id="ab-testing-section"'), html.indexOf('id="smart-routing-unavailable"'));
		expect(block).toMatch(/<summary>Teste A\/B/);
		expect(block).toMatch(/Ativar Teste A\/B/);
		expect(block).toMatch(/Variante B \(URL alternativa\)/);
		expect(block).toMatch(/aria-label="Ajuda sobre Variante B"/);
		expect(block).toMatch(/Distribuição do tráfego/);
		expect(block).toMatch(/variante A[^.]*destino principal/i);
		expect(block).toMatch(/variante B[^.]*URL alternativa/i);
		expect(block).toMatch(/redirecionamento 302/);
		expect(block).toMatch(/sem cookies nem identificadores persistentes/);
	});

	it("explains ordered Smart Routing, both criteria, default destination and privacy", () => {
		const html = readPublic("admin.html");
		const block = html.slice(html.indexOf('<details id="smart-routing-section"'), html.indexOf('<div class="actions">'));
		for (const meaning of [/cima para baixo/, /primeira/i, /país e dispositivo/, /Se nenhuma corresponder/, /destino principal/, /Nenhum dado do visitante é armazenado/]) expect(block).toMatch(meaning);
		expect(block).toMatch(/Se nenhuma regra corresponder:/);
		expect(readPublic("admin.js")).toMatch(/Se nenhuma regra corresponder: \$\{value\}/);
	});

	it("keeps every migration filename in unavailable guidance", () => {
		const html = readPublic("admin.html");
		for (const filename of ["0004_ab_testing.sql", "0005_smart_routing.sql", "0006_expired_redirect.sql"]) {
			const line = html.split("\n").find((line) => line.includes(filename))!;
			expect(line).toMatch(/não está disponível nesta instalação/);
			expect(line).toMatch(/Aplique a migração/);
		}
	});

	it("corrects misleading history, edit and expiration guidance", () => {
		const html = readPublic("admin.html"), admin = readPublic("admin.js");
		expect(html).not.toMatch(/histórico estável|para de funcionar|UTMs e parâmetros serão adicionados automaticamente/);
		expect(html).toMatch(/campos vazios removem o parâmetro correspondente/);
		expect(html).toMatch(/deixa de redirecionar \(HTTP 410\)/);
		expect(admin).not.toMatch(/altere apenas o destino/);
		expect(admin).toMatch(/editar os demais campos/);
		expect(html).toMatch(/aria-label="Buscar links por slug, URL de destino ou tags"/);
	});

	it.each([
		["Invalid target URL", /URL de destino inválida.*HTTP ou HTTPS/],
		["Invalid abTargetUrl", /variante B inválida/],
		["expiresAt cannot be earlier than goLiveAt", /expiração.*antes da ativação/],
		["Slug already exists", /slug.*uso ou reservado/],
		["Link was modified concurrently. Reload it and try again", /outra sessão.*Recarregue/],
		["PASSWORD_SESSION_SECRET is required to add password protection", /Configure PASSWORD_SESSION_SECRET/],
		["Smart Routing requires migration 0005_smart_routing.sql to be applied", /migração 0005_smart_routing.sql/],
	])("translates API error %s only for display", (raw, expected) => {
		expect(errorCopy()(raw)).toMatch(expected);
	});

	it("preserves unknown-outcome warnings and useful diagnostic codes", () => {
		const copy = errorCopy();
		const suffix = " O estado final é desconhecido: recarregue a lista de links e revise antes de tentar novamente.";
		expect(copy("Failed to fetch" + suffix)).toContain("Verifique a conexão");
		expect(copy("Failed to fetch" + suffix)).toContain(suffix);
		expect(copy("Failed to fetch" + suffix)).not.toContain("Nenhuma alteração foi aplicada");
		expect(copy("Falha do servidor (TRACE_42)")).toBe("Falha do servidor (TRACE_42)");
		expect(copy("")).toBe("");
	});

	it("uses textContent at the terminal display boundary without translating API results", () => {
		const admin = readPublic("admin.js");
		expect(admin).toContain('type === "error" ? adminErrorCopy(message)');
		expect(admin).toContain('error.payload = payload');
		expect(admin).toContain('throw error');
		expect(readPublic("portability-import-ui.js")).toContain('var APPLY_INTERNAL_ERROR_MESSAGE = "Import could not be completed"');
	});
});

describe("Gate 7.13: global hidden semantics (BL-712-04)", () => {
	/**
	 * A miniature quote-aware cascade simulator with the real CSS decision order —
	 * importance, then specificity, then source position — so the `hidden` contract
	 * is validated semantically: no line is pinned, any stylesheet position works,
	 * and only a global `!important` (or stronger) rule passes. Pseudo-class
	 * selectors never match (rest state) and descendant selectors only match when
	 * the caller supplies the ancestor scope, so `.drawer [hidden]` can never pose
	 * as the global protection.
	 */
	type SimElement = { tag: string; classes?: string[]; hidden?: boolean };
	type SimRule = { selector: string; body: string; order: number };

	function styleRules(css: string): SimRule[] {
		const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
		const rules: SimRule[] = [];
		const stack: string[] = [];
		let pending = "";
		let quote: string | null = null;
		for (const char of source) {
			if (quote) {
				pending += char;
				if (char === quote) quote = null;
				continue;
			}
			if (char === '"' || char === "'") {
				quote = char;
				pending += char;
				continue;
			}
			if (char === "{") {
				stack.push(pending.trim());
				pending = "";
			} else if (char === "}") {
				const selector = stack.pop() ?? "";
				// Style rules at top level or directly inside a conditional group apply;
				// the group prelude itself and @keyframes frames do not.
				if (selector && !selector.startsWith("@") && (stack.length === 0 || stack[stack.length - 1].startsWith("@media"))) {
					rules.push({ selector, body: pending, order: rules.length });
				}
				pending = "";
			} else {
				pending += char;
			}
		}
		return rules;
	}

	function specificity(selector: string): [number, number, number] {
		let ids = 0;
		let classes = 0;
		let types = 0;
		for (const token of selector.match(/[#.][\w-]+|\[[^\]]+\]|\*|\b[a-z][\w-]*\b/gi) ?? []) {
			if (token.startsWith("#")) ids += 1;
			else if (token.startsWith(".") || token.startsWith("[")) classes += 1;
			else if (token !== "*") types += 1;
		}
		return [ids, classes, types];
	}

	function compoundMatches(compound: string, element: SimElement): boolean {
		const units = compound.match(/[#.][\w-]+|\[[^\]]+\]|\*|\b[a-z][\w-]*\b/gi) ?? [];
		if (units.length === 0) return false;
		for (const unit of units) {
			if (unit === "*") continue;
			if (unit.startsWith("#")) return false;
			if (unit.startsWith(".")) {
				if (!element.classes?.includes(unit.slice(1))) return false;
			} else if (unit.startsWith("[")) {
				if (unit.replace(/\s/g, "") !== "[hidden]" || !element.hidden) return false;
			} else if (unit.toLowerCase() !== element.tag.toLowerCase()) return false;
		}
		return true;
	}

	function selectorMatches(selector: string, element: SimElement, ancestors: SimElement[] = []): boolean {
		if (selector.includes(":")) return false;
		const parts = selector.split(/\s+/).filter(Boolean);
		if (parts.length > 1) {
			const scope = parts.slice(0, -1).join(" ");
			return compoundMatches(parts[parts.length - 1], element) && ancestors.some((ancestor) => selectorMatches(scope, ancestor));
		}
		return compoundMatches(selector, element);
	}

	function computedDisplay(css: string, element: SimElement, ancestors: SimElement[] = []): string {
		type Candidate = { value: string; important: boolean; specificity: [number, number, number]; order: number };
		const candidates: Candidate[] = [];
		for (const rule of styleRules(css)) {
			for (const single of rule.selector.split(",")) {
				if (!selectorMatches(single.trim(), element, ancestors)) continue;
				for (const declaration of rule.body.split(";")) {
					const colon = declaration.indexOf(":");
					if (colon === -1 || declaration.slice(0, colon).trim().toLowerCase() !== "display") continue;
					const raw = declaration.slice(colon + 1);
					candidates.push({
						value: raw.replace(/!\s*important/i, "").trim(),
						important: /!\s*important/i.test(raw),
						specificity: specificity(single),
						order: rule.order,
					});
				}
			}
		}
		if (candidates.length === 0) return "inline";
		candidates.sort((a, b) => {
			if (a.important !== b.important) return a.important ? -1 : 1;
			const [aIds, aClasses, aTypes] = a.specificity;
			const [bIds, bClasses, bTypes] = b.specificity;
			if (aIds !== bIds) return bIds - aIds;
			if (aClasses !== bClasses) return bClasses - aClasses;
			if (aTypes !== bTypes) return bTypes - aTypes;
			return b.order - a.order;
		});
		return candidates[0].value;
	}

	/**
	 * The BL-712-04 contract: a hidden control never keeps its author display —
	 * the button rule from the finding plus every class-level layout rule in the
	 * stylesheet, each simulated as a hidden element carrying that class.
	 */
	function hiddenStaysOutOfLayout(css: string): boolean {
		if (computedDisplay(css, { tag: "button", hidden: true }) !== "none") return false;
		const classDisplays = new Map<string, string>();
		for (const rule of styleRules(css)) {
			for (const single of rule.selector.split(",")) {
				const selector = single.trim();
				if (!/^\.[\w-]+$/.test(selector)) continue;
				for (const declaration of rule.body.split(";")) {
					const colon = declaration.indexOf(":");
					if (colon !== -1 && declaration.slice(0, colon).trim().toLowerCase() === "display") {
						classDisplays.set(selector.slice(1), declaration.slice(colon + 1).replace(/!\s*important/i, "").trim());
					}
				}
			}
		}
		for (const [className, value] of classDisplays) {
			if (value === "none") continue;
			if (computedDisplay(css, { tag: "div", classes: [className], hidden: true }) !== "none") return false;
		}
		return true;
	}

	it("admin.css restores the global hidden contract over the author button display", () => {
		const css = readPublic("admin.css");
		expect(computedDisplay(css, { tag: "button", hidden: true })).toBe("none");
		expect(computedDisplay(css, { tag: "button", hidden: false })).not.toBe("none");
		expect(hiddenStaysOutOfLayout(css)).toBe(true);
	});

	it("negative control: the author button display alone keeps hidden controls visible", () => {
		const css = "button { display: inline-flex; align-items: center; }";
		expect(computedDisplay(css, { tag: "button", hidden: true })).toBe("inline-flex");
		expect(hiddenStaysOutOfLayout(css)).toBe(false);
	});

	it("scoped drawer rules protect their own scope but never satisfy the global contract", () => {
		const css = ".qr-dialog [hidden] { display: none !important; } button { display: inline-flex; }";
		expect(computedDisplay(css, { tag: "button", hidden: true })).toBe("inline-flex");
		expect(hiddenStaysOutOfLayout(css)).toBe(false);
		expect(computedDisplay(css, { tag: "button", hidden: true }, [{ tag: "div", classes: ["qr-dialog"] }])).toBe("none");
	});

	it("positive control: the global rule restores the contract next to the button display", () => {
		const css = "button { display: inline-flex; } [hidden] { display: none !important; }";
		expect(computedDisplay(css, { tag: "button", hidden: true })).toBe("none");
		expect(computedDisplay(css, { tag: "button", hidden: false })).toBe("inline-flex");
		expect(hiddenStaysOutOfLayout(css)).toBe(true);
	});

	it("generic element: hidden beats a class-level grid regardless of source order", () => {
		const protectedCss = ".some-grid { display: grid; } [hidden] { display: none !important; }";
		expect(computedDisplay(protectedCss, { tag: "div", classes: ["some-grid"], hidden: true })).toBe("none");
		const orderFragileCss = "[hidden] { display: none; } .some-grid { display: grid; }";
		expect(computedDisplay(orderFragileCss, { tag: "div", classes: ["some-grid"], hidden: true })).toBe("grid");
	});
});

describe("Gate 8.10: published 3.1.0 identity (BL-89-01)", () => {
	function staleIdentity(text: string): boolean {
		const prose = text.replace(/[`*]/g, "");
		return /3\.1\.0[^\n.]{0,100}(?:não publicada|não foi publicada|not published|development)/i.test(prose)
			|| /(?:release\s+(?:atual(?:\s+publicada)?|publicada\s+atual)|(?:última|latest)\s+(?:release\s+)?(?:publicada\b\s*)?)\s*(?:é(?:\s+a)?|=|:)?\s*v?3\.0\.0/i.test(prose)
			|| /main\s*(?:==|=|e|\/)\s*(?:tag\s+)?v3\.0\.0/i.test(prose);
	}
	it("scans all current documents and the current blocks of the release histories", () => {
		for (const file of collectDocumentationFiles(process.cwd())) {
			const name = relative(process.cwd(), file);
			// This exact file is the historical local Gates 8.1-8.5 report.
			if (name === "docs/phase8-local-validation.md") continue;
			let text = readDoc(name);
			if (name === "CHANGELOG.md") text = text.split("## [3.0.0]")[0];
			if (name === "RELEASE_NOTES.md") text = text.split("## BoltLink 3.0.0")[0];
			expect(staleIdentity(text), name).toBe(false);
		}
		for (const name of ["AGENTS.md", "AI-START.md", "README.md", "docs/cloudflare-setup.md", "docs/upgrading.md"]) {
			const text = readDoc(name);
			expect(text).toContain("3.1.0 está publicada");
			expect(text).toContain("v3.1.0");
			expect(text).toContain("3.1.1");
			expect(text).toContain("## Release candidate — 3.1.1 (não publicada)");
			expect(text).not.toMatch(/3\.1\.1 está publicada|Release atual publicada: 3\.1\.1|3\.2\.0/);
		}
	});
	it.each([
		"3.1.0 está em desenvolvimento, não publicada",
		"3.1.0 not published",
		"3.1.0 development",
		"release atual é a 3.0.0",
		"Última release publicada: v3.0.0",
		"main == v3.0.0",
		"Gate histórico foi concluído; release atual é a 3.0.0",
	])("rejects the stale identity reproducer: %s", (text) => {
		expect(staleIdentity(text)).toBe(true);
	});
	it("accepts historical origins and the frozen previous release", () => {
		expect(staleIdentity("Release atual publicada: 3.1.0, tag v3.1.0. Release anterior: v3.0.0. Smart Routing publicado desde a 3.0.0.")).toBe(false);
	});
});

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
import { join, resolve } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

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
	"migrations/0005_smart_routing.sql",
	"migrations/0004_ab_testing.sql",
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
			["INVALID_URL", "Informe um destino http ou https válido."],
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
	 * The GLOBAL-003 root cause was documentation disagreeing with the artifact.
	 * This test reads the real tag so the published boundary stays checkable
	 * instead of being taken from prose. It is evidence validation, not the
	 * primary guard: a checkout without the tag skips it and the Markdown scope
	 * scanner above still enforces the boundary.
	 */
	it.skipIf(publishedTag === null)("documents a published tag that really ends at migration 0003", () => {
		assertPublishedTagContract(publishedTag!);
	});

	it("attributes 0003 to the published upgrade line and 0004 to Phase 2", () => {
		const upgrading = readDoc("docs/upgrading.md");
		const scope = parseMarkdownSections(upgrading).find((entry) => entry.title.startsWith("Escopo das três bases"))!;
		expect(classifySectionScope(scope)).toBe("unreleased");
		expect(scope.body).toContain("`0000` a `0003`");
		expect(scope.body).toContain("`0000` a `0004`");
		expect(scope.body).toContain("`0000` a `0005`");

		// The published upgrade section never sends a reader to a later migration.
		const published = parseMarkdownSections(upgrading).find((entry) => entry.title.startsWith("Upgrade para a versão publicada"))!;
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
		expect(sections.map((section) => section.heading)).toEqual(["## Published setup"]);
		expect(classifySectionScope(sections[0])).toBe("published");
		expect(findForbiddenTokens(sections[0].text)).toContain("Smart Routing");
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
 * The documentation describes three different code states, and each section is
 * scoped to exactly one of them. The published tag is the smallest: it ends at
 * migration 0003. Phase 2 (the local baseline) adds 0004 and A/B. Phase 3 (the
 * working tree) adds 0005 and Smart Routing.
 */
type SectionScope = "published" | "phase2" | "unreleased" | "neutral";

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

/** Phase 3 artifacts: absent from both the published tag and the Phase 2 baseline. */
const UNRELEASED_FEATURE_TOKENS: Array<{ label: string; pattern: RegExp }> = [
	{ label: "0005", pattern: /\b0005\b/ },
	{ label: "0005_smart_routing", pattern: /0005_smart_routing/i },
	{ label: "Smart Routing", pattern: /smart[\s-]?routing/i },
	{ label: "smartRoutingRules", pattern: /smartRoutingRules/i },
	{ label: "smart_routing_rules", pattern: /smart_routing_rules/i },
	{ label: "src/smart-routing.ts", pattern: /src\/smart-routing\.ts/i },
	{ label: "public/smart-routing-ui.js", pattern: /public\/smart-routing-ui\.js/i },
];

/** Phase 2 artifacts: present in the local baseline, absent from the published tag. */
const PHASE2_FEATURE_TOKENS: Array<{ label: string; pattern: RegExp }> = [
	{ label: "0004", pattern: /\b0004\b/ },
	{ label: "0004_ab_testing", pattern: /0004_ab_testing/i },
	{ label: "Split Test A/B", pattern: /split\s*test\s*a\/b/i },
	{ label: "A/B testing", pattern: /a\/b\s*testing/i },
	{ label: "ab_enabled", pattern: /\bab_enabled\b/i },
	{ label: "ab_target_url", pattern: /\bab_target_url\b/i },
	{ label: "dev-prepare", pattern: /dev-prepare/i },
];

/** Everything the published tag does not contain. */
const PUBLISHED_FORBIDDEN_TOKENS = [...PHASE2_FEATURE_TOKENS, ...UNRELEASED_FEATURE_TOKENS];

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
 * Resolves the effective scope from the nearest heading/ancestor marker. The
 * nearest marker wins, so a Phase 3 child of a published parent is scanned as
 * Phase 3. Phase 2 is matched before the generic `development` marker so a
 * "development Phase 2" heading is not read as Phase 3.
 */
function classifySectionScope(section: MarkdownSection): SectionScope {
	const chain = [...section.ancestors.map((entry) => entry.title), section.title];
	for (let index = chain.length - 1; index >= 0; index -= 1) {
		const title = chain[index];
		if (PHASE2_SCOPE_PATTERNS.some((pattern) => pattern.test(title))) {
			return "phase2";
		}
		if (UNRELEASED_SCOPE_PATTERNS.some((pattern) => pattern.test(title))) {
			return "unreleased";
		}
		if (PUBLISHED_SCOPE_PATTERNS.some((pattern) => pattern.test(title))) {
			return "published";
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

/** Scope-aware violation report for one section. */
function findScopeViolations(section: MarkdownSection): string[] {
	const scope = classifySectionScope(section);
	if (scope === "published") {
		return findForbiddenTokens(section.text);
	}
	if (scope === "phase2") {
		return findPhase3Tokens(section.text);
	}
	return [];
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

	it("keeps the published README upgrade section free of Smart Routing and 0005", () => {
		const readme = readDoc("README.md");
		const published = markdownSection(readme, "## Upgrade para v2.2.1");
		expect(published).not.toBeNull();
		expect(published).not.toMatch(/0005|Smart Routing/i);

		const unreleased = markdownSection(readme, "## Unreleased / Fase 3 (próxima release)");
		expect(unreleased).not.toBeNull();
		expect(unreleased).toMatch(/0005/);
		expect(unreleased).toMatch(/Smart Routing/i);
	});

	it("keeps the README Wrangler local procedure published-scoped", () => {
		const readme = readDoc("README.md");
		const section = parseMarkdownSections(readme).find((entry) => entry.title.startsWith("1. Wrangler local"))!;
		expect(section).toBeTruthy();
		expect(classifySectionScope(section)).toBe("published");
		expect(findScopeViolations(section)).toEqual([]);

		// Direct content only: the Phase 2 and Phase 3 development children have
		// their own scope and are not part of the published procedure.
		expect(section.body).toMatch(/migrations apply/);
		expect(section.body).not.toMatch(/dev-prepare|0004|0005/i);
	});

	it("keeps the README v2.2.1 upgrade section free of Smart Routing and 0005", () => {
		const readme = readDoc("README.md");
		const published = markdownSection(readme, "## Upgrade para v2.2.1");
		expect(published).not.toBeNull();
		expect(published).not.toMatch(/0005|Smart Routing|smartRouting|smart_routing_rules/i);
	});

	it("keeps the upgrading A/B Phase 2 section free of Phase 3 artifacts", () => {
		const upgrading = readDoc("docs/upgrading.md");
		const section = parseMarkdownSections(upgrading).find((entry) => entry.title.startsWith("Split Test A/B e migration 0004"))!;
		expect(section).toBeTruthy();
		expect(classifySectionScope(section)).toBe("phase2");
		expect(findScopeViolations(section)).toEqual([]);
		expect(section.body).toMatch(/0004/);
	});

	it("keeps the cloudflare Fluxo A published-scoped", () => {
		const setup = readDoc("docs/cloudflare-setup.md");
		const fluxoA = markdownSection(setup, "## Fluxo A: Wrangler local (release publicada v2.2.1)");
		expect(fluxoA).not.toBeNull();
		expect(fluxoA).not.toMatch(/0005|Smart Routing|smart_routing_rules/i);

		const unreleased = markdownSection(setup, "## Unreleased / Fase 3 (próxima release)");
		expect(unreleased).not.toBeNull();
		expect(unreleased).toMatch(/0005/);
		expect(unreleased).toMatch(/Smart Routing/i);
	});

	it("keeps the published upgrading section free of Smart Routing and 0005", () => {
		const upgrading = readDoc("docs/upgrading.md");
		const published = markdownSection(upgrading, "## Upgrade para a versão publicada (v2.2.1)");
		expect(published).not.toBeNull();
		expect(published).not.toMatch(/0005|Smart Routing/i);

		const unreleased = markdownSection(upgrading, "## Smart Routing e migration 0005 (Unreleased / Fase 3)");
		expect(unreleased).not.toBeNull();
		expect(unreleased).toMatch(/0005/);
	});

	it("keeps each migration attributed to its own baseline in cloudflare-setup", () => {
		const setup = readDoc("docs/cloudflare-setup.md");
		const lines = setup.split("\n");

		// The published upgrade step ends at 0003 and must not import a Phase 2 or
		// Phase 3 migration into the published procedure.
		const publishedStep = lines.findIndex((line) => line.includes("última migration da release publicada"));
		expect(publishedStep).toBeGreaterThan(-1);
		expect(lines[publishedStep]).toContain("0003");
		expect(lines[publishedStep]).not.toMatch(/0004|0005/);

		// 0004 is attributed to the Phase 2 baseline and 0005 to Phase 3.
		const phase2Line = lines.find((line) => line.includes("`0004_ab_testing.sql` habilita"));
		expect(phase2Line).toBeTruthy();
		expect(phase2Line).toMatch(/Phase 2 local/);
		expect(phase2Line).not.toMatch(/0005/);

		const phase3Line = lines.find((line) => line.includes("Unreleased / Fase 3") && line.includes("0005"));
		expect(phase3Line).toBeTruthy();
	});

	it("keeps the architecture clean-install scope separated", () => {
		const sections = parseMarkdownSections(readDoc("docs/architecture.md"));
		const publishedSection = sections.find((section) => section.heading === "### Migrações e runtime (release publicada v2.2.1)");
		expect(publishedSection).toBeTruthy();
		expect(findForbiddenTokens(publishedSection!.text)).toEqual([]);

		const unreleasedSection = sections.find((section) => section.heading === "#### Instalação limpa e upgrade (Unreleased / Fase 3)");
		expect(unreleasedSection).toBeTruthy();
		expect(findForbiddenTokens(unreleasedSection!.text)).toContain("0005_smart_routing");
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

	it("marks migration 0005 as Unreleased in every doc that mentions it", () => {
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
			const text = readDoc(file);
			if (/\b0005\b|smart_routing_rules|Smart Routing/.test(text)) {
				expect(text, `${file} must mark Smart Routing as Unreleased`).toMatch(/Unreleased|próxima release|Proxima release|development/i);
			}
		}
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

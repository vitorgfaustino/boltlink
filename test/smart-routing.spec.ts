/*
 * Copyright (c) 2026 Vitor Faustino
 * AGPL-3.0 License — https://github.com/vitorgfaustino/boltlink
 *
 * Gate 3.1: pure Smart Routing domain. Unit and adversarial coverage.
 */

import { describe, expect, it, vi } from "vitest";
import {
	ISO_3166_ALPHA2_COUNTRIES,
	MAX_RULES,
	MAX_SERIALIZED_RULES_BYTES,
	MAX_TARGET_URL_BYTES,
	MAX_USER_AGENT_BYTES,
	classifyDevice,
	matchSmartRoutingRule,
	normalizeRequestCountry,
	parsePersistedSmartRoutingRules,
	parseSmartRoutingRules,
	selectSmartRoutingTarget,
} from "../src/smart-routing";
import type { SmartRoutingRule } from "../src/smart-routing";

const url = (path: string) => `https://example.com/${path}`;

const IOS_PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const IPAD = "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const IPOD = "Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1";
const IPADOS_DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const ANDROID_PHONE = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";
const ANDROID_TABLET = "Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const CROS = "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const UNKNOWN = "SomeCustomClient/1.0";

const DISTINCT_COUNTRIES = ["BR", "US", "GB", "DE", "FR", "JP", "CA", "AU", "IT", "ES", "NL", "SE", "NO", "FI", "DK", "PT", "PL", "IE", "AT", "BE"];

function twentyRules(pathLength: number): unknown[] {
	return DISTINCT_COUNTRIES.map((country) => ({ country, url: url("a".repeat(pathLength)) }));
}

describe("smart routing: country model", () => {
	it("accepts configured ISO codes and rejects non-countries", () => {
		expect(ISO_3166_ALPHA2_COUNTRIES.has("BR")).toBe(true);
		expect(ISO_3166_ALPHA2_COUNTRIES.has("US")).toBe(true);
		expect(ISO_3166_ALPHA2_COUNTRIES.has("GB")).toBe(true);
		expect(ISO_3166_ALPHA2_COUNTRIES.has("DE")).toBe(true);
		expect(ISO_3166_ALPHA2_COUNTRIES.has("JP")).toBe(true);
		expect(ISO_3166_ALPHA2_COUNTRIES.has("XX")).toBe(false);
		expect(ISO_3166_ALPHA2_COUNTRIES.has("T1")).toBe(false);
		expect(ISO_3166_ALPHA2_COUNTRIES.has("ZZ")).toBe(false);
		expect(ISO_3166_ALPHA2_COUNTRIES.has("br")).toBe(false);

		expect(parseSmartRoutingRules([{ country: "BR", url: url("br") }])).toEqual({
			ok: true,
			rules: [{ country: "BR", url: url("br") }],
		});
		expect(parseSmartRoutingRules([{ country: "US", device: "desktop", url: url("us") }]).ok).toBe(true);
	});

	it("rejects invalid country configuration without silent normalization", () => {
		for (const country of ["br", " BR ", "XX", "T1", "ZZ", "", "BRA", "B", 1, null, undefined]) {
			const result = parseSmartRoutingRules([{ country, url: url("x") } as Record<string, unknown>]);
			expect(result).toEqual({ ok: false, code: "INVALID_COUNTRY" });
		}
	});

	it("normalizes transient country conservatively", () => {
		expect(normalizeRequestCountry("BR")).toBe("BR");
		expect(normalizeRequestCountry("US")).toBe("US");
		expect(normalizeRequestCountry("XX")).toBeNull();
		expect(normalizeRequestCountry("T1")).toBeNull();
		expect(normalizeRequestCountry("ZZ")).toBeNull();
		expect(normalizeRequestCountry("br")).toBeNull();
		expect(normalizeRequestCountry(" BR ")).toBeNull();
		expect(normalizeRequestCountry(null)).toBeNull();
		expect(normalizeRequestCountry(undefined)).toBeNull();
		expect(normalizeRequestCountry(123)).toBeNull();
		expect(normalizeRequestCountry({ country: "BR" })).toBeNull();
	});
});

describe("smart routing: device classifier", () => {
	it("classifies iOS devices", () => {
		expect(classifyDevice(IOS_PHONE)).toBe("ios");
		expect(classifyDevice(IPAD)).toBe("ios");
		expect(classifyDevice(IPOD)).toBe("ios");
		expect(classifyDevice(IPADOS_DESKTOP)).toBe("ios");
	});

	it("classifies Android before Linux desktop", () => {
		expect(classifyDevice(ANDROID_PHONE)).toBe("android");
		expect(classifyDevice(ANDROID_TABLET)).toBe("android");
	});

	it("classifies desktop platforms", () => {
		expect(classifyDevice(WINDOWS)).toBe("desktop");
		expect(classifyDevice(MAC)).toBe("desktop");
		expect(classifyDevice(LINUX)).toBe("desktop");
		expect(classifyDevice(CROS)).toBe("desktop");
	});

	it("treats unknown, empty and oversized User-Agents as other", () => {
		expect(classifyDevice(UNKNOWN)).toBe("other");
		expect(classifyDevice("")).toBe("other");
		expect(classifyDevice(undefined)).toBe("other");
		expect(classifyDevice(null)).toBe("other");
		expect(classifyDevice(42)).toBe("other");
		expect(classifyDevice("x".repeat(MAX_USER_AGENT_BYTES + 1))).toBe("other");
		expect(classifyDevice(`Mozilla/5.0 (iPhone) ${"x".repeat(MAX_USER_AGENT_BYTES)}`)).toBe("other");
	});

	it("does not confuse iPadOS with macOS desktop", () => {
		expect(classifyDevice(IPADOS_DESKTOP)).toBe("ios");
		expect(classifyDevice(MAC)).toBe("desktop");
	});
});

describe("smart routing: rule validation", () => {
	it("rejects non-arrays, empty arrays and too many rules", () => {
		expect(parseSmartRoutingRules("nope")).toEqual({ ok: false, code: "NOT_ARRAY" });
		expect(parseSmartRoutingRules({})).toEqual({ ok: false, code: "NOT_ARRAY" });
		expect(parseSmartRoutingRules([])).toEqual({ ok: false, code: "EMPTY_RULES" });
		expect(parseSmartRoutingRules(twentyRules(1).concat([{ country: "AR", url: url("x") }]))).toEqual({ ok: false, code: "TOO_MANY_RULES" });
	});

	it("accepts the maximum of twenty rules", () => {
		const result = parseSmartRoutingRules(twentyRules(1));
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.rules).toHaveLength(MAX_RULES);
		}
	});

	it("rejects unknown keys and non-object rules", () => {
		expect(parseSmartRoutingRules([{ country: "BR", url: url("x"), id: 1 }])).toEqual({ ok: false, code: "UNKNOWN_KEY" });
		expect(parseSmartRoutingRules([{ country: "BR", url: url("x"), priority: 2 }])).toEqual({ ok: false, code: "UNKNOWN_KEY" });
		expect(parseSmartRoutingRules([null])).toEqual({ ok: false, code: "INVALID_RULE" });
		expect(parseSmartRoutingRules(["x"])).toEqual({ ok: false, code: "INVALID_RULE" });
	});

	it("requires at least one matcher (no Any/Any)", () => {
		expect(parseSmartRoutingRules([{ url: url("x") }])).toEqual({ ok: false, code: "MISSING_MATCHER" });
	});

	it("rejects invalid devices", () => {
		for (const device of ["mobile", "tablet", "windows", "macos", "linux", "iPhone", "Android", "unknown", "", 1, null]) {
			const result = parseSmartRoutingRules([{ device, url: url("x") } as Record<string, unknown>]);
			expect(result).toEqual({ ok: false, code: "INVALID_DEVICE" });
		}
	});

	it("rejects unsafe, relative and oversized URLs", () => {
		expect(parseSmartRoutingRules([{ country: "BR", url: "javascript:alert(1)" }])).toEqual({ ok: false, code: "INVALID_URL" });
		expect(parseSmartRoutingRules([{ country: "BR", url: "data:text/html,hi" }])).toEqual({ ok: false, code: "INVALID_URL" });
		expect(parseSmartRoutingRules([{ country: "BR", url: "file:///etc/passwd" }])).toEqual({ ok: false, code: "INVALID_URL" });
		expect(parseSmartRoutingRules([{ country: "BR", url: "ftp://example.com/x" }])).toEqual({ ok: false, code: "INVALID_URL" });
		expect(parseSmartRoutingRules([{ country: "BR", url: "mailto:a@example.com" }])).toEqual({ ok: false, code: "INVALID_URL" });
		expect(parseSmartRoutingRules([{ country: "BR", url: "/relative" }])).toEqual({ ok: false, code: "INVALID_URL" });
		expect(parseSmartRoutingRules([{ country: "BR", url: "not a url" }])).toEqual({ ok: false, code: "INVALID_URL" });
		expect(parseSmartRoutingRules([{ country: "BR" }])).toEqual({ ok: false, code: "INVALID_URL" });
		expect(parseSmartRoutingRules([{ country: "BR", url: url("a".repeat(3000)) }])).toEqual({ ok: false, code: "URL_TOO_LONG" });
	});

	it("accepts a URL at the size limit and rejects one byte over", () => {
		const prefix = "https://example.com/";
		const atLimit = prefix + "a".repeat(MAX_TARGET_URL_BYTES - prefix.length);
		const overLimit = `${atLimit}a`;
		expect(parseSmartRoutingRules([{ country: "BR", url: atLimit }]).ok).toBe(true);
		expect(parseSmartRoutingRules([{ country: "BR", url: overLimit }])).toEqual({ ok: false, code: "URL_TOO_LONG" });
	});

	it("rejects a rule set whose serialized JSON exceeds the byte budget", () => {
		const result = parseSmartRoutingRules(twentyRules(600));
		expect(result).toEqual({ ok: false, code: "RULES_TOO_LARGE" });
		expect(MAX_SERIALIZED_RULES_BYTES).toBe(8192);
	});
});

describe("smart routing: duplicate and shadow detection", () => {
	it("rejects identical matchers regardless of URL", () => {
		expect(parseSmartRoutingRules([{ country: "BR", url: url("a") }, { country: "BR", url: url("b") }])).toEqual({ ok: false, code: "DUPLICATE_MATCHER" });
		expect(parseSmartRoutingRules([{ device: "ios", url: url("a") }, { device: "ios", url: url("b") }])).toEqual({ ok: false, code: "DUPLICATE_MATCHER" });
		expect(parseSmartRoutingRules([{ country: "BR", device: "ios", url: url("a") }, { country: "BR", device: "ios", url: url("b") }])).toEqual({ ok: false, code: "DUPLICATE_MATCHER" });
	});

	it("rejects rules fully shadowed by a broader previous rule", () => {
		expect(parseSmartRoutingRules([{ country: "BR", url: url("broad") }, { country: "BR", device: "android", url: url("narrow") }])).toEqual({ ok: false, code: "SHADOWED_RULE" });
		expect(parseSmartRoutingRules([{ device: "android", url: url("broad") }, { country: "BR", device: "android", url: url("narrow") }])).toEqual({ ok: false, code: "SHADOWED_RULE" });
	});

	it("accepts inverse specificity (narrow first, broad later)", () => {
		expect(parseSmartRoutingRules([{ country: "BR", device: "android", url: url("narrow") }, { country: "BR", url: url("broad") }]).ok).toBe(true);
		expect(parseSmartRoutingRules([{ country: "BR", url: url("br") }, { country: "US", url: url("us") }]).ok).toBe(true);
		expect(parseSmartRoutingRules([{ country: "BR", url: url("br") }, { device: "ios", url: url("ios") }]).ok).toBe(true);
	});
});

describe("smart routing: first-match selection", () => {
	const rules: SmartRoutingRule[] = [
		{ country: "BR", url: url("br") },
		{ country: "BR", device: "ios", url: url("br-ios") },
		{ country: "US", url: url("us") },
		{ device: "ios", url: url("any-ios") },
	];

	it("matches country-only, device-only and combined rules", () => {
		expect(matchSmartRoutingRule([{ country: "BR", url: url("br") }], { country: "BR", device: "desktop" })).toMatchObject({ url: url("br") });
		expect(matchSmartRoutingRule([{ device: "android", url: url("and") }], { country: null, device: "android" })).toMatchObject({ url: url("and") });
		expect(matchSmartRoutingRule([{ country: "BR", device: "ios", url: url("both") }], { country: "BR", device: "ios" })).toMatchObject({ url: url("both") });
	});

	it("does not match on a partial combined rule", () => {
		const combined = [{ country: "BR", device: "ios", url: url("both") }];
		expect(matchSmartRoutingRule(combined, { country: "BR", device: "android" })).toBeNull();
		expect(matchSmartRoutingRule(combined, { country: "US", device: "ios" })).toBeNull();
	});

	it("never matches a country rule when the request country is unknown", () => {
		expect(matchSmartRoutingRule(rules, { country: null, device: "desktop" })).toBeNull();
	});

	it("keeps device-only rules eligible when the country is unknown", () => {
		expect(selectSmartRoutingTarget(rules, { country: null, device: "ios" }, url("fallback"))).toBe(url("any-ios"));
	});

	it("obeys order and first-match-wins without auto-sorting", () => {
		const broadFirst: SmartRoutingRule[] = [
			{ country: "BR", url: url("broad") },
			{ country: "BR", device: "ios", url: url("narrow") },
		];
		expect(matchSmartRoutingRule(broadFirst, { country: "BR", device: "ios" })?.url).toBe(url("broad"));

		const reversed: SmartRoutingRule[] = [
			{ country: "BR", device: "ios", url: url("narrow") },
			{ country: "BR", url: url("broad") },
		];
		expect(matchSmartRoutingRule(reversed, { country: "BR", device: "ios" })?.url).toBe(url("narrow"));
	});

	it("returns the fallback when nothing matches", () => {
		expect(selectSmartRoutingTarget(rules, { country: "DE", device: "desktop" }, url("fallback"))).toBe(url("fallback"));
	});
});

describe("smart routing: persisted configuration safety", () => {
	it("distinguishes disabled, valid and invalid persisted content", () => {
		expect(parsePersistedSmartRoutingRules(null)).toEqual({ status: "disabled", rules: [] });
		expect(parsePersistedSmartRoutingRules(undefined)).toEqual({ status: "disabled", rules: [] });
		expect(parsePersistedSmartRoutingRules(JSON.stringify([{ country: "BR", url: url("br") }]))).toEqual({
			status: "valid",
			rules: [{ country: "BR", url: url("br") }],
		});
		expect(parsePersistedSmartRoutingRules("{not json")).toEqual({ status: "invalid", rules: [] });
		expect(parsePersistedSmartRoutingRules("{}")).toEqual({ status: "invalid", rules: [] });
		expect(parsePersistedSmartRoutingRules("[]")).toEqual({ status: "invalid", rules: [] });
		expect(parsePersistedSmartRoutingRules('"string"')).toEqual({ status: "invalid", rules: [] });
		expect(parsePersistedSmartRoutingRules(JSON.stringify([{ country: "BR", url: url("x"), id: 1 }]))).toEqual({ status: "invalid", rules: [] });
		expect(parsePersistedSmartRoutingRules(JSON.stringify([{ url: url("x") }]))).toEqual({ status: "invalid", rules: [] });
		expect(parsePersistedSmartRoutingRules(JSON.stringify([{ country: "BR", url: url("a") }, { country: "BR", device: "ios", url: url("b") }]))).toEqual({ status: "invalid", rules: [] });
	});

	it("never throws on unexpected persisted input", () => {
		expect(() => parsePersistedSmartRoutingRules("\u0000")).not.toThrow();
		expect(() => parsePersistedSmartRoutingRules("[}")).not.toThrow();
	});
});

describe("smart routing: canonical URL byte invariants (BL-SR-001)", () => {
	const prefix = "https://example.com/";

	it("accepts a canonical URL at the byte limit", () => {
		const atLimit = prefix + "a".repeat(MAX_TARGET_URL_BYTES - prefix.length);
		const result = parseSmartRoutingRules([{ country: "BR", url: atLimit }]);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(new TextEncoder().encode(result.rules[0].url).byteLength).toBeLessThanOrEqual(MAX_TARGET_URL_BYTES);
		}
	});

	it("accepts a URL whose canonical form adds a trailing slash", () => {
		expect(parseSmartRoutingRules([{ country: "BR", url: "https://example.com" }])).toEqual({
			ok: true,
			rules: [{ country: "BR", url: "https://example.com/" }],
		});
	});

	it("keeps common ASCII URLs working", () => {
		const result = parseSmartRoutingRules([{ country: "BR", device: "desktop", url: "https://example.com/path?x=1#frag" }]);
		expect(result.ok).toBe(true);
	});

	it("rejects canonicalization that pushes the URL over the byte limit (multibyte)", () => {
		const input = prefix + "\u00e9".repeat(1000);
		expect(new TextEncoder().encode(input).byteLength).toBeLessThanOrEqual(MAX_TARGET_URL_BYTES);
		expect(parseSmartRoutingRules([{ country: "BR", url: input }])).toEqual({ ok: false, code: "URL_TOO_LONG" });
	});

	it("reproduces the audit case: raw 2048 bytes -> ~6 KiB canonical", () => {
		const input = prefix + "\u00e9".repeat(1014);
		expect(new TextEncoder().encode(input).byteLength).toBe(2048);
		expect(parseSmartRoutingRules([{ country: "BR", url: input }])).toEqual({ ok: false, code: "URL_TOO_LONG" });
	});
});

describe("smart routing: hostile rule objects (BL-SR-002)", () => {
	it("rejects inherited (non-own) fields", () => {
		const proto = { url: "https://example.com/inherited" };
		const rule = Object.create(proto) as Record<string, unknown>;
		rule.country = "BR";
		expect(parseSmartRoutingRules([rule])).toEqual({ ok: false, code: "INVALID_RULE" });
	});

	it("rejects custom and null prototypes even with own valid fields", () => {
		const custom = Object.create({}) as Record<string, unknown>;
		custom.country = "BR";
		custom.url = url("custom");
		expect(parseSmartRoutingRules([custom])).toEqual({ ok: false, code: "INVALID_RULE" });

		const nullProto = Object.create(null) as Record<string, unknown>;
		nullProto.country = "BR";
		nullProto.url = url("nullproto");
		expect(parseSmartRoutingRules([nullProto])).toEqual({ ok: false, code: "INVALID_RULE" });

		expect(parseSmartRoutingRules([new Date()])).toEqual({ ok: false, code: "INVALID_RULE" });
		expect(parseSmartRoutingRules([new String("x")])).toEqual({ ok: false, code: "INVALID_RULE" });
	});

	it("never executes accessors and fails closed", () => {
		const throwingUrl = { country: "BR" };
		Object.defineProperty(throwingUrl, "url", { get() { throw new Error("getter-fired"); }, enumerable: true, configurable: true });
		expect(() => parseSmartRoutingRules([throwingUrl])).not.toThrow();
		expect(parseSmartRoutingRules([throwingUrl])).toEqual({ ok: false, code: "INVALID_RULE" });

		const nonThrowingUrl = { country: "BR" };
		Object.defineProperty(nonThrowingUrl, "url", { get() { return url("accessor"); }, enumerable: true, configurable: true });
		expect(parseSmartRoutingRules([nonThrowingUrl])).toEqual({ ok: false, code: "INVALID_RULE" });

		const throwingDevice = { country: "BR", url: url("x") };
		Object.defineProperty(throwingDevice, "device", { get() { throw new Error("device-getter"); }, enumerable: true, configurable: true });
		expect(() => parseSmartRoutingRules([throwingDevice])).not.toThrow();
		expect(parseSmartRoutingRules([throwingDevice])).toEqual({ ok: false, code: "INVALID_RULE" });
	});

	it("fails closed on hostile proxies", () => {
		const ownKeysProxy = new Proxy({}, { ownKeys() { throw new Error("ownKeys-fired"); } });
		expect(() => parseSmartRoutingRules([ownKeysProxy])).not.toThrow();
		expect(parseSmartRoutingRules([ownKeysProxy])).toEqual({ ok: false, code: "INVALID_RULE" });

		const protoProxy = new Proxy({}, { getPrototypeOf() { throw new Error("proto-fired"); } });
		expect(() => parseSmartRoutingRules([protoProxy])).not.toThrow();
		expect(parseSmartRoutingRules([protoProxy])).toEqual({ ok: false, code: "INVALID_RULE" });

		const descriptorProxy = new Proxy(
			{ country: "BR", url: url("x") },
			{
				getPrototypeOf() { return Object.prototype; },
				ownKeys() { return ["country", "url"]; },
				getOwnPropertyDescriptor() { throw new Error("descriptor-fired"); },
			},
		);
		expect(() => parseSmartRoutingRules([descriptorProxy])).not.toThrow();
		expect(parseSmartRoutingRules([descriptorProxy])).toEqual({ ok: false, code: "INVALID_RULE" });
	});

	it("rejects symbol keys instead of ignoring them", () => {
		const rule: Record<string | symbol, unknown> = { country: "BR", url: url("symbol") };
		rule[Symbol("x")] = true;
		expect(parseSmartRoutingRules([rule])).toEqual({ ok: false, code: "INVALID_RULE" });
	});

	it("keeps UNKNOWN_KEY for unknown string keys on plain objects", () => {
		expect(parseSmartRoutingRules([{ country: "BR", url: url("x"), foo: true }])).toEqual({ ok: false, code: "UNKNOWN_KEY" });
	});

	it("never throws across a battery of hostile inputs", () => {
		const hostileInputs: unknown[] = [
			[Object.assign(Object.create(null), { country: "BR", url: url("x") })],
			[new Date()],
			[new String("x")],
			[Object.defineProperty({}, "url", { get() { throw new Error("boom"); }, configurable: true })],
			[new Proxy({}, { ownKeys() { throw new Error("k"); } })],
			[new Proxy({}, { getPrototypeOf() { throw new Error("p"); } })],
			[Symbol("s")],
			[(() => { const r: Record<string, unknown> = {}; Object.defineProperty(r, "url", { value: url("x") }); Object.defineProperty(r, "country", { value: "BR" }); return r; })()],
		];
		for (const rules of hostileInputs) {
			expect(() => parseSmartRoutingRules(rules)).not.toThrow();
		}
	});
});

describe("smart routing: bounds and no I/O", () => {
	it("processes at most MAX_RULES without calling fetch", () => {
		const parsed = parseSmartRoutingRules(twentyRules(1));
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) {
			return;
		}

		const fetchMock = vi.fn(() => {
			throw new Error("fetch must not be called by the pure domain");
		});
		vi.stubGlobal("fetch", fetchMock);

		try {
			const target = selectSmartRoutingTarget(parsed.rules, { country: "BR", device: "ios" }, url("fallback"));
			expect(typeof target).toBe("string");
			expect(matchSmartRoutingRule(parsed.rules, { country: "GB", device: "desktop" })?.country).toBe("GB");
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

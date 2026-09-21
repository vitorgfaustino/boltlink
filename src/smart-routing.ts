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

/**
 * Smart Routing domain (pure).
 *
 * Stateless first-match routing rules. This module has no Hono/D1/binding or
 * request-handler dependency and performs no I/O. It only validates,
 * canonicalizes and matches caller-provided data. Bot/human classification is
 * out of scope: the future integration calls this module after click-filtering.
 */

export type SmartRoutingDevice = "ios" | "android" | "desktop" | "other";

export type SmartRoutingRule = {
	country?: string;
	device?: SmartRoutingDevice;
	url: string;
};

export type SmartRoutingContext = {
	country: string | null;
	device: SmartRoutingDevice;
};

export type SmartRoutingErrorCode =
	| "NOT_ARRAY"
	| "EMPTY_RULES"
	| "TOO_MANY_RULES"
	| "INVALID_RULE"
	| "UNKNOWN_KEY"
	| "MISSING_MATCHER"
	| "INVALID_COUNTRY"
	| "INVALID_DEVICE"
	| "INVALID_URL"
	| "URL_TOO_LONG"
	| "DUPLICATE_MATCHER"
	| "SHADOWED_RULE"
	| "RULES_TOO_LARGE";

export type SmartRoutingParseResult =
	| { ok: true; rules: SmartRoutingRule[] }
	| { ok: false; code: SmartRoutingErrorCode };

export type SmartRoutingPersistedResult =
	| { status: "disabled"; rules: [] }
	| { status: "valid"; rules: SmartRoutingRule[] }
	| { status: "invalid"; rules: [] };

export const MAX_RULES = 20;
export const MAX_SERIALIZED_RULES_BYTES = 8192;
export const MAX_TARGET_URL_BYTES = 2048;
export const MAX_USER_AGENT_BYTES = 1024;

/** Static ISO 3166-1 alpha-2 codes. No external fetch/package. */
export const ISO_3166_ALPHA2_COUNTRIES: ReadonlySet<string> = new Set(
	(
		"AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ " +
		"BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
		"CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ " +
		"DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR " +
		"GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY " +
		"HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP " +
		"KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY " +
		"MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ " +
		"NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY " +
		"QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ " +
		"TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ " +
		"VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW"
	).split(" "),
);

const RULE_KEYS: ReadonlySet<string> = new Set(["country", "device", "url"]);
const DEVICES: ReadonlySet<string> = new Set(["ios", "android", "desktop", "other"]);

const encoder = new TextEncoder();

function utf8ByteLength(value: string): number {
	return encoder.encode(value).byteLength;
}

/**
 * Conservative transitional country normalization. Accepts only a canonical,
 * already-uppercase ISO 3166-1 alpha-2 code. Lowercase, padded, unknown and
 * non-string values become `null` (unknown); nothing is silently fixed.
 */
export function normalizeRequestCountry(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	if (value.length !== 2) {
		return null;
	}
	if (value !== value.toUpperCase()) {
		return null;
	}
	return ISO_3166_ALPHA2_COUNTRIES.has(value) ? value : null;
}

/**
 * Lightweight User-Agent device classification. Order matters: iOS tokens and
 * Android are checked before desktop (Android UAs also contain "linux"; iPadOS
 * reports "Macintosh" with "Mobile"). Oversized User-Agents are treated as
 * `other`. No regex, no dependency, no bot list (callers filter bots first).
 */
export function classifyDevice(userAgent: unknown): SmartRoutingDevice {
	if (typeof userAgent !== "string") {
		return "other";
	}
	if (utf8ByteLength(userAgent) > MAX_USER_AGENT_BYTES) {
		return "other";
	}

	const ua = userAgent.toLowerCase();
	if (ua.includes("iphone") || ua.includes("ipad") || ua.includes("ipod")) {
		return "ios";
	}
	if (ua.includes("android")) {
		return "android";
	}
	if (ua.includes("macintosh") && ua.includes("mobile")) {
		return "ios";
	}
	if (
		ua.includes("windows") ||
		ua.includes("macintosh") ||
		ua.includes("cros") ||
		ua.includes("x11") ||
		ua.includes("linux")
	) {
		return "desktop";
	}
	return "other";
}

function normalizeRuleUrl(value: unknown): { ok: true; url: string } | { ok: false; code: "INVALID_URL" | "URL_TOO_LONG" } {
	if (typeof value !== "string" || value.length === 0) {
		return { ok: false, code: "INVALID_URL" };
	}
	// Early resource guard on the raw input. It does NOT replace the canonical
	// byte check below: URL.toString() can percent-encode and grow the result.
	if (utf8ByteLength(value) > MAX_TARGET_URL_BYTES) {
		return { ok: false, code: "URL_TOO_LONG" };
	}

	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return { ok: false, code: "INVALID_URL" };
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return { ok: false, code: "INVALID_URL" };
	}
	if (!parsed.hostname.includes(".")) {
		return { ok: false, code: "INVALID_URL" };
	}

	const canonical = parsed.toString();
	if (utf8ByteLength(canonical) > MAX_TARGET_URL_BYTES) {
		return { ok: false, code: "URL_TOO_LONG" };
	}

	return { ok: true, url: canonical };
}

type RuleInspection =
	| { ok: true; descriptors: Map<string, PropertyDescriptor> }
	| { ok: false; code: SmartRoutingErrorCode };

/**
 * Fail-closed, prototype-preserving inspection of a single rule.
 *
 * Only plain JSON-like objects (prototype === Object.prototype) are accepted.
 * All observable introspection runs inside try/catch so getters, accessors,
 * hostile Proxies and exotic objects become a structured INVALID_RULE instead
 * of propagating an exception. Values are read from own DATA descriptors, so
 * accessors are rejected and never executed.
 */
function inspectPlainRule(value: unknown): RuleInspection {
	try {
		if (value === null || typeof value !== "object" || Array.isArray(value)) {
			return { ok: false, code: "INVALID_RULE" };
		}

		if (Object.getPrototypeOf(value) !== Object.prototype) {
			return { ok: false, code: "INVALID_RULE" };
		}

		const ownKeys = Reflect.ownKeys(value);
		if (ownKeys.some((key) => typeof key !== "string")) {
			return { ok: false, code: "INVALID_RULE" };
		}

		const keys = ownKeys as string[];
		if (keys.some((key) => !RULE_KEYS.has(key))) {
			return { ok: false, code: "UNKNOWN_KEY" };
		}

		const descriptors = new Map<string, PropertyDescriptor>();
		for (const key of keys) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor || descriptor.get !== undefined || descriptor.set !== undefined) {
				return { ok: false, code: "INVALID_RULE" };
			}
			descriptors.set(key, descriptor);
		}

		return { ok: true, descriptors };
	} catch {
		return { ok: false, code: "INVALID_RULE" };
	}
}

function matcherKey(rule: SmartRoutingRule): string {
	return `${rule.country ?? "*"}|${rule.device ?? "*"}`;
}

function shadows(previous: SmartRoutingRule, candidate: SmartRoutingRule): boolean {
	if (previous.country !== undefined && previous.country !== candidate.country) {
		return false;
	}
	if (previous.device !== undefined && previous.device !== candidate.device) {
		return false;
	}
	return true;
}

function hasShadowedRule(rules: SmartRoutingRule[]): boolean {
	for (let index = 1; index < rules.length; index += 1) {
		for (let previous = 0; previous < index; previous += 1) {
			if (shadows(rules[previous], rules[index])) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Validates and canonicalizes an administrative rules array. Returns a
 * structured result; never throws and never logs. Order is preserved,
 * duplicate matchers and fully shadowed rules are rejected, and the serialized
 * JSON is bounded by MAX_SERIALIZED_RULES_BYTES (UTF-8).
 */
export function parseSmartRoutingRules(value: unknown): SmartRoutingParseResult {
	if (!Array.isArray(value)) {
		return { ok: false, code: "NOT_ARRAY" };
	}
	if (value.length === 0) {
		return { ok: false, code: "EMPTY_RULES" };
	}
	if (value.length > MAX_RULES) {
		return { ok: false, code: "TOO_MANY_RULES" };
	}

	const rules: SmartRoutingRule[] = [];
	const matchers = new Set<string>();

	for (const item of value) {
		const inspection = inspectPlainRule(item);
		if (!inspection.ok) {
			return { ok: false, code: inspection.code };
		}

		const { descriptors } = inspection;
		const hasCountry = descriptors.has("country");
		const hasDevice = descriptors.has("device");
		if (!hasCountry && !hasDevice) {
			return { ok: false, code: "MISSING_MATCHER" };
		}

		if (!descriptors.has("url")) {
			return { ok: false, code: "INVALID_URL" };
		}

		let country: string | undefined;
		if (hasCountry) {
			const countryValue = descriptors.get("country")!.value as unknown;
			if (
				typeof countryValue !== "string" ||
				countryValue !== countryValue.toUpperCase() ||
				!ISO_3166_ALPHA2_COUNTRIES.has(countryValue)
			) {
				return { ok: false, code: "INVALID_COUNTRY" };
			}
			country = countryValue;
		}

		let device: SmartRoutingDevice | undefined;
		if (hasDevice) {
			const deviceValue = descriptors.get("device")!.value as unknown;
			if (typeof deviceValue !== "string" || !DEVICES.has(deviceValue)) {
				return { ok: false, code: "INVALID_DEVICE" };
			}
			device = deviceValue as SmartRoutingDevice;
		}

		const normalizedUrl = normalizeRuleUrl(descriptors.get("url")!.value as unknown);
		if (!normalizedUrl.ok) {
			return { ok: false, code: normalizedUrl.code };
		}

		const rule: SmartRoutingRule = {
			...(country !== undefined ? { country } : {}),
			...(device !== undefined ? { device } : {}),
			url: normalizedUrl.url,
		};

		const key = matcherKey(rule);
		if (matchers.has(key)) {
			return { ok: false, code: "DUPLICATE_MATCHER" };
		}

		rules.push(rule);
		matchers.add(key);
	}

	if (hasShadowedRule(rules)) {
		return { ok: false, code: "SHADOWED_RULE" };
	}

	if (utf8ByteLength(JSON.stringify(rules)) > MAX_SERIALIZED_RULES_BYTES) {
		return { ok: false, code: "RULES_TOO_LARGE" };
	}

	return { ok: true, rules };
}

/**
 * Safe reader for the future persisted column (`links.smart_routing_rules`).
 * Broken JSON or invalid content never throws: the runtime can fall back.
 */
export function parsePersistedSmartRoutingRules(raw: string | null | undefined): SmartRoutingPersistedResult {
	if (raw === null || raw === undefined) {
		return { status: "disabled", rules: [] };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { status: "invalid", rules: [] };
	}

	const result = parseSmartRoutingRules(parsed);
	if (!result.ok) {
		return { status: "invalid", rules: [] };
	}

	return { status: "valid", rules: result.rules };
}

/**
 * First-match-wins selection. A rule with `country` only matches when the
 * context country equals it (unknown/null never matches); a rule with `device`
 * only matches on the exact device; combined rules require both.
 */
export function matchSmartRoutingRule(
	rules: readonly SmartRoutingRule[],
	context: SmartRoutingContext,
): SmartRoutingRule | null {
	for (const rule of rules) {
		if (rule.country !== undefined && (context.country === null || rule.country !== context.country)) {
			continue;
		}
		if (rule.device !== undefined && rule.device !== context.device) {
			continue;
		}
		return rule;
	}
	return null;
}

export function selectSmartRoutingTarget(
	rules: readonly SmartRoutingRule[],
	context: SmartRoutingContext,
	fallback: string,
): string {
	const match = matchSmartRoutingRule(rules, context);
	return match ? match.url : fallback;
}

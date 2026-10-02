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
 * BoltLink Portability Format v1 — export serializer (published in 3.0.0; origin Phase 5, Gate 5.2).
 *
 * The artifact produced here is a **logical configuration** export, not a database
 * backup. A complete D1 backup remains the only mechanism that restores hashes,
 * counters and operational metadata; nothing in this module is a substitute for it.
 *
 * What the format carries is the administrative intent an operator would have to
 * retype: destination, redirect type, tags, group membership, lifecycle, the fact
 * that a password exists, and the routing configuration. What it deliberately never
 * carries:
 *
 * - `password_hash` (the SELECT computes a boolean instead, so the hash never even
 *   enters this module's memory);
 * - metrics (`clicks_total`, `ab_clicks_*`, `ab_started_at`);
 * - internal state (`version`, `metric_epoch`, `ab_generation`, `has_qrcode`);
 * - internal D1 identifiers: groups get document-local `ref`s and links are tied to
 *   them through `groupRef`, so nothing here depends on the destination database's
 *   row ids.
 *
 * Two properties are load-bearing and are the reason this is a module rather than a
 * few lines in the handler:
 *
 * 1. **Fail closed.** Any persisted row the current BoltLink would not accept today
 *    refuses the whole export with a controlled error. There is no row skipping, no
 *    field dropping, no repair and no partial document: a configuration that cannot
 *    be re-applied must not be presented as if it could.
 * 2. **Determinism.** Groups and links are ordered by a total, locale-independent
 *    comparator and the `ref`s derive from that order, so the same configuration
 *    always yields the same functional document. Only `exportedAt` varies.
 *
 * The format version evolves independently from the product version: `schemaVersion`
 * is the format's own identity and never mirrors `package.json`.
 */

import { analyzeGroupHierarchy, isCanonicalGroupName } from "./group-hierarchy";
import { parsePersistedSmartRoutingRules } from "./smart-routing";
import type { SmartRoutingRule } from "./smart-routing";

/** Format identity. Independent from the product version on purpose. */
export const PORTABILITY_FORMAT = "boltlink-portability";
/** Literal format revision consumed by the future import (Gate 5.3). */
export const PORTABILITY_SCHEMA_VERSION = 1;

/**
 * Bounded export. The limits are deliberately small: the artifact is a portable
 * configuration, and an operator above them is better served by a database backup
 * than by a document nobody can review. They are never applied by truncation.
 */
export const PORTABILITY_MAX_GROUPS = 50;
export const PORTABILITY_MAX_LINKS = 100;
export const PORTABILITY_MAX_BYTES = 256 * 1024;

/**
 * Download filename. A constant, never derived from persisted data or from a
 * request value, so no user-controlled string can reach `Content-Disposition`.
 */
export const PORTABILITY_EXPORT_FILENAME = "boltlink-export.json";

/** Document-local group reference, e.g. `g1`. Unique inside one document. */
export type PortabilityGroupV1 = {
	ref: string;
	name: string;
	parentRef: string | null;
};

/**
 * A/B configuration without its outcomes. `enabled` is the effective switch; a
 * destination retained while the split is off is real persisted configuration, so
 * it is carried instead of dropped.
 */
export type PortabilityAbTestV1 = {
	enabled: boolean;
	variantBUrl: string | null;
	weightB: number;
};

/**
 * One link's administrative configuration. Capability-backed properties are only
 * present when the database carries the corresponding column, which mirrors how the
 * administrative API already reports a pre-migration database: absence means "this
 * database has no such feature", never "configured as null".
 */
export type PortabilityLinkV1 = {
	slug: string;
	targetUrl: string;
	redirectType: "301" | "302";
	tags: string[];
	groupRef: string | null;
	disabled: boolean;
	goLiveAt: string | null;
	expiresAt: string | null;
	expiredRedirectUrl?: string | null;
	passwordProtected: boolean;
	abTest?: PortabilityAbTestV1;
	smartRouting?: SmartRoutingRule[] | null;
};

export type PortabilityDocumentV1 = {
	format: typeof PORTABILITY_FORMAT;
	schemaVersion: 1;
	exportedAt: string;
	groups: PortabilityGroupV1[];
	links: PortabilityLinkV1[];
};

/** Raw `link_groups` row. Persisted values are `unknown`: external SQL can write anything. */
export type PortabilityGroupRow = {
	id: unknown;
	name: unknown;
	parent_id: unknown;
};

/**
 * Raw `links` row, projected to the fields the format reasons about. `has_password`
 * is deliberately a flag: the hash is never selected, so it cannot be leaked by a
 * later mistake in this module.
 */
export type PortabilityLinkRow = {
	slug: unknown;
	target_url: unknown;
	redirect_type: unknown;
	tags: unknown;
	group_id: unknown;
	disabled_at: unknown;
	go_live_at: unknown;
	expires_at: unknown;
	has_password: unknown;
	ab_enabled?: unknown;
	ab_target_url?: unknown;
	ab_weight_b?: unknown;
	smart_routing_rules?: unknown;
	expired_redirect_url?: unknown;
};

/**
 * Product rules injected from the runtime. Slug syntax/reservation and the
 * destination policy already live in the worker as the single authority for every
 * other write path; passing them in keeps this module free of a second, drifting
 * copy of the rules while still letting it decide alone what is exportable.
 */
export type PortabilityValidationPolicy = {
	isValidSlug(slug: string): boolean;
	normalizeUrl(candidate: string | undefined): string | null;
};

/** Migration level of the database being exported, as detected by the runtime. */
export type PortabilityCapabilities = {
	abTesting: boolean;
	smartRouting: boolean;
	expiredRedirect: boolean;
};

export type PortabilityErrorCode =
	| "TOO_MANY_GROUPS"
	| "TOO_MANY_LINKS"
	| "TOO_LARGE"
	| "GROUP_HIERARCHY_CORRUPT"
	| "INVALID_GROUP_ROW"
	| "INVALID_LINK_ROW"
	| "DANGLING_GROUP_REFERENCE"
	| "INVALID_SLUG"
	| "INVALID_TARGET_URL"
	| "INVALID_REDIRECT_TYPE"
	| "INVALID_TAGS"
	| "INVALID_LIFECYCLE"
	| "INVALID_EXPIRED_REDIRECT"
	| "INVALID_AB_CONFIG"
	| "INVALID_SMART_ROUTING"
	| "CONFLICTING_ROUTING_CONFIG";

/**
 * Status policy, decided once and documented here because it was an explicit Gate
 * 5.2 choice:
 *
 * - `413` for a state that exists but is beyond the portability budget (too many
 *   groups, too many links, document above the byte ceiling). The configuration is
 *   not broken, it is simply outside the format's envelope — and the answer is never
 *   a truncated document.
 * - `409` for a state that cannot be exported because BoltLink itself would refuse
 *   it today: it is not a request problem, so 400 would mislead, and it is not a
 *   server fault, so 500 would too.
 */
export type PortabilityExportFailure = {
	ok: false;
	status: 409 | 413;
	code: PortabilityErrorCode;
	error: string;
};

export type PortabilityExportSuccess = {
	ok: true;
	document: PortabilityDocumentV1;
	body: string;
	bytes: number;
};

export type PortabilityExportResult = PortabilityExportSuccess | PortabilityExportFailure;

const PORTABILITY_ERROR_MESSAGES: Record<PortabilityErrorCode, string> = {
	TOO_MANY_GROUPS: "Portability export refused: group limit exceeded",
	TOO_MANY_LINKS: "Portability export refused: link limit exceeded",
	TOO_LARGE: "Portability export refused: document exceeds the size limit",
	GROUP_HIERARCHY_CORRUPT: "Portability export refused: group hierarchy is corrupt",
	INVALID_GROUP_ROW: "Portability export refused: invalid group row",
	INVALID_LINK_ROW: "Portability export refused: invalid link row",
	DANGLING_GROUP_REFERENCE: "Portability export refused: link references a missing group",
	INVALID_SLUG: "Portability export refused: invalid slug",
	INVALID_TARGET_URL: "Portability export refused: invalid destination URL",
	INVALID_REDIRECT_TYPE: "Portability export refused: invalid redirect type",
	INVALID_TAGS: "Portability export refused: invalid tags",
	INVALID_LIFECYCLE: "Portability export refused: invalid lifecycle",
	INVALID_EXPIRED_REDIRECT: "Portability export refused: invalid expired destination",
	INVALID_AB_CONFIG: "Portability export refused: invalid A/B configuration",
	INVALID_SMART_ROUTING: "Portability export refused: invalid Smart Routing configuration",
	CONFLICTING_ROUTING_CONFIG: "Portability export refused: A/B and Smart Routing cannot both be active",
};

const encoder = new TextEncoder();

/** UTF-8 byte length, because the budget is bytes and JavaScript counts UTF-16 units. */
function utf8ByteLength(value: string): number {
	return encoder.encode(value).byteLength;
}

/**
 * Every failure is built here, so no message can ever interpolate a raw column
 * value. The optional detail carries the row's *logical identity* only — a slug for
 * a link, a group name for a group — which is what makes a refusal actionable and is
 * already visible in the panel. Raw SQL, SQLite errors, stacks, hashes and secrets
 * never reach a caller.
 */
function fail(status: 409 | 413, code: PortabilityErrorCode, detail?: string): PortabilityExportFailure {
	const base = PORTABILITY_ERROR_MESSAGES[code];
	return { ok: false, status, code, error: detail ? `${base}: ${detail}` : base };
}

function linkSubject(slug: unknown): string {
	return typeof slug === "string" ? `link "${slug}"` : "link";
}

/**
 * Storage contract of every timestamp the product writes: `Date#toISOString()`,
 * i.e. an ISO-8601 UTC instant. A value in any other shape (an offset form, a naive
 * local datetime, a number) was not produced by BoltLink and is not one BoltLink
 * would accept on write, so it is corruption rather than something to normalize.
 */
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export type Resolved<T> = { ok: true; value: T } | { ok: false };

/**
 * Instant rule of the format, shared by both directions. The import reuses this exact
 * function instead of restating the rule, so a value can never be accepted by one
 * direction and refused by the other: `Date#toISOString()` is the only shape BoltLink
 * stores, which is why an offset form, a naive local datetime or a number is refused
 * rather than reinterpreted in some timezone.
 */
export function resolvePersistedInstant(raw: unknown): Resolved<string | null> {
	if (raw === null || raw === undefined) {
		return { ok: true, value: null };
	}
	if (typeof raw !== "string" || !ISO_INSTANT_PATTERN.test(raw)) {
		return { ok: false };
	}

	const timestamp = Date.parse(raw);
	if (Number.isNaN(timestamp)) {
		return { ok: false };
	}

	// Canonical form, so two semantically equal instants can never serialize
	// differently depending on how many fractional digits were stored.
	return { ok: true, value: new Date(timestamp).toISOString() };
}

function resolvePersistedUrl(raw: unknown, policy: PortabilityValidationPolicy): Resolved<string | null> {
	if (raw === null || raw === undefined) {
		return { ok: true, value: null };
	}
	if (typeof raw !== "string") {
		return { ok: false };
	}

	const normalized = policy.normalizeUrl(raw);
	if (!normalized) {
		return { ok: false };
	}

	return { ok: true, value: normalized };
}

/**
 * Stored tags are the JSON array `normalizeTags` writes: trimmed, non-empty strings,
 * at most 50, in the operator's order. That order is preserved here — the product
 * never sorts tags, so sorting them during export would be a silent rewrite.
 *
 * Exported for {@link ./portability-import}, which feeds the document's array through
 * `JSON.stringify` into this same function: the import then accepts exactly the shape
 * the export emits, instead of restating the rule and drifting from it.
 */
export function resolvePersistedTags(raw: unknown): Resolved<string[]> {
	if (raw === null || raw === undefined) {
		return { ok: true, value: [] };
	}
	if (typeof raw !== "string") {
		return { ok: false };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { ok: false };
	}

	if (!Array.isArray(parsed) || parsed.length > 50) {
		return { ok: false };
	}

	const tags: string[] = [];
	for (const entry of parsed) {
		if (typeof entry !== "string" || entry.trim().length === 0 || entry !== entry.trim()) {
			return { ok: false };
		}
		tags.push(entry);
	}

	return { ok: true, value: tags };
}

/**
 * Total, locale-independent group order: case-folded name, then the exact name for
 * case ties, then the internal id. The id is a tiebreaker for ordering only and is
 * never exported, so duplicate names still produce distinct, stable `ref`s.
 */
function compareGroups(
	left: { name: string; id: number },
	right: { name: string; id: number },
): number {
	const leftFolded = left.name.toLowerCase();
	const rightFolded = right.name.toLowerCase();
	if (leftFolded !== rightFolded) {
		return leftFolded < rightFolded ? -1 : 1;
	}
	if (left.name !== right.name) {
		return left.name < right.name ? -1 : 1;
	}
	return left.id - right.id;
}

/**
 * Link order is the slug order: the slug is the link's public logical identity and
 * unique per instance, so the order is total without depending on insertion order.
 */
function compareLinks(left: PortabilityLinkRow, right: PortabilityLinkRow): number {
	const leftSlug = String(left.slug);
	const rightSlug = String(right.slug);
	if (leftSlug !== rightSlug) {
		return leftSlug < rightSlug ? -1 : 1;
	}
	const leftTarget = String(left.target_url);
	const rightTarget = String(right.target_url);
	if (leftTarget !== rightTarget) {
		return leftTarget < rightTarget ? -1 : 1;
	}
	return 0;
}

type GroupReferenceMap = Map<number, string>;

function buildGroups(
	rows: PortabilityGroupRow[],
): { ok: true; groups: PortabilityGroupV1[]; refs: GroupReferenceMap } | PortabilityExportFailure {
	const normalized: Array<{ id: number; name: string; parentId: number | null }> = [];

	for (const row of rows) {
		const { id, name, parent_id: parentId } = row;
		if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
			return fail(409, "INVALID_GROUP_ROW");
		}
		// A group name is exported only in the exact form the write paths store. A
		// padded, whitespace-only or over-ceiling value cannot come from the API, so it
		// is corruption rather than something to trim into shape: normalizing it here
		// would export a name the database does not contain.
		if (!isCanonicalGroupName(name)) {
			return fail(409, "INVALID_GROUP_ROW");
		}
		if (
			parentId !== null
			&& (typeof parentId !== "number" || !Number.isInteger(parentId) || parentId <= 0)
		) {
			return fail(409, "INVALID_GROUP_ROW", `group "${name}"`);
		}
		normalized.push({ id, name, parentId });
	}

	// Cycle and dangling parent are decided by the approved Gate 5.1 analysis rather
	// than by a second traversal with its own rules. An uninterpretable graph is
	// refused whole: no promotion to root, no row skipping, no partial tree.
	if (!analyzeGroupHierarchy(normalized.map((group) => ({ id: group.id, parent_id: group.parentId }))).ok) {
		return fail(409, "GROUP_HIERARCHY_CORRUPT");
	}

	// No depth ceiling here on purpose. `MAX_GROUP_DEPTH` governs new writes and
	// moves; a legacy tree that is already deeper is structurally valid and must stay
	// transportable, otherwise the export could not be used to migrate away from it.
	normalized.sort(compareGroups);

	// Two passes: every ref exists before any `parentRef` is read, so a parent that
	// sorts after its child still resolves.
	const refs: GroupReferenceMap = new Map();
	normalized.forEach((group, index) => {
		refs.set(group.id, `g${index + 1}`);
	});

	const groups: PortabilityGroupV1[] = [];
	for (const group of normalized) {
		const ref = refs.get(group.id);
		if (ref === undefined) {
			return fail(409, "GROUP_HIERARCHY_CORRUPT");
		}

		let parentRef: string | null = null;
		if (group.parentId !== null) {
			const resolved = refs.get(group.parentId);
			if (resolved === undefined) {
				return fail(409, "GROUP_HIERARCHY_CORRUPT");
			}
			parentRef = resolved;
		}

		groups.push({ ref, name: group.name, parentRef });
	}

	return { ok: true, groups, refs };
}

function buildLink(
	row: PortabilityLinkRow,
	refs: GroupReferenceMap,
	capabilities: PortabilityCapabilities,
	policy: PortabilityValidationPolicy,
): { ok: true; link: PortabilityLinkV1 } | PortabilityExportFailure {
	const subject = linkSubject(row.slug);

	const slug = row.slug;
	if (typeof slug !== "string" || !policy.isValidSlug(slug)) {
		return fail(409, "INVALID_SLUG", subject);
	}

	const targetUrl = resolvePersistedUrl(row.target_url, policy);
	if (!targetUrl.ok || targetUrl.value === null) {
		return fail(409, "INVALID_TARGET_URL", subject);
	}

	const redirectType = row.redirect_type;
	if (redirectType !== "301" && redirectType !== "302") {
		return fail(409, "INVALID_REDIRECT_TYPE", subject);
	}

	const tags = resolvePersistedTags(row.tags);
	if (!tags.ok) {
		return fail(409, "INVALID_TAGS", subject);
	}

	const groupId = row.group_id;
	let groupRef: string | null = null;
	if (groupId !== null && groupId !== undefined) {
		if (typeof groupId !== "number" || !Number.isInteger(groupId) || groupId <= 0) {
			return fail(409, "DANGLING_GROUP_REFERENCE", subject);
		}
		const resolved = refs.get(groupId);
		if (resolved === undefined) {
			// The group set was read before the links, so a group missing here means the
			// link points at something the snapshot does not contain. Exporting the link
			// with a dangling `groupRef` would make the document unusable; dropping the
			// membership would be a silent rewrite.
			return fail(409, "DANGLING_GROUP_REFERENCE", subject);
		}
		groupRef = resolved;
	}

	const goLiveAt = resolvePersistedInstant(row.go_live_at);
	const expiresAt = resolvePersistedInstant(row.expires_at);
	if (!goLiveAt.ok || !expiresAt.ok) {
		return fail(409, "INVALID_LIFECYCLE", subject);
	}
	// Both values are canonical `toISOString()` at this point, so the comparison is a
	// plain string comparison of same-shaped UTC instants.
	if (goLiveAt.value !== null && expiresAt.value !== null && expiresAt.value < goLiveAt.value) {
		return fail(409, "INVALID_LIFECYCLE", subject);
	}

	const hasPassword = row.has_password;
	if (hasPassword !== 0 && hasPassword !== 1) {
		return fail(409, "INVALID_LINK_ROW", subject);
	}

	let expiredRedirectUrl: string | null | undefined;
	if (capabilities.expiredRedirect) {
		const resolved = resolvePersistedUrl(row.expired_redirect_url, policy);
		if (!resolved.ok) {
			return fail(409, "INVALID_EXPIRED_REDIRECT", subject);
		}
		// Administrative invariant of the feature: the destination is only reachable
		// after `expires_at` elapses, so a stored destination without an expiration is
		// a dormant configuration the product refuses on write.
		if (resolved.value !== null && expiresAt.value === null) {
			return fail(409, "INVALID_EXPIRED_REDIRECT", subject);
		}
		expiredRedirectUrl = resolved.value;
	}

	let abTest: PortabilityAbTestV1 | undefined;
	if (capabilities.abTesting) {
		const enabled = row.ab_enabled === 1;
		if (row.ab_enabled !== 0 && row.ab_enabled !== 1) {
			return fail(409, "INVALID_AB_CONFIG", subject);
		}

		const variantBUrl = resolvePersistedUrl(row.ab_target_url, policy);
		if (!variantBUrl.ok) {
			return fail(409, "INVALID_AB_CONFIG", subject);
		}

		const weightB = row.ab_weight_b;
		if (typeof weightB !== "number" || !Number.isInteger(weightB) || weightB < 1 || weightB > 99) {
			return fail(409, "INVALID_AB_CONFIG", subject);
		}

		if (enabled && variantBUrl.value === null) {
			return fail(409, "INVALID_AB_CONFIG", subject);
		}
		// Matches the write invariant "A/B testing requires a temporary redirect": the
		// split is a runtime decision, and a permanent redirect would freeze one answer.
		if (enabled && redirectType === "301") {
			return fail(409, "INVALID_AB_CONFIG", subject);
		}

		abTest = { enabled, variantBUrl: variantBUrl.value, weightB };
	}

	let smartRouting: SmartRoutingRule[] | null | undefined;
	if (capabilities.smartRouting) {
		const raw = row.smart_routing_rules;
		if (raw === null || raw === undefined) {
			// NULL is the documented "Smart Routing disabled" state for this column.
			smartRouting = null;
		} else {
			// The approved reader classifies the persisted bytes. Only a valid canonical
			// configuration is transmissible: a corrupt value is refused, never converted
			// into "disabled" and never repaired, exactly as the administrative API
			// preserves it instead of erasing it. A non-string value (external SQL) is
			// handed over as NULL, which that reader already classifies as unreadable.
			const persisted = parsePersistedSmartRoutingRules(typeof raw === "string" ? raw : null);
			if (persisted.status !== "valid") {
				return fail(409, "INVALID_SMART_ROUTING", subject);
			}
			// Order is semantic (first match wins) so the rules travel exactly as stored.
			if (redirectType === "301") {
				return fail(409, "INVALID_SMART_ROUTING", subject);
			}
			smartRouting = persisted.rules;
		}
	}

	// The two routing features are mutually exclusive. The API tolerates a legacy
	// hybrid row so it stays editable, but a document carrying both routing
	// configurations is not re-appliable, so it is refused instead of exported as if
	// it were valid.
	if (abTest?.enabled && smartRouting !== null && smartRouting !== undefined) {
		return fail(409, "CONFLICTING_ROUTING_CONFIG", subject);
	}

	return {
		ok: true,
		link: {
			slug,
			targetUrl: targetUrl.value,
			redirectType,
			tags: tags.value,
			groupRef,
			// Retained for compatibility with legacy v1 imports. Normal exports select
			// only active links; recovery validation can also inspect a tombstone.
			disabled: row.disabled_at !== null && row.disabled_at !== undefined,
			goLiveAt: goLiveAt.value,
			expiresAt: expiresAt.value,
			// Key order is fixed by construction so the serialized form is stable.
			...(capabilities.expiredRedirect ? { expiredRedirectUrl: expiredRedirectUrl ?? null } : {}),
			passwordProtected: hasPassword === 1,
			...(capabilities.abTesting ? { abTest } : {}),
			...(capabilities.smartRouting ? { smartRouting } : {}),
		},
	};
}

/** Shared persisted configuration validation for recovery, without export size limits. */
export function validateRecoverableLink(
	row: PortabilityLinkRow,
	groups: PortabilityGroupRow[],
	capabilities: PortabilityCapabilities,
	policy: PortabilityValidationPolicy,
) {
	const builtGroups = buildGroups(groups);
	if (!builtGroups.ok) return builtGroups;
	return buildLink(row, builtGroups.refs, capabilities, policy);
}

function buildLinks(
	rows: PortabilityLinkRow[],
	refs: GroupReferenceMap,
	capabilities: PortabilityCapabilities,
	policy: PortabilityValidationPolicy,
): { ok: true; links: PortabilityLinkV1[] } | PortabilityExportFailure {
	const ordered = [...rows].sort(compareLinks);
	const links: PortabilityLinkV1[] = [];

	for (const row of ordered) {
		const built = buildLink(row, refs, capabilities, policy);
		if (!built.ok) {
			return built;
		}
		links.push(built.link);
	}

	return { ok: true, links };
}

/**
 * Serializes the real document and then measures it, so the byte ceiling applies to
 * what would actually be downloaded. Neither the document nor the response is ever
 * truncated to fit.
 */
export function serializePortabilityDocument(document: PortabilityDocumentV1): PortabilityExportResult {
	const body = JSON.stringify(document);
	const bytes = utf8ByteLength(body);
	if (bytes > PORTABILITY_MAX_BYTES) {
		return fail(413, "TOO_LARGE", `${bytes} bytes, limit ${PORTABILITY_MAX_BYTES}`);
	}

	return { ok: true, document, body, bytes };
}

export type PortabilityExportInput = {
	/**
	 * Counts read before the rows. They are what keeps an oversized instance from
	 * being loaded into memory; the loaded lengths are checked again afterwards so a
	 * concurrent insert cannot slip past the pre-count.
	 */
	counts: { groups: number; links: number };
	groups: PortabilityGroupRow[];
	links: PortabilityLinkRow[];
	capabilities: PortabilityCapabilities;
	policy: PortabilityValidationPolicy;
	/** Informative metadata only: not part of the format identity. */
	exportedAt: string;
};

/**
 * Builds the v1 document from persisted rows. Pure: no binding, no D1, no clock —
 * `exportedAt` is passed in, which is what makes the determinism of the functional
 * payload testable.
 */
export function buildPortabilityExport(input: PortabilityExportInput): PortabilityExportResult {
	const { counts, groups: groupRows, links: linkRows, capabilities, policy, exportedAt } = input;

	if (counts.groups > PORTABILITY_MAX_GROUPS) {
		return fail(413, "TOO_MANY_GROUPS", `${counts.groups} groups, limit ${PORTABILITY_MAX_GROUPS}`);
	}
	if (counts.links > PORTABILITY_MAX_LINKS) {
		return fail(413, "TOO_MANY_LINKS", `${counts.links} links, limit ${PORTABILITY_MAX_LINKS}`);
	}
	if (groupRows.length > PORTABILITY_MAX_GROUPS) {
		return fail(413, "TOO_MANY_GROUPS", `${groupRows.length} groups, limit ${PORTABILITY_MAX_GROUPS}`);
	}
	if (linkRows.length > PORTABILITY_MAX_LINKS) {
		return fail(413, "TOO_MANY_LINKS", `${linkRows.length} links, limit ${PORTABILITY_MAX_LINKS}`);
	}

	const builtGroups = buildGroups(groupRows);
	if (!builtGroups.ok) {
		return builtGroups;
	}

	const builtLinks = buildLinks(linkRows, builtGroups.refs, capabilities, policy);
	if (!builtLinks.ok) {
		return builtLinks;
	}

	return serializePortabilityDocument({
		format: PORTABILITY_FORMAT,
		schemaVersion: PORTABILITY_SCHEMA_VERSION,
		exportedAt,
		groups: builtGroups.groups,
		links: builtLinks.links,
	});
}

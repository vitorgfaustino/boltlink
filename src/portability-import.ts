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
 * BoltLink Portability Format v1 — import domain (Unreleased / Phase 5, Gate 5.3).
 *
 * The inverse of {@link ./portability}: it consumes exactly the document the export
 * produces and turns it into the statements that rebuild the configuration. Like the
 * export, this module is pure — no D1, no binding, no clock beyond the instant the
 * caller passes in — so the whole format contract is testable without a database.
 *
 * Two properties decide the design.
 *
 * 1. **Strictness.** A document is a machine-written artifact, not a form: every key,
 *    type and shape is checked against the frozen V1 contract, unknown fields are
 *    refused instead of ignored, and nothing is coerced (`"true"` is not `true`,
 *    `"302"` is not `302`). A file that was not produced by the export is far more
 *    likely to be a different file than a slightly-off one, and repairing it silently
 *    would rebuild a configuration the operator never reviewed — which is why the
 *    rules the export applies to persisted rows (canonical group names, canonical
 *    instants, canonical tags) are applied verbatim here, through the same functions.
 *
 * 2. **Atomicity by construction.** The import never computes a destination id it
 *    cannot guarantee: every group is inserted with an id derived from the table
 *    *inside the statement that inserts it*, and every link resolves its group by an
 *    offset from that same state, all inside one `batch()` — one SQL transaction. A
 *    destination that changed since the preview (a slug taken meanwhile) makes the
 *    batch abort and roll back, so the outcome is either the whole document or
 *    nothing. No temporary table, no auxiliary column, no migration.
 */

import { MAX_GROUP_DEPTH, analyzeGroupHierarchy, isCanonicalGroupName } from "./group-hierarchy";
import {
	PORTABILITY_FORMAT,
	PORTABILITY_MAX_GROUPS,
	PORTABILITY_MAX_LINKS,
	PORTABILITY_SCHEMA_VERSION,
	resolvePersistedInstant,
	resolvePersistedTags,
} from "./portability";
import { parseSmartRoutingRules } from "./smart-routing";

/**
 * Transport allowance on top of the document ceiling: the envelope keys, the
 * replacement passwords and their JSON overhead. The document itself is still
 * measured against {@link PORTABILITY_MAX_BYTES} after parsing, so the format limit
 * is exact and this bound exists only so an oversized body is refused before it is
 * parsed instead of being buffered.
 */
export const PORTABILITY_IMPORT_ENVELOPE_SLACK_BYTES = 64 * 1024;

/** Bounded error report: an unreadable file must not answer with a hundred lines. */
export const PORTABILITY_IMPORT_MAX_ERRORS = 20;

/** Replacement passwords are never persisted and never echoed; only their hash is. */
export const PORTABILITY_IMPORT_ENVELOPE_KEYS: ReadonlySet<string> = new Set(["document", "replacementPasswords"]);

/**
 * Group references travel inside one document only: they are never persisted, never
 * resolved against the destination and never used as a key. The ceiling exists so a
 * hostile document cannot make an error message unbounded.
 */
const MAX_REF_LENGTH = 64;

const LINK_KEYS: ReadonlySet<string> = new Set([
	"slug",
	"targetUrl",
	"redirectType",
	"tags",
	"groupRef",
	"disabled",
	"goLiveAt",
	"expiresAt",
	"passwordProtected",
	"expiredRedirectUrl",
	"abTest",
	"smartRouting",
]);

/** Required on every link: the export always writes them, so absence means a broken file. */
const LINK_REQUIRED_KEYS = [
	"slug",
	"targetUrl",
	"redirectType",
	"tags",
	"groupRef",
	"disabled",
	"goLiveAt",
	"expiresAt",
	"passwordProtected",
] as const;

const GROUP_KEYS: ReadonlySet<string> = new Set(["ref", "name", "parentRef"]);
const AB_KEYS: ReadonlySet<string> = new Set(["enabled", "variantBUrl", "weightB"]);
const DOCUMENT_KEYS: ReadonlySet<string> = new Set(["format", "schemaVersion", "exportedAt", "groups", "links"]);

/**
 * Every refusal this format can produce. `INVALID_*` codes describe the document;
 * the limit codes describe a document outside the format envelope, which the export
 * answers with `413` in the other direction as well.
 */
export type PortabilityImportErrorCode =
	| "INVALID_BODY"
	| "INVALID_DOCUMENT"
	| "UNKNOWN_FIELD"
	| "UNSUPPORTED_FORMAT"
	| "UNSUPPORTED_SCHEMA_VERSION"
	| "TOO_MANY_GROUPS"
	| "TOO_MANY_LINKS"
	| "TOO_LARGE"
	| "INVALID_GROUP_ENTRY"
	| "INVALID_GROUP_NAME"
	| "INVALID_GROUP_REF"
	| "DUPLICATE_GROUP_REF"
	| "DANGLING_PARENT_REF"
	| "GROUP_CYCLE"
	| "INVALID_LINK_ENTRY"
	| "DUPLICATE_LINK_SLUG"
	| "INVALID_SLUG"
	| "INVALID_TARGET_URL"
	| "INVALID_REDIRECT_TYPE"
	| "INVALID_TAGS"
	| "DANGLING_GROUP_REF"
	| "INVALID_LIFECYCLE"
	| "INVALID_EXPIRED_REDIRECT"
	| "INVALID_AB_CONFIG"
	| "INVALID_SMART_ROUTING"
	| "CONFLICTING_ROUTING_CONFIG"
	| "INVALID_PASSWORD"
	| "PASSWORD_REQUIRED";

/**
 * Reasons an otherwise valid document cannot be applied to this destination. They are
 * not request problems, so they are reported as `409` in both directions of the gate.
 */
export type PortabilityImportBlockerCode =
	| "SLUG_COLLISION"
	| "GROUP_DEPTH_EXCEEDED"
	| "TARGET_CAPABILITY_MISSING"
	| "DESTINATION_HIERARCHY_CORRUPT"
	| "TARGET_GROUP_REFERENCE_CORRUPT"
	| "PASSWORD_SESSION_SECRET_MISSING";

/** Warning codes are mapped to copy by the panel, so the API carries no user-facing text. */
export type PortabilityImportWarningCode = "METRICS_NOT_EXPORTED";

const PORTABILITY_IMPORT_ERROR_MESSAGES: Record<PortabilityImportErrorCode, string> = {
	INVALID_BODY: "Portability import refused: invalid request body",
	INVALID_DOCUMENT: "Portability import refused: invalid document",
	UNKNOWN_FIELD: "Portability import refused: unknown field",
	UNSUPPORTED_FORMAT: "Portability import refused: unsupported format",
	UNSUPPORTED_SCHEMA_VERSION: "Portability import refused: unsupported export version",
	TOO_MANY_GROUPS: "Portability import refused: group limit exceeded",
	TOO_MANY_LINKS: "Portability import refused: link limit exceeded",
	TOO_LARGE: "Portability import refused: document exceeds the size limit",
	INVALID_GROUP_ENTRY: "Portability import refused: invalid group entry",
	INVALID_GROUP_NAME: "Portability import refused: invalid group name",
	INVALID_GROUP_REF: "Portability import refused: invalid group reference",
	DUPLICATE_GROUP_REF: "Portability import refused: duplicate group reference",
	DANGLING_PARENT_REF: "Portability import refused: group references a missing parent",
	GROUP_CYCLE: "Portability import refused: group hierarchy contains a cycle",
	INVALID_LINK_ENTRY: "Portability import refused: invalid link entry",
	DUPLICATE_LINK_SLUG: "Portability import refused: duplicate slug inside the document",
	INVALID_SLUG: "Portability import refused: invalid slug",
	INVALID_TARGET_URL: "Portability import refused: invalid destination URL",
	INVALID_REDIRECT_TYPE: "Portability import refused: invalid redirect type",
	INVALID_TAGS: "Portability import refused: invalid tags",
	DANGLING_GROUP_REF: "Portability import refused: link references a missing group",
	INVALID_LIFECYCLE: "Portability import refused: invalid lifecycle",
	INVALID_EXPIRED_REDIRECT: "Portability import refused: invalid expired destination",
	INVALID_AB_CONFIG: "Portability import refused: invalid A/B configuration",
	INVALID_SMART_ROUTING: "Portability import refused: invalid Smart Routing configuration",
	CONFLICTING_ROUTING_CONFIG: "Portability import refused: A/B and Smart Routing cannot both be active",
	INVALID_PASSWORD: "Portability import refused: invalid replacement password",
	PASSWORD_REQUIRED: "Portability import refused: a replacement password is required for every protected link",
};

/**
 * Product rules injected from the runtime, exactly as the export does it: slug policy,
 * URL normalization, tag storage and the A/B default weight already live in the worker
 * as the single authority for every other write path. Passing them in keeps this module
 * free of a second copy of the rules without letting it accept something the
 * administrative API would refuse.
 */
export type PortabilityImportPolicy = {
	isValidSlug(slug: string): boolean;
	normalizeUrl(candidate: string): string | null;
	/** Storage contract of the write path: the persisted `tags` value, or `null` for none. */
	serializeTags(tags: string[]): string | null;
	defaultAbWeightB: number;
};

/** One entry of the bounded error report. `path` is positional context, never a raw dump. */
export type PortabilityImportIssue = {
	path: string;
	code: PortabilityImportErrorCode;
};

/** A group to insert. `index` is the insertion order, 1-based; `parentIndex` is lower. */
export type PortabilityImportGroup = {
	index: number;
	name: string;
	parentIndex: number | null;
};

/** A link to insert, already normalized to the exact values the write path stores. */
export type PortabilityImportLink = {
	slug: string;
	targetUrl: string;
	redirectType: "301" | "302";
	/** Persisted form, or `null` for "no tags" (the same value the Admin writes). */
	tags: string | null;
	groupIndex: number | null;
	disabled: boolean;
	goLiveAt: string | null;
	expiresAt: string | null;
	expiredRedirectUrl: string | null;
	passwordProtected: boolean;
	ab: { enabled: boolean; variantBUrl: string | null; weightB: number };
	/** Canonical serialized rules, or `null` when Smart Routing is disabled. */
	smartRouting: string | null;
};

export type PortabilityImportSummary = {
	groups: number;
	links: number;
	disabledLinks: number;
	protectedLinks: number;
	abTests: number;
	smartRouting: number;
};

/**
 * The three capability-backed features of the format, as detected on the destination
 * and as required by a document. Sharing one shape is what lets the two be compared
 * field by field instead of by position.
 */
export type PortabilityImportFeatureFlags = {
	abTesting: boolean;
	smartRouting: boolean;
	expiredRedirect: boolean;
};

/**
 * What the document needs from the destination. A capability is required only when the
 * document *uses* the feature: an A/B block that equals the database default carries no
 * configuration that could be lost, so importing it into a pre-0004 database keeps the
 * link logically identical, while a split that is on, a retained Variant B or a weight
 * other than the default would be silently dropped — and that is refused instead.
 */
export type PortabilityImportRequirements = PortabilityImportFeatureFlags;

export type PortabilityImportPlan = {
	groups: PortabilityImportGroup[];
	links: PortabilityImportLink[];
	summary: PortabilityImportSummary;
	requirements: PortabilityImportRequirements;
	/** Protected links, in document order: one replacement password each. */
	protectedSlugs: string[];
};

export type PortabilityImportSuccess = { ok: true; plan: PortabilityImportPlan };

export type PortabilityImportRefusal = {
	ok: false;
	/**
	 * `400` for a document or request that is malformed, `413` for a document outside the
	 * format's envelope and `409` for an import requirement the request did not meet — the
	 * replacement passwords it owes for the protected links it carries.
	 */
	status: 400 | 409 | 413;
	code: PortabilityImportErrorCode;
	error: string;
	errors: PortabilityImportIssue[];
};

export type PortabilityImportResult = PortabilityImportSuccess | PortabilityImportRefusal;

/**
 * Request shape shared by both endpoints: the document exactly as the export produced it,
 * plus the replacement passwords for its protected links. Keeping the passwords beside the
 * document — instead of inside it — is what lets the format stay free of secrets in both
 * directions. `null` means the caller sent no mapping at all, which is legitimate for a
 * document without protected links and for every preview.
 */
export type PortabilityImportEnvelope = {
	document: unknown;
	replacementPasswords: Record<string, unknown> | null;
};

/** Collects at most {@link PORTABILITY_IMPORT_MAX_ERRORS} issues, then stops recording. */
class IssueList {
	private readonly issues: PortabilityImportIssue[] = [];

	get full(): boolean {
		return this.issues.length >= PORTABILITY_IMPORT_MAX_ERRORS;
	}

	get empty(): boolean {
		return this.issues.length === 0;
	}

	add(path: string, code: PortabilityImportErrorCode): void {
		if (this.full) {
			return;
		}
		this.issues.push({ path, code });
	}

	list(): PortabilityImportIssue[] {
		return this.issues;
	}
}

/**
 * Every refusal is built here, so no message can interpolate a raw document value: the
 * positional `path` of each issue carries the context, and the panel maps the codes.
 * Exported so the routes can refuse an envelope that never reached the document (an
 * unreadable body, a missing `document` field) with the same vocabulary.
 */
export function portabilityImportRefusal(
	status: 400 | 409 | 413,
	code: PortabilityImportErrorCode,
	errors: PortabilityImportIssue[] = [],
): PortabilityImportRefusal {
	return { ok: false, status, code, error: PORTABILITY_IMPORT_ERROR_MESSAGES[code], errors };
}

function refuseAt(status: 400 | 413, path: string, code: PortabilityImportErrorCode): PortabilityImportRefusal {
	return portabilityImportRefusal(status, code, [{ path, code }]);
}

/** UTF-8 byte length of the document as it would be applied, which is what the limit means. */
export function portabilityImportDocumentBytes(document: unknown): number {
	try {
		return new TextEncoder().encode(JSON.stringify(document) ?? "").byteLength;
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

/** True for a plain object: `null`, arrays and primitives are not field containers. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Unknown keys are refused, never ignored: a typo must not silently lose configuration. */
function collectUnknownKeys(
	value: Record<string, unknown>,
	allowed: ReadonlySet<string>,
	path: string,
	issues: IssueList,
): void {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) {
			issues.add(`${path}.${key}`, "UNKNOWN_FIELD");
		}
	}
}

type GroupDraft = {
	path: string;
	ref: string;
	name: string;
	parentRef: string | null;
};

/**
 * Validates the document shape and returns the plan, or a bounded refusal.
 *
 * The order is deliberate: format identity first (a different file is not worth
 * validating entry by entry), then the limits that bound all remaining work, then the
 * entries, then the references, and finally the tree itself.
 */
export function parsePortabilityImportDocument(
	raw: unknown,
	policy: PortabilityImportPolicy,
): PortabilityImportResult {
	if (!isRecord(raw)) {
		return refuseAt(400, "document", "INVALID_DOCUMENT");
	}

	const issues = new IssueList();
	collectUnknownKeys(raw, DOCUMENT_KEYS, "document", issues);

	if (raw.format !== PORTABILITY_FORMAT) {
		return refuseAt(400, "format", "UNSUPPORTED_FORMAT");
	}
	if (raw.schemaVersion !== PORTABILITY_SCHEMA_VERSION) {
		return refuseAt(400, "schemaVersion", "UNSUPPORTED_SCHEMA_VERSION");
	}
	// Informational only: the moment the file was produced is not configuration and is
	// deliberately never interpreted, but it is part of the V1 shape, so its type is
	// still checked (a number there means the file was assembled by something else).
	if (typeof raw.exportedAt !== "string") {
		return refuseAt(400, "exportedAt", "INVALID_DOCUMENT");
	}
	if (!Array.isArray(raw.groups)) {
		return refuseAt(400, "groups", "INVALID_DOCUMENT");
	}
	if (!Array.isArray(raw.links)) {
		return refuseAt(400, "links", "INVALID_DOCUMENT");
	}
	if (raw.groups.length > PORTABILITY_MAX_GROUPS) {
		return refuseAt(413, "groups", "TOO_MANY_GROUPS");
	}
	if (raw.links.length > PORTABILITY_MAX_LINKS) {
		return refuseAt(413, "links", "TOO_MANY_LINKS");
	}
	if (!issues.empty) {
		return portabilityImportRefusal(400, "INVALID_DOCUMENT", issues.list());
	}

	const groups = validateGroups(raw.groups, issues);
	if (groups === null) {
		return portabilityImportRefusal(400, "INVALID_DOCUMENT", issues.list());
	}

	const refusal = portabilityImportRefusal(400, "INVALID_DOCUMENT", issues.list());
	const documentIndexByRef = mapGroupRefs(groups, issues);
	if (documentIndexByRef === null) {
		return refusal;
	}

	const hierarchy = resolveGroupHierarchy(groups, documentIndexByRef, issues);
	if (hierarchy === null) {
		return refusal;
	}

	const requirements: PortabilityImportRequirements = {
		abTesting: false,
		smartRouting: false,
		expiredRedirect: false,
	};

	// Links resolve their group through the *plan* index, which is the insertion order
	// after the topological sort — never through the document's position, which the sort
	// may have changed.
	const links = validateLinks(raw.links, hierarchy.indexByRef, policy, requirements, issues);

	if (!issues.empty || links === null) {
		return portabilityImportRefusal(400, "INVALID_DOCUMENT", issues.list());
	}

	return {
		ok: true,
		plan: {
			groups: hierarchy.groups,
			links,
			summary: {
				groups: hierarchy.groups.length,
				links: links.length,
				disabledLinks: links.filter((link) => link.disabled).length,
				protectedLinks: links.filter((link) => link.passwordProtected).length,
				abTests: links.filter((link) => link.ab.enabled).length,
				smartRouting: links.filter((link) => link.smartRouting !== null).length,
			},
			requirements,
			protectedSlugs: links.filter((link) => link.passwordProtected).map((link) => link.slug),
		},
	};
}

function validateGroups(rawGroups: unknown[], issues: IssueList): GroupDraft[] | null {
	const drafts: GroupDraft[] = [];

	for (let index = 0; index < rawGroups.length; index += 1) {
		const path = `groups[${index}]`;
		const entry = rawGroups[index];
		if (!isRecord(entry)) {
			issues.add(path, "INVALID_GROUP_ENTRY");
			continue;
		}

		collectUnknownKeys(entry, GROUP_KEYS, path, issues);
		if (typeof entry.ref !== "string" || entry.ref.length === 0 || entry.ref.length > MAX_REF_LENGTH) {
			issues.add(`${path}.ref`, "INVALID_GROUP_REF");
			continue;
		}
		if (typeof entry.name !== "string") {
			issues.add(`${path}.name`, "INVALID_GROUP_NAME");
			continue;
		}
		// A canonical name is one the write path would return unchanged: a padded,
		// whitespace-only or over-ceiling value cannot come from BoltLink, so it is
		// refused instead of being trimmed into shape on the way in.
		if (!isCanonicalGroupName(entry.name)) {
			issues.add(`${path}.name`, "INVALID_GROUP_NAME");
			continue;
		}
		if (entry.parentRef !== null && (typeof entry.parentRef !== "string" || entry.parentRef.length === 0 || entry.parentRef.length > MAX_REF_LENGTH)) {
			issues.add(`${path}.parentRef`, "INVALID_GROUP_REF");
			continue;
		}
		if (entry.parentRef === entry.ref) {
			// Self-parenting is a cycle of one; named here because the path is precise.
			issues.add(`${path}.parentRef`, "GROUP_CYCLE");
			continue;
		}

		drafts.push({ path, ref: entry.ref, name: entry.name, parentRef: entry.parentRef ?? null });
	}

	if (!issues.empty) {
		return null;
	}
	return drafts;
}

/**
 * Refs are unique inside the document. This map resolves a `parentRef` to the parent's
 * position *in the document*, which is what the cycle analysis walks; the plan index is a
 * different numbering, produced after the topological sort, so links and parents are
 * resolved through refs and never through a position that the sort may have changed.
 */
function mapGroupRefs(groups: GroupDraft[], issues: IssueList): Map<string, number> | null {
	const indexByRef = new Map<string, number>();

	for (let index = 0; index < groups.length; index += 1) {
		const group = groups[index];
		if (indexByRef.has(group.ref)) {
			issues.add(`${group.path}.ref`, "DUPLICATE_GROUP_REF");
			continue;
		}
		// 1-based: the document position, not an array offset.
		indexByRef.set(group.ref, index + 1);
	}

	return issues.empty ? indexByRef : null;
}

/**
 * Resolves parent references and orders the groups so every parent is inserted before
 * its children. The cycle, dangling and depth rules come from the approved Gate 5.1
 * analysis — the same reader the export uses — instead of a second traversal with its
 * own rules: refs become the ids of a synthetic adjacency list and that analyzer decides.
 *
 * Depth is a *portability* limit, not a document defect: the export deliberately
 * transmits structurally valid legacy trees that exceed `MAX_GROUP_DEPTH`, because
 * otherwise an installation could never be migrated away from one. The import is the
 * other half of that decision — creating a tree the current write paths would refuse to
 * build would leave the destination holding a shape it cannot maintain — so a document
 * deeper than the ceiling is reported as a blocker (`409`) by the caller, with zero
 * writes, rather than bypassing the invariant to make the round trip pass.
 */
function resolveGroupHierarchy(
	groups: GroupDraft[],
	documentIndexByRef: Map<string, number>,
	issues: IssueList,
): { groups: PortabilityImportGroup[]; indexByRef: Map<string, number> } | null {
	const rows: Array<{ id: number; parent_id: number | null }> = [];

	for (let position = 0; position < groups.length; position += 1) {
		const group = groups[position];
		let parentDocumentIndex: number | null = null;

		if (group.parentRef !== null) {
			const resolved = documentIndexByRef.get(group.parentRef);
			if (resolved === undefined) {
				issues.add(`${group.path}.parentRef`, "DANGLING_PARENT_REF");
				continue;
			}
			parentDocumentIndex = resolved;
		}

		rows.push({ id: position + 1, parent_id: parentDocumentIndex });
	}

	if (!issues.empty) {
		return null;
	}

	const analysis = analyzeGroupHierarchy(rows);
	if (!analysis.ok) {
		// A cycle is a document defect: there is no insertion order that satisfies it.
		issues.add("groups", analysis.reason === "cycle" ? "GROUP_CYCLE" : "DANGLING_PARENT_REF");
		return null;
	}

	// Topological order: depth ascending, ties by document position, so a parent is
	// always inserted before its children while the author's order is otherwise kept.
	const ordered = groups
		.map((group, position) => ({
			ref: group.ref,
			name: group.name,
			parentRef: group.parentRef,
			depth: analysis.snapshot.depthById.get(position + 1) ?? 1,
			documentIndex: position + 1,
		}))
		.sort((left, right) => (left.depth !== right.depth ? left.depth - right.depth : left.documentIndex - right.documentIndex));

	// The plan index of every group, in insertion order. A parent ref resolves through this
	// and not through the document position: after the sort the two numberings differ.
	const indexByRef = new Map<string, number>();
	ordered.forEach((group, position) => indexByRef.set(group.ref, position + 1));

	return {
		groups: ordered.map((group, position) => ({
			index: position + 1,
			name: group.name,
			parentIndex: group.parentRef === null ? null : indexByRef.get(group.parentRef) ?? null,
		})),
		indexByRef,
	};
}

/** Highest depth of the planned tree, measured by the same analyzer the write paths use. */
export function portabilityImportGroupDepth(plan: PortabilityImportPlan): number {
	const analysis = analyzeGroupHierarchy(
		plan.groups.map((group) => ({ id: group.index, parent_id: group.parentIndex })),
	);
	return analysis.ok ? Math.max(0, ...analysis.snapshot.depthById.values()) : Number.POSITIVE_INFINITY;
}

function validateLinks(
	rawLinks: unknown[],
	groupIndexByRef: Map<string, number>,
	policy: PortabilityImportPolicy,
	requirements: PortabilityImportRequirements,
	issues: IssueList,
): PortabilityImportLink[] | null {
	const links: PortabilityImportLink[] = [];
	const seenSlugs = new Set<string>();

	for (let index = 0; index < rawLinks.length; index += 1) {
		const path = `links[${index}]`;
		const entry = rawLinks[index];
		if (!isRecord(entry)) {
			issues.add(path, "INVALID_LINK_ENTRY");
			continue;
		}

		collectUnknownKeys(entry, LINK_KEYS, path, issues);
		const missing = LINK_REQUIRED_KEYS.filter((key) => !Object.prototype.hasOwnProperty.call(entry, key));
		if (missing.length) {
			for (const key of missing) {
				issues.add(`${path}.${key}`, "INVALID_LINK_ENTRY");
			}
			continue;
		}

		const slug = entry.slug;
		if (typeof slug !== "string" || !policy.isValidSlug(slug)) {
			issues.add(`${path}.slug`, "INVALID_SLUG");
			continue;
		}
		// Duplicate slugs inside the document are refused, never deduplicated and never
		// resolved by "the last one wins": the operator would review a plan that does not
		// describe what would be written.
		if (seenSlugs.has(slug)) {
			issues.add(`${path}.slug`, "DUPLICATE_LINK_SLUG");
			continue;
		}
		seenSlugs.add(slug);

		const targetUrl = typeof entry.targetUrl === "string" ? policy.normalizeUrl(entry.targetUrl) : null;
		if (!targetUrl) {
			issues.add(`${path}.targetUrl`, "INVALID_TARGET_URL");
			continue;
		}

		// The format's own field, so its rule is the format's: an exact literal, with no
		// default and no coercion. Accepting `"301"` as a string-typed 301 or a missing
		// value as 302 would silently change how a link answers.
		const redirectType = entry.redirectType === "301" || entry.redirectType === "302" ? entry.redirectType : null;
		if (!redirectType) {
			issues.add(`${path}.redirectType`, "INVALID_REDIRECT_TYPE");
			continue;
		}

		// Tags go through the export's own reader (via the document's array form), so the
		// accepted shape is by construction the emitted shape: ≤ 50 trimmed, non-empty
		// strings, in order.
		const tags = Array.isArray(entry.tags) ? resolvePersistedTags(JSON.stringify(entry.tags)) : { ok: false as const };
		if (!tags.ok) {
			issues.add(`${path}.tags`, "INVALID_TAGS");
			continue;
		}

		let groupIndex: number | null = null;
		if (entry.groupRef !== null) {
			if (typeof entry.groupRef !== "string") {
				issues.add(`${path}.groupRef`, "INVALID_GROUP_REF");
				continue;
			}
			const resolved = groupIndexByRef.get(entry.groupRef);
			if (resolved === undefined) {
				issues.add(`${path}.groupRef`, "DANGLING_GROUP_REF");
				continue;
			}
			groupIndex = resolved;
		}

		if (typeof entry.disabled !== "boolean") {
			issues.add(`${path}.disabled`, "INVALID_LINK_ENTRY");
			continue;
		}
		if (typeof entry.passwordProtected !== "boolean") {
			issues.add(`${path}.passwordProtected`, "INVALID_LINK_ENTRY");
			continue;
		}

		// Lifecycle uses the format's canonical-instant rule, never the administrative
		// date parser: a naive local datetime would otherwise be reinterpreted in the
		// destination's timezone, which is a silent change of when a link goes live.
		const goLiveAt = resolvePersistedInstant(entry.goLiveAt);
		const expiresAt = resolvePersistedInstant(entry.expiresAt);
		if (!goLiveAt.ok || !expiresAt.ok) {
			issues.add(`${path}.${goLiveAt.ok ? "expiresAt" : "goLiveAt"}`, "INVALID_LIFECYCLE");
			continue;
		}
		if (goLiveAt.value !== null && expiresAt.value !== null && expiresAt.value < goLiveAt.value) {
			issues.add(`${path}.expiresAt`, "INVALID_LIFECYCLE");
			continue;
		}

		// Capability-backed keys are optional in the document and are interpreted only
		// when they are present, exactly as the export writes them.
		let expiredRedirectUrl: string | null = null;
		if (Object.prototype.hasOwnProperty.call(entry, "expiredRedirectUrl")) {
			const rawRedirect = entry.expiredRedirectUrl;
			if (rawRedirect === null) {
				expiredRedirectUrl = null;
			} else if (typeof rawRedirect === "string") {
				const normalized = policy.normalizeUrl(rawRedirect);
				if (!normalized) {
					issues.add(`${path}.expiredRedirectUrl`, "INVALID_EXPIRED_REDIRECT");
					continue;
				}
				expiredRedirectUrl = normalized;
			} else {
				issues.add(`${path}.expiredRedirectUrl`, "INVALID_EXPIRED_REDIRECT");
				continue;
			}
			// Administrative invariant of the feature: a destination is only reachable
			// once `expiresAt` elapses, so storing one without an expiration would persist
			// a dormant configuration the product refuses on write.
			if (expiredRedirectUrl !== null && expiresAt.value === null) {
				issues.add(`${path}.expiredRedirectUrl`, "INVALID_EXPIRED_REDIRECT");
				continue;
			}
			if (expiredRedirectUrl !== null) {
				requirements.expiredRedirect = true;
			}
		}

		let ab = { enabled: false, variantBUrl: null as string | null, weightB: policy.defaultAbWeightB };
		if (Object.prototype.hasOwnProperty.call(entry, "abTest")) {
			const abEntry = entry.abTest;
			if (!isRecord(abEntry)) {
				issues.add(`${path}.abTest`, "INVALID_AB_CONFIG");
				continue;
			}
			collectUnknownKeys(abEntry, AB_KEYS, `${path}.abTest`, issues);
			if (typeof abEntry.enabled !== "boolean") {
				issues.add(`${path}.abTest.enabled`, "INVALID_AB_CONFIG");
				continue;
			}
			if (!hasEveryKey(abEntry, ["enabled", "variantBUrl", "weightB"])) {
				issues.add(`${path}.abTest`, "INVALID_AB_CONFIG");
				continue;
			}
			const variantBUrl = abEntry.variantBUrl === null
				? null
				: typeof abEntry.variantBUrl === "string"
					? policy.normalizeUrl(abEntry.variantBUrl)
					: null;
			if (abEntry.variantBUrl !== null && !variantBUrl) {
				issues.add(`${path}.abTest.variantBUrl`, "INVALID_AB_CONFIG");
				continue;
			}
			const weightB = abEntry.weightB;
			if (typeof weightB !== "number" || !Number.isInteger(weightB) || weightB < 1 || weightB > 99) {
				issues.add(`${path}.abTest.weightB`, "INVALID_AB_CONFIG");
				continue;
			}
			if (abEntry.enabled && variantBUrl === null) {
				issues.add(`${path}.abTest.variantBUrl`, "INVALID_AB_CONFIG");
				continue;
			}
			// "A/B testing requires a temporary redirect": the split is a runtime decision,
			// and a permanent redirect would freeze one answer.
			if (abEntry.enabled && redirectType === "301") {
				issues.add(`${path}.abTest.enabled`, "INVALID_AB_CONFIG");
				continue;
			}
			ab = { enabled: abEntry.enabled, variantBUrl, weightB };
			// A split that is on, a retained Variant B or a non-default weight is real
			// persisted configuration; the default block is not, and demanding the column
			// for it would block documents that carry nothing to lose.
			if (
				ab.enabled ||
				ab.variantBUrl !== null ||
				ab.weightB !== policy.defaultAbWeightB
			) {
				requirements.abTesting = true;
			}
		}

		let smartRouting: string | null = null;
		if (Object.prototype.hasOwnProperty.call(entry, "smartRouting") && entry.smartRouting !== null) {
			// The approved domain validates and canonicalizes the rules; only its own
			// canonical serialization is stored, never the document's raw bytes. Order is
			// semantic (first match wins) so it travels unchanged.
			const parsed = parseSmartRoutingRules(entry.smartRouting);
			if (!parsed.ok) {
				issues.add(`${path}.smartRouting`, "INVALID_SMART_ROUTING");
				continue;
			}
			if (redirectType === "301") {
				issues.add(`${path}.smartRouting`, "INVALID_SMART_ROUTING");
				continue;
			}
			smartRouting = JSON.stringify(parsed.rules);
			requirements.smartRouting = true;
		}

		// Mutual exclusion, matching the runtime's rule: an *enabled* split next to a
		// configured Smart Routing is a hybrid the product never writes.
		if (ab.enabled && smartRouting !== null) {
			issues.add(`${path}.smartRouting`, "CONFLICTING_ROUTING_CONFIG");
			continue;
		}

		links.push({
			slug,
			targetUrl,
			redirectType,
			tags: policy.serializeTags(tags.value),
			groupIndex,
			disabled: entry.disabled,
			goLiveAt: goLiveAt.value,
			expiresAt: expiresAt.value,
			expiredRedirectUrl,
			passwordProtected: entry.passwordProtected,
			ab,
			smartRouting,
		});
	}

	if (!issues.empty) {
		return null;
	}
	return links;
}

function hasEveryKey(value: Record<string, unknown>, keys: string[]): boolean {
	return keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

/**
 * Why an otherwise valid document cannot be applied here. Collected together so the
 * operator sees every reason at once instead of discovering them one import attempt at
 * a time; the caller answers `409` when the list is not empty.
 */
export function findPortabilityImportBlockers(input: {
	plan: PortabilityImportPlan;
	capabilities: PortabilityImportFeatureFlags;
	/** Slugs of the document that already reserve a slug in the destination. */
	conflicts: string[];
	destinationHierarchyValid: boolean;
	/** False when the destination holds a link whose group does not exist. */
	destinationGroupReferencesValid: boolean;
	passwordSecretConfigured: boolean;
}): PortabilityImportBlockerCode[] {
	const blockers: PortabilityImportBlockerCode[] = [];
	const { plan, capabilities } = input;

	if (!input.destinationHierarchyValid) {
		blockers.push("DESTINATION_HIERARCHY_CORRUPT");
	}
	// A reference the destination cannot resolve is not repaired, adopted or ignored: the
	// import writes into a tree this installation can no longer read, and an imported group
	// taking the id of a deleted one would make that reference look valid again.
	if (!input.destinationGroupReferencesValid) {
		blockers.push("TARGET_GROUP_REFERENCE_CORRUPT");
	}
	if (input.conflicts.length > 0) {
		blockers.push("SLUG_COLLISION");
	}
	if (portabilityImportGroupDepth(plan) > MAX_GROUP_DEPTH) {
		blockers.push("GROUP_DEPTH_EXCEEDED");
	}
	// A feature the document really uses is never dropped and never degraded: the
	// destination must support it, which in practice means being up to date.
	if (
		(plan.requirements.abTesting && !capabilities.abTesting) ||
		(plan.requirements.smartRouting && !capabilities.smartRouting) ||
		(plan.requirements.expiredRedirect && !capabilities.expiredRedirect)
	) {
		blockers.push("TARGET_CAPABILITY_MISSING");
	}
	if (plan.summary.protectedLinks > 0 && !input.passwordSecretConfigured) {
		blockers.push("PASSWORD_SESSION_SECRET_MISSING");
	}

	return blockers;
}

/**
 * Whether a failed batch failed *because* a slug is already reserved.
 *
 * The import's only expected batch failure is the `UNIQUE` constraint on `links.slug` —
 * the guard that turns a slug taken since the preview into an aborted transaction — and
 * SQLite names the constraint it refused, which D1 wraps and re-exposes on `cause`. That
 * signature is the evidence: reading the destination *afterwards* to see whether some slug
 * is taken is not, because a rollback leaves exactly the state that was there before, and
 * a destination that already held a conflicting slug would explain an unrelated failure —
 * a trigger, a missing column, a locked database — as a collision, hiding the real defect.
 *
 * Anything that cannot be identified this way is deliberately *not* classified: an unknown
 * error stays an unknown error, and the caller answers with a controlled `500`.
 */
export function isPortabilityImportSlugCollisionError(error: unknown): boolean {
	let current: unknown = error;

	for (let depth = 0; current !== null && current !== undefined && depth < 4; depth += 1) {
		const message = (current as { message?: unknown }).message;
		if (typeof message === "string" && /UNIQUE constraint failed: links\.slug\b/.test(message)) {
			return true;
		}
		current = (current as { cause?: unknown }).cause;
	}

	return false;
}

export type PortabilityImportStatement = {
	sql: string;
	bindings: Array<string | number | null>;
};

/**
 * The id the next group would take, read from the table by the statement that writes it.
 *
 * `MAX(id)` alone is not enough to describe "the next free id" here. `link_groups.id` is
 * `INTEGER PRIMARY KEY AUTOINCREMENT`, so SQLite keeps a high-water mark in
 * `sqlite_sequence` that survives deletion: an installation that removed its newest groups
 * has a `MAX(id)` far below the ids the table already handed out, and nothing on D1
 * enforces `links.group_id` as a foreign key, so a row elsewhere may still point at one of
 * those deleted ids. Taking `MAX(id) + 1` would hand an imported group an id the
 * destination already spent — and the leftover reference would silently start resolving to
 * a group it never meant. The floor is therefore the higher of the two, and it is read
 * inside the same statement that inserts, so a concurrent writer cannot shift it.
 */
const PORTABILITY_IMPORT_GROUP_ID_FLOOR =
	"max(COALESCE(MAX(id), 0), COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'link_groups'), 0))";

/**
 * Group insert. The id is read from the table by the statement that writes it, from the
 * floor above, so the mapping never depends on a value computed outside the transaction.
 * The parent is addressed by its *distance* from the row being inserted
 * (`index - parentIndex`), which is a constant of the plan: since groups are inserted in
 * topological order and each insert takes the next free id, the parent is always exactly
 * that many ids behind. A parent that does not exist cannot be addressed at all, and a
 * concurrent group insert cannot shift the arithmetic, because it cannot interleave inside
 * the transaction.
 */
export const PORTABILITY_IMPORT_GROUP_SQL = `INSERT INTO link_groups (id, name, parent_id)
	VALUES (
		(SELECT ${PORTABILITY_IMPORT_GROUP_ID_FLOOR} + 1 FROM link_groups),
		?,
		CASE WHEN ? IS NULL THEN NULL ELSE (SELECT ${PORTABILITY_IMPORT_GROUP_ID_FLOOR} + 1 - ? FROM link_groups) END
	)`;

/**
 * Group resolution for a link. Links are inserted after every group, so `MAX(id)` is the
 * last imported group — the imported block always sits on top of the table, because its
 * floor is above every id the destination ever handed out — and a reference is again a
 * constant distance away. A null `groupRef` binds no id at all instead of a sentinel.
 */
const PORTABILITY_IMPORT_GROUP_ID_EXPRESSION =
	"CASE WHEN ? IS NULL THEN NULL ELSE (SELECT COALESCE(MAX(id), 0) - ? FROM link_groups) END";

type StatementFragment = {
	column: string;
	expression: string;
	bindings: Array<string | number | null>;
};

/**
 * Builds the single batch that applies the whole plan: groups first (parents before
 * children), then links, in document order. One statement per row, so the batch is
 * exactly as wide as the document and is executed as one SQL transaction: the plan is
 * applied whole or the batch aborts and leaves the destination untouched.
 *
 * A plain `INSERT` is used on purpose — a `WHERE NOT EXISTS` guard would turn a slug
 * taken since the preview into a silently skipped link, which is precisely the partial
 * import this design forbids. The `UNIQUE` constraint is the guard: it fails the batch.
 */
export function buildPortabilityImportStatements(input: {
	plan: PortabilityImportPlan;
	capabilities: PortabilityImportFeatureFlags;
	/** Hash per protected slug; the caller hashes before any statement is built. */
	passwordHashes: Map<string, string>;
	/** Single instant for every timestamp the import generates, from the runtime clock. */
	now: string;
}): PortabilityImportStatement[] {
	const { plan, capabilities, passwordHashes, now } = input;

	if (
		(plan.requirements.abTesting && !capabilities.abTesting) ||
		(plan.requirements.smartRouting && !capabilities.smartRouting) ||
		(plan.requirements.expiredRedirect && !capabilities.expiredRedirect)
	) {
		// The caller blocks on this before building; reaching it here would mean the
		// capability flags and the plan disagreed, so the import is refused loudly instead
		// of writing a document whose features were silently dropped.
		throw new Error("Portability import statements require destination capabilities that are missing");
	}

	const statements: PortabilityImportStatement[] = [];

	for (const group of plan.groups) {
		statements.push({
			sql: PORTABILITY_IMPORT_GROUP_SQL,
			bindings: [
				group.name,
				group.parentIndex === null ? null : 0,
				group.parentIndex === null ? null : group.index - group.parentIndex,
			],
		});
	}

	const lastGroupIndex = plan.groups.length;
	for (const link of plan.links) {
		const fragments: StatementFragment[] = [
			{ column: "slug", expression: "?", bindings: [link.slug] },
			{ column: "target_url", expression: "?", bindings: [link.targetUrl] },
			{ column: "redirect_type", expression: "?", bindings: [link.redirectType] },
			{ column: "tags", expression: "?", bindings: [link.tags] },
			{
				column: "group_id",
				expression: PORTABILITY_IMPORT_GROUP_ID_EXPRESSION,
				bindings: [
					link.groupIndex === null ? null : 0,
					link.groupIndex === null ? null : lastGroupIndex - link.groupIndex,
				],
			},
			// The tombstone timestamp is generated by the destination, exactly as the
			// soft-delete path does it: a disabled link stays disabled and keeps reserving
			// its slug, and the source's timestamp is not part of the format.
			{ column: "disabled_at", expression: "?", bindings: [link.disabled ? now : null] },
			{ column: "expires_at", expression: "?", bindings: [link.expiresAt] },
			{ column: "go_live_at", expression: "?", bindings: [link.goLiveAt] },
			{ column: "password_hash", expression: "?", bindings: [passwordHashes.get(link.slug) ?? null] },
		];

		if (capabilities.abTesting) {
			// Mirrors the create path: an enabled split starts at generation 1 with its own
			// start instant; a disabled one keeps the dormant configuration it carries.
			fragments.push(
				{ column: "ab_enabled", expression: "?", bindings: [link.ab.enabled ? 1 : 0] },
				{ column: "ab_target_url", expression: "?", bindings: [link.ab.variantBUrl] },
				{ column: "ab_weight_b", expression: "?", bindings: [link.ab.weightB] },
				{ column: "ab_generation", expression: "?", bindings: [link.ab.enabled ? 1 : 0] },
				{ column: "ab_started_at", expression: "?", bindings: [link.ab.enabled ? now : null] },
			);
		}
		if (capabilities.smartRouting) {
			fragments.push({ column: "smart_routing_rules", expression: "?", bindings: [link.smartRouting] });
		}
		if (capabilities.expiredRedirect) {
			fragments.push({ column: "expired_redirect_url", expression: "?", bindings: [link.expiredRedirectUrl] });
		}

		// Metrics are deliberately absent from both the column list and the bindings:
		// counters, `metric_epoch`, `created_at` and `version` take the column defaults,
		// exactly like a freshly created link, so nothing operational is invented and
		// nothing from the source is restored.
		statements.push({
			sql: `INSERT INTO links (${fragments.map((fragment) => fragment.column).join(", ")})
	VALUES (${fragments.map((fragment) => fragment.expression).join(", ")})`,
			bindings: fragments.flatMap((fragment) => fragment.bindings),
		});
	}

	return statements;
}

/** Statement count of a plan, so a test can pin it against the format's own limits. */
export function portabilityImportStatementCount(plan: PortabilityImportPlan): number {
	return plan.groups.length + plan.links.length;
}

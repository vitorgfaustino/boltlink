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
 * Group hierarchy integrity for the administrative API (Unreleased / Phase 5).
 *
 * The tree already exists in the schema: `link_groups.parent_id` arrives with
 * `migrations/0002_advanced_features.sql` together with its self-referencing
 * foreign key, its `parent_id` index and `ON DELETE SET NULL`. This module adds
 * no migration, no auxiliary table and no closure/materialized-path column; it
 * only makes the existing adjacency list safe to mutate.
 *
 * Two invariants are enforced here and nowhere else:
 *
 * 1. the graph stays acyclic, and
 * 2. every group stays at or below {@link MAX_GROUP_DEPTH}.
 *
 * Both are decided by a single conditional statement, never by a read followed
 * by an unprotected write:
 *
 * - {@link GROUP_MOVE_SQL} is one `UPDATE` guarded by recursive CTEs, so the
 *   cycle check, the observed-parent precondition and the write are one atomic
 *   unit. A concurrent writer can therefore not slip between the check and the
 *   write, and two opposite moves cannot both be accepted.
 * - {@link GROUP_DELETE_SQL} is one conditional `DELETE`, so a group cannot lose
 *   its last child or its last link between a check and the removal.
 * - {@link GROUP_INSERT_SQL} is one guarded `INSERT ... SELECT`, so a child is
 *   never created past the depth ceiling even if the parent moves meanwhile, and
 *   never created under a parent that was deleted meanwhile: the parent's
 *   existence is decided by the writing statement, not by an earlier read.
 *
 * Every recursive CTE deduplicates with `UNION` and is bounded by
 * {@link GROUP_DEPTH_PROBE_LIMIT}, so a database that already holds an
 * externally introduced cycle still terminates instead of looping.
 *
 * The read path never answers a partial tree: {@link analyzeGroupHierarchy}
 * refuses a corrupt graph and the route fails closed, instead of repairing it or
 * silently promoting an orphan to a root.
 */

/** Root groups are depth 1, so a chain of 16 groups is the deepest legal shape. */
export const MAX_GROUP_DEPTH = 16;

/**
 * Recursion bound of the measurement CTEs. It is deliberately larger than the
 * ceiling: a tree that already exceeds {@link MAX_GROUP_DEPTH} must still be
 * measurable, otherwise a repair that only moves a subtree upwards could not be
 * told apart from one that deepens the violation. It is also what keeps the
 * recursion finite when the stored graph contains a cycle.
 */
export const GROUP_DEPTH_PROBE_LIMIT = MAX_GROUP_DEPTH * 4;

/** Minimal shape of `link_groups` this module reasons about. */
export type GroupHierarchyRow = {
	id: number;
	parent_id: number | null;
};

export type GroupHierarchySnapshot = {
	parentById: Map<number, number | null>;
	/** Nodes from the root down to the group, inclusive. A root group is 1. */
	depthById: Map<number, number>;
	/** Nodes from the group down to its deepest descendant, inclusive. */
	heightById: Map<number, number>;
};

export type GroupHierarchyAnalysis =
	| { ok: true; snapshot: GroupHierarchySnapshot }
	| { ok: false; reason: GroupHierarchyCorruption };

/**
 * `dangling` is unreachable while the `0002` foreign key is enforced; it is kept
 * because the read path must fail closed on any graph it cannot interpret, and a
 * database restored without the constraint would otherwise render orphans as
 * roots, which is a silent repair.
 */
export type GroupHierarchyCorruption = "cycle" | "dangling";

/**
 * Classifies the stored adjacency list and measures it.
 *
 * Deliberately pure and database-free so the graph rules are unit testable, and
 * deliberately independent from the write guards: this answers "can this graph be
 * shown?", while the SQL statements above decide "may this edge be written?".
 */
export function analyzeGroupHierarchy(rows: GroupHierarchyRow[]): GroupHierarchyAnalysis {
	const parentById = new Map<number, number | null>();
	for (const row of rows) {
		parentById.set(row.id, row.parent_id ?? null);
	}

	for (const row of rows) {
		const parentId = parentById.get(row.id) ?? null;
		if (parentId !== null && !parentById.has(parentId)) {
			return { ok: false, reason: "dangling" };
		}
	}

	const depthById = new Map<number, number>();
	for (const row of rows) {
		if (depthById.has(row.id)) {
			continue;
		}

		// Walk to the root, memoizing on the way back so the whole pass stays
		// linear. A node met twice on one walk is a cycle: the graph has no depth
		// to report and every descending measurement would be meaningless.
		const chain: number[] = [];
		const seen = new Set<number>();
		let current: number | null = row.id;
		let base = 0;
		for (;;) {
			if (current === null) {
				base = 0;
				break;
			}
			if (seen.has(current)) {
				return { ok: false, reason: "cycle" };
			}
			seen.add(current);
			const known = depthById.get(current);
			if (known !== undefined) {
				base = known;
				break;
			}
			chain.push(current);
			current = parentById.get(current) ?? null;
		}

		for (let index = chain.length - 1; index >= 0; index -= 1) {
			base += 1;
			depthById.set(chain[index], base);
		}
	}

	const childrenById = new Map<number, number[]>();
	for (const row of rows) {
		const parentId = parentById.get(row.id) ?? null;
		if (parentId === null) {
			continue;
		}
		const siblings = childrenById.get(parentId);
		if (siblings) {
			siblings.push(row.id);
		} else {
			childrenById.set(parentId, [row.id]);
		}
	}

	// Deepest first: a node is measured only after all of its children were.
	const deepestFirst = [...rows].sort((left, right) => (depthById.get(right.id) ?? 0) - (depthById.get(left.id) ?? 0));
	const heightById = new Map<number, number>();
	for (const row of deepestFirst) {
		let height = 1;
		for (const childId of childrenById.get(row.id) ?? []) {
			height = Math.max(height, (heightById.get(childId) ?? 1) + 1);
		}
		heightById.set(row.id, height);
	}

	return { ok: true, snapshot: { parentById, depthById, heightById } };
}

/**
 * True when `candidateId` is `ancestorId` itself or one of its descendants.
 * Bounded by a visited set so it cannot loop on a corrupt graph.
 */
export function isWithinSubtree(
	parentById: Map<number, number | null>,
	ancestorId: number,
	candidateId: number | null,
): boolean {
	if (candidateId === null) {
		return false;
	}

	const seen = new Set<number>();
	let current: number | null = candidateId;
	while (current !== null) {
		if (current === ancestorId) {
			return true;
		}
		if (seen.has(current)) {
			return false;
		}
		seen.add(current);
		current = parentById.get(current) ?? null;
	}

	return false;
}

/**
 * Single-statement move.
 *
 * The `WHERE` clause carries every condition, which is the whole point: there is
 * no window between deciding and writing.
 *
 * - `parent_id IS ?` is the optimistic precondition. `IS` rather than `=` so the
 *   observed parent `null` (a root group) compares equal, and a parent that
 *   changed since the client read it makes the statement match nothing.
 * - `NOT EXISTS (subtree)` refuses a target inside the moving group's own
 *   subtree, which covers self-parenting and every indirect ring.
 * - the final disjunction enforces the ceiling. The first branch is the ordinary
 *   rule; the second accepts a move that strictly reduces the parent depth, so a
 *   tree that already exceeds {@link MAX_GROUP_DEPTH} stays repairable while a
 *   move that keeps or deepens the violation is refused.
 */
export const GROUP_MOVE_SQL = `WITH RECURSIVE
	subtree(id) AS (
		SELECT id FROM link_groups WHERE id = ?
		UNION
		SELECT child.id FROM link_groups AS child JOIN subtree ON child.parent_id = subtree.id
	),
	target_chain(id, depth) AS (
		SELECT ?, 1
		UNION
		SELECT parent.parent_id, target_chain.depth + 1
		FROM target_chain JOIN link_groups AS parent ON parent.id = target_chain.id
		WHERE parent.parent_id IS NOT NULL AND target_chain.depth < ?
	),
	current_chain(id, depth) AS (
		SELECT ?, 1
		UNION
		SELECT parent.parent_id, current_chain.depth + 1
		FROM current_chain JOIN link_groups AS parent ON parent.id = current_chain.id
		WHERE parent.parent_id IS NOT NULL AND current_chain.depth < ?
	),
	moving_height(id, depth) AS (
		SELECT ?, 1
		UNION
		SELECT child.id, moving_height.depth + 1
		FROM moving_height JOIN link_groups AS child ON child.parent_id = moving_height.id
		WHERE moving_height.depth < ?
	)
UPDATE link_groups
SET parent_id = ?, name = COALESCE(?, name)
WHERE id = ?
	AND parent_id IS ?
	AND (? IS NULL OR EXISTS (SELECT 1 FROM link_groups AS target WHERE target.id = ?))
	AND NOT EXISTS (SELECT 1 FROM subtree WHERE subtree.id = ?)
	AND (
		(CASE WHEN ? IS NULL THEN 0 ELSE (SELECT MAX(depth) FROM target_chain) END)
			+ (SELECT MAX(depth) FROM moving_height)
			<= ?
		OR
		(CASE WHEN ? IS NULL THEN 0 ELSE (SELECT MAX(depth) FROM target_chain) END)
			< (CASE WHEN ? IS NULL THEN 0 ELSE (SELECT MAX(depth) FROM current_chain) END)
	)
RETURNING id, name, parent_id, created_at`;

/**
 * Bindings for {@link GROUP_MOVE_SQL}, in statement order. Kept next to the
 * statement because positional parameters make the two easy to desynchronize.
 * `newName` of `null` preserves the stored name.
 */
export function groupMoveBindings(
	groupId: number,
	targetParentId: number | null,
	expectedParentId: number | null,
	newName: string | null,
): Array<string | number | null> {
	return [
		groupId,
		targetParentId,
		GROUP_DEPTH_PROBE_LIMIT,
		expectedParentId,
		GROUP_DEPTH_PROBE_LIMIT,
		groupId,
		GROUP_DEPTH_PROBE_LIMIT,
		targetParentId,
		newName,
		groupId,
		expectedParentId,
		targetParentId,
		targetParentId,
		targetParentId,
		targetParentId,
		MAX_GROUP_DEPTH,
		targetParentId,
		expectedParentId,
	];
}

/**
 * Guarded insert: the child is written only when the parent still exists and its
 * measured depth leaves room for one more level.
 *
 * Both conditions live in the statement, which is the whole point. The route's
 * pre-read is a description of the request, never the authority: a parent deleted
 * between that read and this write makes the `EXISTS` subquery false, so nothing is
 * inserted and the `0002` foreign key is never reached — the caller gets a missing
 * parent instead of a raw constraint failure. A parent moved meanwhile cannot
 * produce a depth 17 group for the same reason. A parent-less group is always
 * accepted.
 */
export const GROUP_INSERT_SQL = `WITH RECURSIVE
	parent_chain(id, depth) AS (
		SELECT ?, 1
		UNION
		SELECT parent.parent_id, parent_chain.depth + 1
		FROM parent_chain JOIN link_groups AS parent ON parent.id = parent_chain.id
		WHERE parent.parent_id IS NOT NULL AND parent_chain.depth < ?
	)
INSERT INTO link_groups (name, parent_id)
SELECT ?, ?
WHERE (? IS NULL OR EXISTS (SELECT 1 FROM link_groups AS target WHERE target.id = ?))
	AND (? IS NULL OR (SELECT MAX(depth) FROM parent_chain) < ?)
RETURNING id, name, parent_id, created_at`;

/** Bindings for {@link GROUP_INSERT_SQL}, in statement order. */
export function groupInsertBindings(name: string, parentId: number | null): Array<string | number | null> {
	return [parentId, GROUP_DEPTH_PROBE_LIMIT, name, parentId, parentId, parentId, parentId, MAX_GROUP_DEPTH];
}

/**
 * Conditional delete. A group is removable only when it has no child groups and
 * no links at all, disabled links included: emptiness is not "no active link", it
 * is "nothing left behind". The `ON DELETE SET NULL` of the `0002` foreign key is
 * unchanged and never reached from here, because a group with children cannot be
 * deleted in the first place.
 */
export const GROUP_DELETE_SQL = `DELETE FROM link_groups
WHERE id = ?
	AND NOT EXISTS (SELECT 1 FROM link_groups AS child WHERE child.parent_id = ?)
	AND NOT EXISTS (SELECT 1 FROM links AS link WHERE link.group_id = ?)
RETURNING id, name`;

/** Bindings for {@link GROUP_DELETE_SQL}: the id is needed by all three clauses. */
export function groupDeleteBindings(groupId: number): Array<number> {
	return [groupId, groupId, groupId];
}

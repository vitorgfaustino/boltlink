/*
 * Copyright (c) 2026 Vitor Faustino
 * AGPL-3.0 License — https://github.com/vitorgfaustino/boltlink
 *
 * Phase 5, Gate 5.1: group hierarchy integrity.
 *
 * The hierarchy itself is not new — `link_groups.parent_id` arrives with
 * migration `0002` — so this suite adds no schema. It pins what Gate 5.1 makes
 * safe around it: the `parentId` contract, parent existence, self and indirect
 * cycles, the observed-parent precondition, the depth ceiling, the atomic delete
 * rules, fail-closed reads of a corrupt graph, and the concurrency properties
 * that only hold because each write is a single conditional statement.
 *
 * `PUBLIC_REDIRECT_SQL` and the whole redirect path are frozen: one test asserts
 * the redirect still runs exactly one schema-neutral read and never names the
 * group table.
 */

import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetRateLimitStore } from "../src/rate-limit";
import worker from "../src/index";
import {
	GROUP_DELETE_SQL,
	GROUP_INSERT_SQL,
	GROUP_MOVE_SQL,
	MAX_GROUP_DEPTH,
	analyzeGroupHierarchy,
	groupDeleteBindings,
	groupInsertBindings,
	groupMoveBindings,
	isWithinSubtree,
} from "../src/group-hierarchy";
import type { GroupHierarchyRow } from "../src/group-hierarchy";

const SCHEMA_STATEMENTS = [
	`CREATE TABLE IF NOT EXISTS links (
	  id INTEGER PRIMARY KEY AUTOINCREMENT,
	  slug TEXT NOT NULL UNIQUE,
	  target_url TEXT NOT NULL,
	  clicks_total INTEGER NOT NULL DEFAULT 0,
	  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	  disabled_at TEXT,
	  expires_at TEXT,
	  go_live_at TEXT,
	  redirect_type TEXT NOT NULL DEFAULT '302',
	  tags TEXT,
	  has_qrcode INTEGER NOT NULL DEFAULT 0,
	  group_id INTEGER,
	  password_hash TEXT,
	  ab_enabled INTEGER NOT NULL DEFAULT 0,
	  ab_target_url TEXT,
	  ab_weight_b INTEGER NOT NULL DEFAULT 50,
	  ab_generation INTEGER NOT NULL DEFAULT 0,
	  metric_epoch INTEGER NOT NULL DEFAULT 0,
	  ab_clicks_a INTEGER NOT NULL DEFAULT 0,
	  ab_clicks_b INTEGER NOT NULL DEFAULT 0,
	  ab_started_at TEXT,
	  version INTEGER NOT NULL DEFAULT 1
	)`,
	"CREATE INDEX IF NOT EXISTS idx_links_slug ON links(slug)",
	"CREATE INDEX IF NOT EXISTS idx_links_group_id ON links(group_id)",
	`CREATE TABLE IF NOT EXISTS link_groups (
	  id INTEGER PRIMARY KEY AUTOINCREMENT,
	  name TEXT NOT NULL,
	  parent_id INTEGER,
	  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	  FOREIGN KEY (parent_id) REFERENCES link_groups(id) ON DELETE SET NULL
	)`,
	"CREATE INDEX IF NOT EXISTS idx_link_groups_parent_id ON link_groups(parent_id)",
];

async function resetDatabase() {
	for (const statement of SCHEMA_STATEMENTS) {
		await env.db_boltlink.prepare(statement).run();
	}
	await env.db_boltlink.prepare("DROP VIEW IF EXISTS boltlink_metric_fence").run();
	await env.db_boltlink.prepare("DELETE FROM links").run();
	await env.db_boltlink.prepare("DELETE FROM link_groups").run();
}

function passThrough(target: object, prop: string | symbol) {
	const value = Reflect.get(target, prop);
	return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
}

/** A distinct handle identity over the same database, modelling a second isolate. */
function cloneDbHandle(db: D1Database): D1Database {
	return new Proxy(db, {
		get(target, prop) {
			return passThrough(target, prop);
		},
	}) as D1Database;
}

/**
 * Deterministic interleaving of the create race: the guarded insert is held until
 * the parent has been removed, so the order is exactly "the pre-read answered,
 * the parent is gone, the insert runs". No sleep and no timing assumption is
 * involved, and `attempts` proves the seam fired, so a matcher that stopped
 * matching fails the test instead of letting it pass on an early 404.
 *
 * The removal goes through `db` itself — the unproxied handle, standing in for the
 * second request — so the interposition cannot recurse into itself.
 */
function deleteParentBeforeInsert(db: D1Database, parentId: number, race: { attempts: number }): D1Database {
	const wrapBound = (bound: D1PreparedStatement) =>
		new Proxy(bound, {
			get(bs, boundProp) {
				if (boundProp === "bind") {
					return (...args: unknown[]) =>
						wrapBound((bs as unknown as { bind: (...values: unknown[]) => D1PreparedStatement }).bind(...args));
				}
				if (boundProp !== "first") {
					return passThrough(bs, boundProp);
				}

				return async (...args: unknown[]) => {
					race.attempts += 1;
					await db.prepare("DELETE FROM link_groups WHERE id = ?").bind(parentId).run();
					return (bs as unknown as { first: (...values: unknown[]) => Promise<unknown> }).first(...args);
				};
			},
		});

	return new Proxy(db, {
		get(target, prop) {
			if (prop !== "prepare") {
				return passThrough(target, prop);
			}

			return (sql: string) => {
				const statement = target.prepare(sql);
				return sql === GROUP_INSERT_SQL ? wrapBound(statement) : statement;
			};
		},
	}) as D1Database;
}

type TracedHandle = { handle: D1Database; statements: string[] };

function tracedHandle(db: D1Database): TracedHandle {
	const statements: string[] = [];
	const handle = new Proxy(db, {
		get(target, prop) {
			if (prop !== "prepare") {
				return passThrough(target, prop);
			}
			return (sql: string) => {
				statements.push(sql);
				return target.prepare(sql);
			};
		},
	}) as D1Database;
	return { handle, statements };
}

async function fetchWorker(url: string, init?: RequestInit, handle?: D1Database) {
	const request = new Request(url, init);
	const ctx = createExecutionContext();
	const response = await worker.fetch(
		request,
		{ ...env, PASSWORD_SESSION_SECRET: "test-secret", db_boltlink: handle ?? cloneDbHandle(env.db_boltlink) },
		ctx,
	);
	await waitOnExecutionContext(ctx);
	return response;
}

function jsonInit(method: string, body: unknown): RequestInit {
	return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

async function createGroup(name: string, parentId?: number | null, handle?: D1Database) {
	const body = parentId === undefined ? { name } : { name, parentId };
	return fetchWorker("http://localhost/api/groups", jsonInit("POST", body), handle);
}

async function createGroupId(name: string, parentId?: number | null): Promise<number> {
	const response = await createGroup(name, parentId);
	expect(response.status).toBe(201);
	const payload = (await response.json()) as { group: { id: number } };
	return payload.group.id;
}

async function moveGroup(
	groupId: number,
	body: { parentId?: number | null; expectedParentId?: number | null },
	handle?: D1Database,
) {
	return fetchWorker(`http://localhost/api/groups/${groupId}`, jsonInit("PATCH", body), handle);
}

async function listGroups(handle?: D1Database) {
	return fetchWorker("http://localhost/api/groups", undefined, handle);
}

/** Direct read, used to prove the stored state after a refused write. */
async function storedParent(groupId: number): Promise<number | null> {
	const row = await env.db_boltlink
		.prepare("SELECT parent_id FROM link_groups WHERE id = ?")
		.bind(groupId)
		.first<{ parent_id: number | null }>();
	return row ? row.parent_id ?? null : null;
}

async function groupCount(): Promise<number> {
	const row = await env.db_boltlink.prepare("SELECT COUNT(1) AS total FROM link_groups").first<{ total: number }>();
	return row?.total ?? 0;
}

/** Every stored group name, to prove what a refused write did and did not leave. */
async function storedNames(): Promise<string[]> {
	const rows = await env.db_boltlink.prepare("SELECT name FROM link_groups ORDER BY name").all<{ name: string }>();
	return (rows.results ?? []).map((row) => row.name);
}

/** Builds a root-to-leaf chain of `length` groups and returns their ids. */
async function buildChain(length: number, parentId: number | null = null): Promise<number[]> {
	const ids: number[] = [];
	let parent = parentId;
	for (let level = 1; level <= length; level += 1) {
		parent = await createGroupId(`nivel-${level}-${Math.random().toString(36).slice(2, 7)}`, parent);
		ids.push(parent);
	}
	return ids;
}

beforeEach(async () => {
	await resetDatabase();
	resetRateLimitStore();
});

describe("Phase 5: group hierarchy graph helpers", () => {
	it("measures depth from the root and height of each subtree", () => {
		const rows: GroupHierarchyRow[] = [
			{ id: 1, parent_id: null },
			{ id: 2, parent_id: 1 },
			{ id: 3, parent_id: 2 },
			{ id: 4, parent_id: 1 },
		];

		const analysis = analyzeGroupHierarchy(rows);
		expect(analysis.ok).toBe(true);
		if (!analysis.ok) {
			return;
		}

		// A root group is depth 1.
		expect(analysis.snapshot.depthById.get(1)).toBe(1);
		expect(analysis.snapshot.depthById.get(2)).toBe(2);
		expect(analysis.snapshot.depthById.get(3)).toBe(3);
		expect(analysis.snapshot.depthById.get(4)).toBe(2);
		// Height counts the node itself, so a leaf is 1.
		expect(analysis.snapshot.heightById.get(3)).toBe(1);
		expect(analysis.snapshot.heightById.get(2)).toBe(2);
		expect(analysis.snapshot.heightById.get(1)).toBe(3);
	});

	it("refuses a cycle and a dangling parent instead of measuring them", () => {
		expect(analyzeGroupHierarchy([{ id: 1, parent_id: 1 }])).toEqual({ ok: false, reason: "cycle" });
		expect(
			analyzeGroupHierarchy([
				{ id: 1, parent_id: 2 },
				{ id: 2, parent_id: 1 },
			]),
		).toEqual({ ok: false, reason: "cycle" });
		// `dangling` is unreachable while the 0002 foreign key is enforced; the read
		// path still refuses it rather than rendering an orphan as a root.
		expect(analyzeGroupHierarchy([{ id: 1, parent_id: 99 }])).toEqual({ ok: false, reason: "dangling" });
	});

	it("keeps every statement placeholder aligned with its bindings", () => {
		const placeholders = (sql: string) => (sql.match(/\?/g) || []).length;

		expect(groupMoveBindings(7, 3, null, "nome")).toHaveLength(placeholders(GROUP_MOVE_SQL));
		expect(groupMoveBindings(7, null, 3, null)).toHaveLength(placeholders(GROUP_MOVE_SQL));
		expect(groupInsertBindings("nome", 3)).toHaveLength(placeholders(GROUP_INSERT_SQL));
		expect(groupInsertBindings("nome", null)).toHaveLength(placeholders(GROUP_INSERT_SQL));
		expect(groupDeleteBindings(7)).toHaveLength(placeholders(GROUP_DELETE_SQL));
	});

	it("treats a group itself and its descendants as inside its subtree", () => {
		const parentById = new Map<number, number | null>([
			[1, null],
			[2, 1],
			[3, 2],
			[4, null],
		]);

		expect(isWithinSubtree(parentById, 1, 1)).toBe(true);
		expect(isWithinSubtree(parentById, 1, 3)).toBe(true);
		expect(isWithinSubtree(parentById, 2, 1)).toBe(false);
		expect(isWithinSubtree(parentById, 1, 4)).toBe(false);
		// A null candidate is a root move, which is never inside a subtree.
		expect(isWithinSubtree(parentById, 1, null)).toBe(false);
	});

	it("exposes the depth ceiling the API enforces", () => {
		expect(MAX_GROUP_DEPTH).toBe(16);
	});
});

describe("Phase 5: parentId contract", () => {
	it("treats an absent and a null parentId as root", async () => {
		const absent = await createGroup("sem-parent");
		expect(absent.status).toBe(201);
		expect(((await absent.json()) as { group: { parent_id: number | null } }).group.parent_id).toBeNull();

		const explicitNull = await createGroup("parent-nulo", null);
		expect(explicitNull.status).toBe(201);
		expect(((await explicitNull.json()) as { group: { parent_id: number | null } }).group.parent_id).toBeNull();
	});

	it("creates a child under a positive parentId", async () => {
		const parentId = await createGroupId("pai");
		const child = await createGroup("filho", parentId);
		expect(child.status).toBe(201);
		expect(((await child.json()) as { group: { parent_id: number | null } }).group.parent_id).toBe(parentId);
	});

	it("rejects invalid parentId types with 400 and creates nothing", async () => {
		const before = await groupCount();
		for (const parentId of ["1", 1.5, 0, -3, true, {}, []]) {
			const response = await createGroup("invalido", parentId as unknown as number);
			expect(response.status, `parentId ${JSON.stringify(parentId)}`).toBe(400);
		}
		expect(await groupCount()).toBe(before);
	});

	it("answers 404 for a missing parent instead of ignoring or re-parenting it", async () => {
		const before = await groupCount();
		const response = await createGroup("orfao", 987654);
		expect(response.status).toBe(404);
		expect(((await response.json()) as { error: string }).error).toBe("Parent group not found");
		// Not ignored, not converted to root, not created implicitly.
		expect(await groupCount()).toBe(before);
	});

	it("preserves the parent when PATCH omits parentId and moves it to root when null", async () => {
		const parentId = await createGroupId("pai");
		const childId = await createGroupId("filho", parentId);

		const renamed = await moveGroup(childId, { name: "filho-renomeado" });
		expect(renamed.status).toBe(200);
		expect(((await renamed.json()) as { group: { name: string; parent_id: number | null } }).group.parent_id).toBe(parentId);

		const toRoot = await moveGroup(childId, { parentId: null, expectedParentId: parentId });
		expect(toRoot.status).toBe(200);
		expect(((await toRoot.json()) as { group: { parent_id: number | null } }).group.parent_id).toBeNull();
		expect(await storedParent(childId)).toBeNull();
	});

	it("answers 400 when parentId changes without the observed parent", async () => {
		const parentId = await createGroupId("pai");
		const childId = await createGroupId("filho");

		const response = await moveGroup(childId, { parentId });
		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: string }).error).toBe("expectedParentId is required when parentId changes");
		expect(await storedParent(childId)).toBeNull();
	});
});

describe("Phase 5: cycle refusal", () => {
	it("refuses self-parenting with 409 and writes nothing", async () => {
		const groupId = await createGroupId("auto");
		const response = await moveGroup(groupId, { parentId: groupId, expectedParentId: null });

		expect(response.status).toBe(409);
		expect(((await response.json()) as { error: string }).error).toBe("Group cannot be its own parent");
		expect(await storedParent(groupId)).toBeNull();
	});

	it("refuses a two-step ring A > B then A under B", async () => {
		const aId = await createGroupId("A");
		const bId = await createGroupId("B", aId);

		const response = await moveGroup(aId, { parentId: bId, expectedParentId: null });
		expect(response.status).toBe(409);
		expect(((await response.json()) as { error: string }).error).toBe("Group cannot be moved into its own subtree");
		expect(await storedParent(aId)).toBeNull();
		expect(await storedParent(bId)).toBe(aId);
	});

	it("refuses an arbitrary ring A > B > C then A under C", async () => {
		const aId = await createGroupId("A");
		const bId = await createGroupId("B", aId);
		const cId = await createGroupId("C", bId);
		const dId = await createGroupId("D", cId);

		// Both a direct parent and a deeper descendant are refused.
		expect((await moveGroup(aId, { parentId: cId, expectedParentId: null })).status).toBe(409);
		expect((await moveGroup(bId, { parentId: dId, expectedParentId: aId })).status).toBe(409);
		// Self-parenting is refused at any depth, not only for a root group.
		expect((await moveGroup(cId, { parentId: cId, expectedParentId: bId })).status).toBe(409);

		// The ring stayed open and the subtree is untouched.
		expect(await storedParent(aId)).toBeNull();
		expect(await storedParent(bId)).toBe(aId);
		expect(await storedParent(cId)).toBe(bId);
		expect(await storedParent(dId)).toBe(cId);
	});

	it("still allows moving a leaf under its own ancestor", async () => {
		const aId = await createGroupId("A");
		const bId = await createGroupId("B", aId);
		const cId = await createGroupId("C", bId);

		// C has no descendants, so re-parenting it under A closes no ring.
		const response = await moveGroup(cId, { parentId: aId, expectedParentId: bId });
		expect(response.status).toBe(200);
		expect(await storedParent(cId)).toBe(aId);
	});
});

describe("Phase 5: depth limit", () => {
	it("accepts depth 16 and refuses depth 17 on create", async () => {
		// Root is depth 1, so a chain of 15 puts the next group at the ceiling.
		const chain = await buildChain(15);
		const atCeiling = await createGroup("nivel-16", chain[14]);
		expect(atCeiling.status).toBe(201);
		const level16 = ((await atCeiling.json()) as { group: { id: number } }).group.id;

		const before = await groupCount();
		const pastCeiling = await createGroup("nivel-17", level16);
		expect(pastCeiling.status).toBe(409);
		expect(((await pastCeiling.json()) as { error: string }).error).toContain("depth limit of 16");
		expect(await groupCount()).toBe(before);
	});

	it("counts the whole moved subtree, not only its root node", async () => {
		// A deep branch whose 3-node subtree currently sits at depth 6.
		const chain = await buildChain(15);
		const shallow = chain[4];
		const subtreeRoot = await createGroupId("subarvore", shallow);
		const subtreeChild = await createGroupId("subarvore-filho", subtreeRoot);
		const subtreeLeaf = await createGroupId("subarvore-neto", subtreeChild);
		const depth14 = chain[13];

		// depth 14 + subtree height 3 = 17 > 16, and the move goes deeper.
		const response = await moveGroup(subtreeRoot, { parentId: depth14, expectedParentId: shallow });
		expect(response.status).toBe(409);
		expect(await storedParent(subtreeRoot)).toBe(shallow);
		expect(await storedParent(subtreeChild)).toBe(subtreeRoot);
		expect(await storedParent(subtreeLeaf)).toBe(subtreeChild);

		// Moving the same subtree to the root is inside the ceiling.
		const up = await moveGroup(subtreeRoot, { parentId: null, expectedParentId: shallow });
		expect(up.status).toBe(200);
		expect(await storedParent(subtreeLeaf)).toBe(subtreeChild);
	});

	it("keeps a legacy over-deep tree readable and repairable upwards", async () => {
		// Built directly, bypassing the API: a 20 node chain that already violates
		// the ceiling. It must stay readable and its deepest node must be movable up.
		let parent: number | null = null;
		const ids: number[] = [];
		for (let level = 1; level <= 20; level += 1) {
			const row = await env.db_boltlink
				.prepare("INSERT INTO link_groups (name, parent_id) VALUES (?, ?) RETURNING id")
				.bind(`legado-${level}`, parent)
				.first<{ id: number }>();
			parent = row!.id;
			ids.push(parent);
		}

		const listed = await listGroups();
		expect(listed.status).toBe(200);
		expect(((await listed.json()) as { groups: unknown[] }).groups).toHaveLength(20);

		// Reducing the violation is accepted even though the tree is still over-deep.
		const repair = await moveGroup(ids[19], { parentId: null, expectedParentId: ids[18] });
		expect(repair.status).toBe(200);
		expect(await storedParent(ids[19])).toBeNull();

		// A separate compliant branch to move the over-deep subtree under.
		const separate = await buildChain(10);

		// Deepening the violation is refused: depth 10 + subtree height 20.
		const deeper = await moveGroup(ids[0], { parentId: separate[9], expectedParentId: null });
		expect(deeper.status).toBe(409);
		expect(((await deeper.json()) as { error: string }).error).toContain("depth limit of 16");
		expect(await storedParent(ids[0])).toBeNull();

		// A move that neither reduces nor complies is refused as well.
		const noop = await moveGroup(ids[0], { parentId: null, expectedParentId: null });
		expect(noop.status).toBe(409);
		expect(await storedParent(ids[0])).toBeNull();

		// Creating under a group already past the ceiling is refused too.
		const create = await createGroup("legado-21", ids[18]);
		expect(create.status).toBe(409);
	});
});

describe("Phase 5: delete contract", () => {
	it("answers 404 for a group that does not exist", async () => {
		const response = await fetchWorker("http://localhost/api/groups/424242", { method: "DELETE" });
		expect(response.status).toBe(404);
	});

	it("removes a group that has no children and no links", async () => {
		const groupId = await createGroupId("vazio");
		const response = await fetchWorker(`http://localhost/api/groups/${groupId}`, { method: "DELETE" });

		expect(response.status).toBe(200);
		expect(await groupCount()).toBe(0);
		expect(((await (await listGroups()).json()) as { groups: unknown[] }).groups).toEqual([]);
	});

	it("refuses a group that still has an active link", async () => {
		const groupId = await createGroupId("com-link");
		await env.db_boltlink
			.prepare("INSERT INTO links (slug, target_url, group_id) VALUES (?, ?, ?)")
			.bind("link-ativo", "https://example.com/a", groupId)
			.run();

		const response = await fetchWorker(`http://localhost/api/groups/${groupId}`, { method: "DELETE" });
		expect(response.status).toBe(409);
		expect(((await response.json()) as { error: string }).error).toBe("Group still has links");
		expect(await groupCount()).toBe(1);
	});

	it("refuses a group whose only link is disabled", async () => {
		const groupId = await createGroupId("so-desabilitado");
		await env.db_boltlink
			.prepare("INSERT INTO links (slug, target_url, disabled_at, group_id) VALUES (?, ?, ?, ?)")
			.bind("link-desabilitado", "https://example.com/b", "2026-01-01T00:00:00.000Z", groupId)
			.run();

		// Emptiness is "nothing left behind", not "no active link".
		const response = await fetchWorker(`http://localhost/api/groups/${groupId}`, { method: "DELETE" });
		expect(response.status).toBe(409);
		expect(await groupCount()).toBe(1);
	});

	it("refuses a group that has children, without promoting them", async () => {
		const parentId = await createGroupId("pai");
		const childId = await createGroupId("filho", parentId);

		const response = await fetchWorker(`http://localhost/api/groups/${parentId}`, { method: "DELETE" });
		expect(response.status).toBe(409);
		expect(((await response.json()) as { error: string }).error).toBe("Group has child groups");
		// No cascade and no automatic re-parenting.
		expect(await groupCount()).toBe(2);
		expect(await storedParent(childId)).toBe(parentId);
	});

	it("removes the children before the parent, one deliberate delete at a time", async () => {
		const parentId = await createGroupId("pai");
		const childId = await createGroupId("filho", parentId);

		expect((await fetchWorker(`http://localhost/api/groups/${childId}`, { method: "DELETE" })).status).toBe(200);
		expect((await fetchWorker(`http://localhost/api/groups/${parentId}`, { method: "DELETE" })).status).toBe(200);
		expect(await groupCount()).toBe(0);
	});
});

describe("Phase 5: no automatic group cleanup", () => {
	it("keeps a group after its last active link is soft deleted", async () => {
		const groupId = await createGroupId("temporario");
		await env.db_boltlink
			.prepare("INSERT INTO links (slug, target_url, group_id) VALUES (?, ?, ?)")
			.bind("unico-link", "https://example.com/only", groupId)
			.run();

		const deleted = await fetchWorker("http://localhost/api/links/unico-link", { method: "DELETE" });
		expect(deleted.status).toBe(200);
		expect(await groupCount()).toBe(1);
	});

	it("keeps the source group when its last link moves elsewhere", async () => {
		const sourceId = await createGroupId("origem");
		const targetId = await createGroupId("destino");
		await env.db_boltlink
			.prepare("INSERT INTO links (slug, target_url, group_id) VALUES (?, ?, ?)")
			.bind("link-movido", "https://example.com/moved", sourceId)
			.run();

		const moved = await fetchWorker("http://localhost/api/links/link-movido", jsonInit("PATCH", { groupId: targetId }));
		expect(moved.status).toBe(200);
		expect(((await moved.json()) as { link: { group_id: number | null } }).link.group_id).toBe(targetId);

		// Both groups survive: the emptied one is not a deletion candidate.
		expect(await groupCount()).toBe(2);
	});

	it("keeps a group that holds only a disabled link when another link leaves", async () => {
		const groupId = await createGroupId("misto");
		await env.db_boltlink
			.prepare("INSERT INTO links (slug, target_url, disabled_at, group_id) VALUES (?, ?, ?, ?)")
			.bind("desabilitado", "https://example.com/off", "2026-01-01T00:00:00.000Z", groupId)
			.run();
		await env.db_boltlink
			.prepare("INSERT INTO links (slug, target_url, group_id) VALUES (?, ?, ?)")
			.bind("ativo", "https://example.com/on", groupId)
			.run();

		expect((await fetchWorker("http://localhost/api/links/ativo", { method: "DELETE" })).status).toBe(200);
		// The group is not empty while a disabled link still points at it.
		expect(await groupCount()).toBe(1);
		expect((await fetchWorker(`http://localhost/api/groups/${groupId}`, { method: "DELETE" })).status).toBe(409);
	});
});

describe("Phase 5: corrupt hierarchy fails closed", () => {
	async function buildCorruptRing(): Promise<{ aId: number; bId: number }> {
		const aId = await createGroupId("A");
		const bId = await createGroupId("B", aId);
		// An external SQL edit, the only way this state can appear.
		await env.db_boltlink.prepare("UPDATE link_groups SET parent_id = ? WHERE id = ?").bind(bId, aId).run();
		return { aId, bId };
	}

	it("answers 409 on the list instead of a partial tree", async () => {
		const { aId, bId } = await buildCorruptRing();

		const response = await listGroups();
		expect(response.status).toBe(409);
		expect(((await response.json()) as { error: string }).error).toBe("Group hierarchy is corrupt");
		expect(response.headers.get("Cache-Control")).not.toBeNull();

		// No automatic repair: the ring is still stored exactly as it was.
		expect(await storedParent(aId)).toBe(bId);
		expect(await storedParent(bId)).toBe(aId);
	});

	it("refuses creates and moves while the graph is uninterpretable", async () => {
		const { aId, bId } = await buildCorruptRing();
		const before = await groupCount();

		const created = await createGroup("novo", aId);
		expect(created.status).toBe(409);
		expect(((await created.json()) as { error: string }).error).toBe("Group hierarchy is corrupt");

		const root = await createGroup("raiz-nova");
		// A root create does not interpret the tree, so it still works.
		expect(root.status).toBe(201);

		// A move always interprets the tree, so it fails closed even when the
		// requested edge itself would be harmless.
		const move = await moveGroup(aId, { parentId: null, expectedParentId: bId });
		expect(move.status).toBe(409);
		expect(((await move.json()) as { error: string }).error).toBe("Group hierarchy is corrupt");

		expect(await groupCount()).toBe(before + 1);
	});

	it("terminates instead of looping when the stored graph holds a cycle", async () => {
		await buildCorruptRing();
		// The assertions above already prove a bounded answer; this pins that the
		// request path itself never throws or hangs.
		await expect(listGroups()).resolves.toBeInstanceOf(Response);
	});
});

describe("Phase 5: concurrency on two handles", () => {
	it("accepts at most one of two opposite moves", async () => {
		const aId = await createGroupId("A");
		const bId = await createGroupId("B");
		const handleA = cloneDbHandle(env.db_boltlink);
		const handleB = cloneDbHandle(env.db_boltlink);

		const [first, second] = await Promise.all([
			moveGroup(aId, { parentId: bId, expectedParentId: null }, handleA),
			moveGroup(bId, { parentId: aId, expectedParentId: null }, handleB),
		]);

		const statuses = [first.status, second.status].sort();
		expect(statuses).toEqual([200, 409]);

		// The surviving state is acyclic: exactly one group became the parent.
		const parentOfA = await storedParent(aId);
		const parentOfB = await storedParent(bId);
		expect([parentOfA, parentOfB].filter((value) => value !== null)).toHaveLength(1);
		expect(parentOfA === bId || parentOfB === aId).toBe(true);
	});

	it("rejects a move issued against a parent that changed meanwhile", async () => {
		const aId = await createGroupId("A");
		const xId = await createGroupId("X");
		const yId = await createGroupId("Y");
		const zId = await createGroupId("Z");
		const staleHandle = cloneDbHandle(env.db_boltlink);
		const otherHandle = cloneDbHandle(env.db_boltlink);

		// Client 1 observed A at the root. Client 2 moves A under X.
		const otherMove = await moveGroup(aId, { parentId: xId, expectedParentId: null }, otherHandle);
		expect(otherMove.status).toBe(200);

		// Client 1 still believes the parent is the root: the write is refused.
		const stale = await moveGroup(aId, { parentId: yId, expectedParentId: null }, staleHandle);
		expect(stale.status).toBe(409);
		expect(((await stale.json()) as { error: string }).error).toBe("Group parent changed. Reload the tree and try again");
		expect(await storedParent(aId)).toBe(xId);

		// After reloading, the same client moves A under Z with the observed parent.
		const fresh = await moveGroup(aId, { parentId: zId, expectedParentId: xId }, staleHandle);
		expect(fresh.status).toBe(200);
		expect(await storedParent(aId)).toBe(zId);
	});

	it("answers 404 when the parent is deleted between the pre-read and the insert", async () => {
		const parentId = await createGroupId("pai-efemero");
		expect(await storedNames()).toEqual(["pai-efemero"]);

		// Request A validated this parent; request B removes it right before A's
		// insert. The interleaving is forced, not raced.
		const race = { attempts: 0 };
		const racingHandle = deleteParentBeforeInsert(env.db_boltlink, parentId, race);

		const response = await createGroup("filho", parentId, racingHandle);

		// The insert was reached once, so this is the race and not an early refusal.
		expect(race.attempts).toBe(1);

		const text = await response.text();
		expect(response.status).toBe(404);
		expect(JSON.parse(text)).toEqual({ error: "Parent group not found" });
		// No exposed foreign-key failure, no raw SQL and no stack in the payload.
		expect(text).not.toMatch(/SQLITE_CONSTRAINT|FOREIGN KEY|constraint failed|at Object\./i);

		// The removed parent stayed removed and the child was never written: the
		// zero-row insert is reported, not retried.
		expect(await storedNames()).toEqual([]);
	});

	it("keeps simultaneous renames last-write-wins, with no version column added", async () => {
		const groupId = await createGroupId("original");
		const handleA = cloneDbHandle(env.db_boltlink);
		const handleB = cloneDbHandle(env.db_boltlink);

		const [first, second] = await Promise.all([
			moveGroup(groupId, { name: "primeiro" }, handleA),
			moveGroup(groupId, { name: "segundo" }, handleB),
		]);

		// Both renames are accepted by design: Gate 5.1 does not add optimistic
		// locking to groups, and the last writer wins.
		expect([first.status, second.status]).toEqual([200, 200]);
		const stored = await env.db_boltlink
			.prepare("SELECT name FROM link_groups WHERE id = ?")
			.bind(groupId)
			.first<{ name: string }>();
		expect(["primeiro", "segundo"]).toContain(stored?.name);
	});
});

describe("Phase 5: read contract and redirect freeze", () => {
	it("keeps GET /api/groups flat with parent_id and no nested tree", async () => {
		const parentId = await createGroupId("pai");
		await createGroupId("filho", parentId);

		const response = await listGroups();
		expect(response.status).toBe(200);
		const payload = (await response.json()) as { groups: Array<Record<string, unknown>> };

		expect(payload.groups).toHaveLength(2);
		for (const group of payload.groups) {
			expect(Object.keys(group).sort()).toEqual(["created_at", "id", "name", "parent_id"]);
		}
		// Enough to mount the tree in the client, without a new nested shape.
		expect(payload.groups.some((group) => group.parent_id === parentId)).toBe(true);
	});

	it("never touches the group table on the public redirect", async () => {
		const groupId = await createGroupId("roteado");
		await env.db_boltlink
			.prepare("INSERT INTO links (slug, target_url, group_id) VALUES (?, ?, ?)")
			.bind("destino", "https://example.com/target", groupId)
			.run();

		const traced = tracedHandle(cloneDbHandle(env.db_boltlink));
		// Warm the handle first: the first request on an isolate validates the
		// schema, and this test measures the steady-state redirect.
		await fetchWorker("https://example.com/destino", undefined, traced.handle);

		traced.statements.length = 0;
		const response = await fetchWorker("https://example.com/destino", undefined, traced.handle);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("https://example.com/target");

		// The redirect stays the single schema-neutral read.
		const selects = traced.statements.filter((sql) => sql.trimStart().startsWith("SELECT"));
		expect(selects).toHaveLength(1);
		expect(selects[0]).toBe("SELECT * FROM links WHERE slug = ? AND disabled_at IS NULL");
		expect(traced.statements.some((sql) => /link_groups|JOIN|PRAGMA|WITH RECURSIVE/i.test(sql))).toBe(false);
	});
});

describe("Gate 9.1: recursive administrative group filter", () => {
	async function fixture() {
		const a = await createGroupId("Franquia 01");
		const b = await createGroupId("Bio", a);
		const c = await createGroupId("Instagram", b);
		const d = await createGroupId("Cardápio", a);
		const e = await createGroupId("Outro");
		const f = await createGroupId("Mais profundo", c);
		for (const [slug, id] of [["a1", a], ["b1", b], ["c1", c], ["d1", d], ["e1", e], ["f1", f], ["ungrouped", null]] as const) {
			await env.db_boltlink.prepare("INSERT INTO links (slug, target_url, group_id) VALUES (?, 'https://example.com/', ?)").bind(slug, id).run();
		}
		return { a, b, c, d, e, f };
	}
	async function slugs(query: string) {
		const response = await fetchWorker(`http://localhost/api/links${query ? "?" + query : ""}`);
		expect(response.status).toBe(200);
		const data = await response.json() as { links: { slug: string }[] };
		return data.links.map((link) => link.slug).sort();
	}
	it("parent/intermediate/leaf include all descendants without duplicating rows; direct API remains compatible", async () => {
		const { a, b, c, d } = await fixture();
		expect(await slugs(`group_id=${a}&include_descendants=true`)).toEqual(["a1", "b1", "c1", "d1", "f1"]);
		expect(await slugs(`group_id=${b}&include_descendants=true`)).toEqual(["b1", "c1", "f1"]);
		expect(await slugs(`group_id=${c}&include_descendants=true`)).toEqual(["c1", "f1"]);
		expect(await slugs(`group_id=${d}&include_descendants=true`)).toEqual(["d1"]);
		expect(await slugs(`group_id=${a}`)).toEqual(["a1"]);
		expect(await slugs("group_id=null&include_descendants=true")).toEqual(["ungrouped"]);
		expect(await slugs("")).toEqual(["a1", "b1", "c1", "d1", "e1", "f1", "ungrouped"]);
	});
	it("finds old child links before LIMIT even when 110 unrelated newer links exist, excluding tombstones and preserving text search", async () => {
		const { a, e } = await fixture();
		await env.db_boltlink.prepare("DELETE FROM links WHERE slug = 'a1'").run();
		await env.db_boltlink.prepare("UPDATE links SET created_at = '2020-01-01'").run();
		await env.db_boltlink.batch(Array.from({ length: 110 }, (_, i) => env.db_boltlink.prepare("INSERT INTO links (slug, target_url, group_id, created_at) VALUES (?, 'https://example.com/', ?, '2026-01-01')").bind(`unrelated-${i}`, e)));
		await env.db_boltlink.prepare("INSERT INTO links (slug, target_url, group_id, disabled_at) VALUES ('deleted', 'https://example.com/', ?, '2026-01-01')").bind(a).run();
		expect(await slugs(`group_id=${a}&include_descendants=true`)).toEqual(["b1", "c1", "d1", "f1"]);
		expect(await slugs(`group_id=${a}&include_descendants=true&search=c1`)).toEqual(["c1"]);
	});
	it("terminates on a legacy cycle and returns each link once, with no fixed depth limit", async () => {
		const { a, c } = await fixture();
		await env.db_boltlink.prepare("UPDATE link_groups SET parent_id = ? WHERE id = ?").bind(c, a).run();
		expect(await slugs(`group_id=${a}&include_descendants=true`)).toEqual(["a1", "b1", "c1", "d1", "f1"]);
	});
	it("returns an empty list for a genuinely empty/missing group", async () => {
		const id = await createGroupId("Vazio");
		expect(await slugs(`group_id=${id}&include_descendants=true`)).toEqual([]);
		expect(await slugs("group_id=999999&include_descendants=true")).toEqual([]);
	});
});

describe("Gate 9.2: administrative filter audit", () => {
	it("includes each branch of A/B/C/D/E/F in descending creation order, with a single list query", async () => {
		const a = await createGroupId("A");
		const b = await createGroupId("B", a);
		const c = await createGroupId("C", b);
		const d = await createGroupId("D", c);
		const e = await createGroupId("E", b);
		const f = await createGroupId("F", a);
		const x = await createGroupId("B"); // Same name in another tree is unrelated.
		const entries = [["LA", a], ["LB", b], ["LC", c], ["LD", d], ["LE", e], ["LF", f], ["LX", x], ["LN", null]] as const;
		for (const [index, [slug, id]] of entries.entries()) {
			await env.db_boltlink.prepare("INSERT INTO links (slug, target_url, group_id, created_at) VALUES (?, 'https://example.com/', ?, ?)")
				.bind(slug, id, `2026-01-0${index + 1}`).run();
		}
		for (const [id, expected] of [[a, ["LF", "LE", "LD", "LC", "LB", "LA"]], [b, ["LE", "LD", "LC", "LB"]], [c, ["LD", "LC"]], [d, ["LD"]], [f, ["LF"]], ["null", ["LN"]]] as const) {
			const traced = tracedHandle(cloneDbHandle(env.db_boltlink));
			const response = await fetchWorker(`http://localhost/api/links?group_id=${id}&include_descendants=true`, undefined, traced.handle);
			expect(response.status).toBe(200);
			const data = await response.json() as { links: { slug: string }[] };
			expect(data.links.map((link) => link.slug)).toEqual(expected);
			expect(traced.statements.filter((sql) => sql.includes("LEFT JOIN link_groups"))).toHaveLength(1);
			if (id !== "null") expect(traced.statements.filter((sql) => sql.includes("descendant_groups"))).toHaveLength(1);
		}
		await env.db_boltlink.prepare("DELETE FROM links WHERE slug IN ('LA', 'LB', 'LC')").run();
		const response = await fetchWorker(`http://localhost/api/links?group_id=${b}&include_descendants=true`);
		expect(((await response.json()) as { links: { slug: string }[] }).links.map((link) => link.slug)).toEqual(["LE", "LD"]);
	});
	it("supports a 32-level legacy chain without a fixed filter depth cap", async () => {
		let parent: number | null = null;
		let root = 0;
		for (let i = 0; i < 32; i++) {
			const result = await env.db_boltlink.prepare("INSERT INTO link_groups (name, parent_id) VALUES ('Legado', ?)").bind(parent).run();
			parent = Number(result.meta.last_row_id);
			if (!root) root = parent;
		}
		await env.db_boltlink.prepare("INSERT INTO links (slug, target_url, group_id) VALUES ('deep-legacy', 'https://example.com/', ?)").bind(parent).run();
		const response = await fetchWorker(`http://localhost/api/links?group_id=${root}&include_descendants=true`);
		expect(response.status).toBe(200);
		expect(((await response.json()) as { links: { slug: string }[] }).links.map((link) => link.slug)).toEqual(["deep-legacy"]);
		const groupResponse = await fetchWorker("http://localhost/api/groups");
		expect(groupResponse.status).toBe(200); // Deep legacy trees stay readable.
	});
});

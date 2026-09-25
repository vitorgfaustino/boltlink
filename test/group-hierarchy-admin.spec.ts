/*
 * Copyright (c) 2026 Vitor Faustino
 * AGPL-3.0 License — https://github.com/vitorgfaustino/boltlink
 *
 * Phase 5, Gate 5.1: minimal admin tree UX coverage.
 *
 * The tree helpers are pure and DOM-free, so the layout, the ordering, the path
 * labels and the error mapping are verified in Node. Source scans prove the
 * panel keeps the API as the authority: every rejection is shown instead of
 * retried, a group name or full path never reaches an HTML sink, and the move
 * request always carries the observed parent alongside the new one.
 */

// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type Group = { id: number; name: string; parent_id: number | null };

type TreeNode = {
	id: number;
	name: string;
	parentId: number | null;
};

type BuiltTree =
	| { ok: false; reason: string }
	| {
			ok: true;
			roots: TreeNode[];
			childrenOf: Map<number, TreeNode[]>;
			byId: Map<number, TreeNode>;
			depthById: Map<number, number>;
	  };

type FlatRow = {
	group: TreeNode;
	depth: number;
	path: string;
	hasChildren: boolean;
	expanded: boolean;
};

type TreeApi = {
	MAX_DEPTH: number;
	PATH_SEPARATOR: string;
	ERROR_MESSAGES: Record<string, string>;
	normalizeGroups: (groups: unknown) => TreeNode[];
	siblingOrder: (left: TreeNode, right: TreeNode) => number;
	buildTree: (groups: unknown) => BuiltTree;
	groupPath: (byId: Map<number, TreeNode>, groupId: number) => string;
	flattenTree: (tree: BuiltTree & { ok: true }, expandedIds?: Iterable<number>) => FlatRow[];
	subtreeIds: (tree: BuiltTree & { ok: true }, groupId: number) => Set<number>;
	allIds: (tree: BuiltTree & { ok: true }) => Set<number>;
	parentOptions: (tree: BuiltTree & { ok: true }, excludeGroupId?: number | null) => Array<{ value: string; label: string }>;
	groupErrorMessage: (rawMessage: unknown) => string;
	isStaleParentError: (rawMessage: unknown) => boolean;
	isCorruptHierarchyError: (rawMessage: unknown) => boolean;
};

function readPublic(file: string) {
	return readFileSync(resolve(process.cwd(), `public/${file}`), "utf8");
}

function loadTreeApi(): TreeApi {
	const sandbox: { window: { BoltLinkGroupHierarchy?: TreeApi }; URL: typeof URL } = { window: {}, URL };
	vm.createContext(sandbox);
	vm.runInContext(readPublic("group-hierarchy-ui.js"), sandbox);
	const api = sandbox.window.BoltLinkGroupHierarchy;
	if (!api) {
		throw new Error("BoltLinkGroupHierarchy not registered");
	}
	return api;
}

function build(api: TreeApi, groups: Group[]) {
	const tree = api.buildTree(groups);
	if (!tree.ok) {
		throw new Error(`expected a valid tree, got ${tree.reason}`);
	}
	return tree;
}

/** `Clientes`, `Clientes / Brasil`, `Clientes / Brasil / Campinas`. */
const SAMPLE: Group[] = [
	{ id: 1, name: "Clientes", parent_id: null },
	{ id: 2, name: "Fornecedores", parent_id: null },
	{ id: 3, name: "Brasil", parent_id: 1 },
	{ id: 4, name: "Campinas", parent_id: 3 },
];

function functionBody(source: string, name: string) {
	const start = source.indexOf(`function ${name}(`);
	expect(start, `missing function ${name}`).toBeGreaterThan(-1);
	const next = source.indexOf("\nfunction ", start + 1);
	return source.slice(start, next === -1 ? source.length : next);
}

describe("Phase 5: group tree helpers", () => {
	it("assembles the tree from the flat parent_id payload", () => {
		const api = loadTreeApi();
		const tree = build(api, SAMPLE);

		expect(tree.roots.map((group) => group.name)).toEqual(["Clientes", "Fornecedores"]);
		expect(tree.childrenOf.get(1)?.map((group) => group.name)).toEqual(["Brasil"]);
		expect(tree.childrenOf.get(3)?.map((group) => group.name)).toEqual(["Campinas"]);
		expect(tree.depthById.get(1)).toBe(1);
		expect(tree.depthById.get(4)).toBe(3);
	});

	it("orders siblings by name with the id as tiebreaker", () => {
		const api = loadTreeApi();
		const tree = build(api, [
			{ id: 9, name: "beta", parent_id: null },
			{ id: 4, name: "Alpha", parent_id: null },
			{ id: 2, name: "beta", parent_id: null },
		]);

		// Case-insensitive by name, and the repeated name falls back to the id.
		expect(tree.roots.map((group) => group.id)).toEqual([4, 2, 9]);

		// Deterministic: the same input always produces the same order.
		const again = build(api, [
			{ id: 2, name: "beta", parent_id: null },
			{ id: 9, name: "beta", parent_id: null },
			{ id: 4, name: "Alpha", parent_id: null },
		]);
		expect(again.roots.map((group) => group.id)).toEqual([4, 2, 9]);
	});

	it("layers the tree with a Map instead of rescanning the group list", () => {
		const api = loadTreeApi();
		const wide: Group[] = [{ id: 1, name: "raiz", parent_id: null }];
		for (let index = 2; index <= 2000; index += 1) {
			wide.push({ id: index, name: `grupo-${index}`, parent_id: index % 500 === 0 ? 1 : index - 1 });
		}

		const started = Date.now();
		const tree = build(api, wide);
		const elapsed = Date.now() - started;

		// One pass into Map<parentId, children[]> per level, so a 2000 node tree
		// stays linear. The bound is deliberately loose: this is a blowup guard, not
		// a benchmark. `instanceof` cannot be used here because the module runs in
		// its own vm realm.
		expect(Object.prototype.toString.call(tree.childrenOf)).toBe("[object Map]");
		expect(typeof tree.childrenOf.get).toBe("function");
		expect(tree.byId.size).toBe(2000);
		expect(elapsed).toBeLessThan(1000);
	});

	it("refuses a cycle or a missing parent instead of laying out a partial tree", () => {
		const api = loadTreeApi();

		expect(api.buildTree([{ id: 1, name: "A", parent_id: 1 }])).toEqual({ ok: false, reason: "cycle" });
		expect(
			api.buildTree([
				{ id: 1, name: "A", parent_id: 3 },
				{ id: 2, name: "B", parent_id: 1 },
				{ id: 3, name: "C", parent_id: 2 },
			]),
		).toEqual({ ok: false, reason: "cycle" });
		expect(api.buildTree([{ id: 1, name: "A", parent_id: 99 }])).toEqual({ ok: false, reason: "dangling" });
	});

	it("ignores malformed rows instead of throwing", () => {
		const api = loadTreeApi();
		expect(api.normalizeGroups(null)).toEqual([]);
		expect(api.normalizeGroups([null, { name: "sem id" }, { id: 5, name: "ok", parent_id: null }])).toEqual([
			{ id: 5, name: "ok", parentId: null },
		]);
		// A missing name degrades to an empty label rather than to `undefined`.
		expect(api.normalizeGroups([{ id: 6, parent_id: null }])).toEqual([{ id: 6, name: "", parentId: null }]);
	});

	it("shows the full path so repeated names stay distinguishable", () => {
		const api = loadTreeApi();
		const tree = build(api, SAMPLE);

		expect(api.groupPath(tree.byId, 4)).toBe("Clientes / Brasil / Campinas");
		expect(api.groupPath(tree.byId, 1)).toBe("Clientes");
		// A group that is not in the snapshot has no path instead of a broken one.
		expect(api.groupPath(tree.byId, 404)).toBe("");
	});

	it("lists rows depth-first and honours expand/collapse", () => {
		const api = loadTreeApi();
		const tree = build(api, SAMPLE);

		const expanded = api.flattenTree(tree, api.allIds(tree));
		expect(expanded.map((row) => [row.depth, row.path])).toEqual([
			[1, "Clientes"],
			[2, "Clientes / Brasil"],
			[3, "Clientes / Brasil / Campinas"],
			[1, "Fornecedores"],
		]);
		expect(expanded[0].hasChildren).toBe(true);
		expect(expanded[0].expanded).toBe(true);
		expect(expanded[2].hasChildren).toBe(false);

		// A collapsed node hides its whole branch but keeps its own row.
		const collapsed = api.flattenTree(tree, [2]);
		expect(collapsed.map((row) => row.path)).toEqual(["Clientes", "Fornecedores"]);
		expect(collapsed[0].expanded).toBe(false);
	});

	it("offers every parent with its full path and hides the excluded subtree", () => {
		const api = loadTreeApi();
		const tree = build(api, SAMPLE);

		expect(api.parentOptions(tree).map((option) => option.label)).toEqual([
			"Clientes",
			"Clientes / Brasil",
			"Clientes / Brasil / Campinas",
			"Fornecedores",
		]);
		expect(api.parentOptions(tree).map((option) => option.value)).toEqual(["1", "3", "4", "2"]);

		// Moving a group into itself or into its own subtree is not offered: a
		// convenience only, since the API refuses it regardless.
		expect(api.parentOptions(tree, 1).map((option) => option.value)).toEqual(["2"]);
		expect(Array.from(api.subtreeIds(tree, 1)).sort()).toEqual([1, 3, 4]);
	});
});

describe("Phase 5: group error mapping", () => {
	it("maps every API refusal onto the panel message", () => {
		const api = loadTreeApi();

		expect(api.groupErrorMessage("Group hierarchy is corrupt")).toBe(api.ERROR_MESSAGES.CORRUPT);
		expect(api.groupErrorMessage("Group parent changed. Reload the tree and try again")).toBe(
			api.ERROR_MESSAGES.PARENT_CHANGED,
		);
		expect(api.groupErrorMessage("Group cannot be its own parent")).toBe(api.ERROR_MESSAGES.OWN_SUBTREE);
		expect(api.groupErrorMessage("Group cannot be moved into its own subtree")).toBe(api.ERROR_MESSAGES.OWN_SUBTREE);
		expect(api.groupErrorMessage("Group depth limit of 16 exceeded (resulting depth 17)")).toBe(api.ERROR_MESSAGES.DEPTH);
		expect(api.groupErrorMessage("Group has child groups")).toBe(api.ERROR_MESSAGES.HAS_CHILDREN);
		expect(api.groupErrorMessage("Group still has links")).toBe(api.ERROR_MESSAGES.HAS_LINKS);
		expect(api.groupErrorMessage("Parent group not found")).toBe(api.ERROR_MESSAGES.PARENT_MISSING);
		expect(api.groupErrorMessage("Group not found")).toBe(api.ERROR_MESSAGES.NOT_FOUND);

		// The depth message is dynamic, so the ceiling is stated by the panel.
		expect(api.ERROR_MESSAGES.DEPTH).toContain(String(api.MAX_DEPTH));
		expect(api.MAX_DEPTH).toBe(16);
	});

	it("falls back to the server text and still answers for an empty message", () => {
		const api = loadTreeApi();
		expect(api.groupErrorMessage("Falha inesperada")).toBe("Falha inesperada");
		expect(api.groupErrorMessage(undefined)).not.toBe("");
	});

	it("separates the two 409s the panel acts on differently", () => {
		const api = loadTreeApi();
		// The stale parent is resolved by reloading; a corrupt graph is not
		// something the panel may repair.
		expect(api.isStaleParentError("Group parent changed. Reload the tree and try again")).toBe(true);
		expect(api.isStaleParentError("Group hierarchy is corrupt")).toBe(false);
		expect(api.isCorruptHierarchyError("Group hierarchy is corrupt")).toBe(true);
		expect(api.isCorruptHierarchyError("Group parent changed. Reload the tree and try again")).toBe(false);
	});
});

describe("Phase 5: admin wiring", () => {
	it("loads the tree helper before the admin script", () => {
		const html = readPublic("admin.html");
		const scripts = Array.from(html.matchAll(/<script src="([^"]+)"/g)).map((match) => match[1]);

		expect(scripts).toContain("/group-hierarchy-ui.js");
		expect(scripts.indexOf("/group-hierarchy-ui.js")).toBeLessThan(scripts.indexOf("/admin.js"));
	});

	it("registers every group control with a unique id", () => {
		const html = readPublic("admin.html");
		const ids = Array.from(html.matchAll(/\sid="([^"]+)"/g)).map((match) => match[1]);
		expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);

		for (const expected of [
			"group-tree",
			"group-status",
			"group-create-name",
			"group-create-parent",
			"group-create-button",
			"group-move-source",
			"group-move-target",
			"group-move-path",
			"group-move-button",
			"group-expand-all",
			"group-collapse-all",
			"group-refresh",
		]) {
			expect(ids, `missing ${expected}`).toContain(expected);
		}
	});

	it("labels every tree control and pairs each select with its own label", () => {
		const html = readPublic("admin.html");
		const panel = html.slice(html.indexOf('class="panel groups-panel"'));

		expect(panel).toMatch(/<label for="group-create-name">/);
		expect(panel).toMatch(/<label for="group-create-parent">/);
		expect(panel).toMatch(/<label for="group-move-source">/);
		expect(panel).toMatch(/<label for="group-move-target">/);
		// Creation takes an optional parent, which is the CREATE contract.
		expect(panel).toMatch(/Grupo pai \(opcional\)/);
		expect(panel).toMatch(/id="group-create-button"[^>]*>/);
		// The filter stays a direct association, with no implicit descendants.
		expect(html).toMatch(/associação direta ao grupo escolhido, sem incluir subgrupos/);
	});

	it("keeps the tree controls as real buttons and a reachable list", () => {
		const admin = readPublic("admin.js");
		const node = functionBody(admin, "buildGroupNode");

		expect(node).toContain('document.createElement("button")');
		expect(node).toContain("toggle.setAttribute(\"aria-expanded\", String(row.expanded))");
		expect(node).toContain("toggle.textContent");
		// Nested lists are the indent: each row is an <li> inside its parent level.
		const render = functionBody(admin, "renderGroupTree");
		expect(render).toContain('document.createElement("li")');
		expect(render).toContain('document.createElement("ul")');
	});

	it("wraps the first tree level in a real list instead of the plain container", () => {
		const html = readPublic("admin.html");
		const admin = readPublic("admin.js");
		const render = functionBody(admin, "renderGroupTree");

		// The host is a <div>, and an <li> is only valid inside a list, so depth 1
		// needs its own <ul> rather than being appended to the container.
		expect(html).toMatch(/<div class="group-tree" id="group-tree"><\/div>/);
		expect(render).toMatch(/const rootList = document\.createElement\("ul"\)/);
		expect(render).toContain("groupTreeContainer.append(rootList)");
		// The stack starts at that list, so no depth ever lands on the container.
		expect(render).toContain("const listStack = [rootList]");
		expect(render).not.toContain("listStack = [groupTreeContainer]");

		// Deeper levels still nest inside their parent <li>.
		expect(render).toContain('const item = document.createElement("li")');
		expect(render).toContain('const childList = document.createElement("ul")');
		expect(render).toContain("list.append(item)");

		// The added root list changes the semantics, not the layout: the plain rule
		// styles it and the indent still comes from the `li ul` rule alone.
		const css = readPublic("admin.css");
		expect(css).toMatch(/\.group-tree ul\s*\{/);
		expect(css).toMatch(/\.group-tree li ul\s*\{/);
	});

	it("never renders a group name or full path through an HTML sink", () => {
		const admin = readPublic("admin.js");
		const dangerousLines = admin
			.split("\n")
			.filter((line) => /innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(line));

		for (const line of dangerousLines) {
			expect(line).not.toMatch(/groupNode|groupTree|groupPath|groupPathLabel|row\.path|row\.group|parentOptions/i);
		}

		// The panel clears and fills the tree without parsing HTML.
		expect(functionBody(admin, "renderGroupTree")).toContain("groupTreeContainer.replaceChildren()");
		expect(functionBody(admin, "buildGroupNode")).toContain("name.textContent = row.group.name");
		expect(functionBody(admin, "buildGroupNode")).toContain("path.textContent = row.path");
		// Select labels are persisted paths too.
		expect(functionBody(admin, "groupOption")).toContain("option.textContent = label");
		expect(admin).not.toMatch(/groupIdInput\.(innerHTML|outerHTML)/);
	});

	it("keeps the helper module free of DOM access and dynamic code", () => {
		const ui = readPublic("group-hierarchy-ui.js");

		expect(ui).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
		expect(ui).not.toMatch(/\beval\(|new Function\(/);
		expect(ui).not.toMatch(/document\./);
	});

	it("sends the observed parent and the new parent in one move request", () => {
		const admin = readPublic("admin.js");
		const move = functionBody(admin, "moveSelectedGroup");

		expect(move).toContain("body: JSON.stringify({ parentId: targetParentId, expectedParentId: group.parentId })");
		expect(move).toContain('method: "PATCH"');
		// A refused move reloads the tree instead of being retried.
		expect(move).toContain("await loadGroups();");
		expect(admin).toContain("groupHierarchyUi.groupErrorMessage(result.error)");
	});

	it("confirms before deleting and never removes a node the API refused", () => {
		const admin = readPublic("admin.js");
		const remove = functionBody(admin, "deleteGroupFromPanel");

		expect(remove).toContain("window.confirm(");
		expect(remove).toContain('method: "DELETE"');
		// The failure branch reloads and reports: nothing is hidden or dropped early.
		expect(remove).toContain("await loadGroups();");
		expect(remove).toContain("groupHierarchyUi.groupErrorMessage(result.error)");
		expect(remove).not.toMatch(/remove\(\)|replaceChildren\(\)/);
	});

	it("routes every group mutation through the non-throwing request helper", () => {
		const admin = readPublic("admin.js");

		expect(admin).toContain("async function groupRequest(");
		expect(admin).toContain('groupRequest("/api/groups", { method: "GET" })');
		expect(admin).toContain('groupRequest("/api/groups", { method: "POST"');
		expect(admin).toContain("groupRequest(`/api/groups/${groupId}`");
		// The shared throwing helper must not be used for group writes any more.
		expect(admin).not.toMatch(/request\("\/api\/groups"/);
		expect(admin).not.toMatch(/request\(`\/api\/groups/);
	});

	it("fails the panel closed when the tree cannot be interpreted", () => {
		const admin = readPublic("admin.js");
		const load = functionBody(admin, "loadGroups");
		const failure = functionBody(admin, "renderGroupTreeFailure");

		// Both the transport failure and a cycle are shown as a message, with no
		// partial tree and no automatic repair.
		expect(load).toContain("if (!result.ok)");
		expect(load).toContain("if (!tree.ok)");
		expect(load).toContain("renderGroupTreeFailure(");
		expect(failure).toContain("state.groupTree = null");
		expect(failure).toContain("groupTreeContainer.replaceChildren()");
		expect(failure).toContain("notice.textContent = message");
	});

	it("keeps the removed inline group creator out of the link form", () => {
		const html = readPublic("admin.html");
		// Creation with an optional parent lives in the panel; the form keeps only
		// the association select.
		expect(html).not.toContain('id="new-group-name"');
		expect(html).not.toContain('id="create-group-button"');
		expect(html).toContain('id="group-id"');
	});
});

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
			"group-expand-all",
			"group-collapse-all",
			"group-refresh",
			"group-tab-tree",
			"group-tab-create",
			"group-panel-tree",
			"group-panel-create",
			"group-context-editor",
			"group-context-name",
			"group-context-path",
			"group-context-parent",
			"group-context-name-input",
			"group-context-confirm",
			"group-context-cancel",
			"create-link-toggle",
			"group-drawer-open",
			"group-drawer-close",
			"group-drawer-backdrop",
		]) {
			expect(ids, `missing ${expected}`).toContain(expected);
		}
	});

	it("labels every tree control and pairs each select with its own label", () => {
		const html = readPublic("admin.html");
		const panel = html.slice(html.indexOf("<aside"));

		expect(panel).toMatch(/<label for="group-create-name">/);
		expect(panel).toMatch(/<label for="group-create-parent">/);
		expect(panel).toMatch(/<label for="group-context-parent">/);
		expect(panel).toMatch(/<label for="group-context-name-input">/);
		// Creation takes an optional parent, which is the CREATE contract.
		expect(panel).toMatch(/Grupo pai \(opcional\)/);
		expect(panel).toMatch(/id="group-create-button"[^>]*>/);
		// The filter stays a direct association, with no implicit descendants.
		expect(html).toMatch(/vinculados diretamente ao grupo escolhido[\s\S]*Não inclui links dos subgrupos/);
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
		const confirm = functionBody(admin, "confirmGroupContext");

		expect(confirm).toContain("body: JSON.stringify(isMove ? { parentId: targetParentId, expectedParentId: group.parentId } : { name })");
		expect(confirm).toContain('method: "PATCH"');
		expect(confirm).toContain("groupRequest(`/api/groups/${groupId}`");
		// A refused move reloads the tree instead of being retried.
		expect(confirm).toContain("await loadGroups();");
		expect(confirm).toContain("groupHierarchyUi.groupErrorMessage(result.error)");
		// Renaming keeps the documented last-write-wins path: no parentId at all.
		expect(confirm).toMatch(/isMove \? \{ parentId: targetParentId, expectedParentId: group\.parentId \} : \{ name \}/);
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

/** Selector/declaration pairs. Nothing in this stylesheet nests a rule in a rule body. */
function cssRules(source: string) {
	const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
	return Array.from(withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)).map((match) => ({
		selector: match[1].trim(),
		body: match[2],
	}));
}

function rulesMatching(css: string, selectorPattern: RegExp) {
	return cssRules(css).filter((rule) => selectorPattern.test(rule.selector));
}

describe("Phase 5: groups drawer layout", () => {
	it("keeps the group editor out of the main layout flow", () => {
		const html = readPublic("admin.html");
		const main = html.slice(html.indexOf('<section class="layout">'), html.indexOf("</main>"));

		// The tree is no longer a card in the page: nothing inside <main> holds it, so no
		// card can cover it and it cannot cover a card.
		expect(main).not.toContain('id="group-tree"');
		expect(main).not.toContain('id="group-drawer"');
		expect(html).not.toMatch(/class="panel groups-panel/);
		expect(readPublic("admin.css")).not.toMatch(/\.layout\s*>\s*\.groups-panel/);

		// The drawer is the page-level overlay after the main content.
		expect(html.indexOf('id="group-drawer"')).toBeGreaterThan(html.indexOf("</main>"));
	});

	it("drops the sticky rule that used to pin a card over the layout", () => {
		const css = readPublic("admin.css");
		// A sticky grid item is contained by the grid container rather than by its own row,
		// so a pinned card follows the scrollport past the rows below it. Nothing in the
		// admin may position a layout card or a panel outside the normal flow again.
		const cards = rulesMatching(css, /\.layout|\.panel(?!-)/);
		expect(cards.length).toBeGreaterThan(0);
		expect(cards.filter((rule) => /position:\s*(sticky|fixed|absolute)/.test(rule.body)).map((rule) => rule.selector)).toEqual([]);
		expect(css).not.toMatch(/position:\s*sticky/);
	});

	it("exposes one trigger next to the other admin actions", () => {
		const html = readPublic("admin.html");
		expect(html).toMatch(/<button type="button"[^>]*id="group-drawer-open"[^>]*>Gerenciar grupos<\/button>/);

		const linksPanel = html.slice(html.indexOf('<article class="panel links-panel">'), html.indexOf("</main>"));
		expect(linksPanel).toContain('id="group-drawer-open"');
		expect(linksPanel).toContain('id="export-button"');
		// Above the cards, so it does not depend on how many links are loaded.
		expect(linksPanel.slice(0, linksPanel.indexOf('<div class="cards"'))).toContain('id="group-drawer-open"');
	});

	it("starts closed, off-screen and unreachable", () => {
		const html = readPublic("admin.html");
		const css = readPublic("admin.css");
		const asideStart = html.indexOf("<aside");
		const openTag = html.slice(asideStart, html.indexOf(">", asideStart) + 1);

		expect(openTag).toContain('role="dialog"');
		expect(openTag).toContain('aria-modal="true"');
		expect(openTag).toContain('aria-labelledby="group-drawer-title"');
		expect(openTag).toContain('aria-hidden="true"');
		// `inert` is what makes the closed drawer non-focusable, not just invisible.
		expect(openTag).toContain("inert");

		const drawer = rulesMatching(css, /^\.group-drawer\s*$/)[0];
		expect(drawer.body).toMatch(/position:\s*fixed/);
		expect(drawer.body).toMatch(/visibility:\s*hidden/);
		expect(drawer.body).toMatch(/transform:\s*translateX\(100%\)/);
		expect(drawer.body).toMatch(/z-index:\s*60/);

		const open = rulesMatching(css, /^\.group-drawer\.is-open\s*$/)[0];
		expect(open.body).toMatch(/visibility:\s*visible/);
		expect(open.body).toMatch(/transform:\s*translateX\(0\)/);

		const backdrop = rulesMatching(css, /^\.group-drawer-backdrop\s*$/)[0];
		expect(backdrop.body).toMatch(/position:\s*fixed/);
		expect(backdrop.body).toMatch(/inset:\s*0/);
		expect(backdrop.body).toMatch(/visibility:\s*hidden/);
	});

	it("sizes the drawer for both desktop and mobile without a sidebar", () => {
		const css = readPublic("admin.css");
		const drawer = rulesMatching(css, /^\.group-drawer\s*$/)[0];

		// Desktop width cap, full width on a narrower viewport.
		expect(drawer.body).toMatch(/width:\s*min\(460px,\s*100%\)/);
		// Anchored to the right edge, never reserving application width.
		expect(drawer.body).toMatch(/right:\s*0/);
		expect(drawer.body).toMatch(/transition:\s*transform/);

		// Only the body scrolls, so the title and the close button stay reachable.
		expect(drawer.body).toMatch(/grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\)/);
		const body = rulesMatching(css, /^\.group-drawer-body\s*$/)[0];
		expect(body.body).toMatch(/overflow-y:\s*auto/);
		expect(body.body).toMatch(/min-height:\s*0/);
	});

	it("opens the drawer from the trigger and locks the body scroll", () => {
		const admin = readPublic("admin.js");

		expect(admin).toContain('groupDrawerOpenButton.addEventListener("click", () => {');
		expect(admin).toContain("openGroupDrawer();");

		const open = functionBody(admin, "openGroupDrawer");
		expect(open).toContain("state.groupDrawerOpen = true");
		// Every session starts on the tree, whatever tab the previous one ended on.
		expect(open).toContain('selectGroupTab("tree")');
		expect(open).toContain('groupDrawerOpenButton.setAttribute("aria-expanded", "true")');
		expect(open).toContain('groupDrawer.removeAttribute("inert")');
		expect(open).toContain('groupDrawer.setAttribute("aria-hidden", "false")');
		expect(open).toContain('groupDrawer.classList.add("is-open")');
		expect(open).toContain('groupDrawerBackdrop.classList.add("is-open")');
		expect(open).toContain("lockBodyScroll()");
		expect(open).toContain("groupDrawerCloseButton.focus()");

		// The lock is reversible and restores exactly what it replaced. No scroll listener.
		const lock = functionBody(admin, "lockBodyScroll");
		const unlock = functionBody(admin, "unlockBodyScroll");
		expect(lock).toContain('document.body.style.overflow = "hidden"');
		expect(unlock).toContain("document.body.style.overflow = bodyScrollLock.overflow");
		expect(unlock).toContain("document.body.style.paddingRight = bodyScrollLock.paddingRight");
		expect(unlock).toContain("bodyScrollLock = null");
		expect(admin).not.toMatch(/addEventListener\("scroll"/);
	});

	it("closes from the button and the backdrop and gives focus back", () => {
		const admin = readPublic("admin.js");

		expect(admin).toContain('groupDrawerCloseButton.addEventListener("click", () => {');
		expect(admin).toContain('groupDrawerBackdrop.addEventListener("click", () => {');

		const close = functionBody(admin, "closeGroupDrawer");
		expect(close).toContain("state.groupDrawerOpen = false");
		expect(close).toContain('groupDrawer.setAttribute("inert", "")');
		expect(close).toContain('groupDrawer.setAttribute("aria-hidden", "true")');
		expect(close).toContain('groupDrawerOpenButton.setAttribute("aria-expanded", "false")');
		expect(close).toContain("unlockBodyScroll()");
		// Focus returns to the trigger that opened the drawer.
		expect(close).toContain("groupDrawerOpenButton.focus()");
	});

	it("closes on Escape and keeps Tab inside while open", () => {
		const admin = readPublic("admin.js");

		const keydown = functionBody(admin, "onGroupDrawerKeydown");
		expect(keydown).toContain('event.key === "Escape"');
		expect(keydown).toContain("closeGroupDrawer()");
		expect(keydown).toContain("keepGroupDrawerFocus(event)");

		// The listener lives only while the drawer is open.
		expect(functionBody(admin, "openGroupDrawer")).toContain('document.addEventListener("keydown", onGroupDrawerKeydown)');
		expect(functionBody(admin, "closeGroupDrawer")).toContain('document.removeEventListener("keydown", onGroupDrawerKeydown)');

		const trap = functionBody(admin, "keepGroupDrawerFocus");
		expect(trap).toContain('event.key !== "Tab"');
		expect(trap).toContain("!groupDrawer.contains(active)");
		expect(trap).toContain("first.focus()");
		expect(trap).toContain("last.focus()");
		// Hidden controls are skipped instead of being focusable off-screen.
		expect(functionBody(admin, "groupDrawerFocusables")).toContain("!element.hidden");
	});

	it("labels the drawer, its trigger and its close control", () => {
		const html = readPublic("admin.html");
		const trigger = html.slice(html.indexOf('id="group-drawer-open"'), html.indexOf("</button>", html.indexOf('id="group-drawer-open"')));

		expect(trigger).toContain('aria-haspopup="dialog"');
		expect(trigger).toContain('aria-expanded="false"');
		expect(trigger).toContain('aria-controls="group-drawer"');

		// The close control is a real button with an accessible name of its own.
		expect(html).toMatch(/id="group-drawer-close" aria-label="Fechar painel de grupos"/);
		// The dialog is named by its visible heading.
		expect(html).toMatch(/<h2 id="group-drawer-title">Grupos<\/h2>/);
	});

	it("keeps the link filter out of the drawer", () => {
		const html = readPublic("admin.html");
		const drawerStart = html.indexOf("<aside");
		const main = html.slice(0, drawerStart);

		// Filtering links stays a responsibility of the links panel, not of management.
		expect(main).toContain('id="search-group-id"');
		expect(html.slice(drawerStart)).not.toContain('id="search-group-id"');
		expect(html).toMatch(/<label for="search-group-id">Filtrar por grupo<\/label>/);
	});
});

describe("Phase 5: groups drawer empty state", () => {
	it("starts empty and hides the controls with no group to act on", () => {
		const html = readPublic("admin.html");
		const drawer = html.slice(html.indexOf("<aside"));

		expect(drawer).toMatch(/class="group-drawer"/);
		expect(drawer).toMatch(/id="group-expand-all" hidden>/);
		expect(drawer).toMatch(/id="group-collapse-all" hidden>/);
		// Reloading stays available: it is the only useful toolbar action with no group.
		expect(drawer).toMatch(/id="group-refresh">/);
	});

	it("hides the empty-state controls for real instead of dimming them", () => {
		const css = readPublic("admin.css");
		// `hidden` alone is not enough: the toolbar buttons are `display: inline-flex` and the
		// tabs and panels are flex/grid, and those rules would win over the UA one.
		const hidden = rulesMatching(css, /^\.group-drawer\s+\[hidden\]\s*$/);
		expect(hidden.length).toBe(1);
		expect(hidden[0].body).toMatch(/display:\s*none/);
	});

	it("gives the tree and the actions back as soon as a group exists", () => {
		const admin = readPublic("admin.js");
		const sync = functionBody(admin, "syncGroupDrawerEmptyState");

		expect(sync).toContain("state.groupTree && state.groupTree.byId.size");
		expect(sync).toContain("groupExpandAllButton.hidden = !hasGroups");
		expect(sync).toContain("groupCollapseAllButton.hidden = !hasGroups");
		// An editor bound to a group that no longer exists must not survive the reload.
		expect(sync).toContain("closeGroupContext()");

		// Both rendering paths keep the drawer and its controls in agreement.
		expect(functionBody(admin, "renderGroupTree")).toContain("syncGroupDrawerEmptyState()");
		expect(functionBody(admin, "renderGroupTreeFailure")).toContain("syncGroupDrawerEmptyState()");
	});
});

describe("Phase 5: groups drawer copy and status", () => {
	it("describes the drawer by what it does for the user", () => {
		const html = readPublic("admin.html");
		const drawer = html.slice(html.indexOf("<aside"), html.indexOf('<div class="group-toolbar">'));

		expect(drawer).toMatch(/Organize seus links em grupos e subgrupos/);
		// Implementation vocabulary stays in the documentation, not in the interface.
		for (const technical of ["API", "ciclos", "concorrência", "valida", "16 níveis", "profundidade"]) {
			expect(drawer).not.toContain(technical);
		}
	});

	it("reserves no status line and never leaves a stale outcome behind", () => {
		const css = readPublic("admin.css");
		const html = readPublic("admin.html");
		const admin = readPublic("admin.js");

		expect(html).toMatch(/<div class="status" id="group-status" role="status"[^>]*><\/div>/);
		const emptyStatus = rulesMatching(css, /#group-status:empty/);
		expect(emptyStatus.length).toBe(1);
		expect(emptyStatus[0].body).toMatch(/min-height:\s*0/);

		// The reload note is explicit refresh feedback, never permanent content.
		expect(admin.split("Grupos recarregados.").length - 1).toBe(1);
		expect(admin).toMatch(/groupRefreshButton\.addEventListener\("click", async \(\) => \{\s*\n\s*await loadGroups\(\);\s*\n\s*setStatus\(groupStatus, "Grupos recarregados\."\);/);
		expect(functionBody(admin, "openGroupDrawer")).toContain('setStatus(groupStatus, "")');
	});

	it("builds both states without touching an HTML sink", () => {
		const admin = readPublic("admin.js");
		const ui = readPublic("group-hierarchy-ui.js");

		expect(functionBody(admin, "syncGroupDrawerEmptyState")).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
		// Group content still arrives through textContent only.
		expect(functionBody(admin, "buildGroupNode")).toContain("name.textContent = row.group.name");
		expect(functionBody(admin, "buildGroupNode")).toContain("path.textContent = row.path");
		expect(functionBody(admin, "renderGroupTree")).toContain('empty.textContent = "Nenhum grupo criado ainda."');
		expect(ui).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
	});
});

describe("Phase 5: groups drawer tabs", () => {
	it("splits the drawer into a tree view and a create view", () => {
		const html = readPublic("admin.html");
		const drawer = html.slice(html.indexOf("<aside"));

		expect(drawer).toMatch(/<div class="group-tabs" role="tablist" aria-label="Gerenciamento de grupos">/);
		expect(drawer).toMatch(/role="tab" class="group-tab" id="group-tab-tree" aria-controls="group-panel-tree" aria-selected="true">Grupos</);
		expect(drawer).toMatch(/role="tab" class="group-tab" id="group-tab-create" aria-controls="group-panel-create" aria-selected="false" tabindex="-1">Criar</);
		// No third global tab: moving is an action of a group, not a view of the drawer.
		expect(drawer).not.toMatch(/>Mover</);
	});

	it("marks the tree tab as the default view", () => {
		const html = readPublic("admin.html");
		const drawer = html.slice(html.indexOf("<aside"));

		expect(drawer).toMatch(/id="group-tab-tree"[^>]*aria-selected="true"/);
		expect(drawer).toMatch(/<section class="group-panel" role="tabpanel" id="group-panel-tree" aria-labelledby="group-tab-tree">/);
		expect(drawer).toMatch(/id="group-panel-create" aria-labelledby="group-tab-create" hidden>/);
	});

	it("mounts only the active panel", () => {
		const admin = readPublic("admin.js");
		const select = functionBody(admin, "selectGroupTab");

		expect(select).toContain("groupTreePanel.hidden = !isTree");
		expect(select).toContain("groupCreatePanel.hidden = isTree");
		expect(select).toContain('groupTabTreeButton.setAttribute("aria-selected", String(isTree))');
		expect(select).toContain('groupTabCreateButton.setAttribute("aria-selected", String(!isTree))');
		// Roving tabindex: the inactive tab is not a tab stop either.
		expect(select).toContain("groupTabTreeButton.tabIndex = isTree ? 0 : -1");
		expect(select).toContain("groupTabCreateButton.tabIndex = isTree ? -1 : 0");
		// Leaving the tree does not leave a half-open editor behind.
		expect(select).toContain("closeGroupContext()");
	});

	it("moves the selection with the arrow keys", () => {
		const admin = readPublic("admin.js");
		const keydown = functionBody(admin, "onGroupTabsKeydown");

		for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) {
			expect(keydown).toContain(`"${key}"`);
		}
		expect(keydown).toContain("event.preventDefault()");
		expect(keydown).toContain("selectGroupTab");
		expect(keydown).toContain("focus()");
		expect(admin).toContain('.addEventListener("keydown", onGroupTabsKeydown)');
	});

	it("returns to the tree after a group is created", () => {
		const admin = readPublic("admin.js");
		const create = functionBody(admin, "createGroupFromPanel");

		expect(create).toContain("const created = result.payload.group");
		expect(create).toContain('groupCreateNameInput.value = ""');
		expect(create).toContain('groupCreateParentSelect.value = ""');
		expect(create).toContain("await loadGroups()");
		expect(create).toContain('selectGroupTab("tree")');
		expect(create).toContain("showGroupNode(created.id)");
		// The tree, the main filter and the link form all follow from the same reload.
		expect(functionBody(admin, "loadGroups")).toContain("refreshGroupSelects()");
	});

	it("takes the empty state straight to creation", () => {
		const admin = readPublic("admin.js");
		const render = functionBody(admin, "renderGroupTree");

		expect(render).toContain('empty.textContent = "Nenhum grupo criado ainda."');
		expect(render).toContain('cta.dataset.groupAction = "create-first"');
		expect(render).toContain('cta.textContent = "Criar primeiro grupo"');
		// Built is not enough: the call to action has to reach the container.
		expect(render).toContain("groupTreeContainer.append(empty, cta)");
		expect(admin).toContain('button.dataset.groupAction === "create-first"');
		expect(admin).toMatch(/selectGroupTab\("create"\);\s*\n\s*groupCreateNameInput\.focus\(\);/);
	});
});

describe("Phase 5: contextual group actions", () => {
	it("has no global move form any more", () => {
		const html = readPublic("admin.html");

		expect(html).not.toContain("Grupo a mover");
		expect(html).not.toContain('id="group-move-source"');
		expect(html).not.toContain('id="group-move-target"');
		expect(html).not.toContain('id="group-move-button"');
		expect(html).not.toContain('id="group-move-path"');
		expect(readPublic("admin.js")).not.toContain("groupMoveSourceSelect");
	});

	it("offers move, rename and delete on the row itself", () => {
		const admin = readPublic("admin.js");
		const menu = functionBody(admin, "buildGroupNodeMenu");

		expect(menu).toContain('groupNodeButton("move", "Mover", "Mover grupo", row)');
		expect(menu).toContain('groupNodeButton("rename", "Renomear", "Renomear grupo", row)');
		expect(menu).toContain('groupNodeButton("delete", "Excluir", "Excluir grupo", row, "danger")');
		// A `…` menu, so a row never carries three full buttons.
		expect(menu).toContain('wrapper.className = "more-actions-dropdown group-node-menu"');
		expect(menu).toContain('summary.textContent = "⋯"');
		// Safe DOM: even the glyph is text, never markup.
		expect(menu).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
		// And the row actually renders it, so the menu is not just defined.
		expect(functionBody(admin, "buildGroupNode")).toContain("container.append(buildGroupNodeMenu(row))");
	});

	it("binds the editor to the group the row already picked", () => {
		const admin = readPublic("admin.js");
		const open = functionBody(admin, "openGroupContext");

		expect(open).toContain("state.groupContext = { mode, groupId }");
		expect(open).toContain("groupContextName.textContent = group.name");
		expect(open).toContain("groupContextPath.textContent = groupHierarchyUi.groupPath(tree.byId, groupId)");
		// The editor asks for the value only: which group is already known.
		expect(open).toContain("groupContextMoveField.hidden = !isMove");
		expect(open).toContain("groupContextRenameField.hidden = isMove");
		expect(open).toContain("groupContextNameInput.value = group.name");

		// The row menu is the only entry point, and it closes behind the action.
		expect(admin).toMatch(/if \(action === "move" \|\| action === "rename"\) \{\s*\n\s*openGroupContext\(action, groupId\);/);
		expect(admin).toContain('menu.removeAttribute("open")');
	});

	it("preselects the current parent so confirming is never a silent promotion", () => {
		const admin = readPublic("admin.js");
		const open = functionBody(admin, "openGroupContext");

		expect(open).toContain("groupHierarchyUi.parentOptions(tree, groupId)");
		expect(open).toContain('group.parentId === null ? "" : String(group.parentId)');
	});

	it("keeps an empty rename away from the API", () => {
		const admin = readPublic("admin.js");
		const confirm = functionBody(admin, "confirmGroupContext");

		expect(confirm).toContain('setStatus(groupStatus, "Informe o novo nome do grupo.", "error")');
		expect(confirm).toContain("if (!isMove && name === group.name)");
		// The group name is never written through an HTML sink.
		expect(confirm).toContain("groupContextNameInput.value.trim()");
	});
});

describe("Phase 5: compact group list", () => {
	it("keeps the hierarchy while making the rows dense", () => {
		const css = readPublic("admin.css");
		const admin = readPublic("admin.js");
		const render = functionBody(admin, "renderGroupTree");

		// The structural indent survives: nesting is still a <ul> inside its parent <li>.
		expect(render).toContain('const item = document.createElement("li")');
		expect(render).toContain('const childList = document.createElement("ul")');
		expect(css).toMatch(/\.group-tree li ul\s*\{/);

		// One dense line plus its context, aligned with its actions.
		const node = rulesMatching(css, /^\.group-node\s*$/)[0];
		expect(node.body).toMatch(/align-items:\s*center/);
		expect(Number(node.body.match(/padding:\s*(\d+)px/)?.[1])).toBeLessThanOrEqual(4);
		expect(node.body).not.toMatch(/flex-wrap:\s*wrap/);

		const name = rulesMatching(css, /^\.group-node-name\s*$/)[0];
		const path = rulesMatching(css, /^\.group-node-path\s*$/)[0];
		expect(Number(name.body.match(/font-size:\s*([\d.]+)rem/)?.[1])).toBeLessThanOrEqual(0.86);
		expect(Number(path.body.match(/font-size:\s*([\d.]+)rem/)?.[1])).toBeLessThanOrEqual(0.72);

		// The menu is the only action surface a row renders.
		expect(functionBody(admin, "buildGroupNode")).toContain("container.append(buildGroupNodeMenu(row))");
		expect(functionBody(admin, "buildGroupNode")).not.toContain("group-node-actions");
	});
});

describe("Phase 5: narrow viewport links-first", () => {
	it("starts the creation form collapsed where the list is the content", () => {
		const admin = readPublic("admin.js");

		expect(admin).toContain('const createFormMedia = window.matchMedia("(max-width: 900px)")');
		const collapse = functionBody(admin, "setCreateFormCollapsed");
		expect(collapse).toContain("state.createFormCollapsed = collapsed");
		expect(collapse).toContain("linkFormPanel.hidden = collapsed");
		expect(collapse).toContain('createLinkToggleButton.setAttribute("aria-expanded", String(!collapsed))');

		// One source of truth: the initial state and a rotation both follow the query.
		expect(admin).toContain("setCreateFormCollapsed(createFormMedia.matches)");
		expect(admin).toContain('createFormMedia.addEventListener("change", (event) => {');
		expect(admin).toContain("setCreateFormCollapsed(event.matches)");
		expect(admin).not.toMatch(/window\.innerWidth\s*[<>=]/);
	});

	it("keeps the desktop form open and its toggle out of the way", () => {
		const css = readPublic("admin.css");
		const toggle = rulesMatching(css, /^\.create-link-toggle\s*$/);

		// One rule hides it everywhere, one shows it again under the breakpoint only.
		expect(toggle.map((rule) => rule.body.match(/display:\s*([a-z-]+)/)?.[1]).sort()).toEqual(["inline-flex", "none"]);
		expect(css).toMatch(/@media \(max-width: 900px\)/);
	});

	it("puts the create action where the list starts", () => {
		const html = readPublic("admin.html");
		const linksPanel = html.slice(html.indexOf('<article class="panel links-panel">'), html.indexOf("</main>"));
		const actions = linksPanel.slice(0, linksPanel.indexOf('<div class="cards"'));

		expect(actions).toContain('id="create-link-toggle"');
		expect(actions).toContain('id="group-drawer-open"');
		expect(actions).toContain('id="export-button"');
		// The three actions precede search and filter, so nothing has to be crossed first.
		expect(actions.indexOf('id="create-link-toggle"')).toBeLessThan(actions.indexOf('id="search-form"'));
		expect(actions.indexOf('id="group-drawer-open"')).toBeLessThan(actions.indexOf('id="search-form"'));
	});

	it("folds the form back after saving or cancelling", () => {
		const admin = readPublic("admin.js");

		expect(functionBody(admin, "collapseCreateFormIfNarrow")).toContain("if (createFormMedia.matches)");
		// resetForm runs on cancel and after a successful save.
		expect(functionBody(admin, "resetForm")).toContain("collapseCreateFormIfNarrow()");
		// Editing a card reveals the form first, whatever the viewport default was.
		expect(functionBody(admin, "beginEdit")).toContain("setCreateFormCollapsed(false)");
	});

	it("documents the layout order instead of reordering the DOM", () => {
		const html = readPublic("admin.html");
		const createIndex = html.indexOf('<article class="panel link-form-panel"');
		const linksIndex = html.indexOf('<article class="panel links-panel">');

		// The creation card stays before the links panel on purpose: the collapsible form has
		// to appear next to the action that opens it. With the form hidden there is nothing
		// above the list, and the reading order matches the visual order on both viewports.
		expect(createIndex).toBeGreaterThan(-1);
		expect(createIndex).toBeLessThan(linksIndex);

		// No area template and no flex order on the layout: neither is what makes the mobile
		// order work, so neither may be introduced to fake it. (The footer keeps its own
		// `order: -1`, which is not part of the layout grid.)
		const css = readPublic("admin.css");
		expect(css).not.toContain("grid-template-areas");
		const layoutRules = rulesMatching(css, /\.layout|\.link-form-panel|\.links-panel/);
		expect(layoutRules.filter((rule) => /(^|[\s;])order:\s*-?\d/.test(rule.body)).map((rule) => rule.selector)).toEqual([]);
	});
});

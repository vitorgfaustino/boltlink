/* Copyright (c) 2026 Vitor Faustino — AGPL-3.0 */
// @vitest-environment node
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

class Node {
  textContent = ""; className = ""; type = ""; value = ""; hidden = false; disabled = false; open = false;
  children: Node[] = []; attributes: Record<string, string> = {}; handlers: Record<string, Function> = {};
  constructor(public tagName = "DIV") {}
  appendChild(node: Node) { this.children.push(node); return node; }
  replaceChildren() { this.children = []; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  addEventListener(name: string, fn: Function) { this.handlers[name] = fn; }
  focus() {} scrollIntoView() {}
  querySelectorAll(_selector: string): Node[] { return this.children.flatMap((child) => [child, ...child.querySelectorAll(_selector)]).filter((child) => ["BUTTON", "INPUT"].includes(child.tagName)); }
  async fire(name = "click") { if (!this.disabled) await this.handlers[name]?.({ preventDefault() {} }); for (let i = 0; i < 20; i++) await Promise.resolve(); }
}
function setup(request?: Function) {
  const ids = [...readFileSync("public/admin.html", "utf8").matchAll(/id="(trash-[^"]+)"/g)].map((match) => match[1]);
  const nodes = Object.fromEntries(ids.map((id) => [id, new Node(id.includes("search") && !id.includes("form") ? "INPUT" : /previous|next|confirm|cancel|open/.test(id) ? "BUTTON" : "DIV")]));
  nodes["trash-panel"].children = Object.entries(nodes).filter(([key]) => key !== "trash-panel").map(([, value]) => value);
  const confirm = vi.fn(() => false);
  const onChange = vi.fn(async () => {});
  const apiRequest = vi.fn(request || (async (path: string) => path.includes("purge-preview")
    ? { total: 1, eligible: 1, cutoff: "2026-07-03T00:00:00.000Z", retentionDays: 90 }
    : path.startsWith("/api/trash?") ? { total: 1, links: [{ slug: "example", target_url: "https://example.com/", disabled_at: "2026-01-01T00:00:00.000Z", group_name: "Campaign" }], hasMore: false }
    : { ok: true, removed: 1 }));
  const sandbox = { window: { confirm, BoltLinkTrash: undefined as any }, document: { getElementById: (id: string) => nodes[id], createElement: (tag: string) => new Node(tag.toUpperCase()) } };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync("public/trash-ui.js", "utf8"), sandbox);
  const controller = sandbox.window.BoltLinkTrash.mount({ request: apiRequest, onChange });
  return { nodes, confirm, apiRequest, controller, onChange };
}
async function open(ui: ReturnType<typeof setup>) {
  await ui.controller.open();
}
function action(ui: ReturnType<typeof setup>, index: number) { return ui.nodes["trash-list"].children[0].children[3].children[index]; }

describe("Phase 8: trash admin behavior", () => {
  it("cancels permanent delete without sending a mutation, then explicitly confirms it", async () => {
    const ui = setup(); await open(ui);
    await action(ui, 1).fire();
    expect(ui.confirm).toHaveBeenCalledWith(expect.stringMatching(/Excluir definitivamente \/example\?.*\n.*não pode ser desfeita.*slug ficará disponível/));
    expect(ui.apiRequest.mock.calls.some(([, options]) => options?.method === "DELETE")).toBe(false);
    ui.confirm.mockReturnValue(true);
    await action(ui, 1).fire();
    expect(ui.apiRequest).toHaveBeenCalledWith("/api/trash/example", { method: "DELETE" });
    expect(ui.onChange).toHaveBeenCalled();
  });
  it("restores through the administrative endpoint and reports preservation", async () => {
    const ui = setup(); await open(ui);
    await action(ui, 0).fire();
    expect(ui.apiRequest).toHaveBeenCalledWith("/api/trash/example/restore", { method: "POST" });
    expect(ui.nodes["trash-status"].textContent).toMatch(/configuração e as métricas foram preservadas/);
  });
  it("requires a successful preview before purge and discards cancelled previews", async () => {
    const ui = setup(); await open(ui);
    await ui.nodes["trash-purge-confirm"].fire();
    expect(ui.apiRequest.mock.calls.some(([path]) => path === "/api/trash/purge")).toBe(false);
    await ui.nodes["trash-purge-open"].fire();
    expect(ui.nodes["trash-purge-copy"].textContent).toMatch(/1 link será excluído definitivamente.*slug.*recalculada/);
    await ui.nodes["trash-purge-cancel"].fire();
    await ui.nodes["trash-purge-confirm"].fire();
    expect(ui.apiRequest.mock.calls.some(([path]) => path === "/api/trash/purge")).toBe(false);
    await ui.nodes["trash-purge-open"].fire();
    await ui.nodes["trash-purge-confirm"].fire();
    expect(ui.apiRequest).toHaveBeenCalledWith("/api/trash/purge", { method: "POST" });
    expect(ui.nodes["trash-status"].textContent).toMatch(/1 link excluído definitivamente/);
  });
  it("handles refused restore and network purge failure, unlocking controls and requiring another preview", async () => {
    const ui = setup(async (path: string, options?: { method: string }) => {
      if (options) throw new Error("Operação recusada");
      return path.includes("purge-preview") ? { total: 1, eligible: 1, cutoff: "cutoff", retentionDays: 90 }
        : { total: 1, links: [{ slug: "invalid", target_url: "https://invalid/", disabled_at: "date" }], hasMore: false };
    });
    await open(ui); await action(ui, 0).fire();
    expect(ui.nodes["trash-status"].textContent).toBe("Operação recusada");
    expect(ui.onChange).not.toHaveBeenCalled();
    await ui.nodes["trash-purge-open"].fire(); await ui.nodes["trash-purge-confirm"].fire();
    expect(ui.nodes["trash-purge-preview"].hidden).toBe(true);
    expect(ui.nodes["trash-purge-confirm"].disabled).toBe(true);
    expect(ui.nodes["trash-search"].disabled).toBe(false);
  });
  it("renders untrusted rows as text and encodes slug in mutation URLs", async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const ui = setup(async (path: string) => path.includes("purge-preview") ? { total: 1, eligible: 0, retentionDays: 90 }
      : { total: 1, links: [{ slug: hostile, target_url: hostile, disabled_at: hostile, group_name: hostile }], hasMore: false });
    await open(ui);
    expect(ui.nodes["trash-list"].children[0].children[1].textContent).toBe(hostile);
    await action(ui, 0).fire();
    expect(ui.apiRequest).toHaveBeenCalledWith("/api/trash/" + encodeURIComponent(hostile) + "/restore", { method: "POST" });
    expect(readFileSync("public/trash-ui.js", "utf8")).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  });
  it("drops an older listing response after a newer refresh", async () => {
    let resolveOld!: Function; let listingCalls = 0;
    const ui = setup(async (path: string) => {
      if (path.includes("purge-preview")) return { total: 0, eligible: 0, retentionDays: 90 };
      if (++listingCalls === 1) return new Promise((resolve) => { resolveOld = resolve; });
      return { total: 0, links: [], hasMore: false };
    });
    const old = ui.controller.open();
    await ui.controller.refresh();
    resolveOld({ total: 1, links: [{ slug: "stale", target_url: "https://example.com/", disabled_at: "date" }], hasMore: true });
    await old;
    expect(ui.nodes["trash-list"].children[0].textContent).toMatch(/Lixeira está vazia/);
    expect(ui.nodes["trash-next"].disabled).toBe(true);
  });
  it("uses accessible status, labels and existing styles, loading the controller before admin", () => {
    const html = readFileSync("public/admin.html", "utf8");
    expect(html).toContain('id="trash-status" class="status" role="status" aria-live="polite"');
    expect(html).toContain('label for="trash-search"');
    expect(html.indexOf('src="/trash-ui.js"')).toBeLessThan(html.indexOf('src="/admin.js"'));
    expect(readFileSync("public/admin.js", "utf8")).toContain('portabilityUi.exportErrorMessage(response.status, apiMessage, apiCode)');
  });
});

function bodyOf(name: string) {
  const source = readFileSync("public/admin.js", "utf8");
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf("\nfunction ", start + 1);
  if (start < 0) throw new Error(`Missing ${name}`);
  return source.slice(start, end < 0 ? source.length : end);
}

/** Execute the actual modal lifecycle with a small DOM double, not a second implementation. */
function modalSetup() {
  const listeners = new Map<string, Function>();
  const main = { inert: false };
  const doc: any = {
    activeElement: null,
    documentElement: { clientWidth: 1000 },
    body: { style: { overflow: "auto", paddingRight: "3px" } },
    querySelector: () => main,
    addEventListener: (key: string, fn: Function) => listeners.set(key, fn),
    removeEventListener: (key: string) => listeners.delete(key),
  };
  function element() {
    const attributes = new Map<string, string>();
    const classes = new Set<string>();
    const node: any = {
      hidden: false, disabled: false, tabIndex: 0, children: [], ancestorHidden: false,
      style: { display: "block", visibility: "visible" },
      setAttribute: (key: string, value: string) => attributes.set(key, value),
      removeAttribute: (key: string) => attributes.delete(key),
      getAttribute: (key: string) => attributes.get(key),
      classList: { add: (key: string) => classes.add(key), remove: (key: string) => classes.delete(key), contains: (key: string) => classes.has(key) },
      focus: () => { doc.activeElement = node; },
      contains: (candidate: any) => candidate === node || node.children.includes(candidate),
      querySelectorAll: (selector: string) => node.children.filter((child: any) => !child.disabled && (!child.isSummary || selector.includes("summary"))),
      closest: () => node.ancestorHidden ? {} : null,
      getClientRects: () => node.style.display === "none" ? [] : [{}],
    };
    return node;
  }
  const sandbox: any = { document: doc, window: { innerWidth: 1016 }, getComputedStyle: (node: any) => node.style,
    state: { groupDrawerOpen: false, importDrawerOpen: false, trashDrawerOpen: false },
    selectGroupTab: vi.fn(), setStatus: vi.fn(), resetImportDrawer: vi.fn(), closeQrDialog: vi.fn(),
    groupStatus: {}, exportStatus: {}, trashController: { open: vi.fn(), close: vi.fn() },
  };
  const drawers = ["group", "import", "trash"].map((kind) => {
    const drawer = element(), opener = element(), close = element(), last = element(), hidden = element();
    hidden.ancestorHidden = true;
    if (kind === "group") last.isSummary = true;
    drawer.children = [close, hidden, last];
    sandbox[`${kind}Drawer`] = drawer;
    sandbox[`${kind}DrawerOpenButton`] = opener;
    sandbox[`${kind}DrawerCloseButton`] = close;
    sandbox[`${kind}DrawerBackdrop`] = element();
    return { kind, drawer, opener, close, last, hidden };
  });
  const names = ["lockBodyScroll", "unlockBodyScroll", "drawerFocusables", "keepDrawerFocus",
    "groupDrawerFocusables", "keepGroupDrawerFocus", "onGroupDrawerKeydown", "openGroupDrawer", "closeGroupDrawer",
    "importDrawerFocusables", "keepImportDrawerFocus", "onImportDrawerKeydown", "openImportDrawer", "closeImportDrawer",
    "onTrashDrawerKeydown", "openTrashDrawer", "closeTrashDrawer"];
  vm.createContext(sandbox);
  vm.runInContext("let bodyScrollLock = null;\n" + names.map(bodyOf).join("\n"), sandbox);
  const event = (key: string, shiftKey = false) => ({ key, shiftKey, preventDefault: vi.fn() });
  return { sandbox, drawers, listeners, doc, main, event };
}

describe("Phase 8 Gate 8.6: offcanvas navigation", () => {
  for (const kind of ["group", "import", "trash"]) {
    const title = kind[0].toUpperCase() + kind.slice(1);
    it(`${kind}: locks the background, sets aria, wraps Tab both ways, and returns focus on Escape`, () => {
      const ui = modalSetup();
      const row = ui.drawers.find((item) => item.kind === kind)!;
      row.opener.focus();
      ui.sandbox[`open${title}Drawer`]();
      expect(ui.main.inert).toBe(true);
      expect(ui.doc.body.style.overflow).toBe("hidden");
      expect(row.drawer.getAttribute("aria-hidden")).toBe("false");
      expect(row.opener.getAttribute("aria-expanded")).toBe("true");
      expect(ui.doc.activeElement).toBe(row.close);
      const backwards = ui.event("Tab", true);
      ui.listeners.get("keydown")!(backwards);
      expect(backwards.preventDefault).toHaveBeenCalled();
      expect(ui.doc.activeElement).toBe(row.last);
      ui.listeners.get("keydown")!(ui.event("Tab"));
      expect(ui.doc.activeElement).toBe(row.close);
      ui.listeners.get("keydown")!(ui.event("Escape"));
      expect(ui.main.inert).toBe(false);
      expect(ui.doc.body.style).toEqual({ overflow: "auto", paddingRight: "3px" });
      expect(row.drawer.getAttribute("aria-hidden")).toBe("true");
      expect(row.drawer.getAttribute("inert")).toBe("");
      expect(row.opener.getAttribute("aria-expanded")).toBe("false");
      expect(ui.doc.activeElement).toBe(row.opener);
      expect(ui.listeners.size).toBe(0);
    });
  }
  it("switches all pairs without leaving another drawer active or losing the original scroll styles", () => {
    for (const first of ["Group", "Import", "Trash"]) for (const second of ["Group", "Import", "Trash"]) {
      if (first === second) continue;
      const ui = modalSetup();
      ui.sandbox[`open${first}Drawer`]();
      ui.sandbox[`open${second}Drawer`]();
      expect(ui.drawers.filter((row) => row.drawer.classList.contains("is-open")).map((row) => row.kind)).toEqual([second.toLowerCase()]);
      expect(ui.main.inert).toBe(true);
      expect(ui.doc.body.style.overflow).toBe("hidden");
      ui.sandbox[`close${second}Drawer`]();
      expect(ui.doc.body.style).toEqual({ overflow: "auto", paddingRight: "3px" });
    }
  });
  it("excludes hidden ancestors, negative tab order and disabled controls from modal focus", () => {
    const ui = modalSetup();
    const row = ui.drawers[0];
    row.last.parentElement = { tagName: "DETAILS", open: false, querySelector: () => ({}) };
    expect(ui.sandbox.drawerFocusables(row.drawer)).toEqual([row.close]);
    row.last.parentElement.open = true;
    expect(ui.sandbox.drawerFocusables(row.drawer)).toEqual([row.close, row.last]);
    row.last.disabled = true;
    expect(ui.sandbox.drawerFocusables(row.drawer)).toEqual([row.close]);
    row.close.tabIndex = -1;
    expect(ui.sandbox.drawerFocusables(row.drawer)).toEqual([]);
    row.close.tabIndex = 0;
    ui.doc.activeElement = row.opener;
    const key = ui.event("Tab");
    ui.sandbox.keepDrawerFocus(key, row.drawer);
    expect(ui.doc.activeElement).toBe(row.close);
    expect(key.preventDefault).toHaveBeenCalled();
  });
  it("has only three tools in the page and keeps trash and export out of the primary flow", () => {
    const html = readFileSync("public/admin.html", "utf8");
    const main = html.slice(html.indexOf("<main>"), html.indexOf("</main>"));
    expect(main).not.toContain('id="trash-panel"');
    expect(main).not.toContain('id="trash-drawer"');
    expect(main).not.toContain('id="export-button"');
    expect(main).not.toContain('id="export-status"');
    const portability = html.slice(html.indexOf('class="import-drawer"'), html.indexOf('id="import-status"'));
    expect(portability).toContain('id="export-button"');
    expect(portability).toContain('id="export-status"');
    expect(portability).toContain('id="import-file"');
    expect(portability).toContain('id="import-apply-button"');
    expect(portability.indexOf('id="export-button"')).toBeLessThan(portability.indexOf('id="import-file"'));
    for (const prefix of ["group", "import", "trash"]) {
      const id = `${prefix}-drawer`;
      const aside = html.match(new RegExp(`<aside[^>]*id="${id}"[^>]*>`))![0];
      expect(aside).toContain('role="dialog"');
      expect(aside).toContain('aria-modal="true"');
      expect(aside).toContain(`aria-labelledby="${id}-title"`);
      expect(aside).toContain('aria-hidden="true"');
      expect(aside).toContain("inert");
    }
    const js = readFileSync("public/admin.js", "utf8");
    expect(js).toContain('trashDrawerBackdrop.addEventListener("click", closeTrashDrawer)');
    expect(js).toContain('trashDrawerCloseButton.addEventListener("click", closeTrashDrawer)');
    expect(js).toContain('event.defaultPrevented || state.groupDrawerOpen || state.importDrawerOpen || state.trashDrawerOpen || state.qrDialogOpen');
  });
  it("keeps the filter explanation across both columns so it cannot shrink the select", () => {
    const css = readFileSync("public/admin.css", "utf8");
    expect(css).toMatch(/\.slug\s*\{[^}]*overflow-wrap: anywhere/);
    expect(css).toMatch(/\.search-filter-row > \.field-help\s*\{[^}]*grid-column: 1 \/ -1/);
  });
  it("folds only the form, preserves the heading, and defaults from viewport rather than saved state", () => {
    const toggle = { setAttribute: vi.fn(), focus: vi.fn() };
    const form = { hidden: false, contains: () => true };
    const sandbox: any = { state: {}, linkForm: form, createLinkToggleButton: toggle, document: { activeElement: {} } };
    vm.createContext(sandbox);
    vm.runInContext(bodyOf("setCreateFormCollapsed"), sandbox);
    sandbox.setCreateFormCollapsed(true);
    expect(form.hidden).toBe(true);
    expect(toggle.setAttribute).toHaveBeenLastCalledWith("aria-expanded", "false");
    expect(toggle.focus).toHaveBeenCalled();
    sandbox.setCreateFormCollapsed(false);
    expect(form.hidden).toBe(false);
    expect(toggle.setAttribute).toHaveBeenLastCalledWith("aria-expanded", "true");
    const js = readFileSync("public/admin.js", "utf8");
    expect(js).toContain("setCreateFormCollapsed(createFormMedia.matches)");
    expect(js).not.toMatch(/localStorage|sessionStorage/);
    const html = readFileSync("public/admin.html", "utf8");
    expect(html).toContain('id="create-link-toggle" aria-expanded="false" aria-controls="link-form"');
    for (const title of ["Gerador de UTMs", "Opções avançadas", "Teste A/B", "Smart Routing"]) expect(html).toContain(`<summary>${title}</summary>`);
  });
  it("searches and paginates within trash with encoded input, reporting empty matches", async () => {
    const ui = setup(async (path: string) => path.includes("purge-preview") ? { total: 200, eligible: 1, retentionDays: 90 }
      : { total: 200, links: [], hasMore: true });
    await open(ui);
    ui.nodes["trash-search"].value = "<x>&tag";
    await ui.nodes["trash-search-form"].fire("submit");
    expect(ui.apiRequest).toHaveBeenCalledWith("/api/trash?search=%3Cx%3E%26tag&page=1");
    expect(ui.nodes["trash-list"].children[0].textContent).toMatch(/corresponde à busca/);
    await ui.nodes["trash-next"].fire();
    expect(ui.apiRequest).toHaveBeenCalledWith("/api/trash?search=%3Cx%3E%26tag&page=2");
    await ui.nodes["trash-previous"].fire();
    expect(ui.nodes["trash-page"].textContent).toBe("Página 1");
  });
  it("discards a purge preview on close, including a response arriving after reopen", async () => {
    let finish!: Function;
    let summaries = 0;
    const ui = setup(async (path: string) => {
      if (path.includes("purge-preview")) {
        if (++summaries === 3) return new Promise((resolve) => { finish = resolve; });
        return { total: 1, eligible: 1, retentionDays: 90 };
      }
      return { total: 1, links: [], hasMore: false };
    });
    await open(ui);
    const pending = ui.nodes["trash-purge-open"].fire();
    ui.controller.close();
    await ui.controller.open();
    finish({ total: 1, eligible: 1, retentionDays: 90 });
    await pending;
    expect(ui.nodes["trash-purge-preview"].hidden).toBe(true);
    expect(ui.nodes["trash-purge-confirm"].disabled).toBe(true);
    await ui.nodes["trash-purge-confirm"].fire();
    expect(ui.apiRequest.mock.calls.some(([path]) => path === "/api/trash/purge")).toBe(false);
  });
});

it("Gate 8.6: reopening a busy trash drawer cannot unlock a pending mutation", async () => {
  let finish!: Function;
  const ui = setup(async (path: string, options?: { method: string }) => {
    if (options?.method === "POST") return new Promise((resolve) => { finish = resolve; });
    return path.includes("purge-preview") ? { total: 1, eligible: 1, retentionDays: 90 }
      : { total: 1, links: [{ slug: "example", target_url: "https://example.com/", disabled_at: "date" }], hasMore: false };
  });
  await open(ui);
  const pending = action(ui, 0).fire();
  ui.controller.close();
  await ui.controller.open();
  expect(ui.nodes["trash-search"].disabled).toBe(true);
  expect(action(ui, 0).disabled).toBe(true);
  finish({ ok: true });
  await pending;
  expect(ui.nodes["trash-search"].disabled).toBe(false);
});

it("Gate 8.6: export downloads the exact API document with the safe name and reports status in its drawer", async () => {
  const apiBody = '{"format":"boltlink-portability","schemaVersion":1,"links":[]}';
  const anchor = { href: "", download: "", click: vi.fn() };
  const createObjectURL = vi.fn(() => "blob:test-export");
  const revokeObjectURL = vi.fn();
  const exportStatus = {};
  const sandbox: any = { window: {}, Blob, URL: { createObjectURL, revokeObjectURL },
    exportStatus, exportButton: {}, setStatus: vi.fn(), setBusy: vi.fn(),
    document: { createElement: () => anchor },
    fetch: vi.fn(async () => ({ ok: true, text: async () => apiBody, headers: { get: () => 'attachment; filename="boltlink-export.json"' } })),
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync("public/portability-ui.js", "utf8"), sandbox);
  sandbox.portabilityUi = sandbox.window.BoltLinkPortability;
  vm.runInContext("async " + bodyOf("exportConfiguration"), sandbox);
  await sandbox.exportConfiguration();
  expect(sandbox.fetch).toHaveBeenCalledWith("/api/export", expect.objectContaining({ method: "GET", credentials: "same-origin" }));
  expect(await createObjectURL.mock.calls[0][0].text()).toBe(apiBody);
  expect(anchor.download).toBe("boltlink-export.json");
  expect(anchor.click).toHaveBeenCalledOnce();
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:test-export");
  expect(sandbox.setStatus).toHaveBeenLastCalledWith(exportStatus, "Exportação concluída: boltlink-export.json", "success");
  expect(sandbox.setBusy).toHaveBeenLastCalledWith(sandbox.exportButton, false);
});

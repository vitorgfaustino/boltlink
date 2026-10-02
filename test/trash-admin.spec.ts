/* Copyright (c) 2026 Vitor Faustino — AGPL-3.0 */
// @vitest-environment node
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

/** The presentation code runs unchanged against measured element dimensions. */
function contentSetup() {
  const controls: any[] = [];
  const texts = new Map<string, any>();
  const listeners: Function[] = [];
  const frames: Function[] = [];
  const resize = new Map<string, Function>();
  const shortCopy = { focus: vi.fn() };
  const list: any = { innerHTML: "", querySelectorAll: () => controls, addEventListener: (_name: string, fn: Function) => listeners.push(fn) };
  const doc: any = { activeElement: null, getElementById: (id: string) => texts.get(id) };
  const sandbox: any = { document: doc, linksList: list, window: { addEventListener: (name: string, fn: Function) => resize.set(name, fn),
    requestAnimationFrame: (fn: Function) => { frames.push(fn); return frames.length; } },
    copyToClipboard: vi.fn(async () => {}), copyStatus: { textContent: "" }, copyFeedbackStates: new WeakMap(),
    setTimeout, clearTimeout, setStatus: vi.fn(), listStatus: {}, linksCount: {}, ICONS: { more: "", check: '<svg data-icon="check"></svg>', cancel: '<svg data-icon="cancel"></svg>' },
    buildShortLink: (slug: string) => `https://links.example.com/${slug}`,
    state: { links: [], pendingDeletes: new Map() }, cardActionMarkup: () => "", formatDate: () => "01/10/2026 09:00",
    renderAbMetrics: () => "", renderSmartBadge: () => "" };
  vm.createContext(sandbox);
  const actual = readFileSync("public/admin.js", "utf8");
  const functions = ["escapeHtml", "buttonMarkup", "linkContentMarkup", "refreshLinkContent", "toggleLinkContent", "scheduleLinkContentMeasure", "restoreCopyFeedback", "copyWithFeedback", "renderLinks"]
    .map((name) => actual.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`))![0]).join("\n");
  vm.runInContext("let contentMeasureFrame = null;\n" + functions, sandbox);
  const source = readFileSync("public/admin.js", "utf8");
  const start = source.indexOf('window.addEventListener("resize", scheduleLinkContentMeasure)');
  const first = source.indexOf('linksList.addEventListener("click", async (event) => {', start);
  const second = source.indexOf('linksList.addEventListener("click", async (event) => {', first + 1);
  vm.runInContext(source.slice(start, source.indexOf("\nfunction escapeHtml", second)), sandbox);
  function add(width: number, scrollWidth: number, height = 20, scrollHeight = height) {
    const id = `content-${controls.length}`;
    const classes = new Set<string>();
    const text: any = { clientWidth: width, scrollWidth, clientHeight: height, scrollHeight, textContent: "full original content",
      classList: { remove: (key: string) => classes.delete(key), contains: (key: string) => classes.has(key),
        toggle: (key: string, force: boolean) => force ? classes.add(key) : classes.delete(key) } };
    const attributes: Record<string, string> = { "aria-controls": id, "aria-expanded": "false" };
    let hidden = true;
    const button: any = { get hidden() { return hidden; }, set hidden(value: boolean) { hidden = value; if (value && doc.activeElement === button) doc.activeElement = null; },
      textContent: "Ver mais", dataset: { contentLabel: "URL de destino" },
      getAttribute: (key: string) => attributes[key], setAttribute: (key: string, value: string) => { attributes[key] = value; },
      classList: { contains: (key: string) => key === "content-toggle" }, closest: () => ({ querySelector: () => shortCopy }) };
    texts.set(id, text); controls.push(button);
    return { text, button, attributes };
  }
  function addCopy(kind = "destination", value = "https://example.com/") {
    const attributes: Record<string, string> = { "aria-label": kind === "short" ? "Copiar" : `Copiar destino: ${kind}`, title: "Original" };
    const feedback: any = { innerHTML: "", get textContent() { return this.innerHTML.replace(/<[^>]+>/g, ""); }, set textContent(value: string) { this.innerHTML = value; } };
    const button: any = { isConnected: true, dataset: { copyValue: value, copyKind: kind },
      getAttribute: (key: string) => attributes[key] ?? null, setAttribute: (key: string, value: string) => { attributes[key] = value; },
      removeAttribute: (key: string) => { delete attributes[key]; }, querySelector: () => feedback,
      classList: { contains: () => false }, closest: () => null };
    return { button, feedback, attributes };
  }
  return { sandbox, doc, list, add, addCopy, controls, texts, listeners, frames, resize, shortCopy };
}

describe("Phase 8 Gate 8.6.1: measured long content", () => {
  it("does not infer truncation from character count: a short text can clip and a long text can fit", () => {
    const ui = contentSetup(); const clipped = ui.add(30, 80); const fits = ui.add(800, 800);
    clipped.text.textContent = "abc"; fits.text.textContent = "a".repeat(300);
    ui.sandbox.refreshLinkContent();
    expect(clipped.button.hidden).toBe(false); expect(fits.button.hidden).toBe(true);
  });
  it("hides Ver mais for a fully visible URL", () => {
    const ui = contentSetup(); const row = ui.add(200, 160);
    ui.sandbox.refreshLinkContent(); expect(row.button.hidden).toBe(true); expect(row.attributes["aria-expanded"]).toBe("false");
  });
  it("detects line-clamp overflow by height even when widths match", () => {
    const ui = contentSetup(); const row = ui.add(200, 200, 40, 120);
    ui.sandbox.refreshLinkContent(); expect(row.button.hidden).toBe(false);
  });
  it("ignores a one pixel measurement rounding difference", () => {
    const ui = contentSetup(); const row = ui.add(200, 201, 40, 41);
    ui.sandbox.refreshLinkContent(); expect(row.button.hidden).toBe(true);
  });
  it("expands and collapses with aria and the full original text intact", async () => {
    const ui = contentSetup(); const row = ui.add(200, 200, 40, 120);
    const original = row.text.textContent; ui.sandbox.refreshLinkContent();
    const event = { target: { closest: () => row.button } };
    await ui.listeners[0](event);
    expect(row.text.classList.contains("is-expanded")).toBe(true);
    expect(row.attributes["aria-expanded"]).toBe("true"); expect(row.button.textContent).toBe("Ver menos");
    expect(row.attributes["aria-label"]).toBe("Ver menos: URL de destino");
    await ui.listeners[0](event);
    expect(row.text.classList.contains("is-expanded")).toBe(false);
    expect(row.attributes["aria-expanded"]).toBe("false"); expect(row.button.textContent).toBe("Ver mais");
    expect(row.text.textContent).toBe(original);
  });
  it("preserves an expanded state when a resized collapsed layout still clips", () => {
    const ui = contentSetup(); const row = ui.add(200, 200, 40, 120);
    ui.sandbox.toggleLinkContent(row.button); ui.sandbox.refreshLinkContent();
    expect(row.attributes["aria-expanded"]).toBe("true"); expect(row.button.hidden).toBe(false);
  });
  it("removes an unnecessary expansion control when the new layout fits", () => {
    const ui = contentSetup(); const row = ui.add(200, 200, 40, 120);
    ui.sandbox.toggleLinkContent(row.button); row.text.scrollHeight = 40; ui.sandbox.refreshLinkContent();
    expect(row.button.hidden).toBe(true); expect(row.attributes["aria-expanded"]).toBe("false");
    row.text.scrollHeight = 120; ui.sandbox.refreshLinkContent();
    expect(row.button.hidden).toBe(false); expect(row.text.classList.contains("is-expanded")).toBe(false);
  });
  it("moves focus to the original Copy action if resize hides the focused expansion control", () => {
    const ui = contentSetup(); const row = ui.add(200, 160); ui.doc.activeElement = row.button;
    ui.sandbox.refreshLinkContent(); expect(ui.shortCopy.focus).toHaveBeenCalledOnce();
  });
  it("coalesces resize notifications into one frame and measures content after render", () => {
    const ui = contentSetup(); const row = ui.add(200, 250);
    ui.resize.get("resize")!(); ui.resize.get("resize")!();
    expect(ui.frames).toHaveLength(1); ui.frames.shift()!(); expect(row.button.hidden).toBe(false);
    ui.resize.get("resize")!(); expect(ui.frames).toHaveLength(1);
  });
  it("copies the complete original destination while it is collapsed", async () => {
    const ui = contentSetup(); const url = "https://example.com/" + "a".repeat(320) + "?utm_source=newsletter";
    const { button } = ui.addCopy("destination", url);
    await ui.listeners[0]({ target: { closest: () => button } });
    expect(ui.sandbox.copyToClipboard).toHaveBeenCalledWith(url);
    expect(ui.sandbox.copyStatus.textContent).toBe("URL de destino copiada");
  });
  it("reports clipboard failure without exposing the destination", async () => {
    const ui = contentSetup(); const url = "https://example.com/?x=" + "a".repeat(300);
    ui.sandbox.copyToClipboard.mockRejectedValue(new Error("clipboard denied"));
    const { button } = ui.addCopy("destination", url);
    await ui.listeners[0]({ target: { closest: () => button } });
    expect(ui.sandbox.copyStatus.textContent).toBe("Não foi possível copiar a URL de destino");
    expect(ui.sandbox.copyStatus.textContent).not.toContain(url);
  });
  it("escapes URL, slug and copy attributes without shortening their original content", () => {
    const ui = contentSetup(); const unsafe = 'https://example.com/?x="<img src=x onerror=alert(1)>&test=\'a\'';
    const markup = ui.sandbox.linkContentMarkup(unsafe, "URL de destino", "safe-id", false, unsafe);
    expect(markup).toContain("&lt;img"); expect(markup).toContain("&quot;"); expect(markup).not.toContain("<img");
    expect(markup).toContain('aria-controls="safe-id"'); expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toMatch(/class="(?:slug-url|slug) content-text"[^>]*aria-hidden/); expect(markup).not.toContain("title=");
    expect(ui.sandbox.linkContentMarkup("/" + "a".repeat(64), "slug", "slug-id", true)).toContain("/" + "a".repeat(64));
  });
  it("uses native keyboard buttons and labels destination and Variant B copying explicitly", () => {
    const ui = contentSetup(); const markup = ui.sandbox.linkContentMarkup("Variante B: https://example.com/b", "URL da variante B", "b", false, "https://example.com/b");
    expect(markup).toContain('<button type="button" class="content-toggle"');
    expect(markup).toContain('aria-label="Copiar destino: URL da variante B"');
    expect(markup).toContain('data-copy-value="https://example.com/b"');
  });
  it("renders adversarial persisted values without mutating records or using truncated data in actions", () => {
    const ui = contentSetup(); const original = { slug: "a".repeat(64), target_url: "https://example.com/" + "a".repeat(320), tags: JSON.stringify(["a".repeat(30)]), group_name: "a".repeat(120), ab_enabled: 1, ab_target_url: "https://example.com/b?x=" + "b".repeat(300), clicks_total: 12, redirect_type: "302" };
    ui.sandbox.state.links = [original]; const saved = JSON.stringify(original);
    ui.sandbox.renderLinks();
    expect(ui.list.innerHTML).toContain(original.target_url); expect(ui.list.innerHTML).toContain(original.ab_target_url);
    expect(ui.list.innerHTML).toContain('class="card"'); expect(ui.list.innerHTML).toContain('class="link-states"');
    expect(ui.list.innerHTML).toContain(original.group_name); expect(ui.frames).toHaveLength(1);
    expect(JSON.stringify(original)).toBe(saved);
  });
  it("copies the complete short link for a clamped 64-character slug through the original handler", async () => {
    const ui = contentSetup(); const slug = "a".repeat(64); ui.sandbox.state.links = [{ slug }];
    const { button } = ui.addCopy("short"); Object.assign(button.dataset, { slug, action: "copy" });
    await ui.listeners[1]({ target: { closest: () => button } });
    expect(ui.sandbox.copyToClipboard).toHaveBeenCalledWith(`https://links.example.com/${slug}`);
  });
  it("preserves the existing Copy action as the complete short link", () => {
    const admin = readFileSync("public/admin.js", "utf8");
    const start = admin.indexOf('if (action === "copy")');
    const copy = admin.slice(start, admin.indexOf('if (action === "delete")', start));
    expect(copy).toContain("buildShortLink(link.slug)"); expect(copy).toContain('copyWithFeedback(button, shortLink, "short")');
    expect(copy).not.toContain("target_url");
  });
  it("uses compact surfaces, unclipped menus and one desktop/two mobile text lines", () => {
    const css = readFileSync("public/admin.css", "utf8");
    expect(css).toMatch(/\.card\s*\{[^}]*padding: 16px;[^}]*border: 1px solid var\(--line\);[^}]*border-radius: var\(--radius-sm\);/);
    expect(css).toMatch(/\.cards\s*\{[^}]*gap: 12px;/);
    expect(css).toMatch(/\.content-text:not\(\.is-expanded\)\s*\{[^}]*-webkit-line-clamp: 1;[^}]*overflow: hidden;/);
    expect(css).toMatch(/@media \(max-width: 900px\)\s*\{\s*\.content-text:not\(\.is-expanded\) \{ -webkit-line-clamp: 2; \}/);
    expect(css).toMatch(/\.card\s*\{[^}]*overflow: visible;/);
    expect(css).not.toMatch(/\.metric[^{}]*::before\s*\{[^}]*content: "·"/);
  });
});

describe("Phase 8 Gate 8.6.2: mobile component consistency", () => {
  it("renders tags through the measured expander without changing data or injecting markup", () => {
    const ui = contentSetup();
    const tag = '<img src=x onerror="alert(1)">' + "a".repeat(40);
    const link = { slug: "tags", target_url: "https://example.com/", tags: JSON.stringify([tag, "b".repeat(40)]), group_name: 'Grupo "<script>"' };
    ui.sandbox.state.links = [link]; const original = JSON.stringify(link);
    ui.sandbox.renderLinks();
    expect(ui.list.innerHTML).toContain('id="link-content-0-tags"');
    expect(ui.list.innerHTML).toContain('aria-controls="link-content-0-tags"');
    expect(ui.list.innerHTML).toContain('data-content-label="tags"');
    expect(ui.list.innerHTML).toContain("&lt;img"); expect(ui.list.innerHTML).not.toContain("<img");
    expect(ui.list.innerHTML).toContain('aria-label="Grupo: Grupo &quot;&lt;script&gt;&quot;"');
    expect(ui.list.innerHTML).not.toContain("<script>");
    expect(JSON.stringify(link)).toBe(original); expect(ui.frames).toHaveLength(1);
  });
  it("omits the tags region entirely when there are no tags", () => {
    const ui = contentSetup(); ui.sandbox.state.links = [{ slug: "simple", target_url: "https://example.com/", tags: "[]" }];
    ui.sandbox.renderLinks(); expect(ui.list.innerHTML).not.toContain('class="link-tags"');
  });
  it("hides expansion for ten short tags when they actually fit", () => {
    const ui = contentSetup(); const row = ui.add(600, 500);
    row.button.dataset.contentLabel = "tags"; row.text.textContent = "Tags: " + Array.from({ length: 10 }, (_, i) => `tag${i}`).join(", ");
    ui.sandbox.refreshLinkContent(); expect(row.button.hidden).toBe(true);
    expect(row.attributes["aria-label"]).toBe("Ver mais: tags");
  });
  it("expands and collapses clipped tags through the native button handler, preserving every tag", async () => {
    const ui = contentSetup(); const row = ui.add(230, 230, 34, 100);
    row.button.dataset.contentLabel = "tags"; row.text.textContent = "Tags: " + "a".repeat(40) + ", " + "b".repeat(40);
    const original = row.text.textContent; ui.sandbox.refreshLinkContent(); expect(row.button.hidden).toBe(false);
    await ui.listeners[0]({ target: { closest: () => row.button } });
    expect(row.attributes["aria-expanded"]).toBe("true"); expect(row.attributes["aria-label"]).toBe("Ver menos: tags");
    expect(row.text.classList.contains("is-expanded")).toBe(true);
    await ui.listeners[0]({ target: { closest: () => row.button } });
    expect(row.attributes["aria-expanded"]).toBe("false"); expect(row.attributes["aria-label"]).toBe("Ver mais: tags");
    expect(row.text.textContent).toBe(original);
  });
  it("returns focus to short-link Copy when resize makes a focused tags expander unnecessary", () => {
    const ui = contentSetup(); const row = ui.add(230, 230, 34, 100); row.button.dataset.contentLabel = "tags";
    ui.sandbox.refreshLinkContent(); ui.sandbox.toggleLinkContent(row.button); ui.doc.activeElement = row.button;
    row.text.scrollHeight = 34; ui.sandbox.refreshLinkContent();
    expect(row.button.hidden).toBe(true); expect(row.attributes["aria-expanded"]).toBe("false");
    expect(ui.shortCopy.focus).toHaveBeenCalledOnce();
  });
  it("places the Variant B label above its own complete URL and copy action", () => {
    const ui = contentSetup(); const variant = "https://example.com/b?x=" + "b".repeat(310);
    ui.sandbox.state.links = [{ slug: "ab", target_url: "https://example.com/a", ab_enabled: 1, ab_target_url: variant }];
    ui.sandbox.renderLinks(); const markup = ui.list.innerHTML;
    expect(markup).toContain('<div class="variant-content"><span class="content-label">Variante B</span>');
    expect(markup).toContain(`id="link-content-0-variant">${variant}</div>`);
    expect(markup).toContain(`data-copy-value="${variant}" data-copy-kind="variant" aria-label="Copiar destino: URL da variante B"`);
    expect(markup).toContain('data-copy-value="https://example.com/a" data-copy-kind="destination" aria-label="Copiar destino: URL de destino"');
  });
  it("uses a restrained group badge with breathing room instead of a capsule", () => {
    const css = readFileSync("public/admin.css", "utf8");
    const badge = css.match(/\.group-badge\s*\{[^}]*\}/)![0];
    expect(badge).toContain("border-radius: 6px;"); expect(badge).toContain("padding: 4px 8px;");
    expect(badge).toContain("max-width: 100%;"); expect(badge).toContain("overflow-wrap: anywhere;");
    expect(badge).not.toContain("999px");
  });
  it("limits compact create and equal-width actions to mobile while retaining a 44px touch target", () => {
    const css = readFileSync("public/admin.css", "utf8"); const mobile = css.slice(css.lastIndexOf("@media (max-width: 900px)"));
    expect(mobile).toContain('.link-form-panel:has(.create-link-toggle[aria-expanded="false"]) { padding: 8px 16px; }');
    expect(mobile).toContain('.create-mobile-heading::after { display: none; }');
    expect(mobile).toMatch(/\.card-actions \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);[^}]*width: 100%;/);
    expect(mobile).toContain(".primary-actions { display: contents; }");
    expect(mobile).toMatch(/\.card-actions \.more-actions-dropdown summary \{ width: 100%; min-width: 0; min-height: 44px; \}/);
    expect(css).toContain('.link-form-panel:has(.create-link-toggle[aria-expanded="false"]) #link-form { display: none; }');
  });
  it("keeps metadata facts as separate wrapping items without orphan punctuation", () => {
    const ui = contentSetup(); ui.sandbox.state.links = [{ slug: "schedule", target_url: "https://example.com/", clicks_total: 6,
      redirect_type: "302", created_at: "2026-10-01", go_live_at: "2026-10-01", expires_at: "2027-10-01" }];
    ui.sandbox.renderLinks();
    for (const label of ["Cliques", "Criado:", "Redirecionamento", "Expira", "Ativa"]) expect(ui.list.innerHTML).toContain(`<span class="metric">${label}`);
    expect(ui.list.innerHTML).not.toContain("·");
    const css = readFileSync("public/admin.css", "utf8");
    expect(css).toMatch(/\.metrics\s*\{[^}]*display: flex;[^}]*flex-wrap: wrap;/);
    expect(css).toContain(".metrics { gap: 6px 10px; }");
    expect(css).not.toMatch(/\.metric[^{}]*::before\s*\{[^}]*content: "·"/);
  });
});

describe("Phase 8 Gate 8.6.3: local copy feedback", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it.each([
    ["short", "Link curto copiado"],
    ["destination", "URL de destino copiada"],
    ["variant", "URL da Variante B copiada"],
  ])("confirms %s with check, contextual announcement and unchanged focus", async (kind, message) => {
    const ui = contentSetup(); const { button, feedback, attributes } = ui.addCopy(kind);
    ui.doc.activeElement = button;
    await ui.sandbox.copyWithFeedback(button, "https://example.com/full?utm_source=email", kind);
    expect(button.dataset.copyState).toBe("success");
    expect(feedback.textContent).toBe("Copiado"); expect(feedback.innerHTML).toContain('data-icon="check"');
    expect(ui.sandbox.copyStatus.textContent).toBe(message);
    expect(attributes["aria-label"]).toMatch(/^Copiado: /); expect(attributes["aria-busy"]).toBeUndefined();
    expect(ui.doc.activeElement).toBe(button); expect(ui.sandbox.copyToClipboard).toHaveBeenCalledWith("https://example.com/full?utm_source=email");
  });
  it("restores the original label, title and idle icon at 1800ms", async () => {
    const ui = contentSetup(); const { button, feedback, attributes } = ui.addCopy("short");
    await ui.sandbox.copyWithFeedback(button, "https://example.com/slug", "short");
    vi.advanceTimersByTime(1799); expect(button.dataset.copyState).toBe("success");
    vi.advanceTimersByTime(1); expect(button.dataset.copyState).toBeUndefined(); expect(feedback.innerHTML).toBe("");
    expect(attributes["aria-label"]).toBe("Copiar"); expect(attributes.title).toBe("Original"); expect(vi.getTimerCount()).toBe(0);
  });
  it("renews the same control's timeout without accumulating timers", async () => {
    const ui = contentSetup(); const { button } = ui.addCopy("short");
    await ui.sandbox.copyWithFeedback(button, "https://example.com/slug", "short"); vi.advanceTimersByTime(500);
    await ui.sandbox.copyWithFeedback(button, "https://example.com/slug", "short"); expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1300); expect(button.dataset.copyState).toBe("success");
    vi.advanceTimersByTime(499); expect(button.dataset.copyState).toBe("success");
    vi.advanceTimersByTime(1); expect(button.dataset.copyState).toBeUndefined();
  });
  it("keeps short link, URL A and URL B independent with their own expiry", async () => {
    const ui = contentSetup(); const short = ui.addCopy("short"), a = ui.addCopy(), b = ui.addCopy("variant");
    await ui.sandbox.copyWithFeedback(short.button, "https://links.example.com/slug", "short"); vi.advanceTimersByTime(500);
    await ui.sandbox.copyWithFeedback(a.button, "https://example.com/a", "destination"); vi.advanceTimersByTime(500);
    await ui.sandbox.copyWithFeedback(b.button, "https://example.com/b", "variant");
    expect(vi.getTimerCount()).toBe(3); expect([short, a, b].map(row => row.button.dataset.copyState)).toEqual(["success", "success", "success"]);
    expect(ui.sandbox.copyToClipboard.mock.calls.map((args: string[]) => args[0])).toEqual(["https://links.example.com/slug", "https://example.com/a", "https://example.com/b"]);
    vi.advanceTimersByTime(800); expect(short.button.dataset.copyState).toBeUndefined(); expect(a.button.dataset.copyState).toBe("success"); expect(b.button.dataset.copyState).toBe("success");
    vi.advanceTimersByTime(500); expect(a.button.dataset.copyState).toBeUndefined(); expect(b.button.dataset.copyState).toBe("success");
    vi.advanceTimersByTime(500); expect(b.button.dataset.copyState).toBeUndefined();
  });
  it("copies the full Variant B through its actual delegated handler", async () => {
    const ui = contentSetup(); const url = "https://example.com/b?utm_content=" + "b".repeat(360); const { button } = ui.addCopy("variant", url);
    await ui.listeners[0]({ target: { closest: () => button } });
    expect(ui.sandbox.copyToClipboard).toHaveBeenCalledWith(url); expect(ui.sandbox.copyStatus.textContent).toBe("URL da Variante B copiada");
  });
  it.each([
    ["short", "Não foi possível copiar o link"],
    ["destination", "Não foi possível copiar a URL de destino"],
    ["variant", "Não foi possível copiar a URL da Variante B"],
  ])("reports %s failure without Copiado or a leaked URL", async (kind, message) => {
    const ui = contentSetup(); const { button, feedback } = ui.addCopy(kind); const url = "https://example.com/private?token=secret";
    ui.sandbox.copyToClipboard.mockRejectedValue(new Error(url));
    await ui.sandbox.copyWithFeedback(button, url, kind);
    expect(button.dataset.copyState).toBe("error"); expect(feedback.textContent).toBe("Falhou"); expect(feedback.innerHTML).not.toContain("Copiado");
    expect(ui.sandbox.copyStatus.textContent).toBe(message); expect(feedback.innerHTML).not.toContain(url);
    vi.advanceTimersByTime(1800); expect(button.dataset.copyState).toBeUndefined();
  });
  it("a retry can replace success with error and then recover", async () => {
    const ui = contentSetup(); const { button } = ui.addCopy();
    await ui.sandbox.copyWithFeedback(button, "https://example.com/a", "destination");
    ui.sandbox.copyToClipboard.mockRejectedValueOnce(new Error("denied"));
    await ui.sandbox.copyWithFeedback(button, "https://example.com/a", "destination");
    expect(button.dataset.copyState).toBe("error"); expect(vi.getTimerCount()).toBe(1);
    await ui.sandbox.copyWithFeedback(button, "https://example.com/a", "destination"); expect(button.dataset.copyState).toBe("success"); expect(vi.getTimerCount()).toBe(1);
  });
  it("ignores an older failure that settles after a newer success on the same button", async () => {
    const ui = contentSetup(); const { button } = ui.addCopy(); let rejectOld!: Function;
    ui.sandbox.copyToClipboard.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
    const old = ui.sandbox.copyWithFeedback(button, "https://example.com/a", "destination");
    await ui.sandbox.copyWithFeedback(button, "https://example.com/a", "destination"); rejectOld(new Error("late failure")); await old;
    expect(button.dataset.copyState).toBe("success"); expect(ui.sandbox.copyStatus.textContent).toBe("URL de destino copiada"); expect(vi.getTimerCount()).toBe(1);
  });
  it("does not let an older completion clear the newer request's busy state", async () => {
    const ui = contentSetup(); const { button, attributes } = ui.addCopy(); let resolveOld!: Function, resolveNew!: Function;
    ui.sandbox.copyToClipboard.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })).mockImplementationOnce(() => new Promise(resolve => { resolveNew = resolve; }));
    const old = ui.sandbox.copyWithFeedback(button, "a", "destination"), current = ui.sandbox.copyWithFeedback(button, "a", "destination");
    resolveOld(); await old; expect(attributes["aria-busy"]).toBe("true"); expect(button.dataset.copyState).toBeUndefined();
    resolveNew(); await current; expect(button.dataset.copyState).toBe("success"); expect(attributes["aria-busy"]).toBeUndefined();
  });
  it("discards late feedback from a button removed by rerender", async () => {
    const ui = contentSetup(); const { button } = ui.addCopy(); let resolve!: Function;
    ui.sandbox.copyToClipboard.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = ui.sandbox.copyWithFeedback(button, "https://example.com/a", "destination"); button.isConnected = false; resolve(); await pending;
    expect(ui.sandbox.copyStatus.textContent).toBe(""); expect(button.dataset.copyState).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
  });
  it("does not interpolate persisted strings into confirmation markup", async () => {
    const ui = contentSetup(); const { button, feedback } = ui.addCopy(); const value = '<img src=x onerror="alert(1)">';
    await ui.sandbox.copyWithFeedback(button, value, "destination");
    expect(ui.sandbox.copyToClipboard).toHaveBeenCalledWith(value); expect(feedback.innerHTML).not.toContain(value); expect(ui.sandbox.copyStatus.textContent).not.toContain(value);
  });
  it("reserves idle geometry, overlays feedback and removes motion without hiding confirmation", () => {
    const css = readFileSync("public/admin.css", "utf8"), html = readFileSync("public/admin.html", "utf8");
    expect(css).toContain('.copy-control[data-copy-state] .copy-idle { visibility: hidden; }');
    expect(css).toMatch(/\.copy-feedback \{[^}]*position: absolute; inset: 0;/);
    expect(css).toContain('.copy-control[data-copy-state] .copy-feedback { display: flex; }');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.copy-control[^}]*transform: none; transition: none !important;/);
    expect(html).toContain('id="copy-status" class="copy-status" role="status" aria-live="polite" aria-atomic="true"');
  });
});

function clipboardSetup(result: boolean | Error = true, api?: Function) {
  const opener: any = { focus: vi.fn(() => { doc.activeElement = opener; }) };
  const input: any = { value: "", style: {}, setAttribute: vi.fn(), select: vi.fn(() => { doc.activeElement = input; }), remove: vi.fn(() => { doc.activeElement = doc.body; }) };
  const doc: any = { activeElement: opener, createElement: vi.fn(() => input), body: { appendChild: vi.fn() }, execCommand: vi.fn(() => { if (result instanceof Error) throw result; return result; }) };
  const sandbox: any = { document: doc, navigator: { clipboard: api ? { writeText: api } : undefined } };
  vm.createContext(sandbox); vm.runInContext(readFileSync("public/admin.js", "utf8").match(/async function copyToClipboard\([\s\S]*?\n\}/)![0], sandbox);
  return { sandbox, doc, opener, input };
}

describe("Phase 8 Gate 8.6.3: clipboard fallback", () => {
  it("retains the fallback's full value and restores button focus after success", async () => {
    const ui = clipboardSetup(); const value = "https://example.com/?utm=" + "a".repeat(350);
    await ui.sandbox.copyToClipboard(value);
    expect(ui.input.value).toBe(value); expect(ui.doc.execCommand).toHaveBeenCalledWith("copy"); expect(ui.input.remove).toHaveBeenCalledOnce();
    expect(ui.doc.activeElement).toBe(ui.opener); expect(ui.opener.focus).toHaveBeenCalledWith({ preventScroll: true });
  });
  it.each([false, new Error("denied")])("cleans up and restores focus when fallback fails: %s", async result => {
    const ui = clipboardSetup(result); await expect(ui.sandbox.copyToClipboard("https://example.com/")).rejects.toThrow();
    expect(ui.input.remove).toHaveBeenCalledOnce(); expect(ui.doc.activeElement).toBe(ui.opener);
  });
  it("preserves the existing API path and propagates rejection without inventing success", async () => {
    const api = vi.fn().mockRejectedValue(new Error("denied")); const ui = clipboardSetup(true, api);
    await expect(ui.sandbox.copyToClipboard("https://example.com/")).rejects.toThrow("denied");
    expect(api).toHaveBeenCalledWith("https://example.com/"); expect(ui.doc.createElement).not.toHaveBeenCalled(); expect(ui.doc.activeElement).toBe(ui.opener);
  });
});

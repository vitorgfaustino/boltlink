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
  ui.nodes["trash-panel"].open = true;
  await ui.controller.refresh();
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
    ui.nodes["trash-panel"].open = true;
    const old = ui.controller.refresh();
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

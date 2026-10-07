// @vitest-environment node
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const admin = readFileSync("public/admin.js", "utf8");
const html = readFileSync("public/admin.html", "utf8");
function moduleApi(file: string, name: string): any {
  const sandbox: any = { window: {}, URL, URLSearchParams, Map, Set };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(`public/${file}`, "utf8"), sandbox);
  return sandbox.window[name];
}
function actual(name: string) {
  return admin.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`))![0];
}
const utm = moduleApi("utm-ui.js", "BoltLinkUtm");
const groups = moduleApi("group-hierarchy-ui.js", "BoltLinkGroupHierarchy");
const hierarchy = [
  { id: 1, name: "Franquia 01", parent_id: null },
  { id: 2, name: "Bio", parent_id: 1 },
  { id: 3, name: "Instagram", parent_id: 2 },
  { id: 4, name: "Cardápio", parent_id: 1 },
  { id: 5, name: "Franquia 02", parent_id: null },
  { id: 6, name: "Bio", parent_id: 5 },
];

describe("Gate 9.1: paths and descendant sets", () => {
  it.each([[1, "Franquia 01"], [2, "Franquia 01 / Bio"], [3, "Franquia 01 / Bio / Instagram"], [6, "Franquia 02 / Bio"]])("full path %s", (id, path) => {
    expect(groups.groupPath(groups.buildTree(hierarchy).byId, id)).toBe(path);
  });
  it.each([[1, [1, 2, 3, 4]], [2, [2, 3]], [3, [3]], [4, [4]]])("subtree %s", (id, expected) => {
    expect([...groups.subtreeIds(groups.buildTree(hierarchy), id)].sort()).toEqual(expected);
  });
  it("keeps all 16 levels and terminates a hand-built cyclic/repeated graph without duplicate ids", () => {
    const deep = Array.from({ length: 16 }, (_, i) => ({ id: i + 1, name: `Nível ${i + 1}`, parent_id: i || null }));
    const tree = groups.buildTree(deep);
    expect(groups.groupPath(tree.byId, 16)).toBe(deep.map((g) => g.name).join(" / "));
    expect(groups.subtreeIds(tree, 1).size).toBe(16);
    expect([...groups.subtreeIds({ childrenOf: new Map([[1, [{ id: 2 }, { id: 2 }]], [2, [{ id: 1 }]]]) }, 1)].sort()).toEqual([1, 2]);
  });
  it("renders the full escaped path into badge text, title and accessible name without touching records", () => {
    const link = { slug: "example", target_url: "https://example.com/", group_id: 3, group_name: "Instagram" };
    const sandbox: any = {
      state: { links: [link], groupTree: groups.buildTree(hierarchy), pendingDeletes: new Map() }, groupHierarchyUi: groups,
      linksCount: {}, linksList: {}, cardActionMarkup: () => "", linkContentMarkup: () => "", ICONS: {},
      renderAbMetrics: () => "", renderAbBreakdown: () => "", renderSmartBadge: () => "", formatDate: () => "", scheduleLinkContentMeasure: vi.fn(),
    };
    vm.createContext(sandbox);
    vm.runInContext(actual("escapeHtml") + actual("renderLinks"), sandbox);
    const before = JSON.stringify(link);
    sandbox.renderLinks();
    expect(sandbox.linksList.innerHTML).toContain('title="Franquia 01 / Bio / Instagram" aria-label="Grupo: Franquia 01 / Bio / Instagram">Franquia 01 / Bio / Instagram</span>');
    expect(JSON.stringify(link)).toBe(before);
    sandbox.state.groupTree.byId.get(2).name = '<img src=x onerror="alert(1)">';
    sandbox.renderLinks();
    expect(sandbox.linksList.innerHTML).toContain("&lt;img");
    expect(sandbox.linksList.innerHTML).not.toContain("<img");
    const css = readFileSync("public/admin.css", "utf8").match(/\.group-badge\s*\{[^}]*\}/)![0];
    for (const rule of ["text-overflow: ellipsis", "white-space: nowrap", "max-width: 100%", "overflow: hidden"]) expect(css).toContain(rule);
  });
  it.each([["1", "group_id=1&include_descendants=true"], ["__none__", "group_id=null"], ["", ""]])("Admin sends one list request for filter %s", async (filter, query) => {
    const sandbox: any = { URLSearchParams, state: {}, searchTermInput: { value: "" }, searchGroupIdInput: { value: filter, options: [{ text: "Grupo" }], selectedIndex: 0 },
      listStatus: {}, setStatus: vi.fn(), renderLinks: vi.fn(), request: vi.fn(async () => ({ links: [] })) };
    vm.createContext(sandbox); vm.runInContext(actual("loadLinks"), sandbox);
    await sandbox.loadLinks();
    expect(sandbox.request).toHaveBeenCalledExactlyOnceWith(`/api/links${query ? "?" + query : ""}`, { method: "GET" });
  });
});

describe("Gate 9.1: UTM pure helpers", () => {
  it.each(["https://example.com/", "https://example.com/?other=value"]) ("no UTMs: %s", (url) => {
    expect(Object.values(utm.parseUtmFromUrl(url))).toEqual(["", "", "", "", ""]);
  });
  it("reads one or all five supported parameters, decoding spaces and unicode", () => {
    expect(utm.parseUtmFromUrl("https://example.com/?utm_source=google").utm_source).toBe("google");
    expect(utm.parseUtmFromUrl("https://example.com/p?utm_source=google&utm_medium=cpc&utm_campaign=promo&utm_content=a%20b&utm_term=caf%C3%A9&utm_other=ignored#hash"))
      .toEqual({ utm_source: "google", utm_medium: "cpc", utm_campaign: "promo", utm_content: "a b", utm_term: "café" });
  });
  it("changes/removes supported parameters while preserving unrelated query bytes, duplicates, path and hash", () => {
    const before = "https://example.com/pr%6Fduct?id=55&ref=a%20b&ref=~&flag&utm_source=google&utm_medium=cpc&utm_campaign=promo#det%61ils";
    const changed = utm.applyUtmToUrl(before, { utm_source: "instagram" });
    expect(changed).toBe(before.replace("utm_source=google", "utm_source=instagram"));
    expect(utm.applyUtmToUrl(changed, { utm_medium: "" })).toBe(changed.replace("&utm_medium=cpc", ""));
    expect(utm.applyUtmToUrl("https://example.com/#hash?utm_source=x", { utm_source: "a & café" })).toBe("https://example.com/?utm_source=a+%26+caf%C3%A9#hash?utm_source=x");
  });
  it("does not reserialize an unchanged UTM or an unrelated URL", () => {
    const url = "https://example.com/?utm_source=a%20b&x=~#h";
    expect(utm.applyUtmToUrl(url, { utm_source: "a b" })).toBe(url);
    expect(utm.applyUtmToUrl("https://example.com/path?#h", {})).toBe("https://example.com/path?#h");
  });
  it("removes all duplicates/empty fields and leaves unknown UTM parameters alone", () => {
    const url = "https://example.com/?utm_source=a&utm_source=b&utm_other=x";
    expect(utm.applyUtmToUrl(url, { utm_source: "c" })).toBe("https://example.com/?utm_source=c&utm_other=x");
    expect(utm.applyUtmToUrl(url, { utm_source: "" })).toBe("https://example.com/?utm_other=x");
    expect(utm.applyUtmToUrl("https://example.com/?utm_source=", { utm_source: "" })).toBe("https://example.com/");
  });
  it.each(["", "https://", "not a URL", "javascript:alert(1)"]) ("invalid input never throws: %s", (url) => {
    expect(utm.parseUtmFromUrl(url)).toBeNull();
    expect(utm.applyUtmToUrl(url, { utm_source: "x" })).toBeNull();
  });
});

function utmForm() {
  const field = () => ({ value: "", listeners: {} as Record<string, Function>, addEventListener(event: string, fn: Function) { this.listeners[event] = fn; }, focus() {} });
  const targetUrlInput = field();
  const fields = Array.from({ length: 5 }, field);
  const sandbox: any = { utmUi: utm, state: { pendingUtmFields: {} }, targetUrlInput, utmPreview: {},
    utmSourceInput: fields[0], utmMediumInput: fields[1], utmCampaignInput: fields[2], utmContentInput: fields[3], utmTermInput: fields[4],
    refreshDomainWarning: vi.fn(), refreshSmartFallback: vi.fn(), schedulePreviewLoad: vi.fn() };
  vm.createContext(sandbox);
  vm.runInContext(["hydrateUtmFields", "refreshUtmPreview"].map(actual).join("\n"), sandbox);
  const start = admin.indexOf("[targetUrlInput, utmSourceInput,");
  vm.runInContext(admin.slice(start, admin.indexOf('searchForm.addEventListener("submit"', start)), sandbox);
  return { sandbox, target: targetUrlInput, fields };
}

// Execute the real submit payload preparation, rather than a copied assembler.
function submittedUrl(ui: ReturnType<typeof utmForm>) {
  const start = admin.indexOf("  // Manual URL edits are authoritative");
  const end = admin.indexOf("\n  collectSmartRules();", start);
  return vm.runInContext(`(() => { ${admin.slice(start, end)}; return urlWithUtm; })()`, ui.sandbox);
}

describe("Gate 9.1: actual Admin UTM wiring", () => {
  it("hydrates, edits, clears and rehydrates after a manual URL blur", () => {
    const ui = utmForm();
    ui.target.value = "https://example.com/produto?id=55&utm_source=google&utm_medium=cpc&utm_campaign=promo#detalhes";
    ui.sandbox.hydrateUtmFields();
    expect(ui.fields.map((f) => f.value)).toEqual(["google", "cpc", "promo", "", ""]);
    ui.fields[0].value = "instagram"; ui.fields[0].listeners.input();
    expect(ui.target.value).toBe("https://example.com/produto?id=55&utm_source=instagram&utm_medium=cpc&utm_campaign=promo#detalhes");
    ui.fields[1].value = ""; ui.fields[1].listeners.input();
    expect(ui.target.value).not.toContain("utm_medium");
    ui.target.value = "https://site.example/?utm_source=facebook&utm_campaign=black_friday";
    ui.target.listeners.blur();
    expect(ui.fields.map((f) => f.value)).toEqual(["facebook", "", "black_friday", "", ""]);
  });
  it("preserves generator edits entered before a valid URL in the creation flow", () => {
    const ui = utmForm();
    ui.fields[0].value = "newsletter"; ui.fields[0].listeners.input();
    ui.target.value = "https://"; ui.target.listeners.input();
    expect(ui.fields[0].value).toBe("newsletter");
    ui.target.value = "https://example.com/?id=55&utm_medium=email#hash";
    ui.target.listeners.blur();
    expect(ui.target.value).toBe("https://example.com/?id=55&utm_medium=email&utm_source=newsletter#hash");
    expect(ui.fields.map((f) => f.value)).toEqual(["newsletter", "email", "", "", ""]);
    expect(ui.sandbox.state.pendingUtmFields).toEqual({});
  });
  it("does not clear fields during partial input and resynchronizes at submit even without blur", () => {
    const ui = utmForm(); ui.fields[0].value = "keep"; ui.target.value = "https://";
    ui.target.listeners.input(); ui.target.listeners.blur();
    expect(ui.fields[0].value).toBe("keep");
    ui.target.value = "https://example.com/?utm_source=new";
    ui.sandbox.hydrateUtmFields(); expect(ui.fields[0].value).toBe("new");
    const submit = admin.slice(admin.indexOf('linkForm.addEventListener("submit"'), admin.indexOf("const urlWithUtm"));
    expect(submit).toContain("hydrateUtmFields()");
    expect(actual("beginEdit")).toContain("hydrateUtmFields()");
    expect(html.indexOf('src="/utm-ui.js"')).toBeLessThan(html.indexOf('src="/admin.js"'));
  });
});

describe("Gate 9.2: UTM regression hardening", () => {
  it("explicitly associates all UTM labels with inputs even when help buttons share the label", () => {
    for (const key of ["source", "medium", "campaign", "content", "term"]) {
      const label = html.match(new RegExp(`<label for="utm-${key}">([\\s\\S]*?)</label>`));
      expect(label, key).not.toBeNull();
      expect(label![1]).toContain(`id="utm-${key}"`);
    }
  });
  it.each([
    "https://example.com/path",
    "https://EXAMPLE.com:443/pr%6Fduct?id=55&ref=a%20b&ref=~&flag#det%61ils",
    "https://example.com/path?#hash?utm_source=fragment",
    "https://example.com/?utm_campaign=promo%20de%20verao&id=55#detalhes",
  ])("does not transform an untouched URL on hydration and save: %s", (url) => {
    const ui = utmForm(); ui.target.value = url;
    ui.sandbox.hydrateUtmFields();
    expect(ui.target.value).toBe(url);
    expect(submittedUrl(ui)).toBe(url);
  });
  it.each(utm.KEYS as string[])("clearing %s removes only that parameter, preserving other UTMs/query/hash", (key) => {
    const ui = utmForm();
    const query = utm.KEYS.map((k: string) => `${k}=value`).join("&");
    ui.target.value = `https://example.com/path?id=55&ref=abc&${query}#detalhes`;
    ui.sandbox.hydrateUtmFields();
    const index = utm.KEYS.indexOf(key);
    ui.fields[index].value = ""; ui.fields[index].listeners.input();
    const expected = `https://example.com/path?id=55&ref=abc&${utm.KEYS.filter((k: string) => k !== key).map((k: string) => `${k}=value`).join("&")}#detalhes`;
    expect(submittedUrl(ui)).toBe(expected);
  });
  it.each(["google", "facebook"])("hydrates the first repeated value and normalizes save when the second is %s", (second) => {
    const ui = utmForm();
    ui.target.value = `https://example.com/?id=55&ref=a%20b&utm_source=google&ref=~&utm_source=${second}#hash`;
    ui.sandbox.hydrateUtmFields();
    expect(ui.fields[0].value).toBe("google");
    expect(submittedUrl(ui)).toBe("https://example.com/?id=55&ref=a%20b&utm_source=google&ref=~#hash");
  });
  it("normalizes an explicitly edited duplicate even when both old values already equal the input", () => {
    expect(utm.applyUtmToUrl("https://example.com/?utm_source=google&id=1&utm_source=google", { utm_source: "google" }))
      .toBe("https://example.com/?utm_source=google&id=1");
  });
  it("encodes unicode once and preserves the untouched campaign encoding", () => {
    const ui = utmForm();
    ui.target.value = "https://example.com/?id=55&utm_campaign=promo%20de%20verao#hash";
    ui.sandbox.hydrateUtmFields(); expect(ui.fields[2].value).toBe("promo de verao");
    ui.fields[3].value = "botão principal"; ui.fields[3].listeners.input();
    ui.fields[4].value = "ração gatos"; ui.fields[4].listeners.input();
    expect(submittedUrl(ui)).toBe("https://example.com/?id=55&utm_campaign=promo%20de%20verao&utm_content=bot%C3%A3o+principal&utm_term=ra%C3%A7%C3%A3o+gatos#hash");
    expect(ui.fields[3].value).toBe("botão principal"); expect(ui.fields[4].value).toBe("ração gatos");
  });
  it("preserves fields on empty/incomplete URL and rehydrates the next valid manual URL", () => {
    const ui = utmForm(); ui.target.value = "https://example.com/?utm_source=google"; ui.sandbox.hydrateUtmFields();
    for (const value of ["", "https:", "https://"]) {
      ui.target.value = value; ui.target.listeners.input(); ui.target.listeners.blur();
      expect(ui.fields[0].value).toBe("google");
    }
    ui.target.value = "https://example.com/?utm_source=facebook&utm_campaign=q2";
    ui.target.listeners.blur(); expect(ui.fields.map((f) => f.value)).toEqual(["facebook", "", "q2", "", ""]);
  });
});

describe("Gate 9.2: asynchronous group filter", () => {
  it.each(["success", "failure"])("ignores an old filter %s that settles after the latest selection", async (oldResult) => {
    const pending: Array<{ resolve: Function; reject: Function }> = [];
    const sandbox: any = { URLSearchParams, state: {}, searchTermInput: { value: "" },
      searchGroupIdInput: { value: "1", options: [{ text: "A" }, { text: "B" }], selectedIndex: 0 },
      listStatus: {}, setStatus: vi.fn(), renderLinks: vi.fn(),
      request: vi.fn(() => new Promise((resolve, reject) => pending.push({ resolve, reject }))) };
    vm.createContext(sandbox); vm.runInContext(actual("loadLinks"), sandbox);
    const oldRequest = sandbox.loadLinks("", "1");
    sandbox.searchGroupIdInput.value = "2"; sandbox.searchGroupIdInput.selectedIndex = 1;
    const currentRequest = sandbox.loadLinks("", "2");
    pending[1].resolve({ links: [{ slug: "latest-selection" }] }); await currentRequest;
    const calls = sandbox.setStatus.mock.calls.length;
    if (oldResult === "success") pending[0].resolve({ links: [{ slug: "old-selection" }] });
    else pending[0].reject(new Error("old selection failed"));
    await oldRequest;
    expect(sandbox.state.links).toEqual([{ slug: "latest-selection" }]);
    expect(sandbox.renderLinks).toHaveBeenCalledOnce();
    expect(sandbox.setStatus.mock.calls).toHaveLength(calls);
  });
});

describe("Gate 9.1: setup and product README", () => {
  it("exposes ROOT_REDIRECT_URL as optional Text with an empty default and no secret entry", () => {
    const cfg = Function(`return (${readFileSync("wrangler.jsonc", "utf8")});`)();
    expect(cfg.vars.ROOT_REDIRECT_URL).toBe(""); expect(cfg.keep_vars).toBe(true);
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.cloudflare.bindings.ROOT_REDIRECT_URL.description).toMatch(/Opcional.*Text.*não Secret/);
    expect(readFileSync(".dev.vars.example", "utf8")).not.toMatch(/^ROOT_REDIRECT_URL=/m);
    expect(readFileSync("docs/admin-ux.md", "utf8")).toContain("Text");
  });
  it("leads with product value and deployment, and preserves technical docs and existing screenshots", () => {
    const readme = readFileSync("README.md", "utf8");
    const intro = readme.split("## Instalação e configuração")[0];
    for (const text of ["Por que usar", "Principais recursos", "Screenshots", "Deploy rápido", "deploy.workers.cloudflare.com/?url="]) expect(intro).toContain(text);
    expect(intro).not.toMatch(/000[0-6]|7500|SQL DELTA|parser|histórico de gates/);
    for (const file of ["public/tela-links.webp", "public/tela-home.webp", "public/tela-link-protegido.webp", "docs/technical-reference.md"]) expect(existsSync(file)).toBe(true);
    for (const match of readme.matchAll(/\]\(([^)]+)\)/g)) {
      if (!/^https?:/.test(match[1])) expect(existsSync(resolve(match[1].split("#")[0])), match[1]).toBe(true);
    }
  });
});

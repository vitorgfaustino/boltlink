/* Copyright (c) 2026 Vitor Faustino — AGPL-3.0 */
// @vitest-environment node
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

/**
 * Gate 9.4: the link card must answer two different questions at a glance without mixing them.
 *
 *   "Which BoltLink feature does this link use?"  -> semantic feature badge (fixed hue)
 *   "Where was it classified / where did it come from?" -> neutral (group, tags, source)
 *
 * These assertions protect the roles, not literal hexes: a feature keeps its own token, and
 * user-created data never borrows one.
 */
const admin = readFileSync("public/admin.js", "utf8");
const css = readFileSync("public/admin.css", "utf8");

function windowApi(file: string, name: string): any {
  const sandbox: any = { window: {}, URL };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(`public/${file}`, "utf8"), sandbox);
  return sandbox.window[name];
}
const groups = windowApi("group-hierarchy-ui.js", "BoltLinkGroupHierarchy");
const smartRouting = windowApi("smart-routing-ui.js", "BoltLinkSmartRouting");
const abDisplay = windowApi("ab-display.js", "BoltLinkAbDisplay");

function source(name: string): string {
  const match = admin.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`));
  if (!match) throw new Error(`admin.js has no function ${name}`);
  return match[0];
}

const hierarchy = [
  { id: 1, name: "Franquia 01", parent_id: null },
  { id: 2, name: "Bio", parent_id: 1 },
  { id: 3, name: "Instagram", parent_id: 2 },
];

/** Renders real cards with the real badge helpers, so the assertions read the shipped markup. */
function render(links: any[], options: { smartRouting?: boolean } = {}) {
  const list: any = { innerHTML: "" };
  const sandbox: any = {
    window: { BoltLinkAbDisplay: abDisplay },
    state: { links, groupTree: groups.buildTree(hierarchy), pendingDeletes: new Map(), smartRouting: options.smartRouting !== false },
    smartRoutingUi: smartRouting,
    groupHierarchyUi: groups,
    linksCount: {}, linksList: list, ICONS: {},
    cardActionMarkup: (action: string, _variant: string, _icon: string, label: string, slug: string) =>
      `<button data-action="${action}" data-slug="${slug}" aria-label="${label}" title="${label}">${label}</button>`,
    formatDate: () => "01/10/2026 09:00",
    scheduleLinkContentMeasure: vi.fn(),
  };
  vm.createContext(sandbox);
  vm.runInContext(
    ["escapeHtml", "featureBadge", "renderAbMetrics", "renderAbBreakdown", "renderSmartBadge", "linkContentMarkup", "renderLinks"]
      .map(source)
      .join("\n"),
    sandbox,
  );
  sandbox.renderLinks();
  return list.innerHTML as string;
}

const badgesOf = (markup: string) => [...markup.matchAll(/<span class="([^"]*badge[^"]*)"[^>]*>([\s\S]*?)<\/span>/g)]
  .map((match) => ({ className: match[1], text: match[2].replace(/<[^>]*>/g, "").trim() }));

const featureRule = (modifier: string) => css.match(new RegExp(`\\.feature-badge--${modifier} \\{[^}]*\\}`))![0];

describe("Gate 9.4: copy actions stay unambiguous", () => {
  it('labels the primary card action "Copiar link" and keeps it bound to the short link', () => {
    const markup = render([{ slug: "campanha-q2", target_url: "https://exemplo.com/x", redirect_type: "302" }]);
    expect(markup).toContain('aria-label="Copiar link"');
    expect(markup).toContain('data-action="copy"');
    // The handler still copies the short link, never the destination.
    const start = admin.indexOf('if (action === "copy")');
    const copy = admin.slice(start, admin.indexOf('if (action === "delete")', start));
    expect(copy).toContain("buildShortLink(link.slug)");
    expect(copy).toContain('copyWithFeedback(button, shortLink, "short")');
    expect(copy).not.toContain("target_url");
  });

  it('keeps a separate "Copiar destino" for the destination', () => {
    const markup = render([{ slug: "campanha-q2", target_url: "https://exemplo.com/x" }]);
    expect(markup).toContain('aria-label="Copiar destino: URL de destino"');
    expect(markup).toContain('data-copy-kind="destination"');
    expect(markup).toContain('data-copy-value="https://exemplo.com/x"');
  });
});

describe("Gate 9.4: features are coloured, classification is not", () => {
  it.each([
    ["ab", { slug: "ab", target_url: "https://exemplo.com/a", ab_enabled: 1, ab_weight_b: 50, ab_clicks_a: 1, ab_clicks_b: 1, ab_target_url: "https://exemplo.com/b" }, /Teste A\/B/],
    ["routing", { slug: "sr", target_url: "https://exemplo.com/s", smartRoutingRules: [{ country: "BR", target_url: "https://exemplo.com/br" }] }, /Smart Routing/],
    ["qr", { slug: "qr", target_url: "https://exemplo.com/q", has_qrcode: 1 }, /QR Code baixado/],
  ])("%s carries its own semantic feature badge", (modifier, link, text) => {
    const badge = badgesOf(render([link])).find((entry) => entry.className.includes(`feature-badge--${modifier}`));
    expect(badge, `no feature-badge--${modifier} rendered`).toBeDefined();
    expect(badge!.text).toMatch(text);
    // Every feature modifier resolves to the dedicated tokens, never to the neutral line/badge set.
    expect(featureRule(modifier as string)).toContain("--feature-ink: var(--feature-");
    expect(featureRule(modifier as string)).not.toContain("--badge-");
  });

  it("never colour-codes a group or user-created data", () => {
    const markup = render([{ slug: "g", target_url: "https://exemplo.com/g", group_id: 3, tags: '["promo"]' }]);
    const classes = badgesOf(markup).map((entry) => entry.className);
    expect(classes.some((name) => name.includes("feature-badge"))).toBe(false);
    expect(markup).toContain('class="group-badge"');
    // The neutral classifier and the tag line reference no feature hue at all.
    expect(css.match(/\.group-badge \{[^}]*\}/)![0]).not.toContain("--feature-");
    expect(css.match(/\.link-tags \{[^}]*\}/)![0]).not.toContain("--feature-");
    // No per-name/per-hash colour assignment exists anywhere in the Admin.
    expect(admin).not.toMatch(/hashCode|hashString|stringToColor|colorForGroup|hsl\(/i);
    expect(css).not.toMatch(/hsl\(/i);
  });

  it("keeps the semantic map fixed, complete and documented for both themes", () => {
    const dark = css.match(/:root,[\s\S]*?\{([\s\S]*?)\}/)![1];
    const light = css.match(/\[data-theme="light"\] \{([\s\S]*?)\}/)![1];
    for (const token of [
      "--feature-ab", "--feature-ab-bg", "--feature-ab-border",
      "--feature-routing", "--feature-routing-bg", "--feature-routing-border",
      "--feature-qr", "--feature-qr-bg", "--feature-qr-border",
    ]) {
      expect(dark, `dark is missing ${token}`).toContain(`${token}:`);
      expect(light, `light is missing ${token}`).toContain(`${token}:`);
    }
    // One feature modifier per BoltLink feature, and nothing for user data.
    const modifiers = [...css.matchAll(/\.feature-badge--([\w-]+)/g)].map((match) => match[1]);
    expect([...new Set(modifiers)].sort()).toEqual(["ab", "lock", "qr", "routing"]);
  });

  it("keeps the password badge neutral on purpose, told apart by text rather than a fourth hue", () => {
    const badge = badgesOf(render([{ slug: "p", target_url: "https://exemplo.com/p", has_password: 1 }]))
      .find((entry) => entry.className.includes("feature-badge--lock"));
    expect(badge!.text).toBe("Senha definida");
    expect(featureRule("lock")).toContain("--feature-ink: var(--text-secondary)");
    expect(featureRule("lock")).not.toContain("--feature-ab");
    expect(featureRule("lock")).not.toContain("--feature-routing");
    expect(featureRule("lock")).not.toContain("--feature-qr");
  });
});

describe("Gate 9.4: compact A/B keeps every counter reachable", () => {
  const link = {
    slug: "ab", target_url: "https://exemplo.com/a", ab_target_url: "https://exemplo.com/b",
    ab_enabled: 1, ab_weight_b: 50, ab_clicks_a: 210, ab_clicks_b: 221,
  };

  it("summarizes the experiment on the card and keeps the details collapsed", () => {
    const markup = render([link]);
    expect(markup).toContain("Teste A/B");
    expect(markup).toContain("50% / 50%");
    expect(markup).toMatch(/<details class="card-details">\s*<summary>Ver detalhes<\/summary>/);
    expect(markup).not.toMatch(/<details class="card-details" open/);
  });

  it("keeps the variant destination and both counter sets in the DOM inside the details", () => {
    const markup = render([link]);
    expect(markup).toContain('class="variant-content"');
    expect(markup).toContain(`id="link-content-0-variant">${link.ab_target_url}</div>`);
    expect(markup).toContain("Cliques A <strong>210</strong>");
    expect(markup).toContain("Cliques B <strong>221</strong>");
    expect(markup).toContain("Distribuição observada");
    // The variant URL keeps its own copy action and its measured expander.
    expect(markup).toContain('data-copy-value="https://exemplo.com/b" data-copy-kind="variant"');
    expect(markup).toContain('aria-controls="link-content-0-variant"');
  });

  it("re-measures the expanders when the details is opened, so a long variant URL stays revealable", () => {
    const start = admin.indexOf('linksList.addEventListener("click", async (event) => {');
    const listener = admin.slice(start, admin.indexOf('await copyWithFeedback', start));
    expect(listener).toContain('closest(".card-details > summary")');
    expect(listener).toContain("scheduleLinkContentMeasure()");
  });
});

describe("Gate 9.4: metadata line reads as one structured row", () => {
  it("keeps each fact as its own item and spells the redirect type out", () => {
    const markup = render([{
      slug: "schedule", target_url: "https://exemplo.com/", clicks_total: 6, redirect_type: "302",
      created_at: "2026-10-01", go_live_at: "2026-10-01", expires_at: "2027-10-01",
    }]);
    for (const label of ["Cliques", "Criado:", "Redirecionamento", "Expira", "Ativa"]) {
      expect(markup).toContain(`<span class="metric">${label}`);
    }
    expect(markup).toContain("302 (temporário)");
    expect(render([{ slug: "p", target_url: "https://exemplo.com/", redirect_type: "301" }])).toContain("301 (permanente)");
  });

  it("draws the separator between facts in CSS only, so no punctuation can orphan in the DOM", () => {
    const markup = render([{ slug: "m", target_url: "https://exemplo.com/", clicks_total: 1, redirect_type: "302" }]);
    expect(markup).not.toContain("•");
    // The separator belongs to the metadata line only; the expanded breakdown is a row list.
    expect(css).toMatch(/\.metrics \.metric \+ \.metric::before \{ content: "•";/);
    expect(css).not.toMatch(/\.card-details-metrics \.metric \+ \.metric::before/);
    expect(css).toMatch(/\.card-details-metrics \{ display: grid; gap: 4px;/);
    // Narrow viewports are the ones that wrap, so they fall back to the gap alone.
    expect(css).toMatch(/@media \(max-width: 640px\) \{\s*\.metrics \.metric \+ \.metric::before \{ content: none; \}\s*\}/);
    expect(css).toMatch(/\.metrics \{ gap: 6px 10px;[^}]*\}/);
  });
});

describe("Gate 9.4: density and long values", () => {
  it("clamps the destination to one measured line and exposes the complete value in title", () => {
    const long = "https://exemplo.com/" + "segmento-longo/".repeat(12);
    const markup = render([{ slug: "long", target_url: long }]);
    expect(markup).toContain(`title="${long}"`);
    expect(css).toMatch(/\.content-text:not\(\.is-expanded\) \{[^}]*-webkit-line-clamp: 1;[^}]*overflow: hidden;/);
    expect(css).toContain(".content-text { overflow-wrap: anywhere; }");
    expect(css).not.toMatch(/overflow-x:\s*scroll/);
  });

  it("lets the badges wrap while the destination keeps its own full-width line", () => {
    // Gate 9.5 stacks the copy action under the URL on every viewport, so the destination
    // never has to shrink to make room for a control next to it.
    expect(css).toMatch(/\.link-content \{ display: block; min-width: 0; \}/);
    expect(css).toMatch(/\.link-content > \.content-actions \{ margin-top: 4px; \}/);
    expect(css).not.toMatch(/\.link-content \{[^}]*display: flex/);
    expect(css).toMatch(/\.link-states \{ display: flex; flex-wrap: wrap; gap: 6px 8px; min-width: 0; margin-top: 4px; \}/);
    expect(css).toMatch(/\.feature-badge \{[^}]*max-width: 100%;/);
    // A long group path still ellipsizes instead of stretching the card.
    expect(css.match(/\.group-badge \{[^}]*\}/)![0]).toContain("text-overflow: ellipsis");
  });

  it("keeps the four visual levels in the documented order", () => {
    const markup = render([{ slug: "levels", target_url: "https://exemplo.com/x", group_id: 3, clicks_total: 1, redirect_type: "302" }]);
    const order = ["card-top", "card-destination", "link-states", "metrics"].map((name) => markup.indexOf(`class="${name}"`));
    expect(order.every((index) => index > -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("does not reintroduce a sticky column or an inner-scrolling editor", () => {
    expect(css).not.toMatch(/position:\s*sticky/);
    expect(css).not.toMatch(/@media[^{]*min-width:\s*1024px/);
    expect(admin).not.toMatch(/ResizeObserver/);
  });
});

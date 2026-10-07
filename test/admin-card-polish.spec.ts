/* Copyright (c) 2026 Vitor Faustino — AGPL-3.0 */
// @vitest-environment node
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

/**
 * Gate 9.5: spacing polish for the link card and the A/B disclosure.
 *
 * Gate 9.4 compacted the card; this gate only re-balances the space *between* the four
 * approved levels and turns the A/B summary into a control that reads as one. The
 * assertions below protect the relationships (which element owns which spacing, one
 * chevron, native semantics) rather than the exact pixel of every gap.
 */
const admin = readFileSync("public/admin.js", "utf8");
const css = readFileSync("public/admin.css", "utf8");
const rule = (pattern: RegExp) => {
  const match = css.match(pattern);
  if (!match) throw new Error(`admin.css has no rule matching ${pattern}`);
  return match[0];
};

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

function render(links: any[]) {
  const list: any = { innerHTML: "" };
  const sandbox: any = {
    window: { BoltLinkAbDisplay: abDisplay },
    state: { links, groupTree: groups.buildTree([{ id: 1, name: "Franquia 01", parent_id: null }]), pendingDeletes: new Map(), smartRouting: true },
    smartRoutingUi: smartRouting, groupHierarchyUi: groups,
    linksCount: {}, linksList: list, ICONS: {},
    cardActionMarkup: (action: string, _v: string, _i: string, label: string, slug: string) =>
      `<button data-action="${action}" data-slug="${slug}" aria-label="${label}">${label}</button>`,
    formatDate: () => "01/10/2026 09:00",
    scheduleLinkContentMeasure: vi.fn(),
  };
  vm.createContext(sandbox);
  vm.runInContext(
    ["escapeHtml", "featureBadge", "renderAbMetrics", "renderAbBreakdown", "renderSmartBadge", "linkContentMarkup", "renderLinks"]
      .map(source).join("\n"),
    sandbox,
  );
  sandbox.renderLinks();
  return list.innerHTML as string;
}

const simple = { slug: "campanha-q2", target_url: "https://exemplo.com/campanha-q2", redirect_type: "302", clicks_total: 12 };
const abLink = { slug: "ab", target_url: "https://exemplo.com/a", ab_target_url: "https://exemplo.com/b", ab_enabled: 1, ab_weight_b: 50, ab_clicks_a: 210, ab_clicks_b: 221 };

describe("Gate 9.5: destination owns its line and its own copy action", () => {
  it("renders the URL and the copy action as two distinct blocks, in that order", () => {
    const markup = render([simple]);
    const url = markup.indexOf('class="slug-url content-text"');
    const actions = markup.indexOf('aria-label="Copiar destino: URL de destino"');
    expect(url).toBeGreaterThan(-1);
    expect(actions).toBeGreaterThan(url);
    // The copy action belongs to its own block, not to the URL text node.
    expect(markup).toMatch(/class="slug-url content-text"[^>]*>https:\/\/exemplo\.com\/campanha-q2<\/div>/);
    expect(markup).toContain('aria-label="Copiar destino: URL de destino"');
    expect(markup).toContain('data-copy-kind="destination"');
  });

  it("stacks the destination at every viewport so the URL always keeps the full width", () => {
    expect(rule(/\.link-content \{[^}]*\}/)).toBe(".link-content { display: block; min-width: 0; }");
    expect(css).toContain(".link-content > .content-actions { margin-top: 4px; }");
    // No viewport-dependent switch back to an inline row that would squeeze the URL.
    expect(css).not.toMatch(/\.link-content \{[^}]*display:\s*flex/);
    expect(css).not.toMatch(/@media[^{]*\{[^}]*\.link-content \{/);
  });

  it("keeps the destination control at or above the 24px target size on desktop", () => {
    const desktop = rule(/@media \(min-width: 901px\) \{[\s\S]*?\.content-toggle, \.content-copy \{[^}]*\}\s*\}/);
    const minHeight = Number(desktop.match(/min-height:\s*(\d+)px/)![1]);
    expect(minHeight).toBeGreaterThanOrEqual(24);
    // ... and comfortably larger on touch viewports.
    expect(rule(/\.content-toggle, \.content-copy \{[^}]*\}/)).toContain("min-height: 44px;");
  });
});

describe("Gate 9.5: the four levels keep distinct spacing", () => {
  it("gives every level its own separation instead of one uniform gap", () => {
    expect(rule(/\.card-destination \{[^}]*\}/)).toContain("margin-top: 2px;");
    expect(rule(/\.link-states \{[^}]*\}/)).toContain("margin-top: 4px;");
    expect(rule(/\.metrics \{ gap: 6px 10px;[^}]*\}/)).toContain("margin-top: 6px;");
    expect(rule(/\.card \.card-details \{[^}]*\}/)).toContain("margin: 7px 0 0;");
    // The metadata sits further from the level above than the base card gap, so it reads as
    // tertiary information rather than as a continuation of the feature row.
    const cardGap = Number(rule(/\.card \{[^}]*\}/).match(/gap:\s*(\d+)px/)![1]);
    const metricsGap = Number(rule(/\.metrics \{ gap: 6px 10px;[^}]*\}/).match(/margin-top:\s*(\d+)px/)![1]);
    expect(cardGap + metricsGap).toBeGreaterThanOrEqual(13);
  });

  it("wraps feature badges with a wider column gap and never touches the metadata row", () => {
    const states = rule(/\.link-states \{[^}]*\}/);
    expect(states).toContain("display: flex;");
    expect(states).toContain("flex-wrap: wrap;");
    expect(states).toContain("gap: 6px 8px;");
    expect(states).toContain("margin-top: 4px;");
    expect(rule(/\.feature-badge \{[^}]*\}/)).toContain("max-width: 100%;");
  });

  it("keeps the metadata contract from Gate 9.4 intact", () => {
    expect(css).toMatch(/\.metrics \.metric \+ \.metric::before \{ content: "•";/);
    expect(css).toMatch(/@media \(max-width: 640px\) \{\s*\.metrics \.metric \+ \.metric::before \{ content: none; \}\s*\}/);
    const markup = render([{ ...simple, created_at: "2026-10-01" }]);
    expect(markup).toContain('<span class="metric">Cliques');
    expect(markup).toContain('<span class="metric">Criado:');
    expect(markup).toContain('<span class="metric">Redirecionamento');
    expect(markup).not.toContain("•");
  });
});

describe("Gate 9.5: the A/B summary reads as one control with one chevron", () => {
  it("keeps the native disclosure element and its short label", () => {
    const markup = render([abLink]);
    expect(markup).toMatch(/<details class="card-details">/);
    expect(markup).toContain("<summary>Ver detalhes</summary>");
    expect(markup).not.toMatch(/<details class="card-details"[^>]*open/);
    // The disclosure stays native: no scripted open/close state on the summary.
    expect(admin).not.toMatch(/card-details[\s\S]{0,120}aria-expanded/);
    expect(markup).not.toMatch(/<summary[^>]*tabindex/);
  });

  it("draws one chevron: the native marker is removed and no second indicator is added", () => {
    // The shared accordion rule trees `details` (the actions menu excluded) already kills the
    // UA marker, which is what would otherwise show up next to the custom chevron.
    const baseSummary = rule(/details:not\(\.more-actions-dropdown\) summary \{[^}]*\}/);
    expect(baseSummary).toContain("list-style: none !important;");
    expect(css).toContain("details:not(.more-actions-dropdown) summary::-webkit-details-marker {");
    expect(css).toMatch(/summary::-webkit-details-marker \{\s*display: none !important;/);
    // Exactly one glyph: an ::after, never a ::before, and nothing inside the summary markup.
    expect(css).toMatch(/\.card \.card-details > summary::after \{/);
    expect(css).not.toMatch(/\.card-details > summary::before/);
    expect(css).not.toMatch(/\.card-details > summary \{[^}]*background-image/);
  });

  it("overrides the shared accordion chevron instead of stacking two of them", () => {
    // The scoped selector must outrank `details:not(.more-actions-dropdown) summary::after`,
    // otherwise the card would silently inherit the uncentred version.
    const scoped = ".card .card-details > summary::after";
    const classNameCount = (selector: string) => (selector.match(/\./g) || []).length;
    expect(classNameCount(scoped)).toBeGreaterThan(classNameCount("details:not(.more-actions-dropdown) summary::after"));
    expect(rule(/\.card \.card-details > summary::after \{[^}]*\}/)).toContain("transform: translateY(-2px) rotate(45deg);");
  });

  it("turns the same glyph 180 degrees when the details opens", () => {
    const open = rule(/\.card \.card-details\[open\] > summary::after \{[^}]*\}/);
    expect(open).toContain("rotate(-135deg)");
    // The closed and open states are the same 7px box, so the rotation is about one centre.
    expect(rule(/\.card \.card-details > summary::after \{[^}]*\}/)).toContain("width: 7px;");
    expect(open).toContain("translateY(2px)");
  });

  it("gives the summary a real target, a focus ring and a pointer cursor", () => {
    const summary = rule(/\.card \.card-details > summary \{[^}]*\}/);
    expect(summary).toContain("display: inline-flex;");
    expect(summary).toContain("align-items: center;");
    expect(summary).toContain("gap: 8px;");
    expect(summary).toContain("min-height: 24px;");
    expect(rule(/details:not\(\.more-actions-dropdown\) summary \{[^}]*\}/)).toContain("cursor: pointer;");
    expect(css).toContain("html :is(button, summary, a, input, select, textarea):focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }");
    // Hover is a colour change only: no transform, no shadow, nothing that shifts layout.
    expect(rule(/\.card \.card-details > summary:hover \{[^}]*\}/)).toBe(".card .card-details > summary:hover { color: var(--link-hover); }");
  });

  it("keeps the expanded content compact and orphan-free", () => {
    const markup = render([abLink]);
    expect(markup).toContain('class="variant-content"');
    expect(markup).toContain("Cliques A <strong>210</strong>");
    expect(markup).toContain("Cliques B <strong>221</strong>");
    expect(markup).toContain("Distribuição observada");
    // One fact per row: the breakdown needs no separator, so it can never lead a line with one.
    expect(rule(/\.card-details-metrics \{[^}]*\}/)).toBe(".card-details-metrics { display: grid; gap: 4px; margin-top: 10px; }");
    expect(css).not.toMatch(/\.card-details-metrics \.metric \+ \.metric::before/);
    expect(rule(/\.card-details \.variant-content \{[^}]*\}/)).toContain("margin-top: 10px;");
  });
});

describe("Gate 9.5: layout contracts that must not regress", () => {
  it("stacks the destination on touch viewports and keeps the four levels in order", () => {
    const markup = render([{ ...simple, group_id: 1 }]);
    const order = ["card-top", "card-destination", "link-states", "metrics"].map((name) => markup.indexOf(`class="${name}"`));
    expect(order.every((index) => index > -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // 375px is the narrowest supported width: the URL line and the action line are separate,
    // and neither the badges nor the metadata can force a horizontal scrollbar.
    expect(css).toMatch(/\.card \{[^}]*min-width: 0;/);
    expect(css).toContain(".content-text { overflow-wrap: anywhere; }");
    expect(css).not.toMatch(/overflow-x:\s*(?:scroll|auto)/);
    expect(css).toContain(".card-destination { order: 1; }");
  });

  it("still ships no sticky editor scaffolding", () => {
    expect(css).not.toMatch(/position:\s*sticky/);
    expect(css).not.toMatch(/@media[^{]*min-width:\s*1024px/);
    expect(css).not.toMatch(/max-height:\s*calc\(100vh - 48px\)/);
    expect(admin).not.toMatch(/ResizeObserver/);
  });
});

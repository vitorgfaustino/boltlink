/* Copyright (c) 2026 Vitor Faustino — AGPL-3.0 */
// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Gate 9.3 dark-theme contracts.
 *
 * These protect the *behaviour* of the dark palette rather than its exact cosmetics: no glow
 * tokens, a flat decorative background with a bounded budget, a surface hierarchy that carries
 * the depth instead of shadows, and — most importantly — zero leakage into Light Mode.
 *
 * The desktop sticky create/edit column is deliberately NOT part of the Admin: the form column
 * keeps the normal document flow, so the matching assertions here guard against orphan sticky
 * scaffolding creeping back in.
 */
const css = readFileSync("public/admin.css", "utf8");
const block = (pattern: RegExp) => css.match(pattern)![1];
const dark = block(/:root,[\s\S]*?\{([\s\S]*?)\}/);
const light = block(/\[data-theme="light"\] \{([\s\S]*?)\}/);
const tokens = (source: string) =>
  Object.fromEntries([...source.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2]]));
const darkTokens = tokens(dark);
const lightTokens = tokens(light);

const rgb = (color: string) => {
  if (color.startsWith("#")) return [1, 3, 5].map((index) => parseInt(color.slice(index, index + 2), 16));
  return color.match(/[\d.]+/g)!.map(Number);
};
const composite = (color: number[], bg: number[]) =>
  color.length === 3 ? color : bg.map((value, index) => color[index] * color[3] + value * (1 - color[3]));
const luminance = (color: number[]) =>
  color
    .map((value) => value / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
    .reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0);
const alpha = (color: string) => {
  const parts = color.match(/[\d.]+/g)!.map(Number);
  return parts.length === 4 ? parts[3] : 1;
};

describe("Gate 9.3: dark theme is neutral-first, not glow-led", () => {
  it("defines no glow token and no glowed heading", () => {
    expect(Object.keys(darkTokens)).not.toContain("accent-glow");
    expect(Object.keys(darkTokens)).not.toContain("shadow-glow");
    expect(darkTokens["heading-glow"]).toBe("none");
    // A zero-offset, non-zero-blur shadow is a halo. Dark keeps only directional shadows.
    for (const [name, value] of Object.entries(darkTokens)) {
      expect(value, `--${name} looks like a glow`).not.toMatch(/^\s*(?:inset\s+)?0\s+0\s+[1-9]\d*px/);
    }
  });

  it("keeps the decorative background flat and inside a quiet alpha budget", () => {
    // The body paints radial meshes over a three-stop gradient; equal stops mean the gradient
    // contributes no vignette of its own.
    expect(darkTokens["bg-start"]).toBe(darkTokens["bg"]);
    expect(darkTokens["bg-end"]).toBe(darkTokens["bg"]);
    expect(css).toMatch(/background-image:\s*radial-gradient\(circle at top, var\(--bg-mesh-1\)/);
    for (const name of ["bg-mesh-1", "bg-mesh-2"]) {
      expect(alpha(darkTokens[name]), `--${name} alpha`).toBeLessThanOrEqual(0.05);
      expect(alpha(lightTokens[name]), `light --${name} alpha`).toBeLessThanOrEqual(0.05);
    }
    expect(alpha(darkTokens["selection-bg"])).toBeLessThanOrEqual(0.3);
    expect(alpha(darkTokens["accent-soft"])).toBeLessThanOrEqual(0.15);
    expect(alpha(darkTokens["overlay"])).toBeGreaterThanOrEqual(0.6);
  });

  it("builds depth from a monotonic surface ramp instead of blue fills", () => {
    const page = luminance(rgb(darkTokens["bg"]));
    const panel = luminance(composite(rgb(darkTokens["panel-bg"]), rgb(darkTokens["bg"])));
    const card = luminance(composite(rgb(darkTokens["card-bg"]), composite(rgb(darkTokens["panel-bg"]), rgb(darkTokens["bg"]))));
    // Page is the darkest step, the panel lifts off it and the card lifts off the panel.
    expect(page).toBeLessThan(panel);
    expect(panel).toBeLessThan(card);
    // The lift is a surface step, not a contrast jump: a large ratio here would read as a
    // bright block rather than a sober secondary surface.
    expect(card / page).toBeLessThan(3);
    // Panels and cards are solid surfaces, so they do not inherit the decorative background.
    expect(darkTokens["panel-bg"]).toMatch(/^#[0-9a-f]{6}$/i);
    expect(darkTokens["card-bg"]).toMatch(/^#[0-9a-f]{6}$/i);
    expect(darkTokens["raised-bg"]).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("keeps the accent for actions, selection and focus instead of large blue surfaces", () => {
    // Blue stays the identity accent.
    expect(darkTokens["accent"]).toBe("#00A1F5");
    expect(darkTokens["accent-hover"]).toBe("#008cd6");
    // ... but only as an indicator: the chip/link inks are desaturated away from neon cyan.
    for (const name of ["badge-text", "link-text", "link-hover"]) {
      const [r, g, b] = rgb(darkTokens[name]);
      expect(b - r, `--${name} is still a neon cyan`).toBeLessThan(0x60);
      expect(g, `--${name} is still a bright cyan`).toBeLessThan(0xd0);
    }
    expect(alpha(darkTokens["badge-bg"])).toBeLessThanOrEqual(0.1);
    expect(alpha(darkTokens["accent-bg"])).toBeLessThanOrEqual(0.1);
  });
});

describe("Gate 9.3: light mode is not touched by the dark refinement", () => {
  it("keeps light surfaces light and dark ink dark, and never reuses a dark surface", () => {
    // Contract instead of frozen hexes: the two themes keep opposite polarity, and no Dark
    // surface value may be adopted as a Light surface (which is how a dark regression leaks).
    for (const name of ["bg", "panel-bg", "card-bg", "raised-bg"]) {
      expect(luminance(rgb(lightTokens[name])), `light --${name} must stay a light surface`).toBeGreaterThan(0.6);
    }
    for (const name of ["text", "heading", "text-secondary"]) {
      expect(luminance(rgb(lightTokens[name])), `light --${name} must stay dark ink`).toBeLessThan(0.15);
    }
    const darkSurfaces = ["bg", "panel-bg", "card-bg", "raised-bg", "surface-strong"].map((name) => darkTokens[name]);
    for (const name of ["bg", "panel-bg", "card-bg", "raised-bg", "surface-strong"]) {
      expect(darkSurfaces, `light --${name} reused a dark surface`).not.toContain(lightTokens[name]);
    }
  });

  it("keeps the light background ramp and glow-free heading exactly as the light theme defines them", () => {
    expect(lightTokens["bg"]).toBe("#f3f5f8");
    expect(lightTokens["bg-start"]).toBe("#f3f5f8");
    expect(lightTokens["bg-end"]).toBe("#eef2f7");
    expect(lightTokens["heading-glow"]).toBe("none");
    expect(Object.keys(lightTokens)).not.toContain("accent-glow");
    expect(Object.keys(lightTokens)).not.toContain("shadow-glow");
  });

  it("keeps focus and control boundaries intact so the sober palette stays accessible", () => {
    expect(css).toContain("html :is(button, summary, a, input, select, textarea):focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }");
    expect(css).toContain("border: 1px solid var(--control-line)");
    expect(css).toMatch(/input:focus, select:focus, textarea:focus \{[^}]*border-color: var\(--accent\);/);
    expect(css).toMatch(/button:focus-visible \{[^}]*box-shadow: 0 0 0 4px var\(--accent-soft\);/);
  });
});

describe("Gate 9.3: the create/edit column keeps the normal flow", () => {
  it("ships no sticky column and no orphan scaffolding for one", () => {
    expect(css).not.toMatch(/position:\s*sticky/);
    expect(css).not.toMatch(/@media[^{]*min-width:\s*1024px/);
    expect(css).not.toMatch(/\.link-form-panel\s*\{[^}]*\}/);
    expect(css).not.toMatch(/max-height:\s*calc\(100vh - 48px\)/);
    // The original, intentional normal-flow decision is still documented in place.
    expect(css).toContain("The first card stays in normal flow on purpose.");
    expect(css).toMatch(/\.layout \{[\s\S]*?align-items: start;/);
  });

  it("keeps the responsive layout contract for the two columns", () => {
    expect(css).toMatch(/\.layout \{[\s\S]*?grid-template-columns: minmax\(340px, 440px\) minmax\(0, 1fr\);/);
    expect(css).toMatch(/@media \(min-width: 768px\) and \(max-width: 900px\) \{\s*\.layout \{/);
    expect(css).toMatch(/@media \(max-width: 900px\) \{[\s\S]*?\.layout \{\s*grid-template-columns: 1fr;/);
  });
});

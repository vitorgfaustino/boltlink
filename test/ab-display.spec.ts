/*
 * Copyright (c) 2026 Vitor Faustino
 * AGPL-3.0 License — https://github.com/vitorgfaustino/boltlink
 *
 * Presentation coverage for the admin A/B card: historical counters must
 * never be rendered as if they belonged to the current/future configuration.
 */

// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type AbDisplay = {
	isActive: boolean;
	title: string;
	showHistoricalLabel: boolean;
	clicksA: number;
	clicksB: number;
	observed: string;
	allocation: string | null;
	nextTest: { targetUrl: string; allocation: string } | null;
};

type AbDisplayApi = {
	buildAbDisplay: (link: Record<string, unknown>) => AbDisplay | null;
	buildAbFields: (abTesting: boolean, values: Record<string, unknown>) => Record<string, unknown>;
};

function loadApi(): AbDisplayApi {
	const source = readFileSync(resolve(process.cwd(), "public/ab-display.js"), "utf8");
	const sandbox: { window: { BoltLinkAbDisplay?: AbDisplayApi } } = { window: {} };
	vm.createContext(sandbox);
	vm.runInContext(source, sandbox);
	const api = sandbox.window.BoltLinkAbDisplay;
	if (!api) {
		throw new Error("BoltLinkAbDisplay not registered");
	}
	return api;
}

function loadDisplay() {
	return loadApi().buildAbDisplay;
}

describe("A/B admin presentation", () => {
	it("shows allocation for the active split", () => {
		const build = loadDisplay();
		const display = build({
			ab_enabled: 1,
			ab_target_url: "https://example.com/b",
			ab_weight_b: 50,
			ab_clicks_a: 2,
			ab_clicks_b: 1,
			ab_started_at: "2026-02-01T00:00:00.000Z",
		});

		expect(display).toMatchObject({
			isActive: true,
			title: "Ativo",
			showHistoricalLabel: false,
			clicksA: 2,
			clicksB: 1,
			observed: "66.7% / 33.3%",
			allocation: "50% / 50%",
			nextTest: null,
		});
	});

	it("separates historical counters from the current configuration after disable", () => {
		const build = loadDisplay();
		const display = build({
			ab_enabled: 0,
			ab_target_url: "https://example.com/b",
			ab_weight_b: 50,
			ab_clicks_a: 2,
			ab_clicks_b: 1,
			ab_started_at: "2026-02-01T00:00:00.000Z",
		});

		expect(display).toMatchObject({
			isActive: false,
			title: "Encerrado",
			showHistoricalLabel: true,
			clicksA: 2,
			clicksB: 1,
			observed: "66.7% / 33.3%",
			allocation: null,
			nextTest: { targetUrl: "https://example.com/b", allocation: "50% / 50%" },
		});
	});

	it("never presents a changed allocation or a changed Variant B as historical", () => {
		const build = loadDisplay();
		const display = build({
			ab_enabled: 0,
			ab_target_url: "https://example.com/b-changed",
			ab_weight_b: 90,
			ab_clicks_a: 2,
			ab_clicks_b: 1,
			ab_started_at: "2026-02-01T00:00:00.000Z",
		});

		expect(display).toMatchObject({
			title: "Encerrado",
			clicksA: 2,
			clicksB: 1,
			observed: "66.7% / 33.3%",
			allocation: null,
			nextTest: { targetUrl: "https://example.com/b-changed", allocation: "10% / 90%" },
		});
	});

	it("hides the A/B block when disabled without history", () => {
		const build = loadDisplay();
		const display = build({
			ab_enabled: 0,
			ab_target_url: null,
			ab_weight_b: 50,
			ab_clicks_a: 0,
			ab_clicks_b: 0,
			ab_started_at: null,
		});

		expect(display).toBeNull();
	});

	it("shows the new allocation only after a new split is active", () => {
		const build = loadDisplay();
		const display = build({
			ab_enabled: 1,
			ab_target_url: "https://example.com/b-changed",
			ab_weight_b: 90,
			ab_clicks_a: 0,
			ab_clicks_b: 0,
			ab_started_at: "2026-03-01T00:00:00.000Z",
		});

		expect(display).toMatchObject({
			isActive: true,
			allocation: "10% / 90%",
			nextTest: null,
			clicksA: 0,
			clicksB: 0,
		});
	});

	it("omits A/B fields entirely when the schema does not support A/B", () => {
		const { buildAbFields } = loadApi();

		const fields = buildAbFields(false, {
			abEnabled: true,
			abTargetUrl: "https://example.com/b",
			abWeightB: 90,
		});

		expect(fields).toEqual({});
		expect(Object.keys(fields)).toHaveLength(0);
	});

	it("includes the approved A/B fields when the schema supports A/B", () => {
		const { buildAbFields } = loadApi();

		const fields = buildAbFields(true, {
			abEnabled: true,
			abTargetUrl: "https://example.com/b",
			abWeightB: 25,
		});

		expect(fields).toEqual({
			abEnabled: true,
			abTargetUrl: "https://example.com/b",
			abWeightB: 25,
		});
	});
});

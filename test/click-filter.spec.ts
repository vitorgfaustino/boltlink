/**
 * Phase 1 Tests: Click Filter
 * BoltLink v2.0.0
 * AGPL-3.0 License — https://github.com/vitorgfaustino/boltlink
 */

import { describe, expect, it } from "vitest";
import { isCountableClick, identifyBot } from "../src/click-filter";

describe("Phase 1: Click Filter", () => {
	// --- Test case 1: GET with Chrome UA → should count
	it("counts GET request with Chrome User-Agent as legitimate click", () => {
		const request = new Request("https://example.com/test", {
			method: "GET",
			headers: {
				"user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
			},
		});

		expect(isCountableClick(request)).toBe(true);
	});

	// --- Test case 2: HEAD request → should NOT count
	it("does not count HEAD request", () => {
		const request = new Request("https://example.com/test", {
			method: "HEAD",
			headers: {
				"user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
			},
		});

		expect(isCountableClick(request)).toBe(false);
	});

	// --- Test case 3: OPTIONS request → should NOT count
	it("does not count OPTIONS request", () => {
		const request = new Request("https://example.com/test", {
			method: "OPTIONS",
			headers: {
				"user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
			},
		});

		expect(isCountableClick(request)).toBe(false);
	});

	// --- Test case 4: Purpose: prefetch → should NOT count
	it("does not count request with Purpose: prefetch header", () => {
		const request = new Request("https://example.com/test", {
			method: "GET",
			headers: {
				"user-agent": "Mozilla/5.0",
				"purpose": "prefetch",
			},
		});

		expect(isCountableClick(request)).toBe(false);
	});

	// --- Test case 5: Sec-Purpose: prerender → should NOT count
	it("does not count request with Sec-Purpose: prerender header", () => {
		const request = new Request("https://example.com/test", {
			method: "GET",
			headers: {
				"user-agent": "Mozilla/5.0",
				"sec-purpose": "prerender",
			},
		});

		expect(isCountableClick(request)).toBe(false);
	});

	// --- Test case 6: X-Purpose: prefetch → should NOT count
	it("does not count request with X-Purpose: prefetch header", () => {
		const request = new Request("https://example.com/test", {
			method: "GET",
			headers: {
				"user-agent": "Mozilla/5.0",
				"x-purpose": "prefetch",
			},
		});

		expect(isCountableClick(request)).toBe(false);
	});

	// --- Test case 7: Sec-Fetch-Mode: navigate → should count
	it("counts request with Sec-Fetch-Mode: navigate as legitimate click", () => {
		const request = new Request("https://example.com/test", {
			method: "GET",
			headers: {
				"user-agent": "Mozilla/5.0",
				"sec-fetch-mode": "navigate",
			},
		});

		expect(isCountableClick(request)).toBe(true);
	});

	// --- Test case 8: Empty User-Agent → should NOT count
	it("does not count request with empty User-Agent", () => {
		const request = new Request("https://example.com/test", {
			method: "GET",
			headers: {
				"user-agent": "",
			},
		});

		expect(isCountableClick(request)).toBe(false);
	});

	// --- Test case 9: Missing User-Agent → should NOT count
	it("does not count request with missing User-Agent header", () => {
		const request = new Request("https://example.com/test", {
			method: "GET",
		});

		expect(isCountableClick(request)).toBe(false);
	});

	// --- Test case 10: Googlebot → should NOT count
	it("does not count Googlebot request", () => {
		const request = new Request("https://example.com/test", {
			method: "GET",
			headers: {
				"user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
			},
		});

		expect(isCountableClick(request)).toBe(false);
	});

	// --- Test case 11: Facebook external hit bot → should NOT count
	it("does not count facebookexternalhit bot", () => {
		const request = new Request("https://example.com/test", {
			method: "GET",
			headers: {
				"user-agent": "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
			},
		});

		expect(isCountableClick(request)).toBe(false);
	});

	// --- Test case 12: curl → should NOT count
	it("does not count curl request", () => {
		const request = new Request("https://example.com/test", {
			method: "GET",
			headers: {
				"user-agent": "curl/7.68.0",
			},
		});

		expect(isCountableClick(request)).toBe(false);
	});

	// --- Test case 13: UptimeRobot monitor → should NOT count
	it("does not count UptimeRobot monitoring request", () => {
		const request = new Request("https://example.com/test", {
			method: "GET",
			headers: {
				"user-agent": "Mozilla/5.0 (compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)",
			},
		});

		expect(isCountableClick(request)).toBe(false);
	});

	// --- Test case 14: Firefox browser → should count
	it("counts Firefox browser request as legitimate click", () => {
		const request = new Request("https://example.com/test", {
			method: "GET",
			headers: {
				"user-agent": "Mozilla/5.0 (X11; Linux x86_64; rv:89.0) Gecko/20100101 Firefox/89.0",
			},
		});

		expect(isCountableClick(request)).toBe(true);
	});

	// --- Test case 15: Safari browser → should count
	it("counts Safari browser request as legitimate click", () => {
		const request = new Request("https://example.com/test", {
			method: "GET",
			headers: {
				"user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Mobile/15E148 Safari/604.1",
			},
		});

		expect(isCountableClick(request)).toBe(true);
	});

	// --- Test case 16: POST request → should NOT count
	it("does not count POST request", () => {
		const request = new Request("https://example.com/test", {
			method: "POST",
			headers: {
				"user-agent": "Mozilla/5.0",
			},
		});

		expect(isCountableClick(request)).toBe(false);
	});

	// --- Test case 17: WhatsApp bot → should NOT count
	it("does not count WhatsApp bot request", () => {
		const request = new Request("https://example.com/test", {
			method: "GET",
			headers: {
				"user-agent": "WhatsApp/2.20.1 A",
			},
		});

		expect(isCountableClick(request)).toBe(false);
	});

	// --- Test case 18: Telegram bot → should NOT count
	it("does not count Telegram bot request", () => {
		const request = new Request("https://example.com/test", {
			method: "GET",
			headers: {
				"user-agent": "TelegramBot (like TwitterBot)",
			},
		});

		expect(isCountableClick(request)).toBe(false);
	});

	// --- Test case 19: HTTP client library (python-requests) → should NOT count
	it("does not count python-requests library", () => {
		const request = new Request("https://example.com/test", {
			method: "GET",
			headers: {
				"user-agent": "python-requests/2.25.1",
			},
		});

		expect(isCountableClick(request)).toBe(false);
	});

	// --- Test case 20: Redirect always happens regardless of countability
	it("recognizes multiple bot patterns correctly", () => {
		const bots = [
			"AdsBot-Google",
			"APIs-Google",
			"MediaPartners-Google",
			"TwitterBot/1.0",
			"LinkedInBot/1.0",
			"Pingdom.com_bot_version_1.4_(http://www.pingdom.com/)",
			"ahrefs",
			"Semrushbot",
			"wget/1.20.3",
		];

		bots.forEach((botUA) => {
			const request = new Request("https://example.com/test", {
				method: "GET",
				headers: { "user-agent": botUA },
			});
			expect(isCountableClick(request)).toBe(false);
		});
	});

	// --- Utility: identifyBot function
	it("identifies bot type from User-Agent string", () => {
		expect(identifyBot("Googlebot/2.1")).toBe("Googlebot");
		expect(identifyBot("Mozilla/5.0 (compatible; facebookexternalhit/1.1)")).toContain("facebook");
		expect(identifyBot("curl/7.68.0")).toBe("curl");
		expect(identifyBot("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/91.0")).toBeNull();
	});
});

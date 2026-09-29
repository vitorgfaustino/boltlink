/*
 * Copyright (c) 2026 Vitor Faustino
 * AGPL-3.0 License — https://github.com/vitorgfaustino/boltlink
 *
 * Phase 5, Gate 5.4: QR dialog admin coverage.
 *
 * The dialog is DOM glue inside admin.js, so its properties are verified as source
 * scans over the shipped files, the same way the other admin gates do it: the exact
 * places the QR surface is wired, the object URL lifecycle, the request token that
 * drops a late answer for a link the dialog no longer shows, and the fact that
 * nothing derived from a link reaches an HTML sink. The CSS parser proves the
 * 390px layout constraints from the shipped stylesheet.
 *
 * The two orderings a scan cannot reach — a flag write that fails, and one that
 * finishes after the dialog moved on — are driven for real: the shipped admin.js runs
 * in a VM context over a minimal DOM, and `fetch` is programmable, so a completion can
 * be delivered late on purpose.
 */

// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

function readPublic(file: string) {
	return readFileSync(resolve(process.cwd(), `public/${file}`), "utf8");
}

const adminJs = readPublic("admin.js");
const adminHtml = readPublic("admin.html");
const adminCss = readPublic("admin.css");

function functionBody(source: string, name: string) {
	const start = source.indexOf(`function ${name}(`);
	expect(start, `missing function ${name}`).toBeGreaterThan(-1);
	const next = source.indexOf("\nfunction ", start + 1);
	return source.slice(start, next === -1 ? source.length : next);
}

/** The async variant used by the dialog handlers. */
function asyncFunctionBody(source: string, name: string) {
	const start = source.indexOf(`async function ${name}(`);
	expect(start, `missing async function ${name}`).toBeGreaterThan(-1);
	const next = source.indexOf("\nfunction ", start + 1);
	const nextAsync = source.indexOf("\nasync function ", start + 1);
	const end = [next, nextAsync].filter((index) => index > start).sort((a, b) => a - b)[0] ?? source.length;
	return source.slice(start, end);
}

function cssRules(source: string) {
	const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
	return Array.from(withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)).map((match) => ({
		selector: match[1].trim(),
		body: match[2],
	}));
}

function rulesMatching(selectorPattern: RegExp) {
	return cssRules(adminCss).filter((rule) => selectorPattern.test(rule.selector));
}

/** Every function the QR surface owns, joined for whole-feature scans. */
const QR_FUNCTIONS = [
	"rasterizeQrSvg",
	"qrRequestIsCurrent",
	"releaseQrObjectUrl",
	"resetQrDialogSurface",
	"qrDialogFocusables",
	"keepQrDialogFocus",
	"onQrDialogKeydown",
	"openQrDialog",
	"closeQrDialog",
	"downloadQrCode",
	"copyQrLink",
].map((name) => functionBody(adminJs, name))
	.concat(asyncFunctionBody(adminJs, "openQrDialog"))
	.join("\n");

function qrDialogMarkup() {
	const start = adminHtml.indexOf('id="qr-dialog-backdrop"');
	expect(start).toBeGreaterThan(-1);
	const end = adminHtml.indexOf("</div>", adminHtml.indexOf('id="qr-status"'));
	return adminHtml.slice(start, end);
}

describe("Phase 5, Gate 5.4: QR dialog markup", () => {
	it("mounts a modal dialog with the preview, the URL and both actions", () => {
		const markup = qrDialogMarkup();
		expect(markup).toContain('class="qr-dialog"');
		expect(markup).toContain('role="dialog"');
		expect(markup).toContain('aria-modal="true"');
		expect(markup).toContain('aria-labelledby="qr-dialog-title"');
		expect(markup).toContain('id="qr-dialog-title"');
		expect(markup).toContain('id="qr-image"');
		expect(markup).toContain('id="qr-url"');
		expect(markup).toContain('id="qr-download-button"');
		expect(markup).toContain('id="qr-copy-button"');
		expect(markup).toContain('id="qr-status"');
		expect(markup).toContain('aria-label="Fechar diálogo de QR Code"');
	});

	it("ships the dialog closed and the download disabled until a PNG exists", () => {
		const markup = adminHtml.slice(
			adminHtml.indexOf('class="qr-dialog"'),
			adminHtml.indexOf('id="qr-status"'),
		);
		expect(markup).toContain('aria-hidden="true"');
		expect(markup).toContain("inert");
		expect(markup).toContain('id="qr-download-button" disabled');
	});

	it("keeps the card action in the contextual menu, not on every row", () => {
		const renderLinks = functionBody(adminJs, "renderLinks");
		expect(renderLinks).toContain('cardActionMarkup("qrcode", "secondary", "qrcode", "QR Code", link.slug)');
		expect(renderLinks).toContain('more-actions-dropdown');
		// The operational badge stays tied to the persisted flag.
		expect(renderLinks).toContain("link.has_qrcode");
	});
});

describe("Phase 5, Gate 5.4: QR dialog safe DOM", () => {
	it("fills slug, URL, alt text and image through text and attribute assignment only", () => {
		const open = asyncFunctionBody(adminJs, "openQrDialog");
		expect(open).toContain("qrDialogSlug.textContent =");
		expect(open).toContain("qrUrl.textContent = buildShortLink(slug)");
		expect(open).toContain("qrImage.alt =");
		expect(open).toContain("qrImage.src = state.qrPreviewSrc");
	});

	it("uses no HTML sink anywhere in the QR functions", () => {
		expect(QR_FUNCTIONS).not.toContain("innerHTML");
		expect(QR_FUNCTIONS).not.toContain("insertAdjacentHTML");
		expect(QR_FUNCTIONS).not.toContain("document.write");
	});

	it("encodes the fetch path with the slug, matching the card action vocabulary", () => {
		const open = asyncFunctionBody(adminJs, "openQrDialog");
		expect(open).toContain("fetch(`/api/links/${encodeURIComponent(slug)}/qrcode`");
	});
});

describe("Phase 5, Gate 5.4: QR object URL lifecycle", () => {
	it("keeps exactly one PNG object URL alive, revoked on close and on switch", () => {
		const release = functionBody(adminJs, "releaseQrObjectUrl");
		expect(release).toContain("if (state.qrObjectUrl)");
		expect(release).toContain("URL.revokeObjectURL(state.qrObjectUrl)");
		expect(release).toContain("state.qrPreviewSrc = null");
		expect(release).toContain('qrImage.removeAttribute("src")');

		const close = functionBody(adminJs, "closeQrDialog");
		expect(close).toContain("resetQrDialogSurface()");

		const open = asyncFunctionBody(adminJs, "openQrDialog");
		// The previous URL is released before a new one replaces it, and only after the
		// answer is known to be current.
		expect(open).toContain("releaseQrObjectUrl();");
		expect(open).toContain("state.qrObjectUrl = URL.createObjectURL(png.blob)");
	});

	it("feeds the decoder and the preview through data URLs, never object URLs", () => {
		// WebKit-based webviews refuse `blob:` URLs as image sources, so the SVG and the
		// preview PNG both ride data URLs; the object URL exists only for the download.
		const rasterize = functionBody(adminJs, "rasterizeQrSvg");
		expect(rasterize).toContain("`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`");
		expect(rasterize).toContain('canvas.toDataURL("image/png")');
		expect(rasterize).not.toContain("createObjectURL");

		const open = asyncFunctionBody(adminJs, "openQrDialog");
		expect(open).toContain("state.qrPreviewSrc = png.previewSrc");
	});

	it("never hands the anchor a URL that was revoked or a foreign source", () => {
		const download = asyncFunctionBody(adminJs, "downloadQrCode");
		expect(download).toContain("if (!state.qrDialogOpen || !state.qrSlug || !state.qrObjectUrl)");
		expect(download).toContain("anchor.href = state.qrObjectUrl");
	});
});

describe("Phase 5, Gate 5.4: QR request token", () => {
	it("moves on every open and every close", () => {
		const open = asyncFunctionBody(adminJs, "openQrDialog");
		expect(open).toContain("state.qrRequestToken += 1");
		const close = functionBody(adminJs, "closeQrDialog");
		expect(close).toContain("state.qrRequestToken += 1");
	});

	it("honors an answer only while the dialog still shows the link that asked", () => {
		const guard = functionBody(adminJs, "qrRequestIsCurrent");
		expect(guard).toContain("state.qrDialogOpen && state.qrRequestToken === token");

		const open = asyncFunctionBody(adminJs, "openQrDialog");
		// One checkpoint after each await: fetch, body, rasterization, and the catch.
		const checkpoints = open.match(/if \(!qrRequestIsCurrent\(token\)\) \{/g) ?? [];
		expect(checkpoints.length).toBe(4);
	});

	it("clears the surface before awaiting, so an error never shows a stale QR", () => {
		const open = asyncFunctionBody(adminJs, "openQrDialog");
		const releaseIndex = open.indexOf("releaseQrObjectUrl();");
		const fetchIndex = open.indexOf("await fetch(");
		expect(releaseIndex).toBeGreaterThan(-1);
		expect(fetchIndex).toBeGreaterThan(releaseIndex);
		expect(open).toContain('setStatus(qrStatus, "Não foi possível gerar o QR Code deste link. Verifique a conexão e tente de novo.", "error")');
	});
});

describe("Phase 5, Gate 5.4: QR download and flag semantics", () => {
	it("downloads a predictably named PNG of the short link", () => {
		const download = asyncFunctionBody(adminJs, "downloadQrCode");
		expect(download).toContain('anchor.download = `boltlink-${slug}-qr.png`');
		expect(download).not.toContain("target_url");
	});

	it("marks has_qrcode only when the operator actually obtains the QR", () => {
		const download = asyncFunctionBody(adminJs, "downloadQrCode");
		expect(download).toContain("await markQrCodeGenerated(slug)");

		const open = asyncFunctionBody(adminJs, "openQrDialog");
		expect(open).not.toContain("markQrCodeGenerated");

		const mark = asyncFunctionBody(adminJs, "markQrCodeGenerated");
		expect(mark).toContain("/qrcode`, { method: \"POST\" }");
	});

	it("enables the download only after the PNG is ready", () => {
		const open = asyncFunctionBody(adminJs, "openQrDialog");
		const objectUrlIndex = open.indexOf("state.qrObjectUrl = URL.createObjectURL(png.blob)");
		const enableIndex = open.indexOf("qrDownloadButton.disabled = false");
		expect(objectUrlIndex).toBeGreaterThan(-1);
		expect(enableIndex).toBeGreaterThan(objectUrlIndex);

		const reset = functionBody(adminJs, "resetQrDialogSurface");
		expect(reset).toContain("qrDownloadButton.disabled = true");
	});
});

describe("Phase 5, Gate 5.4: QR dialog wiring", () => {
	it("opens the dialog from the contextual card action", () => {
		const handlerStart = adminJs.indexOf('if (action === "qrcode") {');
		expect(handlerStart).toBeGreaterThan(-1);
		const handler = adminJs.slice(handlerStart, handlerStart + 200);
		expect(handler).toContain("openQrDialog(link)");
	});

	it("closes the `…` menu that hosts the action", () => {
		const open = asyncFunctionBody(adminJs, "openQrDialog");
		expect(open).toContain('querySelectorAll("details.more-actions-dropdown[open]")');
	});

	it("wires close, backdrop, download and copy to their handlers", () => {
		expect(adminJs).toContain("qrDialogCloseButton.addEventListener(\"click\", () => {\n  closeQrDialog();\n});");
		expect(adminJs).toContain("qrDialogBackdrop.addEventListener(\"click\", () => {\n  closeQrDialog();\n});");
		expect(adminJs).toContain("qrDownloadButton.addEventListener(\"click\", () => {\n  downloadQrCode();\n});");
		expect(adminJs).toContain("qrCopyButton.addEventListener(\"click\", () => {\n  copyQrLink();\n});");
	});

	it("traps focus and closes on Escape while the dialog is open", () => {
		const keydown = functionBody(adminJs, "onQrDialogKeydown");
		expect(keydown).toContain('event.key === "Escape"');
		expect(keydown).toContain("closeQrDialog()");

		const trap = functionBody(adminJs, "keepQrDialogFocus");
		expect(trap).toContain('event.key !== "Tab"');
		expect(trap).toContain("event.preventDefault()");
	});

	it("returns focus to the opener, then to the same card action, then to search", () => {
		const close = functionBody(adminJs, "closeQrDialog");
		expect(close).toContain("opener.isConnected");
		expect(close).toContain('querySelector(`[data-action="qrcode"][data-slug="${slug}"]`)');
		expect(close).toContain("searchTermInput.focus()");
	});

	it("rasterizes the Worker SVG into a fixed-size PNG", () => {
		const rasterize = functionBody(adminJs, "rasterizeQrSvg");
		expect(rasterize).toContain("canvas.width = QR_PNG_SIZE");
		expect(rasterize).toContain("canvas.height = QR_PNG_SIZE");
		expect(rasterize).toContain('canvas.getContext("2d")');
		expect(rasterize).toContain('context.drawImage(image, 0, 0, QR_PNG_SIZE, QR_PNG_SIZE)');
		expect(rasterize).toContain('"image/png"');
		expect(rasterize).toContain("image.onerror");
		expect(adminJs).toContain("const QR_PNG_SIZE = 512;");
	});
});

describe("Phase 5, Gate 5.4: QR dialog CSS", () => {
	it("constrains the card to the viewport without horizontal overflow", () => {
		const dialog = rulesMatching(/^\.qr-dialog$/);
		expect(dialog).toHaveLength(1);
		expect(dialog[0].body).toContain("width: min(400px, calc(100vw - 32px))");
		expect(dialog[0].body).toContain("max-height: calc(100vh - 32px)");
		expect(dialog[0].body).toContain("overflow-y: auto");
	});

	it("wraps the encoded URL instead of letting it stretch the card", () => {
		const url = rulesMatching(/^\.qr-url$/);
		expect(url).toHaveLength(1);
		expect(url[0].body).toContain("overflow-wrap: anywhere");
	});

	it("keeps the preview square and bounded", () => {
		const image = rulesMatching(/^\.qr-preview img$/);
		expect(image).toHaveLength(1);
		expect(image[0].body).toContain("height: auto");
		expect(image[0].body).toContain("max-width: 264px");
	});

	it("reuses the drawer modal vocabulary: backdrop, is-open and inert-safe hiding", () => {
		expect(rulesMatching(/^\.qr-dialog-backdrop$/)).toHaveLength(1);
		expect(rulesMatching(/^\.qr-dialog-backdrop\.is-open$/)).toHaveLength(1);
		expect(rulesMatching(/^\.qr-dialog\.is-open$/)).toHaveLength(1);
		expect(rulesMatching(/^\.qr-dialog \[hidden\]$/)).toHaveLength(1);
	});

	it("keeps the download action inside the shared touch-target scale", () => {
		const buttons = cssRules(adminCss).filter((rule) => rule.selector === "button");
		expect(buttons).toHaveLength(1);
		expect(buttons[0].body).toContain("min-height: 46px");
	});
});

/*
 * The download flow is driven through its real entry points over a minimal DOM, with a
 * programmable `fetch`. Two of its facts are timing facts — the flag write can fail, and
 * it can answer after the dialog already shows another link — so a source scan cannot
 * prove them: the panel has to run.
 */

type Deferred = { promise: Promise<unknown>; resolve: (value: unknown) => void; reject: (reason?: unknown) => void };

function deferred(): Deferred {
	let resolve!: (value: unknown) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<unknown>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** What the dialog currently shows: the surface a late completion must not touch. */
type QrSurface = {
	status: string;
	statusClass: string;
	slug: string;
	url: string;
	imageSrc: string;
	imageAlt: string;
	downloadDisabled: boolean;
};

type QrHarness = {
	/** Runs an expression in the panel's own realm and returns its value. */
	run: <T>(code: string) => T;
	open: (slug: string) => Promise<void>;
	download: () => Promise<void>;
	close: () => void;
	surface: () => QrSurface;
	downloads: Array<{ href: string; download: string }>;
	listRequests: string[];
	pendingFlagWrites: (slug: string) => number;
	confirmFlagWrite: (slug: string) => void;
	refuseFlagWrite: (slug: string) => void;
	rejectFlagWrite: (slug: string) => void;
};

/**
 * Loads the shipped admin.js the way the admin page does — helper modules first, then the
 * panel — over a DOM stub that answers every member the panel touches. Requests are
 * programmable: the QR flag write and the list refresh are answered by hand, and every
 * other call (capabilities, groups, version) simply stays in flight, which keeps the
 * panel from rendering anything the tests did not ask for.
 */
function createQrHarness(): QrHarness {
	const objectUrls: string[] = [];
	const downloads: Array<{ href: string; download: string }> = [];
	const listRequests: string[] = [];
	const pendingFlagWrites = new Map<string, Deferred[]>();
	let objectUrlSequence = 0;

	class SandboxUrl extends URL {
		static createObjectURL() {
			objectUrlSequence += 1;
			const url = `blob:boltlink-qr-${objectUrlSequence}`;
			objectUrls.push(url);
			return url;
		}
		static revokeObjectURL(url: string) {
			const index = objectUrls.indexOf(url);
			if (index !== -1) {
				objectUrls.splice(index, 1);
			}
		}
	}

	/**
	 * The panel assigns `onload` before the source, so a synchronous load is the
	 * deterministic equivalent of a decoded image — no timer to race with the assertions.
	 */
	class SandboxImage {
		onload: (() => void) | null = null;
		onerror: (() => void) | null = null;
		private source = "";
		set src(value: string) {
			this.source = value;
			this.onload?.();
		}
		get src() {
			return this.source;
		}
	}

	function canvasStub(): Record<string, unknown> {
		return {
			width: 0,
			height: 0,
			getContext: () => ({ fillStyle: "", fillRect: () => {}, drawImage: () => {} }),
			toDataURL: () => "data:image/png;base64,boltlink-qr",
			toBlob: (callback: (blob: unknown) => void) => callback({ type: "image/png" }),
		};
	}

	function elementStub(tagName: string): Record<string, unknown> {
		const attributes = new Map<string, string>();
		const classes = new Set<string>();
		const element: Record<string, unknown> = {
			tagName: tagName.toUpperCase(),
			id: "",
			value: "",
			checked: false,
			readOnly: false,
			hidden: false,
			disabled: false,
			open: false,
			selectedIndex: -1,
			options: [],
			dataset: {},
			style: {},
			children: [],
			isConnected: true,
			isContentEditable: false,
			textContent: "",
			innerHTML: "",
			className: "",
			classList: {
				add: (name: string) => classes.add(name),
				remove: (name: string) => classes.delete(name),
				contains: (name: string) => classes.has(name),
			},
			setAttribute: (name: string, value: unknown) => attributes.set(name, String(value)),
			getAttribute: (name: string) => (attributes.has(name) ? attributes.get(name) : null),
			hasAttribute: (name: string) => attributes.has(name),
			// Backed by the attribute map so `removeAttribute("src")` really clears it.
			removeAttribute: (name: string) => attributes.delete(name),
			addEventListener: () => {},
			removeEventListener: () => {},
			dispatchEvent: () => true,
			appendChild: () => undefined,
			removeChild: () => undefined,
			replaceChildren: () => undefined,
			insertBefore: () => undefined,
			remove: () => {},
			contains: () => false,
			closest: () => null,
			querySelector: (selector: string) => selectorFor(selector),
			querySelectorAll: () => [],
			matches: () => false,
			focus: () => {},
			blur: () => {},
			click: () => {},
			select: () => {},
			reset: () => {},
			submit: () => {},
			setSelectionRange: () => {},
			scrollIntoView: () => {},
			getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
		};
		Object.defineProperty(element, "src", {
			enumerable: true,
			get: () => attributes.get("src") ?? "",
			set: (value: string) => attributes.set("src", String(value)),
		});
		return element;
	}

	const elements = new Map<string, Record<string, unknown>>();
	function elementFor(id: string) {
		if (!elements.has(id)) {
			const element = elementStub("div");
			element.id = id;
			elements.set(id, element);
		}
		return elements.get(id) as Record<string, unknown>;
	}

	/**
	 * Single-node lookups answer a stable stub instead of `null`: the panel wires
	 * load-time listeners through them, and these tests only drive the QR dialog, so an
	 * element that never exists here never becomes an observable difference.
	 */
	const selectors = new Map<string, Record<string, unknown>>();
	function selectorFor(selector: string) {
		if (!selectors.has(selector)) {
			const element = elementStub("div");
			element.selector = selector;
			selectors.set(selector, element);
		}
		return selectors.get(selector) as Record<string, unknown>;
	}

	const documentStub = {
		activeElement: null,
		body: elementStub("body"),
		documentElement: { clientWidth: 1024, style: {} },
		getElementById: (id: string) => elementFor(id),
		querySelector: (selector: string) => selectorFor(selector),
		querySelectorAll: () => [],
		createElement: (tagName: string) => {
			if (tagName === "canvas") {
				return canvasStub();
			}
			const element = elementStub(tagName);
			if (tagName === "a") {
				// The only observable effect of the download the page can have.
				element.click = () => {
					downloads.push({ href: String(element.href ?? ""), download: String(element.download ?? "") });
				};
			}
			return element;
		},
		addEventListener: () => {},
		removeEventListener: () => {},
		dispatchEvent: () => true,
		execCommand: () => true,
	};

	function slugOfDownloadTarget(target: string) {
		return decodeURIComponent(target.replace(/^.*\/links\//, "").replace(/\/qrcode$/, ""));
	}

	function fetchStub(input: unknown, init?: { method?: string }) {
		const target = String(input);
		const method = String(init?.method ?? "GET").toUpperCase();
		if (method === "GET" && target.endsWith("/qrcode")) {
			return Promise.resolve({ ok: true, status: 200, text: async () => "<svg></svg>" });
		}
		if (method === "POST" && target.endsWith("/qrcode")) {
			const pending = deferred();
			const slug = slugOfDownloadTarget(target);
			const queue = pendingFlagWrites.get(slug) ?? [];
			queue.push(pending);
			pendingFlagWrites.set(slug, queue);
			return pending.promise;
		}
		if (method === "GET" && target.includes("/api/links")) {
			listRequests.push(target);
			return Promise.resolve({ ok: true, status: 200, json: async () => ({ links: [] }) });
		}
		return new Promise(() => {});
	}

	const sandbox: Record<string, unknown> = {
		window: {
			location: { origin: "http://localhost" },
			innerWidth: 1024,
			matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
			addEventListener: () => {},
			removeEventListener: () => {},
		},
		document: documentStub,
		getComputedStyle: () => ({ display: "block", visibility: "visible" }),
		HTMLElement: class {},
		Event: class {
			type: string;
			constructor(type: string) {
				this.type = type;
			}
		},
		Image: SandboxImage,
		URL: SandboxUrl,
		URLSearchParams,
		Blob: class {},
		AbortController,
		crypto: globalThis.crypto,
		navigator: {},
		fetch: fetchStub,
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		queueMicrotask,
		structuredClone,
		TextEncoder,
		TextDecoder,
		console,
	};

	vm.createContext(sandbox);
	// The page loads these before admin.js; the panel reads them off `window`.
	for (const module of [
		"smart-routing-ui.js",
		"expired-redirect-ui.js",
		"group-hierarchy-ui.js",
		"portability-ui.js",
		"portability-import-ui.js",
	]) {
		vm.runInContext(readPublic(module), sandbox);
	}
	vm.runInContext(adminJs, sandbox);

	const run = <T>(code: string) => vm.runInContext(code, sandbox) as T;

	/** Takes the next flag write recorded for a slug, failing loudly when there is none. */
	function takePendingFlagWrite(slug: string): Deferred {
		const queue = pendingFlagWrites.get(slug) ?? [];
		const pending = queue.shift();
		if (!pending) {
			throw new Error(`no pending QR flag write for ${slug}`);
		}
		return pending;
	}

	return {
		run,
		open: (slug: string) => run<Promise<void>>(`openQrDialog({ slug: ${JSON.stringify(slug)} })`),
		download: () => run<Promise<void>>("downloadQrCode()"),
		close: () => {
			run("closeQrDialog()");
		},
		surface: () => ({
			status: String(run("qrStatus.textContent")),
			statusClass: String(run("qrStatus.className")),
			slug: String(run("qrDialogSlug.textContent")),
			url: String(run("qrUrl.textContent")),
			imageSrc: String(run("qrImage.src")),
			imageAlt: String(run("qrImage.alt")),
			downloadDisabled: Boolean(run("qrDownloadButton.disabled")),
		}),
		downloads,
		listRequests,
		pendingFlagWrites: (slug: string) => (pendingFlagWrites.get(slug) ?? []).length,
		confirmFlagWrite: (slug: string) => {
			takePendingFlagWrite(slug).resolve({
				ok: true,
				status: 200,
				json: async () => ({ link: { slug, has_qrcode: 1 } }),
			});
		},
		refuseFlagWrite: (slug: string) => {
			takePendingFlagWrite(slug).resolve({ ok: false, status: 500, json: async () => ({ error: "Falha inesperada" }) });
		},
		rejectFlagWrite: (slug: string) => {
			takePendingFlagWrite(slug).reject(new TypeError("Failed to fetch"));
		},
	};
}

function expectNoFlagWritePending(harness: QrHarness, slug: string) {
	// `markQrCodeGenerated` is only reached from the download, so an empty queue after the
	// download is the proof that the click alone never writes the flag.
	expect(harness.pendingFlagWrites(slug)).toBe(0);
}

describe("Phase 5, Gate 5.4: QR download never reports an unconfirmed flag", () => {
	it("hands the PNG over, then reports the refused flag without claiming it", async () => {
		const harness = createQrHarness();
		await harness.open("a");

		const download = harness.download();
		harness.refuseFlagWrite("a");
		await download;

		expect(harness.downloads).toEqual([{ href: "blob:boltlink-qr-1", download: "boltlink-a-qr.png" }]);
		expectNoFlagWritePending(harness, "a");
		// The API answered, and the answer was a failure: no "QR Ativo" may be announced.
		expect(harness.surface().statusClass).toBe("status error");
		expect(harness.surface().status).not.toContain("QR Code baixado:");
		expect(harness.surface().status).toContain("não foi possível confirmar");
		// Nothing was confirmed on the server, so there is nothing to re-read either.
		expect(harness.listRequests).toHaveLength(0);
	});

	it("hands the PNG over, then reports the unreachable flag without claiming it", async () => {
		const harness = createQrHarness();
		await harness.open("a");

		const download = harness.download();
		harness.rejectFlagWrite("a");
		await download;

		expect(harness.downloads).toHaveLength(1);
		expectNoFlagWritePending(harness, "a");
		expect(harness.surface().statusClass).toBe("status error");
		expect(harness.surface().status).not.toContain("QR Code baixado:");
		expect(harness.listRequests).toHaveLength(0);
	});

	it("confirms the flag, refreshes the list and reports success when the write succeeds", async () => {
		const harness = createQrHarness();
		await harness.open("a");

		const download = harness.download();
		harness.confirmFlagWrite("a");
		await download;

		expect(harness.downloads).toHaveLength(1);
		expect(harness.listRequests).toHaveLength(1);
		expect(harness.surface().statusClass).toBe("status success");
		expect(harness.surface().status).toBe("QR Code baixado: http://localhost/a");
	});

	it("keeps the prepared QR usable in the dialog when the flag write never reached the API", async () => {
		// A rejection that never reaches the API is a network fault, and the dialog must keep
		// the operator's own surface usable: the PNG is already downloaded.
		const harness = createQrHarness();
		await harness.open("a");
		const download = harness.download();
		harness.rejectFlagWrite("a");
		await download;

		expect(harness.surface().downloadDisabled).toBe(false);
		expect(harness.surface().slug).toBe("/a");
	});
});

describe("Phase 5, Gate 5.4: QR download never writes into another dialog", () => {
	it("drops a late completion of A instead of describing it in B", async () => {
		const harness = createQrHarness();
		await harness.open("a");
		const stale = harness.download();

		harness.close();
		await harness.open("b");
		const bSurface = harness.surface();

		harness.confirmFlagWrite("a");
		await stale;

		const surface = harness.surface();
		// B's own surface is intact: nothing of A's completion reached it.
		expect(surface.slug).toBe("/b");
		expect(surface.url).toBe("http://localhost/b");
		expect(surface.imageSrc).toBe(bSurface.imageSrc);
		expect(surface.imageAlt).toBe("QR Code do short link http://localhost/b");
		expect(surface.downloadDisabled).toBe(false);
		expect(surface.status).toBe("");
		// The confirmed flag is a global fact, so the list is still re-read.
		expect(harness.listRequests).toHaveLength(1);
	});

	it("writes nothing into a dialog that was closed while the flag write was in flight", async () => {
		const harness = createQrHarness();
		await harness.open("a");
		const stale = harness.download();

		harness.close();
		harness.confirmFlagWrite("a");
		await stale;

		const surface = harness.surface();
		expect(surface.status).toBe("");
		expect(surface.slug).toBe("");
		expect(surface.url).toBe("");
		expect(surface.imageSrc).toBe("");
		expect(surface.downloadDisabled).toBe(true);
	});

	it("keeps a reopened link's new generation unaware of the previous one", async () => {
		const harness = createQrHarness();
		await harness.open("a");
		const stale = harness.download();

		harness.close();
		await harness.open("a");
		harness.confirmFlagWrite("a");
		await stale;

		// The slug matches, so only the token can tell the generations apart.
		const surface = harness.surface();
		expect(surface.slug).toBe("/a");
		expect(surface.status).toBe("");
		expect(surface.downloadDisabled).toBe(false);
		expect(harness.downloads).toHaveLength(1);
	});
});

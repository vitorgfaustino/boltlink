/*
 * Copyright (c) 2026 Vitor Faustino
 * AGPL-3.0 License — https://github.com/vitorgfaustino/boltlink
 *
 * Phase 5, Gate 5.4 (+ Gate 5.4.1 dual download): QR dialog admin coverage.
 *
 * The dialog is DOM glue inside admin.js, so its properties are verified as source
 * scans over the shipped files, the same way the other admin gates do it: the exact
 * places the QR surface is wired, the object URL lifecycle, the request token that
 * drops a late answer for a link the dialog no longer shows, and the fact that
 * nothing derived from a link reaches an HTML sink. The CSS parser proves the
 * 390px layout constraints and the Gate 5.4.1 spacing/action grid from the shipped
 * stylesheet.
 *
 * The orderings a scan cannot reach — a flag write that fails, one that finishes
 * after the dialog moved on, and the SVG download replaying the served body byte for
 * byte — are driven for real: the shipped admin.js runs in a VM context over a
 * minimal DOM, and `fetch` is programmable, so a completion can be delivered late
 * on purpose. The Gate 5.4.1 negative controls rerun the same harness over mutated
 * in-memory copies of admin.js to prove those behavioral assertions can actually
 * tell the pinned behavior from the faults they describe; the file on disk is never
 * touched.
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
	"setQrDownloadsDisabled",
	"qrDownloadArtifact",
	"scheduleQrDownloadRevoke",
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
		expect(markup).toContain('id="qr-copy-button"');
		expect(markup).toContain('id="qr-status"');
		expect(markup).toContain('aria-label="Fechar diálogo de QR Code"');
	});

	it("exposes PNG, SVG and copy as three explicit, immediately visible actions", () => {
		const markup = qrDialogMarkup();
		expect(markup).toContain('id="qr-download-png-button" disabled>Baixar PNG</button>');
		expect(markup).toContain('id="qr-download-svg-button" disabled>Baixar SVG</button>');
		expect(markup).toContain('id="qr-copy-button">Copiar link</button>');
		// The old single-format action is gone: no label may hide the format choice.
		expect(markup).not.toContain("Baixar QR Code");
	});

	it("ships the dialog closed and both downloads disabled until a generation exists", () => {
		const markup = adminHtml.slice(
			adminHtml.indexOf('class="qr-dialog"'),
			adminHtml.indexOf('id="qr-status"'),
		);
		expect(markup).toContain('aria-hidden="true"');
		expect(markup).toContain("inert");
		expect(markup).toContain('id="qr-download-png-button" disabled');
		expect(markup).toContain('id="qr-download-svg-button" disabled');
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
		expect(release).toContain("state.qrSvgText = null");
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
		const artifact = functionBody(adminJs, "qrDownloadArtifact");
		// A generation that cannot serve a format produces no artifact at all.
		expect(artifact).toContain("if (!state.qrSvgText) {");
		expect(artifact).toContain("if (!state.qrObjectUrl) {");

		const download = asyncFunctionBody(adminJs, "downloadQrCode");
		expect(download).toContain("if (!state.qrDialogOpen || !state.qrSlug)");
		expect(download).toContain("if (!artifact) {");
		expect(download).toContain("anchor.href = artifact.href");
	});

	it("gives the SVG download an object URL of its own, revoked with the download", () => {
		// Gate 5.4.1: the SVG never touches the PNG's persistent URL. Its blob wraps the
		// exact body the Worker returned, and the URL it borrows is returned in a
		// `finally` — on success, on a refused write and on a network fault alike.
		const artifact = functionBody(adminJs, "qrDownloadArtifact");
		expect(artifact).toContain('URL.createObjectURL(new Blob([state.qrSvgText], { type: "image/svg+xml;charset=utf-8" }))');
		expect(artifact).toContain("ownsHref: true");

		const download = asyncFunctionBody(adminJs, "downloadQrCode");
		expect(download).toContain("} finally {");
		expect(download).toContain("if (artifact.ownsHref) {");
		expect(download).toContain("URL.revokeObjectURL(artifact.href);");
	});

	it("returns the borrowed SVG URL on a schedule the flag write cannot extend (QR-541-01)", () => {
		// The `finally` above only runs once the async block ends, and how long that takes is
		// the network's decision, not the download's. The release is therefore also armed at
		// the click, on its own deferred task: that second route — not the `finally` — is what
		// bounds the URL when the write never settles.
		const release = functionBody(adminJs, "scheduleQrDownloadRevoke");
		expect(release).toContain("setTimeout(");
		expect(release).toContain("URL.revokeObjectURL(href)");

		const download = asyncFunctionBody(adminJs, "downloadQrCode");
		const clickIndex = download.indexOf("anchor.click();");
		const scheduleIndex = download.indexOf("scheduleQrDownloadRevoke(artifact.href);");
		const writeIndex = download.indexOf("await markQrCodeGenerated(slug)");
		// Armed after the browser got the file and before the write is awaited, so the release
		// is in flight whatever the write does next.
		expect(clickIndex).toBeGreaterThan(-1);
		expect(scheduleIndex).toBeGreaterThan(clickIndex);
		expect(writeIndex).toBeGreaterThan(scheduleIndex);
		// Never revoked in the same frame as the click, which is the shape that can cancel a
		// download in some browsers.
		expect(download).not.toContain("anchor.click();\n  URL.revokeObjectURL");
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
	it("downloads predictably named PNG and SVG files of the short link", () => {
		const artifact = functionBody(adminJs, "qrDownloadArtifact");
		expect(artifact).toContain("filename: `boltlink-${slug}-qr.png`");
		expect(artifact).toContain("filename: `boltlink-${slug}-qr.svg`");
		expect(artifact).not.toContain("target_url");
	});

	it("marks has_qrcode only when the operator actually obtains the QR", () => {
		const download = asyncFunctionBody(adminJs, "downloadQrCode");
		expect(download).toContain("await markQrCodeGenerated(slug)");

		const open = asyncFunctionBody(adminJs, "openQrDialog");
		expect(open).not.toContain("markQrCodeGenerated");

		const mark = asyncFunctionBody(adminJs, "markQrCodeGenerated");
		expect(mark).toContain("/qrcode`, { method: \"POST\" }");
	});

	it("shares one flag policy across both formats through a single helper", () => {
		const download = asyncFunctionBody(adminJs, "downloadQrCode");
		// One function, both formats: the only thing the format changes is the artifact
		// and the label, never the write-or-report policy.
		expect(download).toContain('downloadQrCode(format)');
		expect(download).toContain("qrDownloadArtifact(format, slug)");
		expect(download).toContain("const formatLabel = format.toUpperCase();");
		expect(download).toContain('`QR Code ${formatLabel} baixado: ${buildShortLink(slug)}`');
		expect(download).toContain('`QR Code ${formatLabel} baixado, mas não foi possível confirmar o estado "QR Ativo" de ${buildShortLink(slug)}.`');
	});

	it("enables both downloads only after the generation is complete", () => {
		const open = asyncFunctionBody(adminJs, "openQrDialog");
		const svgIndex = open.indexOf("state.qrSvgText = svgText;");
		const objectUrlIndex = open.indexOf("state.qrObjectUrl = URL.createObjectURL(png.blob)");
		const enableIndex = open.indexOf("setQrDownloadsDisabled(false)");
		expect(svgIndex).toBeGreaterThan(-1);
		expect(objectUrlIndex).toBeGreaterThan(svgIndex);
		expect(enableIndex).toBeGreaterThan(objectUrlIndex);

		const reset = functionBody(adminJs, "resetQrDialogSurface");
		expect(reset).toContain("setQrDownloadsDisabled(true)");

		const both = functionBody(adminJs, "setQrDownloadsDisabled");
		expect(both).toContain("qrDownloadPngButton.disabled = disabled");
		expect(both).toContain("qrDownloadSvgButton.disabled = disabled");
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

	it("wires close, backdrop, both downloads and copy to their handlers", () => {
		expect(adminJs).toContain("qrDialogCloseButton.addEventListener(\"click\", () => {\n  closeQrDialog();\n});");
		expect(adminJs).toContain("qrDialogBackdrop.addEventListener(\"click\", () => {\n  closeQrDialog();\n});");
		expect(adminJs).toContain("qrDownloadPngButton.addEventListener(\"click\", () => {\n  downloadQrCode(\"png\");\n});");
		expect(adminJs).toContain("qrDownloadSvgButton.addEventListener(\"click\", () => {\n  downloadQrCode(\"svg\");\n});");
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

	it("gates the spacing of Gate 5.4.1: one rhythm, breathing around the QR", () => {
		// No two blocks of the body sit flush: a 12px row gap carries the whole ladder,
		// with the accents that make the QR the most spaced element of the card.
		const body = rulesMatching(/^\.qr-dialog-body$/);
		expect(body).toHaveLength(1);
		expect(body[0].body).toContain("display: grid");
		expect(body[0].body).toContain("row-gap: 12px");

		const help = rulesMatching(/^\.qr-dialog-help$/);
		expect(help).toHaveLength(1);
		expect(help[0].body).toContain("margin: 0");

		const preview = rulesMatching(/^\.qr-preview$/);
		expect(preview).toHaveLength(1);
		expect(preview[0].body).toContain("margin-block: 2px");
		expect(preview[0].body).toContain("padding: 12px");

		const actions = rulesMatching(/^\.qr-actions$/);
		expect(actions.length).toBeGreaterThanOrEqual(1);
		expect(actions[0].body).toContain("margin-block-start: 2px");

		const status = rulesMatching(/^#qr-status$/);
		expect(status).toHaveLength(1);
		expect(status[0].body).toContain("margin-top: 0");
	});

	it("lays the three actions in a grid that pairs the downloads under the card cap", () => {
		// Full width: one row of three. The base `.qr-actions` rule carries the 3-track
		// grid; the 431px variant re-declares the same selector with 2 tracks, so both
		// shapes surface under this selector.
		const actions = rulesMatching(/^\.qr-actions$/);
		expect(actions.some((rule) => rule.body.includes("grid-template-columns: repeat(3, minmax(0, 1fr))"))).toBe(true);
		expect(actions.some((rule) => rule.body.includes("grid-template-columns: repeat(2, minmax(0, 1fr))"))).toBe(true);
		expect(rulesMatching(/^\.qr-actions button$/)[0]?.body).toContain("padding-inline: 12px");

		// The breakpoint is the width where the card's min(400px, 100vw - 32px) leaves
		// its cap, so below it three nowrap labels would not fit a track each.
		expect(adminCss).toContain("@media (max-width: 431px)");

		// Copy owns the full second row on the narrow shape, never a squeezed third cell.
		const copy = rulesMatching(/^#qr-copy-button$/);
		expect(copy).toHaveLength(1);
		expect(copy[0].body).toContain("grid-column: 1 / -1");
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
	pngDisabled: boolean;
	svgDisabled: boolean;
};

type QrHarness = {
	/** Runs an expression in the panel's own realm and returns its value. */
	run: <T>(code: string) => T;
	open: (slug: string) => Promise<void>;
	download: (format: "png" | "svg") => Promise<void>;
	close: () => void;
	surface: () => QrSurface;
	/** The exact SVG body the endpoint serves for a slug — the download's only truth. */
	qrBodyOf: (slug: string) => string;
	/** The SVG text the panel currently holds, or null once the generation is gone. */
	svgText: () => string | null;
	/** Object URLs alive right now: the PNG preview's, plus any leaked download URL. */
	liveObjectUrls: () => string[];
	downloads: Array<{ href: string; download: string }>;
	/** Blob type and text per download, in click order; text is null for non-Sandbox blobs. */
	downloadBlobs: Array<{ type: string; text: string | null }>;
	listRequests: string[];
	pendingFlagWrites: (slug: string) => number;
	confirmFlagWrite: (slug: string) => void;
	refuseFlagWrite: (slug: string) => void;
	rejectFlagWrite: (slug: string) => void;
	/** Resolves the next in-flight QR generation for a slug (deferred mode only). */
	deliverQr: (slug: string) => void;
};

/** Knobs the behavioral suites and the negative controls steer the harness with. */
type QrHarnessOptions = {
	/** Runs this source instead of the shipped admin.js (mutations only; disk is read-only). */
	source?: string;
	/** Makes the SVG decoder fail, so the whole generation must fail closed. */
	imageFails?: boolean;
	/** Holds every QR GET until `deliverQr` answers it, keeping the dialog mid-generation. */
	deferQrGet?: boolean;
};

/**
 * Loads the shipped admin.js the way the admin page does — helper modules first, then the
 * panel — over a DOM stub that answers every member the panel touches. Requests are
 * programmable: the QR generation and the flag write are answered by hand, and every
 * other call (capabilities, groups, version) simply stays in flight, which keeps the
 * panel from rendering anything the tests did not ask for.
 */
function createQrHarness(options: QrHarnessOptions = {}): QrHarness {
	const objectUrls: string[] = [];
	const blobByUrl = new Map<string, SandboxBlob>();
	const downloads: Array<{ href: string; download: string }> = [];
	const downloadBlobs: Array<{ type: string; text: string | null }> = [];
	const listRequests: string[] = [];
	const pendingFlagWrites = new Map<string, Deferred[]>();
	const pendingQrGets = new Map<string, Deferred[]>();
	let objectUrlSequence = 0;

	/** Each slug gets its own deterministic body, so A's artifact can never pass for B's. */
	const qrBodyFor = (slug: string) => `<svg xmlns="http://www.w3.org/2000/svg" data-slug="${slug}"><!-- boltlink qr --></svg>`;

	/** The only Blob the panel ever needs to read back: the SVG download's payload. */
	class SandboxBlob {
		readonly parts: string[];
		readonly type: string;
		constructor(parts: unknown[], init?: { type?: string }) {
			this.parts = parts.map((part) => String(part));
			this.type = init?.type ?? "";
		}
	}

	class SandboxUrl extends URL {
		static createObjectURL(blob?: unknown) {
			objectUrlSequence += 1;
			const url = `blob:boltlink-qr-${objectUrlSequence}`;
			objectUrls.push(url);
			if (blob instanceof SandboxBlob) {
				blobByUrl.set(url, blob);
			}
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
	 * `imageFails` flips to the error branch, which is how a broken rasterization is
	 * rehearsed without a real decoder.
	 */
	class SandboxImage {
		onload: (() => void) | null = null;
		onerror: (() => void) | null = null;
		private source = "";
		set src(value: string) {
			this.source = value;
			if (options.imageFails) {
				this.onerror?.();
				return;
			}
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
				// The only observable effect of the download the page can have, plus the
				// blob behind the URL it handed over, when there is one.
				element.click = () => {
					const href = String(element.href ?? "");
					downloads.push({ href, download: String(element.download ?? "") });
					const blob = blobByUrl.get(href);
					downloadBlobs.push({
						type: blob ? blob.type : "",
						text: blob ? blob.parts.join("") : null,
					});
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
			const slug = slugOfDownloadTarget(target);
			if (options.deferQrGet) {
				const pending = deferred();
				const queue = pendingQrGets.get(slug) ?? [];
				queue.push(pending);
				pendingQrGets.set(slug, queue);
				return pending.promise;
			}
			return Promise.resolve({ ok: true, status: 200, text: async () => qrBodyFor(slug) });
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
		Blob: SandboxBlob,
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
	// The negative controls pass a mutated copy; the shipped file is never rewritten.
	vm.runInContext(options.source ?? adminJs, sandbox);

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
		download: (format: "png" | "svg") => run<Promise<void>>(`downloadQrCode(${JSON.stringify(format)})`),
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
			pngDisabled: Boolean(run("qrDownloadPngButton.disabled")),
			svgDisabled: Boolean(run("qrDownloadSvgButton.disabled")),
		}),
		qrBodyOf: (slug: string) => qrBodyFor(slug),
		svgText: () => run<string | null>("state.qrSvgText"),
		liveObjectUrls: () => [...objectUrls],
		downloads,
		downloadBlobs,
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
		deliverQr: (slug: string) => {
			const queue = pendingQrGets.get(slug) ?? [];
			const pending = queue.shift();
			if (!pending) {
				throw new Error(`no pending QR generation for ${slug}`);
			}
			pending.resolve({ ok: true, status: 200, text: async () => qrBodyFor(slug) });
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

		const download = harness.download("png");
		harness.refuseFlagWrite("a");
		await download;

		expect(harness.downloads).toEqual([{ href: "blob:boltlink-qr-1", download: "boltlink-a-qr.png" }]);
		expectNoFlagWritePending(harness, "a");
		// The API answered, and the answer was a failure: no "QR Ativo" may be announced.
		expect(harness.surface().statusClass).toBe("status error");
		expect(harness.surface().status).not.toContain("QR Code PNG baixado:");
		expect(harness.surface().status).toContain("QR Code PNG baixado, mas não foi possível confirmar");
		// Nothing was confirmed on the server, so there is nothing to re-read either.
		expect(harness.listRequests).toHaveLength(0);
	});

	it("hands the PNG over, then reports the unreachable flag without claiming it", async () => {
		const harness = createQrHarness();
		await harness.open("a");

		const download = harness.download("png");
		harness.rejectFlagWrite("a");
		await download;

		expect(harness.downloads).toHaveLength(1);
		expectNoFlagWritePending(harness, "a");
		expect(harness.surface().statusClass).toBe("status error");
		expect(harness.surface().status).not.toContain("QR Code PNG baixado:");
		expect(harness.listRequests).toHaveLength(0);
	});

	it("confirms the flag, refreshes the list and reports success when the write succeeds", async () => {
		const harness = createQrHarness();
		await harness.open("a");

		const download = harness.download("png");
		harness.confirmFlagWrite("a");
		await download;

		expect(harness.downloads).toHaveLength(1);
		expect(harness.listRequests).toHaveLength(1);
		expect(harness.surface().statusClass).toBe("status success");
		expect(harness.surface().status).toBe("QR Code PNG baixado: http://localhost/a");
	});

	it("keeps the prepared QR usable in the dialog when the flag write never reached the API", async () => {
		// A rejection that never reaches the API is a network fault, and the dialog must keep
		// the operator's own surface usable: the PNG is already downloaded.
		const harness = createQrHarness();
		await harness.open("a");
		const download = harness.download("png");
		harness.rejectFlagWrite("a");
		await download;

		expect(harness.surface().pngDisabled).toBe(false);
		expect(harness.surface().svgDisabled).toBe(false);
		expect(harness.surface().slug).toBe("/a");
	});
});

describe("Phase 5, Gate 5.4: QR download never writes into another dialog", () => {
	it("drops a late completion of A instead of describing it in B", async () => {
		const harness = createQrHarness();
		await harness.open("a");
		const stale = harness.download("png");

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
		expect(surface.pngDisabled).toBe(false);
		expect(surface.svgDisabled).toBe(false);
		expect(surface.status).toBe("");
		// The confirmed flag is a global fact, so the list is still re-read.
		expect(harness.listRequests).toHaveLength(1);
	});

	it("writes nothing into a dialog that was closed while the flag write was in flight", async () => {
		const harness = createQrHarness();
		await harness.open("a");
		const stale = harness.download("png");

		harness.close();
		harness.confirmFlagWrite("a");
		await stale;

		const surface = harness.surface();
		expect(surface.status).toBe("");
		expect(surface.slug).toBe("");
		expect(surface.url).toBe("");
		expect(surface.imageSrc).toBe("");
		expect(surface.pngDisabled).toBe(true);
		expect(surface.svgDisabled).toBe(true);
	});

	it("keeps a reopened link's new generation unaware of the previous one", async () => {
		const harness = createQrHarness();
		await harness.open("a");
		const stale = harness.download("png");

		harness.close();
		await harness.open("a");
		harness.confirmFlagWrite("a");
		await stale;

		// The slug matches, so only the token can tell the generations apart.
		const surface = harness.surface();
		expect(surface.slug).toBe("/a");
		expect(surface.status).toBe("");
		expect(surface.pngDisabled).toBe(false);
		expect(harness.downloads).toHaveLength(1);
	});
});

describe("Phase 5, Gate 5.4.1: QR SVG download serves the exact artifact the Worker returned", () => {
	it("downloads the served body byte for byte under the SVG MIME and name", async () => {
		const harness = createQrHarness();
		await harness.open("a");

		// The panel holds the served body itself, not a re-serialization of it.
		expect(harness.svgText()).toBe(harness.qrBodyOf("a"));

		const download = harness.download("svg");
		harness.confirmFlagWrite("a");
		await download;

		expect(harness.downloads).toEqual([{ href: "blob:boltlink-qr-2", download: "boltlink-a-qr.svg" }]);
		expect(harness.downloadBlobs[0]?.type).toBe("image/svg+xml;charset=utf-8");
		expect(harness.downloadBlobs[0]?.text).toBe(harness.qrBodyOf("a"));
		expect(harness.surface().statusClass).toBe("status success");
		expect(harness.surface().status).toBe("QR Code SVG baixado: http://localhost/a");
		// The flag was confirmed, so the list is re-read exactly once.
		expect(harness.listRequests).toHaveLength(1);
	});

	it("hands the SVG over and reports a refused flag without claiming it", async () => {
		const harness = createQrHarness();
		await harness.open("a");

		const download = harness.download("svg");
		harness.refuseFlagWrite("a");
		await download;

		// The download itself is a fact; only the "QR Ativo" claim is withheld.
		expect(harness.downloads).toHaveLength(1);
		expect(harness.downloads[0]?.download).toBe("boltlink-a-qr.svg");
		expectNoFlagWritePending(harness, "a");
		expect(harness.surface().statusClass).toBe("status error");
		expect(harness.surface().status).not.toContain("QR Code SVG baixado:");
		expect(harness.surface().status).toContain("QR Code SVG baixado, mas não foi possível confirmar");
		expect(harness.listRequests).toHaveLength(0);
	});

	it("revokes the borrowed SVG URL even when the flag write never reaches the API", async () => {
		const harness = createQrHarness();
		await harness.open("a");

		const download = harness.download("svg");
		harness.rejectFlagWrite("a");
		await download;

		expect(harness.downloads).toHaveLength(1);
		// The SVG URL was created for the download alone and does not survive it —
		// not even through a network fault.
		expect(harness.liveObjectUrls()).toEqual(["blob:boltlink-qr-1"]);
	});

	it("keeps both downloads unavailable when the rasterization fails", async () => {
		// Gate 5.4.1 keeps the generation atomic: a PNG that cannot be produced leaves no
		// SVG-only state behind, exactly as the single-format flow did.
		const harness = createQrHarness({ imageFails: true });
		await harness.open("a");

		const surface = harness.surface();
		expect(surface.pngDisabled).toBe(true);
		expect(surface.svgDisabled).toBe(true);
		expect(harness.svgText()).toBeNull();
		expect(surface.status).toContain("Não foi possível gerar o QR Code deste link");
		expect(harness.downloads).toHaveLength(0);
	});

	it("keeps both downloads disabled and unreachable while the generation is in flight", async () => {
		const harness = createQrHarness({ deferQrGet: true });
		const opening = harness.open("b");

		const mid = harness.surface();
		expect(mid.pngDisabled).toBe(true);
		expect(mid.svgDisabled).toBe(true);
		// A click mid-generation is a no-op: no artifact, no anchor, no flag write.
		await harness.download("svg");
		expect(harness.downloads).toHaveLength(0);
		expect(harness.pendingFlagWrites("b")).toBe(0);

		harness.deliverQr("b");
		await opening;

		const done = harness.surface();
		expect(done.pngDisabled).toBe(false);
		expect(done.svgDisabled).toBe(false);
		expect(harness.svgText()).toBe(harness.qrBodyOf("b"));
	});
});

describe("Phase 5, Gate 5.4.1: QR object URL hygiene across both formats", () => {
	it("leaks nothing through repeated, alternating downloads and close", async () => {
		const harness = createQrHarness();
		await harness.open("a");

		// PNG rides the persistent URL; each SVG borrows and returns its own.
		const sequence: Array<"png" | "svg"> = ["png", "svg", "svg", "png", "svg"];
		for (const format of sequence) {
			const download = harness.download(format);
			harness.confirmFlagWrite("a");
			await download;
		}

		expect(harness.downloads).toHaveLength(5);
		expect(harness.downloads.map((entry) => entry.download)).toEqual([
			"boltlink-a-qr.png",
			"boltlink-a-qr.svg",
			"boltlink-a-qr.svg",
			"boltlink-a-qr.png",
			"boltlink-a-qr.svg",
		]);
		// Both formats of one generation describe the same QR: the PNG always hands over
		// the URL the dialog owns, and every SVG URL is already gone.
		expect(harness.liveObjectUrls()).toEqual(["blob:boltlink-qr-1"]);

		harness.close();
		expect(harness.liveObjectUrls()).toEqual([]);
	});

	it("serves B its own SVG after A's download, never A's artifact", async () => {
		const harness = createQrHarness();
		await harness.open("a");
		const stale = harness.download("svg");

		harness.close();
		await harness.open("b");
		harness.confirmFlagWrite("a");
		await stale;

		// A's late confirmation wrote nothing into B's dialog…
		const surface = harness.surface();
		expect(surface.slug).toBe("/b");
		expect(surface.status).toBe("");

		// …and B's own SVG download is B's artifact under B's filename.
		const download = harness.download("svg");
		harness.confirmFlagWrite("b");
		await download;

		const last = harness.downloads[harness.downloads.length - 1];
		expect(last?.download).toBe("boltlink-b-qr.svg");
		expect(harness.downloadBlobs[harness.downloadBlobs.length - 1]?.text).toBe(harness.qrBodyOf("b"));
	});

	it("is a no-op after close: no artifact, no anchor, no flag write", async () => {
		const harness = createQrHarness();
		await harness.open("a");
		harness.close();

		await harness.download("svg");
		await harness.download("png");

		expect(harness.downloads).toHaveLength(0);
		expectNoFlagWritePending(harness, "a");
	});
});

/*
 * QR-541-01 (Gate 5.4.1, P2). The borrowed SVG URL and the `has_qrcode` write are two
 * unrelated facts that shared one lifetime: the URL was returned only by the `finally` of
 * an async block whose length the network decides. A write that never settles therefore
 * kept the URL allocated, and closing the dialog could not release it either — the `finally`
 * had not run. Every test below is written so that the borrow is released while the write is
 * still in flight; the write is then answered only to leave no timer behind.
 */
function flushScheduledCleanup() {
	// The deferred release waits for one macrotask; a real 0ms timer is what advances it.
	return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Phase 5, Gate 5.4.1: QR-541-01 the SVG URL outlives nothing but its own click", () => {
	it("returns the SVG URL while the flag write is pending and the dialog stays open", async () => {
		const harness = createQrHarness();
		await harness.open("a");

		// Deliberately not awaited: the hanging write is the condition under test.
		const download = harness.download("svg");
		expect(harness.downloads).toHaveLength(1);
		// Mid-flight the dialog owns its PNG URL plus the one borrowed for this click.
		expect(harness.liveObjectUrls()).toEqual(["blob:boltlink-qr-1", "blob:boltlink-qr-2"]);

		await flushScheduledCleanup();

		// Only the dialog's own URL is left, and the write is untouched by the release.
		expect(harness.liveObjectUrls()).toEqual(["blob:boltlink-qr-1"]);
		expect(harness.pendingFlagWrites("a")).toBe(1);
		expect(harness.surface().status).toBe("");

		harness.confirmFlagWrite("a");
		await download;
	});

	it("returns the SVG URL when the dialog is closed with the flag write still pending", async () => {
		const harness = createQrHarness();
		await harness.open("a");

		const download = harness.download("svg");
		harness.close();
		// Closing released the PNG URL; the borrowed one must not need the close to go away,
		// and a closed dialog is precisely where the `finally` would never be reached.
		expect(harness.liveObjectUrls()).toEqual(["blob:boltlink-qr-2"]);

		await flushScheduledCleanup();

		expect(harness.liveObjectUrls()).toEqual([]);
		expect(harness.pendingFlagWrites("a")).toBe(1);

		harness.confirmFlagWrite("a");
		await download;
		// A confirmation for a closed dialog still writes nothing into the surface.
		expect(harness.surface().status).toBe("");
	});

	it("accumulates nothing across repeated SVG downloads whose writes hang", async () => {
		const harness = createQrHarness();
		await harness.open("a");

		const pending = [harness.download("svg"), harness.download("svg"), harness.download("svg")];
		expect(harness.downloads).toHaveLength(3);
		expect(harness.liveObjectUrls()).toHaveLength(4);

		await flushScheduledCleanup();

		// Three borrowed URLs returned while all three writes are still in flight: no
		// accumulation, and nothing here waits on the network to be reclaimed.
		expect(harness.liveObjectUrls()).toEqual(["blob:boltlink-qr-1"]);
		expect(harness.pendingFlagWrites("a")).toBe(3);

		harness.confirmFlagWrite("a");
		harness.confirmFlagWrite("a");
		harness.confirmFlagWrite("a");
		await Promise.all(pending);
		expect(harness.surface().status).toBe("QR Code SVG baixado: http://localhost/a");
	});
});

describe("Phase 5, Gate 5.4.1: QR-541-01 the release leaves the approved outcomes alone", () => {
	it("keeps the confirmed-flag path intact while releasing the URL independently", async () => {
		const harness = createQrHarness();
		await harness.open("a");

		const download = harness.download("svg");
		harness.confirmFlagWrite("a");
		await download;

		// The download itself, the content and the confirmed flag are unchanged.
		expect(harness.downloads).toEqual([{ href: "blob:boltlink-qr-2", download: "boltlink-a-qr.svg" }]);
		expect(harness.downloadBlobs[0]?.type).toBe("image/svg+xml;charset=utf-8");
		expect(harness.downloadBlobs[0]?.text).toBe(harness.qrBodyOf("a"));
		expect(harness.listRequests).toHaveLength(1);
		expect(harness.surface().statusClass).toBe("status success");
		expect(harness.surface().status).toBe("QR Code SVG baixado: http://localhost/a");

		await flushScheduledCleanup();
		// Same end state as before QR-541-01: the borrowed URL is gone, the PNG's remains.
		expect(harness.liveObjectUrls()).toEqual(["blob:boltlink-qr-1"]);
	});

	it("releases the URL and still refuses to claim an HTTP-refused flag", async () => {
		const harness = createQrHarness();
		await harness.open("a");

		const download = harness.download("svg");
		harness.refuseFlagWrite("a");
		await download;
		await flushScheduledCleanup();

		expect(harness.downloads).toHaveLength(1);
		expect(harness.liveObjectUrls()).toEqual(["blob:boltlink-qr-1"]);
		expect(harness.listRequests).toHaveLength(0);
		expect(harness.surface().statusClass).toBe("status error");
		expect(harness.surface().status).not.toContain("QR Code SVG baixado:");
		expect(harness.surface().status).toContain("não foi possível confirmar");
	});

	it("releases the URL and still reports an unreachable flag conservatively", async () => {
		const harness = createQrHarness();
		await harness.open("a");

		const download = harness.download("svg");
		harness.rejectFlagWrite("a");
		await download;
		await flushScheduledCleanup();

		expect(harness.downloads).toHaveLength(1);
		expect(harness.liveObjectUrls()).toEqual(["blob:boltlink-qr-1"]);
		expect(harness.surface().statusClass).toBe("status error");
		expect(harness.surface().status).not.toContain("QR Code SVG baixado:");
	});
});

/*
 * Gate 5.4.1 negative controls. Each reruns the harness over a mutated in-memory copy of
 * admin.js and shows the fault the mutation plants is exactly what the pinned assertions
 * above detect. The mutations must apply — a stale anchor fails the control loudly — and
 * the file on disk is never touched, so the pristine source is restored by construction.
 */
const MUTATIONS = {
	/** Control A: the SVG is built from something other than the served body. */
	destinationSvg: (source: string) => source.replace(
		"new Blob([state.qrSvgText], { type: \"image/svg+xml;charset=utf-8\" })",
		"new Blob([`<svg>destination:${slug}</svg>`], { type: \"image/svg+xml;charset=utf-8\" })",
	),
	/** Control B: the SVG download skips the has_qrcode write entirely. */
	noFlagWriteOnSvg: (source: string) => source.replace(
		"const marked = await markQrCodeGenerated(slug);",
		"const marked = format === \"svg\" || await markQrCodeGenerated(slug);",
	),
	/** Control C: the previous generation's SVG survives the switch to another link. */
	staleSvgSurvives: (source: string) => source.replace("state.qrSvgText = null;", ""),
	/** Control D: the borrowed SVG object URL is never returned, by either route. */
	noSvgRevoke: (source: string) => source
		.replace("URL.revokeObjectURL(artifact.href);", "")
		.replace("URL.revokeObjectURL(href);", ""),
	/**
	 * Control E: QR-541-01 restored — the deferred release is gone, so the borrowed URL is
	 * returned only by the `finally` of the async block and its lifetime is once again
	 * decided by the flag write.
	 */
	revokeOnlyWhenTheWriteEnds: (source: string) => source.replace("scheduleQrDownloadRevoke(artifact.href);", ""),
};

function mutatedSource(name: keyof typeof MUTATIONS): string {
	const mutated = MUTATIONS[name](adminJs);
	expect(mutated, `mutation ${name} did not apply — its anchor drifted`).not.toBe(adminJs);
	return mutated;
}

describe("Phase 5, Gate 5.4.1: negative controls over the SVG download", () => {
	it("control A: an SVG built from anything but the served body fails the integrity pin", async () => {
		const harness = createQrHarness({ source: mutatedSource("destinationSvg") });
		await harness.open("a");

		const download = harness.download("svg");
		harness.confirmFlagWrite("a");
		await download;

		// The pinned test asserts equality with the served body; under the mutation the
		// content differs, which is what makes that assertion able to fail.
		expect(harness.downloadBlobs[0]?.text).not.toBe(harness.qrBodyOf("a"));
		expect(harness.downloadBlobs[0]?.text).toContain("destination:a");
	});

	it("control B: an SVG download that skips the flag write leaves nothing to confirm", async () => {
		const clean = createQrHarness();
		await clean.open("a");
		const cleanDownload = clean.download("svg");
		// Sanity first: the pinned flow leaves exactly one write waiting to be confirmed.
		expect(clean.pendingFlagWrites("a")).toBe(1);
		clean.confirmFlagWrite("a");
		await cleanDownload;

		const harness = createQrHarness({ source: mutatedSource("noFlagWriteOnSvg") });
		await harness.open("a");
		const download = harness.download("svg");
		await download;
		// The file still downloads, but no write ever left the panel — confirming one
		// now would throw "no pending QR flag write", which is precisely the fact the
		// pinned tests refuse to accept for a completed SVG download.
		expect(harness.downloads).toHaveLength(1);
		expect(harness.pendingFlagWrites("a")).toBe(0);
	});

	it("control C: a generation that survives the switch is downloadable in the next dialog", async () => {
		const harness = createQrHarness({ source: mutatedSource("staleSvgSurvives"), deferQrGet: true });
		const openingA = harness.open("a");
		harness.deliverQr("a");
		await openingA;
		harness.close();

		const openingB = harness.open("b");
		const leaking = harness.download("svg");
		// The real code answers null (no generation yet) and downloads nothing; the
		// mutation hands A's SVG out under B's filename — the exact "SVG of A in B" the
		// pinned mid-generation test forbids.
		expect(harness.downloads).toHaveLength(1);
		expect(harness.downloads[0]?.download).toBe("boltlink-b-qr.svg");
		expect(harness.downloadBlobs[0]?.text).toBe(harness.qrBodyOf("a"));

		harness.refuseFlagWrite("b");
		await leaking;
		harness.deliverQr("b");
		await openingB;
	});

	it("control D: an unrevoked SVG object URL stays visible as a leak", async () => {
		const harness = createQrHarness({ source: mutatedSource("noSvgRevoke") });
		await harness.open("a");

		const download = harness.download("svg");
		harness.confirmFlagWrite("a");
		await download;
		await flushScheduledCleanup();

		// The pinned hygiene test allows exactly one live URL (the PNG's); the mutation
		// leaves the borrowed SVG URL alive through both release routes — the `finally` and
		// the deferred task — which is the leak those tests detect.
		expect(harness.liveObjectUrls()).toHaveLength(2);
		expect(harness.liveObjectUrls()).toContain("blob:boltlink-qr-2");
	});

	it("control E: a release that waits for the flag write leaks while the write hangs", async () => {
		const harness = createQrHarness({ source: mutatedSource("revokeOnlyWhenTheWriteEnds") });
		await harness.open("a");

		// The write never answers. The pinned QR-541-01 test reads one live URL here; under
		// the mutation the borrowed one is still allocated, which is the defect itself.
		const download = harness.download("svg");
		await flushScheduledCleanup();

		expect(harness.liveObjectUrls()).toEqual(["blob:boltlink-qr-1", "blob:boltlink-qr-2"]);
		expect(harness.pendingFlagWrites("a")).toBe(1);

		harness.confirmFlagWrite("a");
		await download;
		// Once the write answers the mutation does release it: the leak is bounded by the
		// write, not by the click — exactly the coupling the fix removes.
		expect(harness.liveObjectUrls()).toEqual(["blob:boltlink-qr-1"]);
	});

	it("control E: repeated SVG downloads accumulate while the writes hang", async () => {
		const harness = createQrHarness({ source: mutatedSource("revokeOnlyWhenTheWriteEnds") });
		await harness.open("a");

		const pending = [harness.download("svg"), harness.download("svg"), harness.download("svg")];
		await flushScheduledCleanup();

		// Four live URLs against the one the pinned test allows: the accumulation QR-541-01
		// describes, and the per-download growth a single-shot assertion would miss.
		expect(harness.liveObjectUrls()).toHaveLength(4);

		harness.confirmFlagWrite("a");
		harness.confirmFlagWrite("a");
		harness.confirmFlagWrite("a");
		await Promise.all(pending);
		expect(harness.liveObjectUrls()).toEqual(["blob:boltlink-qr-1"]);
	});
});

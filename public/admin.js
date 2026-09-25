/*
 * Copyright (c) 2026 Vitor Faustino
 *
 * BoltLink is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * BoltLink is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with BoltLink. If not, see <https://www.gnu.org/licenses/>.
 */

const state = {
  editingSlug: null,
  links: [],
  pendingDeletes: new Map(),
  countdownInterval: null,
  abTesting: false,
  smartRouting: false,
  smartRules: [],
  // Loaded persisted routing state is kept explicit: a corrupt value must never
  // be collapsed into "off", otherwise an unrelated edit would erase it.
  smartRoutingCorrupt: false,
  smartClearInvalid: false,
  expiredRedirect: false,
  // Group hierarchy snapshot, as returned by the API and laid out by
  // BoltLinkGroupHierarchy. `collapsedGroups` holds the collapsed ids, so a group
  // created meanwhile is visible without extra bookkeeping.
  groupTree: null,
  collapsedGroups: new Set(),
};

const smartRoutingUi = window.BoltLinkSmartRouting || null;
const expiredRedirectUi = window.BoltLinkExpiredRedirect || null;
// Loaded before this script, and pinned by an order test. The panel fails closed
// with an explanatory status instead of throwing when the module is absent.
const groupHierarchyUi = window.BoltLinkGroupHierarchy || null;
// Loaded before this script, and pinned by an order test. The local fallback only
// keeps the controls inert instead of throwing if the module is ever absent; a
// submission that actually needs the rules fails closed in the payload builder.
const EXPIRED_MODE_RESPONSE = expiredRedirectUi ? expiredRedirectUi.MODE_RESPONSE : "410";
const EXPIRED_MODE_REDIRECT = expiredRedirectUi ? expiredRedirectUi.MODE_REDIRECT : "redirect";
const MAX_SMART_RULES = smartRoutingUi ? smartRoutingUi.MAX_RULES : 20;

const ICONS = {
  save: `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
      <path d="M17 21v-8H7v8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
      <path d="M7 3v5h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
    </svg>`,
  update: `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M23 4v6h-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
      <path d="M1 20v-6h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
      <path d="M3.51 9A9 9 0 0 1 18.36 5.64L23 10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
      <path d="M20.49 15A9 9 0 0 1 5.64 18.36L1 14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
    </svg>`,
  cancel: `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M18 6 6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
      <path d="m6 6 12 12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
    </svg>`,
  copy: `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
      <rect x="8" y="2" width="8" height="4" rx="1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></rect>
    </svg>`,
  duplicate: `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" stroke="currentColor" stroke-width="1.8"></rect>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
    </svg>`,
  qrcode: `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="3" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></rect>
      <rect x="15" y="3" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></rect>
      <rect x="3" y="15" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></rect>
      <path d="M15 15h2v2h-2zm4 4h2v2h-2zm0-4h2v2h-2zm-4 4h2v2h-2z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
    </svg>`,
  reset: `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
      <path d="M3 3v5h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
    </svg>`,
  edit: `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
      <path d="M18.5 2.5a2.12 2.12 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5Z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
    </svg>`,
  trash: `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3 6h18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
    </svg>`,
  more: `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="1.5" fill="currentColor"></circle>
      <circle cx="6" cy="12" r="1.5" fill="currentColor"></circle>
      <circle cx="18" cy="12" r="1.5" fill="currentColor"></circle>
    </svg>`,
};

const linkForm = document.getElementById("link-form");
const slugInput = document.getElementById("slug");
const targetUrlInput = document.getElementById("target-url");
const linkPreview = document.getElementById("link-preview");
const redirectTypeInput = document.getElementById("redirect-type");
const tagsInput = document.getElementById("tags");
const groupIdInput = document.getElementById("group-id");
const goLiveAtInput = document.getElementById("go-live-at");
const expiresAtInput = document.getElementById("expires-at");
const expiredRedirectSection = document.getElementById("expired-redirect-section");
const expiredRedirectUnavailable = document.getElementById("expired-redirect-unavailable");
const expiredRedirectModeResponse = document.getElementById("expired-redirect-mode-response");
const expiredRedirectModeUrl = document.getElementById("expired-redirect-mode-url");
const expiredRedirectUrlField = document.getElementById("expired-redirect-url-field");
const expiredRedirectUrlInput = document.getElementById("expired-redirect-url");
const passwordInput = document.getElementById("password");
const abEnabledInput = document.getElementById("ab-enabled");
const abTargetUrlInput = document.getElementById("ab-target-url");
const abWeightBInput = document.getElementById("ab-weight-b");
const abTestingSection = document.getElementById("ab-testing-section");
const abTestingUnavailable = document.getElementById("ab-testing-unavailable");
const smartRoutingEnabledInput = document.getElementById("smart-routing-enabled");
const smartRoutingSection = document.getElementById("smart-routing-section");
const smartRoutingUnavailable = document.getElementById("smart-routing-unavailable");
const smartRoutingRulesContainer = document.getElementById("smart-routing-rules");
const smartRoutingCount = document.getElementById("smart-routing-count");
const smartRoutingFallback = document.getElementById("smart-routing-fallback");
const smartRoutingError = document.getElementById("smart-routing-error");
const smartRoutingConflict = document.getElementById("smart-routing-conflict");
const smartRoutingInvalid = document.getElementById("smart-routing-invalid");
const clearSmartInvalidButton = document.getElementById("clear-smart-invalid-button");
const addSmartRuleButton = document.getElementById("add-smart-rule-button");
const domainWarning = document.getElementById("domain-warning");
const utmSourceInput = document.getElementById("utm-source");
const utmMediumInput = document.getElementById("utm-medium");
const utmCampaignInput = document.getElementById("utm-campaign");
const utmContentInput = document.getElementById("utm-content");
const utmTermInput = document.getElementById("utm-term");
const utmPreview = document.getElementById("utm-preview");
const submitButton = document.getElementById("submit-button");
const cancelButton = document.getElementById("cancel-button");
const generateSlugButton = document.getElementById("generate-slug-button");
const searchForm = document.getElementById("search-form");
const searchTermInput = document.getElementById("search-term");
const searchGroupIdInput = document.getElementById("search-group-id");
const groupTreeContainer = document.getElementById("group-tree");
const groupStatus = document.getElementById("group-status");
const groupCreateNameInput = document.getElementById("group-create-name");
const groupCreateParentSelect = document.getElementById("group-create-parent");
const groupCreateButton = document.getElementById("group-create-button");
const groupMoveSourceSelect = document.getElementById("group-move-source");
const groupMoveTargetSelect = document.getElementById("group-move-target");
const groupMovePath = document.getElementById("group-move-path");
const groupMoveButton = document.getElementById("group-move-button");
const groupExpandAllButton = document.getElementById("group-expand-all");
const groupCollapseAllButton = document.getElementById("group-collapse-all");
const groupRefreshButton = document.getElementById("group-refresh");
const formTitle = document.getElementById("form-title");
const formStatus = document.getElementById("form-status");
const listStatus = document.getElementById("list-status");
const linksList = document.getElementById("links-list");
const linksCount = document.getElementById("links-count");
const appVersion = document.getElementById("app-version");
const footerYear = document.getElementById("footer-year");
const footerTimezone = document.getElementById("footer-timezone");
const appOrigin = window.location.origin;
let appTimeZone = "America/Sao_Paulo";
let previewTimer = null;

function buttonMarkup(icon, label) {
  return `${ICONS[icon]}<span class="button-text">${label}</span>`;
}

function cardActionMarkup(action, variant, icon, label, slug) {
  const safeSlug = escapeHtml(slug);
  return `
    <button
      type="button"
      class="${variant}"
      data-action="${action}"
      data-slug="${safeSlug}"
      aria-label="${label}"
      title="${label}"
    >
      ${buttonMarkup(icon, label)}
    </button>
  `;
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new Error(payload?.error || "Falha inesperada");
  }

  return payload;
}

function setStatus(element, message, type = "") {
  element.textContent = message || "";
  element.className = type ? `status ${type}` : "status";
}

function setBusy(button, isBusy) {
  button.disabled = isBusy;
  button.setAttribute("aria-busy", String(isBusy));
}

function buildShortLink(slug) {
  return new URL(`/${slug}`, appOrigin).toString();
}

function parseTags(value) {
  const tags = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return tags.length ? tags : undefined;
}

function toIsoDateTime(localValue) {
  if (!localValue) {
    return undefined;
  }

  const iso = localDateTimeToIsoInTimeZone(localValue, appTimeZone);
  return iso || undefined;
}

function toLocalInputDateTime(value) {
  if (!value) {
    return "";
  }

  return isoToLocalInputInTimeZone(value, appTimeZone);
}

function isValidTimeZone(value) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function localDateTimeToIsoInTimeZone(value, timeZone) {
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) {
    return null;
  }

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const hour = Number.parseInt(match[4], 10);
  const minute = Number.parseInt(match[5], 10);
  const second = Number.parseInt(match[6] || "0", 10);

  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }

  const desiredUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let guessUtc = desiredUtc;

  for (let i = 0; i < 4; i += 1) {
    const zoned = getZonedParts(guessUtc, timeZone);
    if (!zoned) {
      return null;
    }

    const zonedAsUtc = Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute, zoned.second);
    const delta = desiredUtc - zonedAsUtc;
    guessUtc += delta;
    if (delta === 0) {
      break;
    }
  }

  const finalZoned = getZonedParts(guessUtc, timeZone);
  if (!finalZoned
    || finalZoned.year !== year
    || finalZoned.month !== month
    || finalZoned.day !== day
    || finalZoned.hour !== hour
    || finalZoned.minute !== minute
    || finalZoned.second !== second) {
    return null;
  }

  return new Date(guessUtc).toISOString();
}

function isoToLocalInputInTimeZone(value, timeZone) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const parts = getZonedParts(date.getTime(), timeZone);
  if (!parts) {
    return "";
  }

  const pad = (number) => String(number).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

function getZonedParts(timestamp, timeZone) {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      hourCycle: "h23",
    });
    const map = new Map(formatter.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]));
    return {
      year: Number.parseInt(map.get("year") || "", 10),
      month: Number.parseInt(map.get("month") || "", 10),
      day: Number.parseInt(map.get("day") || "", 10),
      hour: Number.parseInt(map.get("hour") || "", 10),
      minute: Number.parseInt(map.get("minute") || "", 10),
      second: Number.parseInt(map.get("second") || "", 10),
    };
  } catch {
    return null;
  }
}

function buildUtmUrl(baseUrl) {
  if (!baseUrl) {
    return "";
  }

  try {
    const parsed = new URL(baseUrl);
    const entries = [
      ["utm_source", utmSourceInput.value.trim()],
      ["utm_medium", utmMediumInput.value.trim()],
      ["utm_campaign", utmCampaignInput.value.trim()],
      ["utm_content", utmContentInput.value.trim()],
      ["utm_term", utmTermInput.value.trim()],
    ];

    entries.forEach(([key, value]) => {
      if (value) {
        parsed.searchParams.set(key, value);
      } else {
        parsed.searchParams.delete(key);
      }
    });

    return parsed.toString();
  } catch {
    return "";
  }
}

function refreshUtmPreview() {
  const url = buildUtmUrl(targetUrlInput.value.trim());
  utmPreview.textContent = url ? `Preview UTM: ${url}` : "Preview UTM: -";
}

function refreshDomainWarning() {
  const targetValue = targetUrlInput.value.trim();
  if (!targetValue) {
    domainWarning.style.display = "none";
    return;
  }

  try {
    const sourceHost = new URL(appOrigin).hostname;
    const targetHost = new URL(targetValue).hostname;
    domainWarning.style.display = sourceHost !== targetHost ? "block" : "none";
  } catch {
    domainWarning.style.display = "none";
  }
}

function renderLinkPreview(preview) {
  if (!preview || (!preview.title && !preview.description && !preview.image)) {
    linkPreview.style.display = "none";
    linkPreview.innerHTML = "";
    return;
  }

  const title = preview.title ? escapeHtml(preview.title) : escapeHtml(preview.domain || "Destino");
  const description = preview.description ? escapeHtml(preview.description) : "Sem descrição disponível.";
  const previewImageUrl = preview.image || "";
  let isImageAllowed = false;
  if (previewImageUrl) {
    try {
      const imageUrl = new URL(previewImageUrl, appOrigin);
      isImageAllowed = imageUrl.origin === appOrigin || imageUrl.protocol === "data:";
    } catch {
      isImageAllowed = false;
    }
  }
  const imageMarkup = isImageAllowed
    ? `<img src="${escapeHtml(previewImageUrl)}" alt="Preview" style="width:100%;max-height:160px;object-fit:cover;border-radius:8px;margin-bottom:10px;" />`
    : "";
  const imageHint = previewImageUrl && !isImageAllowed
    ? '<p style="margin:0 0 8px;font-size:.78rem;color:var(--muted);">Imagem de preview indisponível neste ambiente por política de segurança (CSP).</p>'
    : "";

  linkPreview.style.display = "block";
  linkPreview.innerHTML = `
    ${imageMarkup}
    ${imageHint}
    <strong style="display:block;margin-bottom:6px;">${title}</strong>
    <p style="margin:0;font-size:.86rem;color:var(--muted);">${description}</p>
  `;
}

async function fetchLinkPreview(url) {
  if (!url) {
    renderLinkPreview(null);
    return;
  }

  try {
    const payload = await request(`/api/preview?url=${encodeURIComponent(url)}`, { method: "GET" });
    renderLinkPreview(payload.preview || null);
  } catch {
    renderLinkPreview(null);
  }
}

function schedulePreviewLoad() {
  if (previewTimer) {
    clearTimeout(previewTimer);
  }
  previewTimer = setTimeout(() => {
    fetchLinkPreview(targetUrlInput.value.trim());
  }, 350);
}

/**
 * Group requests never reuse the throwing helper: a refused move or delete must
 * be shown as a message and must never be retried or applied optimistically, so
 * the status travels back with the payload.
 */
async function groupRequest(path, options = {}) {
  try {
    const response = await fetch(path, {
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      ...options,
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      return { ok: false, status: response.status, error: payload?.error || "Falha inesperada" };
    }

    return { ok: true, status: response.status, payload };
  } catch (error) {
    return { ok: false, status: 0, error: error.message };
  }
}

function groupOption(value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
}

/**
 * Rebuilds one select from `{ value, label }` pairs, keeping the previous
 * selection when it still exists. Every label is written with `textContent`:
 * group names and full paths are persisted data.
 */
function fillGroupSelect(select, placeholder, options, preferredValue) {
  const previous = preferredValue === undefined ? select.value : preferredValue;
  const next = [groupOption("", placeholder)];
  (options || []).forEach((entry) => {
    next.push(groupOption(entry.value, entry.label));
  });
  select.replaceChildren(...next);
  select.value = next.some((option) => option.value === previous) ? previous : "";
}

function expandedGroupIds(tree) {
  const expanded = new Set();
  tree.byId.forEach((_group, id) => {
    if (!state.collapsedGroups.has(id)) {
      expanded.add(id);
    }
  });
  return expanded;
}

function groupNodeButton(action, label, title, row) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary compact";
  button.dataset.groupAction = action;
  button.textContent = label;
  // The path, not the bare name, so repeated names stay distinguishable.
  button.setAttribute("aria-label", `${title}: ${row.path}`);
  button.title = button.getAttribute("aria-label");
  return button;
}

/**
 * One tree row. Built with `createElement`, `textContent` and `setAttribute` only:
 * a group name or path never reaches an HTML sink.
 */
function buildGroupNode(row) {
  const container = document.createElement("div");
  container.className = "group-node";
  container.dataset.groupId = String(row.group.id);

  if (row.hasChildren) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "secondary compact group-node-toggle";
    toggle.dataset.groupAction = "toggle";
    toggle.setAttribute("aria-expanded", String(row.expanded));
    toggle.setAttribute("aria-label", `${row.expanded ? "Recolher" : "Expandir"} subgrupos de ${row.path}`);
    toggle.title = toggle.getAttribute("aria-label");
    toggle.textContent = row.expanded ? "▾" : "▸";
    container.append(toggle);
  } else {
    const spacer = document.createElement("span");
    spacer.className = "group-node-toggle-spacer";
    spacer.setAttribute("aria-hidden", "true");
    container.append(spacer);
  }

  const main = document.createElement("div");
  main.className = "group-node-main";
  const name = document.createElement("span");
  name.className = "group-node-name";
  name.textContent = row.group.name;
  const path = document.createElement("span");
  path.className = "group-node-path";
  path.textContent = row.path;
  main.append(name, path);
  container.append(main);

  const actions = document.createElement("div");
  actions.className = "group-node-actions";
  actions.append(
    groupNodeButton("move", "Mover", "Mover grupo", row),
    groupNodeButton("delete", "Excluir", "Excluir grupo", row),
  );
  container.append(actions);

  return container;
}

function renderGroupTree() {
  const tree = state.groupTree;
  groupTreeContainer.replaceChildren();

  if (!tree) {
    return;
  }

  const rows = groupHierarchyUi.flattenTree(tree, expandedGroupIds(tree));
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "group-tree-empty";
    empty.textContent = "Nenhum grupo criado ainda.";
    groupTreeContainer.append(empty);
    return;
  }

  // The host is a plain <div>, and an <li> is only valid inside <ul>/<ol>: the
  // first level gets a list of its own. Every deeper level nests the same way, so
  // the depth of each row decides which <ul> receives its <li> and the indent stays
  // structural instead of a computed padding.
  const rootList = document.createElement("ul");
  groupTreeContainer.append(rootList);
  const listStack = [rootList];
  rows.forEach((row) => {
    while (listStack.length > row.depth) {
      listStack.pop();
    }
    const list = listStack[listStack.length - 1];
    const item = document.createElement("li");
    item.append(buildGroupNode(row));
    const childList = document.createElement("ul");
    item.append(childList);
    list.append(item);
    listStack.push(childList);
  });
}

/** A governed failure: the panel explains it and never renders a partial tree. */
function renderGroupTreeFailure(message) {
  state.groupTree = null;
  groupTreeContainer.replaceChildren();
  const notice = document.createElement("p");
  notice.className = "group-tree-empty error-text";
  notice.textContent = message;
  groupTreeContainer.append(notice);
}

function refreshGroupSelects() {
  const tree = state.groupTree;
  // The link form, the create form and the move source all list every group by
  // full path so equal names stay distinguishable.
  const options = tree ? groupHierarchyUi.parentOptions(tree, null) : [];

  fillGroupSelect(groupIdInput, "Sem grupo", options, groupIdInput.value);
  fillGroupSelect(groupCreateParentSelect, "Sem grupo pai (raiz)", options, groupCreateParentSelect.value);
  fillGroupSelect(groupMoveSourceSelect, "Escolha um grupo", options, groupMoveSourceSelect.value);
  // The filter keeps its own sentinel for "no group", restored when still offered.
  fillGroupSelect(
    searchGroupIdInput,
    "Todos os grupos",
    [groupOption("__none__", "Sem grupo")].concat(options),
    searchGroupIdInput.value,
  );

  refreshMoveForm();
}

/** Full-path context for the selected group, plus its still-possible parents. */
function refreshMoveForm() {
  const tree = state.groupTree;
  const sourceValue = groupMoveSourceSelect.value;
  const groupId = sourceValue ? Number(sourceValue) : null;

  if (!tree || !groupId) {
    fillGroupSelect(groupMoveTargetSelect, "Sem grupo pai (raiz)", [], "");
    groupMovePath.textContent = "Selecione um grupo para ver o caminho completo.";
    return;
  }

  const path = groupHierarchyUi.groupPath(tree.byId, groupId);
  const group = tree.byId.get(groupId);
  const parentId = group ? group.parentId : null;
  const currentParentPath = parentId === null
    ? "raiz"
    : groupHierarchyUi.groupPath(tree.byId, parentId);

  // The group and its subtree are hidden from the target list: a display
  // convenience, since the API refuses such a move regardless.
  const options = groupHierarchyUi.parentOptions(tree, groupId);
  fillGroupSelect(groupMoveTargetSelect, "Sem grupo pai (raiz)", options, parentId === null ? "" : String(parentId));

  groupMovePath.textContent = `Caminho atual: ${path} (pai: ${currentParentPath}). Máximo de ${groupHierarchyUi.MAX_DEPTH} níveis.`;
}

async function loadGroups() {
  if (!groupHierarchyUi) {
    renderGroupTreeFailure("Módulo de hierarquia de grupos indisponível nesta página.");
    return;
  }

  const result = await groupRequest("/api/groups", { method: "GET" });

  if (!result.ok) {
    // Includes the corrupt-hierarchy 409: the panel shows the failure instead of
    // assembling a partial tree or repairing anything on its own.
    renderGroupTreeFailure(groupHierarchyUi.groupErrorMessage(result.error));
    refreshGroupSelects();
    return;
  }

  const tree = groupHierarchyUi.buildTree(result.payload?.groups);
  if (!tree.ok) {
    renderGroupTreeFailure(groupHierarchyUi.ERROR_MESSAGES.CORRUPT);
    refreshGroupSelects();
    return;
  }

  state.groupTree = tree;
  renderGroupTree();
  refreshGroupSelects();
}

async function createGroupFromPanel() {
  const name = groupCreateNameInput.value.trim();
  if (!name) {
    setStatus(groupStatus, "Informe o nome do grupo antes de criar.", "error");
    return;
  }

  const parentValue = groupCreateParentSelect.value;
  // `parentId` absent means root, which is the exact CREATE contract.
  const body = parentValue ? { name, parentId: Number(parentValue) } : { name };
  setBusy(groupCreateButton, true);
  try {
    const result = await groupRequest("/api/groups", { method: "POST", body: JSON.stringify(body) });
    if (!result.ok) {
      setStatus(groupStatus, groupHierarchyUi.groupErrorMessage(result.error), "error");
      return;
    }

    groupCreateNameInput.value = "";
    await loadGroups();
    setStatus(groupStatus, `Grupo "${result.payload.group.name}" criado.`, "success");
  } finally {
    setBusy(groupCreateButton, false);
  }
}

async function moveSelectedGroup() {
  const tree = state.groupTree;
  const sourceValue = groupMoveSourceSelect.value;
  if (!tree || !sourceValue) {
    setStatus(groupStatus, "Escolha o grupo que deve ser movido.", "error");
    return;
  }

  const groupId = Number(sourceValue);
  const group = tree.byId.get(groupId);
  if (!group) {
    setStatus(groupStatus, groupHierarchyUi.ERROR_MESSAGES.NOT_FOUND, "error");
    return;
  }

  const targetValue = groupMoveTargetSelect.value;
  const targetParentId = targetValue ? Number(targetValue) : null;
  const path = groupHierarchyUi.groupPath(tree.byId, groupId);

  setBusy(groupMoveButton, true);
  try {
    const result = await groupRequest(`/api/groups/${groupId}`, {
      method: "PATCH",
      // The parent observed in the loaded snapshot is the precondition, sent in
      // the same request as the new one. A move that happened meanwhile makes the
      // API answer 409 instead of overwriting it.
      body: JSON.stringify({ parentId: targetParentId, expectedParentId: group.parentId }),
    });

    if (!result.ok) {
      // No automatic retry: reload so the panel reflects the current state, then
      // report why the move was refused.
      await loadGroups();
      setStatus(groupStatus, groupHierarchyUi.groupErrorMessage(result.error), "error");
      return;
    }

    await loadGroups();
    setStatus(groupStatus, `Grupo "${path}" movido.`, "success");
  } finally {
    setBusy(groupMoveButton, false);
  }
}

async function deleteGroupFromPanel(groupId) {
  const tree = state.groupTree;
  const group = tree ? tree.byId.get(groupId) : null;
  if (!tree || !group) {
    setStatus(groupStatus, groupHierarchyUi.ERROR_MESSAGES.NOT_FOUND, "error");
    return;
  }

  const path = groupHierarchyUi.groupPath(tree.byId, groupId);
  const confirmed = window.confirm(
    `Excluir o grupo "${path}"? A exclusão só é permitida quando o grupo não tem subgrupos nem links.`,
  );
  if (!confirmed) {
    return;
  }

  const result = await groupRequest(`/api/groups/${groupId}`, { method: "DELETE" });
  if (!result.ok) {
    // Nothing is removed from the panel: the API refused the deletion.
    await loadGroups();
    setStatus(groupStatus, groupHierarchyUi.groupErrorMessage(result.error), "error");
    return;
  }

  await loadGroups();
  setStatus(groupStatus, `Grupo "${path}" excluído.`, "success");
}

function toggleGroupExpansion(groupId) {
  if (state.collapsedGroups.has(groupId)) {
    state.collapsedGroups.delete(groupId);
  } else {
    state.collapsedGroups.add(groupId);
  }
  renderGroupTree();
}

async function markQrCodeGenerated(slug) {
  try {
    await request(`/api/links/${encodeURIComponent(slug)}/qrcode`, { method: "POST" });
  } catch {
    // Keep UX resilient even if the QR flag fails
  }
}

async function downloadQrForSlug(slug) {
  const shortLink = buildShortLink(slug);
  const response = await fetch(`/api/links/${encodeURIComponent(slug)}/qrcode`, {
    method: "GET",
    credentials: "same-origin",
  });

  if (!response.ok) {
    throw new Error("Falha ao gerar QR Code");
  }

  const svgText = await response.text();
  const svgBlob = new Blob([svgText], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(svgBlob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${slug}-qrcode.svg`;
  anchor.click();
  URL.revokeObjectURL(url);
  return shortLink;
}

function setAbWeightBValue(rawWeight) {
  const weight = Number(rawWeight);
  if (!Number.isInteger(weight) || weight < 1 || weight > 99) {
    abWeightBInput.value = "50";
    return;
  }

  const value = String(weight);
  if (!Array.from(abWeightBInput.options).some((option) => option.value === value)) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = `A ${100 - weight}% / B ${weight}%`;
    option.dataset.custom = "1";
    abWeightBInput.appendChild(option);
  }
  abWeightBInput.value = value;
}

function clearCustomAbWeightOptions() {
  Array.from(abWeightBInput.options)
    .filter((option) => option.dataset.custom === "1")
    .forEach((option) => option.remove());
}

function isSmartRoutingActive() {
  return state.smartRouting && smartRoutingEnabledInput.checked;
}

// A/B and Smart Routing both require a temporary redirect. The helper is
// shared so the 301 constraint cannot diverge between the two editors.
function syncRedirectConstraint() {
  const temporaryRequired = smartRoutingUi
    ? smartRoutingUi.requiresTemporaryRedirect({ abEnabled: abEnabledInput.checked, smartEnabled: isSmartRoutingActive() })
    : (abEnabledInput.checked || isSmartRoutingActive());
  const option301 = redirectTypeInput.querySelector('option[value="301"]');

  if (option301) {
    option301.disabled = temporaryRequired;
  }

  const resolvedType = smartRoutingUi
    ? smartRoutingUi.resolveRedirectType(redirectTypeInput.value, temporaryRequired)
    : (temporaryRequired && redirectTypeInput.value === "301" ? "302" : redirectTypeInput.value);
  if (redirectTypeInput.value !== resolvedType) {
    redirectTypeInput.value = resolvedType;
  }
}

abEnabledInput.addEventListener("change", () => {
  const transition = smartRoutingUi
    ? smartRoutingUi.resolveModeTransition({ abEnabled: abEnabledInput.checked, smartEnabled: smartRoutingEnabledInput.checked }, "ab")
    : null;
  if (transition) {
    abEnabledInput.checked = transition.abEnabled;
    smartRoutingEnabledInput.checked = transition.smartEnabled;
    setSmartRoutingConflict(transition.notice);
  }
  syncRedirectConstraint();
  updateSmartRoutingCount();
  setSmartRoutingError("");
});

[expiredRedirectModeResponse, expiredRedirectModeUrl].forEach((input) => {
  if (input) {
    input.addEventListener("change", syncExpiredRedirectConstraint);
  }
});

// `input` covers typing a date and `change` covers picking one, and both keep the
// destination from outliving the expiration it depends on.
expiresAtInput.addEventListener("input", syncExpiredRedirectConstraint);
expiresAtInput.addEventListener("change", syncExpiredRedirectConstraint);

function setSmartRoutingConflict(message) {
  if (!smartRoutingConflict) {
    return;
  }
  smartRoutingConflict.textContent = message || "";
  smartRoutingConflict.hidden = !message;
}

function setSmartRoutingError(message) {
  if (!smartRoutingError) {
    return;
  }
  smartRoutingError.textContent = message || "";
  smartRoutingError.hidden = !message;
}

/**
 * Preserved corrupt state notice. `link` is only used to read the boolean
 * `smartRoutingStatus`; the copy is a fixed string assigned through
 * textContent, so the raw persisted configuration is never rendered.
 */
function setSmartRoutingInvalidState(link) {
  const notice = link && smartRoutingUi ? smartRoutingUi.smartInvalidNotice(link) : "";
  state.smartRoutingCorrupt = Boolean(notice);
  if (smartRoutingInvalid) {
    smartRoutingInvalid.textContent = notice;
    smartRoutingInvalid.hidden = !notice;
  }
  if (clearSmartInvalidButton) {
    clearSmartInvalidButton.hidden = !notice;
  }
}

function updateSmartRoutingCount() {
  if (smartRoutingCount) {
    smartRoutingCount.textContent = `${state.smartRules.length} / ${MAX_SMART_RULES}`;
  }
  if (addSmartRuleButton) {
    addSmartRuleButton.disabled = !state.smartRouting || state.smartRules.length >= MAX_SMART_RULES;
  }
}

function refreshSmartFallback() {
  if (!smartRoutingFallback) {
    return;
  }
  const value = targetUrlInput.value.trim();
  smartRoutingFallback.textContent = value ? `Fallback: ${value}` : "Fallback: destino principal do link";
}

function createSmartSelect(labelText, className, options, selectedValue) {
  const label = document.createElement("label");
  label.className = "smart-rule-field";

  const span = document.createElement("span");
  span.className = "field-label";
  span.textContent = labelText;

  const select = document.createElement("select");
  select.className = className;
  select.setAttribute("aria-describedby", "smart-routing-error");
  options.forEach((option) => {
    const optionElement = document.createElement("option");
    optionElement.value = option.value;
    optionElement.textContent = option.label;
    select.appendChild(optionElement);
  });
  select.value = selectedValue || "";

  label.appendChild(span);
  label.appendChild(select);
  return label;
}

function clearSmartRuleInvalidState() {
  smartRoutingRulesContainer.querySelectorAll("[aria-invalid]").forEach((element) => {
    element.removeAttribute("aria-invalid");
  });
}

// Moves focus to the first invalid rule control instead of the toggle, so the
// operator lands on the field that actually needs attention.
function focusFirstInvalidSmartRule() {
  clearSmartRuleInvalidState();
  if (!smartRoutingUi) {
    return;
  }
  collectSmartRules();
  const index = smartRoutingUi.findFirstInvalidRuleIndex(state.smartRules);
  if (index < 0) {
    return;
  }
  const row = smartRoutingRulesContainer.querySelectorAll(".smart-rule")[index];
  if (!row) {
    return;
  }
  const field = smartRoutingUi.firstInvalidField(state.smartRules[index]);
  const control = row.querySelector(
    field === "country" ? ".smart-rule-country" : field === "device" ? ".smart-rule-device" : ".smart-rule-url",
  );
  if (control) {
    control.setAttribute("aria-invalid", "true");
    control.focus();
  }
}

function createSmartRuleButton(action, label, text, disabled) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary compact smart-rule-button";
  button.dataset.smartAction = action;
  button.setAttribute("aria-label", label);
  button.title = label;
  button.textContent = text;
  button.disabled = disabled;
  return button;
}

// All rule values are inserted through DOM APIs (value/textContent). No rule,
// country, URL or error string ever reaches innerHTML.
function renderSmartRules() {
  if (!smartRoutingRulesContainer) {
    return;
  }
  smartRoutingRulesContainer.replaceChildren();

  const countries = smartRoutingUi
    ? smartRoutingUi.countryOptions()
    : [{ value: "", label: "Qualquer país" }];
  const devices = smartRoutingUi
    ? smartRoutingUi.deviceOptions()
    : [{ value: "", label: "Qualquer dispositivo" }];

  state.smartRules.forEach((rule, index) => {
    const row = document.createElement("div");
    row.className = "smart-rule";
    row.dataset.index = String(index);

    row.appendChild(createSmartSelect("País", "smart-rule-country", countries, rule.country));
    row.appendChild(createSmartSelect("Dispositivo", "smart-rule-device", devices, rule.device));

    const urlLabel = document.createElement("label");
    urlLabel.className = "smart-rule-field";
    const urlSpan = document.createElement("span");
    urlSpan.className = "field-label";
    urlSpan.textContent = "Destino";
    const urlInput = document.createElement("input");
    urlInput.type = "url";
    urlInput.className = "smart-rule-url";
    urlInput.placeholder = "https://exemplo.com/destino";
    urlInput.setAttribute("aria-describedby", "smart-routing-error");
    urlInput.value = rule.url || "";
    urlLabel.appendChild(urlSpan);
    urlLabel.appendChild(urlInput);
    row.appendChild(urlLabel);

    const actions = document.createElement("div");
    actions.className = "smart-rule-actions";
    actions.appendChild(createSmartRuleButton("up", "Mover regra para cima", "↑", index === 0));
    actions.appendChild(createSmartRuleButton("down", "Mover regra para baixo", "↓", index === state.smartRules.length - 1));
    actions.appendChild(createSmartRuleButton("remove", "Remover regra", "Remover", false));
    row.appendChild(actions);

    smartRoutingRulesContainer.appendChild(row);
  });

  updateSmartRoutingCount();
  refreshSmartFallback();
}

function collectSmartRules() {
  if (!smartRoutingRulesContainer) {
    return state.smartRules;
  }
  const rows = Array.from(smartRoutingRulesContainer.querySelectorAll(".smart-rule"));
  state.smartRules = rows.map((row) => ({
    country: row.querySelector(".smart-rule-country")?.value || "",
    device: row.querySelector(".smart-rule-device")?.value || "",
    url: row.querySelector(".smart-rule-url")?.value || "",
  }));
  return state.smartRules;
}

smartRoutingEnabledInput.addEventListener("change", () => {
  const transition = smartRoutingUi
    ? smartRoutingUi.resolveModeTransition({ abEnabled: abEnabledInput.checked, smartEnabled: smartRoutingEnabledInput.checked }, "smart")
    : null;
  if (transition) {
    abEnabledInput.checked = transition.abEnabled;
    smartRoutingEnabledInput.checked = transition.smartEnabled;
    setSmartRoutingConflict(transition.notice);
  } else if (!smartRoutingEnabledInput.checked) {
    setSmartRoutingConflict("");
  }

  if (smartRoutingEnabledInput.checked && !state.smartRules.length) {
    state.smartRules.push({ country: "", device: "", url: "" });
  }
  syncRedirectConstraint();
  renderSmartRules();
  setSmartRoutingError("");
});

/**
 * Explicit clear of a preserved corrupt configuration. It only arms the flag
 * and delegates to the form submit so the shared payload builder stays the
 * single request authority; every other save path omits the field entirely.
 */
clearSmartInvalidButton.addEventListener("click", () => {
  if (!state.smartRoutingCorrupt || !state.smartRouting) {
    return;
  }
  state.smartClearInvalid = true;
  linkForm.requestSubmit();
});

addSmartRuleButton.addEventListener("click", () => {
  if (!state.smartRouting) {
    return;
  }
  if (state.smartRules.length >= MAX_SMART_RULES) {
    setSmartRoutingError(smartRoutingUi ? smartRoutingUi.smartErrorMessage("TOO_MANY_RULES") : "Limite de regras atingido.");
    return;
  }
  collectSmartRules();
  state.smartRules.push({ country: "", device: "", url: "" });
  renderSmartRules();
  setSmartRoutingError("");
  const lastUrl = smartRoutingRulesContainer.querySelector(".smart-rule:last-child .smart-rule-url");
  if (lastUrl) {
    lastUrl.focus();
  }
});

smartRoutingRulesContainer.addEventListener("input", (event) => {
  if (event.target.matches(".smart-rule-url")) {
    collectSmartRules();
    clearSmartRuleInvalidState();
    setSmartRoutingError("");
  }
});

smartRoutingRulesContainer.addEventListener("change", (event) => {
  if (event.target.matches(".smart-rule-country, .smart-rule-device")) {
    collectSmartRules();
    clearSmartRuleInvalidState();
    setSmartRoutingError("");
  }
});

smartRoutingRulesContainer.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-smart-action]");
  if (!button) {
    return;
  }
  collectSmartRules();
  const row = button.closest(".smart-rule");
  const index = row ? Number(row.dataset.index) : -1;
  const action = button.dataset.smartAction;

  if (action === "remove") {
    state.smartRules.splice(index, 1);
    if (!state.smartRules.length) {
      // Removing the last rule disables the feature locally instead of
      // sending an invalid empty array.
      smartRoutingEnabledInput.checked = false;
      setSmartRoutingConflict("Smart Routing foi desativado porque não há regras.");
      syncRedirectConstraint();
    }
    renderSmartRules();
    setSmartRoutingError("");
    return;
  }

  if (smartRoutingUi) {
    state.smartRules = smartRoutingUi.moveRule(state.smartRules, index, action);
  }
  renderSmartRules();
});

function resetForm() {
  state.editingSlug = null;
  linkForm.reset();
  redirectTypeInput.value = "302";
  abEnabledInput.checked = false;
  abTargetUrlInput.value = "";
  clearCustomAbWeightOptions();
  abWeightBInput.value = "50";
  smartRoutingEnabledInput.checked = false;
  state.smartRules = [];
  state.smartRoutingCorrupt = false;
  state.smartClearInvalid = false;
  setSmartRoutingConflict("");
  setSmartRoutingError("");
  setSmartRoutingInvalidState(null);
  clearSmartRuleInvalidState();
  // The expired destination belongs to one record only: the default selection is
  // restored so nothing from the previous link can survive into the next save.
  setExpiredRedirectMode(EXPIRED_MODE_RESPONSE);
  syncExpiredRedirectConstraint();
  syncRedirectConstraint();
  renderSmartRules();
  slugInput.readOnly = false;
  formTitle.textContent = "Criar link";
  submitButton.innerHTML = buttonMarkup("save", "Salvar link");
  cancelButton.innerHTML = buttonMarkup("cancel", "Cancelar");
  cancelButton.hidden = true;
  setStatus(formStatus, "");
  refreshUtmPreview();
  refreshDomainWarning();
  renderLinkPreview(null);
}

function beginEdit(link) {
  state.editingSlug = link.slug;
  slugInput.value = link.slug;
  targetUrlInput.value = link.target_url;
  redirectTypeInput.value = link.redirect_type || "302";
  tagsInput.value = (() => {
    try {
      return (JSON.parse(link.tags || "[]") || []).join(", ");
    } catch {
      return "";
    }
  })();
  groupIdInput.value = link.group_id == null ? "" : String(link.group_id);
  goLiveAtInput.value = toLocalInputDateTime(link.go_live_at);
  expiresAtInput.value = toLocalInputDateTime(link.expires_at);
  // Populated before anything else can recompute it, so a link that already has a
  // destination reloads that destination and an unrelated edit re-sends it as is.
  applyExpiredRedirectSelection(link);
  passwordInput.value = "";
  abEnabledInput.checked = link.ab_enabled === 1;
  abTargetUrlInput.value = link.ab_target_url || "";
  clearCustomAbWeightOptions();
  setAbWeightBValue(link.ab_weight_b);

  const loadedSmartRules = state.smartRouting
    ? (smartRoutingUi ? smartRoutingUi.normalizeLoadedRules(link.smartRoutingRules) : [])
    : [];
  smartRoutingEnabledInput.checked = state.smartRouting && loadedSmartRules.length > 0;
  state.smartRules = loadedSmartRules;
  state.smartClearInvalid = false;
  // A corrupt persisted value loads as "preserved", never as ordinary off: the
  // notice stays visible and nothing is written unless the operator repairs or
  // explicitly clears it.
  setSmartRoutingInvalidState(state.smartRouting ? link : null);
  setSmartRoutingConflict(
    state.smartRouting && link.ab_enabled === 1 && (loadedSmartRules.length > 0 || state.smartRoutingCorrupt)
      ? "Estado persistido ambíguo: Split Test A/B e Smart Routing estão configurados. O redirect público usa o destino principal."
      : "",
  );
  setSmartRoutingError("");

  syncRedirectConstraint();
  renderSmartRules();
  slugInput.readOnly = true;
  formTitle.textContent = `Editar /${link.slug}`;
  submitButton.innerHTML = buttonMarkup("update", "Atualizar");
  cancelButton.innerHTML = buttonMarkup("cancel", "Cancelar");
  cancelButton.hidden = false;
  setStatus(formStatus, "Slug travado após criação; altere apenas o destino.");
  targetUrlInput.focus();
  refreshUtmPreview();
  refreshDomainWarning();
  schedulePreviewLoad();
}

function createClientSlug() {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(7);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

function renderAbMetrics(link) {
  const display = window.BoltLinkAbDisplay?.buildAbDisplay(link);
  if (!display) {
    return "";
  }

  const metrics = [
    `<span class="metric">Split A/B <strong>${display.title}</strong></span>`,
  ];

  if (display.showHistoricalLabel) {
    metrics.push('<span class="metric">Resultados do último teste</span>');
  }

  metrics.push(`<span class="metric">Cliques A <strong>${display.clicksA}</strong></span>`);
  metrics.push(`<span class="metric">Cliques B <strong>${display.clicksB}</strong></span>`);
  metrics.push(`<span class="metric">Distribuição observada <strong>${display.observed}</strong></span>`);

  if (display.allocation) {
    metrics.push(`<span class="metric">Alocação <strong>${display.allocation}</strong></span>`);
  }

  if (display.nextTest) {
    metrics.push(`<span class="metric">Próximo teste <strong>${escapeHtml(display.nextTest.allocation)} · ${escapeHtml(display.nextTest.targetUrl)}</strong></span>`);
  }

  return metrics.join("");
}

function renderSmartBadge(link) {
  const badge = smartRoutingUi ? smartRoutingUi.smartBadge(link, state.smartRouting) : null;
  if (!badge) {
    return "";
  }
  if (badge.corrupt) {
    return badge.conflict
      ? '<span class="metric">Smart Routing <strong>configuração inválida preservada</strong> · Split Test A/B ativo</span>'
      : '<span class="metric">Smart Routing <strong>configuração inválida preservada</strong></span>';
  }
  if (badge.conflict) {
    return '<span class="metric">Smart Routing <strong>configuração ambígua</strong></span>';
  }
  const suffix = badge.count === 1 ? "regra" : "regras";
  return `<span class="metric">Smart Routing <strong>${badge.count} ${suffix}</strong></span>`;
}

function formatDate(value) {
  if (!value) {
    return "Nunca";
  }

  try {
    return new Intl.DateTimeFormat("pt-BR", {
      dateStyle: "short",
      timeStyle: "short",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function renderLinks() {
  linksCount.textContent = String(state.links.length);

  if (!state.links.length) {
    linksList.innerHTML = '<div class="empty">Nenhum link ativo ainda. Preencha o formulário para criar o primeiro.</div>';
    return;
  }

  linksList.innerHTML = state.links
    .map((link) => {
      const safeSlug = escapeHtml(link.slug);
      const safeTargetUrl = escapeHtml(link.target_url);
      const isPendingDelete = state.pendingDeletes.has(link.slug);
      const cardClass = isPendingDelete ? "card is-pending" : "card";
      const actionMarkup = isPendingDelete
        ? cardActionMarkup("undo-delete", "secondary", "cancel", "Desfazer", link.slug)
        : `
          <div class="primary-actions">
            ${cardActionMarkup("copy", "secondary", "copy", "Copiar", link.slug)}
            ${cardActionMarkup("edit", "secondary", "edit", "Editar", link.slug)}
          </div>
          <details class="more-actions-dropdown">
            <summary class="secondary compact icon-btn" aria-label="Mais opções" title="Mais opções">
              ${ICONS.more}
            </summary>
            <div class="dropdown-menu">
              ${cardActionMarkup("qrcode", "secondary", "qrcode", "QR Code", link.slug)}
              ${cardActionMarkup("duplicate", "secondary", "duplicate", "Duplicar", link.slug)}
              ${cardActionMarkup("reset-clicks", "danger", "reset", "Zerar cliques", link.slug)}
              ${cardActionMarkup("delete", "danger", "trash", "Excluir", link.slug)}
            </div>
          </details>
        `;

      const parsedTags = (() => {
        try {
          return JSON.parse(link.tags || "[]");
        } catch {
          return [];
        }
      })();

      return `
        <article class="${cardClass}">
          <div class="card-top">
            <div class="slug-info">
              <p class="slug">/${safeSlug}</p>
              <div class="slug-url">${safeTargetUrl}</div>
              ${link.ab_enabled === 1 && link.ab_target_url ? `<div class="slug-url">Variant B: ${escapeHtml(link.ab_target_url)}</div>` : ""}
              ${link.group_name ? `<span class="group-badge">Grupo: ${escapeHtml(link.group_name)}</span>` : ""}
            </div>
            <div class="card-actions">
              ${actionMarkup}
            </div>
          </div>
          <div class="metrics">
            <span class="metric">Cliques <strong>${link.clicks_total}</strong></span>
            <span class="metric">Criado: <strong>${formatDate(link.created_at)}</strong></span>
            <span class="metric">Redirect <strong>${link.redirect_type || "302"}</strong></span>
            ${link.expires_at ? `<span class="metric">Expira <strong>${formatDate(link.expires_at)}</strong></span>` : ""}
            ${link.go_live_at ? `<span class="metric">Ativa <strong>${formatDate(link.go_live_at)}</strong></span>` : ""}
            ${link.has_qrcode ? '<span class="metric">QR <strong>Ativo</strong></span>' : ""}
            ${link.has_password ? '<span class="metric">Senha <strong>Protegido</strong></span>' : ""}
            ${renderAbMetrics(link)}
            ${renderSmartBadge(link)}
            ${parsedTags.length ? `<span class="metric">Tags <strong>${escapeHtml(parsedTags.join(", "))}</strong></span>` : ""}
            ${isPendingDelete ? `<span class="metric pending-note">Exclusão em <strong>${Math.ceil((state.pendingDeletes.get(link.slug)?.remaining || 0) / 1000)}s</strong></span>` : ""}
          </div>
        </article>
      `;
    })
    .join("");
}

async function loadLinks(searchTerm = searchTermInput.value, groupFilter = searchGroupIdInput.value) {
  const normalizedSearch = searchTerm.trim();
  const normalizedGroupFilter = String(groupFilter || "").trim();

  setStatus(
    listStatus,
    normalizedSearch || normalizedGroupFilter
      ? "Aplicando filtros..."
      : "Carregando links...",
  );

  try {
    const queryParams = new URLSearchParams();
    if (normalizedSearch) {
      queryParams.set("search", normalizedSearch);
    }
    if (normalizedGroupFilter) {
      queryParams.set("group_id", normalizedGroupFilter === "__none__" ? "null" : normalizedGroupFilter);
    }

    const queryString = queryParams.toString();
    const payload = await request(`/api/links${queryString ? `?${queryString}` : ""}`, { method: "GET" });
    state.links = payload.links || [];
    renderLinks();

    const hasAnyFilter = Boolean(normalizedSearch || normalizedGroupFilter);
    const groupLabel = normalizedGroupFilter === "__none__"
      ? "Sem grupo"
      : normalizedGroupFilter
        ? (searchGroupIdInput.options[searchGroupIdInput.selectedIndex]?.text || "Grupo")
        : "";
    const filterLabels = [
      normalizedSearch ? `texto: "${normalizedSearch}"` : "",
      groupLabel ? `grupo: ${groupLabel}` : "",
    ].filter(Boolean);

    setStatus(
      listStatus,
      hasAnyFilter
        ? `${state.links.length} resultado(s) para ${filterLabels.join(" | ")}.`
        : `${state.links.length} link(s) carregado(s).`,
    );
  } catch (error) {
    setStatus(listStatus, error.message, "error");
  }
}

async function loadCapabilities() {
  try {
    const payload = await request("/api/capabilities", { method: "GET" });
    state.abTesting = payload?.abTesting === true;
    state.smartRouting = payload?.smartRouting === true;
    state.expiredRedirect = payload?.expiredRedirect === true;
  } catch {
    state.abTesting = false;
    state.smartRouting = false;
    state.expiredRedirect = false;
  }

  applyAbCapabilityToUi();
  applySmartRoutingCapabilityToUi();
  applyExpiredRedirectCapabilityToUi();
}

function applyAbCapabilityToUi() {
  const available = state.abTesting;

  if (abTestingSection) {
    abTestingSection.hidden = !available;
  }
  if (abTestingUnavailable) {
    abTestingUnavailable.hidden = available;
  }

  abEnabledInput.disabled = !available;
  abTargetUrlInput.disabled = !available;
  abWeightBInput.disabled = !available;

  if (!available) {
    abEnabledInput.checked = false;
  }
  syncRedirectConstraint();
}

function applySmartRoutingCapabilityToUi() {
  const available = state.smartRouting;

  if (smartRoutingSection) {
    smartRoutingSection.hidden = !available;
  }
  if (smartRoutingUnavailable) {
    smartRoutingUnavailable.hidden = available;
  }
  if (smartRoutingEnabledInput) {
    smartRoutingEnabledInput.disabled = !available;
  }

  if (!available) {
    smartRoutingEnabledInput.checked = false;
    state.smartRules = [];
    setSmartRoutingConflict("");
    setSmartRoutingError("");
  }

  renderSmartRules();
  syncRedirectConstraint();
}

function selectedExpiredRedirectMode() {
  if (!expiredRedirectModeUrl) {
    return EXPIRED_MODE_RESPONSE;
  }
  return expiredRedirectModeUrl.checked ? EXPIRED_MODE_REDIRECT : EXPIRED_MODE_RESPONSE;
}

function setExpiredRedirectMode(mode) {
  if (!expiredRedirectModeUrl || !expiredRedirectModeResponse) {
    return;
  }

  const isRedirect = mode === EXPIRED_MODE_REDIRECT;
  expiredRedirectModeUrl.checked = isRedirect;
  expiredRedirectModeResponse.checked = !isRedirect;
}

/**
 * Keeps the expired-destination controls coherent with the rest of the form.
 *
 * The API refuses a destination on a link without an expiration, so the redirect
 * option only exists while "Expira em" is filled: the option and the destination
 * field are disabled otherwise and the default response is selected. Clearing the
 * expiration also empties the destination, which is the visible half of the
 * atomic update the payload builder enforces, so the form can never show a
 * redirect while sending `expiresAt: null`.
 */
function syncExpiredRedirectConstraint() {
  if (!expiredRedirectModeUrl || !expiredRedirectUrlInput) {
    return;
  }

  const canRedirect = expiredRedirectUi
    ? expiredRedirectUi.canRedirectAfterExpiration({
        capability: state.expiredRedirect,
        expiresAt: toIsoDateTime(expiresAtInput.value),
      })
    : false;

  if (!canRedirect) {
    setExpiredRedirectMode(EXPIRED_MODE_RESPONSE);
    expiredRedirectUrlInput.value = "";
  }

  const isRedirect = canRedirect && selectedExpiredRedirectMode() === EXPIRED_MODE_REDIRECT;
  expiredRedirectModeUrl.disabled = !canRedirect;
  expiredRedirectUrlInput.disabled = !isRedirect;
  if (expiredRedirectUrlField) {
    expiredRedirectUrlField.hidden = !isRedirect;
  }
}

/** Loads the persisted expired-destination selection of one link, without loss. */
function applyExpiredRedirectSelection(link) {
  const selection = expiredRedirectUi
    ? expiredRedirectUi.expiredRedirectFromLink(link, state.expiredRedirect)
    : { mode: EXPIRED_MODE_RESPONSE, url: "" };
  setExpiredRedirectMode(selection.mode);
  expiredRedirectUrlInput.value = selection.url;
  syncExpiredRedirectConstraint();
}

function applyExpiredRedirectCapabilityToUi() {
  const available = state.expiredRedirect;

  if (expiredRedirectSection) {
    expiredRedirectSection.hidden = !available;
  }
  if (expiredRedirectUnavailable) {
    expiredRedirectUnavailable.hidden = available;
  }
  if (expiredRedirectModeResponse) {
    expiredRedirectModeResponse.disabled = !available;
  }

  // Also the reset path for an unavailable capability: the constraint disables
  // the redirect option and drops the destination, so the field is never read
  // and never sent on a database without the 0006 column.
  syncExpiredRedirectConstraint();
}

async function loadVersion() {
  try {
    const response = await fetch("/version", { credentials: "same-origin" });
    if (!response.ok) {
      return;
    }

    const payload = await response.json();
    if (payload?.version) {
      appVersion.textContent = `v${payload.version}`;
    }
    if (payload?.timezone && isValidTimeZone(payload.timezone)) {
      appTimeZone = payload.timezone;
    }
    if (footerTimezone) {
      footerTimezone.textContent = `Fuso: ${appTimeZone}`;
    }
  } catch {
    appVersion.textContent = "";
  }
}

function scheduleDelete(link) {
  if (state.pendingDeletes.has(link.slug)) {
    return;
  }

  const startTime = Date.now();
  const timeoutId = window.setTimeout(() => {
    commitDelete(link.slug);
  }, 5000);

  state.pendingDeletes.set(link.slug, { timeoutId, startTime, remaining: 5000 });
  
  // Start countdown interval
  if (!state.countdownInterval) {
    state.countdownInterval = window.setInterval(() => {
      const now = Date.now();
      let hasChanges = false;
      for (const [slug, data] of state.pendingDeletes.entries()) {
        const elapsed = now - data.startTime;
        const remaining = Math.max(0, 5000 - elapsed);
        const prevSecond = Math.floor((data.remaining || 5000) / 1000);
        const currSecond = Math.floor(remaining / 1000);
        if (prevSecond !== currSecond) {
          hasChanges = true;
        }
        data.remaining = remaining;
      }
      if (hasChanges) {
        renderLinks();
      }
    }, 100);
  }
  
  renderLinks();
  setStatus(listStatus, `/${link.slug} será removido em 5 segundos. Use Desfazer para cancelar.`);
}

function undoDelete(slug) {
  const data = state.pendingDeletes.get(slug);
  if (!data) {
    return;
  }

  window.clearTimeout(data.timeoutId);
  state.pendingDeletes.delete(slug);
  
  // Stop interval if no more pending deletes
  if (state.pendingDeletes.size === 0 && state.countdownInterval) {
    window.clearInterval(state.countdownInterval);
    state.countdownInterval = null;
  }
  
  renderLinks();
  setStatus(listStatus, `Exclusão de /${slug} cancelada.`, "success");
}

async function commitDelete(slug) {
  state.pendingDeletes.delete(slug);
  
  // Stop interval if no more pending deletes
  if (state.pendingDeletes.size === 0 && state.countdownInterval) {
    window.clearInterval(state.countdownInterval);
    state.countdownInterval = null;
  }
  
  renderLinks();
  setStatus(listStatus, `Excluindo /${slug}...`);

  try {
    await request(`/api/links/${encodeURIComponent(slug)}`, { method: "DELETE" });
    if (state.editingSlug === slug) {
      resetForm();
    }
    await loadLinks(searchTermInput.value, searchGroupIdInput.value);
    setStatus(listStatus, `/${slug} removido.`, "success");
  } catch (error) {
    setStatus(listStatus, error.message, "error");
    await loadLinks(searchTermInput.value, searchGroupIdInput.value);
  }
}

linkForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus(formStatus, state.editingSlug ? "Atualizando link..." : "Criando link...");
  setBusy(submitButton, true);

  if (!smartRoutingUi || typeof smartRoutingUi.submitLinkForm !== "function") {
    setStatus(formStatus, "Não foi possível preparar o envio do formulário.", "error");
    setBusy(submitButton, false);
    return;
  }

  const urlWithUtm = buildUtmUrl(targetUrlInput.value.trim()) || targetUrlInput.value.trim();
  collectSmartRules();
  clearSmartRuleInvalidState();
  // Clear any stale Smart error before a new attempt. The empty string does not
  // produce an announcement, so this cannot duplicate the next message.
  setSmartRoutingError("");
  // Re-applied here because an expiration cleared by keyboard may not have fired a
  // change event yet, and the payload must not contradict what the form shows.
  syncExpiredRedirectConstraint();

  // The final payload is composed exclusively by the shared builder used here
  // and in the integrated tests. This listener never rebuilds A/B, Smart or
  // redirect fields on its own.
  const input = {
    mode: state.editingSlug ? "edit" : "create",
    editingSlug: state.editingSlug,
    capabilities: { abTesting: state.abTesting, smartRouting: state.smartRouting, expiredRedirect: state.expiredRedirect },
    slug: slugInput.value.trim() || undefined,
    targetUrl: urlWithUtm,
    redirectType: redirectTypeInput.value,
    tags: parseTags(tagsInput.value),
    groupId: groupIdInput.value ? Number(groupIdInput.value) : null,
    goLiveAt: toIsoDateTime(goLiveAtInput.value),
    // An emptied "Expira em" is an explicit `null`, not an omitted field: omitting
    // it would keep the stored expiration while the destination is cleared, which
    // is the one combination the API refuses. Sending both as null together is the
    // documented repair path.
    expiresAt: toIsoDateTime(expiresAtInput.value) ?? null,
    password: passwordInput.value.trim() || undefined,
    ab: {
      enabled: abEnabledInput.checked,
      targetUrl: abTargetUrlInput.value.trim() || null,
      weightB: Number(abWeightBInput.value) || 50,
    },
    smart: {
      enabled: smartRoutingEnabledInput.checked,
      rules: state.smartRules,
      // Corrupt persisted state: preserve it unless the operator used the
      // explicit clear action, in which case the builder sends null.
      preserveInvalid: state.smartRoutingCorrupt,
      clearInvalid: state.smartClearInvalid,
    },
    expired: {
      mode: selectedExpiredRedirectMode(),
      url: expiredRedirectUrlInput.value.trim(),
    },
  };

  try {
    const result = await smartRoutingUi.submitLinkForm(input);

    if (!result.ok) {
      // The destination is a plain form requirement, not a Smart Routing failure,
      // so it is announced once through the polite form status.
      if (expiredRedirectUi && result.code === expiredRedirectUi.MISSING_DESTINATION_CODE) {
        setStatus(formStatus, expiredRedirectUi.expiredRedirectErrorMessage(result.code), "error");
        expiredRedirectUrlInput.focus();
        return;
      }

      // A Smart Routing failure is announced only by the assertive
      // #smart-routing-error region. #form-status stays empty to avoid a
      // duplicate screen-reader announcement.
      const feedback = smartRoutingUi.resolveSubmissionFeedback(result);
      if (feedback.smartError) {
        setStatus(formStatus, "");
        setSmartRoutingError(feedback.smartError);
        if (feedback.focusRules) {
          focusFirstInvalidSmartRule();
        }
        return;
      }

      setStatus(formStatus, feedback.formStatus || "Falha inesperada", "error");
      return;
    }

    const successMessage = state.editingSlug
      ? `Destino de /${state.editingSlug} atualizado.`
      : `Link /${result.payload.link.slug} criado com sucesso.`;

    resetForm();
    await loadLinks();
    setStatus(formStatus, successMessage, "success");
  } catch (error) {
    setStatus(formStatus, error.message, "error");
  } finally {
    setBusy(submitButton, false);
  }
});

cancelButton.addEventListener("click", () => {
  resetForm();
});

generateSlugButton.addEventListener("click", () => {
  slugInput.value = createClientSlug();
  slugInput.focus();
  slugInput.setSelectionRange(slugInput.value.length, slugInput.value.length);
});

groupCreateButton.addEventListener("click", () => {
  createGroupFromPanel();
});

groupMoveButton.addEventListener("click", () => {
  moveSelectedGroup();
});

groupMoveSourceSelect.addEventListener("change", () => {
  refreshMoveForm();
});

groupRefreshButton.addEventListener("click", async () => {
  await loadGroups();
  setStatus(groupStatus, "Grupos recarregados.");
});

groupExpandAllButton.addEventListener("click", () => {
  state.collapsedGroups.clear();
  renderGroupTree();
});

groupCollapseAllButton.addEventListener("click", () => {
  const tree = state.groupTree;
  if (!tree) {
    return;
  }
  tree.byId.forEach((_group, id) => {
    state.collapsedGroups.add(id);
  });
  renderGroupTree();
});

// One delegated listener for the whole tree: rows are rebuilt on every load, so
// per-node handlers would be re-registered each time.
groupTreeContainer.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-group-action]");
  if (!button) {
    return;
  }

  const node = button.closest(".group-node");
  const groupId = node ? Number(node.dataset.groupId) : Number.NaN;
  if (!Number.isInteger(groupId)) {
    return;
  }

  if (button.dataset.groupAction === "toggle") {
    toggleGroupExpansion(groupId);
    return;
  }
  if (button.dataset.groupAction === "move") {
    groupMoveSourceSelect.value = String(groupId);
    refreshMoveForm();
    groupMoveTargetSelect.focus();
    return;
  }
  if (button.dataset.groupAction === "delete") {
    deleteGroupFromPanel(groupId);
  }
});

groupCreateNameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    createGroupFromPanel();
  }
});

[targetUrlInput, utmSourceInput, utmMediumInput, utmCampaignInput, utmContentInput, utmTermInput].forEach((input) => {
  input.addEventListener("input", () => {
    refreshUtmPreview();
    refreshDomainWarning();
    if (input === targetUrlInput) {
      refreshSmartFallback();
      schedulePreviewLoad();
    }
  });
});

searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  loadLinks(searchTermInput.value, searchGroupIdInput.value);
});

searchTermInput.addEventListener("search", () => {
  loadLinks(searchTermInput.value, searchGroupIdInput.value);
});

searchTermInput.addEventListener("input", () => {
  if (!searchTermInput.value.trim()) {
    loadLinks("", searchGroupIdInput.value);
  }
});

searchGroupIdInput.addEventListener("change", () => {
  loadLinks(searchTermInput.value, searchGroupIdInput.value);
});

linksList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) {
    return;
  }

  const details = button.closest("details");
  if (details) {
    details.removeAttribute("open");
  }

  const slug = button.dataset.slug;
  const action = button.dataset.action;
  const link = state.links.find((entry) => entry.slug === slug);
  if (!slug || !link) {
    return;
  }

  if (action === "edit") {
    beginEdit(link);
    return;
  }

  if (action === "copy") {
    const shortLink = buildShortLink(link.slug);
    try {
      await copyToClipboard(shortLink);
      setStatus(listStatus, `Link copiado: ${shortLink}`);
    } catch {
      setStatus(listStatus, `Copie manualmente: ${shortLink}`);
    }
    return;
  }

  if (action === "delete") {
    scheduleDelete(link);
  }

  if (action === "qrcode") {
    const shortLink = await downloadQrForSlug(link.slug);
    await markQrCodeGenerated(link.slug);
    await loadLinks(searchTermInput.value, searchGroupIdInput.value);
    setStatus(listStatus, `QR Code gerado para ${shortLink}`, "success");
    return;
  }

  if (action === "reset-clicks") {
    const confirmed = window.confirm(`Zerar os cliques de /${link.slug}? Esta ação não altera o destino, mas não pode ser desfeita pelo painel.`);
    if (!confirmed) {
      return;
    }

    try {
      await request(`/api/links/${encodeURIComponent(link.slug)}/reset-clicks`, { method: "POST" });
      await loadLinks(searchTermInput.value, searchGroupIdInput.value);
      setStatus(listStatus, `Cliques zerados para /${link.slug}.`, "success");
    } catch (error) {
      setStatus(listStatus, error.message, "error");
    }
    return;
  }

  if (action === "duplicate") {
    try {
      const payload = await request(`/api/links/${encodeURIComponent(link.slug)}/duplicate`, { method: "POST" });
      await loadLinks(searchTermInput.value, searchGroupIdInput.value);
      setStatus(listStatus, `Link duplicado como /${payload.link.slug}.`, "success");
    } catch (error) {
      setStatus(listStatus, error.message, "error");
    }
    return;
  }

  if (action === "undo-delete") {
    undoDelete(slug);
  }
});

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const fallbackInput = document.createElement("input");
  fallbackInput.value = text;
  fallbackInput.setAttribute("readonly", "true");
  fallbackInput.style.position = "absolute";
  fallbackInput.style.left = "-9999px";
  document.body.appendChild(fallbackInput);
  fallbackInput.select();
  const copied = document.execCommand("copy");
  fallbackInput.remove();

  if (!copied) {
    throw new Error("Falha ao copiar link");
  }
}

resetForm();
footerYear.textContent = String(new Date().getFullYear());
loadCapabilities().finally(() => loadLinks());
loadGroups();
loadVersion();

// Close more actions dropdown when clicking outside
document.addEventListener("click", (event) => {
  document.querySelectorAll("details.more-actions-dropdown[open]").forEach((dropdown) => {
    if (!dropdown.contains(event.target)) {
      dropdown.removeAttribute("open");
    }
  });
});

// Clear search button
const clearSearchButton = document.getElementById("clear-search-button");
if (clearSearchButton) {
  clearSearchButton.addEventListener("click", () => {
    searchTermInput.value = "";
    searchForm.dispatchEvent(new Event("submit", { cancelable: true }));
    searchTermInput.focus();
  });

  const updateClearButton = () => {
    clearSearchButton.hidden = !searchTermInput.value.trim();
  };
  searchTermInput.addEventListener("input", updateClearButton);
  searchTermInput.addEventListener("search", () => setTimeout(updateClearButton, 0));
  updateClearButton();
}

// Accordion exclusivity: only one form <details> open at a time
linkForm.querySelectorAll(":scope > details:not(.more-actions-dropdown)").forEach((detail) => {
  detail.addEventListener("toggle", () => {
    if (!detail.open) return;
    linkForm.querySelectorAll(":scope > details:not(.more-actions-dropdown)[open]").forEach((other) => {
      if (other !== detail) other.removeAttribute("open");
    });
  });
});

// Keyboard shortcuts
document.addEventListener("keydown", (event) => {
  const target = event.target;
  const isInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable;

  // Ctrl/Cmd+Enter → submit form (when focus is on a form field)
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    if (target.closest("#link-form")) {
      event.preventDefault();
      linkForm.dispatchEvent(new Event("submit", { cancelable: true }));
      return;
    }
    if (target.closest("#search-form")) {
      event.preventDefault();
      searchForm.dispatchEvent(new Event("submit", { cancelable: true }));
      return;
    }
  }

  // / → focus search (when not typing in an input)
  if (event.key === "/" && !isInput) {
    event.preventDefault();
    searchTermInput.focus();
    searchTermInput.select();
    return;
  }

  // Escape → cancel edit or close dropdowns
  if (event.key === "Escape") {
    // Close all open more-actions dropdowns
    const openDropdowns = document.querySelectorAll("details.more-actions-dropdown[open]");
    if (openDropdowns.length > 0) {
      openDropdowns.forEach((d) => d.removeAttribute("open"));
      return;
    }
    // If in edit mode, cancel
    if (state.editingSlug && cancelButton && !cancelButton.hidden) {
      cancelButton.click();
      return;
    }
  }
});

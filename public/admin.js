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
};

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
const createGroupButton = document.getElementById("create-group-button");
const newGroupNameInput = document.getElementById("new-group-name");
const goLiveAtInput = document.getElementById("go-live-at");
const expiresAtInput = document.getElementById("expires-at");
const passwordInput = document.getElementById("password");
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

async function loadGroups() {
  try {
    const payload = await request("/api/groups", { method: "GET" });
    const currentFormGroup = groupIdInput.value;
    const currentSearchGroup = searchGroupIdInput.value;
    const formOptions = ['<option value="">Sem grupo</option>'];
    const searchOptions = [
      '<option value="">Todos os grupos</option>',
      '<option value="__none__">Sem grupo</option>',
    ];
    (payload.groups || []).forEach((group) => {
      const option = `<option value="${group.id}">${escapeHtml(group.name)}</option>`;
      formOptions.push(option);
      searchOptions.push(option);
    });
    groupIdInput.innerHTML = formOptions.join("");
    searchGroupIdInput.innerHTML = searchOptions.join("");
    if (currentFormGroup) {
      groupIdInput.value = currentFormGroup;
    }
    if (currentSearchGroup) {
      searchGroupIdInput.value = currentSearchGroup;
    }
  } catch {
    // Non-blocking: group listing is optional for basic flow
  }
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

function resetForm() {
  state.editingSlug = null;
  linkForm.reset();
  redirectTypeInput.value = "302";
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
  passwordInput.value = "";
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
    linksList.innerHTML = '<div class="empty">Nenhum link ativo ainda. Crie o primeiro slug no painel ao lado.</div>';
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

  const urlWithUtm = buildUtmUrl(targetUrlInput.value.trim()) || targetUrlInput.value.trim();

  const body = {
    slug: slugInput.value.trim() || undefined,
    targetUrl: urlWithUtm,
    redirectType: redirectTypeInput.value,
    tags: parseTags(tagsInput.value),
    groupId: groupIdInput.value ? Number(groupIdInput.value) : null,
    goLiveAt: toIsoDateTime(goLiveAtInput.value),
    expiresAt: toIsoDateTime(expiresAtInput.value),
    password: passwordInput.value.trim() || undefined,
  };

  try {
    let successMessage = "";
    if (state.editingSlug) {
      await request(`/api/links/${encodeURIComponent(state.editingSlug)}`, {
        method: "PATCH",
        body: JSON.stringify({
          targetUrl: body.targetUrl,
          redirectType: body.redirectType,
          tags: body.tags,
          groupId: body.groupId,
          goLiveAt: body.goLiveAt,
          expiresAt: body.expiresAt,
          password: body.password,
        }),
      });
      successMessage = `Destino de /${state.editingSlug} atualizado.`;
    } else {
      const payload = await request("/api/links", {
        method: "POST",
        body: JSON.stringify(body),
      });
      successMessage = `Link /${payload.link.slug} criado com sucesso.`;
    }

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

createGroupButton.addEventListener("click", async () => {
  const name = newGroupNameInput.value.trim();
  if (!name) {
    setStatus(formStatus, "Informe o nome do grupo antes de criar.", "error");
    return;
  }

  try {
    const payload = await request("/api/groups", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    newGroupNameInput.value = "";
    await loadGroups();
    groupIdInput.value = String(payload.group.id);
    setStatus(formStatus, `Grupo \"${payload.group.name}\" criado.`, "success");
  } catch (error) {
    setStatus(formStatus, error.message, "error");
  }
});

[targetUrlInput, utmSourceInput, utmMediumInput, utmCampaignInput, utmContentInput, utmTermInput].forEach((input) => {
  input.addEventListener("input", () => {
    refreshUtmPreview();
    refreshDomainWarning();
    if (input === targetUrlInput) {
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
loadLinks();
loadGroups();
loadVersion();

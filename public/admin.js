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
  pendingUtmFields: {},
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
  // The editor is an on-demand drawer: nothing about the tree depends on it being
  // open, only where the controls are shown and where focus belongs.
  groupDrawerOpen: false,
  // Which drawer view is mounted, and which group the move/rename editor is bound to.
  groupTab: "tree",
  groupContext: null,
  // On a narrow viewport the creation form starts collapsed so the links list is first.
  createFormCollapsed: false,
  // Import drawer. `importDocument` is the exact parsed document the current preview
  // describes, so the apply can never send a file the operator did not review: choosing
  // another file clears it, and the passwords live only in the fields.
  trashDrawerOpen: false,
  importDrawerOpen: false,
  importApplying: false,
  importDocument: null,
  importState: null,
  // Identity of the document being reviewed, and the preview request in flight for it.
  // Every reset replaces the first and cancels the second, so an answer that arrives late
  // describes a selection the drawer is no longer showing and is dropped.
  importSelection: null,
  importPreviewAbort: null,
  // QR dialog. `qrRequestToken` identifies the open request: it moves on every open and
  // every close, so a generation that arrives late for a link the dialog is no longer
  // showing is dropped instead of replacing the current preview. `qrPreviewSrc` is the
  // data URL the preview `<img>` renders (some webviews won't load `blob:` URLs as
  // images) and `qrObjectUrl` is the single object URL alive at a time — the one the
  // download anchor hands over. `qrSvgText` is the exact SVG body the Worker returned
  // for the current generation, so the SVG download replays the served artifact byte
  // for byte instead of regenerating anything.
  qrDialogOpen: false,
  qrSlug: null,
  qrRequestToken: 0,
  qrObjectUrl: null,
  qrPreviewSrc: null,
  qrSvgText: null,
  qrOpener: null,
};

const smartRoutingUi = window.BoltLinkSmartRouting || null;
const expiredRedirectUi = window.BoltLinkExpiredRedirect || null;
// Loaded before this script, and pinned by an order test. The panel fails closed
// with an explanatory status instead of throwing when the module is absent.
const groupHierarchyUi = window.BoltLinkGroupHierarchy || null;
const utmUi = window.BoltLinkUtm || null;
// Loaded before this script, and pinned by an order test. When it is missing the
// export button disables itself instead of downloading a file under a guessed name.
const portabilityUi = window.BoltLinkPortability || null;
// Loaded before this script, and pinned by an order test. When it is missing the import
// drawer explains itself instead of running with an unknown path or an unmapped state.
const portabilityImportUi = window.BoltLinkPortabilityImport || null;
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
  check: `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m5 12 4 4L19 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path></svg>`,
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
const groupTabTreeButton = document.getElementById("group-tab-tree");
const groupTabCreateButton = document.getElementById("group-tab-create");
const groupTreePanel = document.getElementById("group-panel-tree");
const groupCreatePanel = document.getElementById("group-panel-create");
const groupContextEditor = document.getElementById("group-context-editor");
const groupContextName = document.getElementById("group-context-name");
const groupContextPath = document.getElementById("group-context-path");
const groupContextMoveField = document.getElementById("group-context-move-field");
const groupContextRenameField = document.getElementById("group-context-rename-field");
const groupContextParentSelect = document.getElementById("group-context-parent");
const groupContextNameInput = document.getElementById("group-context-name-input");
const groupContextConfirmButton = document.getElementById("group-context-confirm");
const groupContextCancelButton = document.getElementById("group-context-cancel");
const groupExpandAllButton = document.getElementById("group-expand-all");
const groupCollapseAllButton = document.getElementById("group-collapse-all");
const groupRefreshButton = document.getElementById("group-refresh");
const groupDrawer = document.getElementById("group-drawer");
const groupDrawerOpenButton = document.getElementById("group-drawer-open");
const groupDrawerCloseButton = document.getElementById("group-drawer-close");
const groupDrawerBackdrop = document.getElementById("group-drawer-backdrop");
const linkFormPanel = document.getElementById("link-form-panel");
const createLinkToggleButton = document.getElementById("create-link-toggle");
const createLinkLabel = document.getElementById("create-link-label");
const trashDrawer = document.getElementById("trash-drawer");
const trashDrawerOpenButton = document.getElementById("trash-open");
const trashDrawerCloseButton = document.getElementById("trash-drawer-close");
const trashDrawerBackdrop = document.getElementById("trash-drawer-backdrop");
const formTitle = document.getElementById("form-title");
const formStatus = document.getElementById("form-status");
const listStatus = document.getElementById("list-status");
const copyStatus = document.getElementById("copy-status");
const copyFeedbackStates = new WeakMap();
const linksList = document.getElementById("links-list");
const linksCount = document.getElementById("links-count");
const exportButton = document.getElementById("export-button");
const exportStatus = document.getElementById("export-status");
const importDrawer = document.getElementById("import-drawer");
const importDrawerOpenButton = document.getElementById("import-drawer-open");
const importDrawerCloseButton = document.getElementById("import-drawer-close");
const importDrawerBackdrop = document.getElementById("import-drawer-backdrop");
const importFileInput = document.getElementById("import-file");
const importFileName = document.getElementById("import-file-name");
const importReview = document.getElementById("import-review");
const importSummary = document.getElementById("import-summary");
const importWarnings = document.getElementById("import-warnings");
const importConflicts = document.getElementById("import-conflicts");
const importBlockers = document.getElementById("import-blockers");
const importErrors = document.getElementById("import-errors");
const importPasswords = document.getElementById("import-passwords");
const importPasswordFields = document.getElementById("import-password-fields");
const importPlan = document.getElementById("import-plan");
const importApplyButton = document.getElementById("import-apply-button");
const importResetButton = document.getElementById("import-reset-button");
const importDoneButton = document.getElementById("import-done-button");
const importStatus = document.getElementById("import-status");
const qrDialog = document.getElementById("qr-dialog");
const qrDialogBackdrop = document.getElementById("qr-dialog-backdrop");
const qrDialogCloseButton = document.getElementById("qr-dialog-close");
const qrDialogSlug = document.getElementById("qr-dialog-slug");
const qrImage = document.getElementById("qr-image");
const qrUrl = document.getElementById("qr-url");
const qrDownloadPngButton = document.getElementById("qr-download-png-button");
const qrDownloadSvgButton = document.getElementById("qr-download-svg-button");
const qrCopyButton = document.getElementById("qr-copy-button");
const qrStatus = document.getElementById("qr-status");
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
      class="${variant}${action === "copy" ? " copy-control" : ""}"
      data-action="${action}"
      data-slug="${safeSlug}"
      aria-label="${label}"
      title="${label}"
    >
      ${action === "copy" ? `<span class="copy-idle">${buttonMarkup(icon, label)}</span><span class="copy-feedback" aria-hidden="true"></span>` : buttonMarkup(icon, label)}
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
    const retryAfter = response.headers.get("Retry-After");
    const seconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : 0;
    const message = response.status === 429 && Number.isSafeInteger(seconds) && seconds > 0
      ? `Muitas operações em sequência. Tente novamente em ${seconds} segundos.`
      : adminErrorCopy(payload?.error || "Não foi possível concluir a operação. Tente novamente.");
    const error = new Error(message);
    error.status = response.status;
    error.headers = response.headers;
    error.payload = payload;
    throw error;
  }

  return payload;
}

function adminErrorCopy(message) {
  const text = String(message || "");
  const messages = {
    "Internal server error": "Não foi possível concluir a operação no servidor. Tente novamente.",
    "Not found": "O recurso não foi encontrado nesta instalação. Recarregue o painel.",
    "Authentication required": "Sua sessão não foi reconhecida. Recarregue o painel e entre novamente.",
    "Unauthorized": "Sua sessão não foi reconhecida. Recarregue o painel e entre novamente.",
    "Rate limit exceeded": "Muitas operações em sequência. Aguarde e tente novamente.",
    "Too many requests": "Muitas operações em sequência. Aguarde e tente novamente.",
    "Database schema is not initialized": "O banco ainda não foi preparado. Aplique as migrações desta versão e tente novamente.",
    "Invalid JSON body": "Os dados enviados não puderam ser lidos. Recarregue o painel e tente novamente.",
    "Invalid target URL": "URL de destino inválida. Informe uma URL HTTP ou HTTPS válida.",
    "Invalid redirect type. Use '301' or '302'": "Tipo de redirecionamento inválido. Selecione 301 ou 302.",
    "Invalid tags. Provide an array of strings": "As tags não estão no formato esperado. Separe os valores por vírgulas.",
    "expiresAt cannot be earlier than goLiveAt": "A expiração não pode ocorrer antes da ativação. Confira as datas.",
    "Invalid groupId": "Grupo inválido. Selecione um grupo da lista.",
    "Invalid group id": "Grupo inválido. Recarregue a lista de grupos.",
    "Group not found": "Grupo não encontrado. Recarregue a lista de grupos.",
    "Parent group not found": "O grupo pai não existe mais. Recarregue a lista de grupos.",
    "Invalid parentId": "Grupo pai inválido. Selecione um grupo da lista.",
    "Invalid expectedParentId": "O grupo pai informado não é válido. Recarregue a lista de grupos.",
    "expectedParentId is required when parentId changes": "Não foi possível confirmar o grupo pai atual. Recarregue a lista e tente mover o grupo novamente.",
    "Group name is required": "Informe o nome do grupo.",
    "Group name cannot be empty": "O nome do grupo não pode ficar vazio.",
    "Group could not be removed": "Não foi possível excluir o grupo. Recarregue a lista e tente novamente.",
    "Invalid password. Provide a non-empty string or null": "Senha inválida. Informe uma senha ou deixe o campo vazio.",
    "PASSWORD_SESSION_SECRET is required to create password-protected links": "A proteção por senha está indisponível. Configure PASSWORD_SESSION_SECRET nesta instalação.",
    "PASSWORD_SESSION_SECRET is required to add password protection": "A proteção por senha está indisponível. Configure PASSWORD_SESSION_SECRET nesta instalação.",
    "A/B testing requires migration 0004_ab_testing.sql to be applied": "O Teste A/B não está disponível nesta instalação. Aplique a migração 0004_ab_testing.sql para ativá-lo.",
    "Smart Routing requires migration 0005_smart_routing.sql to be applied": "O Smart Routing não está disponível nesta instalação. Aplique a migração 0005_smart_routing.sql para ativá-lo.",
    "Expired redirect requires migration 0006_expired_redirect.sql to be applied": "O destino após expiração não está disponível nesta instalação. Aplique a migração 0006_expired_redirect.sql para ativá-lo.",
    "A/B testing requires a temporary redirect (302)": "O Teste A/B usa redirecionamento temporário. Selecione 302.",
    "Smart Routing requires a temporary redirect (302)": "O Smart Routing usa redirecionamento temporário. Selecione 302.",
    "A/B testing and Smart Routing are mutually exclusive": "Teste A/B e Smart Routing não podem ficar ativos juntos. Escolha apenas um.",
    "Invalid abEnabled. Use true or false": "Não foi possível ler a opção do Teste A/B. Recarregue o painel.",
    "Invalid abTargetUrl": "URL da variante B inválida. Informe uma URL HTTP ou HTTPS válida.",
    "abTargetUrl is required when A/B testing is enabled": "Informe a URL da variante B para ativar o Teste A/B.",
    "Invalid abWeightB. Use an integer between 1 and 99": "Distribuição do tráfego inválida. Escolha um percentual para a variante B entre 1 e 99.",
    "Invalid expiredRedirectUrl": "Destino após expiração inválido. Informe uma URL HTTP ou HTTPS válida.",
    "expiredRedirectUrl requires expiresAt": "Preencha a data de expiração para definir um destino após expirar.",
    "Slug already exists": "Este slug já está em uso ou reservado. Escolha outro.",
    "Slug is reserved": "Este slug é reservado. Escolha outro.",
    "Slug must be 3-64 chars using only letters, numbers, underscore, or hyphen": "Use de 3 a 64 caracteres no slug: letras, números, sublinhados ou hífens.",
    "Slug is immutable after creation": "O slug não pode ser alterado após a criação. Edite os demais campos.",
    "Missing slug": "Informe o slug do link.",
    "Link not found": "Link não encontrado. Recarregue a lista de links.",
    "Reserved slug cannot be deleted": "Este slug é reservado e não pode ser excluído.",
    "Reserved slug cannot reset clicks": "Não é possível zerar os cliques de um slug reservado.",
    "Reserved slug cannot be updated": "Este slug é reservado e não pode ser editado.",
    "Reserved slug cannot be marked with a QR code": "Não é possível registrar um QR Code para um slug reservado.",
    "Reserved slug cannot generate a QR code": "Não é possível gerar um QR Code para um slug reservado.",
    "QR code generation failed": "Não foi possível gerar o QR Code. Tente novamente.",
    "Source link has incompatible routing configuration": "O link tem Teste A/B e Smart Routing incompatíveis. Corrija a configuração antes de duplicá-lo.",
    "No updatable fields provided": "Nenhuma alteração foi enviada. Edite um campo antes de salvar.",
    "Link was modified concurrently. Reload it and try again": "O link foi alterado em outra sessão. Recarregue-o e tente novamente.",
  };
  if (Object.prototype.hasOwnProperty.call(messages, text)) {
    return messages[text];
  }
  if (text.startsWith("Invalid date format.")) {
    return "Data ou hora inválida. Confira os campos de ativação e expiração e o fuso indicado no painel.";
  }
  return text.replace(/^(?:Failed to fetch|NetworkError when attempting to fetch resource\.?|Load failed)/,
    "Não foi possível conectar ao servidor. Verifique a conexão e tente novamente.");
}

function setStatus(element, message, type = "") {
  element.textContent = type === "error" ? adminErrorCopy(message) : (message || "");
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

function hydrateUtmFields() {
  let fields = utmUi?.parseUtmFromUrl(targetUrlInput.value.trim());
  if (!fields) return;
  // Generator edits made before a valid URL are retained until blur/submit.
  const updated = utmUi.applyUtmToUrl(targetUrlInput.value.trim(), state.pendingUtmFields);
  if (updated) {
    targetUrlInput.value = updated;
    fields = utmUi.parseUtmFromUrl(updated);
    state.pendingUtmFields = {};
  }
  [utmSourceInput, utmMediumInput, utmCampaignInput, utmContentInput, utmTermInput]
    .forEach((input, index) => { input.value = fields[utmUi.KEYS[index]]; });
}

function refreshUtmPreview() {
  const url = utmUi?.parseUtmFromUrl(targetUrlInput.value.trim()) ? targetUrlInput.value.trim() : "";
  utmPreview.textContent = url ? `Prévia da URL com UTMs: ${url}` : "Prévia da URL com UTMs: —";
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
    ? `<img src="${escapeHtml(previewImageUrl)}" alt="Prévia da página de destino" style="width:100%;max-height:160px;object-fit:cover;border-radius:8px;margin-bottom:10px;" />`
    : "";
  const imageHint = previewImageUrl && !isImageAllowed
    ? '<p style="margin:0 0 8px;font-size:.78rem;color:var(--muted);">A política de segurança desta instalação impede a exibição da imagem da prévia (CSP).</p>'
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
      return { ok: false, status: response.status, error: payload?.error || "Não foi possível concluir a operação. Tente novamente." };
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

function groupNodeButton(action, label, title, row, variant = "secondary") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `${variant} compact`;
  button.dataset.groupAction = action;
  button.textContent = label;
  // The path, not the bare name, so repeated names stay distinguishable.
  button.setAttribute("aria-label", `${title}: ${row.path}`);
  button.title = button.getAttribute("aria-label");
  return button;
}

/**
 * Row actions live behind a `…` menu, so a group never has to render three full buttons.
 * The menu is the same `<details>` pattern the link cards use, which keeps it keyboard
 * operable and closes it when the operator clicks outside.
 */
function buildGroupNodeMenu(row) {
  const wrapper = document.createElement("details");
  wrapper.className = "more-actions-dropdown group-node-menu";

  const summary = document.createElement("summary");
  summary.setAttribute("aria-label", `Ações do grupo: ${row.path}`);
  summary.title = summary.getAttribute("aria-label");
  // A glyph, not markup: persisted content is not the only thing kept away from HTML sinks.
  summary.textContent = "⋯";
  wrapper.append(summary);

  const menu = document.createElement("div");
  menu.className = "dropdown-menu";
  menu.append(
    groupNodeButton("move", "Mover", "Mover grupo", row),
    groupNodeButton("rename", "Renomear", "Renomear grupo", row),
    groupNodeButton("delete", "Excluir", "Excluir grupo", row, "danger"),
  );
  wrapper.append(menu);

  return wrapper;
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

  container.append(buildGroupNodeMenu(row));

  return container;
}

/**
 * The two drawer views. Only the active one is rendered, so the hidden view can never hold
 * a focusable control and the operator never faces the tree and a form at the same time.
 */
function selectGroupTab(tab) {
  const isTree = tab !== "create";
  state.groupTab = isTree ? "tree" : "create";
  closeGroupContext();

  groupTabTreeButton.setAttribute("aria-selected", String(isTree));
  groupTabTreeButton.tabIndex = isTree ? 0 : -1;
  groupTabCreateButton.setAttribute("aria-selected", String(!isTree));
  groupTabCreateButton.tabIndex = isTree ? -1 : 0;
  groupTreePanel.hidden = !isTree;
  groupCreatePanel.hidden = isTree;
}

/** Roving focus across the two tabs, which is the keyboard contract for a tablist. */
function onGroupTabsKeydown(event) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
    return;
  }
  event.preventDefault();
  if (event.key === "Home") {
    selectGroupTab("tree");
  } else if (event.key === "End") {
    selectGroupTab("create");
  } else {
    selectGroupTab(state.groupTab === "tree" ? "create" : "tree");
  }
  (state.groupTab === "tree" ? groupTabTreeButton : groupTabCreateButton).focus();
}

/**
 * The move/rename editor is bound to the group the operator picked in the tree: that row
 * already answered "which group", so it is shown as context instead of being asked again.
 */
function openGroupContext(mode, groupId) {
  const tree = state.groupTree;
  const group = tree ? tree.byId.get(groupId) : null;
  if (!group) {
    setStatus(groupStatus, groupHierarchyUi.ERROR_MESSAGES.NOT_FOUND, "error");
    return;
  }

  state.groupContext = { mode, groupId };
  groupContextName.textContent = group.name;
  groupContextPath.textContent = groupHierarchyUi.groupPath(tree.byId, groupId);
  groupContextEditor.hidden = false;
  setStatus(groupStatus, "");

  const isMove = mode === "move";
  groupContextMoveField.hidden = !isMove;
  groupContextRenameField.hidden = isMove;

  if (isMove) {
    // The current parent is preselected: confirming without a change stays a move to the
    // same place instead of turning into an accidental promotion to the root.
    const options = groupHierarchyUi.parentOptions(tree, groupId);
    fillGroupSelect(groupContextParentSelect, "Sem grupo pai (raiz)", options, group.parentId === null ? "" : String(group.parentId));
    groupContextParentSelect.focus();
    return;
  }

  groupContextNameInput.value = group.name;
  groupContextNameInput.focus();
  groupContextNameInput.select();
}

function closeGroupContext() {
  if (!state.groupContext) {
    return;
  }
  state.groupContext = null;
  groupContextEditor.hidden = true;
  groupContextParentSelect.replaceChildren();
  groupContextNameInput.value = "";
}

async function confirmGroupContext() {
  const context = state.groupContext;
  const tree = state.groupTree;
  const group = context && tree ? tree.byId.get(context.groupId) : null;
  if (!context || !group) {
    closeGroupContext();
    setStatus(groupStatus, groupHierarchyUi.ERROR_MESSAGES.NOT_FOUND, "error");
    return;
  }

  const isMove = context.mode === "move";
  const groupId = context.groupId;
  const path = groupHierarchyUi.groupPath(tree.byId, groupId);
  const name = isMove ? null : groupContextNameInput.value.trim();
  if (!isMove && !name) {
    setStatus(groupStatus, "Informe o novo nome do grupo.", "error");
    return;
  }
  if (!isMove && name === group.name) {
    closeGroupContext();
    return;
  }

  const targetParentId = isMove && groupContextParentSelect.value ? Number(groupContextParentSelect.value) : null;

  setBusy(groupContextConfirmButton, true);
  try {
    const result = await groupRequest(`/api/groups/${groupId}`, {
      method: "PATCH",
      // Move: the parent observed in the loaded snapshot travels as the precondition in the
      // same request, so a move that happened meanwhile answers 409 instead of overwriting
      // it. Rename: no parentId at all, which is the last-write-wins path the API documents.
      body: JSON.stringify(isMove ? { parentId: targetParentId, expectedParentId: group.parentId } : { name }),
    });

    closeGroupContext();

    if (!result.ok) {
      // No automatic retry: reload so the drawer reflects the current state, then explain.
      await loadGroups();
      setStatus(groupStatus, groupHierarchyUi.groupErrorMessage(result.error), "error");
      return;
    }

    await loadGroups();
    setStatus(
      groupStatus,
      isMove ? `Grupo "${path}" movido.` : `Grupo renomeado para "${result.payload.group.name}".`,
      "success",
    );
  } finally {
    setBusy(groupContextConfirmButton, false);
  }
}

/** Brings one node into view inside the drawer body, without moving the page behind it. */
function showGroupNode(groupId) {
  const node = groupTreeContainer.querySelector(`.group-node[data-group-id="${groupId}"]`);
  if (node) {
    node.scrollIntoView({ block: "nearest" });
  }
}

/**
 * Expand/collapse and the context editor have nothing to act on while no group exists, so
 * they are hidden instead of dimmed: hidden controls leave the layout, the tab order and the
 * accessibility tree together. Creation is what remains, which is the second tab.
 */
function syncGroupDrawerEmptyState() {
  const hasGroups = Boolean(state.groupTree && state.groupTree.byId.size);
  groupExpandAllButton.hidden = !hasGroups;
  groupCollapseAllButton.hidden = !hasGroups;
  if (!hasGroups) {
    closeGroupContext();
  }
}

function renderGroupTree() {
  const tree = state.groupTree;
  syncGroupDrawerEmptyState();
  groupTreeContainer.replaceChildren();

  if (!tree) {
    return;
  }

  const rows = groupHierarchyUi.flattenTree(tree, expandedGroupIds(tree));
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "group-tree-empty";
    empty.textContent = "Nenhum grupo criado ainda.";
    // The empty state offers the one action that makes sense here and takes it to the
    // creation tab, instead of leaving an operator with nothing to click.
    const cta = document.createElement("button");
    cta.type = "button";
    cta.className = "secondary compact group-tree-empty-cta";
    cta.dataset.groupAction = "create-first";
    cta.textContent = "Criar primeiro grupo";
    groupTreeContainer.append(empty, cta);
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
  syncGroupDrawerEmptyState();
  groupTreeContainer.replaceChildren();
  const notice = document.createElement("p");
  notice.className = "group-tree-empty error-text";
  notice.textContent = message;
  groupTreeContainer.append(notice);
}

// One reversible snapshot of the inline styles the drawer touched. No scroll listener:
// the page behind simply stops scrolling while the drawer is open, and the exact previous
// values come back on close.
let bodyScrollLock = null;

function lockBodyScroll() {
  if (bodyScrollLock) {
    return;
  }
  const scrollbar = window.innerWidth - document.documentElement.clientWidth;
  bodyScrollLock = { overflow: document.body.style.overflow, paddingRight: document.body.style.paddingRight, mainInert: document.querySelector("main").inert };
  document.querySelector("main").inert = true;
  document.body.style.overflow = "hidden";
  if (scrollbar > 0) {
    document.body.style.paddingRight = `${scrollbar}px`;
  }
}

function unlockBodyScroll() {
  if (!bodyScrollLock) {
    return;
  }
  document.body.style.overflow = bodyScrollLock.overflow;
  document.body.style.paddingRight = bodyScrollLock.paddingRight;
  document.querySelector("main").inert = bodyScrollLock.mainInert;
  bodyScrollLock = null;
}

/** Shared modal focus policy, including controls inside hidden ancestor sections. */
function drawerFocusables(drawer) {
  const selector = 'summary, button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]';
  return Array.from(drawer.querySelectorAll(selector)).filter((element) => {
    // Closed native details can still report layout boxes for positioned menus.
    for (let ancestor = element.parentElement; ancestor && ancestor !== drawer; ancestor = ancestor.parentElement) {
      if (ancestor.tagName === "DETAILS" && !ancestor.open && element !== ancestor.querySelector(":scope > summary")) return false;
    }
    const style = getComputedStyle(element);
    return !element.hidden && !element.disabled && !element.closest("[hidden], [inert]") && element.tabIndex >= 0
      && element.getClientRects().length > 0 && style.display !== "none" && style.visibility !== "hidden";
  });
}

function keepDrawerFocus(event, drawer) {
  if (event.key !== "Tab") return;
  const focusables = drawerFocusables(drawer);
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  if (!drawer.contains(active) || (!event.shiftKey && active === last)) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  }
}

function groupDrawerFocusables() {
  return drawerFocusables(groupDrawer);
}

function keepGroupDrawerFocus(event) {
  keepDrawerFocus(event, groupDrawer);
}

function onGroupDrawerKeydown(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    closeGroupDrawer();
    return;
  }
  keepGroupDrawerFocus(event);
}

function openGroupDrawer() {
  if (state.groupDrawerOpen) {
    return;
  }
  closeImportDrawer();
  closeTrashDrawer();
  closeQrDialog();
  state.groupDrawerOpen = true;
  // Every session starts from the same place: the tree, with no outcome left over from the
  // previous one greeting the operator as if it had just happened.
  selectGroupTab("tree");
  setStatus(groupStatus, "");
  lockBodyScroll();
  groupDrawerOpenButton.setAttribute("aria-expanded", "true");
  groupDrawer.removeAttribute("inert");
  groupDrawer.setAttribute("aria-hidden", "false");
  groupDrawer.classList.add("is-open");
  groupDrawerBackdrop.classList.add("is-open");
  document.addEventListener("keydown", onGroupDrawerKeydown);
  groupDrawerCloseButton.focus();
}

function closeGroupDrawer() {
  if (!state.groupDrawerOpen) {
    return;
  }
  state.groupDrawerOpen = false;
  document.removeEventListener("keydown", onGroupDrawerKeydown);
  groupDrawer.classList.remove("is-open");
  groupDrawerBackdrop.classList.remove("is-open");
  // `inert` and `aria-hidden` are what keep the closed drawer out of the tab order and the
  // accessibility tree; the transition only decides when it stops being visible.
  groupDrawer.setAttribute("inert", "");
  groupDrawer.setAttribute("aria-hidden", "true");
  groupDrawerOpenButton.setAttribute("aria-expanded", "false");
  unlockBodyScroll();
  groupDrawerOpenButton.focus();
}

function refreshGroupSelects() {
  const tree = state.groupTree;
  // The link form and the create form list every group by full path so equal names stay
  // distinguishable. The filter keeps its own sentinel for "no group", restored when it is
  // still offered.
  const options = tree ? groupHierarchyUi.parentOptions(tree, null) : [];

  fillGroupSelect(groupIdInput, "Sem grupo", options, groupIdInput.value);
  fillGroupSelect(groupCreateParentSelect, "Sem grupo pai (raiz)", options, groupCreateParentSelect.value);
  fillGroupSelect(
    searchGroupIdInput,
    "Todos os grupos",
    [groupOption("__none__", "Sem grupo")].concat(options),
    searchGroupIdInput.value,
  );
}

async function loadGroups() {
  if (!groupHierarchyUi) {
    renderGroupTreeFailure("Não foi possível carregar o painel de grupos. Recarregue a página.");
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
  renderLinks();
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

    const created = result.payload.group;
    groupCreateNameInput.value = "";
    groupCreateParentSelect.value = "";
    await loadGroups();
    // Creation belongs to the tree: going back there shows the new group instead of leaving
    // the operator in front of a form that has nothing left to submit.
    selectGroupTab("tree");
    showGroupNode(created.id);
    setStatus(groupStatus, `Grupo "${created.name}" criado.`, "success");
  } finally {
    setBusy(groupCreateButton, false);
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

/**
 * Persists the "QR Ativo" flag and reports whether the API confirmed it.
 *
 * The browser cannot prove that a download reached the disk, so the answer to this write —
 * not the click that started the file — is the only trustworthy signal about the persisted
 * state. The caller announces the flag from this result alone.
 */
async function markQrCodeGenerated(slug) {
  try {
    await request(`/api/links/${encodeURIComponent(slug)}/qrcode`, { method: "POST" });
    return true;
  } catch {
    return false;
  }
}

/** Side of the PNG the operator downloads; the Worker serves the QR as SVG. */
const QR_PNG_SIZE = 512;

/**
 * Rasterizes the Worker's SVG into the PNG that is previewed and downloaded.
 *
 * The SVG reaches the decoder through a data URL on purpose: WebKit-based webviews
 * refuse to load `blob:` URLs as image sources, and the preview has to render
 * everywhere. The PNG comes back in the same two shapes for the same reason — a
 * data URL for the `<img>`, and a blob whose object URL (the only one the dialog
 * owns) is handed to the download anchor.
 */
function rasterizeQrSvg(svgText) {
  return new Promise((resolve, reject) => {
    const svgDataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = QR_PNG_SIZE;
        canvas.height = QR_PNG_SIZE;
        const context = canvas.getContext("2d");
        if (!context) {
          throw new Error("Não foi possível preparar a imagem do QR Code neste navegador.");
        }
        // The SVG already carries a white quiet zone; filling first keeps the PNG
        // scannable even if that background ever changes upstream.
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, QR_PNG_SIZE, QR_PNG_SIZE);
        context.drawImage(image, 0, 0, QR_PNG_SIZE, QR_PNG_SIZE);
        const previewSrc = canvas.toDataURL("image/png");
        canvas.toBlob((blob) => {
          if (blob) {
            resolve({ blob, previewSrc });
          } else {
            reject(new Error("Não foi possível gerar o arquivo PNG do QR Code."));
          }
        }, "image/png");
      } catch (error) {
        reject(error);
      }
    };
    image.onerror = () => {
      reject(new Error("Não foi possível carregar a imagem do QR Code."));
    };
    image.src = svgDataUrl;
  });
}

/** A generation is only honored while the dialog still shows the link that asked for it. */
function qrRequestIsCurrent(token) {
  return state.qrDialogOpen && state.qrRequestToken === token;
}

/**
 * A download may only render into the dialog that started it. The token moves on every
 * open and every close, and the slug is re-checked against the request it was captured
 * with, so a completion that arrives late can never be mistaken for the current link.
 */
function qrDownloadIsCurrent(token, slug) {
  return qrRequestIsCurrent(token) && state.qrSlug === slug;
}

function releaseQrObjectUrl() {
  if (state.qrObjectUrl) {
    URL.revokeObjectURL(state.qrObjectUrl);
    state.qrObjectUrl = null;
  }
  state.qrPreviewSrc = null;
  state.qrSvgText = null;
  qrImage.removeAttribute("src");
}

/** The two downloads are one fact — the current generation is usable or it is not. */
function setQrDownloadsDisabled(disabled) {
  qrDownloadPngButton.disabled = disabled;
  qrDownloadSvgButton.disabled = disabled;
}

function resetQrDialogSurface() {
  releaseQrObjectUrl();
  qrImage.alt = "";
  qrDialogSlug.textContent = "";
  qrUrl.textContent = "";
  setQrDownloadsDisabled(true);
  setStatus(qrStatus, "");
}

/** Controls the dialog owns, in document order. A hidden or disabled one is skipped. */
function qrDialogFocusables() {
  const selector = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]';
  return Array.from(qrDialog.querySelectorAll(selector)).filter((element) => {
    const style = getComputedStyle(element);
    return !element.hidden && style.display !== "none" && style.visibility !== "hidden";
  });
}

/**
 * The dialog is modal, so Tab stays inside it while it is open. Wrapping at both ends is
 * enough: every control in it is a plain tab stop, with no shadow root to cross.
 */
function keepQrDialogFocus(event) {
  if (event.key !== "Tab") {
    return;
  }
  const focusables = qrDialogFocusables();
  if (!focusables.length) {
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  if (!qrDialog.contains(active)) {
    event.preventDefault();
    first.focus();
    return;
  }
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
    return;
  }
  if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

function onQrDialogKeydown(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    closeQrDialog();
    return;
  }
  keepQrDialogFocus(event);
}

async function openQrDialog(link) {
  closeGroupDrawer();
  closeImportDrawer();
  closeTrashDrawer();
  const slug = link.slug;
  // The `…` menu that hosts the action would otherwise stay open behind the modal.
  document.querySelectorAll("details.more-actions-dropdown[open]").forEach((dropdown) => {
    dropdown.removeAttribute("open");
  });

  if (state.qrDialogOpen) {
    closeQrDialog();
  }
  state.qrDialogOpen = true;
  state.qrSlug = slug;
  state.qrRequestToken += 1;
  const token = state.qrRequestToken;
  state.qrOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  // No trace of a previous link survives into the new dialog: the preview is cleared
  // before anything is awaited, so an error later never shows a stale QR either.
  releaseQrObjectUrl();
  qrImage.alt = "";
  qrDialogSlug.textContent = `/${slug}`;
  qrUrl.textContent = buildShortLink(slug);
  setQrDownloadsDisabled(true);
  setStatus(qrStatus, "Gerando QR Code…");

  lockBodyScroll();
  qrDialog.removeAttribute("inert");
  qrDialog.setAttribute("aria-hidden", "false");
  qrDialog.classList.add("is-open");
  qrDialogBackdrop.classList.add("is-open");
  document.addEventListener("keydown", onQrDialogKeydown);
  qrDialogCloseButton.focus();

  try {
    const response = await fetch(`/api/links/${encodeURIComponent(slug)}/qrcode`, {
      method: "GET",
      credentials: "same-origin",
    });
    if (!qrRequestIsCurrent(token)) {
      return;
    }
    if (!response.ok) {
      throw new Error("Falha ao gerar QR Code");
    }
    const svgText = await response.text();
    if (!qrRequestIsCurrent(token)) {
      return;
    }
    const png = await rasterizeQrSvg(svgText);
    if (!qrRequestIsCurrent(token)) {
      return;
    }
    releaseQrObjectUrl();
    state.qrSvgText = svgText;
    state.qrObjectUrl = URL.createObjectURL(png.blob);
    state.qrPreviewSrc = png.previewSrc;
    qrImage.alt = `QR Code do link curto ${buildShortLink(slug)}`;
    qrImage.src = state.qrPreviewSrc;
    setQrDownloadsDisabled(false);
    setStatus(qrStatus, "");
  } catch {
    if (!qrRequestIsCurrent(token)) {
      return;
    }
    setStatus(qrStatus, "Não foi possível gerar o QR Code deste link. Verifique a conexão e tente de novo.", "error");
  }
}

function closeQrDialog() {
  if (!state.qrDialogOpen) {
    return;
  }
  const slug = state.qrSlug;
  state.qrDialogOpen = false;
  state.qrSlug = null;
  // A generation still in flight for this dialog must not render into it after closing.
  state.qrRequestToken += 1;
  resetQrDialogSurface();
  document.removeEventListener("keydown", onQrDialogKeydown);
  qrDialog.classList.remove("is-open");
  qrDialogBackdrop.classList.remove("is-open");
  qrDialog.setAttribute("inert", "");
  qrDialog.setAttribute("aria-hidden", "true");
  unlockBodyScroll();

  const opener = state.qrOpener;
  state.qrOpener = null;
  if (opener && opener.isConnected) {
    opener.focus();
    return;
  }
  // A download reloads the list, so the button that opened the dialog can be gone. The
  // same action on the refreshed card is the closest place to return to; a slug never
  // contains a character that would escape the quoted attribute selector.
  const sameAction = slug
    ? linksList.querySelector(`[data-action="qrcode"][data-slug="${slug}"]`)
    : null;
  if (sameAction instanceof HTMLElement) {
    sameAction.focus();
    return;
  }
  searchTermInput.focus();
}

/**
 * Prepares the artifact a format asks for, or `null` when the current generation cannot
 * serve it. The PNG rides the object URL the dialog already owns; the SVG becomes a fresh
 * blob of the exact body the Worker returned — an object URL created for that download
 * alone and revoked with it, never kept in state.
 */
function qrDownloadArtifact(format, slug) {
  if (format === "svg") {
    if (!state.qrSvgText) {
      return null;
    }
    return {
      href: URL.createObjectURL(new Blob([state.qrSvgText], { type: "image/svg+xml;charset=utf-8" })),
      filename: `boltlink-${slug}-qr.svg`,
      ownsHref: true,
    };
  }
  if (!state.qrObjectUrl) {
    return null;
  }
  return {
    href: state.qrObjectUrl,
    filename: `boltlink-${slug}-qr.png`,
    ownsHref: false,
  };
}

/**
 * Returns a URL borrowed for one download on the next task, whatever else is in flight.
 *
 * The browser takes the file during the click itself, so the URL only has to survive that
 * frame; releasing it on a later task is the part that must not be done in the same frame,
 * where some browsers lose the download. The `finally` of the download already covers every
 * outcome the async block can report, but it cannot cover the one it never reaches: a
 * `has_qrcode` write that never settles holds that block open forever, and with it the URL.
 * This release is armed at the click and waits for nothing, so the client-side resource
 * stops depending on a server round trip it has no part in.
 */
function scheduleQrDownloadRevoke(href) {
  setTimeout(() => {
    URL.revokeObjectURL(href);
  }, 0);
}

/**
 * Hands the prepared artifact to the browser and records the "QR Ativo" flag.
 *
 * The download and the flag are two different facts: the file is delivered locally, while
 * the flag is a server write that can fail on its own. The dialog only claims the flag once
 * the API confirms it. A confirmation that arrives after the dialog moved on still keeps
 * its global effect — the list reflects the flag — but writes nothing into the link the
 * dialog is showing now.
 */
async function downloadQrCode(format) {
  if (!state.qrDialogOpen || !state.qrSlug) {
    return;
  }
  const slug = state.qrSlug;
  const token = state.qrRequestToken;
  const artifact = qrDownloadArtifact(format, slug);
  if (!artifact) {
    return;
  }
  const formatLabel = format.toUpperCase();
  const anchor = document.createElement("a");
  anchor.href = artifact.href;
  anchor.download = artifact.filename;
  anchor.click();
  // Only a URL this call created is this call's to return; the PNG one belongs to the
  // dialog and stays alive until the dialog releases it.
  if (artifact.ownsHref) {
    scheduleQrDownloadRevoke(artifact.href);
  }

  try {
    // The flag records that the operator actually obtained a QR, exactly as the previous
    // direct-download flow did; previewing alone keeps writing nothing.
    const marked = await markQrCodeGenerated(slug);
    if (marked) {
      // The flag really changed on the server, so the list is re-read whatever the dialog is
      // showing; only the request that asked for it may describe the result.
      await loadLinks(searchTermInput.value, searchGroupIdInput.value);
      if (!qrDownloadIsCurrent(token, slug)) {
        return;
      }
      setStatus(qrStatus, `QR Code ${formatLabel} baixado: ${buildShortLink(slug)}`, "success");
      return;
    }

    if (!qrDownloadIsCurrent(token, slug)) {
      return;
    }
    // The file was delivered, but the persisted state was not: the panel must never
    // announce a flag the API did not confirm.
    setStatus(
      qrStatus,
      `QR Code ${formatLabel} baixado, mas não foi possível confirmar o estado "QR Code baixado" de ${buildShortLink(slug)}.`,
      "error",
    );
  } finally {
    // Redundant with the deferred release on purpose, and it is the deferred one that
    // carries the guarantee: this only runs when the block ends, so it can shorten the
    // URL's life on the ordinary paths and can never lengthen it.
    if (artifact.ownsHref) {
      URL.revokeObjectURL(artifact.href);
    }
  }
}

async function copyQrLink() {
  if (!state.qrDialogOpen || !state.qrSlug) {
    return;
  }
  const shortLink = buildShortLink(state.qrSlug);
  try {
    await copyToClipboard(shortLink);
    setStatus(qrStatus, `Link copiado: ${shortLink}`);
  } catch {
    setStatus(qrStatus, `Copie manualmente: ${shortLink}`, "error");
  }
}

/**
 * Downloads the portability export.
 *
 * The request goes through the same authenticated `/api/export` route as every other
 * administrative call, and the body is handed to a `download` blob instead of being
 * navigated to, so the panel never renders raw JSON. The filename comes from
 * `Content-Disposition` through the shared helper, which falls back to a constant
 * whenever the header is absent or does not match the safe shape.
 */
async function exportConfiguration() {
  if (!portabilityUi) {
    setStatus(exportStatus, "O módulo de exportação não foi carregado. Recarregue o painel.", "error");
    return;
  }

  setBusy(exportButton, true);
  setStatus(exportStatus, "Preparando exportação...");

  try {
    const response = await fetch(portabilityUi.EXPORT_PATH, {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      let apiMessage = "";
      let apiCode = "";
      try {
        const payload = await response.json();
        apiMessage = typeof payload?.error === "string" ? payload.error : "";
        apiCode = typeof payload?.code === "string" ? payload.code : "";
      } catch {
        apiMessage = "";
      }

      setStatus(exportStatus, portabilityUi.exportErrorMessage(response.status, apiMessage, apiCode), "error");
      return;
    }

    const body = await response.text();
    const filename = portabilityUi.filenameFromDisposition(response.headers.get("Content-Disposition"));
    const blobUrl = URL.createObjectURL(new Blob([body], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = blobUrl;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(blobUrl);

    setStatus(exportStatus, `Exportação concluída: ${filename}`, "success");
  } catch (error) {
    setStatus(exportStatus, error?.message || "Não foi possível exportar a configuração. Tente novamente.", "error");
  } finally {
    setBusy(exportButton, false);
  }
}

/* Configuration import (published in 3.0.0; origin Phase 5, Gate 5.3).

   The drawer walks the operator through one decision at a time: pick the file, review what
   the API answered, supply a new password for every protected link, then apply. Nothing is
   rendered from a file through an HTML sink — every value goes in through `textContent` —
   and nothing about the file is kept after the drawer closes or the selection changes. */

/** Replaces a node's children without parsing any string as markup. */
function clearImportNode(node) {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

function appendImportLine(container, text) {
  const item = document.createElement("li");
  item.textContent = text;
  container.appendChild(item);
}

/** One `path — mensagem` line: the path is positional context from the API, not a dump. */
function appendImportIssue(container, path, message) {
  const item = document.createElement("li");
  const label = document.createElement("span");
  label.className = "import-error-path";
  label.textContent = path;
  const copy = document.createElement("span");
  copy.textContent = message;
  item.appendChild(label);
  item.appendChild(copy);
  container.appendChild(item);
}

function renderImportList(container, entries, render) {
  clearImportNode(container);
  for (const entry of entries) {
    render(container, entry);
  }
  container.hidden = entries.length === 0;
}

/** The review block is replaced wholesale, so no state from a previous file can survive. */
function resetImportReview() {
  // A reset is what replaces the document, so it is also what invalidates the identity of
  // the one being reviewed: a preview still in flight belongs to the previous file, and its
  // answer is dropped instead of describing what an apply would send. The machine is
  // created once and only ever advanced, so a ticket from an earlier selection can never
  // match a later one.
  if (portabilityImportUi) {
    state.importSelection = state.importSelection || portabilityImportUi.createImportSelection();
    state.importSelection.invalidate();
  }
  state.importDocument = null;
  state.importState = null;
  state.importApplying = false;
  discardImportPasswords();
  importReview.hidden = true;
  importSummary.hidden = true;
  importPlan.textContent = "";
  clearImportNode(importSummary);
  clearImportNode(importWarnings);
  clearImportNode(importConflicts);
  clearImportNode(importBlockers);
  clearImportNode(importErrors);
  importWarnings.hidden = true;
  importConflicts.hidden = true;
  importBlockers.hidden = true;
  importErrors.hidden = true;
  importDoneButton.hidden = true;
  importApplyButton.hidden = false;
  // Busy state first, then `disabled`: `setBusy` writes `disabled` itself, so a reset that
  // cleared the flag would leave the button clickable before any file was reviewed.
  setBusy(importApplyButton, false);
  importApplyButton.disabled = true;
}

/** Full reset: selection, review, passwords and status, so nothing outlives its file. */
function resetImportDrawer() {
  importFileInput.value = "";
  importFileName.textContent = "";
  resetImportReview();
  setStatus(importStatus, "");
}

function renderImportSummary(summary) {
  clearImportNode(importSummary);
  for (const line of portabilityImportUi.summaryLines(summary)) {
    const term = document.createElement("dt");
    term.textContent = line.label;
    const value = document.createElement("dd");
    value.textContent = line.value;
    importSummary.appendChild(term);
    importSummary.appendChild(value);
  }
  importSummary.hidden = false;
}

function renderImportWarnings(payload) {
  const messages = portabilityImportUi.warningMessages(payload);
  renderImportList(importWarnings, messages, appendImportLine);
}

/** One password field per protected slug: never pre-filled, never stored anywhere. */
function renderImportPasswords(slugs) {
  clearImportNode(importPasswordFields);

  for (let index = 0; index < slugs.length; index += 1) {
    const slug = slugs[index];
    const field = document.createElement("div");
    field.className = "import-password-field";

    const inputId = `import-password-${index}`;
    const label = document.createElement("label");
    label.setAttribute("for", inputId);
    label.textContent = `Nova senha para ${slug}`;

    const input = document.createElement("input");
    input.type = "password";
    input.id = inputId;
    input.autocomplete = "new-password";
    input.dataset.slug = slug;

    field.appendChild(label);
    field.appendChild(input);
    importPasswordFields.appendChild(field);
  }

  importPasswords.hidden = slugs.length === 0;
}

/**
 * Empties the password fields and drops the nodes that hold them. Every terminal outcome of
 * an apply goes through here, and so does the reset that a new file, a close and the reset
 * button all share: a password typed for an attempt that failed is not reusable, and the
 * operator types it again for the next one. The mapping built for the request is a local of
 * `applyImport` and outlives nothing.
 */
function discardImportPasswords() {
  if (portabilityImportUi) {
    portabilityImportUi.clearPasswordInputs(importPasswordFields.querySelectorAll("input[data-slug]"));
  }
  clearImportNode(importPasswordFields);
  importPasswords.hidden = true;
}

/**
 * The mapping the apply sends, one entry per filled field, built by the helper so a slug
 * like `__proto__` stays an own property instead of being swallowed by object assignment.
 */
function collectImportPasswords() {
  const entries = [];
  for (const input of importPasswordFields.querySelectorAll("input[data-slug]")) {
    const value = input.value.trim();
    if (value) {
      entries.push({ slug: input.dataset.slug, value });
    }
  }
  return portabilityImportUi.passwordMap(entries);
}

/**
 * Ends the attempt that just finished, whatever its outcome was: the passwords typed for it
 * are discarded and the approved preview stops authorizing anything, so a new preview is
 * the only way back to an apply. Called on refusal, on transport failure and on success.
 */
function endImportAttempt() {
  discardImportPasswords();
  state.importState = null;
  if (state.importSelection) {
    state.importSelection.revokePreview();
  }
}

/**
 * Whether the preview answer for `generation` still describes the document the drawer is
 * showing. A stale answer is dropped without a trace: the selection that replaced it is
 * already being validated, and its own answer is the one the operator is waiting for.
 */
function importSelectionStale(generation) {
  return !state.importSelection || !state.importSelection.isCurrent(generation);
}

/**
 * The apply control is enabled by the API's answer, never by the file: a valid preview
 * with no blocker and no collision, approved for the selection the drawer is showing now,
 * plus a non-empty password for every protected link.
 */
function syncImportApplyState() {
  if (state.importApplying) {
    return;
  }

  let enabled = Boolean(
    state.importState === portabilityImportUi.STATE_VALID && state.importSelection && state.importSelection.canApply(),
  );
  if (enabled) {
    for (const input of importPasswordFields.querySelectorAll("input[data-slug]")) {
      if (!input.value.trim()) {
        enabled = false;
        break;
      }
    }
  }

  importApplyButton.disabled = !enabled;
}

function renderImportResult(payload, status, generation) {
  const ui = portabilityImportUi;
  // The document this answer describes is no longer the one in the drawer, so none of it
  // may reach the panel — not the summary, not the conflicts, not the password fields.
  if (importSelectionStale(generation)) {
    return;
  }

  const responseState = ui.responseState(payload);
  state.importState = responseState;
  // An approved preview is what authorizes an apply, and only for the selection it was
  // requested for: the ticket recorded here is compared against the current generation.
  if (responseState === ui.STATE_VALID) {
    state.importSelection.markPreview(generation);
  }
  importReview.hidden = false;

  // The summary belongs to both answers: on a valid plan it is what the operator reviews
  // before importing, and on a refused one it still describes the file that was refused.
  renderImportSummary(payload?.summary);

  renderImportWarnings(payload);
  renderImportList(importConflicts, ui.conflictSlugs(payload), appendImportLine);
  renderImportList(importBlockers, ui.blockerMessages(payload), appendImportLine);
  renderImportList(
    importErrors,
    Array.isArray(payload?.errors) ? payload.errors : [],
    (container, entry) => appendImportIssue(container, entry?.path ?? "documento", ui.errorMessage(entry?.code)),
  );
  renderImportPasswords(responseState === ui.STATE_VALID ? ui.requiresPasswordSlugs(payload) : []);

  importPlan.textContent = responseState === ui.STATE_VALID ? ui.planText(payload?.summary) : "";
  importDoneButton.hidden = true;
  importApplyButton.hidden = false;
  syncImportApplyState();

  if (responseState === ui.STATE_VALID) {
    const protectedCount = ui.requiresPasswordSlugs(payload).length;
    setStatus(
      importStatus,
      protectedCount
        ? `Arquivo validado. Informe ${protectedCount} nova(s) senha(s) para continuar.`
        : "Arquivo validado. Revise o resumo antes de importar.",
      "success",
    );
    return;
  }

  setStatus(importStatus, ui.previewErrorMessage(status, payload?.code), "error");
}

async function requestImportPreview(document, generation) {
  // The request that was superseded is cancelled, which is a courtesy rather than the
  // guarantee: a cancellation can arrive after its response, so the generation check below
  // stays the authority and the abort only saves the round trip.
  if (state.importPreviewAbort) {
    state.importPreviewAbort.abort();
  }
  const controller = new AbortController();
  state.importPreviewAbort = controller;

  let response;
  try {
    response = await fetch(portabilityImportUi.PREVIEW_PATH, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(portabilityImportUi.envelopeFor(document)),
      signal: controller.signal,
    });
  } catch (error) {
    // A request that failed for a document the operator already replaced — including by
    // this selection's own cancellation — has nothing to report about the current one.
    if (importSelectionStale(generation)) {
      return;
    }
    throw error;
  } finally {
    if (state.importPreviewAbort === controller) {
      state.importPreviewAbort = null;
    }
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (importSelectionStale(generation)) {
    return;
  }

  if (!payload) {
    setStatus(importStatus, portabilityImportUi.previewErrorMessage(response.status), "error");
    return;
  }

  renderImportResult(payload, response.status, generation);
}

/** Reads the chosen file and asks the API what would happen. Nothing is written here. */
async function handleImportFileSelection() {
  if (!portabilityImportUi) {
    setStatus(importStatus, "O módulo de importação não foi carregado. Recarregue o painel.", "error");
    return;
  }

  const file = importFileInput.files && importFileInput.files[0];
  resetImportReview();
  // The identity of this selection, taken before the first await: choosing another file
  // while this one is being read invalidates it, and every step below refuses to write to
  // the panel or to the state under a generation that stopped being the current one.
  const generation = state.importSelection.generation;
  setStatus(importStatus, "");

  if (!file) {
    importFileName.textContent = "";
    return;
  }

  importFileName.textContent = file.name;

  if (portabilityImportUi.fileTooLarge(file.size)) {
    setStatus(
      importStatus,
      `Arquivo maior que o limite de ${portabilityImportUi.formatBytes(portabilityImportUi.MAX_BYTES)} do formato.`,
      "error",
    );
    return;
  }

  let parsed = null;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    if (importSelectionStale(generation)) {
      return;
    }
    setStatus(importStatus, "Não foi possível ler o arquivo como JSON. Verifique se ele não está corrompido.", "error");
    return;
  }

  if (importSelectionStale(generation)) {
    return;
  }

  const localProblem = portabilityImportUi.localDocumentProblem(parsed);
  if (localProblem) {
    setStatus(importStatus, localProblem, "error");
    return;
  }

  state.importDocument = parsed;
  setStatus(importStatus, "Validando arquivo...");

  try {
    await requestImportPreview(parsed, generation);
  } catch (error) {
    if (importSelectionStale(generation)) {
      return;
    }
    setStatus(importStatus, error?.message || "Não foi possível validar o arquivo.", "error");
  }
}

/**
 * Applies the document the preview describes. The body carries the same file the operator
 * reviewed plus the passwords just typed; the API revalidates everything and writes the
 * whole document as one transaction, so a failure means the destination is untouched.
 *
 * The document is not enough on its own: the approval has to belong to the selection the
 * drawer is showing, so a file chosen while a previous plan was approved cannot be applied
 * under that plan's review.
 */
async function applyImport() {
  if (state.importApplying || !state.importDocument || !state.importSelection || !state.importSelection.canApply()) {
    return;
  }

  state.importApplying = true;
  setBusy(importApplyButton, true);
  importResetButton.disabled = true;
  setStatus(importStatus, "Importando configuração...");

  try {
    const response = await fetch(portabilityImportUi.APPLY_PATH, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(
        portabilityImportUi.envelopeFor(state.importDocument, collectImportPasswords()),
      ),
    });

    // The body is handed over as text and interpreted by the helper, so the verdict comes from
    // the status *and* a body that is actually the contract. An unreadable body is not a
    // refusal: a `200` whose response was truncated may be an import that already committed,
    // and the panel has no evidence either way.
    const verdict = portabilityImportUi.readApplyResponse(response.status, await response.text());

    if (verdict.verdict === portabilityImportUi.VERDICT_UNKNOWN) {
      renderImportUnknownOutcome(null);
      return;
    }

    if (verdict.verdict === portabilityImportUi.VERDICT_REFUSED) {
      // A refused apply is an apply that wrote nothing: the import is one transaction, so
      // the panel can say that plainly instead of guessing at a partial result.
      renderImportFailure(verdict.payload, verdict.status);
      return;
    }

    renderImportSuccess(verdict.payload);
  } catch (error) {
    // The request never produced an answer at all, which is the same non-answer as a response
    // nobody can read: nothing typed for the attempt is kept, and no outcome is claimed.
    renderImportUnknownOutcome(error?.message);
  } finally {
    state.importApplying = false;
    setBusy(importApplyButton, false);
    importResetButton.disabled = false;
    // Whatever the outcome was, the control ends up in the state the review supports
    // instead of whatever the path that just ran happened to leave behind.
    syncImportApplyState();
  }
}

/**
 * The outcome of an apply nobody can confirm: the request produced no answer, or the answer
 * it produced is not the contract. Nothing is said about the destination — it may hold the
 * whole document or none of it — so the attempt ends like every other terminal outcome
 * (passwords discarded, approval revoked, apply unavailable) and the operator reloads and
 * reviews the current state instead of being told that a rollback happened.
 */
function renderImportUnknownOutcome(detail) {
  const plan = portabilityImportUi.unknownOutcomePlan(detail);
  if (plan.discardPasswords) {
    endImportAttempt();
  }
  importApplyButton.hidden = true;
  importDoneButton.hidden = false;
  setStatus(importStatus, plan.message, "error");
}

function renderImportFailure(payload, status) {
  const ui = portabilityImportUi;
  // Every terminal failure ends the attempt: the passwords typed for it are discarded (they
  // were typed for a review that no longer authorizes anything) and a new preview is the
  // way back.
  if (ui.applyFailureDisposition(status).discardPasswords) {
    endImportAttempt();
  }

  importErrors.hidden = true;
  clearImportNode(importErrors);

  if (payload && Array.isArray(payload.blockers) && payload.blockers.length) {
    renderImportList(importBlockers, ui.blockerMessages(payload), appendImportLine);
    renderImportList(importConflicts, ui.conflictSlugs(payload), appendImportLine);
    // Rebuilt empty for the links that still need one: knowing which slugs owe a password
    // is useful, keeping the values that were just refused is not.
    renderImportPasswords(ui.requiresPasswordSlugs(payload));
  } else if (payload && Array.isArray(payload.errors)) {
    renderImportList(
      importErrors,
      payload.errors,
      (container, entry) => appendImportIssue(container, entry?.path ?? "documento", ui.errorMessage(entry?.code)),
    );
  }

  setStatus(importStatus, `${ui.applyErrorMessage(status, payload?.code)} Nenhuma alteração foi aplicada.`, "error");
  // A new preview is the way out of a conflict: the file is still loaded, so the operator
  // can simply ask again once the destination changed.
  importApplyButton.hidden = true;
  importApplyButton.disabled = true;
  importDoneButton.hidden = false;
}

function renderImportSuccess(payload) {
  const ui = portabilityImportUi;
  importConflicts.hidden = true;
  importBlockers.hidden = true;
  importErrors.hidden = true;
  // The attempt is over: the passwords did their job and are gone, and the approval that
  // authorized this apply does not survive it.
  endImportAttempt();
  importPlan.textContent = "";
  importApplyButton.hidden = true;
  importDoneButton.hidden = false;
  setStatus(importStatus, ui.successText(payload), "success");

  // The panel reflects the new configuration without a reload: the list, the group tree,
  // the group selects and the group filter all read from the API again.
  loadCapabilities()
    .catch(() => {})
    .finally(() => {
      loadLinks().catch(() => {});
      loadGroups().catch(() => {});
      if (trashController) trashController.refresh().catch(() => {});
    });
}

function importDrawerFocusables() {
  return drawerFocusables(importDrawer);
}

function keepImportDrawerFocus(event) {
  keepDrawerFocus(event, importDrawer);
}

function onImportDrawerKeydown(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    closeImportDrawer();
    return;
  }
  keepImportDrawerFocus(event);
}

/**
 * Opening the import closes the group drawer, and vice versa: the two are modal, so
 * leaving one open behind the other would either trap focus in an invisible surface or
 * let a click reach a panel the operator cannot see.
 */
function openImportDrawer() {
  if (state.importDrawerOpen) {
    return;
  }
  closeGroupDrawer();
  closeTrashDrawer();
  closeQrDialog();
  state.importDrawerOpen = true;
  // A fresh session never inherits the previous one's file, summary or passwords.
  resetImportDrawer();
  setStatus(exportStatus, "");
  lockBodyScroll();
  importDrawerOpenButton.setAttribute("aria-expanded", "true");
  importDrawer.removeAttribute("inert");
  importDrawer.setAttribute("aria-hidden", "false");
  importDrawer.classList.add("is-open");
  importDrawerBackdrop.classList.add("is-open");
  document.addEventListener("keydown", onImportDrawerKeydown);
  importDrawerCloseButton.focus();
}

function closeImportDrawer() {
  if (!state.importDrawerOpen) {
    return;
  }
  state.importDrawerOpen = false;
  document.removeEventListener("keydown", onImportDrawerKeydown);
  importDrawer.classList.remove("is-open");
  importDrawerBackdrop.classList.remove("is-open");
  importDrawer.setAttribute("inert", "");
  importDrawer.setAttribute("aria-hidden", "true");
  importDrawerOpenButton.setAttribute("aria-expanded", "false");
  // Closing discards the file and the passwords: a modal that reopens pre-filled would
  // invite an apply the operator did not review.
  resetImportDrawer();
  unlockBodyScroll();
  importDrawerOpenButton.focus();
}

function onTrashDrawerKeydown(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    closeTrashDrawer();
    return;
  }
  keepDrawerFocus(event, trashDrawer);
}

function openTrashDrawer() {
  if (state.trashDrawerOpen) return;
  closeGroupDrawer();
  closeImportDrawer();
  closeQrDialog();
  state.trashDrawerOpen = true;
  lockBodyScroll();
  trashDrawerOpenButton.setAttribute("aria-expanded", "true");
  trashDrawer.removeAttribute("inert");
  trashDrawer.setAttribute("aria-hidden", "false");
  trashDrawer.classList.add("is-open");
  trashDrawerBackdrop.classList.add("is-open");
  document.addEventListener("keydown", onTrashDrawerKeydown);
  trashDrawerCloseButton.focus();
  if (trashController) trashController.open();
}

function closeTrashDrawer() {
  if (!state.trashDrawerOpen) return;
  state.trashDrawerOpen = false;
  document.removeEventListener("keydown", onTrashDrawerKeydown);
  trashDrawer.classList.remove("is-open");
  trashDrawerBackdrop.classList.remove("is-open");
  trashDrawer.setAttribute("inert", "");
  trashDrawer.setAttribute("aria-hidden", "true");
  trashDrawerOpenButton.setAttribute("aria-expanded", "false");
  if (trashController) trashController.close();
  unlockBodyScroll();
  trashDrawerOpenButton.focus();
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
  smartRoutingFallback.textContent = value ? `Se nenhuma regra corresponder: ${value}` : "Se nenhuma regra corresponder: destino principal do link";
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

// The creation form collapses on its own only where the links list is the main content:
// below this width the form would otherwise own the first screen.
const createFormMedia = window.matchMedia("(max-width: 900px)");

/** The section heading remains in the page when the mobile form folds. */
function setCreateFormCollapsed(collapsed) {
  state.createFormCollapsed = collapsed;
  linkForm.hidden = collapsed;
  if (collapsed && linkForm.contains(document.activeElement)) createLinkToggleButton.focus();
  createLinkToggleButton.setAttribute("aria-expanded", String(!collapsed));
}

/** After saving or cancelling there is nothing left to submit, so the card folds back. */
function collapseCreateFormIfNarrow() {
  if (createFormMedia.matches) {
    setCreateFormCollapsed(true);
  }
}

function resetForm() {
  state.editingSlug = null;
  state.pendingUtmFields = {};
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
  createLinkLabel.textContent = "Criar link";
  submitButton.innerHTML = buttonMarkup("save", "Salvar link");
  cancelButton.innerHTML = buttonMarkup("cancel", "Cancelar");
  cancelButton.hidden = true;
  setStatus(formStatus, "");
  refreshUtmPreview();
  refreshDomainWarning();
  renderLinkPreview(null);
  collapseCreateFormIfNarrow();
}

function beginEdit(link) {
  state.editingSlug = link.slug;
  state.pendingUtmFields = {};
  // Editing happens from a card in the list, so the form has to be on screen before it is
  // filled in.
  setCreateFormCollapsed(false);
  slugInput.value = link.slug;
  targetUrlInput.value = link.target_url;
  hydrateUtmFields();
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
      ? "Este link tem Teste A/B e Smart Routing configurados ao mesmo tempo. O redirecionamento usa o destino principal; escolha apenas um dos recursos para corrigir."
      : "",
  );
  setSmartRoutingError("");

  syncRedirectConstraint();
  renderSmartRules();
  slugInput.readOnly = true;
  formTitle.textContent = `Editar /${link.slug}`;
  createLinkLabel.textContent = `Editar /${link.slug}`;
  submitButton.innerHTML = buttonMarkup("update", "Atualizar");
  cancelButton.innerHTML = buttonMarkup("cancel", "Cancelar");
  cancelButton.hidden = false;
  setStatus(formStatus, "O slug não pode ser alterado após a criação. Você pode editar os demais campos do link.");
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

/** One badge vocabulary for the whole list: the hue names the BoltLink feature, the text
    names its state. Classification (group) and user-created data never use these classes. */
function featureBadge(kind, content) {
  return `<span class="feature-badge feature-badge--${kind}">${content}</span>`;
}

/** Level 3 keeps the A/B state to a single line: the split while it runs, "Encerrado" after. */
function renderAbMetrics(link) {
  const display = window.BoltLinkAbDisplay?.buildAbDisplay(link);
  if (!display) {
    return "";
  }

  const summary = display.isActive && display.allocation ? display.allocation : display.title;
  return featureBadge("ab", `Teste A/B · <strong>${escapeHtml(summary)}</strong>`);
}

/** The A/B counters exist nowhere else, so they stay in the DOM inside the card's closed
    `<details>` instead of being dropped from the list. */
function renderAbBreakdown(link) {
  const display = window.BoltLinkAbDisplay?.buildAbDisplay(link);
  if (!display) {
    return "";
  }

  const rows = [];
  if (display.showHistoricalLabel) {
    rows.push('<span class="metric">Resultados do último teste</span>');
  }
  rows.push(`<span class="metric">Cliques A <strong>${display.clicksA}</strong></span>`);
  rows.push(`<span class="metric">Cliques B <strong>${display.clicksB}</strong></span>`);
  rows.push(`<span class="metric">Distribuição observada <strong>${display.observed}</strong></span>`);
  if (display.allocation) {
    rows.push(`<span class="metric">Distribuição do tráfego <strong>${display.allocation}</strong></span>`);
  }
  if (display.nextTest) {
    rows.push(`<span class="metric">Próximo teste <strong>${escapeHtml(display.nextTest.allocation)} · ${escapeHtml(display.nextTest.targetUrl)}</strong></span>`);
  }

  return `<div class="card-details-metrics">${rows.join("")}</div>`;
}

/** Smart Routing is a BoltLink feature, so it keeps the routing hue in every state; the text
    carries the state itself. Rule details stay in the editor, never in the list. */
function renderSmartBadge(link) {
  const badge = smartRoutingUi ? smartRoutingUi.smartBadge(link, state.smartRouting) : null;
  if (!badge) {
    return "";
  }
  if (badge.corrupt) {
    return featureBadge("routing", badge.conflict
      ? 'Smart Routing <strong>configuração inválida preservada</strong> · Teste A/B ativo'
      : 'Smart Routing <strong>configuração inválida preservada</strong>');
  }
  if (badge.conflict) {
    return featureBadge("routing", 'Smart Routing <strong>configuração ambígua</strong>');
  }
  const suffix = badge.count === 1 ? "regra" : "regras";
  return featureBadge("routing", `Smart Routing · <strong>${badge.count} ${suffix}</strong>`);
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

/** Full text stays in the DOM; only its presentation is clamped. The `title` keeps the
    complete value readable when the clamp hides part of a long URL, and it precedes `id`
    so the measured-expander contract for the variant URL stays intact. */
function linkContentMarkup(value, label, id, isSlug = false, copyValue = null) {
  const tag = isSlug ? "p" : "div";
  const className = isSlug ? "slug" : "slug-url";
  return `<div class="link-content">
    <${tag} class="${className} content-text" title="${escapeHtml(value)}" id="${id}">${escapeHtml(value)}</${tag}>
    <div class="content-actions">
    ${copyValue === null ? "" : `<button type="button" class="content-copy copy-control" data-copy-value="${escapeHtml(copyValue)}" data-copy-kind="${label === "URL da variante B" ? "variant" : "destination"}" aria-label="Copiar destino: ${escapeHtml(label)}"><span class="copy-idle">Copiar destino</span><span class="copy-feedback" aria-hidden="true"></span></button>`}
    <button type="button" class="content-toggle" data-content-label="${escapeHtml(label)}" aria-controls="${id}" aria-expanded="false" aria-label="Ver mais: ${escapeHtml(label)}" hidden>Ver mais</button>
    </div>
  </div>`;
}

/** Measure the collapsed layout, including after fonts or viewport widths change. */
function refreshLinkContent() {
  linksList.querySelectorAll(".content-toggle").forEach((button) => {
    const text = document.getElementById(button.getAttribute("aria-controls"));
    const expanded = button.getAttribute("aria-expanded") === "true";
    const focused = document.activeElement === button;
    text.classList.remove("is-expanded");
    const truncated = text.scrollHeight > text.clientHeight + 1 || text.scrollWidth > text.clientWidth + 1;
    const keepExpanded = expanded && truncated;
    text.classList.toggle("is-expanded", keepExpanded);
    button.hidden = !truncated;
    button.setAttribute("aria-expanded", String(keepExpanded));
    button.textContent = keepExpanded ? "Ver menos" : "Ver mais";
    button.setAttribute("aria-label", `${button.textContent}: ${button.dataset.contentLabel}`);
    if (button.hidden && focused) {
      button.closest(".card").querySelector('button[data-action="copy"], button[data-action="undo-delete"]')?.focus();
    }
  });
}

function toggleLinkContent(button) {
  const text = document.getElementById(button.getAttribute("aria-controls"));
  const expanded = button.getAttribute("aria-expanded") !== "true";
  text.classList.toggle("is-expanded", expanded);
  button.setAttribute("aria-expanded", String(expanded));
  button.textContent = expanded ? "Ver menos" : "Ver mais";
  button.setAttribute("aria-label", `${button.textContent}: ${button.dataset.contentLabel}`);
}

let contentMeasureFrame = null;
function scheduleLinkContentMeasure() {
  if (contentMeasureFrame !== null) return;
  contentMeasureFrame = window.requestAnimationFrame(() => {
    contentMeasureFrame = null;
    refreshLinkContent();
  });
}

function restoreCopyFeedback(button, control) {
  delete button.dataset.copyState;
  button.querySelector(".copy-feedback").textContent = "";
  for (const [attribute, value] of [["aria-label", control.label], ["title", control.title]]) {
    if (value === null) button.removeAttribute(attribute);
    else button.setAttribute(attribute, value);
  }
}

/** Each control owns its timer and request generation; URLs never become feedback text. */
async function copyWithFeedback(button, value, kind = "destination") {
  const messages = {
    short: { label: "link curto", success: "Link curto copiado", error: "Não foi possível copiar o link" },
    destination: { label: "URL de destino", success: "URL de destino copiada", error: "Não foi possível copiar a URL de destino" },
    variant: { label: "URL da Variante B", success: "URL da Variante B copiada", error: "Não foi possível copiar a URL da Variante B" },
  }[kind];
  let control = copyFeedbackStates.get(button);
  if (!control) {
    control = { label: button.getAttribute("aria-label"), title: button.getAttribute("title"), generation: 0, timer: null };
    copyFeedbackStates.set(button, control);
  }
  const generation = ++control.generation;
  clearTimeout(control.timer);
  control.timer = null;
  restoreCopyFeedback(button, control);
  button.setAttribute("aria-busy", "true");
  let success = false;
  try {
    await copyToClipboard(value);
    success = true;
  } catch {
    // Neither the persisted URL nor a clipboard error is suitable announcement text.
  }
  if (generation !== control.generation) return;
  button.removeAttribute("aria-busy");
  if (!button.isConnected) return;
  const label = success ? "Copiado" : "Falhou";
  button.dataset.copyState = success ? "success" : "error";
  button.querySelector(".copy-feedback").innerHTML = buttonMarkup(success ? "check" : "cancel", label);
  button.setAttribute("aria-label", `${label}: ${messages.label}`);
  button.setAttribute("title", success ? messages.success : messages.error);
  copyStatus.textContent = success ? messages.success : messages.error;
  control.timer = setTimeout(() => {
    restoreCopyFeedback(button, control);
    control.timer = null;
  }, 1800);
}

function renderLinks() {
  linksCount.textContent = String(state.links.length);

  if (!state.links.length) {
    linksList.innerHTML = '<div class="empty">Nenhum link ativo ainda. Preencha o formulário para criar o primeiro.</div>';
    return;
  }

  linksList.innerHTML = state.links
    .map((link, index) => {
      const isPendingDelete = state.pendingDeletes.has(link.slug);
      const cardClass = isPendingDelete ? "card is-pending" : "card";
      const actionMarkup = isPendingDelete
        ? cardActionMarkup("undo-delete", "secondary", "cancel", "Desfazer", link.slug)
        : `
          <div class="primary-actions">
            ${cardActionMarkup("copy", "secondary", "copy", "Copiar link", link.slug)}
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

      const groupPath = state.groupTree && groupHierarchyUi && link.group_id != null
        ? groupHierarchyUi.groupPath(state.groupTree.byId, link.group_id)
        : link.group_name || "";

      // Redirect types are a closed set owned by BoltLink, so the label is spelled out for
      // scanning instead of leaving a bare "302" on the metadata line.
      const redirectType = link.redirect_type || "302";
      const redirectLabel = { "301": "301 (permanente)", "302": "302 (temporário)" }[redirectType] || redirectType;

      // Level 3 summarizes the experiment; the variant destination and the counters stay
      // reachable inside one collapsed `<details>`, so compacting never removes information.
      const variantMarkup = link.ab_enabled === 1 && link.ab_target_url
        ? `<div class="variant-content"><span class="content-label">Variante B</span>${linkContentMarkup(link.ab_target_url, "URL da variante B", `link-content-${index}-variant`, false, link.ab_target_url)}</div>`
        : "";
      const abBreakdown = renderAbBreakdown(link);
      const abDetails = variantMarkup || abBreakdown
        ? `<details class="card-details">
              <summary>Ver detalhes</summary>
              ${variantMarkup}
              ${abBreakdown}
            </details>`
        : "";

      return `
        <article class="${cardClass}">
          <div class="card-top">
            <div class="slug-info">
              ${linkContentMarkup(`/${link.slug}`, "slug", `link-content-${index}-slug`, true)}
            </div>
            <div class="card-actions">
              ${actionMarkup}
            </div>
          </div>
          <div class="card-destination">
            ${linkContentMarkup(link.target_url, "URL de destino", `link-content-${index}-url`, false, link.target_url)}
          </div>
          <div class="link-states">
            ${groupPath ? `<span class="group-badge" title="${escapeHtml(groupPath)}" aria-label="Grupo: ${escapeHtml(groupPath)}">${escapeHtml(groupPath)}</span>` : ""}
            ${link.has_qrcode ? '<span class="feature-badge feature-badge--qr">QR Code baixado</span>' : ""}
            ${link.has_password ? '<span class="feature-badge feature-badge--lock">Senha definida</span>' : ""}
            ${renderSmartBadge(link)}
            ${renderAbMetrics(link)}
          </div>
          ${abDetails}
          <div class="metrics">
            <span class="metric">Cliques <strong>${link.clicks_total}</strong></span>
            <span class="metric">Criado: <strong>${formatDate(link.created_at)}</strong></span>
            <span class="metric">Redirecionamento <strong>${escapeHtml(redirectLabel)}</strong></span>
            ${link.expires_at ? `<span class="metric">Expira <strong>${formatDate(link.expires_at)}</strong></span>` : ""}
            ${link.go_live_at ? `<span class="metric">Ativa <strong>${formatDate(link.go_live_at)}</strong></span>` : ""}
            ${isPendingDelete ? `<span class="metric pending-note">Exclusão em <strong>${Math.ceil((state.pendingDeletes.get(link.slug)?.remaining || 0) / 1000)}s</strong></span>` : ""}
          </div>
          ${parsedTags.length ? `<div class="link-tags">${linkContentMarkup(`Tags: ${parsedTags.join(", ")}`, "tags", `link-content-${index}-tags`)}</div>` : ""}
        </article>
      `;
    })
    .join("");
  scheduleLinkContentMeasure();
}

async function loadLinks(searchTerm = searchTermInput.value, groupFilter = searchGroupIdInput.value) {
  const generation = state.linksRequestGeneration = (state.linksRequestGeneration || 0) + 1;
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
      if (normalizedGroupFilter !== "__none__") queryParams.set("include_descendants", "true");
    }

    const queryString = queryParams.toString();
    const payload = await request(`/api/links${queryString ? `?${queryString}` : ""}`, { method: "GET" });
    if (generation !== state.linksRequestGeneration) return;
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
    if (generation !== state.linksRequestGeneration) return;
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
  setStatus(listStatus, `/${link.slug} será excluído em 5 segundos. O link irá para a Lixeira e poderá ser restaurado. Use Desfazer para cancelar.`);
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
    if (trashController) await trashController.refresh();
    setStatus(listStatus, `/${slug} movido para a Lixeira. Restaure ou exclua definitivamente para liberar o slug.`, "success");
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

  // Manual URL edits are authoritative even when submit happens before blur.
  hydrateUtmFields();
  const urlWithUtm = utmUi?.normalizeUtmDuplicates(targetUrlInput.value.trim()) || targetUrlInput.value.trim();
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

      setStatus(formStatus, feedback.formStatus || "Não foi possível concluir a operação. Tente novamente.", "error");
      return;
    }

    const successMessage = state.editingSlug
      ? `Link /${state.editingSlug} atualizado.`
      : `Link /${result.payload.link.slug} criado com sucesso.`;

    resetForm();
    await loadLinks();
    setStatus(formStatus, successMessage, "success");
    if (state.createFormCollapsed) setStatus(listStatus, successMessage, "success");
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

groupDrawerOpenButton.addEventListener("click", () => {
  openGroupDrawer();
});

groupDrawerCloseButton.addEventListener("click", () => {
  closeGroupDrawer();
});

// The backdrop is a separate element behind the drawer, so its own clicks close and a
// click that started inside the drawer never does.
groupDrawerBackdrop.addEventListener("click", () => {
  closeGroupDrawer();
});

groupCreateButton.addEventListener("click", () => {
  createGroupFromPanel();
});

groupTabTreeButton.addEventListener("click", () => {
  selectGroupTab("tree");
});

groupTabCreateButton.addEventListener("click", () => {
  selectGroupTab("create");
});

document.querySelector(".group-tabs").addEventListener("keydown", onGroupTabsKeydown);

groupContextConfirmButton.addEventListener("click", () => {
  confirmGroupContext();
});

groupContextCancelButton.addEventListener("click", () => {
  closeGroupContext();
});

groupRefreshButton.addEventListener("click", async () => {
  await loadGroups();
  setStatus(groupStatus, "Grupos recarregados.");
});

trashDrawerOpenButton.addEventListener("click", openTrashDrawer);
trashDrawerCloseButton.addEventListener("click", closeTrashDrawer);
trashDrawerBackdrop.addEventListener("click", closeTrashDrawer);

createLinkToggleButton.addEventListener("click", () => {
  setCreateFormCollapsed(!state.createFormCollapsed);
});

exportButton.addEventListener("click", () => {
  exportConfiguration();
});

importDrawerOpenButton.addEventListener("click", () => {
  openImportDrawer();
});

importDrawerCloseButton.addEventListener("click", () => {
  closeImportDrawer();
});

importDrawerBackdrop.addEventListener("click", () => {
  closeImportDrawer();
});

importDoneButton.addEventListener("click", () => {
  closeImportDrawer();
});

// A new selection invalidates everything the previous file produced, including the
// passwords, so the apply can never refer to a document the operator is no longer seeing.
importFileInput.addEventListener("change", () => {
  handleImportFileSelection();
});

importPasswordFields.addEventListener("input", () => {
  syncImportApplyState();
});

importApplyButton.addEventListener("click", () => {
  applyImport();
});

importResetButton.addEventListener("click", () => {
  resetImportDrawer();
  importFileInput.focus();
});

qrDialogCloseButton.addEventListener("click", () => {
  closeQrDialog();
});

qrDialogBackdrop.addEventListener("click", () => {
  closeQrDialog();
});

qrDownloadPngButton.addEventListener("click", () => {
  downloadQrCode("png");
});

qrDownloadSvgButton.addEventListener("click", () => {
  downloadQrCode("svg");
});

qrCopyButton.addEventListener("click", () => {
  copyQrLink();
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

  // The empty state is not a row: it swaps to the creation tab and goes straight to the
  // field the operator has to fill in.
  if (button.dataset.groupAction === "create-first") {
    selectGroupTab("create");
    groupCreateNameInput.focus();
    return;
  }

  const node = button.closest(".group-node");
  const groupId = node ? Number(node.dataset.groupId) : Number.NaN;
  if (!Number.isInteger(groupId)) {
    return;
  }

  // Row actions live in a `…` menu: choosing one closes it, so the same menu is not left
  // open over the tree while its editor runs.
  const menu = button.closest("details.group-node-menu");
  if (menu) {
    menu.removeAttribute("open");
  }

  const action = button.dataset.groupAction;
  if (action === "toggle") {
    toggleGroupExpansion(groupId);
    return;
  }
  if (action === "move" || action === "rename") {
    openGroupContext(action, groupId);
    return;
  }
  if (action === "delete") {
    deleteGroupFromPanel(groupId);
  }
});

// The row menu is absolutely positioned inside the scrolling drawer body, so a row near the
// bottom would open with part of its menu below the fold. Opening one brings the menu into
// view instead of shipping a portal. Captured because `toggle` does not bubble out of the
// <details> it belongs to.
groupTreeContainer.addEventListener(
  "toggle",
  (event) => {
    const menu = event.target;
    if (!menu.classList || !menu.classList.contains("group-node-menu") || !menu.hasAttribute("open")) {
      return;
    }
    menu.querySelector(".dropdown-menu").scrollIntoView({ block: "nearest" });
  },
  true,
);

groupCreateNameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    createGroupFromPanel();
  }
});

[targetUrlInput, utmSourceInput, utmMediumInput, utmCampaignInput, utmContentInput, utmTermInput].forEach((input) => {
  input.addEventListener("input", () => {
    if (input !== targetUrlInput) {
      if (utmUi) {
        const index = [utmSourceInput, utmMediumInput, utmCampaignInput, utmContentInput, utmTermInput].indexOf(input);
        state.pendingUtmFields[utmUi.KEYS[index]] = input.value;
        hydrateUtmFields();
      }
    }
    refreshUtmPreview();
    refreshDomainWarning();
    refreshSmartFallback();
    schedulePreviewLoad();
  });
});

targetUrlInput.addEventListener("blur", () => {
  hydrateUtmFields();
  refreshUtmPreview();
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

window.addEventListener("resize", scheduleLinkContentMeasure);
if (document.fonts) document.fonts.ready.then(scheduleLinkContentMeasure);
linksList.addEventListener("click", async (event) => {
  const button = event.target.closest("button.content-toggle, button.content-copy");
  if (!button) {
    // Opening the card details reveals long variant URLs that measured as unrendered while
    // the details was closed, so the expanders have to be re-measured after the toggle.
    if (event.target.closest(".card-details > summary")) {
      scheduleLinkContentMeasure();
    }
    return;
  }
  if (button.classList.contains("content-toggle")) {
    toggleLinkContent(button);
    return;
  }
  await copyWithFeedback(button, button.dataset.copyValue, button.dataset.copyKind);
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
    await copyWithFeedback(button, shortLink, "short");
    return;
  }

  if (action === "delete") {
    scheduleDelete(link);
  }

  if (action === "qrcode") {
    await openQrDialog(link);
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
  const previousFocus = document.activeElement;
  try {
    fallbackInput.select();
    if (!document.execCommand("copy")) throw new Error("Falha ao copiar link");
  } finally {
    const restoreFocus = document.activeElement === fallbackInput;
    fallbackInput.remove();
    if (restoreFocus) previousFocus?.focus({ preventScroll: true });
  }
}

const trashController = window.BoltLinkTrash ? window.BoltLinkTrash.mount({
  request,
  onRestore: async () => {
    await loadLinks(searchTermInput.value, searchGroupIdInput.value);
  },
}) : null;
if (!trashController) {
  document.getElementById("trash-open").disabled = true;
  document.getElementById("trash-status").textContent = "O módulo da Lixeira não foi carregado. Recarregue o painel.";
}

resetForm();
// Both narrow-viewport defaults follow the media query itself, so a rotation can never
// leave the form hidden with its toggle hidden, or open with the list pushed down.
setCreateFormCollapsed(createFormMedia.matches);
createFormMedia.addEventListener("change", (event) => {
  setCreateFormCollapsed(event.matches);
});
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
  if (event.defaultPrevented || state.groupDrawerOpen || state.importDrawerOpen || state.trashDrawerOpen || state.qrDialogOpen) return;
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

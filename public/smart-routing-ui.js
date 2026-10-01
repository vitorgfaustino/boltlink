/*
 * Copyright (c) 2026 Vitor Faustino
 * AGPL-3.0 License — https://github.com/vitorgfaustino/boltlink
 *
 * Shared Smart Routing presentation helpers for the admin UI.
 *
 * This module is intentionally framework-free and DOM-free so the same pure
 * rules used by the form can be unit tested without a browser. It never
 * builds HTML; callers are responsible for inserting strings with textContent.
 */
(function () {
  var MAX_RULES = 20;

  // Static ISO 3166-1 alpha-2 list. Kept local on purpose: no CDN, no package,
  // no external fetch. The backend remains the authoritative validator.
  var ISO_COUNTRIES = (
    "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ " +
    "BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
    "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ " +
    "DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR " +
    "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY " +
    "HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP " +
    "KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY " +
    "MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ " +
    "NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY " +
    "QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ " +
    "TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ " +
    "VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW"
  ).split(" ");

  var DEVICE_OPTIONS = [
    { value: "", label: "Qualquer dispositivo" },
    { value: "ios", label: "iOS" },
    { value: "android", label: "Android" },
    { value: "desktop", label: "Computador" },
    { value: "other", label: "Outro" },
  ];

  var ERROR_MESSAGES = {
    EMPTY_RULES: "Adicione pelo menos uma regra antes de salvar.",
    TOO_MANY_RULES: "O limite é de 20 regras por link.",
    UNKNOWN_KEY: "A regra contém um campo não suportado.",
    MISSING_MATCHER: "Cada regra precisa de país ou dispositivo. Se nenhuma regra corresponder, o link usa o destino principal.",
    INVALID_COUNTRY: "País inválido. Selecione um país da lista.",
    INVALID_DEVICE: "Dispositivo inválido. Selecione uma opção da lista.",
    INVALID_URL: "Informe uma URL de destino HTTP ou HTTPS válida.",
    URL_TOO_LONG: "O destino da regra excede o tamanho máximo permitido.",
    DUPLICATE_MATCHER: "Já existe uma regra com o mesmo país e dispositivo.",
    SHADOWED_RULE: "Uma regra anterior já cobre completamente esta regra.",
    RULES_TOO_LARGE: "O conjunto de regras excede o tamanho máximo permitido.",
  };

  function countryLabel(code, locale) {
    if (typeof code !== "string" || code.length !== 2) {
      return String(code || "");
    }
    try {
      if (typeof Intl !== "undefined" && typeof Intl.DisplayNames === "function") {
        var names = new Intl.DisplayNames([locale || "pt-BR"], { type: "region" });
        var label = names.of(code);
        if (label && label !== code) {
          return label;
        }
      }
    } catch (error) {
      // Fall through to the ISO code.
    }
    return code;
  }

  function countryOptions(locale) {
    var options = [];
    for (var index = 0; index < ISO_COUNTRIES.length; index += 1) {
      var code = ISO_COUNTRIES[index];
      options.push({ value: code, label: countryLabel(code, locale) });
    }
    var collator = null;
    if (typeof Intl !== "undefined" && Intl && typeof Intl.Collator === "function") {
      try {
        collator = new Intl.Collator(locale || "pt-BR", { usage: "sort", sensitivity: "base" });
      } catch (error) {
        collator = new Intl.Collator("pt-BR", { usage: "sort", sensitivity: "base" });
      }
    }
    options.sort(function (a, b) {
      var byLabel = collator ? collator.compare(a.label, b.label) : (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
      return byLabel || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0);
    });
    return [{ value: "", label: "Qualquer país" }].concat(options);
  }

  function deviceOptions() {
    return DEVICE_OPTIONS.map(function (option) {
      return { value: option.value, label: option.label };
    });
  }

  function hasMatcher(rule) {
    return Boolean(rule && (rule.country || rule.device));
  }

  /**
   * Basic, non-authoritative URL gate: absolute http/https only. The backend
   * still owns canonicalization, byte limits and full hostname policy. This
   * only prevents an obviously unsafe scheme (javascript:, data:, ftp:, ...)
   * or a relative/invalid value from leaving the browser as a rule target.
   */
  function isAbsoluteHttpUrl(value) {
    if (typeof value !== "string" || !value.trim()) {
      return false;
    }
    var parsed;
    try {
      parsed = new URL(value);
    } catch (error) {
      return false;
    }
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  }

  function validateRule(rule) {
    if (!rule || typeof rule !== "object") {
      return { ok: false, code: "UNKNOWN_KEY" };
    }
    if (!hasMatcher(rule)) {
      return { ok: false, code: "MISSING_MATCHER" };
    }
    if (!isAbsoluteHttpUrl(rule.url)) {
      return { ok: false, code: "INVALID_URL" };
    }
    return { ok: true };
  }

  function validateRules(rules) {
    if (!Array.isArray(rules) || rules.length === 0) {
      return { ok: false, code: "EMPTY_RULES" };
    }
    if (rules.length > MAX_RULES) {
      return { ok: false, code: "TOO_MANY_RULES" };
    }

    var seen = {};
    for (var index = 0; index < rules.length; index += 1) {
      var result = validateRule(rules[index]);
      if (!result.ok) {
        return result;
      }
      var key = (rules[index].country || "*") + "|" + (rules[index].device || "*");
      if (seen[key]) {
        return { ok: false, code: "DUPLICATE_MATCHER" };
      }
      seen[key] = true;
    }
    return { ok: true };
  }

  function toPayloadRule(rule) {
    var payload = { url: String(rule.url).trim() };
    if (rule.country) {
      payload.country = rule.country;
    }
    if (rule.device) {
      payload.device = rule.device;
    }
    return payload;
  }

  function toPayloadRules(rules) {
    return (Array.isArray(rules) ? rules : []).map(toPayloadRule);
  }

  function moveRule(rules, index, direction) {
    var list = Array.isArray(rules) ? rules.slice() : [];
    var target = direction === "up" ? index - 1 : index + 1;
    if (index < 0 || index >= list.length || target < 0 || target >= list.length) {
      return list;
    }
    var item = list.splice(index, 1)[0];
    list.splice(target, 0, item);
    return list;
  }

  function normalizeLoadedRules(raw) {
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.map(function (rule) {
      var country = rule && typeof rule.country === "string" ? rule.country : "";
      var device = rule && typeof rule.device === "string" ? rule.device : "";
      var url = rule && typeof rule.url === "string" ? rule.url : "";
      return { country: country, device: device, url: url };
    });
  }

  function isSmartRoutingEnabled(raw) {
    return Array.isArray(raw) && raw.length > 0;
  }

  /**
   * A corrupt persisted configuration is not the same as a disabled one. The API
   * reports it as `smartRoutingStatus === "invalid"` and deliberately never
   * sends the raw value, so the Admin can keep the distinction without ever
   * seeing (or echoing) the corrupted bytes.
   */
  function isSmartRoutingCorrupt(link) {
    return Boolean(link && link.smartRoutingStatus === "invalid");
  }

  var INVALID_STATE_NOTICE =
    'A configuração do Smart Routing está inválida e foi preservada. O link usa o destino principal. Salve regras válidas para corrigir ou use "Limpar configuração inválida" para descartá-la. Editar os demais campos não altera essa configuração.';

  /**
   * Fixed copy for the preserved-corrupt notice. It interpolates no persisted
   * content, so it is safe to assign through textContent.
   */
  function smartInvalidNotice(link) {
    return isSmartRoutingCorrupt(link) ? INVALID_STATE_NOTICE : "";
  }

  /**
   * Resolves the mutually exclusive A/B x Smart Routing state for the form.
   * `changed` is the control the operator just toggled; enabling it disables
   * the other mode locally so the final payload is a single atomic request.
   */
  function resolveModeTransition(values, changed) {
    var abEnabled = Boolean(values && values.abEnabled);
    var smartEnabled = Boolean(values && values.smartEnabled);
    var notice = "";

    if (abEnabled && smartEnabled) {
      if (changed === "smart") {
        abEnabled = false;
        notice = "Teste A/B foi desativado para evitar conflito com Smart Routing.";
      } else {
        smartEnabled = false;
        notice = "Smart Routing foi desativado para evitar conflito com o Teste A/B.";
      }
    }

    return { abEnabled: abEnabled, smartEnabled: smartEnabled, notice: notice };
  }

  function requiresTemporaryRedirect(values) {
    return Boolean(values && (values.abEnabled || values.smartEnabled));
  }

  function resolveRedirectType(currentType, temporaryRequired) {
    if (temporaryRequired) {
      return "302";
    }
    return currentType === "301" ? "301" : "302";
  }

  function extractErrorCode(message) {
    if (typeof message !== "string") {
      return null;
    }
    var codes = Object.keys(ERROR_MESSAGES);
    for (var index = 0; index < codes.length; index += 1) {
      if (message.indexOf(codes[index]) !== -1) {
        return codes[index];
      }
    }
    return null;
  }

  function smartErrorMessage(message) {
    var code = extractErrorCode(message);
    if (code) {
      return ERROR_MESSAGES[code];
    }
    return "Não foi possível salvar as regras. Revise os valores e tente novamente.";
  }

  /**
   * Safe, text-only card summary. Returns null when the capability is absent,
   * when no rule is configured, or when the persisted state is ambiguous.
   */
  function smartBadge(link, smartRouting) {
    if (!smartRouting || !link) {
      return null;
    }
    if (isSmartRoutingCorrupt(link)) {
      return { conflict: link.ab_enabled === 1, corrupt: true, label: "configuração inválida preservada" };
    }
    var rules = link.smartRoutingRules;
    if (!Array.isArray(rules) || rules.length === 0) {
      return null;
    }
    if (link.ab_enabled === 1) {
      return { conflict: true, label: "configuração ambígua" };
    }
    return { conflict: false, count: rules.length, label: rules.length + (rules.length === 1 ? " regra" : " regras") };
  }

  var RULE_VALIDATION_CODES = ["EMPTY_RULES", "TOO_MANY_RULES", "MISSING_MATCHER", "INVALID_URL", "DUPLICATE_MATCHER"];

  function isRuleValidationCode(code) {
    return RULE_VALIDATION_CODES.indexOf(code) !== -1;
  }

  function findFirstInvalidRuleIndex(rules) {
    if (!Array.isArray(rules)) {
      return -1;
    }
    for (var index = 0; index < rules.length; index += 1) {
      if (!validateRule(rules[index]).ok) {
        return index;
      }
    }
    return -1;
  }

  function firstInvalidField(rule) {
    if (!rule || (!rule.country && !rule.device)) {
      return "country";
    }
    if (typeof rule.url !== "string" || !rule.url.trim()) {
      return "url";
    }
    return "url";
  }

  /**
   * The expired-destination rules live in their own DOM-free module. The lookup
   * is explicit and fail-closed: a missing helper aborts the submission instead
   * of silently dropping the field, because dropping it would erase a persisted
   * destination the operator never touched.
   */
  function expiredRedirectHelper() {
    if (typeof window !== "undefined" && window.BoltLinkExpiredRedirect) {
      return window.BoltLinkExpiredRedirect;
    }
    return null;
  }

  /**
   * Single frontend authority for the final link request. Builds the exact
   * payload, applies the fail-closed guards (A/B x Smart exclusivity, 301 never
   * combined with a dynamic mode, basic rule validation) and returns the target
   * request. The real form submit uses this function; it must not compose a
   * parallel payload anywhere else.
   */
  function buildLinkSubmissionPayload(input) {
    var source = input || {};
    var capabilities = source.capabilities || {};
    var ab = source.ab || {};
    var smart = source.smart || {};
    var expired = source.expired || {};

    var abEnabled = Boolean(capabilities.abTesting && ab.enabled);
    var smartEnabled = Boolean(capabilities.smartRouting && smart.enabled);

    if (abEnabled && smartEnabled) {
      return { ok: false, code: "MODE_CONFLICT" };
    }

    var redirectType = source.redirectType === "301" ? "301" : "302";
    if (abEnabled || smartEnabled) {
      // A/B and Smart Routing always require a temporary redirect.
      redirectType = "302";
    }

    if (smartEnabled) {
      var validation = validateRules(smart.rules || []);
      if (!validation.ok) {
        return { ok: false, code: validation.code };
      }
    }

    var payload = {
      targetUrl: source.targetUrl,
      redirectType: redirectType,
      tags: source.tags,
      groupId: source.groupId,
      goLiveAt: source.goLiveAt,
      expiresAt: source.expiresAt,
      password: source.password,
    };

    var isEdit = source.mode === "edit";
    if (!isEdit) {
      payload.slug = source.slug;
    }

    // The field is mentioned only on a database that carries the 0006 column:
    // pre-0006 the API rejects any request that names it, so omitting it is what
    // keeps normal create and edit working there.
    if (capabilities.expiredRedirect) {
      var expiredUi = expiredRedirectHelper();
      if (!expiredUi) {
        return { ok: false, code: "EXPIRED_REDIRECT_UNAVAILABLE" };
      }

      // Resolved against the expiration already normalized for this payload, so
      // the destination and `expiresAt` can never disagree in one request.
      var expiredFields = expiredUi.resolveExpiredRedirectFields({
        mode: expired.mode,
        url: expired.url,
        expiresAt: payload.expiresAt,
      });
      if (!expiredFields.ok) {
        return { ok: false, code: expiredFields.code };
      }

      payload.expiredRedirectUrl = expiredFields.value;
    }

    if (capabilities.abTesting) {
      payload.abEnabled = abEnabled;
      payload.abTargetUrl = ab.targetUrl;
      payload.abWeightB = ab.weightB;
    }
    if (capabilities.smartRouting) {
      if (smartEnabled) {
        // Also the explicit repair path: saving valid rules replaces the
        // preserved corrupt value with a canonical one.
        payload.smartRoutingRules = toPayloadRules(smart.rules || []);
      } else if (smart.clearInvalid) {
        // The explicit clear action. It is the only path allowed to discard a
        // corrupt value.
        payload.smartRoutingRules = null;
      } else if (!smart.preserveInvalid) {
        payload.smartRoutingRules = null;
      }
      // `preserveInvalid` without `clearInvalid` omits the field entirely, so an
      // unrelated edit (tags, target, group) cannot erase the stored bytes and
      // change routing behavior behind the operator's back.
    }

    return {
      ok: true,
      payload: payload,
      path: isEdit ? "/api/links/" + encodeURIComponent(source.editingSlug) : "/api/links",
      method: isEdit ? "PATCH" : "POST",
    };
  }

  /**
   * Performs exactly one request for a valid submission, or zero requests when
   * the local guards reject the state. `options.fetchImpl` exists so the same
   * function used by the real submit can be exercised in tests.
   */
  /**
   * Routes a failed submission to a single feedback channel so assistive
   * technology never hears the same Smart Routing error twice. Smart-related
   * failures use `smartError` (assertive alert region); unrelated failures use
   * `formStatus` (polite status region). `focusRules` marks local rule errors.
   */
  function resolveSubmissionFeedback(result) {
    var outcome = { smartError: null, formStatus: null, focusRules: false };
    if (!result || result.ok) {
      return outcome;
    }

    if (result.code === "MODE_CONFLICT") {
      outcome.smartError = "Teste A/B e Smart Routing não podem ficar ativos juntos.";
      return outcome;
    }

    if (isRuleValidationCode(result.code)) {
      outcome.smartError = smartErrorMessage(result.code);
      outcome.focusRules = true;
      return outcome;
    }

    if (result.error && extractErrorCode(result.error)) {
      outcome.smartError = smartErrorMessage(result.error);
      return outcome;
    }

    outcome.formStatus = result.error || "Não foi possível salvar o link. Tente novamente.";
    return outcome;
  }

  async function submitLinkForm(input, options) {
    var built = buildLinkSubmissionPayload(input);
    if (!built.ok) {
      return { ok: false, code: built.code, requestCount: 0 };
    }

    var fetchImpl = (options && options.fetchImpl) || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
    if (!fetchImpl) {
      return { ok: false, code: "NO_FETCH", requestCount: 0 };
    }

    var response = await fetchImpl(built.path, {
      method: built.method,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(built.payload),
    });

    var responsePayload = null;
    try {
      responsePayload = await response.json();
    } catch (error) {
      responsePayload = null;
    }

    if (!response.ok) {
      return {
        ok: false,
        code: "HTTP_ERROR",
        status: response.status,
        error: responsePayload && responsePayload.error ? responsePayload.error : "Não foi possível salvar o link. Tente novamente.",
        requestCount: 1,
      };
    }

    return { ok: true, payload: responsePayload, method: built.method, requestCount: 1 };
  }

  var api = {
    MAX_RULES: MAX_RULES,
    ISO_COUNTRIES: ISO_COUNTRIES.slice(),
    countryLabel: countryLabel,
    countryOptions: countryOptions,
    deviceOptions: deviceOptions,
    validateRule: validateRule,
    validateRules: validateRules,
    toPayloadRule: toPayloadRule,
    toPayloadRules: toPayloadRules,
    moveRule: moveRule,
    normalizeLoadedRules: normalizeLoadedRules,
    isSmartRoutingEnabled: isSmartRoutingEnabled,
    isSmartRoutingCorrupt: isSmartRoutingCorrupt,
    smartInvalidNotice: smartInvalidNotice,
    isAbsoluteHttpUrl: isAbsoluteHttpUrl,
    resolveModeTransition: resolveModeTransition,
    requiresTemporaryRedirect: requiresTemporaryRedirect,
    resolveRedirectType: resolveRedirectType,
    extractErrorCode: extractErrorCode,
    smartErrorMessage: smartErrorMessage,
    smartBadge: smartBadge,
    isRuleValidationCode: isRuleValidationCode,
    findFirstInvalidRuleIndex: findFirstInvalidRuleIndex,
    firstInvalidField: firstInvalidField,
    buildLinkSubmissionPayload: buildLinkSubmissionPayload,
    submitLinkForm: submitLinkForm,
    resolveSubmissionFeedback: resolveSubmissionFeedback,
  };

  if (typeof window !== "undefined") {
    window.BoltLinkSmartRouting = api;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})();

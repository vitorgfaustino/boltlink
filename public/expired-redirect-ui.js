/*
 * Copyright (c) 2026 Vitor Faustino
 * AGPL-3.0 License — https://github.com/vitorgfaustino/boltlink
 *
 * Shared expired-destination helpers for the admin UI.
 *
 * This module is intentionally framework-free and DOM-free so the same pure
 * rules used by the form can be unit tested without a browser. It never builds
 * HTML; callers are responsible for assigning persisted content through
 * `textContent` or `value` only.
 */
(function () {
  /** The default response once a link is past `expires_at`: the 410 lifecycle. */
  var MODE_RESPONSE = "410";
  /** Administrative redirect selected for a link that already expired. */
  var MODE_REDIRECT = "redirect";

  var MISSING_DESTINATION_CODE = "MISSING_EXPIRED_DESTINATION";

  function isExpiredRedirectMode(value) {
    return value === MODE_RESPONSE || value === MODE_REDIRECT;
  }

  function hasValue(value) {
    return typeof value === "string" && value.trim() !== "";
  }

  /**
   * Resolves the expired-destination fields the form is allowed to send.
   *
   * The API rejects `expiredRedirectUrl` on a link without `expiresAt`, because
   * the destination would be dormant and unreachable. The form resolves that
   * invariant once, here, instead of trusting the browser or a hidden input:
   *
   *  - no expiration: the default 410 response and a `null` destination. Clearing
   *    "Expira em" therefore clears the destination atomically; a stale URL can
   *    never be sent alongside `expiresAt: null`.
   *  - expiration with the default response: `null`, the expiration is preserved.
   *  - expiration with a redirect: the destination, which becomes required.
   *
   * Only presence is checked. The backend remains the authority for the URL
   * policy and canonicalization, so no second, divergent copy of
   * `normalizeTargetUrl` lives in the browser.
   */
  function resolveExpiredRedirectFields(values) {
    var source = values || {};
    var expiration = hasValue(source.expiresAt) ? source.expiresAt : null;
    var mode = isExpiredRedirectMode(source.mode) ? source.mode : MODE_RESPONSE;
    var url = typeof source.url === "string" ? source.url.trim() : "";

    if (!expiration) {
      return { ok: true, mode: MODE_RESPONSE, url: "", value: null };
    }

    if (mode === MODE_REDIRECT) {
      if (!url) {
        return { ok: false, code: MISSING_DESTINATION_CODE, mode: MODE_REDIRECT, url: "" };
      }
      return { ok: true, mode: MODE_REDIRECT, url: url, value: url };
    }

    return { ok: true, mode: MODE_RESPONSE, url: "", value: null };
  }

  /**
   * Persisted selection of one link. The destination only exists on a database
   * that carries the 0006 column, so a link from an older database always loads
   * as the default, and a row without a destination is never confused with a row
   * that has one.
   */
  function expiredRedirectFromLink(link, capability) {
    if (!capability || !link) {
      return { mode: MODE_RESPONSE, url: "" };
    }

    var url = typeof link.expiredRedirectUrl === "string" ? link.expiredRedirectUrl : "";
    return url.trim() ? { mode: MODE_REDIRECT, url: url } : { mode: MODE_RESPONSE, url: "" };
  }

  /**
   * Whether the redirect option may be selected at all. It needs both the
   * migrated column and a filled expiration, so the form cannot offer a state the
   * API would refuse or store as dormant.
   */
  function canRedirectAfterExpiration(values) {
    var source = values || {};
    return Boolean(source.capability) && hasValue(source.expiresAt);
  }

  /**
   * Static copy for the only local failure of this feature. It interpolates no
   * persisted content, so it is safe to announce through a live region.
   */
  function expiredRedirectErrorMessage(code) {
    if (code === MISSING_DESTINATION_CODE) {
      return "Informe o destino após a expiração.";
    }
    return "Não foi possível salvar o destino após a expiração.";
  }

  var api = {
    MODE_RESPONSE: MODE_RESPONSE,
    MODE_REDIRECT: MODE_REDIRECT,
    MISSING_DESTINATION_CODE: MISSING_DESTINATION_CODE,
    isExpiredRedirectMode: isExpiredRedirectMode,
    resolveExpiredRedirectFields: resolveExpiredRedirectFields,
    expiredRedirectFromLink: expiredRedirectFromLink,
    canRedirectAfterExpiration: canRedirectAfterExpiration,
    expiredRedirectErrorMessage: expiredRedirectErrorMessage,
  };

  if (typeof window !== "undefined") {
    window.BoltLinkExpiredRedirect = api;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})();

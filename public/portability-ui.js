/*
 * Copyright (c) 2026 Vitor Faustino
 * AGPL-3.0 License — https://github.com/vitorgfaustino/boltlink
 *
 * Shared portability-export presentation helpers for the admin UI
 * (published in 3.0.0; origin Phase 5, Gate 5.2).
 *
 * Framework-free and DOM-free so the filename policy and the error mapping can be
 * unit tested in Node. It never builds HTML: callers write every value through
 * `textContent`, `value` or a `download` attribute, so no persisted string can reach
 * an HTML sink. It also never decides authorization — the API is the authority for
 * who may export; this module only shapes what the panel shows after it answered.
 */
(function () {
  var EXPORT_PATH = "/api/export";

  /** Used whenever the API filename is absent or does not match the safe shape. */
  var FALLBACK_FILENAME = "boltlink-export.json";

  /**
   * Conservative shape of a downloadable name. The API sends a constant, so anything
   * else — a path separator, a leading dot, a quote, a control character, an
   * over-long value — is treated as untrusted and replaced by the fallback instead of
   * being sanitized into something plausible.
   */
  var SAFE_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

  function safeFilename(candidate) {
    if (typeof candidate !== "string") {
      return FALLBACK_FILENAME;
    }
    if (!SAFE_FILENAME_PATTERN.test(candidate)) {
      return FALLBACK_FILENAME;
    }
    return candidate;
  }

  /**
   * Reads a download name from `Content-Disposition`, honouring the RFC 5987
   * `filename*` form first and the plain `filename` form next. A missing, malformed
   * or unsafe value yields the fallback, so the download never depends on a header
   * that could be shaped by persisted data.
   */
  function filenameFromDisposition(header) {
    if (typeof header !== "string" || !header) {
      return FALLBACK_FILENAME;
    }

    var extended = header.match(/filename\*\s*=\s*([^;]+)/i);
    if (extended) {
      var extendedValue = extended[1].trim().replace(/^"(.*)"$/, "$1");
      var separator = extendedValue.indexOf("''");
      var encoded = separator === -1 ? "" : extendedValue.slice(separator + 2);
      if (encoded) {
        try {
          return safeFilename(decodeURIComponent(encoded));
        } catch {
          return FALLBACK_FILENAME;
        }
      }
    }

    var plain = header.match(/filename\s*=\s*([^;]+)/i);
    if (!plain) {
      return FALLBACK_FILENAME;
    }

    return safeFilename(plain[1].trim().replace(/^"(.*)"$/, "$1"));
  }

  /**
   * Maps the export response onto a message the panel can show as-is, using the
   * status for the class of failure and the API message only to tell the specific
   * refusals apart. The API message itself is never echoed when it is unrecognized:
   * the raw text is a controlled English string, but showing a pt-BR equivalent keeps
   * the panel consistent with the rest of the Admin.
   */
  function exportErrorMessage(status, rawMessage) {
    var message = typeof rawMessage === "string" ? rawMessage : "";

    if (status === 401 || status === 403) {
      return "Sessão administrativa não reconhecida. Recarregue o painel e entre novamente.";
    }
    if (status === 429) {
      return "Muitas exportações em sequência. Aguarde alguns segundos e tente novamente.";
    }
    if (status === 503) {
      return "O banco ainda não foi preparado com as migrations. Execute as migrations e tente novamente.";
    }
    if (status === 404) {
      return "A rota de exportação não está disponível nesta instalação.";
    }

    if (status === 413) {
      if (/group limit/i.test(message)) {
        return "A exportação foi recusada: a instalação tem mais grupos do que o limite do formato. Use o backup do banco D1 para transportar esta configuração.";
      }
      if (/link limit/i.test(message)) {
        return "A exportação foi recusada: a instalação tem mais links do que o limite do formato. Use o backup do banco D1 para transportar esta configuração.";
      }
      return "A exportação foi recusada: o documento ultrapassa o limite de tamanho do formato. Use o backup do banco D1 para transportar esta configuração.";
    }

    if (status === 409) {
      return "A exportação foi recusada porque o estado persistido não é válido para o BoltLink atual. Corrija ou remova o registro inválido e tente novamente. Nada foi alterado no banco.";
    }

    return message || "Não foi possível exportar os dados.";
  }

  var api = {
    EXPORT_PATH: EXPORT_PATH,
    FALLBACK_FILENAME: FALLBACK_FILENAME,
    safeFilename: safeFilename,
    filenameFromDisposition: filenameFromDisposition,
    exportErrorMessage: exportErrorMessage,
  };

  if (typeof window !== "undefined") {
    window.BoltLinkPortability = api;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})();

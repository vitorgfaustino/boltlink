/*
 * Copyright (c) 2026 Vitor Faustino
 * AGPL-3.0 License — https://github.com/vitorgfaustino/boltlink
 *
 * Shared portability-import presentation helpers for the admin UI
 * (published in 3.0.0; origin Phase 5, Gate 5.3).
 *
 * Framework-free and DOM-free so the copy, the size policy and the state mapping can be
 * unit tested in Node. It never builds HTML: every value reaches the document through
 * `textContent` in `admin.js`, so no slug, group name or tag coming from a file can reach
 * an HTML sink. It never decides authorization or validity — the API is the authority for
 * both; this module only shapes what the panel shows after it answered, and the local
 * checks it does perform are a courtesy that saves a round trip, never a gate.
 */
(function () {
  var PREVIEW_PATH = "/api/import/preview";
  var APPLY_PATH = "/api/import/apply";

  /** The format's own ceiling, in bytes. The API enforces the same number. */
  var MAX_BYTES = 256 * 1024;

  /** Group and link limits of the format, shown as help before a file is chosen. */
  var MAX_GROUPS = 50;
  var MAX_LINKS = 100;

  var FORMAT = "boltlink-portability";
  var SCHEMA_VERSION = 1;

  var METRICS_WARNING = "Métricas não fazem parte desta exportação e começarão novamente.";

  /** Response states the panel has to tell apart. */
  var STATE_VALID = "valid";
  var STATE_BLOCKED = "blocked";
  var STATE_INVALID = "invalid";

  /**
   * The one sentence the apply route writes after a batch that failed for an unexpected
   * reason, copied from `src/index.ts`. It is part of the contract of that answer, so it is
   * compared as a whole: the field says which failure happened, and a `500` whose `error`
   * says anything else came from somewhere the panel cannot vouch for.
   */
  var APPLY_INTERNAL_ERROR_MESSAGE = "Import could not be completed";

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) {
      return "256 KiB";
    }
    if (bytes >= 1024 * 1024) {
      return (bytes / (1024 * 1024)).toFixed(1).replace(".0", "") + " MiB";
    }
    return Math.round(bytes / 1024) + " KiB";
  }

  /** Best-effort answer to "will the API refuse this for size?", decided on the file size. */
  function fileTooLarge(size) {
    return typeof size === "number" && Number.isFinite(size) && size > MAX_BYTES;
  }

  /**
   * Cheap check on the parsed file, so a wrong file is answered before a round trip: the
   * format identity, the supported revision and the two collections. Everything else —
   * every entry, every reference, every rule — is the server's decision, and this never
   * pretends otherwise.
   */
  function localDocumentProblem(parsed) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return "O arquivo não contém um documento do BoltLink.";
    }
    if (parsed.format !== FORMAT) {
      return "Este arquivo não foi gerado por \"Exportar configuração\".";
    }
    if (parsed.schemaVersion !== SCHEMA_VERSION) {
      return "A versão desta exportação não é suportada por esta instalação.";
    }
    if (!Array.isArray(parsed.groups) || !Array.isArray(parsed.links)) {
      return "O documento não tem a estrutura esperada.";
    }
    return null;
  }

  /**
   * Request body of both endpoints: one envelope shape, so the panel builds only one. The
   * password mapping is added only when it actually carries an entry, so a document without
   * protected links produces the minimal body — and a missing mapping is exactly what the
   * API answers with `PASSWORD_REQUIRED` when one was needed.
   *
   * The mapping is read with `Object.keys`, which only sees own enumerable properties: a
   * mapping built by {@link passwordMap} carries `__proto__` as one of them like any other
   * slug.
   */
  function envelopeFor(document, replacementPasswords) {
    var envelope = { document: document };
    if (replacementPasswords && Object.keys(replacementPasswords).length) {
      envelope.replacementPasswords = replacementPasswords;
    }
    return envelope;
  }

  /**
   * The replacement passwords, as a mapping without a prototype.
   *
   * `__proto__` is a valid slug under the current policy, and a plain `{}` cannot hold it:
   * `passwords["__proto__"] = "…"` assigns the object's prototype instead of creating a
   * property, so `Object.keys` never sees it and `JSON.stringify` drops it — the operator
   * would type a password, watch the control enable, and the apply would be refused for a
   * password that was never sent. Building the mapping on `null` makes every slug an own
   * data property, which is also what makes `constructor`, `prototype` and `toString`
   * behave like any other name instead of reaching an inherited value.
   *
   * Blank values are not passwords and are left out, exactly like an empty field.
   */
  function passwordMap(entries) {
    var passwords = Object.create(null);
    if (!Array.isArray(entries)) {
      return passwords;
    }

    for (var index = 0; index < entries.length; index += 1) {
      var entry = entries[index];
      if (!entry || typeof entry.slug !== "string") {
        continue;
      }
      var value = typeof entry.value === "string" ? entry.value.trim() : "";
      if (!value) {
        continue;
      }
      passwords[entry.slug] = value;
    }

    return passwords;
  }

  /**
   * Empties the replacement-password fields and reports how many it emptied.
   *
   * Called after every terminal outcome of an apply, and by the reset that a new file, a
   * close and the reset button all go through: a password typed for a review that no longer
   * authorizes anything is not reusable, so the operator types it again for the next
   * attempt. Anything that is not a list of fields is ignored rather than trusted.
   */
  function clearPasswordInputs(inputs) {
    if (!inputs || typeof inputs.length !== "number") {
      return 0;
    }

    var cleared = 0;
    for (var index = 0; index < inputs.length; index += 1) {
      var input = inputs[index];
      if (input && typeof input === "object") {
        input.value = "";
        cleared += 1;
      }
    }
    return cleared;
  }

  /**
   * What a failed apply means for the panel.
   *
   * Two things are true of every terminal outcome and are decided here rather than at each
   * call site: the passwords of that attempt are discarded (nothing typed for it is
   * reusable, and the apply that follows starts from a new preview), and no second attempt
   * is allowed until then. The one difference is the request that never produced an answer:
   * `stateUnknown` is set so the panel says the final state is unknown instead of claiming
   * the destination is untouched, which is a claim only a response can support.
   */
  function applyFailureDisposition(kind) {
    return {
      discardPasswords: true,
      allowAnotherApply: false,
      stateUnknown: kind === "network",
    };
  }

  /** The three things an apply answer can be. Only the first two carry a verdict. */
  var VERDICT_SUCCESS = "success";
  var VERDICT_REFUSED = "refused";
  var VERDICT_UNKNOWN = "unknown";

  /**
   * Whether a `code` is one of the codes the API documents — a document refusal code or a
   * blocker code — taking the vocabulary from the two message tables this module already
   * carries. A code the panel cannot explain is not a recognized envelope: it is a JSON
   * object that happens to have a `code` field.
   */
  function isKnownImportCode(code) {
    return (
      typeof code === "string" &&
      (Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, code) || Object.prototype.hasOwnProperty.call(BLOCKER_MESSAGES, code))
    );
  }

  /**
   * The success envelope of `POST /api/import/apply`, exactly as the route writes it:
   * `{ ok: true, groupsCreated, linksCreated }` with both counts as non-negative integers.
   * `{ "ok": true }` on its own is not the contract, so it is not accepted as one.
   */
  function isApplySuccessEnvelope(payload) {
    return (
      payload.ok === true &&
      Number.isInteger(payload.groupsCreated) &&
      payload.groupsCreated >= 0 &&
      Number.isInteger(payload.linksCreated) &&
      payload.linksCreated >= 0
    );
  }

  /**
   * A refusal envelope: the `ok: false` answers of the two routes, which are the document
   * refusals (`error`, `code`, `errors`) and the blocked ones (`error`, `code`, `blockers`,
   * plus the summary and the conflict lists).
   *
   * The discriminating fields are required, not merely checked for presence: `ok` has to be
   * exactly `false`, `error` has to be a non-empty string, `code` has to be a code this panel
   * can explain, and the answer has to carry the issue list of the shape it claims (`errors`
   * for a refusal, `blockers` for a blocked import). A JSON object that merely has an `ok`
   * field is not a refusal — and it is not allowed to become one, because "nothing was
   * applied" is a claim only a recognized answer supports.
   */
  function isApplyRefusalEnvelope(payload) {
    return (
      payload.ok === false &&
      typeof payload.error === "string" &&
      payload.error.length > 0 &&
      isKnownImportCode(payload.code) &&
      (Array.isArray(payload.errors) || Array.isArray(payload.blockers))
    );
  }

  /**
   * The controlled internal error. The apply route answers `500` with a single `error` string
   * after the batch failed, and since the batch is one transaction that answer really does
   * mean nothing was applied — so it stays a known outcome.
   *
   * It is recognized only in that exact shape, on the one status that produces it, and with
   * the one sentence the route writes: a lone free-text field is too weak to be a contract
   * discriminator, so a `500` whose `error` says anything else is not this envelope — it is a
   * body the route never produces, and treating it as a known failure would let the panel
   * claim "nothing was applied" on a message nobody wrote. The message is compared exactly,
   * with no trimming or case folding: the contract is the byte-for-byte sentence.
   */
  function isApplyInternalErrorEnvelope(status, payload) {
    return (
      status === 500 &&
      payload.ok === undefined &&
      payload.error === APPLY_INTERNAL_ERROR_MESSAGE &&
      Object.keys(payload).length === 1
    );
  }

  /**
   * The verdict of an apply answer, from the two facts the transport gave: the status and
   * the *raw* body.
   *
   * Parsing lives here, and a body only counts when it *is* one of the route's answers. Two
   * things are deliberately not enough:
   *
   * - the status, on its own. A `200` whose body was truncated or corrupted may be an import
   *   that already committed, and a `500` whose body nobody can read says nothing about what
   *   the server did; both are `unknown`, handled exactly like a request that never answered.
   * - JSON that parses but is not the contract. `{}` is an object, not an answer, and neither
   *   is `{"ok": true}` without the counts or `{"ok": false}` without the envelope: accepting
   *   them would let the panel announce "nothing was applied" — a rollback claim — on the
   *   strength of a body the route never produces.
   *
   * Everything else is `unknown`, so the panel only ever claims an outcome it can prove: the
   * success envelope, a recognized refusal/blocked envelope, or the controlled internal error.
   */
  function readApplyResponse(status, bodyText) {
    var payload = null;
    if (typeof bodyText === "string" && bodyText.length > 0) {
      try {
        payload = JSON.parse(bodyText);
      } catch {
        payload = null;
      }
    }

    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      return { verdict: VERDICT_UNKNOWN, status: status, payload: null };
    }
    if (isApplySuccessEnvelope(payload)) {
      return { verdict: VERDICT_SUCCESS, status: status, payload: payload };
    }
    if (isApplyRefusalEnvelope(payload) || isApplyInternalErrorEnvelope(status, payload)) {
      return { verdict: VERDICT_REFUSED, status: status, payload: payload };
    }

    return { verdict: VERDICT_UNKNOWN, status: status, payload: null };
  }

  /**
   * The ending of an outcome nobody can confirm: a request that never answered, or an answer
   * nobody can read. Nothing is claimed about the destination — it may hold the whole
   * document or none of it — so the plan discards the passwords, refuses a second attempt
   * under the same review and asks the operator to reload and review. The transport's own
   * words, when there are any, are kept as context for the retry and never as a claim.
   */
  function unknownOutcomePlan(detail) {
    var disposition = applyFailureDisposition("network");
    var prefix = typeof detail === "string" && detail.trim() ? detail.trim() : "Não foi possível importar a configuração.";

    return {
      discardPasswords: disposition.discardPasswords,
      allowAnotherApply: disposition.allowAnotherApply,
      stateUnknown: disposition.stateUnknown,
      message: prefix + " O estado final é desconhecido: recarregue a lista de links e revise antes de tentar novamente.",
    };
  }

  /** Which of the three answers the API gave, from its own body. */
  function responseState(payload) {
    if (payload && payload.ok === true) {
      return STATE_VALID;
    }
    if (payload && Array.isArray(payload.blockers)) {
      return STATE_BLOCKED;
    }
    return STATE_INVALID;
  }

  /**
   * The identity of the document the drawer is reviewing.
   *
   * Two previews can be in flight at once — the operator picks a file, then picks another
   * before the first answer arrives — and a response is only ever an answer about the
   * document it was asked about. Without that identity the slower answer wins the panel:
   * the summary, the conflicts and the password fields would describe file A while the
   * apply sends file B, and the operator would commit a configuration they never reviewed
   * (the API revalidates B, so nothing unsafe is written — it is the review that is
   * bypassed, not the validation).
   *
   * Every operation that replaces the document — a new file, the reset button, closing the
   * drawer, opening it again — calls `invalidate()`, which bumps the generation and drops
   * the approved preview with it. A request carries the generation it started under, and an
   * answer may only touch the panel while that generation is still the current one:
   *
   *   var generation = selection.generation;      // taken before the request
   *   if (!selection.isCurrent(generation)) return;   // a stale answer is dropped
   *   selection.markPreview(generation);          // an approved plan for *this* selection
   *   selection.canApply();                       // false for any other selection
   *
   * Cancelling the superseded request is a courtesy that saves a round trip; the generation
   * check is the authority, because a cancellation can always arrive after the response.
   * The generation starts at 1 so that no ticket a caller might default to — `0`,
   * `undefined`, a stringified number — can ever be the current one.
   */
  function createImportSelection() {
    var generation = 1;
    var previewGeneration = null;

    return {
      get generation() {
        return generation;
      },
      get previewGeneration() {
        return previewGeneration;
      },
      /** Replaces the document: the previous answers, review and approval stop applying. */
      invalidate: function () {
        generation += 1;
        previewGeneration = null;
        return generation;
      },
      /** True only while the ticket still describes the document being reviewed. */
      isCurrent: function (ticket) {
        return ticket === generation;
      },
      /** Records an approved preview for the ticket, and only while it is current. */
      markPreview: function (ticket) {
        if (ticket !== generation) {
          return false;
        }
        previewGeneration = ticket;
        return true;
      },
      /**
       * Withdraws the approval without touching the selection: the document on screen is
       * still the current one, but the plan that was approved for it stopped authorizing an
       * apply. Used when an attempt reaches a terminal outcome — refused, failed in
       * transport or succeeded — so the way back is always a new preview.
       */
      revokePreview: function () {
        previewGeneration = null;
      },
      /** True only with an approved preview for the document the drawer is showing now. */
      canApply: function () {
        return previewGeneration !== null && previewGeneration === generation;
      },
    };
  }

  function slugList(entries) {
    if (!Array.isArray(entries)) {
      return [];
    }
    return entries
      .map(function (entry) {
        return entry && typeof entry.slug === "string" ? entry.slug : null;
      })
      .filter(function (slug) {
        return Boolean(slug);
      });
  }

  /** Protected links the file needs a new password for, in the order the API reported them. */
  function requiresPasswordSlugs(payload) {
    return slugList(payload && payload.requiresPasswords);
  }

  function conflictSlugs(payload) {
    return slugList(payload && payload.conflicts);
  }

  /** Summary lines in a fixed order, so the panel never reshuffles between two previews. */
  function summaryLines(summary) {
    var source = summary && typeof summary === "object" ? summary : {};
    function value(key) {
      var raw = source[key];
      return typeof raw === "number" && Number.isFinite(raw) ? String(raw) : "0";
    }
    return [
      { label: "Grupos", value: value("groups") },
      { label: "Links", value: value("links") },
      { label: "Links desativados", value: value("disabledLinks") },
      { label: "Links protegidos", value: value("protectedLinks") },
      { label: "Testes A/B", value: value("abTests") },
      { label: "Smart Routing", value: value("smartRouting") },
    ];
  }

  /** What the import would create, stated before the operator commits to it. */
  function planText(summary) {
    var source = summary && typeof summary === "object" ? summary : {};
    var groups = typeof source.groups === "number" ? source.groups : 0;
    var links = typeof source.links === "number" ? source.links : 0;
    return "Serão criados " + groups + " grupo(s) e " + links + " link(s).";
  }

  function successText(result) {
    var groups = result && typeof result.groupsCreated === "number" ? result.groupsCreated : 0;
    var links = result && typeof result.linksCreated === "number" ? result.linksCreated : 0;
    return "Configuração importada com sucesso: " + groups + " grupo(s) e " + links + " link(s).";
  }

  /** Warnings travel as codes and are rendered from here, so no API text reaches the panel. */
  function warningMessages(payload) {
    var codes = payload && Array.isArray(payload.warnings) ? payload.warnings : [];
    return codes
      .map(function (code) {
        if (code === "METRICS_NOT_EXPORTED") {
          return METRICS_WARNING;
        }
        return null;
      })
      .filter(function (message) {
        return Boolean(message);
      });
  }

  /**
   * Document problems, one message per code. The categories match the ones the API
   * reports, so the operator learns whether the file is malformed, whether a specific
   * field is wrong, or whether the file simply came from somewhere else.
   */
  var ERROR_MESSAGES = {
    INVALID_BODY: "A requisição não foi aceita como um documento de importação.",
    INVALID_DOCUMENT: "O documento não tem a estrutura esperada.",
    UNKNOWN_FIELD: "O documento tem um campo que este formato não define.",
    UNSUPPORTED_FORMAT: "Este arquivo não é uma exportação do BoltLink.",
    UNSUPPORTED_SCHEMA_VERSION: "A versão desta exportação não é suportada por esta instalação.",
    TOO_MANY_GROUPS: "A exportação tem mais de " + MAX_GROUPS + " grupos, o limite do formato.",
    TOO_MANY_LINKS: "A exportação tem mais de " + MAX_LINKS + " links, o limite do formato.",
    TOO_LARGE: "O documento ultrapassa o limite de " + formatBytes(MAX_BYTES) + " do formato.",
    INVALID_GROUP_ENTRY: "Um grupo não tem os campos esperados.",
    INVALID_GROUP_NAME: "Um nome de grupo não é válido nesta instalação.",
    INVALID_GROUP_REF: "Uma referência de grupo não é válida.",
    DUPLICATE_GROUP_REF: "A mesma referência de grupo aparece mais de uma vez.",
    DANGLING_PARENT_REF: "Um grupo aponta para um grupo pai que não existe no arquivo.",
    GROUP_CYCLE: "A hierarquia de grupos do arquivo forma um ciclo.",
    INVALID_LINK_ENTRY: "Um link não tem os campos esperados.",
    DUPLICATE_LINK_SLUG: "O mesmo slug aparece mais de uma vez no arquivo.",
    INVALID_SLUG: "Um slug não é válido nesta instalação.",
    INVALID_TARGET_URL: "Uma URL de destino não é válida.",
    INVALID_REDIRECT_TYPE: "Um tipo de redirecionamento não é válido.",
    INVALID_TAGS: "As tags de um link não estão no formato esperado.",
    DANGLING_GROUP_REF: "Um link aponta para um grupo que não existe no arquivo.",
    INVALID_LIFECYCLE: "Uma data de agendamento ou expiração não é válida.",
    INVALID_EXPIRED_REDIRECT: "Um destino de expiração não é válido para o link.",
    INVALID_AB_CONFIG: "Uma configuração de Teste A/B não é válida.",
    INVALID_SMART_ROUTING: "Uma configuração de Smart Routing não é válida.",
    CONFLICTING_ROUTING_CONFIG: "Um link tem Teste A/B e Smart Routing ativos ao mesmo tempo.",
    INVALID_PASSWORD: "As novas senhas enviadas não estão no formato esperado.",
    PASSWORD_REQUIRED: "Informe uma nova senha para cada link protegido.",
  };

  function errorMessage(code) {
    if (typeof code === "string" && Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, code)) {
      return ERROR_MESSAGES[code];
    }
    return "O documento não pôde ser validado.";
  }

  /** The document is valid but this destination cannot take it as it is. */
  var BLOCKER_MESSAGES = {
    SLUG_COLLISION: "Não é possível importar porque alguns slugs já existem nesta instalação.",
    GROUP_DEPTH_EXCEEDED: "Esta exportação tem uma árvore de grupos mais profunda do que o limite atual do BoltLink (16 níveis). Ela pode ter vindo de uma instalação mais antiga; nada foi importado.",
    TARGET_CAPABILITY_MISSING: "Esta instalação ainda não tem as migrations necessárias para as funcionalidades usadas nesta exportação. Atualize as migrations e tente novamente.",
    DESTINATION_HIERARCHY_CORRUPT: "A hierarquia de grupos desta instalação está corrompida. O BoltLink não importa sobre uma árvore que não consegue ler.",
    TARGET_GROUP_REFERENCE_CORRUPT: "Esta instalação tem links apontando para grupos que não existem mais. O BoltLink não importa sobre uma árvore que não consegue resolver; corrija os links órfãos e tente novamente.",
    PASSWORD_SESSION_SECRET_MISSING: "Esta instalação não tem PASSWORD_SESSION_SECRET configurado, então não é possível recriar links protegidos.",
  };

  function blockerMessages(payload) {
    var codes = payload && Array.isArray(payload.blockers) ? payload.blockers : [];
    return codes
      .map(function (code) {
        return blockerMessage(code) || "O documento não pode ser importado nesta instalação.";
      })
      .filter(function (message, index, all) {
        return all.indexOf(message) === index;
      });
  }

  /** One blocker code as copy, or `null` when the code is not a blocker. */
  function blockerMessage(code) {
    if (typeof code === "string" && Object.prototype.hasOwnProperty.call(BLOCKER_MESSAGES, code)) {
      return BLOCKER_MESSAGES[code];
    }
    return null;
  }

  /** Boundary and infrastructure statuses, told apart before the code is looked at. */
  function boundaryMessage(status) {
    if (status === 401 || status === 403) {
      return "Sessão administrativa não reconhecida. Recarregue o painel e entre novamente.";
    }
    if (status === 429) {
      return "Muitas operações em sequência. Aguarde alguns segundos e tente novamente.";
    }
    if (status === 503) {
      return "O banco ainda não foi preparado com as migrations. Execute as migrations e tente novamente.";
    }
    if (status === 404) {
      return "A rota de importação não está disponível nesta instalação.";
    }
    return null;
  }

  function previewErrorMessage(status, code) {
    var boundary = boundaryMessage(status);
    if (boundary) {
      return boundary;
    }
    if (status === 413) {
      return errorMessage(code);
    }
    if (status === 409) {
      // A blocked document carries a blocker code, and the panel shows the reason the
      // operator has to act on rather than "the document is invalid".
      return blockerMessage(code) || errorMessage(code);
    }
    if (status === 400) {
      return errorMessage(code);
    }
    return "Não foi possível validar o arquivo.";
  }

  /**
   * Apply failures. The invariant that makes the message honest is the design's, not the
   * panel's: the whole document is written as a single transaction, so every refusal means
   * the destination still holds exactly what it held before. A `409` can be a blocker (a
   * slug taken since the preview) or the import's own requirement (a password that was not
   * supplied), so both vocabularies are consulted.
   */
  function applyErrorMessage(status, code) {
    var boundary = boundaryMessage(status);
    if (boundary) {
      return boundary;
    }
    if (status === 400) {
      return errorMessage(code);
    }
    if (status === 409) {
      return blockerMessage(code) || errorMessage(code);
    }
    if (status === 413) {
      return errorMessage(code);
    }
    return "Não foi possível importar a configuração. Nenhuma alteração foi aplicada.";
  }

  var api = {
    PREVIEW_PATH: PREVIEW_PATH,
    APPLY_PATH: APPLY_PATH,
    MAX_BYTES: MAX_BYTES,
    MAX_GROUPS: MAX_GROUPS,
    MAX_LINKS: MAX_LINKS,
    FORMAT: FORMAT,
    SCHEMA_VERSION: SCHEMA_VERSION,
    STATE_VALID: STATE_VALID,
    STATE_BLOCKED: STATE_BLOCKED,
    STATE_INVALID: STATE_INVALID,
    VERDICT_SUCCESS: VERDICT_SUCCESS,
    VERDICT_REFUSED: VERDICT_REFUSED,
    VERDICT_UNKNOWN: VERDICT_UNKNOWN,
    formatBytes: formatBytes,
    fileTooLarge: fileTooLarge,
    localDocumentProblem: localDocumentProblem,
    envelopeFor: envelopeFor,
    passwordMap: passwordMap,
    clearPasswordInputs: clearPasswordInputs,
    applyFailureDisposition: applyFailureDisposition,
    readApplyResponse: readApplyResponse,
    unknownOutcomePlan: unknownOutcomePlan,
    responseState: responseState,
    createImportSelection: createImportSelection,
    requiresPasswordSlugs: requiresPasswordSlugs,
    conflictSlugs: conflictSlugs,
    summaryLines: summaryLines,
    planText: planText,
    successText: successText,
    warningMessages: warningMessages,
    errorMessage: errorMessage,
    blockerMessages: blockerMessages,
    previewErrorMessage: previewErrorMessage,
    applyErrorMessage: applyErrorMessage,
  };

  if (typeof window !== "undefined") {
    window.BoltLinkPortabilityImport = api;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})();

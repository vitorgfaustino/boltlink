/* Copyright (c) 2026 Vitor Faustino — AGPL-3.0 */
(function () {
  const KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];

  function parseUtmFromUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      return Object.fromEntries(KEYS.map((key) => [key, url.searchParams.get(key) || ""]));
    } catch {
      return null;
    }
  }

  // Edit only supported query tokens: reserializing URL.searchParams would also
  // re-encode unrelated parameters (for example %20 as +, and ~ as %7E).
  function applyUtmToUrl(value, fields) {
    if (!parseUtmFromUrl(value)) return null;
    const hashIndex = value.indexOf("#");
    const hash = hashIndex < 0 ? "" : value.slice(hashIndex);
    const head = hashIndex < 0 ? value : value.slice(0, hashIndex);
    const queryIndex = head.indexOf("?");
    const path = queryIndex < 0 ? head : head.slice(0, queryIndex);
    let tokens = queryIndex < 0 ? [] : head.slice(queryIndex + 1).split("&");
    let changed = false;
    for (const key of KEYS) {
      if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
      const wanted = String(fields[key] || "");
      const matches = tokens.map((token, index) => ({ index, params: new URLSearchParams(token) }))
        .filter((entry) => entry.params.has(key));
      if (wanted && matches.length === 1 && matches[0].params.get(key) === wanted) continue;
      if (!wanted && !matches.length) continue;
      const indices = new Set(matches.map((entry) => entry.index));
      const replacement = new URLSearchParams([[key, wanted]]).toString();
      tokens = tokens.flatMap((token, index) => indices.has(index)
        ? (wanted && index === matches[0].index ? [replacement] : []) : [token]);
      if (wanted && !matches.length) tokens.push(replacement);
      changed = true;
    }
    if (!changed) return value;
    const query = tokens.join("&");
    return path + (query ? "?" + query : "") + hash;
  }

  // URLSearchParams.get() defines the effective value: the first occurrence.
  // Only repeated supported UTMs are rewritten at save. All other bytes survive.
  function normalizeUtmDuplicates(value) {
    const fields = parseUtmFromUrl(value);
    if (!fields) return null;
    const params = new URL(value).searchParams;
    const repeated = Object.fromEntries(KEYS.filter((key) => params.getAll(key).length > 1)
      .map((key) => [key, fields[key]]));
    return applyUtmToUrl(value, repeated);
  }

  const api = { KEYS, parseUtmFromUrl, applyUtmToUrl, normalizeUtmDuplicates };
  if (typeof window !== "undefined") window.BoltLinkUtm = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

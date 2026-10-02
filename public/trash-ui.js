/* Copyright (c) 2026 Vitor Faustino — AGPL-3.0 */
(function () {
  function mount(options) {
    var root = document.getElementById("trash-panel");
    if (!root) return null;
    var list = document.getElementById("trash-list");
    var status = document.getElementById("trash-status");
    var count = document.getElementById("trash-count");
    var eligible = document.getElementById("trash-eligible");
    var search = document.getElementById("trash-search");
    var preview = document.getElementById("trash-purge-preview");
    var previewCopy = document.getElementById("trash-purge-copy");
    var previous = document.getElementById("trash-previous");
    var next = document.getElementById("trash-next");
    var pageLabel = document.getElementById("trash-page");
    var purge = document.getElementById("trash-purge-open");
    var confirmPurge = document.getElementById("trash-purge-confirm");
    var page = 1;
    var generation = 0;
    var busy = false;
    var isOpen = false;
    var hasMore = false;
    var purgePreview = null;
    var previewGeneration = 0;
    var rows = [];

    function announce(message, error) {
      status.textContent = message;
      status.className = error ? "status error" : "status";
    }
    function invalidatePreview() {
      previewGeneration++;
      purgePreview = null;
      preview.hidden = true;
    }
    function controls() {
      root.querySelectorAll("button, input").forEach(function (node) { node.disabled = busy; });
      previous.disabled = busy || page === 1;
      next.disabled = busy || !hasMore;
      confirmPurge.disabled = busy || !purgePreview || purgePreview.eligible === 0;
      root.setAttribute("aria-busy", String(busy));
    }
    function text(tag, value, className) {
      var node = document.createElement(tag);
      node.textContent = value;
      if (className) node.className = className;
      return node;
    }
    function render() {
      list.replaceChildren();
      if (!rows.length) {
        list.appendChild(text("p", search.value.trim()
          ? "Nenhum item na Lixeira corresponde à busca."
          : "A Lixeira está vazia. Links excluídos aparecerão aqui para restauração ou exclusão definitiva."));
      }
      rows.forEach(function (row) {
        var item = document.createElement("article");
        item.className = "trash-item";
        item.appendChild(text("h3", "/" + row.slug));
        item.appendChild(text("p", row.target_url, "trash-destination"));
        item.appendChild(text("p", "Excluído em: " + row.disabled_at + (row.group_name ? " · Grupo: " + row.group_name : ""), "field-help"));
        var actions = document.createElement("div");
        actions.className = "panel-action-row";
        [["restore", "Restaurar", "secondary"], ["delete", "Excluir definitivamente", "danger"]].forEach(function (action) {
          var button = text("button", action[1]);
          button.type = "button";
          button.className = action[2] + " compact";
          button.setAttribute("aria-label", action[1] + " /" + row.slug);
          button.addEventListener("click", function () { mutate(row.slug, action[0]); });
          actions.appendChild(button);
        });
        item.appendChild(actions);
        list.appendChild(item);
      });
      pageLabel.textContent = "Página " + page;
      controls();
    }
    async function refreshCount() {
      var summary = await options.request("/api/trash/purge-preview");
      count.textContent = "Links excluídos: " + summary.total;
      eligible.textContent = "Itens com pelo menos " + summary.retentionDays + " dias: " + summary.eligible;
      return summary;
    }
    async function load() {
      var token = ++generation;
      invalidatePreview();
      busy = true;
      controls();
      announce("Carregando Lixeira...");
      try {
        var result = await options.request("/api/trash?search=" + encodeURIComponent(search.value.trim()) + "&page=" + page);
        if (token !== generation) return;
        rows = result.links;
        hasMore = result.hasMore;
        render();
        await refreshCount();
        if (token === generation) announce(result.total + " itens encontrados.");
      } catch (error) {
        if (token === generation) announce(error.message || "Não foi possível carregar a Lixeira.", true);
      } finally {
        if (token === generation) { busy = false; controls(); }
      }
    }
    async function mutate(slug, action) {
      if (busy) return;
      if (action === "delete" && !window.confirm("Excluir definitivamente /" + slug + "?\nEssa ação não pode ser desfeita e o slug ficará disponível para reutilização.")) return;
      busy = true;
      invalidatePreview();
      controls();
      try {
        await options.request("/api/trash/" + encodeURIComponent(slug) + (action === "restore" ? "/restore" : ""),
          { method: action === "restore" ? "POST" : "DELETE" });
        await options.onChange();
        await load();
        announce(action === "restore" ? "/" + slug + " restaurado. A configuração e as métricas foram preservadas."
          : "/" + slug + " excluído definitivamente. O slug está disponível para reutilização.");
      } catch (error) {
        announce(error.message || "Não foi possível concluir a operação.", true);
      } finally { busy = false; controls(); }
    }
    async function previewPurge() {
      if (busy) return;
      busy = true;
      invalidatePreview();
      controls();
      var token = previewGeneration;
      try {
        var result = await refreshCount();
        if (!isOpen || token !== previewGeneration) return;
        purgePreview = result;
        previewCopy.textContent = (purgePreview.eligible === 1
          ? "1 link será excluído definitivamente e seu slug voltará a ficar disponível. "
          : purgePreview.eligible + " links serão excluídos definitivamente e seus slugs voltarão a ficar disponíveis. ")
          + "Excluídos até " + purgePreview.cutoff + ". A elegibilidade será recalculada ao confirmar. Esta ação não pode ser desfeita.";
        preview.hidden = false;
        announce("Preview pronto. Revise a quantidade antes de confirmar.");
      } catch (error) { announce(error.message || "Não foi possível preparar o preview.", true); }
      finally { busy = false; controls(); }
    }
    async function applyPurge() {
      if (busy || !purgePreview || !purgePreview.eligible) return;
      busy = true;
      controls();
      try {
        var result = await options.request("/api/trash/purge", { method: "POST" });
        invalidatePreview();
        page = 1;
        await options.onChange();
        await load();
        announce(result.removed === 1 ? "1 link excluído definitivamente. O slug foi liberado." : result.removed + " links excluídos definitivamente. Os slugs foram liberados.");
      } catch (error) {
        invalidatePreview();
        announce((error.message || "Não foi possível confirmar a limpeza.") + " Atualize a Lixeira antes de tentar novamente.", true);
      } finally { busy = false; controls(); }
    }
    document.getElementById("trash-search-form").addEventListener("submit", function (event) { event.preventDefault(); if (!busy) { page = 1; load(); } });
    previous.addEventListener("click", function () { if (!busy && page > 1) { page--; load(); } });
    next.addEventListener("click", function () { if (!busy && hasMore) { page++; load(); } });
    purge.addEventListener("click", previewPurge);
    confirmPurge.addEventListener("click", applyPurge);
    document.getElementById("trash-purge-cancel").addEventListener("click", function () { invalidatePreview(); controls(); purge.focus(); });
    refreshCount().catch(function () { count.textContent = "Links excluídos: indisponível"; });
    controls();
    return {
      open: function () { isOpen = true; if (!busy) return load(); },
      close: function () { isOpen = false; invalidatePreview(); controls(); },
      refresh: function () { invalidatePreview(); return isOpen ? load() : refreshCount(); }
    };
  }
  var api = { mount: mount };
  if (typeof window !== "undefined") window.BoltLinkTrash = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

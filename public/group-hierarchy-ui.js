/*
 * Copyright (c) 2026 Vitor Faustino
 * AGPL-3.0 License — https://github.com/vitorgfaustino/boltlink
 *
 * Shared group-hierarchy presentation helpers for the admin UI
 * (published in 3.0.0; origin Phase 5, Gate 5.1).
 *
 * This module is intentionally framework-free and DOM-free so the same tree rules
 * used by the panel can be unit tested without a browser. It never builds HTML;
 * callers are responsible for inserting persisted content through `textContent`
 * or `value` only.
 *
 * It also never decides authorization. The API is the authority for cycles, the
 * depth ceiling and the observed-parent precondition: every function here only
 * shapes what the panel shows, and `buildTree` refuses a graph it cannot lay out
 * so a rendering pass can never loop.
 */
(function () {
  /** Mirrors the API ceiling: a root group is depth 1. */
  var MAX_DEPTH = 16;

  var PATH_SEPARATOR = " / ";

  var ERROR_MESSAGES = {
    CORRUPT: "A hierarquia de grupos está inconsistente. Nenhuma alteração foi feita.",
    PARENT_CHANGED: "O grupo foi movido em outra sessão. A árvore foi recarregada; confira e tente novamente.",
    OWN_SUBTREE: "Um grupo não pode ser movido para dentro dele mesmo.",
    DEPTH: "Limite de profundidade de " + MAX_DEPTH + " níveis atingido. Escolha um grupo pai menos profundo.",
    HAS_CHILDREN: "Este grupo tem subgrupos. Mova ou exclua os subgrupos primeiro.",
    HAS_LINKS: "Este grupo ainda tem links (inclusive desabilitados). Mova ou exclua os links primeiro.",
    PARENT_MISSING: "O grupo pai informado não existe mais. Recarregue a árvore.",
    NOT_FOUND: "Grupo não encontrado. Recarregue a árvore.",
  };

  /**
   * Normalises the `/api/groups` payload. The endpoint stays flat with
   * `parent_id`; the tree is assembled here, in `O(N)`.
   */
  function normalizeGroups(groups) {
    var list = [];
    if (!Array.isArray(groups)) {
      return list;
    }

    for (var index = 0; index < groups.length; index += 1) {
      var group = groups[index];
      if (!group || typeof group.id !== "number") {
        continue;
      }
      list.push({
        id: group.id,
        name: typeof group.name === "string" ? group.name : "",
        parentId: group.parent_id === null || group.parent_id === undefined ? null : group.parent_id,
      });
    }

    return list;
  }

  /** Deterministic sibling order: name, then id as the tiebreaker. */
  function siblingOrder(left, right) {
    var byName = String(left.name).localeCompare(String(right.name), "pt-BR", { sensitivity: "base" });
    if (byName !== 0) {
      return byName;
    }
    return left.id - right.id;
  }

  /**
   * Builds `Map<parentId, children[]>` in one pass plus the root list.
   *
   * Returns `{ ok: false, reason }` for a graph the panel cannot lay out (a
   * cycle, a missing parent). The caller shows the failure instead of rendering a
   * partial tree, which mirrors the API refusing an uninterpretable graph.
   */
  function buildTree(groups) {
    var list = normalizeGroups(groups);
    var byId = new Map();
    for (var index = 0; index < list.length; index += 1) {
      byId.set(list[index].id, list[index]);
    }

    var childrenOf = new Map();
    var roots = [];
    for (var position = 0; position < list.length; position += 1) {
      var group = list[position];
      if (group.parentId === null) {
        roots.push(group);
        continue;
      }
      if (!byId.has(group.parentId)) {
        return { ok: false, reason: "dangling" };
      }
      var siblings = childrenOf.get(group.parentId);
      if (siblings) {
        siblings.push(group);
      } else {
        childrenOf.set(group.parentId, [group]);
      }
    }

    // Sorting once per sibling list keeps the whole build at O(N log N).
    roots.sort(siblingOrder);
    childrenOf.forEach(function (siblings) {
      siblings.sort(siblingOrder);
    });

    // Depth is resolved by walking to a root with a visited set, so a stored
    // cycle is detected instead of iterated forever.
    var depthById = new Map();
    for (var entry = 0; entry < list.length; entry += 1) {
      var current = list[entry];
      if (depthById.has(current.id)) {
        continue;
      }
      var chain = [];
      var seen = new Set();
      var depth = 1;
      while (current) {
        if (seen.has(current.id)) {
          return { ok: false, reason: "cycle" };
        }
        seen.add(current.id);
        if (depthById.has(current.id)) {
          depth = depthById.get(current.id) + 1;
          break;
        }
        chain.push(current.id);
        current = current.parentId === null ? null : byId.get(current.parentId);
      }
      for (var index = chain.length - 1; index >= 0; index -= 1) {
        depthById.set(chain[index], depth);
        depth += 1;
      }
    }

    return { ok: true, roots: roots, childrenOf: childrenOf, byId: byId, depthById: depthById };
  }

  /** `Clientes / Brasil / Campinas`, cycle-safe. */
  function groupPath(byId, groupId) {
    var names = [];
    var seen = new Set();
    var current = byId.get(groupId);
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      names.unshift(current.name);
      current = current.parentId === null ? null : byId.get(current.parentId);
    }
    return names.join(PATH_SEPARATOR);
  }

  /**
   * Depth-first rows for rendering: `{ group, depth, path, hasChildren, expanded }`.
   * A visited set makes a repeated group impossible even if `tree` was built by
   * hand rather than by `buildTree`.
   */
  function flattenTree(tree, expandedIds) {
    var expanded = expandedIds instanceof Set ? expandedIds : new Set(expandedIds || []);
    var rows = [];
    var visited = new Set();

    function visit(group, depth) {
      if (!group || visited.has(group.id)) {
        return;
      }
      visited.add(group.id);
      var children = tree.childrenOf.get(group.id) || [];
      var isExpanded = expanded.has(group.id);
      rows.push({
        group: group,
        depth: depth,
        path: groupPath(tree.byId, group.id),
        hasChildren: children.length > 0,
        expanded: isExpanded,
      });
      if (!isExpanded) {
        return;
      }
      for (var index = 0; index < children.length; index += 1) {
        visit(children[index], depth + 1);
      }
    }

    for (var index = 0; index < tree.roots.length; index += 1) {
      visit(tree.roots[index], 1);
    }

    return rows;
  }

  /** Every id in the subtree rooted at `groupId`, the group itself included. */
  function subtreeIds(tree, groupId) {
    var ids = new Set();
    var queue = [groupId];
    while (queue.length) {
      var current = queue.shift();
      if (ids.has(current)) {
        continue;
      }
      ids.add(current);
      var children = tree.childrenOf.get(current) || [];
      for (var index = 0; index < children.length; index += 1) {
        queue.push(children[index].id);
      }
    }
    return ids;
  }

  /** Every group id in the tree: the "expand all" set. */
  function allIds(tree) {
    var ids = new Set();
    tree.byId.forEach(function (_group, id) {
      ids.add(id);
    });
    return ids;
  }

  /**
   * Options for a parent `<select>`, labelled with the full path so repeated
   * names stay distinguishable. `excludeGroupId` hides a group and its subtree:
   * a display convenience only, since the API refuses such a move anyway.
   */
  function parentOptions(tree, excludeGroupId) {
    var rows = flattenTree(tree, allIds(tree));
    var excluded = excludeGroupId === null || excludeGroupId === undefined
      ? new Set()
      : subtreeIds(tree, excludeGroupId);
    var options = [];
    for (var index = 0; index < rows.length; index += 1) {
      if (excluded.has(rows[index].group.id)) {
        continue;
      }
      options.push({ value: String(rows[index].group.id), label: rows[index].path });
    }
    return options;
  }

  /** Maps an API group error onto a message the panel can show as-is. */
  function groupErrorMessage(rawMessage) {
    var message = typeof rawMessage === "string" ? rawMessage : "";
    if (/hierarchy is corrupt/i.test(message)) {
      return ERROR_MESSAGES.CORRUPT;
    }
    if (/parent changed/i.test(message)) {
      return ERROR_MESSAGES.PARENT_CHANGED;
    }
    if (/own parent|own subtree/i.test(message)) {
      return ERROR_MESSAGES.OWN_SUBTREE;
    }
    if (/depth limit/i.test(message)) {
      return ERROR_MESSAGES.DEPTH;
    }
    if (/child groups/i.test(message)) {
      return ERROR_MESSAGES.HAS_CHILDREN;
    }
    if (/still has links/i.test(message)) {
      return ERROR_MESSAGES.HAS_LINKS;
    }
    if (/parent group not found/i.test(message)) {
      return ERROR_MESSAGES.PARENT_MISSING;
    }
    if (/group not found/i.test(message)) {
      return ERROR_MESSAGES.NOT_FOUND;
    }
    return message || "Não foi possível concluir a operação com grupos.";
  }

  /** A stale observed parent is the one 409 the panel resolves by reloading. */
  function isStaleParentError(rawMessage) {
    return /parent changed/i.test(typeof rawMessage === "string" ? rawMessage : "");
  }

  /** The 409 the panel cannot resolve by reloading: the tree itself is broken. */
  function isCorruptHierarchyError(rawMessage) {
    return /hierarchy is corrupt/i.test(typeof rawMessage === "string" ? rawMessage : "");
  }

  var api = {
    MAX_DEPTH: MAX_DEPTH,
    PATH_SEPARATOR: PATH_SEPARATOR,
    ERROR_MESSAGES: ERROR_MESSAGES,
    normalizeGroups: normalizeGroups,
    siblingOrder: siblingOrder,
    buildTree: buildTree,
    groupPath: groupPath,
    flattenTree: flattenTree,
    subtreeIds: subtreeIds,
    allIds: allIds,
    parentOptions: parentOptions,
    groupErrorMessage: groupErrorMessage,
    isStaleParentError: isStaleParentError,
    isCorruptHierarchyError: isCorruptHierarchyError,
  };

  if (typeof window !== "undefined") {
    window.BoltLinkGroupHierarchy = api;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})();

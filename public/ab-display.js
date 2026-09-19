/*
 * Copyright (c) 2026 Vitor Faustino
 * AGPL-3.0 License — https://github.com/vitorgfaustino/boltlink
 *
 * Shared A/B presentation logic for the admin UI.
 * Historical counters must never be rendered together with the current
 * (possibly changed) experiment configuration.
 */
(function () {
  function buildAbDisplay(link) {
    const clicksA = Number(link.ab_clicks_a || 0);
    const clicksB = Number(link.ab_clicks_b || 0);
    const hasHistory = clicksA > 0 || clicksB > 0 || Boolean(link.ab_started_at);
    const isActive = link.ab_enabled === 1;

    if (!isActive && !hasHistory) {
      return null;
    }

    const total = clicksA + clicksB;
    const observed = total > 0
      ? `${((clicksA / total) * 100).toFixed(1)}% / ${((clicksB / total) * 100).toFixed(1)}%`
      : "—";
    const weightB = Number(link.ab_weight_b ?? 50);
    const currentAllocation = `${100 - weightB}% / ${weightB}%`;
    const currentTarget = link.ab_target_url || null;

    return {
      isActive,
      title: isActive ? "Split A/B Ativo" : "Split A/B Encerrado",
      showHistoricalLabel: !isActive,
      clicksA,
      clicksB,
      observed,
      // Allocation is only trustworthy while the test that produced the
      // counters is still the active configuration.
      allocation: isActive ? currentAllocation : null,
      // Future configuration stays clearly separated from past counters.
      nextTest: !isActive && currentTarget ? { targetUrl: currentTarget, allocation: currentAllocation } : null,
    };
  }

  // Only include A/B fields in admin requests when the schema supports them.
  // Pre-migration installs must keep the plain Phase 1 payload.
  function buildAbFields(abTesting, values) {
    if (!abTesting) {
      return {};
    }

    return {
      abEnabled: values.abEnabled,
      abTargetUrl: values.abTargetUrl,
      abWeightB: values.abWeightB,
    };
  }

  const api = { buildAbDisplay, buildAbFields };

  if (typeof window !== "undefined") {
    window.BoltLinkAbDisplay = api;
  }
})();

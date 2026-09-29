/*
 * Vital — local storage model (spec §6).
 *
 * A thin, defensive persistence layer over browser.storage.local. It owns
 * the record shapes (SiteRule, Visit), site-rule CRUD, settings, per-day usage
 * and the open visit. Time accounting lives in shared/usage.js; the visit
 * lifecycle in background/visits.js.
 *
 * Only hostnames, timestamps, outcomes and per-day totals are ever stored —
 * never full URLs, titles, queries, or page content.
 *
 * Attaches to globalThis.Vital.
 */
(function (root) {
  "use strict";

  const Vital = (root.Vital = root.Vital || {});

  const KEYS = Object.freeze({
    rules: "rules",
    visits: "visits",
    settings: "settings",
    // Foreground ms on watchlisted sites per local day: { "YYYY-MM-DD": ms }.
    usage: "usage",
    // The single open (foreground) visit, persisted across event-page unloads.
    openVisit: "openVisit",
  });

  // Keys written by earlier versions (points/penalties); removed on update.
  const LEGACY_KEYS = ["ledger", "scoreState", "balance"];

  const DEFAULT_SETTINGS = Object.freeze({
    paused: false,
    warningEnabled: true,
    dailyAllowanceMin: Vital.CONFIG.defaultAllowanceMin,
  });

  function api() {
    // Firefox exposes the promise-based `browser`. Fall back to `chrome`.
    return root.browser && root.browser.storage ? root.browser : root.chrome;
  }

  function newId() {
    if (root.crypto && typeof root.crypto.randomUUID === "function") {
      return root.crypto.randomUUID();
    }
    return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  async function get(keys) {
    return api().storage.local.get(keys);
  }
  async function set(obj) {
    return api().storage.local.set(obj);
  }

  // ---- Site rules -------------------------------------------------------

  async function getRules() {
    const data = await get(KEYS.rules);
    return Array.isArray(data[KEYS.rules]) ? data[KEYS.rules] : [];
  }

  async function saveRules(rules) {
    await set({ [KEYS.rules]: rules });
    return rules;
  }

  /**
   * Add a rule for an already-normalized host. Rejects duplicates
   * (same host, case-insensitive). Returns { ok, rule } or { ok:false, error }.
   */
  async function addRule({ host, includeSubdomains = true, enabled = true }) {
    const rules = await getRules();
    const lower = String(host).toLowerCase();
    if (rules.some((r) => r.host.toLowerCase() === lower)) {
      return { ok: false, error: "That site is already on your watchlist." };
    }
    const rule = { id: newId(), host: lower, includeSubdomains, enabled };
    rules.push(rule);
    await saveRules(rules);
    return { ok: true, rule };
  }

  async function updateRule(id, patch) {
    const rules = await getRules();
    const idx = rules.findIndex((r) => r.id === id);
    if (idx === -1) return { ok: false, error: "Rule not found." };
    // If host changes, guard against creating a duplicate.
    if (patch.host) {
      const lower = String(patch.host).toLowerCase();
      if (rules.some((r) => r.id !== id && r.host.toLowerCase() === lower)) {
        return { ok: false, error: "Another rule already uses that site." };
      }
      patch = { ...patch, host: lower };
    }
    rules[idx] = { ...rules[idx], ...patch };
    await saveRules(rules);
    return { ok: true, rule: rules[idx] };
  }

  async function removeRule(id) {
    const rules = await getRules();
    const next = rules.filter((r) => r.id !== id);
    await saveRules(next);
    return { ok: true };
  }

  // ---- Settings ---------------------------------------------------------

  async function getSettings() {
    const data = await get(KEYS.settings);
    return { ...DEFAULT_SETTINGS, ...(data[KEYS.settings] || {}) };
  }

  async function setSettings(patch) {
    const current = await getSettings();
    const next = { ...current, ...patch };
    await set({ [KEYS.settings]: next });
    return next;
  }

  // ---- Visits -----------------------------------------------------------

  async function getVisits() {
    const data = await get(KEYS.visits);
    return Array.isArray(data[KEYS.visits]) ? data[KEYS.visits] : [];
  }
  async function saveVisits(visits) {
    await set({ [KEYS.visits]: visits });
    return visits;
  }

  function retentionCutoff() {
    return Date.now() - Vital.CONFIG.detailRetentionDays * 24 * 60 * 60 * 1000;
  }

  /** Append a finalized visit and prune history older than the retention window. */
  async function addVisit(visit) {
    const cutoff = retentionCutoff();
    const visits = (await getVisits()).filter(
      (v) => (v.endedAt || v.startedAt) >= cutoff
    );
    visits.push(visit);
    await saveVisits(visits);
    return visit;
  }

  // ---- Usage (per-day foreground time) ----------------------------------

  async function getUsage() {
    const data = await get(KEYS.usage);
    const u = data[KEYS.usage];
    return u && typeof u === "object" ? u : {};
  }
  async function saveUsage(usage) {
    await set({ [KEYS.usage]: usage });
    return usage;
  }

  // ---- Open visit -------------------------------------------------------

  async function getOpenVisit() {
    const data = await get(KEYS.openVisit);
    return data[KEYS.openVisit] || null;
  }
  async function saveOpenVisit(visit) {
    await set({ [KEYS.openVisit]: visit });
    return visit;
  }
  async function clearOpenVisit() {
    await set({ [KEYS.openVisit]: null });
  }

  // ---- History / reset / migration --------------------------------------

  /** Delete the visit list; today's time and the watchlist stay. */
  async function clearHistory() {
    await set({ [KEYS.visits]: [] });
    return { ok: true };
  }

  /** Forget the time used today (the open visit keeps counting from now). */
  async function resetToday() {
    const usage = await getUsage();
    delete usage[Vital.usage.dateKey(Date.now())];
    await saveUsage(usage);
    return { ok: true };
  }

  async function removeLegacyKeys() {
    await api().storage.local.remove(LEGACY_KEYS);
  }

  Vital.storage = {
    KEYS,
    DEFAULT_SETTINGS,
    newId,
    getRules,
    saveRules,
    addRule,
    updateRule,
    removeRule,
    getSettings,
    setSettings,
    getVisits,
    saveVisits,
    addVisit,
    getUsage,
    saveUsage,
    getOpenVisit,
    saveOpenVisit,
    clearOpenVisit,
    clearHistory,
    resetToday,
    removeLegacyKeys,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);

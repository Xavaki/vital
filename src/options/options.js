/*
 * Vital — options page: daily allowance, the site-rule editor (spec §4), and
 * the warning toggle.
 *
 * Uses the shared config/usage/matcher/storage classic scripts loaded before it.
 */
(function () {
  "use strict";

  const browserApi = window.browser || window.chrome;
  const { matcher, storage, CONFIG } = window.Vital;

  const $ = (id) => document.getElementById(id);
  const els = {
    form: $("add-form"),
    input: $("site-input"),
    addBtn: $("add-btn"),
    exactHost: $("exact-host"),
    preview: $("add-preview"),
    search: $("search"),
    list: $("rule-list"),
    empty: $("empty-state"),
    warningToggle: $("warning-toggle"),
    allowance: $("allowance-input"),
    allowanceHint: $("allowance-hint"),
    toast: $("toast"),
  };

  // In-memory mirror so duplicate checks stay synchronous — permission
  // requests must fire inside the user gesture, before any await.
  let rules = [];
  let filter = "";

  // ---- Small helpers ----------------------------------------------------

  let toastTimer = null;
  function toast(msg, isError) {
    els.toast.textContent = msg;
    els.toast.classList.toggle("err", !!isError);
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, 3200);
  }

  function looksLikeUrl(raw) {
    return /:\/\/|[/?#]|:\d/.test(raw.trim());
  }

  async function hasPermissionFor(rule) {
    try {
      return await browserApi.permissions.contains({
        origins: matcher.originPatternsForRule(rule),
      });
    } catch {
      return false;
    }
  }

  // ---- Add form ---------------------------------------------------------

  function analyze() {
    const raw = els.input.value;
    const result = matcher.normalizeHost(raw);
    const urlLike = looksLikeUrl(raw);

    els.preview.className = "preview";
    if (!raw.trim()) {
      els.preview.textContent = "";
      els.addBtn.disabled = true;
      els.addBtn.textContent = "Add";
      return;
    }

    if (!result.ok) {
      els.preview.textContent = result.error;
      els.preview.classList.add("err");
      els.addBtn.disabled = true;
      els.addBtn.textContent = "Add";
      return;
    }

    els.addBtn.disabled = false;
    if (urlLike) {
      // Explicit confirmation of a pasted URL's extracted hostname (spec §4).
      els.preview.textContent = `Extracted from URL — this will watch ${result.host}. Confirm to add.`;
      els.preview.classList.add("confirm");
      els.addBtn.textContent = `Add ${result.host}`;
    } else {
      els.preview.textContent = `Will watch ${result.host}${
        els.exactHost.checked ? " (exact host only)" : " and its subdomains"
      }.`;
      els.preview.classList.add("ok");
      els.addBtn.textContent = "Add";
    }
  }

  async function onSubmit(event) {
    event.preventDefault();
    const result = matcher.normalizeHost(els.input.value);
    if (!result.ok) { toast(result.error, true); return; }

    const includeSubdomains = !els.exactHost.checked;
    const candidate = { host: result.host, includeSubdomains };

    // Synchronous duplicate guard (against the in-memory mirror) so we don't
    // prompt for a permission we won't use.
    if (rules.some((r) => r.host.toLowerCase() === result.host)) {
      toast("That site is already on your watchlist.", true);
      return;
    }

    // Request host permission WITHIN the user gesture, before any await.
    let granted = false;
    try {
      granted = await browserApi.permissions.request({
        origins: matcher.originPatternsForRule(candidate),
      });
    } catch (err) {
      console.warn("Vital: permission request failed", err);
    }

    const added = await storage.addRule(candidate);
    if (!added.ok) { toast(added.error, true); return; }

    els.input.value = "";
    els.exactHost.checked = false;
    analyze();
    await loadRules();

    toast(
      granted
        ? `Added ${result.host}.`
        : `Added ${result.host}. The in-page warning needs page access — visits are still tracked.`
    );
  }

  // ---- Rule list --------------------------------------------------------

  async function loadRules() {
    rules = await storage.getRules();
    await renderList();
  }

  async function renderList() {
    const q = filter.trim().toLowerCase();
    const shown = q ? rules.filter((r) => r.host.includes(q)) : rules;

    els.list.innerHTML = "";
    els.empty.hidden = rules.length !== 0;

    // Resolve permission state for each shown rule in parallel.
    const perms = await Promise.all(shown.map(hasPermissionFor));

    shown.forEach((rule, i) => {
      els.list.appendChild(renderRule(rule, perms[i]));
    });
  }

  function renderRule(rule, hasPerm) {
    const li = document.createElement("li");
    li.className = "rule-item" + (rule.enabled === false ? " disabled" : "");

    // Enable/disable switch
    const sw = document.createElement("label");
    sw.className = "switch";
    sw.title = rule.enabled === false ? "Enable" : "Disable";
    const swInput = document.createElement("input");
    swInput.type = "checkbox";
    swInput.checked = rule.enabled !== false;
    swInput.setAttribute("aria-label", `Enable ${rule.host}`);
    swInput.addEventListener("change", async () => {
      await storage.updateRule(rule.id, { enabled: swInput.checked });
      await loadRules();
    });
    const slider = document.createElement("span");
    slider.className = "slider";
    sw.append(swInput, slider);

    // Main info
    const main = document.createElement("div");
    main.className = "rule-main";
    const host = document.createElement("div");
    host.className = "rule-host";
    host.textContent = rule.host;
    const meta = document.createElement("div");
    meta.className = "rule-meta";
    meta.append(
      badge(rule.includeSubdomains === false ? "exact host" : "+ subdomains")
    );
    if (!hasPerm) meta.append(badge("warning off — no page access", true));
    main.append(host, meta);

    // Actions
    const actions = document.createElement("div");
    actions.className = "rule-actions";
    const editBtn = mkBtn("Edit", "icon-btn", () => startEdit(li, rule));
    const delBtn = mkBtn("Remove", "icon-btn danger", async () => {
      await storage.removeRule(rule.id);
      await loadRules();
      toast(`Removed ${rule.host}.`);
    });
    actions.append(editBtn, delBtn);

    li.append(sw, main, actions);
    return li;
  }

  function startEdit(li, rule) {
    li.innerHTML = "";
    li.classList.remove("disabled");
    const wrap = document.createElement("div");
    wrap.className = "rule-edit";

    const input = document.createElement("input");
    input.type = "text";
    input.value = rule.host;
    input.setAttribute("aria-label", "Edit hostname");

    const exact = document.createElement("label");
    exact.className = "subcheck";
    const exactBox = document.createElement("input");
    exactBox.type = "checkbox";
    exactBox.checked = rule.includeSubdomains === false;
    exact.append(exactBox, document.createTextNode(" exact host"));

    const save = mkBtn("Save", "", async () => {
      const result = matcher.normalizeHost(input.value);
      if (!result.ok) { toast(result.error, true); return; }
      const includeSubdomains = !exactBox.checked;

      // Re-request permission for the (possibly changed) host, in-gesture.
      try {
        await browserApi.permissions.request({
          origins: matcher.originPatternsForRule({ host: result.host, includeSubdomains }),
        });
      } catch { /* logging stays independent of injection */ }

      const res = await storage.updateRule(rule.id, {
        host: result.host,
        includeSubdomains,
      });
      if (!res.ok) { toast(res.error, true); return; }
      await loadRules();
      toast(`Updated ${result.host}.`);
    });
    const cancel = mkBtn("Cancel", "icon-btn", () => loadRules());

    wrap.append(input, exact, save, cancel);
    li.append(wrap);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  function badge(text, warn) {
    const b = document.createElement("span");
    b.className = "badge" + (warn ? " warn" : "");
    b.textContent = text;
    return b;
  }
  function mkBtn(label, className, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    if (className) b.className = className;
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  }

  // ---- Settings (allowance + warning) -----------------------------------
  // The background picks changes up via storage.onChanged.

  function allowanceHint(min) {
    const h = Math.floor(min / 60), m = min % 60;
    return h ? `= ${h} h${m ? ` ${m} min` : ""}` : "";
  }

  async function loadSettings() {
    const s = await storage.getSettings();
    els.warningToggle.checked = s.warningEnabled;
    els.allowance.value = s.dailyAllowanceMin;
    els.allowanceHint.textContent = allowanceHint(s.dailyAllowanceMin);
  }

  async function onWarningChange() {
    await storage.setSettings({ warningEnabled: els.warningToggle.checked });
    toast("Saved.");
  }

  async function onAllowanceChange() {
    const min = Number(els.allowance.value);
    if (!Number.isInteger(min) || min < CONFIG.minAllowanceMin || min > CONFIG.maxAllowanceMin) {
      els.allowanceHint.textContent =
        `Enter whole minutes, ${CONFIG.minAllowanceMin}–${CONFIG.maxAllowanceMin}.`;
      els.allowanceHint.classList.add("err");
      return;
    }
    els.allowanceHint.classList.remove("err");
    els.allowanceHint.textContent = allowanceHint(min);
    await storage.setSettings({ dailyAllowanceMin: min });
    toast(`Daily allowance: ${min} min.`);
  }

  // ---- Wire up ----------------------------------------------------------

  els.input.addEventListener("input", analyze);
  els.exactHost.addEventListener("change", analyze);
  els.form.addEventListener("submit", onSubmit);
  els.search.addEventListener("input", () => { filter = els.search.value; renderList(); });
  els.warningToggle.addEventListener("change", onWarningChange);
  els.allowance.min = CONFIG.minAllowanceMin;
  els.allowance.max = CONFIG.maxAllowanceMin;
  els.allowance.addEventListener("change", onAllowanceChange);

  // Fill config-derived numbers in the copy so it can't drift.
  document.querySelectorAll(".cfg-grace").forEach((el) => {
    el.textContent = CONFIG.graceMs / 1000;
  });

  loadRules();
  loadSettings();
})();

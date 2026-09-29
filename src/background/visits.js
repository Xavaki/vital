/*
 * Vital — visit state machine and time accounting.
 *
 * Tracks the single foreground visit on a watchlisted site and records its
 * foreground time against today's allowance. A visit ends on close,
 * focus-away/navigation, pause, or interruption (browser restart / extension
 * reload). All tab/window listeners are registered at top level so the event
 * page can wake for them, and state changes are serialized through one promise
 * queue so near-simultaneous events produce exactly one terminal outcome.
 *
 * Foreground = the active tab in the focused Firefox window. Background tabs,
 * other windows and time away from Firefox never count.
 *
 * Time is recorded incrementally: the open visit's `countedUntil` marks how far
 * its time is already in the per-day usage map. A periodic tick (and every
 * event) records up to "now", so the event page can be unloaded at any point
 * and lose at most one tick of time on a crash.
 */
(function (root) {
  "use strict";

  const browserApi = root.browser || root.chrome;
  const { matcher, storage, usage: U, CONFIG } = root.Vital;
  const NONE = browserApi.windows.WINDOW_ID_NONE;
  const TICK_ALARM = "vital-tick";
  const INK = "#111113";
  const MUTED = "#55575d";
  const SIGNAL = "#d9480f";

  // ---- In-memory state --------------------------------------------------

  let activeVisit = null; // the open foreground visit, or null
  let focusedWindowId = null; // null/NONE = Firefox not focused
  let rulesCache = [];
  let settingsCache = { ...storage.DEFAULT_SETTINGS };

  // Serialize all state mutations behind one promise chain.
  let queue = Promise.resolve();
  function enqueue(task) {
    queue = queue.then(() => task().catch((e) => console.warn("Vital:", e)));
    return queue;
  }

  // Debounced foreground reconcile, deferred so a close can beat a focus-away.
  // `leftAt` remembers when the foreground first changed, so the deferral
  // doesn't count against the allowance.
  let reconcileTimer = null;
  let leftAt = null;
  const RECONCILE_DELAY_MS = 250;
  function scheduleReconcile(foregroundChanged = false) {
    if (foregroundChanged && leftAt === null) leftAt = Date.now();
    if (reconcileTimer) clearTimeout(reconcileTimer);
    reconcileTimer = setTimeout(() => {
      reconcileTimer = null;
      enqueue(reconcile);
    }, RECONCILE_DELAY_MS);
  }
  function cancelReconcile() {
    if (reconcileTimer) { clearTimeout(reconcileTimer); reconcileTimer = null; }
  }

  async function refreshCaches() {
    [rulesCache, settingsCache] = await Promise.all([
      storage.getRules(),
      storage.getSettings(),
    ]);
  }

  // ---- Foreground resolution -------------------------------------------

  async function getForeground() {
    if (focusedWindowId === null || focusedWindowId === NONE) return null;
    let tabs;
    try {
      tabs = await browserApi.tabs.query({ active: true, windowId: focusedWindowId });
    } catch {
      return null;
    }
    const tab = tabs && tabs[0];
    if (!tab || !tab.url) return null;
    return { tabId: tab.id, url: tab.url };
  }

  // ---- Time accounting --------------------------------------------------

  /** Record the open visit's time up to `at` into today's usage. */
  async function record(visit, at) {
    if (typeof visit.countedUntil !== "number") {
      visit.countedUntil = at; // visit from an older version: count from now
      return;
    }
    const end = U.observedEnd(visit.countedUntil, at);
    if (end > visit.countedUntil) {
      const usage = await storage.getUsage();
      U.creditSpan(usage, visit.countedUntil, end);
      U.prune(usage, at);
      await storage.saveUsage(usage);
      visit.activeMs = (visit.activeMs || 0) + (end - visit.countedUntil);
    }
    // Anything past `end` was unobserved (sleep) or a clock jump: drop it.
    visit.countedUntil = at;
  }

  async function remainingMs(now = Date.now()) {
    const usage = await storage.getUsage();
    return U.allowanceMs(settingsCache) - U.usedTodayMs(usage, activeVisit, now);
  }

  // ---- Visit lifecycle --------------------------------------------------

  async function startVisit(tabId, host, at) {
    activeVisit = {
      id: storage.newId(),
      tabId,
      host,
      startedAt: at,
      countedUntil: at,
      activeMs: 0,
      warningShown: false,
      warningUnavailable: false,
    };
    await storage.saveOpenVisit(activeVisit);
    try {
      await browserApi.alarms.create(TICK_ALARM, { periodInMinutes: CONFIG.tickMinutes });
    } catch (e) {
      console.warn("Vital: tick alarm failed", e);
    }
    console.info("Vital: visit started", host);
    if (settingsCache.warningEnabled) await injectWarning(activeVisit);
  }

  async function injectWarning(visit) {
    try {
      const info = {
        remainingMs: await remainingMs(),
        allowanceMs: U.allowanceMs(settingsCache),
      };
      // Hand the numbers to the toast (same isolated world), then run it.
      await browserApi.scripting.executeScript({
        target: { tabId: visit.tabId },
        func: (i) => { window.__vitalWarning = i; },
        args: [info],
      });
      await browserApi.scripting.executeScript({
        target: { tabId: visit.tabId },
        files: ["src/content/warning.js"],
      });
      visit.warningShown = true;
    } catch (e) {
      // Restricted page or missing host permission — time still counts.
      visit.warningUnavailable = true;
      console.info("Vital: warning unavailable", e && e.message);
    }
    if (activeVisit && activeVisit.id === visit.id) {
      await storage.saveOpenVisit(activeVisit);
    }
  }

  /**
   * End a visit at `endedAt`. Its time is recorded unless `count` is false
   * (interruptions, where we can't vouch for time after the last observation).
   */
  async function finalize(visit, outcome, endedAt, { count = true } = {}) {
    if (count) await record(visit, endedAt);
    await storage.addVisit({
      id: visit.id,
      host: visit.host,
      startedAt: visit.startedAt,
      endedAt,
      activeMs: visit.activeMs || 0,
      outcome,
      warningShown: !!visit.warningShown,
      warningUnavailable: !!visit.warningUnavailable,
    });
    if (!activeVisit || activeVisit.id === visit.id) {
      activeVisit = null;
      await storage.clearOpenVisit();
      try { await browserApi.alarms.clear(TICK_ALARM); } catch { /* ignore */ }
    }
    console.info("Vital:", outcome, visit.host, Math.round((visit.activeMs || 0) / 1000) + "s");
  }

  // ---- Toolbar badge ----------------------------------------------------
  // Paused: "⏸". On a watchlisted site: time left today ("12m", "-4m").
  // Otherwise empty.

  async function updateBadge() {
    try {
      if (settingsCache.paused) {
        await browserApi.action.setBadgeBackgroundColor({ color: MUTED });
        await browserApi.action.setBadgeText({ text: "⏸" });
        await browserApi.action.setTitle({ title: "Vital — paused" });
        return;
      }
      if (!activeVisit) {
        await browserApi.action.setBadgeText({ text: "" });
        await browserApi.action.setTitle({ title: "Vital" });
        return;
      }
      const left = await remainingMs();
      await browserApi.action.setBadgeBackgroundColor({
        color: left <= CONFIG.lowRemainingMs ? SIGNAL : INK,
      });
      await browserApi.action.setBadgeText({ text: U.fmtBadge(left) });
      await browserApi.action.setTitle({
        title: left >= 0
          ? `Vital — ${U.fmtShort(left)} left today`
          : `Vital — ${U.fmtShort(-left)} over today's allowance`,
      });
    } catch { /* badge is cosmetic */ }
  }

  // ---- Reconcile: the single decision point -----------------------------

  async function reconcile() {
    const now = Date.now();
    const changedAt = leftAt !== null ? Math.min(leftAt, now) : now;
    leftAt = null;

    if (settingsCache.paused) {
      if (activeVisit) await finalize(activeVisit, "paused", now);
      await updateBadge();
      return;
    }

    const fg = await getForeground();
    const host = fg ? matcher.hostFromPageUrl(fg.url) : null;
    const rule = host ? matcher.findMatchingRule(rulesCache, host) : null;

    if (activeVisit) {
      const sameTab = fg && fg.tabId === activeVisit.tabId;
      if (sameTab && rule && host === activeVisit.host) {
        // Same visit continues (reload / same-host navigation): record time.
        await record(activeVisit, now);
        await storage.saveOpenVisit(activeVisit);
        await updateBadge();
        return;
      }
      await finalize(activeVisit, sameTab ? "navigated" : "focused_away", changedAt);
    }

    if (rule) await startVisit(fg.tabId, host, now);
    await updateBadge();
  }

  // ---- Event listeners (top level) --------------------------------------

  browserApi.windows.onFocusChanged.addListener((windowId) => {
    focusedWindowId = windowId;
    scheduleReconcile(true);
  });

  browserApi.tabs.onActivated.addListener((info) => {
    if (focusedWindowId === null) focusedWindowId = info.windowId;
    scheduleReconcile(true);
  });

  browserApi.tabs.onUpdated.addListener((tabId, changeInfo) => {
    // Top-level navigation or load completion may change what's in front.
    if (changeInfo.url || changeInfo.status === "complete") scheduleReconcile(true);
  });

  browserApi.tabs.onRemoved.addListener((tabId) => {
    enqueue(async () => {
      if (activeVisit && activeVisit.tabId === tabId) {
        // A definitive close: record it as `closed` rather than letting a
        // pending reconcile call it `focused_away`.
        cancelReconcile();
        leftAt = null;
        await finalize(activeVisit, "closed", Date.now());
        await updateBadge();
        // Re-evaluate whatever tab is now in front (may be watchlisted).
        scheduleReconcile();
      }
    });
  });

  browserApi.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== TICK_ALARM) return;
    enqueue(async () => {
      if (!activeVisit) {
        try { await browserApi.alarms.clear(TICK_ALARM); } catch { /* ignore */ }
        return;
      }
      await reconcile(); // verifies it's still in front and records time
    });
  });

  // The toast's "Close tab" button: close the sender's tab, which then ends
  // the visit exactly like a normal close.
  browserApi.runtime.onMessage.addListener((message, sender) => {
    if (message && message.type === "closeTabFromWarning" && sender.tab) {
      return browserApi.tabs.remove(sender.tab.id).then(() => ({ ok: true }));
    }
    return undefined;
  });

  browserApi.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.rules || changes.settings) {
      // Watchlist, pause or allowance edited in options/popup.
      enqueue(async () => {
        await refreshCaches();
        scheduleReconcile();
      });
    } else if (changes.usage) {
      enqueue(updateBadge); // e.g. "reset today" from the popup
    }
  });

  // ---- Startup / recovery ----------------------------------------------

  // Runs every time the event page loads. Firefox unloads an idle event page
  // (~30s), so a load is usually just a wake-up for the next event: restore the
  // open visit and let that event finalize it. Don't require its tab to still
  // exist — when the wake-up event IS onRemoved, the tab is already gone.
  async function init() {
    await refreshCaches();
    try {
      const win = await browserApi.windows.getLastFocused();
      focusedWindowId = win && win.focused ? win.id : NONE;
    } catch {
      focusedWindowId = NONE;
    }
    const open = await storage.getOpenVisit();
    if (open && open.id && !activeVisit) activeVisit = open;
    await updateBadge();
    scheduleReconcile();
  }

  // Browser restart or extension reload/update: a visit left open by the
  // previous session ends as interrupted at its last observation. Time after
  // that point is never guessed.
  async function interruptOpenVisit() {
    cancelReconcile();
    const open = activeVisit || (await storage.getOpenVisit());
    if (open && open.id) {
      const lastSeen = typeof open.countedUntil === "number" ? open.countedUntil : open.startedAt;
      await finalize(open, "interrupted", lastSeen, { count: false });
    }
    scheduleReconcile();
  }

  browserApi.runtime.onStartup.addListener(() => enqueue(interruptOpenVisit));
  browserApi.runtime.onInstalled.addListener(() =>
    enqueue(async () => {
      await interruptOpenVisit();
      // Drop data and alarms left by the earlier points-based versions.
      await storage.removeLegacyKeys();
      try {
        for (const a of await browserApi.alarms.getAll()) {
          if (a.name.startsWith("vital-linger:")) await browserApi.alarms.clear(a.name);
        }
      } catch { /* ignore */ }
    })
  );
  enqueue(init);
})(typeof globalThis !== "undefined" ? globalThis : this);

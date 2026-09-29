/*
 * Vital — popup: time left today (live), recent visits, pause & data controls.
 * Reads storage directly and recomputes the countdown every second while a
 * visit is open; the background records time and handles pause via
 * storage.onChanged.
 */
(function () {
  "use strict";

  const browserApi = window.browser || window.chrome;
  const { storage, CONFIG, usage: U } = window.Vital;
  const $ = (id) => document.getElementById(id);

  const OUTCOME_LABEL = {
    closed: "closed",
    focused_away: "switched away",
    navigated: "navigated away",
    paused: "paused",
    interrupted: "interrupted",
  };

  // Latest storage snapshot; the header re-renders from it every second.
  let snap = { usage: {}, openVisit: null, settings: storage.DEFAULT_SETTINGS };

  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  function fmtDuration(ms) {
    const s = Math.round(Math.max(0, ms) / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return m < 60 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : U.fmtShort(ms);
  }

  // ---- Header: countdown + meter ---------------------------------------

  function renderHeader() {
    const now = Date.now();
    const allowance = U.allowanceMs(snap.settings);
    const used = U.usedTodayMs(snap.usage, snap.openVisit, now);
    const left = allowance - used;
    const over = left < 0;
    const low = !over && left <= CONFIG.lowRemainingMs;

    $("readout-label").textContent = over ? "Over today's allowance" : "Time left today";
    $("readout").textContent = over ? `+${U.fmtClock(-left)}` : U.fmtClock(left);
    $("readout").classList.toggle("alert", over || low);
    $("used").textContent = `${U.fmtClock(used)} used of ${U.fmtClock(allowance)}`;
    renderMeter(Math.max(0, left) / allowance, over || low);

    const live = !!snap.openVisit && !snap.settings.paused;
    $("live").hidden = !live;
    if (live) $("live-host").textContent = snap.openVisit.host;
  }

  // Ten segments, each a tenth of the allowance; the current one fills partly.
  function renderMeter(fraction, alert) {
    const meter = $("meter");
    const SEGMENTS = 10;
    if (meter.children.length !== SEGMENTS) {
      meter.replaceChildren(
        ...Array.from({ length: SEGMENTS }, () => {
          const seg = document.createElement("span");
          seg.className = "seg";
          seg.append(document.createElement("i"));
          return seg;
        })
      );
    }
    meter.classList.toggle("alert", alert);
    meter.setAttribute("aria-label", `${Math.round(fraction * 100)}% of today's allowance left`);
    const filled = fraction * SEGMENTS;
    [...meter.children].forEach((seg, i) => {
      const f = Math.min(1, Math.max(0, filled - i));
      seg.firstChild.style.width = `${f * 100}%`;
    });
  }

  // ---- Full render ------------------------------------------------------

  async function render() {
    const [usage, openVisit, settings, visits] = await Promise.all([
      storage.getUsage(),
      storage.getOpenVisit(),
      storage.getSettings(),
      storage.getVisits(),
    ]);
    snap = { usage, openVisit, settings };
    renderHeader();

    $("pause-toggle").checked = settings.paused;
    $("paused-banner").hidden = !settings.paused;

    const recent = [...visits].sort((a, b) => b.startedAt - a.startedAt).slice(0, 12);
    const list = $("visit-list");
    list.replaceChildren();
    $("visit-empty").hidden = recent.length !== 0;

    for (const v of recent) {
      const li = document.createElement("li");
      li.className = "visit-item";

      const host = document.createElement("div");
      host.className = "visit-host";
      host.textContent = v.host;

      const sub = document.createElement("div");
      sub.className = "visit-sub";
      sub.textContent = `${fmtTime(v.startedAt)} · ${OUTCOME_LABEL[v.outcome] || v.outcome}`;

      const dur = document.createElement("div");
      dur.className = "visit-dur" + (v.activeMs < 1000 ? " zero" : "");
      dur.textContent = fmtDuration(v.activeMs);

      li.append(host, sub, dur);
      list.append(li);
    }
  }

  // ---- Controls ---------------------------------------------------------

  $("pause-toggle").addEventListener("change", async (e) => {
    // The background sees the settings change and ends any open visit.
    await storage.setSettings({ paused: e.target.checked });
  });

  $("manage").addEventListener("click", () => {
    browserApi.runtime.openOptionsPage();
    window.close();
  });

  const menu = $("menu");
  $("menu-btn").addEventListener("click", () => { menu.hidden = !menu.hidden; });

  function confirmAction(text, onOk) {
    const box = $("confirm");
    $("confirm-text").textContent = text;
    box.hidden = false;
    menu.hidden = true;
    $("confirm-ok").onclick = async () => { await onOk(); box.hidden = true; render(); };
    $("confirm-cancel").onclick = () => { box.hidden = true; };
  }

  $("clear-history").addEventListener("click", () => {
    confirmAction("Delete the visit list? Today's time and your watchlist stay.", () =>
      storage.clearHistory()
    );
  });
  $("reset-today").addEventListener("click", () => {
    confirmAction("Reset the time used today back to zero?", () => storage.resetToday());
  });

  // Live updates: storage changes re-render; the countdown ticks every second.
  browserApi.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.usage || changes.openVisit || changes.visits || changes.settings) render();
  });
  setInterval(() => { if (snap.openVisit) renderHeader(); }, 1000);

  render();
})();

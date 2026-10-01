/*
 * Vital — popup: time left today (live), a 7-day history chart and recent
 * visits. Reads storage directly and recomputes the live numbers
 * every second while a visit is open; the background does all recording.
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
    paused: "paused", // outcome from earlier versions
    interrupted: "interrupted",
  };
  const DAYS = 7;
  const PLOT_H = 88; // px; the chart container adds the x-axis band below

  // Latest storage snapshot; live parts re-render from it every second.
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

  function renderHeader(now) {
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

    const live = !!snap.openVisit;
    $("live").hidden = !live;
    if (live) {
      // During the grace period countedUntil is still in the future.
      const graceLeft = snap.openVisit.countedUntil - now;
      const inGrace = graceLeft > 0 && !snap.openVisit.activeMs;
      $("live").classList.toggle("grace", inGrace);
      $("live-state").textContent = inGrace ? `Grace ${Math.ceil(graceLeft / 1000)}s` : "Counting";
      $("live-host").textContent = snap.openVisit.host;
    }
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

  // ---- History chart: last 7 days --------------------------------------
  // One column per day: time within the allowance in ink, any overage stacked
  // on top in the signal color (2px surface gap between). A solid hairline
  // marks the current allowance. Only today's column carries a value label;
  // every column has a hover/focus tooltip, and a hidden table mirrors it all.

  let chart = null; // cached DOM, built once
  let activeIdx = null; // column whose tooltip is showing

  function lastDays(now) {
    const d = new Date(now);
    return Array.from({ length: DAYS }, (_, i) => {
      // Noon avoids DST edges when stepping back whole days.
      const day = new Date(d.getFullYear(), d.getMonth(), d.getDate() - (DAYS - 1 - i), 12);
      return { ts: day.getTime(), key: U.dateKey(day.getTime()), isToday: i === DAYS - 1 };
    });
  }

  function buildChart() {
    const root = $("chart");
    root.style.setProperty("--plot-h", `${PLOT_H}px`);

    const plot = document.createElement("div");
    plot.className = "plot";
    const limit = document.createElement("div");
    limit.className = "limit";
    const limitLabel = document.createElement("span");
    limitLabel.className = "limit-label";
    limit.append(limitLabel);
    plot.append(limit);

    const cols = [];
    const axis = document.createElement("div");
    axis.className = "axis";
    for (let i = 0; i < DAYS; i++) {
      const col = document.createElement("div");
      col.className = "col";
      col.tabIndex = 0;
      col.setAttribute("role", "img");
      const stack = document.createElement("div");
      stack.className = "stack";
      const overSeg = document.createElement("span");
      overSeg.className = "over";
      const withinSeg = document.createElement("span");
      withinSeg.className = "within";
      const value = document.createElement("span");
      value.className = "value";
      stack.append(value, overSeg, withinSeg);
      col.append(stack);
      plot.append(col);

      const label = document.createElement("span");
      axis.append(label);

      col.addEventListener("pointerenter", () => showTip(i));
      col.addEventListener("focus", () => showTip(i));
      col.addEventListener("pointerleave", hideTip);
      col.addEventListener("blur", hideTip);
      cols.push({ col, overSeg, withinSeg, value, label });
    }

    const tip = document.createElement("div");
    tip.className = "tip";
    tip.hidden = true;
    const tipValue = document.createElement("strong");
    const tipDay = document.createElement("span");
    const tipOver = document.createElement("span");
    tipOver.className = "tip-over";
    tip.append(tipValue, tipDay, tipOver);

    root.replaceChildren(plot, axis, tip);
    chart = { plot, limit, limitLabel, cols, tip, tipValue, tipDay, tipOver, days: [] };
  }

  function renderChart(now) {
    if (!chart) buildChart();
    const allowance = U.allowanceMs(snap.settings);
    const days = lastDays(now).map((d) => ({
      ...d,
      used: d.isToday ? U.usedTodayMs(snap.usage, snap.openVisit, now) : snap.usage[d.key] || 0,
    }));
    chart.days = days;

    // Headroom above the tallest mark (or the allowance line) for today's label.
    const yMax = Math.max(allowance, ...days.map((d) => d.used)) * 1.18;
    const px = (ms) => (ms / yMax) * PLOT_H;

    chart.limit.style.bottom = `${px(allowance)}px`;
    chart.limitLabel.textContent = U.fmtShort(allowance);

    days.forEach((d, i) => {
      const c = chart.cols[i];
      const within = Math.min(d.used, allowance);
      const over = Math.max(0, d.used - allowance);
      // Keep any non-zero day visible as at least a 2px stub.
      const withinH = within > 0 ? Math.max(2, px(within)) : 0;
      const overH = over > 0 ? Math.max(2, px(over)) : 0;
      c.withinSeg.style.height = `${withinH}px`;
      c.overSeg.style.height = `${overH}px`;
      c.overSeg.hidden = overH === 0;
      c.col.classList.toggle("has-over", overH > 0);
      c.col.classList.toggle("today", d.isToday);
      c.value.textContent = d.isToday && d.used > 0 ? U.fmtShort(d.used) : "";

      const dayName = d.isToday
        ? "Today"
        : new Date(d.ts).toLocaleDateString([], { weekday: "short" });
      c.label.textContent = dayName;
      c.label.classList.toggle("today", d.isToday);
      c.col.setAttribute(
        "aria-label",
        `${dayName}: ${U.fmtShort(d.used)}${over > 0 ? `, ${U.fmtShort(over)} over` : ""}`
      );
    });

    const total = days.reduce((sum, d) => sum + d.used, 0);
    $("week-avg").textContent = `avg ${U.fmtShort(total / DAYS)}/day`;
    renderTable(days, allowance);
    if (activeIdx !== null) showTip(activeIdx);
  }

  function showTip(i) {
    activeIdx = i;
    const d = chart.days[i];
    if (!d) return;
    const allowance = U.allowanceMs(snap.settings);
    const over = Math.max(0, d.used - allowance);
    chart.tipValue.textContent = fmtDuration(d.used);
    chart.tipDay.textContent = new Date(d.ts).toLocaleDateString([], {
      weekday: "short", day: "numeric", month: "short",
    });
    chart.tipOver.textContent = over > 0 ? `${U.fmtShort(over)} over` : "";
    chart.tipOver.hidden = over === 0;
    chart.tip.hidden = false;

    // Center over the column, clamped inside the chart. Columns sit inside the
    // offset plot, so measure against the chart's own box.
    const root = $("chart").getBoundingClientRect();
    const col = chart.cols[i].col.getBoundingClientRect();
    const tipW = chart.tip.offsetWidth;
    const center = col.left - root.left + col.width / 2;
    const left = Math.min(Math.max(0, center - tipW / 2), root.width - tipW);
    chart.tip.style.left = `${left}px`;
    chart.cols.forEach((c, j) => c.col.classList.toggle("active", j === i));
  }
  function hideTip() {
    activeIdx = null;
    if (!chart) return;
    chart.tip.hidden = true;
    chart.cols.forEach((c) => c.col.classList.remove("active"));
  }

  function renderTable(days, allowance) {
    const rows = days.map((d) => {
      const tr = document.createElement("tr");
      for (const text of [
        new Date(d.ts).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" }),
        fmtDuration(d.used),
        d.used > allowance ? fmtDuration(d.used - allowance) : "—",
      ]) {
        const td = document.createElement("td");
        td.textContent = text;
        tr.append(td);
      }
      return tr;
    });
    $("chart-table").tBodies[0].replaceChildren(...rows);
  }

  // ---- Recent visits ----------------------------------------------------

  function renderVisits(visits) {
    const recent = [...visits].sort((a, b) => b.startedAt - a.startedAt).slice(0, 8);
    const list = $("visit-list");
    list.replaceChildren();
    $("visit-empty").hidden = recent.length !== 0;

    for (const v of recent) {
      const li = document.createElement("li");
      li.className = "visit-item";

      const host = document.createElement("div");
      host.className = "visit-host";
      host.textContent = v.host;

      const dur = document.createElement("div");
      dur.className = "visit-dur" + ((v.activeMs || 0) < 1000 ? " zero" : "");
      dur.textContent = fmtDuration(v.activeMs || 0);

      const sub = document.createElement("div");
      sub.className = "visit-sub";
      sub.textContent = `${fmtTime(v.startedAt)} · ${OUTCOME_LABEL[v.outcome] || v.outcome}`;

      li.append(host, dur, sub);
      list.append(li);
    }
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
    const now = Date.now();
    renderHeader(now);
    renderChart(now);
    renderVisits(visits);
  }

  // ---- Controls ---------------------------------------------------------

  $("manage").addEventListener("click", () => {
    browserApi.runtime.openOptionsPage();
    window.close();
  });


  // Live updates: storage changes re-render; live numbers tick every second.
  browserApi.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.usage || changes.openVisit || changes.visits || changes.settings) render();
  });
  setInterval(() => {
    if (!snap.openVisit) return;
    const now = Date.now();
    renderHeader(now);
    renderChart(now);
  }, 1000);

  render();
})();

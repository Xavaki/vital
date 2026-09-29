/*
 * Vital — daily time accounting. Pure logic, no browser APIs.
 *
 * Foreground time on watchlisted sites is recorded per local calendar day in a
 * `usage` map ({ "YYYY-MM-DD": ms }). The open visit carries `countedUntil`,
 * the point up to which its time is already in the map; anything after that is
 * "live" time that readers add on the fly, so the popup can count down every
 * second without the background writing every second.
 *
 * Attaches to globalThis.Vital.usage (and module.exports under Node).
 */
(function (root) {
  "use strict";

  const Vital = (root.Vital = root.Vital || {});
  const DAY_MS = 24 * 60 * 60 * 1000;

  function pad(n) { return String(n).padStart(2, "0"); }

  /** Local calendar-day key, sortable as a string. */
  function dateKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function startOfDay(ts) {
    const d = new Date(ts);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }
  function nextMidnight(ts) {
    const d = new Date(ts);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  }

  /**
   * End of the span we can vouch for. The background re-observes an open visit
   * every tick; if nothing observed it for longer than `maxUnobservedMs` (e.g.
   * the machine slept with the tab in front), count at most that much.
   * A clock that went backwards counts nothing.
   */
  function observedEnd(countedUntil, now) {
    const gap = Math.min(Math.max(0, now - countedUntil), Vital.CONFIG.maxUnobservedMs);
    return countedUntil + gap;
  }

  /** Add [from, to) to the usage map, splitting at local midnights. Mutates. */
  function creditSpan(usage, from, to) {
    for (let t = from; t < to; ) {
      const end = Math.min(to, nextMidnight(t));
      const key = dateKey(t);
      usage[key] = (usage[key] || 0) + (end - t);
      t = end;
    }
    return usage;
  }

  /** Drop days older than the retention window. Mutates. */
  function prune(usage, now) {
    const oldest = dateKey(now - Vital.CONFIG.detailRetentionDays * DAY_MS);
    for (const key of Object.keys(usage)) if (key < oldest) delete usage[key];
    return usage;
  }

  /** Time used today, including the open visit's not-yet-recorded live time. */
  function usedTodayMs(usage, openVisit, now) {
    let used = (usage && usage[dateKey(now)]) || 0;
    if (openVisit && typeof openVisit.countedUntil === "number") {
      const from = Math.max(openVisit.countedUntil, startOfDay(now));
      const to = observedEnd(openVisit.countedUntil, now);
      if (to > from) used += to - from;
    }
    return used;
  }

  function allowanceMs(settings) {
    return settings.dailyAllowanceMin * 60 * 1000;
  }

  /** "18:04", "1:02:09"; negative values get a leading "−". */
  function fmtClock(ms) {
    const sign = ms < 0 ? "−" : "";
    const s = Math.floor(Math.abs(ms) / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${sign}${h}:${pad(m)}:${pad(sec)}` : `${sign}${m}:${pad(sec)}`;
  }

  /** Compact duration for lists: "45s", "12m", "1h 05m". */
  function fmtShort(ms) {
    const s = Math.round(Math.max(0, ms) / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
  }

  /** Toolbar badge text (max ~4 chars): "12m", "1h05", "0m", "-4m". */
  function fmtBadge(remainingMs) {
    const over = remainingMs < 0;
    const m = over ? Math.ceil(-remainingMs / 60000) : Math.floor(remainingMs / 60000);
    const body = m < 60 ? `${m}m` : m < 600 ? `${Math.floor(m / 60)}h${pad(m % 60)}` : `${Math.floor(m / 60)}h`;
    return over ? `-${body}` : body;
  }

  Vital.usage = {
    dateKey, startOfDay, nextMidnight, observedEnd, creditSpan, prune,
    usedTodayMs, allowanceMs, fmtClock, fmtShort, fmtBadge,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = Vital.usage;
})(typeof globalThis !== "undefined" ? globalThis : this);

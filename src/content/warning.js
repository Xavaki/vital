/*
 * Vital — in-page warning toast (spec §5).
 *
 * Injected on demand when a watchlisted visit starts. Renders a small,
 * dismissible toast in the top-right corner inside a shadow root so page styles
 * can't touch it and it can't touch the page. Auto-hides when the visit's grace
 * period ends. Never traps focus, intercepts typing, covers the page, or plays
 * sound.
 *
 * The background sets
 * `globalThis.__vitalWarning = { remainingMs, allowanceMs, durationMs }`
 * just before injecting this file. "Close tab" asks the background to remove
 * the tab, which ends the visit like a normal close. "Stop seeing this" asks it
 * to open the settings page at the in-page warning toggle.
 *
 * Use `globalThis`, not `window`: in Firefox content scripts the global is a
 * separate object inheriting from the page's `window`, and the extension APIs
 * (`browser`) live only on it — `window.browser` is undefined.
 */
(function () {
  "use strict";

  const browserApi = globalThis.browser || globalThis.chrome;
  const HOST_ID = "vital-warning-host";
  const info = globalThis.__vitalWarning || null;
  delete globalThis.__vitalWarning;
  // Lasts exactly the visit's grace period (sent by the background), so the
  // draining bar runs out when time starts counting.
  const AUTO_HIDE_MS = (info && info.durationMs) || 4000;

  function fmtMinutes(ms) {
    const m = Math.floor(ms / 60000);
    if (m < 1) return "under a minute";
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60), rest = m % 60;
    return rest ? `${h} h ${rest} min` : `${h} h`;
  }

  // Only ever one toast; a fresh visit replaces any leftover.
  const existing = document.getElementById(HOST_ID);
  if (existing) existing.remove();

  const host = document.createElement("div");
  host.id = HOST_ID;
  // Keep the host out of layout flow and above page content.
  host.style.cssText = "position:fixed;top:0;right:0;z-index:2147483647;";
  const shadow = host.attachShadow({ mode: "closed" });

  const reduceMotion =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const SANS = `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    /* Small and quiet: a translucent near-black navy card with a faint blue
       glow, so it stays legible on any page without shouting. Gradients only
       (no images), so page CSPs can't strip it. */
    .toast {
      position: fixed; top: 12px; right: 12px;
      width: 248px;
      font: 12.5px/1.4 ${SANS};
      color: #eef0ff;
      background:
        radial-gradient(160px 90px at 0% 100%, rgba(0,87,251,0.30), transparent),
        rgba(1,4,26,0.88);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(6,206,252,0.14);
      border-radius: 16px;
      box-shadow: 0 6px 20px rgba(1,4,26,0.22);
      padding: 10px 12px 0;
      overflow: hidden;
      ${reduceMotion ? "" : "animation: vital-in 220ms ease-out;"}
    }
    @keyframes vital-in {
      from { opacity: 0; transform: translateY(-4px); }
      to   { opacity: 1; transform: none; }
    }
    .head { display: flex; align-items: center; gap: 8px; }
    /* The logo's two colours, as a tiny mark. */
    .mark {
      flex: none; width: 8px; height: 8px; border-radius: 50%;
      background: linear-gradient(135deg, #06cefc, #0057fb 55%, #fc581d);
    }
    .left {
      flex: 1; margin: 0;
      font: 500 13.5px/1.3 ${SANS};
      font-variant-numeric: tabular-nums;
    }
    .left.over { color: #ff6f3a; }
    .x {
      flex: none; width: 22px; height: 22px; padding: 0; margin: -3px -5px -3px 0;
      display: grid; place-items: center;
      background: transparent; border: none; border-radius: 50%;
      color: #8fa0dc; font: 400 16px/1 ${SANS};
    }
    .x:hover { color: #ffffff; background: rgba(157,176,255,0.12); }
    .msg { margin: 6px 0 0; color: #b4bce6; font-size: 12px; }
    .msg.error { color: #ff6f3a; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 9px 0 10px; }
    button { cursor: pointer; transition: background 0.15s, color 0.15s; }
    .close {
      font: 600 12px/1 ${SANS};
      padding: 6px 12px; border-radius: 999px;
      background: #ffffff; color: #030c3d; border: none;
    }
    .close:hover { background: #dcecff; }
    .stop {
      font: 500 11.5px/1 ${SANS};
      padding: 4px 0; background: none; border: none; color: #8fa0dc;
      text-decoration: underline; text-decoration-color: rgba(143,160,220,0.4); text-underline-offset: 3px;
    }
    .stop:hover { color: #eef0ff; text-decoration-color: currentColor; }
    button:focus-visible { outline: 2px solid #fcc32d; outline-offset: 2px; }
    button:disabled { opacity: 0.6; cursor: default; }
    /* Thin line showing time until auto-hide. */
    .timer { height: 2px; margin: 0 -12px; background: rgba(157,176,255,0.10); }
    .timer span {
      display: block; height: 100%; transform-origin: left;
      background: linear-gradient(90deg, #0057fb, #06cefc);
      ${reduceMotion ? "" : `animation: vital-drain ${AUTO_HIDE_MS}ms linear forwards;`}
    }
    @keyframes vital-drain { from { transform: scaleX(1); } to { transform: scaleX(0); } }
  `;

  const toast = document.createElement("div");
  toast.className = "toast";
  toast.setAttribute("role", "alertdialog");
  toast.setAttribute("aria-label", "Vital reminder");

  const head = document.createElement("div");
  head.className = "head";
  const mark = document.createElement("span");
  mark.className = "mark";
  mark.setAttribute("aria-hidden", "true");

  // Headline: time left today (or how far over), when the background supplied it.
  const left = document.createElement("p");
  left.className = "left";
  if (info && typeof info.remainingMs === "number") {
    if (info.remainingMs > 0) {
      left.textContent = `${fmtMinutes(info.remainingMs)} left today`;
    } else {
      left.classList.add("over");
      left.textContent = info.remainingMs === 0
        ? "No time left today"
        : `${fmtMinutes(-info.remainingMs)} over today`;
    }
  } else {
    left.textContent = "Watchlisted site";
  }

  const dismissBtn = document.createElement("button");
  dismissBtn.className = "x";
  dismissBtn.type = "button";
  dismissBtn.setAttribute("aria-label", "Dismiss");
  dismissBtn.textContent = "\u00D7"; // escaped: host page charset can vary
  head.append(mark, left, dismissBtn);

  // Only used to report a failed "Close tab".
  const msg = document.createElement("p");
  msg.className = "msg";
  msg.hidden = true;

  const row = document.createElement("div");
  row.className = "row";

  const stopBtn = document.createElement("button");
  stopBtn.className = "stop";
  stopBtn.type = "button";
  stopBtn.textContent = "Stop seeing this";

  const closeBtn = document.createElement("button");
  closeBtn.className = "close";
  closeBtn.type = "button";
  closeBtn.textContent = "Close tab";

  row.append(stopBtn, closeBtn);
  const timer = document.createElement("div");
  timer.className = "timer";
  timer.append(document.createElement("span"));
  toast.append(head, msg, row, timer);
  shadow.append(style, toast);
  document.documentElement.appendChild(host);

  let hideTimer = null;
  function teardown() {
    if (hideTimer) clearTimeout(hideTimer);
    host.remove();
  }

  // Auto-hide (neutral — costs nothing).
  hideTimer = setTimeout(teardown, AUTO_HIDE_MS);

  dismissBtn.addEventListener("click", teardown);

  // Open the settings page at the in-page warning toggle (content scripts
  // can't open extension pages themselves, so the background does it).
  stopBtn.addEventListener("click", () => {
    teardown();
    browserApi.runtime.sendMessage({ type: "openWarningSettings" }).catch((e) => {
      console.warn("Vital: couldn't open settings", e);
    });
  });

  // Ask the background to close this tab. Keep the toast up until that works:
  // on success the tab (and toast) disappear; on failure say so rather than
  // vanishing silently. (window.close() is no fallback — Firefox ignores it
  // for tabs the user opened.)
  closeBtn.addEventListener("click", async () => {
    clearTimeout(hideTimer);
    timer.hidden = true;
    closeBtn.disabled = true;
    closeBtn.textContent = "Closing\u2026";
    try {
      const reply = await browserApi.runtime.sendMessage({ type: "closeTabFromWarning" });
      if (!reply || !reply.ok) throw new Error("no confirmation from Vital");
    } catch (e) {
      if (!host.isConnected) return; // page already going away
      console.warn("Vital: couldn't close the tab", e);
      closeBtn.hidden = true;
      msg.hidden = false;
      msg.classList.add("error");
      msg.textContent = "Couldn't close this tab \u2014 close it yourself (Ctrl+W).";
      hideTimer = setTimeout(teardown, AUTO_HIDE_MS * 2);
    }
  });
})();
